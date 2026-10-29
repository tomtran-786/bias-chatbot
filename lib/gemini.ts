/**
 * Thin wrapper over the Gemini SDK.
 *
 * Three shapes of call, and none of them gives the model a tool:
 *
 * - **Conversation** (`streamReply`): intake, the questions and the verdict are
 *   streamed text, with the photos attached where they first appear.
 * - **Facts** (`extractFacts`): one non-streaming call against a response
 *   schema. It reads the whole conversation and the photos and returns the item
 *   as data.
 * - **Listings** (`readListings`): one non-streaming call against a response
 *   schema. It is handed numbered sources — text the app fetched from a search
 *   service — and returns the listings it can read in them, each pointing at the
 *   source it came from.
 *
 * The app searches and the model reads. There is no `tools` entry on any call:
 * the model does not decide when to search, cannot search at all, and so cannot
 * touch a tool quota. That is what keeps this on the free tier. A test asserts it
 * for every request this module makes.
 *
 * The system instruction is assembled from the protocol's Gem-portable core, not
 * the whole document. Sending the model exactly the span that gets pasted into
 * the Gem builder is the entire basis for claiming the two are the same
 * instrument.
 */
import "server-only";
import {
  ApiError,
  GoogleGenAI,
  PartMediaResolutionLevel,
  ThinkingLevel,
  type Content,
  type GenerateContentConfig,
  type Part,
} from "@google/genai";
import { env } from "./env";
import { inTryOrder, markUnavailable, type Refusal } from "./model-health";
import type { Source } from "./sources";
import type { Intake, ItemFacts, Photo } from "./item";
import {
  FACTS_REQUEST,
  FACTS_SCHEMA,
  EMPTY_READING,
  EXTRACT_INSTRUCTION,
  MalformedAppraisalError,
  extractionSchema,
  factsSystem,
  parseFacts,
  parseReading,
  readingPrompt,
  systemInstruction,
  type MarketReading,
  type TurnContext,
} from "./prompts";
import type { Stage } from "./stages";
import type { TranscriptMessage } from "./transcript";

export { MalformedAppraisalError };
export type { MarketReading, TurnContext };
export type { TranscriptMessage };

/**
 * Thrown when Gemini's quota is exhausted (HTTP 429). `tried` is every model that
 * was asked before giving up, which is more than one when a chain is configured.
 */
export class RateLimitError extends Error {
  constructor(readonly tried: readonly string[] = []) {
    super("Gemini quota exhausted");
    this.name = "RateLimitError";
  }
}

/** Thrown when no model in the chain exists for this key (HTTP 404): a configuration problem. */
export class ModelNotFoundError extends Error {
  constructor(readonly tried: readonly string[] = []) {
    super("No configured Gemini model is available to this key");
    this.name = "ModelNotFoundError";
  }
}

/**
 * Thrown when a call is cut off for taking too long. Free-tier models get
 * overloaded and can sit on a request indefinitely; without this the person would
 * wait on a spinner with nothing to tell them it will not come.
 */
export class ModelTimeoutError extends Error {
  constructor() {
    super("The model took too long to answer");
    this.name = "ModelTimeoutError";
  }
}

/**
 * Longest one non-streaming call may take. Each market step is its own request
 * with a 60-second function to itself, so a slow model can be given up on and the
 * next one tried inside it.
 */
const CALL_TIMEOUT_MS = 25_000;
/** All the models in a chain together, so the last attempt cannot run past the function's limit. */
const CHAIN_BUDGET_MS = 50_000;
/** Not worth starting another model with less than this left. */
const MIN_ATTEMPT_MS = 5_000;
/**
 * A whole streamed reply, verdict included. Under the chat route's 60-second limit, so
 * a reply that runs long ends in an error the person can retry, not in a cut.
 */
const STREAM_TIMEOUT_MS = 55_000;

/**
 * Thrown on HTTP 503: the model is overloaded and will say so for a while. Like a
 * quota error it is the model's availability, not a fault in the request, which is
 * why the backup model takes over for it too.
 */
export class ModelOverloadedError extends Error {
  constructor(readonly tried: readonly string[] = []) {
    super("Gemini is overloaded");
    this.name = "ModelOverloadedError";
  }
}

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: env.geminiApiKey });
  return client;
}

/**
 * The conversation as Gemini wants it, with each photo attached to the message
 * it first appeared in.
 *
 * Photos are only worth their tokens while there is something to check against
 * them, so callers pass `withPhotos: false` for the verdict, which argues from
 * the facts already extracted. MEDIUM resolution is enough to read wear and a
 * model label and costs a fraction of HIGH.
 */
