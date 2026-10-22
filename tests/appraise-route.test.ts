/**
 * The appraise route, run for real with the model SDK and the search service
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

const { POST: appraise } = await import("@/app/api/appraise/route");
const { ApiError } = await import("@google/genai");
const { FACT_COUNT } = await import("@/lib/stages");
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
  searchListings.mockResolvedValue({
    results: overrides.results ?? hits,
    queries: ["iPhone 13 128GB used sold price", "iPhone 13 128GB used for sale"],
    credits: 2,
  });
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

async function post(payload: unknown) {
  const response = await appraise(
    new Request("http://localhost/api/appraise", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return { status: response.status, json: await response.json() };
}

const modelRequests = () => generateContent.mock.calls.map(([request]) => request as Request);

beforeEach(() => {
  generateContent.mockReset();
  searchListings.mockReset();
  resetBudget();
  vi.spyOn(console, "error").mockImplementation(() => {});
  scripted();
});

describe("a healthy appraisal", () => {
  it("returns the market, the suggestion and the gap, all computed here", async () => {
    const { status, json } = await post(body);

    expect(status).toBe(200);
    expect(json.market).toMatchObject({ tier: "full", count: 5, median: 300, q1: 250, q3: 350 });
    expect(json.suggested).toEqual({ price: 300, anchor: "median", capped: false });
    expect(json.gap.amount).toBe(LOCKED - 300);
    expect(json.overpriced).toBe(true); // 637 against 300
    expect(json.item.purchasePrice).toBe(PAID);
    expect(json.raw.listings).toHaveLength(5);
    expect(json.queries).toEqual([
      "iPhone 13 128GB used sold price",
      "iPhone 13 128GB used for sale",
    ]);
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

    const [queries] = searchListings.mock.calls[0];
    expect(queries).toHaveLength(2);
    for (const query of queries as string[]) {
      expect(query).not.toContain(String(PAID));
      expect(query).not.toContain(String(LOCKED));
      expect(query).not.toContain("$");
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

    const [queries] = searchListings.mock.calls[0];
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
  it("answers 200 with no price when the search found nothing at all", async () => {
    scripted({ results: [] });

    const { status, json } = await post(body);

    expect(status).toBe(200);
    expect(json.market.tier).toBe("none");
    expect(json.suggested).toBeNull();
    expect(json.gap).toBeNull();
    expect(json.overpriced).toBe(false);
    expect(json.listings).toEqual([]);
    expect(modelRequests()).toHaveLength(1); // no reading without sources
  });

  it("answers 200 and withholds a price when only two listings are usable", async () => {
    scripted({
      reading: { listings: listings.slice(0, 2), position: "typical", positionEvidence: "" },
    });
    const { status, json } = await post(body);
    expect(status).toBe(200);
    expect(json.market.tier).toBe("none");
    expect(json.suggested).toBeNull();
  });

  it("shows listings it cannot verify, dimmed, and does not count them", async () => {
    scripted({
      results: hits.map((hit) => ({ ...hit, content: "A page with no prices in its text." })),
    });
    const { json } = await post(body);
    expect(json.market.tier).toBe("none");
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

  it("refuses before every fact has been asked about", async () => {
    const { status, json } = await post({ ...body, transcript: transcript.slice(0, (FACT_COUNT - 1) * 2) });
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

  it("refuses with no locked price", async () => {
    const { status } = await post({ ...body, askingPrice: undefined });
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

  it("refuses with budget_exhausted before calling anything, and does not spend", async () => {
    process.env.DAILY_SEARCH_BUDGET = "3"; // one appraisal costs two

    expect((await post(body)).status).toBe(200);
    const refused = await post(body);

    expect(refused.status).toBe(429);
    expect(refused.json.error).toBe("budget_exhausted");
    expect(generateContent).toHaveBeenCalledTimes(2); // only the first appraisal's
    expect(searchListings).toHaveBeenCalledTimes(1);
  });

  it("refuses when the model budget is the one that is short", async () => {
    process.env.DAILY_MODEL_BUDGET = "1";
    const { status, json } = await post(body);
    expect(status).toBe(429);
    expect(json.error).toBe("budget_exhausted");
    expect(searchListings).not.toHaveBeenCalled();
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

  it("answers a model that went quiet with a 504 and says so, rather than hanging", async () => {
    generateContent.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    const { status, json } = await post(body);
    expect(status).toBe(504);
    expect(json.error).toBe("appraisal_failed");
    expect(json.reason).toMatch(/too long/);
    expect(searchListings).not.toHaveBeenCalled();
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
    for (const query of searchListings.mock.calls[0][0] as string[]) {
      expect(query).not.toMatch(/849|637|\$/);
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

  it("does not take over for a timeout or a bad answer", async () => {
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
