import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SearchFailedError,
  SearchQuotaError,
  SearchRateLimitError,
  SearchUnavailableError,
  searchListings,
} from "@/lib/search";
import { SEARCH_DOMAINS } from "@/lib/sources";

const KEY = "tvly-test-key-0123456789";

const ok = (results: unknown[], credits: number | null = 1) =>
  new Response(JSON.stringify({ results, ...(credits === null ? {} : { usage: { credits } }) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const status = (code: number) => new Response(JSON.stringify({ detail: "x" }), { status: code });

const hit = (url: string, content = "c", raw: string | null = null) => ({
  title: `title ${url}`,
  url,
  content,
  raw_content: raw,
  score: 0.5,
});

function stub(...answers: Array<Response | Error>) {
  const queue = [...answers];
  return vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch called more times than the test expected");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const bodyOf = (fetchImpl: ReturnType<typeof stub>, call = 0) =>
  JSON.parse((fetchImpl.mock.calls[call] as [string, RequestInit])[1].body as string);

beforeEach(() => {
  process.env.TAVILY_API_KEY = KEY;
});
afterEach(() => {
  delete process.env.TAVILY_API_KEY;
});

describe("the request", () => {
  it("posts to Tavily with a bearer key, one credit's worth of search, and the used-item sites", async () => {
    const fetchImpl = stub(ok([]));
    await searchListings(["iphone 13 used sold price"], { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);

    expect(bodyOf(fetchImpl)).toEqual({
      query: "iphone 13 used sold price",
      search_depth: "basic",
      max_results: 10,
      include_domains: SEARCH_DOMAINS,
      include_raw_content: "markdown",
      include_usage: true,
    });
  });

  it("can ask for the page text in the other form", async () => {
    const fetchImpl = stub(ok([]));
    await searchListings(["q"], { fetchImpl, rawContent: "text" });
    expect(bodyOf(fetchImpl).include_raw_content).toBe("text");
  });

  it("never asks for the costly depth, and never puts the key in the body", async () => {
    const fetchImpl = stub(ok([]), ok([]));
    await searchListings(["a", "b"], { fetchImpl });
    for (const call of [0, 1]) {
      expect(bodyOf(fetchImpl, call).search_depth).toBe("basic");
      expect(JSON.stringify(bodyOf(fetchImpl, call))).not.toContain(KEY);
    }
  });

  it("sends the queries exactly as given, one request each", async () => {
    const fetchImpl = stub(ok([]), ok([]));
    const out = await searchListings(["first query", "second query"], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchImpl, 0).query).toBe("first query");
    expect(bodyOf(fetchImpl, 1).query).toBe("second query");
    expect(out.queries).toEqual(["first query", "second query"]);
  });

  it("has a timeout", async () => {
    const fetchImpl = stub(ok([]));
    await searchListings(["q"], { fetchImpl });
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("the results", () => {
  it("merges the queries and drops a URL it has already seen, fragments aside", async () => {
    const fetchImpl = stub(
      ok([hit("https://www.ebay.com/itm/1"), hit("https://swappa.com/prices/x#top")]),
      ok([hit("https://swappa.com/prices/x"), hit("https://www.mercari.com/us/item/m1/")]),
    );
    const out = await searchListings(["a", "b"], { fetchImpl });
    expect(out.results.map((r) => r.url)).toEqual([
      "https://www.ebay.com/itm/1",
      "https://swappa.com/prices/x#top", // the first sighting wins
      "https://www.mercari.com/us/item/m1/",
    ]);
  });

  it("keeps different pages of one site apart", async () => {
    const fetchImpl = stub(
      ok([hit("https://www.ebay.com/sch/i.html?_nkw=a"), hit("https://www.ebay.com/sch/i.html?_nkw=b")]),
    );
    const out = await searchListings(["q"], { fetchImpl });
    expect(out.results).toHaveLength(2);
  });

  it("carries the page text through, or null when there is none", async () => {
    const fetchImpl = stub(ok([hit("https://a.example/1", "summary", "page body"), hit("https://a.example/2")]));
    const [first, second] = (await searchListings(["q"], { fetchImpl })).results;
    expect(first).toMatchObject({ content: "summary", rawContent: "page body" });
    expect(second.rawContent).toBeNull();
  });

  it("adds up the credits the service reports, and says null when it reports none", async () => {
    expect((await searchListings(["a", "b"], { fetchImpl: stub(ok([], 1), ok([], 2)) })).credits).toBe(3);
    expect((await searchListings(["a"], { fetchImpl: stub(ok([], null)) })).credits).toBeNull();
  });

  it("is fine with no results at all", async () => {
    const out = await searchListings(["a"], { fetchImpl: stub(ok([])) });
    expect(out.results).toEqual([]);
  });
});

describe("failures", () => {
  it.each([
    [401, SearchUnavailableError],
    [432, SearchQuotaError],
    [433, SearchQuotaError],
    [429, SearchRateLimitError],
    [500, SearchFailedError],
    [400, SearchFailedError],
    [422, SearchFailedError],
  ])("maps a %i to the right error", async (code, expected) => {
    await expect(searchListings(["q"], { fetchImpl: stub(status(code)) })).rejects.toBeInstanceOf(expected);
  });

  it("tells the plan limit from the pay-as-you-go limit", async () => {
    await expect(searchListings(["q"], { fetchImpl: stub(status(432)) })).rejects.toMatchObject({ status: 432 });
    await expect(searchListings(["q"], { fetchImpl: stub(status(433)) })).rejects.toMatchObject({ status: 433 });
  });

  it("never retries: a refused search makes exactly one request, even with more queries waiting", async () => {
    for (const code of [401, 429, 432, 433, 500]) {
      const fetchImpl = stub(status(code), ok([]), ok([]));
      await expect(searchListings(["a", "b"], { fetchImpl })).rejects.toBeInstanceOf(Error);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("does not retry a network error either", async () => {
    const fetchImpl = stub(new TypeError("fetch failed"), ok([]));
    await expect(searchListings(["a", "b"], { fetchImpl })).rejects.toBeInstanceOf(SearchFailedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("calls a timeout a timeout", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    await expect(searchListings(["q"], { fetchImpl: stub(timeout) })).rejects.toThrow(/timed out/);
  });

  it("rejects a response it cannot read", async () => {
    await expect(
      searchListings(["q"], { fetchImpl: stub(new Response("not json", { status: 200 })) }),
    ).rejects.toBeInstanceOf(SearchFailedError);
    await expect(
      searchListings(["q"], { fetchImpl: stub(new Response(JSON.stringify({ results: "no" }), { status: 200 })) }),
    ).rejects.toBeInstanceOf(SearchFailedError);
  });

  it("does not call out at all when there is no key", async () => {
    delete process.env.TAVILY_API_KEY;
    const fetchImpl = stub(ok([]));
    await expect(searchListings(["q"], { fetchImpl })).rejects.toThrow(/TAVILY_API_KEY is not set/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats an empty key the same as a missing one", async () => {
    process.env.TAVILY_API_KEY = "";
    await expect(searchListings(["q"], { fetchImpl: stub(ok([])) })).rejects.toBeInstanceOf(
      SearchUnavailableError,
    );
  });

  it("never lets the key into an error message", async () => {
    for (const code of [401, 429, 432, 433, 500]) {
      const error = await searchListings(["q"], { fetchImpl: stub(status(code)) }).catch((e: Error) => e);
      expect((error as Error).message).not.toContain(KEY);
    }
  });
});
