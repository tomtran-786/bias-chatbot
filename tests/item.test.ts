import { describe, expect, it } from "vitest";
import {
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  base64Bytes,
  dedupePhotos,
  forSearch,
  photoProblem,
  scrubPrices,
  searchQueries,
  QUERY_COUNT,
  type ItemFacts,
  type Photo,
} from "@/lib/item";
import { photoCount, referencedPhotoIds } from "@/lib/transcript";

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

  it("makes the fixed number of queries, one for sold prices and one for listings", () => {
    const queries = searchQueries(forSearch(facts));
    expect(queries).toHaveLength(QUERY_COUNT);
    expect(queries).toEqual([
      "Apple iPhone 13 128GB used sold price",
      "Apple iPhone 13 128GB used for sale",
    ]);
  });

  it("never contains what they paid, however it was written into the facts", () => {
    const leaky: ItemFacts = {
      ...facts,
      searchQuery: "Apple iPhone 13 128GB paid $849",
      model: "iPhone 13 ($849)",
      variant: "bought for 849 dollars",
    };
    const text = searchQueries(forSearch(leaky)).join(" | ");
    expect(text).not.toMatch(/849|\$/);
    expect(text).toContain("iPhone 13");
  });

  it("falls back to the model and variant when the search query came back empty", () => {
    const queries = searchQueries(forSearch({ ...facts, searchQuery: "", variant: "128GB" }));
    expect(queries[0]).toBe("iPhone 13 128GB used sold price");
  });

  it("collapses whitespace and bounds the length", () => {
    const long = searchQueries(forSearch({ ...facts, searchQuery: `iPhone   13 ${"x".repeat(400)}` }));
    expect(long[0]).not.toContain("  ");
    expect(long[0].length).toBeLessThan(200);
  });
});
