/**
 * Web search, by calling Tavily directly.
 *
 * The app searches and the model reads. The model is never given a search tool
 * and never decides when to search: this module runs a fixed number of
 * queries, built by code from facts that have had every price scrubbed out, and
 * hands the results to the model as plain text. That keeps the whole pipeline on
 * the model's free tier (no tool, so no tool quota) and keeps the one external
 * paid-by-the-call service behind a single function that can be counted.
 *
 * No retries, anywhere. A failed call is reported once and the request ends; a
 * retry loop is how a transient error turns into a burned quota.
 *
 * Plain `fetch`, no SDK: it is one POST.
 */
import "server-only";
import { z } from "zod";
import { env } from "./env";
import { SEARCH_DOMAINS, type SearchHit } from "./sources";

const ENDPOINT = "https://api.tavily.com/search";
const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;

/** Out of credits for the plan (432), or past the pay-as-you-go cap (433). */
export class SearchQuotaError extends Error {
  constructor(readonly status: number) {
    super(
      status === 433
        ? "The search service's pay-as-you-go limit is used up"
        : "The search service's monthly credits are used up",
    );
    this.name = "SearchQuotaError";
  }
}

/** Too many requests in a short time (429). Worth waiting a minute for. */
export class SearchRateLimitError extends Error {
  constructor() {
    super("The search service is rate limiting this key");
    this.name = "SearchRateLimitError";
  }
}

/** No usable key: missing, or rejected (401). A configuration problem, not a quota one. */
export class SearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchUnavailableError";
  }
}

/** Anything else: a network error, a timeout, a server error, a response we cannot read. */
export class SearchFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchFailedError";
  }
}

const responseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().default(""),
      url: z.string(),
      content: z.string().default(""),
      raw_content: z.string().nullish(),
    }),
  ),
  usage: z.object({ credits: z.number().optional() }).nullish(),
});

export type SearchOutput = {
  results: SearchHit[];
  /** The queries that were actually sent. */
  queries: string[];
  /** Credits the search service reports having used, when it says. */
  credits: number | null;
};

export type SearchOptions = {
  /** Which form of page text to ask for. The spike compares the two. */
  rawContent?: "markdown" | "text";
  fetchImpl?: typeof fetch;
};

/** One search. Throws one of the error classes above, never anything else. */
async function searchOnce(
  query: string,
  { rawContent = "markdown", fetchImpl = fetch }: SearchOptions,
): Promise<{ results: SearchHit[]; credits: number | null }> {
  let key: string;
  try {
    key = env.tavilyApiKey;
  } catch {
    throw new SearchUnavailableError(
      "TAVILY_API_KEY is not set. Add it to .env.local — see .env.example.",
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query,
        // "basic" is one credit; "advanced" is two and not needed to read prices.
        search_depth: "basic",
        max_results: MAX_RESULTS,
        include_domains: SEARCH_DOMAINS,
        include_raw_content: rawContent,
        include_usage: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new SearchFailedError(
      timedOut ? "The search timed out" : "The search could not be reached",
    );
  }

  if (response.status === 401) {
    throw new SearchUnavailableError("The search service rejected the API key");
  }
  if (response.status === 432 || response.status === 433) {
    throw new SearchQuotaError(response.status);
  }
  if (response.status === 429) throw new SearchRateLimitError();
  if (!response.ok) {
    throw new SearchFailedError(`The search service answered ${response.status}`);
  }

  const parsed = responseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new SearchFailedError("The search service sent a response that could not be read");
  }

  return {
    results: parsed.data.results.map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content,
      rawContent: result.raw_content ?? null,
    })),
    credits: parsed.data.usage?.credits ?? null,
  };
}

/** Drops the fragment, which never changes what a page is. */
function keyOf(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Runs each query in turn and merges the results, first sighting of a URL
 * winning.
 *
 * In turn rather than at once so that a failure stops the rest: if the first
 * query is refused for quota there is no reason to spend a credit finding out the
 * second would be too.
 */
export async function searchListings(
  queries: readonly string[],
  options: SearchOptions = {},
): Promise<SearchOutput> {
  const seen = new Set<string>();
  const results: SearchHit[] = [];
  let credits: number | null = null;

  for (const query of queries) {
    const out = await searchOnce(query, options);
    if (out.credits !== null) credits = (credits ?? 0) + out.credits;

    for (const hit of out.results) {
      const key = keyOf(hit.url);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(hit);
    }
  }

  return { results, queries: [...queries], credits };
}
