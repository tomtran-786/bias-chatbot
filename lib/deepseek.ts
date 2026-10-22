/**
 * The backup model: DeepSeek, over its OpenAI-compatible HTTP API.
 *
 * Used only when Gemini's quota is out or it is overloaded (lib/model.ts decides).
 * It is given exactly what Gemini would be — same protocol, same phase
 * instruction, same schemas, answers parsed by the same code (lib/prompts.ts) —
 * with three differences, all deliberate:
 *
 * - **Text only.** No photo is ever sent. DeepSeek's documentation lists image
 *   input for `deepseek-flash`, but the request format is not in the API reference
 *   and has not been tried, so this does not guess at one. It also means photos go
 *   to exactly one outside party, Google. The model is told it cannot see them.
 * - **No schema enforcement.** The API has `json_object` mode, not `json_schema`,
 *   so the schema is written into the prompt and the answer is validated afterwards
 *   by the same zod schemas. Out-of-range source indexes and malformed shapes are
 *   caught there and by the verbatim price check, as they are for Gemini.
 * - **Thinking off.** It is on by default for these models, which spends tokens and
 *   seconds on reasoning nobody reads. The temperature setting is ignored while it
 *   is on, too.
 *
 * Plain `fetch`, no SDK. No retries: a failed call is reported once.
 *
 * Billing is prepaid: costs come off a balance, and at zero the API answers 402.
 */
import "server-only";
import { z } from "zod";
import { env } from "./env";
import type { Intake, ItemFacts } from "./item";
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

const ENDPOINT = "https://api.deepseek.com/chat/completions";
const CALL_TIMEOUT_MS = 45_000;
const STREAM_TIMEOUT_MS = 120_000;
/** Bounds a runaway answer, which JSON mode can produce if it never closes the object. */
const MAX_JSON_TOKENS = 4096;
const MAX_REPLY_TOKENS = 2048;

/** The balance is empty (402). Nothing is charged; it needs topping up. */
export class DeepSeekQuotaError extends Error {
  constructor() {
    super("The DeepSeek balance is empty");
    this.name = "DeepSeekQuotaError";
  }
}

/** Sending too fast (429). */
export class DeepSeekRateLimitError extends Error {
  constructor() {
    super("DeepSeek is rate limiting this key");
    this.name = "DeepSeekRateLimitError";
  }
}

/** No key, or a rejected one (401). A configuration problem. */
export class DeepSeekUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekUnavailableError";
  }
}

/** Anything else: overloaded (503), a server error, a timeout, an unreadable response. */
export class DeepSeekFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekFailedError";
  }
}

/** Whether a backup model is set up. Without a key the app has none. */
export function isConfigured(): boolean {
  return env.deepseekApiKey !== undefined;
}

type Message = { role: "system" | "user" | "assistant"; content: string };

