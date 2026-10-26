/**
 * The market route, run for real with the model SDK and the search service
 * replaced.
 *
 * Replacing them at that boundary is the point: the claims worth proving are about
 * what actually leaves the process in a request. The queries and the model that
 * reads the results must never be shown what they paid or what they locked in;
 * no call may give the model a tool; and the links the person sees must be the
 * ones the search returned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.hoisted(() => vi.fn());
const searchListings = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  class FakeGoogleGenAI {
    models = { generateContent, generateContentStream: vi.fn() };
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

// Keep the real error classes (the route tells them apart); replace only the call.
vi.mock("@/lib/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search")>();
  return { ...actual, searchListings };
});

const { POST: market } = await import("@/app/api/market/route");
const { computeAppraisal } = await import("@/lib/pricing");
const { ApiError } = await import("@google/genai");
const { FACT_COUNT } = await import("@/lib/stages");
const { MAX_SOURCES } = await import("@/lib/sources");
const { resetBudget } = await import("@/lib/budget");
const { SearchFailedError, SearchQuotaError, SearchRateLimitError, SearchUnavailableError } =
  await import("@/lib/search");

const at = new Date().toISOString();

// Distinctive on purpose, so a substring check cannot match something else.
const PAID = 849;
const LOCKED = 637;

const photo = { id: "p1", mime: "image/jpeg" as const, data: "eA==" };

const transcript = Array.from({ length: FACT_COUNT }, (_, index) => [
  {
    role: "user" as const,
    text:
      index === 0
        ? "I'm selling: iPhone 13"
        : index === 1
          ? `I paid $${PAID} for it`
          : `answer ${index}`,
    at,
    photoIds: index === 0 ? ["p1"] : undefined,
  },
  { role: "model" as const, text: `question ${index + 1}`, at },
]).flat();

const body = {
  intake: { item: "iPhone 13, 128GB, blue" },
  photos: [photo],
  askingPrice: { usd: LOCKED },
  transcript,
};

const FACTS = {
  searchQuery: "iPhone 13 128GB",
  model: "iPhone 13",
  condition: "good",
  included: ["box"],
  defects: ["scratch on the back"],
  purchasePrice: PAID,
  ageMonths: 18,
};

/** Five pages, each with one price written in its text. */
const PAGES = [
  { url: "https://www.ebay.com/itm/1", price: "US $200.00" },
  { url: "https://www.ebay.com/itm/2", price: "US $250.00" },
  { url: "https://swappa.com/listing/a", price: "$300" },
  { url: "https://swappa.com/prices/b", price: "$350" },
  { url: "https://www.mercari.com/us/item/m1/", price: "$400" },
];

const hits = PAGES.map((page) => ({
  title: `iPhone 13 ${page.url}`,
  url: page.url,
  content: `iPhone 13 128GB. ${page.price}. Good condition.`,
  rawContent: null,
}));

/** Six priced pages: enough that the search is not widened. */
const sixPages = [
  ...hits,
  { title: "iPhone 13 six", url: "https://www.ebay.com/itm/6", content: "iPhone 13. $450.", rawContent: null },
];

const listings = PAGES.map((page, index) => ({
  title: `iPhone 13 #${index}`,
  priceText: page.price,
  kind: "sold",
  condition: "good",
  platform: "somewhere the model made up",
  sourceIndex: index,
  // A URL the model wrote. It must never reach the person.
  url: "https://evil.example/phish",
}));

type Request = { contents: unknown; config?: { tools?: unknown; responseJsonSchema?: unknown } };

/** Answers the two model calls the route makes, told apart by what each asks for. */
function scripted(
  overrides: {
    facts?: unknown;
    reading?: unknown;
    results?: unknown;
  } = {},
) {
  searchListings.mockImplementation(async (queries: Array<{ query: string }>) => ({
    results: overrides.results ?? hits,
    queries: queries.map((q) => q.query),
    credits: queries.length,
  }));
  generateContent.mockImplementation(async (request: Request) => {
    const properties = (request.config?.responseJsonSchema as { properties: object }).properties;
    if (!("listings" in properties)) return { text: JSON.stringify(overrides.facts ?? FACTS) };
    return {
      text: JSON.stringify(
        overrides.reading ?? {
          listings,
          position: "typical",
          positionEvidence: "light wear on the back",
        },
      ),
    };
  });
}

