/**
 * A text-only backup model behind an OpenAI-compatible HTTP API.
 *
 * Used when every Gemini model has refused for quota or overload (lib/model.ts
 * decides). DeepSeek and OpenRouter both speak this API, so one client serves both;
 * each is a `BackendSpec` (lib/deepseek.ts, lib/openrouter.ts) saying where it is,
 * what its key is called and which models it may use. A backend is given exactly
 * what Gemini would be — same protocol, same phase instruction, same schemas,
 * answers parsed by the same code (lib/prompts.ts) — with these differences, all
 * deliberate:
 *
 * - **Text only.** No photo is ever sent, so photos go to exactly one outside
 *   party, Google. The model is told it cannot see them.
 * - **No schema enforcement.** JSON mode, not a schema, so the schema is written
 *   into the prompt and the answer validated afterwards by the same zod schemas.
 *   Out-of-range source indexes and malformed shapes are caught there and by the
 *   verbatim price check, as they are for Gemini.
 * - **A list of models, tried in order.** A model refused for quota, overload or a
 *   missing name is skipped for the next, like Gemini's chain.
 *
 * Plain `fetch`, no SDK. No retries: a failed call is reported once.
 */
import "server-only";
import { z } from "zod";
import { env } from "./env";
import type { Intake, ItemFacts } from "./item";
import { inTryOrder, markUnavailable } from "./model-health";
import {
  EMPTY_READING,
  EXTRACT_INSTRUCTION,
  FACTS_REQUEST,
  FACTS_SCHEMA,
  extractionSchema,
  factsSystem,
  parseFacts,
  parseReading,
  readingPrompt,
  systemInstruction,
  type MarketReading,
  type TurnContext,
} from "./prompts";
import type { Source } from "./sources";
import type { Stage } from "./stages";
import type { TranscriptMessage } from "./transcript";

const CALL_TIMEOUT_MS = 25_000;
const STREAM_TIMEOUT_MS = 120_000;
/** Bounds a runaway answer, which JSON mode can produce if it never closes the object. */
const MAX_JSON_TOKENS = 4096;
const MAX_REPLY_TOKENS = 2048;

/** What a backend is: where it lives, what its key is called, and which models it may use. */
export type BackendSpec = {
  /** For messages: "DeepSeek", "OpenRouter". */
  name: string;
  /** The environment variable holding the key, for the "not set" message. */
  keyName: string;
  endpoint: string;
  apiKey: () => string | undefined;
  /** Models this backend may use, in the order to try them. Already filtered; empty means unusable. */
  models: () => string[];
  extraBody?: Record<string, unknown>;
  /**
   * Appended to a 404 only when the provider's own message mentions a data policy or
   * privacy setting, since otherwise it would send someone to the wrong place.
   */
  privacyHint?: string;
  /** Sent for any model, e.g. to turn a reasoning mode off. */
};

/** " (detail)" for a message, or nothing. */
const withDetail = (detail: string) => (detail ? ` (${detail})` : "");

/** One line, no control characters, bounded: provider text goes into messages shown to people. */
function tidy(text: string): string {
  return (
    text
      // A link cut off at the length limit is worse than no link, and the one providers
      // append ("add your own key…") is not something this app can act on.
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180)
  );
}

/**
 * What the provider said was wrong, from an error body, for the message.
 *
 * OpenRouter wraps an upstream provider's complaint in `error.metadata.raw` and names
 * the provider, which is the part worth reading ("Nvidia: Function … not found for
 * account", "temporarily rate-limited upstream"); its own `error.message` is usually
 * just "Provider returned error". Never throws, and returns "" when there is nothing
 * useful, so a plain error body changes no message.
 */
export function detailFromBody(body: unknown): string {
  const error = (body as { error?: { message?: unknown; metadata?: { raw?: unknown; provider_name?: unknown } } } | null)?.error;
  if (!error || typeof error !== "object") return "";

  let raw = error.metadata?.raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      raw = parsed?.detail ?? parsed?.message ?? parsed?.title ?? raw;
    } catch {
      // not JSON: use it as written
    }
  }
  const message = typeof error.message === "string" && error.message !== "Provider returned error" ? error.message : null;
  const provider = typeof error.metadata?.provider_name === "string" ? error.metadata.provider_name : null;
  const said = [typeof raw === "string" ? raw : null, message].filter(Boolean).join("; ");
  return tidy(provider && said ? `${provider}: ${said}` : (said || provider || ""));
}