/** One request. Throws one of the error classes above, never anything else. */
async function send(
  body: Record<string, unknown>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const key = env.deepseekApiKey;
  if (!key) {
    throw new DeepSeekUnavailableError(
      "DEEPSEEK_API_KEY is not set. Add it to .env.local — see .env.example.",
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: env.deepseekModel,
        // On by default for these models; nothing here reads the reasoning.
        thinking: { type: "disabled" },
        ...body,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new DeepSeekFailedError(
      timedOut ? "DeepSeek timed out" : "DeepSeek could not be reached",
    );
  }

  if (response.status === 401) {
    throw new DeepSeekUnavailableError("DeepSeek rejected the API key");
  }
  if (response.status === 402) throw new DeepSeekQuotaError();
  if (response.status === 429) throw new DeepSeekRateLimitError();
  if (!response.ok) {
    throw new DeepSeekFailedError(`DeepSeek answered ${response.status}`);
  }
  return response;
}

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

/**
 * One JSON-mode call. The schema goes in the prompt because the API cannot
 * enforce one, and the example because its documentation says JSON mode wants one.
 */
async function completeJson(
  system: string,
  messages: Message[],
  schema: unknown,
  example: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await send(
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

  const parsed = completionSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new DeepSeekFailedError("DeepSeek sent a response that could not be read");
  }
  return parsed.data.choices[0].message.content ?? "";
}

/** The conversation as chat messages. Text only: photo ids are dropped, never resolved. */
function toMessages(transcript: readonly TranscriptMessage[]): Message[] {
  return transcript.map((message) => ({
    role: message.role === "model" ? "assistant" : "user",
    content: message.text,
  }));
}

/** Pulls the text out of one server-sent-events line, or null when it carries none. */
function textOfSseLine(line: string): string | null | "done" {
  if (!line.startsWith("data:")) return null; // blank lines and ": keep-alive" comments
  const data = line.slice(5).trim();
  if (data === "[DONE]") return "done";
  try {
    const delta = JSON.parse(data)?.choices?.[0]?.delta;
    // `reasoning_content` is thinking, not the answer, and is never shown.
    return typeof delta?.content === "string" && delta.content ? delta.content : null;
  } catch {
    return null;
  }
}

/**
 * Streams the reply as text. Stage markers are still embedded and must be
 * stripped by the caller, exactly as for Gemini.
 */
export async function* streamReply(
  transcript: TranscriptMessage[],
  stage: Stage,
  context: TurnContext,
  fetchImpl: typeof fetch = fetch,
): AsyncGenerator<string> {
  const response = await send(
    {
      messages: [
        // `false`: tells the model, in plain words, that it cannot see the photos.
        { role: "system", content: systemInstruction(stage, context, false) },
        ...toMessages(transcript),
      ],
      temperature: 0.4,
      max_tokens: MAX_REPLY_TOKENS,
      stream: true,
    },
    STREAM_TIMEOUT_MS,
    fetchImpl,
  );
  if (!response.body) throw new DeepSeekFailedError("DeepSeek sent no body");

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
        const text = textOfSseLine(line.trim());
        if (text === "done") return;
        if (text) yield text;
      }
    }
    const last = textOfSseLine(carry.trim());
    if (last && last !== "done") yield last;
  } catch (error) {
    if (error instanceof DeepSeekFailedError) throw error;
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new DeepSeekFailedError(timedOut ? "DeepSeek timed out" : "The DeepSeek stream broke");
  } finally {
    reader.releaseLock();
  }
}

const FACTS_EXAMPLE = {
  searchQuery: "Apple iPhone 13 128GB",
  model: "iPhone 13",
  variant: "128GB, blue",
  ageMonths: 24,
  condition: "good",
  included: ["box"],
  defects: ["light scratches on the back"],
  purchasePrice: 700,
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
  newPrice: 699,
  position: "typical",
  positionEvidence: "light wear, comparable to the listings",
};

/** The item as data, from the conversation alone: the backup cannot see the photos. */
export async function extractFacts(
  transcript: TranscriptMessage[],
  intake: Intake,
  fetchImpl: typeof fetch = fetch,
): Promise<ItemFacts> {
  const text = await completeJson(
    factsSystem(intake, false),
    [...toMessages(transcript), { role: "user", content: FACTS_REQUEST }],
    FACTS_SCHEMA,
    FACTS_EXAMPLE,
    fetchImpl,
  );
  return parseFacts(text);
}

/** Reads listings out of the sources. Takes the facts through `forSearch`, like Gemini's. */
export async function readListings(
  facts: ItemFacts,
  sources: readonly Source[],
  fetchImpl: typeof fetch = fetch,
): Promise<MarketReading> {
  if (sources.length === 0) return EMPTY_READING;
  const text = await completeJson(
    EXTRACT_INSTRUCTION,
    [{ role: "user", content: readingPrompt(facts, sources) }],
    extractionSchema(sources.length),
    READING_EXAMPLE,
    fetchImpl,
  );
  return parseReading(text);
}
