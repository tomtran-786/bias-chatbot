/**
 * The browser's side of the market lookup: runs the three steps of
 * /api/market in order, and keeps what each one returned so that nothing already
 * done is done twice.
 *
 *   facts -> search -> read -> figures (computed here, lib/pricing.ts)
 *
 * It starts while the person is still deciding on a price. None of the steps is
 * shown that price or needs it, and nothing it finds is put on screen until the
 * price is locked, so the baseline they are about to give is as uncoached as it was
 * when the lookup waited for them. All that changes is how long they wait after.
 *
 * Each step is retried once if it failed in a way that may pass (a server error, a
 * timeout, a network drop). Never one that quota, a budget, a rate limit or a bad
 * key caused: asking again would only be refused again, and burn a call doing it.
 *
 * `MarketCache` is what makes a rerun cheap. When the person says something more
 * after the lookup has started, the facts are read again, but the search is reused if
 * the item it describes has not changed, and so is the reading if the facts it saw
 * have not.
 */
import { forSearch, searchName, type Intake, type ItemFacts, type Photo } from "./item";
import type { AppraisalInput } from "./pricing";
import type { Source } from "./sources";
import type { TranscriptMessage } from "./transcript";

export type MarketStep = "facts" | "search" | "read";
export type MarketBackup = Array<{ step: "facts" | "reading"; provider: string }>;

/** A failed step: the server's error code (or "network"), and its reason when it gave one. */
export class MarketError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(`The market lookup failed (${code})`);
    this.name = "MarketError";
  }
}

export type MarketCache = {
  facts?: { turns: number; item: ItemFacts; backup: MarketBackup };
  search?: { key: string; sources: Source[]; queries: string[] };
  read?: { key: string; raw: AppraisalInput; backup: MarketBackup };
};

export type MarketRun = {
  intake: Intake;
  photos: Photo[];
  transcript: TranscriptMessage[];
};

export type MarketResult = {
  item: ItemFacts;
  raw: AppraisalInput;
  queries: string[];
  backup: MarketBackup;
};

export type MarketOptions = {
  signal?: AbortSignal;
  /** Told when a step starts, and with "done" at the end. Not told of a step that was reused. */
  onStep?: (step: MarketStep | "done") => void;
  fetchImpl?: typeof fetch;
};

/** Codes that mean "not now, not by asking again". */
const NEVER_RETRY = new Set([
  "search_unavailable",
  "search_quota",
  "budget_exhausted",
  "rate_limited",
  "needs_identity",
  "out_of_order",
]);

export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function retryable(error: unknown): boolean {
  return (
    error instanceof MarketError &&
    !NEVER_RETRY.has(error.code) &&
    (error.code === "network" || error.status >= 500)
  );
}

async function once<T>(
  step: MarketStep,
  payload: Record<string, unknown>,
  { signal, fetchImpl = fetch }: MarketOptions,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl("/api/market", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, ...payload }),
      signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new MarketError("network", 0);
  }

  const body = (await response.json().catch(() => null)) as
    | (T & { error?: undefined })
    | { error?: string; reason?: string }
    | null;
  if (!response.ok || !body || body.error) {
    const failed = body as { error?: string; reason?: string } | null;
    throw new MarketError(failed?.error ?? "unknown", response.status, failed?.reason);
  }
  return body as T;
}

async function step<T>(
  name: MarketStep,
  payload: Record<string, unknown>,
  options: MarketOptions,
): Promise<T> {
  options.onStep?.(name);
  try {
    return await once<T>(name, payload, options);
  } catch (error) {
    if (!retryable(error) || options.signal?.aborted) throw error;
    return once<T>(name, payload, options);
  }
}

/** What the search was run for: the queries are built from these and nothing else. */
const searchKey = (item: ItemFacts) => `${searchName(item)}|${item.model}`;
/** What the reading saw: the item without what they paid, and the search it read. */
const readKey = (item: ItemFacts) => `${searchKey(item)}|${JSON.stringify(forSearch(item))}`;

/**
 * Runs whatever of the three steps the cache does not already hold, and returns
 * everything the market card is built from.
 *
 * Throws `MarketError` (`needs_identity` when the conversation never pinned the item
 * down), or an abort error if `signal` fired.
 */
export async function runMarket(
  run: MarketRun,
  cache: MarketCache,
  options: MarketOptions = {},
): Promise<MarketResult> {
  const { intake, photos, transcript } = run;

  let facts = cache.facts?.turns === transcript.length ? cache.facts : undefined;
  if (!facts) {
    const out = await step<{ item: ItemFacts; backup: MarketBackup }>(
      "facts",
      { intake, photos, transcript },
      options,
    );
    facts = { turns: transcript.length, item: out.item, backup: out.backup };
    cache.facts = facts;
  }
  const { item } = facts;
  if (!item.model.trim()) throw new MarketError("needs_identity", 422);

  let search = cache.search?.key === searchKey(item) ? cache.search : undefined;
  if (!search) {
    const out = await step<{ sources: Source[]; queries: string[] }>(
      "search",
      { item, transcript },
      options,
    );
    search = { key: searchKey(item), sources: out.sources, queries: out.queries };
    cache.search = search;
    cache.read = undefined;
  }

  const key = readKey(item);
  let read = cache.read?.key === key ? cache.read : undefined;
  if (!read) {
    const out = await step<{ raw: AppraisalInput; backup: MarketBackup }>(
      "read",
      { item, sources: search.sources, transcript },
      options,
    );
    read = { key, raw: out.raw, backup: out.backup };
    cache.read = read;
  }

  options.onStep?.("done");
  return {
    item,
    // The reading does not depend on what they paid, so a reused one takes the latest item.
    raw: { ...read.raw, item },
    queries: search.queries,
    backup: [...facts.backup, ...read.backup],
  };
}