/** The balance or credits are empty (402). Nothing is charged; it needs topping up. */
export class BackendQuotaError extends Error {
  constructor(
    readonly provider: string,
    detail = "",
  ) {
    super(`The ${provider} balance is empty${withDetail(detail)}`);
    this.name = "BackendQuotaError";
  }
}

/** Sending too fast, or a daily cap reached (429). */
export class BackendRateLimitError extends Error {
  constructor(
    readonly provider: string,
    detail = "",
  ) {
    super(`${provider} is rate limiting this key${withDetail(detail)}`);
    this.name = "BackendRateLimitError";
  }
}

/** No key, or a rejected one (401), or no model the backend is allowed to use. A configuration problem. */
export class BackendUnavailableError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

/** Anything else: a server error, a timeout, an unreadable response. */
export class BackendFailedError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "BackendFailedError";
  }
}

/** Overloaded or timed out upstream (408, 502, 503): the model, not the request. */
export class BackendOverloadedError extends BackendFailedError {
  constructor(provider: string, message: string) {
    super(provider, message);
    this.name = "BackendOverloadedError";
  }
}

/** The model does not exist for this account (404). */
export class BackendNotFoundError extends BackendFailedError {
  constructor(provider: string, message: string) {
    super(provider, message);
    this.name = "BackendNotFoundError";
  }
}

type Message = { role: "system" | "user" | "assistant"; content: string };

/** The error an HTTP status stands for, with whatever the provider said about it. */
function errorFor(spec: BackendSpec, status: number, model: string, detail = ""): Error {
  if (status === 401) {
    return new BackendUnavailableError(spec.name, `${spec.name} rejected the API key${withDetail(detail)}`);
  }
  if (status === 402) return new BackendQuotaError(spec.name, detail);
  if (status === 429) return new BackendRateLimitError(spec.name, detail);
  if (status === 404) {
    const hint = /polic|privacy/i.test(detail) ? (spec.privacyHint ?? "") : "";
    return new BackendNotFoundError(
      spec.name,
      `${spec.name} has no usable endpoint for "${model}"${withDetail(detail)}${hint}`,
    );
  }
  if (status === 408 || status === 502 || status === 503 || status === 529) {
    return new BackendOverloadedError(spec.name, `${spec.name} answered ${status}${withDetail(detail)}`);
  }
  return new BackendFailedError(spec.name, `${spec.name} answered ${status}${withDetail(detail)}`);
}

/**
 * An error reported inside a 200 response, which OpenRouter does once it has already
 * started answering. Its `code` is the HTTP-style status it stands for.
 */
function errorInBody(spec: BackendSpec, body: unknown, model: string): Error | null {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (!error) return null;
  const code = typeof error.code === "number" ? error.code : Number(error.code);
  const detail = detailFromBody(body);
  return Number.isFinite(code) && code >= 400
    ? errorFor(spec, code, model, detail)
    : new BackendFailedError(spec.name, `${spec.name} reported an error${withDetail(detail)}`);
}

