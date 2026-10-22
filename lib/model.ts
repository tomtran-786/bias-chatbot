/**
 * Which model answers: Gemini, then the free backup, then the paid one.
 *
 * The routes call these three functions and never a model directly. Each tries
 * Gemini first (lib/gemini.ts, which already walks its own chain of Gemini models).
 * If Gemini says it is out of quota (429) or overloaded (503) for every model, and a
 * backup is configured, the same call goes to the backups in order:
 *
 *   1. OpenRouter, free models only (lib/openrouter.ts). Costs nothing.
 *   2. DeepSeek (lib/deepseek.ts). Prepaid, so last: it is only reached if the free
 *      option is absent or has failed too.
 *
 * A backup that fails for any reason hands over to the next, because by then Gemini
 * has already refused and any answer beats none. The caller is told which backup
 * actually answered through `onFallback`, so the person can be told too.
 *
 * What does not fall back, on purpose:
 *
 * - **Timeouts.** A call that has already used its 45 seconds leaves no time for a
 *   second one inside a 60-second request, and a hang says nothing about quota.
 * - **Gemini answering badly** (malformed JSON, wrong schema). That is not
 *   availability; silently swapping the model would hide a prompt problem from
 *   whoever is debugging it.
 * - **A Gemini stream that has already started.** Half of one reply from one model
 *   and half from another is worse than an error. Quota errors arrive before the
 *   first token, so in practice this only matters for a mid-reply failure.
 *
 * When every backup fails as well, the error that reaches the route is
 * `BackupFailedError`, carrying all of them, so the message can say what happened to
 * each rather than blaming only the one the person was expecting.
 */
import "server-only";
import type { Backend } from "./backup";
import { deepseek } from "./deepseek";
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
import { openrouter } from "./openrouter";
import type { Source } from "./sources";
import type { Stage } from "./stages";
import type { TranscriptMessage } from "./transcript";

export type BackupAttempt = { provider: string; error: unknown };

/** Every backup failed. `primary` is Gemini's error, `backups` are theirs, in the order tried. */
export class BackupFailedError extends Error {
  constructor(
    readonly primary: unknown,
    readonly backups: readonly BackupAttempt[],
  ) {
    super("The backup models failed as well");
    this.name = "BackupFailedError";
  }
}

/** The error a route should classify: Gemini's, even when the backups also failed. */
export function primaryOf(error: unknown): unknown {
  return error instanceof BackupFailedError ? error.primary : error;
}

/** A sentence for the person debugging a free tier, empty when no backup was tried. */
export function backupNote(error: unknown): string {
  if (!(error instanceof BackupFailedError) || error.backups.length === 0) return "";
  const why = (attempt: BackupAttempt) =>
    attempt.error instanceof Error ? attempt.error.message : "it failed";
  if (error.backups.length === 1) {
    const [only] = error.backups;
    return ` The backup model (${only.provider}) failed too: ${why(only)}.`;
  }
  return ` The backup models failed too: ${error.backups.map((a) => `${a.provider}: ${why(a)}`).join("; ")}.`;
}

/** The backups that are set up, free before paid. */
function backups(): Backend[] {
  return [openrouter, deepseek].filter((backend) => backend.isConfigured());
}

/** Quota and overload are the model's availability; nothing else triggers a backup. */
function shouldFallBack(error: unknown): boolean {
  return (
    (error instanceof RateLimitError || error instanceof ModelOverloadedError) &&
    backups().length > 0
  );
}

/** Told which backup answered, once it has. */
export type OnFallback = (provider: string) => void;

async function withBackup<T>(
  primary: () => Promise<T>,
  run: (backend: Backend) => Promise<T>,
  onFallback?: OnFallback,
): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    if (!shouldFallBack(error)) throw error;

    const failures: BackupAttempt[] = [];
    for (const backend of backups()) {
      try {
        const result = await run(backend);
        onFallback?.(backend.name);
        return result;
      } catch (backupError) {
        console.warn(`backup model ${backend.name} failed:`, backupError);
        failures.push({ provider: backend.name, error: backupError });
      }
    }
    throw new BackupFailedError(error, failures);
  }
}

/** The item as data. A backup reads the conversation only: it is never sent a photo. */
export function extractFacts(
  transcript: TranscriptMessage[],
  photos: Photo[],
  intake: Intake,
  onFallback?: OnFallback,
): Promise<ItemFacts> {
  return withBackup(
    () => geminiExtractFacts(transcript, photos, intake),
    (backend) => backend.extractFacts(transcript, intake),
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
    (backend) => backend.readListings(facts, sources),
    onFallback,
  );
}

/**
 * The streamed reply. Falls back only if Gemini failed before it said anything, and
 * a backup is only announced once it has produced its first words, so a backup that
 * fails to start is never mistaken for the one that answered.
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

  const failures: BackupAttempt[] = [];
  for (const backend of backups()) {
    const stream = backend.streamReply(transcript, stage, context);

    let first: IteratorResult<string>;
    try {
      first = await stream.next();
    } catch (error) {
      console.warn(`backup model ${backend.name} failed:`, error);
      failures.push({ provider: backend.name, error });
      continue;
    }
    if (first.done) {
      failures.push({ provider: backend.name, error: new Error(`${backend.name} sent an empty reply`) });
      continue;
    }

    onFallback?.(backend.name);
    yield first.value;
    try {
      for await (const chunk of stream) yield chunk;
      return;
    } catch (error) {
      // Mid-reply: it has already spoken, so no other backup may continue it.
      console.warn(`backup model ${backend.name} failed:`, error);
      throw new BackupFailedError(primary, [...failures, { provider: backend.name, error }]);
    }
  }
  throw new BackupFailedError(primary, failures);
}