function toContents(
  transcript: readonly TranscriptMessage[],
  photos: readonly Photo[],
  withPhotos: boolean,
): Content[] {
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  const attached = new Set<string>();

  return transcript.map((message) => {
    const parts: Part[] = [];
    if (withPhotos && message.role === "user") {
      for (const id of message.photoIds ?? []) {
        const photo = byId.get(id);
        if (!photo || attached.has(id)) continue;
        attached.add(id);
        parts.push({
          inlineData: { mimeType: photo.mime, data: photo.data },
          mediaResolution: {
            level: PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM,
          },
        });
      }
    }
    parts.push({ text: message.text });
    return { role: message.role, parts };
  });
}

/**
 * Low but not zero. The instrument wants comparable behaviour from one run to
 * the next, which is a reproducibility concern rather than a stylistic one.
 */
const TEMPERATURE = 0.4;

/**
 * Why the next model in the chain is worth trying, or null when it is not.
 *
 * Quota, overload and a name the key cannot use are about the model. So is a call
 * that timed out: a free-tier model can sit on a request, and another one will not.
 * A bad answer (not JSON, not the schema) is tried on the next model too; the
 * error is kept, so when every model answers badly it is the bad answer that is
 * reported, not a vague failure.
 */
function refusalOf(error: unknown): Refusal | "bad_answer" | null {
  if (
    error instanceof RateLimitError ||
    error instanceof ModelOverloadedError ||
    error instanceof ModelTimeoutError
  ) {
    return "transient";
  }
  if (error instanceof ModelNotFoundError) return "missing";
  if (error instanceof MalformedAppraisalError) return "bad_answer";
  return null;
}

/** Remembers a model only when the refusal says something about it; a bad answer says nothing. */
function remember(model: string, refusal: Refusal | "bad_answer") {
  if (refusal !== "bad_answer") markUnavailable(model, refusal);
}

/** What to say after every model in the chain has refused: the most useful of their errors. */
function exhausted(failures: ReadonlyArray<{ model: string; error: unknown }>): Error {
  const tried = failures.map((failure) => failure.model);
  const errors = failures.map((failure) => failure.error);
  // A quota error is the most actionable, so it wins over an overload.
  if (errors.some((e) => e instanceof RateLimitError)) return new RateLimitError(tried);
  if (errors.some((e) => e instanceof ModelOverloadedError)) return new ModelOverloadedError(tried);
  if (errors.some((e) => e instanceof ModelTimeoutError)) return new ModelTimeoutError();
  const malformed = errors.filter((e) => e instanceof MalformedAppraisalError);
  if (malformed.length > 0) return malformed[malformed.length - 1];
  return new ModelNotFoundError(tried);
}

function noteRefusal(model: string, error: unknown, remaining: number) {
  const name = error instanceof Error ? error.name : "error";
  console.warn(
    `Gemini model ${model} refused (${name})${remaining > 0 ? `; ${remaining} more to try` : ""}`,
  );
}

/** "Tried a, b, c." for a message, or nothing when only one model was ever asked. */
export function triedNote(error: unknown): string {
  const tried = (error as { tried?: readonly string[] } | null)?.tried ?? [];
  return tried.length > 1 ? ` Tried ${tried.join(", ")}.` : "";
}

/**
 * Runs `attempt` against each model in the chain until one answers.
 *
 * `attempt` throws whatever the SDK throws; it is classified here. The order puts
 * models that just refused last (see lib/model-health.ts), and a model that refuses
 * is remembered for next time. It is told how long it may take: never more than
 * `CALL_TIMEOUT_MS`, and less once the chain has used up most of its budget.
 */
async function withModels<T>(attempt: (model: string, timeoutMs: number) => Promise<T>): Promise<T> {
  const models = inTryOrder(env.geminiModels);
  const failures: Array<{ model: string; error: unknown }> = [];
  const started = Date.now();

  for (const [index, model] of models.entries()) {
    const left = CHAIN_BUDGET_MS - (Date.now() - started);
    if (failures.length > 0 && left < MIN_ATTEMPT_MS) break;
    try {
      return await attempt(model, Math.min(CALL_TIMEOUT_MS, left));
    } catch (raw) {
      const error = normalise(raw);
      const refusal = refusalOf(error);
      if (!refusal) throw error;
      remember(model, refusal);
      failures.push({ model, error });
      noteRefusal(model, error, models.length - index - 1);
    }
  }
  throw exhausted(failures);
}

/**
 * Models that answered 400 to a thinking setting. Asked once, then left alone: the
 * setting is an optimisation, and a model that cannot take it is still a model.
 */
const rejectsThinking = new Set<string>();

