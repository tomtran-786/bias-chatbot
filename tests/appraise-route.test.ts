/**
 * The appraise route, run for real with only the SDK replaced.
 *
 * Mocking the SDK rather than `lib/gemini` is the point: the claim worth proving
 * is about what actually leaves the process in a request. The search must never
 * be shown what they paid or what they locked in, and the links the person sees
 * must be the ones the search returned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.GEMINI_API_KEY ??= "test-key";

const generateContent = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  class FakeGoogleGenAI {
    models = { generateContent, generateContentStream: vi.fn() };
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

const { POST: appraise } = await import("@/app/api/appraise/route");
const { ApiError } = await import("@google/genai");
const { FACT_COUNT } = await import("@/lib/stages");

const at = new Date().toISOString();

// Distinctive on purpose, so a substring check cannot match something else.
const PAID = 849;
const LOCKED = 637;

const photo = { id: "p1", mime: "image/jpeg" as const, data: "eA==" };

const transcript = Array.from({ length: FACT_COUNT }, (_, index) => [
  {
    role: "user" as const,
    text: index === 0 ? "I'm selling: iPhone 13" : index === 1 ? `I paid $${PAID} for it` : `answer ${index}`,
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

const SOURCES = [
  "https://www.ebay.com/itm/1",
  "https://www.ebay.com/itm/2",
  "https://swappa.com/listing/a",
  "https://swappa.com/listing/b",
  "https://www.mercari.com/us/item/m1/",
];

const listings = [200, 250, 300, 350, 400].map((price, index) => ({
  title: `iPhone 13 #${index}`,
  priceText: `US $${price}.00`,
  kind: "sold",
  condition: "good",
  platform: "somewhere the model made up",
  sourceIndex: index,
  // A URL the model wrote. It must never reach the person.
  url: "https://evil.example/phish",
}));

type Request = { contents: unknown; config?: { tools?: unknown; responseJsonSchema?: unknown } };

/** Answers the three calls the route makes, by what each one asks for. */
function scripted(overrides: {
  facts?: unknown;
  chunks?: Array<{ web?: { uri: string; title: string } }>;
  extraction?: unknown;
} = {}) {
  generateContent.mockImplementation(async (request: Request) => {
    if (request.config?.tools) {
      return {
        text: "Found several listings [0][1][2][3][4].",
        candidates: [
          {
            groundingMetadata: {
              webSearchQueries: ["iphone 13 128gb used"],
              groundingChunks:
                overrides.chunks ?? SOURCES.map((uri) => ({ web: { uri, title: "site" } })),
              groundingSupports: [
                { segment: { endIndex: 38 }, groundingChunkIndices: [0, 1, 2, 3, 4] },
              ],
              searchEntryPoint: { renderedContent: "<div>Search suggestions</div>" },
            },
          },
        ],
      };
    }
    if (request.config?.responseJsonSchema && !("listings" in (request.config.responseJsonSchema as { properties: object }).properties)) {
      return { text: JSON.stringify(overrides.facts ?? FACTS) };
    }
    return {
      text: JSON.stringify(
        overrides.extraction ?? {
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

const requestsMade = () => generateContent.mock.calls.map(([request]) => request as Request);
const isSearch = (request: Request) => Boolean(request.config?.tools);

beforeEach(() => {
  generateContent.mockReset();
  vi.unstubAllGlobals();
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
    expect(json.searchEntryPoint.renderedContent).toContain("Search suggestions");
    expect(json.raw.listings).toHaveLength(5);
  });

  it("shows only links the search returned, never the one the model wrote", async () => {
    const { json } = await post(body);

    const urls = json.listings.map((l: { url: string }) => l.url);
    expect(urls).toEqual(SOURCES);
    expect(JSON.stringify(json)).not.toContain("evil.example");
    // Nor the platform it claimed: that comes from the page's address.
    expect(json.listings.map((l: { platform: string }) => l.platform)).toEqual([
      "eBay", "eBay", "Swappa", "Swappa", "Mercari",
    ]);
  });

  it("follows Google's redirect links to the real address", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";
    const fetchStub = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://www.ebay.com/itm/9" } }),
    );
    vi.stubGlobal("fetch", fetchStub);
    scripted({
      chunks: [{ web: { uri: redirect, title: "ebay.com" } }],
      extraction: {
        listings: [{ ...listings[0], sourceIndex: 0 }],
        position: "typical",
        positionEvidence: "",
      },
    });

    const { json } = await post(body);

    expect(fetchStub).toHaveBeenCalledWith(redirect, expect.objectContaining({ redirect: "manual" }));
    expect(json.listings[0].url).toBe("https://www.ebay.com/itm/9");
    expect(json.listings[0].match).toBe("listing");
  });
});

describe("what the search is allowed to see", () => {
  it("never receives what they paid or what they locked in", async () => {
    await post(body);

    const calls = requestsMade();
    expect(calls).toHaveLength(3); // facts, search, extraction

    const search = calls.find(isSearch)!;
    const extraction = calls.at(-1)!;
    for (const request of [search, extraction]) {
      const sent = JSON.stringify(request);
      expect(sent).not.toContain(String(PAID));
      expect(sent).not.toContain(String(LOCKED));
    }
  });

  it("does not leak a price written into the free-text facts either", async () => {
    scripted({
      facts: { ...FACTS, variant: "128GB, paid $849 at the carrier", defects: ["scratch, cost me $637 to fix"] },
    });
    await post(body);

    const search = requestsMade().find(isSearch)!;
    expect(JSON.stringify(search)).not.toMatch(/849|637|\$\d/);
    expect(JSON.stringify(search)).toContain("128GB");
  });

  it("does not know the locked price when reading the facts either", async () => {
    await post(body);
    // The facts call sees the conversation, so it sees what they paid — the
    // verdict needs that. The locked price is not in the conversation at all.
    const facts = requestsMade()[0];
    expect(JSON.stringify(facts)).toContain(String(PAID));
    expect(JSON.stringify(facts)).not.toContain(String(LOCKED));
  });
});

describe("thin and empty markets", () => {
  it("answers 200 with no price when the search found nothing at all", async () => {
    scripted({ chunks: [] });

    const { status, json } = await post(body);

    expect(status).toBe(200);
    expect(json.market.tier).toBe("none");
    expect(json.suggested).toBeNull();
    expect(json.gap).toBeNull();
    expect(json.overpriced).toBe(false);
    expect(json.listings).toEqual([]);
    expect(requestsMade()).toHaveLength(2); // no extraction without sources
  });

  it("answers 200 and withholds a price when only two listings are usable", async () => {
    scripted({
      extraction: { listings: listings.slice(0, 2), position: "typical", positionEvidence: "" },
    });
    const { status, json } = await post(body);
    expect(status).toBe(200);
    expect(json.market.tier).toBe("none");
    expect(json.suggested).toBeNull();
  });

  it("shows listings whose source is only the right site, but does not count them", async () => {
    scripted({
      chunks: SOURCES.map((_, i) => ({
        web: { uri: `https://www.ebay.com/sch/i.html?_nkw=${i}`, title: "ebay.com" },
      })),
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
    expect(requestsMade().some(isSearch)).toBe(false);
  });

  it("refuses before every fact has been asked about", async () => {
    const { status, json } = await post({ ...body, transcript: transcript.slice(0, (FACT_COUNT - 1) * 2) });
    expect(status).toBe(409);
    expect(json.error).toBe("out_of_order");
    expect(generateContent).not.toHaveBeenCalled();
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

  it("rejects an oversized photo before any model call", async () => {
    const big = Buffer.alloc(500 * 1024, 1).toString("base64");
    const { status } = await post({ ...body, photos: [{ ...photo, data: big }] });
    expect(status).toBe(413);
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it("reports an exhausted quota as 429", async () => {
    generateContent.mockRejectedValue(new ApiError({ message: "quota", status: 429 }));
    const { status, json } = await post(body);
    expect(status).toBe(429);
    expect(json.error).toBe("rate_limited");
  });

  it("reports a Search tool that is out of quota the same way", async () => {
    scripted();
    const original = generateContent.getMockImplementation()!;
    generateContent.mockImplementation(async (request: Request) => {
      if (isSearch(request)) throw new ApiError({ message: "quota", status: 429 });
      return original(request);
    });
    const { status, json } = await post(body);
    expect(status).toBe(429);
    expect(json.error).toBe("rate_limited");
  });

  it("explains an extraction that does not fit the schema", async () => {
    scripted({ extraction: { listings: "none", position: "typical", positionEvidence: "" } });
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