/** One request. Throws one of the error classes above, never anything else. */
async function send(
  spec: BackendSpec,
  model: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const key = spec.apiKey();
  if (!key) {
    throw new BackendUnavailableError(
      spec.name,
      `${spec.keyName} is not set. Add it to .env.local — see .env.example.`,
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(spec.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, ...spec.extraBody, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new BackendFailedError(
      spec.name,
      timedOut ? `${spec.name} timed out` : `${spec.name} could not be reached`,
    );
  }

  if (!response.ok) {
    // The status says what kind of failure it was; the body says why, and for a free
    // upstream provider that is most of what anyone debugging it needs.
    const body = await response.json().catch(() => null);
    throw errorFor(spec, response.status, model, detailFromBody(body));
  }
  return response;
}

/** What makes the next model worth trying: the model, not the request. */
function skippable(error: unknown): "transient" | "missing" | null {
  if (error instanceof BackendRateLimitError || error instanceof BackendOverloadedError) return "transient";
  if (error instanceof BackendNotFoundError) return "missing";
  return null;
}

/** The models in the order to try them, or the error that says there are none. */
function orderedModels(spec: BackendSpec): string[] {
  const models = spec.models();
  if (models.length === 0) {
    throw new BackendUnavailableError(spec.name, `No ${spec.name} model is configured, or none is allowed.`);
  }
  const key = (model: string) => `${spec.name}:${model}`;
  const order = inTryOrder(models.map(key));
  return order.map((entry) => entry.slice(spec.name.length + 1));
}

/** After every model refused: the most useful error, or the only one. */
function exhausted(failures: Error[]): Error {
  if (failures.length === 1) return failures[0];
  return (
    failures.find((e) => e instanceof BackendRateLimitError) ??
    failures.find((e) => e instanceof BackendOverloadedError) ??
    failures[0]
  );
}

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

/**
 * One JSON-mode call, down the model list. The schema goes in the prompt because
 * the API cannot enforce one, and the example because the docs say JSON mode wants one.
 */
async function completeJson(
  spec: BackendSpec,
  system: string,
  messages: Message[],
  schema: unknown,
  example: unknown,
  fetchImpl: typeof fetch,
): Promise<string> {
  const failures: Error[] = [];

  for (const model of orderedModels(spec)) {
    try {
      const response = await send(
        spec,
        model,
        {
          messages: [
            {
              role: "system",
              content: [
                system,
                "",
                "Reply with a single JSON object and nothing else: valid json, no prose, no code fences.",
                "It must match this JSON Schema:",
                JSON.stringify(schema),
                "",
                "An example of the shape (the values are illustrative):",
                JSON.stringify(example),
              ].join("\n"),
            },
            ...messages,
          ],
          temperature: 0,
          max_tokens: MAX_JSON_TOKENS,
          response_format: { type: "json_object" },
          stream: false,
        },
        CALL_TIMEOUT_MS,
        fetchImpl,
      );

      let raw: unknown = null;
      try {
        raw = await response.json();
      } catch (error) {
        // The deadline can pass while the body is still arriving: that is a timeout,
        // not a response that could not be read.
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new BackendFailedError(spec.name, `${spec.name} timed out`);
        }
      }
      const failure = errorInBody(spec, raw, model);
      if (failure) throw failure;
      const parsed = completionSchema.safeParse(raw);
      if (!parsed.success) {
        throw new BackendFailedError(spec.name, `${spec.name} sent a response that could not be read`);
      }
      return parsed.data.choices[0].message.content ?? "";
    } catch (error) {
      const kind = skippable(error);
      if (!kind) throw error;
      markUnavailable(`${spec.name}:${model}`, kind);
      failures.push(error as Error);
    }
  }
  throw exhausted(failures);
}

/** The conversation as chat messages. Text only: photo ids are dropped, never resolved. */
function toMessages(transcript: readonly TranscriptMessage[]): Message[] {
  return transcript.map((message) => ({
    role: message.role === "model" ? "assistant" : "user",
    content: message.text,
  }));
}

/**
 * Pulls the text out of one server-sent-events line, or null when it carries none.
 * Throws for an error event, which arrives as an ordinary line once the answer has begun.
 */
function textOfSseLine(spec: BackendSpec, model: string, line: string): string | null | "done" {
  if (!line.startsWith("data:")) return null; // blank lines and ": keep-alive" comments
  const data = line.slice(5).trim();
  if (data === "[DONE]") return "done";
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const failure = errorInBody(spec, parsed, model);
  if (failure) throw failure;
  const delta = (parsed as { choices?: Array<{ delta?: { content?: unknown } }> })?.choices?.[0]?.delta;
  // `reasoning_content` is thinking, not the answer, and is never shown.
  return typeof delta?.content === "string" && delta.content ? delta.content : null;
}

/** One model's stream, as text. Throws a Backend* error, whatever goes wrong. */
async function* streamFrom(
  spec: BackendSpec,
  model: string,
  system: string,
  messages: Message[],
  fetchImpl: typeof fetch,
): AsyncGenerator<string> {
  const response = await send(
    spec,
    model,
    {
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.4,
      max_tokens: MAX_REPLY_TOKENS,
      stream: true,
    },
    STREAM_TIMEOUT_MS,
    fetchImpl,
  );
  if (!response.body) throw new BackendFailedError(spec.name, `${spec.name} sent no body`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });

      // A line can straddle two chunks; everything before the last newline is whole.
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const text = textOfSseLine(spec, model, line.trim());
        if (text === "done") return;
        if (text) yield text;
      }
    }
    const last = textOfSseLine(spec, model, carry.trim());
    if (last && last !== "done") yield last;
  } catch (error) {
    if (error instanceof BackendFailedError || error instanceof BackendRateLimitError || error instanceof BackendQuotaError) {
      throw error;
    }
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new BackendFailedError(
      spec.name,
      timedOut ? `${spec.name} timed out` : `The ${spec.name} stream broke`,
    );
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streams the reply as text, down the model list. Stage markers are still embedded
 * and must be stripped by the caller, exactly as for Gemini. Moves to the next model
 * only if the current one refused before saying anything.
 */
async function* streamReplyFrom(
  spec: BackendSpec,
  transcript: TranscriptMessage[],
  stage: Stage,
  context: TurnContext,
  fetchImpl: typeof fetch,
): AsyncGenerator<string> {
  // `false`: tells the model, in plain words, that it cannot see the photos.
  const system = systemInstruction(stage, context, false);
  const messages = toMessages(transcript);
  const failures: Error[] = [];

  for (const model of orderedModels(spec)) {
    let spoke = false;
    try {
      for await (const text of streamFrom(spec, model, system, messages, fetchImpl)) {
        spoke = true;
        yield text;
      }
      if (!spoke) throw new BackendOverloadedError(spec.name, `${spec.name} sent an empty reply`);
      return;
    } catch (error) {
      const kind = skippable(error);
      if (spoke || !kind) throw error;
      markUnavailable(`${spec.name}:${model}`, kind);
      failures.push(error as Error);
    }
  }
  throw exhausted(failures);
}

const FACTS_EXAMPLE = {
  searchQuery: "Apple iPhone 13 128GB",
  model: "iPhone 13",
  variant: "128GB, blue",
  ageMonths: 24,
  condition: "good",
  category: "phone_tablet",
  included: ["box"],
  defects: ["light scratches on the back"],
  purchasePrice: 700,
  purchaseCurrency: "USD",
};

const READING_EXAMPLE = {
  listings: [
    {
      title: "Apple iPhone 13 128GB Blue",
      priceText: "US $312.00",
      kind: "sold",
      condition: "good",
      platform: "eBay",
      sourceIndex: 0,
    },
  ],
  newPrice: { priceText: "$699.00", sourceIndex: 0 },
  position: "typical",
  positionEvidence: "light wear, comparable to the listings",
};

/** What a backend offers: the same three calls Gemini does, text only. */
export type Backend = {
  name: string;
  /** Whether a key is set and at least one allowed model is configured. */
  isConfigured(): boolean;
  streamReply(
    transcript: TranscriptMessage[],
    stage: Stage,
    context: TurnContext,
    fetchImpl?: typeof fetch,
  ): AsyncGenerator<string>;
  extractFacts(transcript: TranscriptMessage[], intake: Intake, fetchImpl?: typeof fetch): Promise<ItemFacts>;
  readListings(facts: ItemFacts, sources: readonly Source[], fetchImpl?: typeof fetch): Promise<MarketReading>;
};

export function createBackend(spec: BackendSpec): Backend {
  return {
    name: spec.name,
    isConfigured: () => spec.apiKey() !== undefined && spec.models().length > 0,

    streamReply: (transcript, stage, context, fetchImpl = fetch) =>
      streamReplyFrom(spec, transcript, stage, context, fetchImpl),

    /** The item as data, from the conversation alone: a backend cannot see the photos. */
    async extractFacts(transcript, intake, fetchImpl = fetch) {
      const text = await completeJson(
        spec,
        factsSystem(intake, false),
        [...toMessages(transcript), { role: "user", content: FACTS_REQUEST }],
        FACTS_SCHEMA,
        FACTS_EXAMPLE,
        fetchImpl,
      );
      return parseFacts(text, env.vndPerUsd);
    },

    /** Reads listings out of the sources. Takes the facts through `forSearch`, like Gemini's. */
    async readListings(facts, sources, fetchImpl = fetch) {
      if (sources.length === 0) return EMPTY_READING;
      const text = await completeJson(
        spec,
        EXTRACT_INSTRUCTION,
        [{ role: "user", content: readingPrompt(facts, sources) }],
        extractionSchema(sources.length),
        READING_EXAMPLE,
        fetchImpl,
      );
      return parseReading(text);
    },
  };
}