/**
 * Thinking kept low. The default for the 3.x models is to think for a long time
 * before the first word, which is the largest part of how slow a reply or a lookup
 * feels, and none of these calls (a short reply, reading facts, reading listings)
 * needs it.
 */
async function lowThinking<T>(
  model: string,
  config: GenerateContentConfig,
  call: (config: GenerateContentConfig) => Promise<T>,
): Promise<T> {
  if (rejectsThinking.has(model)) return call(config);
  try {
    return await call({ ...config, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } });
  } catch (error) {
    const rejected =
      error instanceof ApiError && error.status === 400 && /thinking/i.test(error.message);
    if (!rejected) throw error;
    rejectsThinking.add(model);
    console.warn(`Gemini model ${model} does not take a thinking level; asking without one`);
    return call(config);
  }
}

/**
 * Streams the model's reply. Raw text — stage markers are still embedded and
 * must be stripped by the caller before the person sees it.
 *
 * Moves to the next model only if the current one refused before saying anything:
 * half a reply from one model and the rest from another would be worse than an error.
 */
export async function* streamReply(
  transcript: TranscriptMessage[],
  photos: Photo[],
  stage: Stage,
  context: TurnContext,
): AsyncGenerator<string> {
  const models = inTryOrder(env.geminiModels);
  const failures: Array<{ model: string; error: unknown }> = [];

  for (const [index, model] of models.entries()) {
    let spoke = false;
    try {
      const stream = await lowThinking(model, {
        systemInstruction: systemInstruction(stage, context),
        temperature: TEMPERATURE,
        abortSignal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
      }, (config) =>
        getClient().models.generateContentStream({
          model,
          contents: toContents(transcript, photos, stage !== "verdict"),
          config,
        }),
      );
      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) {
          spoke = true;
          yield text;
        }
      }
      return;
    } catch (raw) {
      const error = normalise(raw);
      const refusal = refusalOf(error);
      if (spoke || !refusal) throw error;
      remember(model, refusal);
      failures.push({ model, error });
      noteRefusal(model, error, models.length - index - 1);
    }
  }
  throw exhausted(failures);
}

/**
 * The item as data, from the conversation and the photos.
 *
 * Runs with no tools and no knowledge of the price they locked in; it does see
 * what they said they paid, because the verdict talks about it. An empty `model`
 * is a valid result — it means the conversation never pinned the item down, and
 * the route turns that into a request for more questions.
 */
export async function extractFacts(
  transcript: TranscriptMessage[],
  photos: Photo[],
  intake: Intake,
): Promise<ItemFacts> {
  return withModels(async (model, timeoutMs) => {
    const response = await lowThinking(
      model,
      {
        systemInstruction: factsSystem(intake),
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: FACTS_SCHEMA,
        abortSignal: AbortSignal.timeout(timeoutMs),
      },
      (config) =>
        getClient().models.generateContent({
          model,
          contents: [
            ...toContents(transcript, photos, true),
            { role: "user", parts: [{ text: FACTS_REQUEST }] },
          ],
          config,
        }),
    );
    // Parsed inside the attempt: an answer that is not the schema is a reason to
    // ask the next model, not to give up.
    return parseFacts(response.text, env.vndPerUsd);
  });
}

/**
 * Reads listings out of the sources, with no tools.
 *
 * Takes the facts through `forSearch`, so neither what they paid nor anything
 * they said about price can reach the model that is reading listings. The price
 * they locked in is never passed to this module at all.
 *
 * No sources is a valid input, not an error — a rare item may simply return
 * nothing — and costs no call.
 */
export async function readListings(
  facts: ItemFacts,
  sources: readonly Source[],
): Promise<MarketReading> {
  if (sources.length === 0) return EMPTY_READING;

  return withModels(async (model, timeoutMs) => {
    const response = await lowThinking(
      model,
      {
        systemInstruction: EXTRACT_INSTRUCTION,
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: extractionSchema(sources.length),
        abortSignal: AbortSignal.timeout(timeoutMs),
      },
      (config) =>
        getClient().models.generateContent({
          model,
          contents: readingPrompt(facts, sources),
          config,
        }),
    );
    return parseReading(response.text);
  });
}

/** The SDK reports a cancelled call under a few names, depending on where it was caught. */
function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      /aborted|timed out/i.test(error.message))
  );
}

function normalise(error: unknown): unknown {
  if (error instanceof ApiError && error.status === 429) {
    return new RateLimitError();
  }
  if (error instanceof ApiError && error.status === 503) {
    return new ModelOverloadedError();
  }
  if (error instanceof ApiError && error.status === 404) {
    return new ModelNotFoundError();
  }
  if (isAbort(error)) return new ModelTimeoutError();
  return error;
}
