import { describe, expect, it } from "vitest";
import {
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  base64Bytes,
  dedupePhotos,
  forSearch,
  photoProblem,
  scrubPrices,
  searchName,
  searchQueries,
  wideningQuery,
  factsAnswerSchema,
  itemFactsSchema,
  toItemFacts,
  type ItemFacts,
  type Photo,
} from "@/lib/item";
import { photoCount, referencedPhotoIds } from "@/lib/transcript";
import { SEARCH_DOMAINS_US, SEARCH_DOMAINS_VN } from "@/lib/sources";

const photo = (id: string, bytes = 100): Photo => ({
  id,
  mime: "image/jpeg",
  data: Buffer.alloc(bytes, 1).toString("base64"),
});

describe("photoProblem", () => {
  it("accepts ordinary photos", () => {
    expect(photoProblem([photo("a"), photo("b")])).toBeNull();
  });

  it("measures decoded size, not string length", () => {
    expect(base64Bytes(photo("a", 100).data)).toBe(100);
    expect(base64Bytes(photo("a", 101).data)).toBe(101);
    expect(base64Bytes(photo("a", 102).data)).toBe(102);
  });

  it("calls an over-size photo too large", () => {
    expect(photoProblem([photo("big", MAX_PHOTO_BYTES + 1)])).toBe("payload_too_large");
    expect(photoProblem([photo("edge", MAX_PHOTO_BYTES)])).toBeNull();
  });

  it("calls too many photos too large", () => {
    const tooMany = Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => photo(`p${i}`));
    expect(photoProblem(tooMany)).toBe("payload_too_large");
  });

  it("rejects data that is not base64", () => {
    expect(photoProblem([{ ...photo("a"), data: "data:image/png;base64,AAAA" }])).toBe(
      "invalid_photo",
    );
  });
});

describe("dedupePhotos", () => {
  it("keeps the first of each id", () => {
    const first = photo("a", 10);
    expect(dedupePhotos([first, photo("a", 20), photo("b")])).toEqual([first, photo("b")]);
  });
});

describe("keeping prices out of the search", () => {
  it("scrubs dollar amounts in the ways people write them", () => {
    expect(scrubPrices("paid $800 new")).toBe("paid new");
    expect(scrubPrices("paid US $1,049.99 last year")).toBe("paid last year");
    expect(scrubPrices("bought for 650 dollars")).toBe("bought for");
    expect(scrubPrices("about 700 USD")).toBe("about");
    expect(scrubPrices("128GB blue")).toBe("128GB blue");
  });

  it("scrubs amounts in đồng too, in every way a Vietnamese seller writes them", () => {
    expect(scrubPrices("mua 15 triệu hồi tháng 3")).toBe("mua hồi tháng 3");
    expect(scrubPrices("mua 15tr")).toBe("mua");
    expect(scrubPrices("giá 5,5 triệu")).toBe("giá");
    expect(scrubPrices("mua 15 củ")).toBe("mua");
    expect(scrubPrices("trả 5.500.000 ₫ ở shop")).toBe("trả ở shop");
    expect(scrubPrices("trả 5.500.000đ")).toBe("trả");
    expect(scrubPrices("paid 5,500,000 VND")).toBe("paid");
    expect(scrubPrices("paid VND 5500000")).toBe("paid");
  });

  it("leaves the parts of a product name that only look like money", () => {
    expect(scrubPrices("LG OLED 4K 55 inch")).toBe("LG OLED 4K 55 inch");
    expect(scrubPrices("Canon EOS 5D Mark IV")).toBe("Canon EOS 5D Mark IV");
    expect(scrubPrices("iPhone 13 128GB xanh")).toBe("iPhone 13 128GB xanh");
    expect(scrubPrices("laptop 15 trong tình trạng tốt")).toBe("laptop 15 trong tình trạng tốt");
  });

  const facts: ItemFacts = {
    searchQuery: "iPhone 13 128GB",
    model: "iPhone 13",
    variant: "128GB, blue, $800 from the carrier",
    ageMonths: 20,
    condition: "good",
    included: ["box", "charger worth $20"],
    defects: ["scratch on the back"],
    purchasePrice: 800,
  };

  it("drops the purchase price and any amount written into free text", () => {
    const visible = forSearch(facts);
    expect(visible).not.toHaveProperty("purchasePrice");
    expect(JSON.stringify(visible)).not.toMatch(/800|\$20|\$/);
    expect(visible.model).toBe("iPhone 13");
    expect(visible.defects).toEqual(["scratch on the back"]);
  });
});

describe("photoCount", () => {
  const at = new Date().toISOString();
  const transcript = [
    { role: "user" as const, text: "a", at, photoIds: ["a", "b"] },
    { role: "model" as const, text: "q", at },
    { role: "user" as const, text: "b", at, photoIds: ["b", "c"] },
  ];

  it("counts each photo once however many messages mention it", () => {
    expect(referencedPhotoIds(transcript)).toEqual(["a", "b", "c"]);
    expect(photoCount(transcript)).toBe(3);
    expect(photoCount([])).toBe(0);
  });
});

