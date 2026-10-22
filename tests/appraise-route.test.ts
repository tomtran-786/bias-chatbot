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
          newPrice: 700,
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