async function step(payload: unknown) {
  const response = await market(
    new Request("http://localhost/api/market", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return { status: response.status, json: await response.json() };
}

/**
 * The whole lookup, the way the browser runs it: the three steps in order, then the
 * figures computed from the listings against a locked price. Stops at the first step
 * that fails and returns its answer.
 */
async function post(payload: {
  intake: unknown;
  photos: unknown;
  askingPrice?: { usd: number };
  transcript: unknown;
}) {
  const { intake, photos, transcript } = payload;
  const facts = await step({ step: "facts", intake, photos, transcript });
  if (facts.status !== 200) return facts;
  const search = await step({ step: "search", item: facts.json.item, transcript });
  if (search.status !== 200) return search;
  const read = await step({ step: "read", item: facts.json.item, sources: search.json.sources, transcript });
  if (read.status !== 200) return read;

  return {
    status: 200,
    json: {
      ...computeAppraisal(read.json.raw, payload.askingPrice?.usd ?? LOCKED),
      item: facts.json.item,
      raw: read.json.raw,
      queries: search.json.queries,
      backup: [...facts.json.backup, ...read.json.backup],
    },
  };
}

const modelRequests = () => generateContent.mock.calls.map(([request]) => request as Request);

beforeEach(() => {
  generateContent.mockReset();
  searchListings.mockReset();
  resetBudget();
  vi.spyOn(console, "error").mockImplementation(() => {});
  scripted();
});

describe("a healthy lookup", () => {
  it("returns the market, the suggestion and the gap, all computed here", async () => {
    const { status, json } = await post(body);

    expect(status).toBe(200);
    expect(json.market).toMatchObject({ tier: "full", count: 5, median: 300, q1: 250, q3: 350 });
    expect(json.suggested).toEqual({ price: 300, anchor: "median", capped: false });
    expect(json.gap.amount).toBe(LOCKED - 300);
    expect(json.overpriced).toBe(true); // 637 against 300
    expect(json.item.purchasePrice).toBe(PAID);
    expect(json.raw.listings).toHaveLength(5);
    // Five priced pages is thin, so the search was widened once.
    expect(json.queries).toEqual([
      "iPhone 13 128GB used sold price",
      "iPhone 13 128GB used for sale",
      "iPhone 13 128GB cũ",
      "iPhone 13 used price",
    ]);
    expect(json.raw.vndPerUsd).toBe(26_000);
    expect(json).not.toHaveProperty("searchEntryPoint");
  });

  it("shows only links the search returned, never the one the model wrote", async () => {
    const { json } = await post(body);

    expect(json.listings.map((l: { url: string }) => l.url)).toEqual(PAGES.map((p) => p.url));
    expect(JSON.stringify(json)).not.toContain("evil.example");
    // Nor the platform it claimed: that comes from the page's address.
    expect(json.listings.map((l: { platform: string }) => l.platform)).toEqual([
      "eBay", "eBay", "Swappa", "Swappa", "Mercari",
    ]);
    expect(json.listings.every((l: { match: string }) => l.match === "verified")).toBe(true);
  });

  it("does not count a price that is not in the text of the page it cites", async () => {
    scripted({
      reading: {
        // The model reports $320 for a page whose text says $300.
        listings: listings.map((l, i) => (i === 2 ? { ...l, priceText: "$320" } : l)),
        position: "typical",
        positionEvidence: "",
      },
    });
    const { json } = await post(body);

    const bad = json.listings.find((l: { priceText: string }) => l.priceText === "$320");
    expect(bad).toMatchObject({ match: "unverified", status: "unverified" });
    expect(json.market.count).toBe(4);
    expect(json.market.tier).toBe("thin");
  });

  it("does not count a price the model copied with its cents dropped", async () => {
    scripted({
      reading: {
        listings: listings.map((l, i) => (i === 0 ? { ...l, priceText: "US $200" } : l)),
        position: "typical",
        positionEvidence: "",
      },
    });
    // The page says "US $200.00"; "US $200" is the same amount with its cents
    // cut off, which is the kind of slip a verbatim check exists to catch.
    const { json } = await post(body);
    expect(json.listings.find((l: { priceText: string }) => l.priceText === "US $200")).toMatchObject({
      match: "unverified",
    });
  });
});

describe("the new price", () => {
  const NEW_URL = "https://www.bestbuy.com/site/iphone-13/1.p";
  /** A sixth page no listing cites, which states a new price. */
  const withNewPricePage = [
    ...hits,
    { title: "iPhone 13 | Best Buy", url: NEW_URL, content: "iPhone 13 128GB. $699.99. New.", rawContent: null },
  ];
  const reading = (newPrice: unknown) => ({ listings, newPrice, position: "typical", positionEvidence: "" });

  it("is used, and linked, when the page it cites shows it", async () => {
    scripted({ results: withNewPricePage, reading: reading({ priceText: "$699.99", sourceIndex: 5 }) });
    const { json } = await post(body);

    expect(json.newPrice).toBe(699.99);
    expect(json.newPriceUrl).toBe(NEW_URL);
    expect(json.raw).toMatchObject({ newPrice: 699.99, newPriceUrl: NEW_URL });
  });

  it("is not used when the page it cites does not show that price", async () => {
    scripted({ results: withNewPricePage, reading: reading({ priceText: "$599.99", sourceIndex: 5 }) });
    const { json } = await post(body);

    expect(json.newPrice).toBeNull();
    expect(json.newPriceUrl).toBeNull();
    expect(json.raw).toMatchObject({ newPrice: null, newPriceUrl: null });
  });

  it("is not used when the model took it from a different page than the one it cites", async () => {
    scripted({ results: withNewPricePage, reading: reading({ priceText: "$699.99", sourceIndex: 0 }) });
    const { json } = await post(body);

    expect(json.newPrice).toBeNull();
    expect(json.newPriceUrl).toBeNull();
  });

  it("does not hold the suggestion down when it cannot be checked", async () => {
    // $320 would cap the suggestion if it were believed; nothing shows it, so it is not.
    scripted({ results: withNewPricePage, reading: reading({ priceText: "$320.00", sourceIndex: 5 }) });
    const { json } = await post(body);

    expect(json.suggested).toEqual({ price: 300, anchor: "median", capped: false });
    expect(json.market.count).toBe(5);
  });
});

describe("what leaves the process", () => {
  it("never puts what they paid or what they locked in into a search query", async () => {
    await post(body);

    for (const [queries] of searchListings.mock.calls) {
      for (const { query } of queries as Array<{ query: string }>) {
        expect(query).not.toContain(String(PAID));
        expect(query).not.toContain(String(LOCKED));
        expect(query).not.toContain("$");
      }
    }
  });

  it("never shows the model that reads the results what they paid or locked in", async () => {
    await post(body);

    const reading = modelRequests().at(-1)!;
    const sent = JSON.stringify(reading);
    expect(sent).not.toContain(String(PAID));
    expect(sent).not.toContain(String(LOCKED));
    // ...and it was given the sources it is meant to read.
    expect(sent).toContain("https://www.ebay.com/itm/1");
  });

  it("does not leak a price written into the free-text facts either", async () => {
    scripted({
      facts: {
        ...FACTS,
        searchQuery: "iPhone 13 paid $849",
        variant: "128GB, paid $849 at the carrier",
        defects: ["scratch, cost me $637 to fix"],
      },
    });
    await post(body);

    const queries = searchListings.mock.calls.map(([q]) => q);
    // The sources below the item legitimately carry dollar amounts: those are the
    // listings. Only what describes the seller's item must be free of them.
    const itemBlock = String(modelRequests().at(-1)!.contents).split("Sources:")[0];
    const sent = JSON.stringify([queries, itemBlock]);
    expect(sent).not.toMatch(/849|637|\$\d/);
    expect(sent).toContain("128GB");
  });

  it("does not know the locked price when reading the facts either", async () => {
    await post(body);
    // The facts call sees the conversation, so it sees what they paid — the
    // verdict needs that. The locked price is not in the conversation at all.
    const facts = modelRequests()[0];
    expect(JSON.stringify(facts)).toContain(String(PAID));
    expect(JSON.stringify(facts)).not.toContain(String(LOCKED));
  });

  it("gives the model no tool on any call", async () => {
    await post(body);

    expect(modelRequests()).toHaveLength(2); // the facts, and the reading
    for (const request of modelRequests()) {
      expect(request.config).not.toHaveProperty("tools");
      expect(JSON.stringify(request)).not.toMatch(/googleSearch|google_search/);
    }
  });
});

describe("thin and empty markets", () => {
  it("answers 200 with a depreciated price when the search found nothing at all", async () => {
    scripted({ results: [] });

    const { status, json } = await post(body);

    expect(status).toBe(200);
    // $849 over 60 months to a $84.90 salvage, 18 months used.
    expect(json.market).toMatchObject({ tier: "estimate", method: "depreciation", count: 0, median: 619.77 });
    expect(json.suggested).toMatchObject({ price: 620, anchor: "median" });
    expect(json.gap).not.toBeNull();
    expect(json.listings).toEqual([]);
    expect(modelRequests()).toHaveLength(1); // no reading without sources
  });

  it("answers 200 with no price when there is nothing to depreciate either", async () => {
    scripted({ results: [], facts: { ...FACTS, purchasePrice: null } });

    const { status, json } = await post(body);

    expect(status).toBe(200);
    expect(json.market.tier).toBe("none");
    expect(json.suggested).toBeNull();
    expect(json.gap).toBeNull();
    expect(json.overpriced).toBe(false);
  });

  it("answers 200 and averages the listings when only two are usable", async () => {
    scripted({
      reading: { listings: listings.slice(0, 2), position: "typical", positionEvidence: "" },
    });
    const { status, json } = await post(body);
    expect(status).toBe(200);
    expect(json.market).toMatchObject({ tier: "sparse", method: "mean", count: 2, median: 225 });
    expect(json.suggested).toMatchObject({ price: 225, anchor: "median" });
  });

  it("shows listings it cannot verify, dimmed, and does not count them", async () => {
    scripted({
      results: hits.map((hit) => ({ ...hit, content: "A page with no prices in its text." })),
    });
    const { json } = await post(body);
    expect(json.market).toMatchObject({ tier: "estimate", count: 0 });
    expect(json.listings).toHaveLength(5);
    expect(json.listings.every((l: { status: string }) => l.status === "unverified")).toBe(true);
  });
});

describe("refusals", () => {
  it("sends them back to the questions when the item was never identified", async () => {
    scripted({ facts: { ...FACTS, model: "" } });
    const { status, json } = await post(body);
    expect(status).toBe(422);
    expect(json.error).toBe("needs_identity");
    expect(searchListings).not.toHaveBeenCalled();
  });

  it("refuses before the assistant has said anything", async () => {
    const { status, json } = await post({ ...body, transcript: transcript.slice(0, 1) });
    expect(status).toBe(409);
    expect(json.error).toBe("out_of_order");
    expect(generateContent).not.toHaveBeenCalled();
    expect(searchListings).not.toHaveBeenCalled();
  });

  it("refuses when no photo was ever shown", async () => {
    const { status } = await post({
      ...body,
      photos: [],
      transcript: transcript.map(({ photoIds: _ignored, ...rest }) => {
        void _ignored;
        return rest;
      }),
    });
    expect(status).toBe(409);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("does not need a locked price: no step is ever shown one", async () => {
    const { askingPrice: _ignored, ...withoutPrice } = body;
    void _ignored;
    expect((await post(withoutPrice)).status).toBe(200);
  });

  it("does not ask the questions to run their course by count: one reply is enough", async () => {
    // The assistant decides when it has the facts; `facts` is the check on it.
    const { status } = await post({ ...body, transcript: transcript.slice(0, 2) });
    expect(status).toBe(200);
  });

  it("rejects a step it does not know, and a body that is not one", async () => {
    expect((await step({ step: "price", transcript })).status).toBe(400);
    expect((await step(null)).status).toBe(400);
    expect((await step({ step: "read", item: FACTS, sources: "none", transcript })).status).toBe(400);
  });

  it("rejects more sources than the model is ever given", async () => {
    const sources = Array.from({ length: MAX_SOURCES + 1 }, (_, n) => ({
      url: `https://a.example/${n}`,
      title: "t",
      text: "$5",
    }));
    const { status } = await step({ step: "read", item: FACTS, sources, transcript });
    expect(status).toBe(400);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("rejects an oversized photo before any call", async () => {
    const big = Buffer.alloc(500 * 1024, 1).toString("base64");
    const { status } = await post({ ...body, photos: [{ ...photo, data: big }] });
    expect(status).toBe(413);
    expect(generateContent).not.toHaveBeenCalled();
    expect(searchListings).not.toHaveBeenCalled();
  });
});

describe("the daily budget", () => {
  afterEach(() => {
    delete process.env.DAILY_SEARCH_BUDGET;
    delete process.env.DAILY_MODEL_BUDGET;
  });

  it("is counted by the queries actually run: three, and a fourth when the first round was thin", async () => {
    process.env.DAILY_SEARCH_BUDGET = "10";
    await post(body); // five priced pages: thin, so widened
    expect((await import("@/lib/budget")).remaining("search")).toBe(10 - 4);

    resetBudget();
    scripted({ results: sixPages });
    await post(body); // six priced pages: enough, so not widened
    expect((await import("@/lib/budget")).remaining("search")).toBe(10 - 3);
  });

  it("refuses with budget_exhausted before searching, and does not spend", async () => {
    process.env.DAILY_SEARCH_BUDGET = "5"; // a lookup costs three, or four when widened

    expect((await post(body)).status).toBe(200); // spends four
    searchListings.mockClear();
    const refused = await step({ step: "search", item: FACTS, transcript });

    expect(refused.status).toBe(429);
    expect(refused.json.error).toBe("budget_exhausted");
    expect(searchListings).not.toHaveBeenCalled();
  });

  it("skips the widening quietly when only the first round is affordable", async () => {
    process.env.DAILY_SEARCH_BUDGET = "3";
    const { status, json } = await step({ step: "search", item: FACTS, transcript });
    expect(status).toBe(200);
    expect(searchListings).toHaveBeenCalledTimes(1);
    expect(json.queries).toHaveLength(3);
  });

  it("refuses when the model budget is the one that is short", async () => {
    process.env.DAILY_MODEL_BUDGET = "1";
    const first = await post(body); // facts takes the one call; the reading is refused
    expect(first.status).toBe(429);
    expect(first.json.error).toBe("budget_exhausted");
    const facts = await step({ step: "facts", intake: body.intake, photos: body.photos, transcript });
    expect(facts.status).toBe(429);
  });

  it("charges a reading nothing when there is nothing to read", async () => {
    process.env.DAILY_MODEL_BUDGET = "1";
    scripted({ results: [] });
    expect((await post(body)).status).toBe(200);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("failures", () => {
  it.each([
    ["search_quota", new SearchQuotaError(432), 429],
    ["search_quota", new SearchQuotaError(433), 429],
    ["rate_limited", new SearchRateLimitError(), 429],
    ["search_unavailable", new SearchUnavailableError("The search service rejected the API key"), 503],
    ["search_failed", new SearchFailedError("The search service answered 500"), 502],
  ])("maps a %s failure of the search to its own code", async (code, failure, expected) => {
    searchListings.mockRejectedValue(failure);
    const { status, json } = await post(body);
    expect(status).toBe(expected);
    expect(json.error).toBe(code);
  });

  it("says why the search is unavailable, since that is something to fix", async () => {
    searchListings.mockRejectedValue(new SearchUnavailableError("TAVILY_API_KEY is not set."));
    const { json } = await post(body);
    expect(json.reason).toContain("TAVILY_API_KEY");
  });

  it("does not retry: a failed search is one request, and the model never reads", async () => {
    searchListings.mockRejectedValue(new SearchQuotaError(432));
    await post(body);
    expect(searchListings).toHaveBeenCalledTimes(1);
    expect(generateContent).toHaveBeenCalledTimes(1); // the facts only
  });

  it("explains why, in the reason, and logs it for whoever is running this", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    searchListings.mockRejectedValue(new SearchQuotaError(432));
    const { json } = await post(body);
    expect(json.reason).toMatch(/monthly credits/);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/market search refused \(search_quota, 429\)/));
  });

  it("reports an exhausted model quota as 429", async () => {
    generateContent.mockRejectedValue(new ApiError({ message: "quota", status: 429 }));
    const { status, json } = await post(body);
    expect(status).toBe(429);
    expect(json.error).toBe("rate_limited");
    expect(json.reason).toMatch(/Gemini/);
  });

  it("says when it is the search service that is rate limiting, not the model", async () => {
    searchListings.mockRejectedValue(new SearchRateLimitError());
    const { json } = await post(body);
    expect(json.error).toBe("rate_limited");
    expect(json.reason).toMatch(/search service/);
  });

  it("answers a model that went quiet with a 504 once every model has, and says so", async () => {
    generateContent.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    const { status, json } = await post(body);
    expect(status).toBe(504);
    expect(json.error).toBe("appraisal_failed");
    expect(json.reason).toMatch(/too long/);
    expect(searchListings).not.toHaveBeenCalled();
    // Each model in the chain was given its chance, inside the one step.
    expect(generateContent.mock.calls.length).toBeGreaterThan(1);
  });

  it("gets past a model that hangs by asking the next one", async () => {
    const { env } = await import("@/lib/env");
    generateContent.mockImplementation(async (request: Request & { model: string }) => {
      if (request.model === env.geminiModels[0]) {
        throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      }
      return { text: JSON.stringify(FACTS) };
    });
    const { status, json } = await step({ step: "facts", intake: body.intake, photos: body.photos, transcript });
    expect(status).toBe(200);
    expect(json.item.model).toBe("iPhone 13");
  });

  it("explains a reading that does not fit the schema", async () => {
    scripted({ reading: { listings: "none", position: "typical", positionEvidence: "" } });
    const { status, json } = await post(body);
    expect(status).toBe(502);
    expect(json.error).toBe("appraisal_failed");
    expect(json.reason).toMatch(/listing extraction/);
  });

  it("explains facts that are not JSON", async () => {
    generateContent.mockResolvedValue({ text: "I cannot help with that." });
    const { status, json } = await post(body);
    expect(status).toBe(502);
    expect(json.reason).toMatch(/not valid JSON/);
  });
});

describe("the backup model", () => {
  const quota = () => new ApiError({ message: "quota", status: 429 });

  /** DeepSeek, told apart by what the request asks for, like the Gemini mock above. */
  function deepseekAnswers(over: { facts?: unknown; reading?: unknown } = {}) {
    const calls: Array<{ system: string; user: string; body: string }> = [];
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const system = body.messages[0].content as string;
      calls.push({ system, user: body.messages.at(-1).content, body: init.body as string });
      const reading = system.includes('"listings"');
      const content = reading
        ? (over.reading ?? { listings, position: "typical", positionEvidence: "light wear" })
        : (over.facts ?? FACTS);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchStub);
    return { calls, fetchStub };
  }

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "sk-test-key";
  });
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    vi.unstubAllGlobals();
  });

  it("carries the whole appraisal when Gemini's quota is out, and says which steps it took", async () => {
    generateContent.mockRejectedValue(quota());
    const { calls } = deepseekAnswers();

    const { status, json } = await post(body);

    expect(status).toBe(200);
    expect(json.backup).toEqual([
      { step: "facts", provider: "DeepSeek" },
      { step: "reading", provider: "DeepSeek" },
    ]);
    expect(json.market).toMatchObject({ tier: "full", count: 5, median: 300 });
    expect(json.item.model).toBe("iPhone 13");
    expect(calls).toHaveLength(2);
  });

  describe("OpenRouter, the free backup tried before DeepSeek", () => {
    /** Answers by host, so a test can tell which backup was asked. */
    function backups(opts: { openrouter?: "ok" | "limited" | "paid-model-check"; facts?: unknown; reading?: unknown } = {}) {
      const asked: Array<{ host: string; model: string; body: string }> = [];
      const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
        const sent = JSON.parse(init.body as string);
        const host = new URL(url).hostname;
        asked.push({ host, model: sent.model, body: init.body as string });
        if (host === "openrouter.ai" && opts.openrouter === "limited") return new Response("{}", { status: 429 });
        const reading = (sent.messages[0].content as string).includes('"listings"');
        const content = reading
          ? (opts.reading ?? { listings, position: "typical", positionEvidence: "light wear" })
          : (opts.facts ?? FACTS);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchStub);
      return { asked, fetchStub };
    }

    beforeEach(() => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.OPENROUTER_MODELS = "free-a/m:free,free-b/m:free";
    });
    afterEach(() => {
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_MODELS;
    });

    it("answers in DeepSeek's place, so nothing paid is touched while a free option works", async () => {
      generateContent.mockRejectedValue(quota());
      const { asked } = backups();

      const { status, json } = await post(body);

      expect(status).toBe(200);
      expect(json.backup).toEqual([
        { step: "facts", provider: "OpenRouter" },
        { step: "reading", provider: "OpenRouter" },
      ]);
      expect(asked.every((a) => a.host === "openrouter.ai")).toBe(true);
    });

    it("only ever asks for a free model, and sends no photo and no price they must not see", async () => {
      generateContent.mockRejectedValue(quota());
      const { asked } = backups();
      await post(body);

      for (const call of asked) {
        expect(call.model.endsWith(":free") || call.model === "openrouter/free").toBe(true);
        expect(call.body).not.toContain(photo.data);
        expect(call.body).not.toContain(String(LOCKED));
      }
      expect(asked[1].body).not.toContain(String(PAID)); // the reading
    });

    it("moves on to DeepSeek when the free models are all rate limited", async () => {
      generateContent.mockRejectedValue(quota());
      const { asked } = backups({ openrouter: "limited" });

      const { status, json } = await post(body);

      expect(status).toBe(200);
      expect(json.backup.map((b: { provider: string }) => b.provider)).toEqual(["DeepSeek", "DeepSeek"]);
      // Both free models were tried (once each) before any money was spent.
      const hosts = asked.map((a) => a.host);
      expect(hosts.indexOf("api.deepseek.com")).toBe(2);
      expect(hosts.slice(0, 2)).toEqual(["openrouter.ai", "openrouter.ai"]);
    });

    it("names every backup that failed when none could answer", async () => {
      generateContent.mockRejectedValue(quota());
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const { status, json } = await post(body);

      expect(status).toBe(429);
      expect(json.reason).toMatch(/The backup models failed too: OpenRouter: OpenRouter is rate limiting this key; DeepSeek: DeepSeek is rate limiting this key/);
    });

    it("is not used when DeepSeek alone is set up and OpenRouter has no key", async () => {
      delete process.env.OPENROUTER_API_KEY;
      generateContent.mockRejectedValue(quota());
      const { asked } = backups();
      await post(body);
      expect(asked.every((a) => a.host === "api.deepseek.com")).toBe(true);
    });
  });

  it("tries every Gemini model before it uses DeepSeek", async () => {
    generateContent.mockRejectedValue(quota());
    deepseekAnswers();
    await post(body);

    const { env } = await import("@/lib/env");
    const asked = generateContent.mock.calls.map(([request]) => request.model);
    // The facts call went down the whole chain; only then did DeepSeek answer it.
    expect(asked.slice(0, env.geminiModels.length)).toEqual(env.geminiModels);
    expect(env.geminiModels.length).toBeGreaterThan(1);
  });

  it("does not touch DeepSeek when another Gemini model can answer", async () => {
    const { env } = await import("@/lib/env");
    generateContent.mockImplementation(async (request: Request & { model: string }) => {
      if (request.model === env.geminiModels[0]) throw quota();
      const properties = (request.config?.responseJsonSchema as { properties: object }).properties;
      return { text: JSON.stringify("listings" in properties ? { listings, position: "typical", positionEvidence: "" } : FACTS) };
    });
    const { fetchStub } = deepseekAnswers();

    const { status, json } = await post(body);

    expect(status).toBe(200);
    expect(json.backup).toEqual([]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("says which Gemini models were tried when nothing could answer", async () => {
    generateContent.mockRejectedValue(quota());
    delete process.env.DEEPSEEK_API_KEY;
    const { json } = await post(body);
    expect(json.reason).toMatch(/Tried gemini-/);
  });

  it("takes over a single step when only that one runs out", async () => {
    generateContent.mockImplementation(async (request: Request) => {
      const properties = (request.config?.responseJsonSchema as { properties: object }).properties;
      if ("listings" in properties) throw quota();
      return { text: JSON.stringify(FACTS) };
    });
    deepseekAnswers();

    const { status, json } = await post(body);
    expect(status).toBe(200);
    expect(json.backup).toEqual([{ step: "reading", provider: "DeepSeek" }]);
  });

  it("takes over for an overloaded Gemini as well", async () => {
    generateContent.mockRejectedValue(new ApiError({ message: "high demand", status: 503 }));
    deepseekAnswers();
    const { status, json } = await post(body);
    expect(status).toBe(200);
    expect(json.backup).toEqual([
      { step: "facts", provider: "DeepSeek" },
      { step: "reading", provider: "DeepSeek" },
    ]);
  });

  it("reports no backup when Gemini answered", async () => {
    deepseekAnswers();
    const { json } = await post(body);
    expect(json.backup).toEqual([]);
  });

  it("is never sent a photo, and the reading is never sent what they paid or locked in", async () => {
    generateContent.mockRejectedValue(quota());
    const { calls } = deepseekAnswers();
    await post(body);

    for (const call of calls) {
      expect(call.body).not.toContain(photo.data);
      expect(call.body).not.toContain(photo.id);
      expect(call.body).not.toContain(String(LOCKED));
    }
    const [facts, reading] = calls;
    expect(facts.body).toContain(String(PAID)); // the facts call reads the conversation
    expect(reading.body).not.toContain(String(PAID));
    expect(facts.system).toMatch(/cannot see their photos/);
    // and the search queries are built the same way whichever model wrote the facts
    for (const [queries] of searchListings.mock.calls) {
      for (const { query } of queries as Array<{ query: string }>) expect(query).not.toMatch(/849|637|\$/);
    }
  });

  it("still checks every price against its source, whoever read the page", async () => {
    generateContent.mockRejectedValue(quota());
    deepseekAnswers({
      reading: {
        listings: listings.map((l, i) => (i === 2 ? { ...l, priceText: "$320" } : l)),
        position: "typical",
        positionEvidence: "",
      },
    });
    const { json } = await post(body);
    expect(json.listings.find((l: { priceText: string }) => l.priceText === "$320")).toMatchObject({ match: "unverified" });
    expect(json.market.count).toBe(4);
  });

  it("says what happened to both when the backup fails too", async () => {
    generateContent.mockRejectedValue(quota());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 402 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { status, json } = await post(body);

    expect(status).toBe(429);
    expect(json.error).toBe("rate_limited");
    expect(json.reason).toMatch(/Gemini is rate limiting/);
    expect(json.reason).toMatch(/backup model \(DeepSeek\) failed too: The DeepSeek balance is empty/);
    expect(searchListings).not.toHaveBeenCalled();
  });

  it("explains an unreadable answer from the backup", async () => {
    generateContent.mockRejectedValue(quota());
    deepseekAnswers({ facts: { model: 3 } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { json } = await post(body);
    expect(json.error).toBe("rate_limited");
    expect(json.reason).toMatch(/did not match the schema/);
  });

  it("does nothing different with no key: the quota error is reported, and nothing is called", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    generateContent.mockRejectedValue(quota());
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    const { status, json } = await post(body);

    expect(status).toBe(429);
    expect(json.reason).not.toMatch(/backup/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("does not take over for a timeout or a bad answer, once the whole Gemini chain has had it", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    generateContent.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    expect((await post(body)).status).toBe(504);

    generateContent.mockReset();
    generateContent.mockResolvedValue({ text: "not json" });
    expect((await post(body)).status).toBe(502);

    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("the facts step", () => {
  const facts = () => step({ step: "facts", intake: body.intake, photos: body.photos, transcript });

  it("returns only the item and which backup read it", async () => {
    const { status, json } = await facts();
    expect(status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(["backup", "item"]);
    expect(searchListings).not.toHaveBeenCalled();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("converts a price given in đồng in code, at the configured rate", async () => {
    process.env.VND_PER_USD = "25000";
    try {
      scripted({ facts: { ...FACTS, purchasePrice: 15_000_000, purchaseCurrency: "VND" } });
      const { status, json } = await facts();
      expect(status).toBe(200);
      expect(json.item.purchasePrice).toBe(600);
    } finally {
      delete process.env.VND_PER_USD;
    }
  });

  it("does not fail, every time, over a price the model left in đồng without saying so", async () => {
    // "mua 15 triệu" read as 15,000,000 dollars used to break the schema, and so every retry.
    scripted({ facts: { ...FACTS, purchasePrice: 15_000_000 } });
    const { status, json } = await facts();
    expect(status).toBe(200);
    expect(json.item.purchasePrice).toBeNull();
    expect(json.item.model).toBe("iPhone 13");
  });

  it("asks for the price in the currency it was said in, never converted by the model", async () => {
    await facts();
    const schema = JSON.stringify(modelRequests()[0].config?.responseJsonSchema);
    expect(schema).toContain("purchaseCurrency");
    expect(schema).toMatch(/15000000/);
  });
});

describe("the search step", () => {
  const search = (item: unknown = FACTS) => step({ step: "search", item, transcript });

  it("runs three queries in one call: two US and one Vietnamese, each on its own sites", async () => {
    scripted({ results: sixPages });
    const { json } = await search();

    expect(searchListings).toHaveBeenCalledTimes(1);
    const [queries] = searchListings.mock.calls[0];
    expect(queries.map((q: { query: string }) => q.query)).toEqual([
      "iPhone 13 128GB used sold price",
      "iPhone 13 128GB used for sale",
      "iPhone 13 128GB cũ",
    ]);
    expect(queries[0].domains).toContain("ebay.com");
    expect(queries[2].domains).toEqual(["chotot.com", "shopee.vn", "lazada.vn"]);
    expect(json.queries).toHaveLength(3);
  });

  it("numbers the sources the search returned and nothing else", async () => {
    scripted({ results: sixPages });
    const { json } = await search();
    expect(json.sources.map((s: { url: string }) => s.url)).toEqual(sixPages.map((p) => p.url));
  });

  it("widens once, on any site, when fewer than six sources carry a price", async () => {
    const { json } = await search();
    expect(searchListings).toHaveBeenCalledTimes(2);
    const [wider] = searchListings.mock.calls[1];
    expect(wider).toEqual([{ query: "iPhone 13 used price", domains: [] }]);
    expect(json.queries.at(-1)).toBe("iPhone 13 used price");
  });

  it("keeps the first round when the widening fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    searchListings
      .mockImplementationOnce(async (queries: Array<{ query: string }>) => ({
        results: hits,
        queries: queries.map((q) => q.query),
        credits: 3,
      }))
      .mockRejectedValueOnce(new SearchFailedError("The search timed out"));
    const { status, json } = await search();
    expect(status).toBe(200);
    expect(json.sources).toHaveLength(5);
    expect(json.queries).toHaveLength(3);
  });

  it("never searches the price they paid, in either currency", async () => {
    await search({ ...FACTS, searchQuery: "iPhone 13 mua 15 triệu", variant: "bought for 849 dollars" });
    for (const [queries] of searchListings.mock.calls) {
      for (const { query } of queries as Array<{ query: string }>) {
        expect(query).not.toMatch(/849|15|triệu|dollars/);
      }
    }
  });

  it("sends the person back to the questions when there is no model to search for", async () => {
    const { status, json } = await search({ ...FACTS, model: "" });
    expect(status).toBe(422);
    expect(json.error).toBe("needs_identity");
    expect(searchListings).not.toHaveBeenCalled();
  });

  it("calls no model", async () => {
    await search();
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("the read step, with listings in đồng", () => {
  const dong = [
    { url: "https://www.chotot.com/mua-ban/1.htm", price: "5.500.000 ₫" },
    { url: "https://www.chotot.com/mua-ban/2.htm", price: "5.250.000 ₫" },
    { url: "https://shopee.vn/iphone-13-i.1.2", price: "5,0 triệu" },
    { url: "https://www.lazada.vn/products/iphone-13-i1-s2.html", price: "5.750.000đ" },
    { url: "https://www.ebay.com/itm/9", price: "US $215.00" },
  ];
  const dongHits = dong.map((page) => ({
    title: `iPhone 13 cũ ${page.url}`,
    url: page.url,
    content: `iPhone 13 128GB cũ. ${page.price}.`,
    rawContent: null,
  }));
  const dongListings = dong.map((page, index) => ({
    title: `iPhone 13 #${index}`,
    priceText: page.price,
    kind: "active",
    condition: "good",
    platform: "?",
    sourceIndex: index,
  }));

  const read = async () => {
    process.env.VND_PER_USD = "25000";
    try {
      const sources = (await step({ step: "search", item: FACTS, transcript })).json.sources;
      return await step({ step: "read", item: FACTS, sources, transcript });
    } finally {
      delete process.env.VND_PER_USD;
    }
  };

  beforeEach(() => {
    scripted({
      results: dongHits,
      reading: { listings: dongListings, position: "typical", positionEvidence: "" },
    });
  });

  it("verifies each price in đồng against the page, and names the Vietnamese platforms from the URL", async () => {
    const { status, json } = await read();
    expect(status).toBe(200);
    expect(json.raw.listings.map((l: { platform: string }) => l.platform)).toEqual([
      "Chợ Tốt", "Chợ Tốt", "Shopee", "Lazada", "eBay",
    ]);
    expect(json.raw.listings.every((l: { match: string }) => l.match === "verified")).toBe(true);
  });

  it("carries the rate it will be converted at, so the browser and the verdict agree", async () => {
    const { json } = await read();
    expect(json.raw.vndPerUsd).toBe(25_000);

    const appraisal = computeAppraisal(json.raw, 300);
    // 220, 210, 200, 230 and 215 dollars: one median, in dollars.
    expect(appraisal.market).toMatchObject({ tier: "full", count: 5, median: 215 });
    expect(appraisal.listings.find((l) => l.priceText === "5.500.000 ₫")?.price).toBe(220);
  });

  it("is never shown what they paid, and makes one model call", async () => {
    await read();
    expect(modelRequests()).toHaveLength(1);
    expect(JSON.stringify(modelRequests()[0])).not.toContain(String(PAID));
  });

  it("tells the model to copy đồng prices as written and not to convert them", async () => {
    await read();
    const system = JSON.stringify(modelRequests()[0].config);
    expect(system).toContain("Chợ Tốt, Shopee and Lazada");
    expect(system).toMatch(/Đã bán/);
    expect(system).toMatch(/you never do/);
  });

  it("does not need a transcript that has a price in it, or any price at all", async () => {
    const { status } = await step({ step: "read", item: FACTS, sources: [], transcript });
    expect(status).toBe(200);
    expect(generateContent).not.toHaveBeenCalled();
  });
});