describe("searchQueries", () => {
  const facts: ItemFacts = {
    searchQuery: "Apple iPhone 13 128GB",
    model: "iPhone 13",
    variant: "128GB, blue",
    ageMonths: 36,
    condition: "good",
    included: [],
    defects: [],
    purchasePrice: 849,
  };

  it("makes two US queries, one for sold prices and one for listings, and one Vietnamese", () => {
    const queries = searchQueries(forSearch(facts));
    expect(queries).toEqual([
      { query: "Apple iPhone 13 128GB used sold price", domains: SEARCH_DOMAINS_US },
      { query: "Apple iPhone 13 128GB used for sale", domains: SEARCH_DOMAINS_US },
      { query: "Apple iPhone 13 128GB cũ", domains: SEARCH_DOMAINS_VN },
    ]);
  });

  it("looks for the Vietnamese one on the three Vietnamese sites", () => {
    expect(SEARCH_DOMAINS_VN).toEqual(["chotot.com", "shopee.vn", "lazada.vn"]);
    expect(SEARCH_DOMAINS_US).not.toContain("shopee.vn");
  });

  it("widens with the model alone, on any site, when the first round found little", () => {
    expect(wideningQuery(forSearch(facts))).toEqual({ query: "iPhone 13 used price", domains: [] });
    // Never narrower than the first round: with no model it falls back to the name.
    expect(wideningQuery({ searchQuery: "Sony A7", model: "", variant: null }).query).toBe(
      "Sony A7 used price",
    );
  });

  it("never contains what they paid, however it was written into the facts", () => {
    const leaky: ItemFacts = {
      ...facts,
      searchQuery: "Apple iPhone 13 128GB paid $849",
      model: "iPhone 13 ($849)",
      variant: "bought for 849 dollars",
    };
    const text = searchQueries(forSearch(leaky)).map((q) => q.query).join(" | ");
    expect(text).not.toMatch(/849|\$/);
    expect(text).toContain("iPhone 13");
  });

  it("never contains what they paid in đồng either", () => {
    const leaky: ItemFacts = {
      ...facts,
      searchQuery: "iPhone 13 128GB mua 15 triệu",
      model: "iPhone 13 (15tr)",
      variant: "mua 15.000.000 ₫",
    };
    const safe = forSearch(leaky);
    const text = [...searchQueries(safe), wideningQuery(safe)].map((q) => q.query).join(" | ");
    expect(text).not.toMatch(/15|triệu|₫/);
    expect(text).toContain("iPhone 13");
  });

  it("falls back to the model and variant when the search query came back empty", () => {
    const queries = searchQueries(forSearch({ ...facts, searchQuery: "", variant: "128GB" }));
    expect(queries[0].query).toBe("iPhone 13 128GB used sold price");
  });

  it("collapses whitespace and bounds the length", () => {
    const long = searchQueries(forSearch({ ...facts, searchQuery: `iPhone   13 ${"x".repeat(400)}` }));
    expect(long[0].query).not.toContain("  ");
    expect(long[0].query.length).toBeLessThan(200);
    expect(searchName({ searchQuery: "  a   b ", model: "", variant: null })).toBe("a b");
  });
});

describe("the facts the model returns", () => {
  const answer = { searchQuery: "iPhone 13 128GB", model: "iPhone 13", condition: "good" };

  it("converts a price given in đồng at the configured rate, in code", () => {
    const facts = toItemFacts(
      factsAnswerSchema.parse({ ...answer, purchasePrice: 15_000_000, purchaseCurrency: "VND" }),
      25_000,
    );
    expect(facts.purchasePrice).toBe(600);
  });

  it("leaves a dollar price, and a price with no currency, as dollars", () => {
    expect(toItemFacts(factsAnswerSchema.parse({ ...answer, purchasePrice: 800 })).purchasePrice).toBe(800);
    expect(
      toItemFacts(factsAnswerSchema.parse({ ...answer, purchasePrice: 800, purchaseCurrency: "USD" })).purchasePrice,
    ).toBe(800);
  });

  it("does not turn '15' (meaning 15 triệu) into fifteen đồng", () => {
    const facts = toItemFacts(factsAnswerSchema.parse({ ...answer, purchasePrice: 15, purchaseCurrency: "VND" }));
    expect(facts.purchasePrice).toBeNull();
  });

  it("does not fail the lookup over a price that is out of range or the wrong type", () => {
    // This was the retry-forever bug: 15,000,000 read as dollars broke the schema.
    expect(itemFactsSchema.parse({ ...answer, purchasePrice: 15_000_000 }).purchasePrice).toBeNull();
    expect(itemFactsSchema.parse({ ...answer, purchasePrice: "lots" }).purchasePrice).toBeNull();
    expect(toItemFacts(factsAnswerSchema.parse({ ...answer, purchasePrice: 15_000_000 })).purchasePrice).toBeNull();
  });

  it("does not fail the lookup over the other detail fields either", () => {
    const parsed = itemFactsSchema.parse({
      ...answer,
      ageMonths: "two years",
      variant: 128,
      included: "box",
      defects: [1, 2],
    });
    expect(parsed).toMatchObject({ ageMonths: null, variant: null, included: [], defects: [] });
  });

  it("still insists on the model name and the condition", () => {
    expect(itemFactsSchema.safeParse({ ...answer, condition: "great" }).success).toBe(false);
    expect(itemFactsSchema.safeParse({ searchQuery: "x", condition: "good" }).success).toBe(false);
  });
});
