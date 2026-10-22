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
  type Content,
  type Part,
} from "@google/genai";
import { env } from "./env";
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

/** Thrown when the Gemini quota is exhausted (HTTP 429). */
export class RateLimitError extends Error {
  constructor() {
    super("Gemini quota exhausted");
    this.name = "RateLimitError";
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
 * Longest one non-streaming call may take. The two appraisal calls run in
 * sequence inside a 60-second function, with a search between them, so each gets
 * well under that.
 */
const CALL_TIMEOUT_MS = 45_000;
/** A whole streamed reply, verdict included. Generous: it is a ceiling, not a target. */
const STREAM_TIMEOUT_MS = 120_000;

/**
 * Thrown on HTTP 503: the model is overloaded and will say so for a while. Like a
 * quota error it is the model's availability, not a fault in the request, which is
 * why the backup model takes over for it too.
 */
export class ModelOverloadedError extends Error {
  constructor() {
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
 * Streams the model's reply. Raw text — stage markers are still embedded and
 * must be stripped by the caller before the person sees it.
 */
export async function* streamReply(
  transcript: TranscriptMessage[],
  photos: Photo[],
  stage: Stage,
  context: TurnContext,
): AsyncGenerator<string> {
  let stream;
  try {
    stream = await getClient().models.generateContentStream({
      model: env.model,
      contents: toContents(transcript, photos, stage !== "verdict"),
      config: {
        systemInstruction: systemInstruction(stage, context),
        temperature: TEMPERATURE,
        abortSignal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
      },
    });
  } catch (error) {
    throw normalise(error);
  }

  try {
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) yield text;
    }
  } catch (error) {
    throw normalise(error);
  }
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
  let response;
  try {
    response = await getClient().models.generateContent({
      model: env.model,
      contents: [
        ...toContents(transcript, photos, true),
        { role: "user", parts: [{ text: FACTS_REQUEST }] },
      ],
      config: {
        systemInstruction: factsSystem(intake),
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: FACTS_SCHEMA,
        abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    });
  } catch (error) {
    throw normalise(error);
  }

  return parseFacts(response.text);
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

  let response;
  try {
    response = await getClient().models.generateContent({
      model: env.model,
      contents: readingPrompt(facts, sources),
      config: {
        systemInstruction: EXTRACT_INSTRUCTION,
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: extractionSchema(sources.length),
        abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    });
  } catch (error) {
    throw normalise(error);
  }

  return parseReading(response.text);
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
  if (isAbort(error)) return new ModelTimeoutError();
  return error;
}
