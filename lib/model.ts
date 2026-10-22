/**
 * Which model answers: Gemini, with DeepSeek behind it.
 *
 * The routes call these three functions and never a model directly. Each tries
 * Gemini first. If Gemini says its quota is out (429) or that it is overloaded
 * (503) *and* a DeepSeek key is configured, the same call is made to DeepSeek
 * instead and the caller is told through `onFallback`, so the person can be told
 * too.
 *
 * What does not fall back, on purpose:
 *
 * - **Timeouts.** A call that has already used its 45 seconds leaves no time for a
 *   second one inside a 60-second request, and a hang says nothing about quota.
 * - **A model that answered badly** (malformed JSON, wrong schema). That is not
 *   availability; a different model gets a different chance, but silently swapping
 *   it in would hide a prompt problem from whoever is debugging it.
 * - **A stream that has already started.** Half of one reply from one model and
 *   half from another is worse than an error. Gemini quota errors arrive before the
 *   first token, so in practice this only matters for a mid-reply failure.
 *
 * When the backup fails as well, the error that reaches the route is
 * `BackupFailedError`, carrying both, so the message can say what happened to each
 * rather than blaming only the one the person was expecting.
 */
import "server-only";
import {
  extractFacts as deepseekExtractFacts,
  isConfigured as backupConfigured,
  readListings as deepseekReadListings,
  streamReply as deepseekStreamReply,
} from "./deepseek";
import {
  ModelOverloadedError,
  RateLimitError,
  extractFacts as geminiExtractFacts,
  readListings as geminiReadListings,
  streamReply as geminiStreamReply,
  type MarketReading,
  type TurnContext,
} from "./gemini";
import type { Intake, ItemFacts, Photo } from "./item";
import type { Source } from "./sources";
import type { Stage } from "./stages";
import type { TranscriptMessage } from "./transcript";

/** Both models failed. `primary` is Gemini's error, `backup` is DeepSeek's. */
export class BackupFailedError extends Error {
  constructor(
    readonly primary: unknown,
    readonly backup: unknown,
  ) {
    super("The backup model failed as well");
    this.name = "BackupFailedError";
  }
}

/** The error a route should classify: Gemini's, even when the backup also failed. */
export function primaryOf(error: unknown): unknown {
  return error instanceof BackupFailedError ? error.primary : error;
}

/** A sentence for the person debugging a free tier, empty when there was no backup attempt. */
export function backupNote(error: unknown): string {
  if (!(error instanceof BackupFailedError)) return "";
  const why = error.backup instanceof Error ? error.backup.message : "it failed";
  return ` The backup model (DeepSeek) failed too: ${why}.`;
}

/** Quota and overload are the model's availability; nothing else triggers the backup. */
function shouldFallBack(error: unknown): boolean {
  return (
    backupConfigured() &&
    (error instanceof RateLimitError || error instanceof ModelOverloadedError)
  );
}

export type OnFallback = () => void;

async function withBackup<T>(
  primary: () => Promise<T>,
  backup: () => Promise<T>,
  onFallback?: OnFallback,
): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    if (!shouldFallBack(error)) throw error;
    onFallback?.();
    try {
      return await backup();
    } catch (backupError) {
      console.warn("backup model failed:", backupError);
      throw new BackupFailedError(error, backupError);
    }
  }
}

/** The item as data. The backup reads the conversation only: it is never sent a photo. */
export function extractFacts(
  transcript: TranscriptMessage[],
  photos: Photo[],
  intake: Intake,
  onFallback?: OnFallback,
): Promise<ItemFacts> {
  return withBackup(
    () => geminiExtractFacts(transcript, photos, intake),
    () => deepseekExtractFacts(transcript, intake),
    onFallback,
  );
}

/** Listings out of the sources. */
export function readListings(
  facts: ItemFacts,
  sources: readonly Source[],
  onFallback?: OnFallback,
): Promise<MarketReading> {
  return withBackup(
    () => geminiReadListings(facts, sources),
    () => deepseekReadListings(facts, sources),
    onFallback,
  );
}

/**
 * The streamed reply. Falls back only if Gemini failed before it said anything.
 */
export async function* streamReply(
  transcript: TranscriptMessage[],
  photos: Photo[],
  stage: Stage,
  context: TurnContext,
  onFallback?: OnFallback,
): AsyncGenerator<string> {
  let spoke = false;
  let primary: unknown;

  try {
    for await (const chunk of geminiStreamReply(transcript, photos, stage, context)) {
      spoke = true;
      yield chunk;
    }
    return;
  } catch (error) {
    if (spoke || !shouldFallBack(error)) throw error;
    primary = error;
  }

  onFallback?.();
  try {
    yield* deepseekStreamReply(transcript, stage, context);
  } catch (backupError) {
    console.warn("backup model failed:", backupError);
    throw new BackupFailedError(primary, backupError);
  }
}

