import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAX_SOURCE_CHARS,
  SEARCH_DOMAINS,
  groundListing,
  groundListings,
  identify,
  priceAppearsIn,
  toSources,
  type ExtractedListing,
  type SearchHit,
  type Source,
} from "@/lib/sources";

type Fixture = {
  results: Array<{ title: string; url: string; content: string; raw_content?: string | null }>;
};
const load = (name: string): SearchHit[] =>
  (JSON.parse(readFileSync(`tests/fixtures/${name}`, "utf8")) as Fixture).results.map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    rawContent: r.raw_content ?? null,
  }));

// Hand-written, so the tests below can assert exact text.
const hits = load("tavily-synthetic.json");
// Captured from the real service by `npm run spike -- --save`.
const realHits = load("tavily-sample.json");

describe("priceAppearsIn", () => {
  it("matches a price written exactly as it appears", () => {
    expect(priceAppearsIn("Sold for US $312.00. Free returns.", "US $312.00")).toBe(true);
    expect(priceAppearsIn("| Good | $305 |", "$305")).toBe(true);
  });

  it("ignores differences in whitespace", () => {
    expect(priceAppearsIn("Price:\n  US\n$1,049.99\nShipping", "US $1,049.99")).toBe(true);
    expect(priceAppearsIn("US $1,049.99", "US   $1,049.99")).toBe(true);
  });

  it("does not accept a price with its cents or digits dropped", () => {
    expect(priceAppearsIn("US $1,049.99", "$1,049")).toBe(false);
    expect(priceAppearsIn("$49.99", "$49")).toBe(false);
    expect(priceAppearsIn("$300,000", "$300")).toBe(false);
    expect(priceAppearsIn("$1,049.99", "$1,049.9")).toBe(false);
  });

  it("does not accept the tail of a bigger number", () => {
    expect(priceAppearsIn("$1,300", "300 USD")).toBe(false);
    expect(priceAppearsIn("costs 1300 USD", "300 USD")).toBe(false);
    expect(priceAppearsIn("costs 300 USD", "300 USD")).toBe(true);
  });

  it("accepts a price at the end of a sentence or followed by a comma", () => {
    expect(priceAppearsIn("It sold for $312.", "$312")).toBe(true);
    expect(priceAppearsIn("$312, free shipping", "$312")).toBe(true);
  });

  it("finds a later occurrence when an earlier one is a longer number", () => {
    expect(priceAppearsIn("was $3000, now $300", "$300")).toBe(true);
  });

  it("is case sensitive and rejects a price that is not there", () => {
    expect(priceAppearsIn("US $312.00", "us $312.00")).toBe(false);
    expect(priceAppearsIn("US $312.00", "US $400.00")).toBe(false);
    expect(priceAppearsIn("anything", "")).toBe(false);
  });
});

describe("toSources", () => {
  const sources = toSources(hits);

  it("keeps every result with an http(s) address, in order", () => {
    expect(sources.map((s) => s.url)).toEqual(hits.map((h) => h.url));
  });

  it("gives the model the search summary, then the lines of the page that carry a price", () => {
    expect(sources[0].text.split("\n")[0]).toBe(hits[0].content);
    expect(sources[0].text).toContain("US $312.00");
    expect(sources[0].text).toContain("Shipping: US $8.50");
    // Navigation and prose without a dollar amount stay out.
    expect(sources[0].text).not.toContain("Seller notes");
    expect(sources[0].text).not.toContain("Help");
    // Table rows are lines too.
    expect(sources[1].text).toContain("| Fair | $279 |");
  });

  it("does not repeat a line the summary already holds", () => {
    const text = toSources([
      { title: "t", url: "https://a.example/x", content: "Sold $10", rawContent: "Sold $10\nAlso $20" },
    ])[0].text;
    expect(text.match(/Sold \$10/g)).toHaveLength(1);
    expect(text).toContain("Also $20");
  });

  it("copes with a result that has no page body", () => {
    expect(sources[2].text).toBe(hits[2].content);
  });

  it("caps what any one source can cost in tokens", () => {
    const big = toSources([
      {
        title: "t",
        url: "https://a.example/x",
        content: "summary",
        rawContent: Array.from({ length: 500 }, (_, i) => `Item ${i} for $${i + 100}.00`).join("\n"),
      },
    ])[0];
    expect(big.text.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
    expect(big.text.startsWith("summary")).toBe(true);
  });

  it("drops results whose address is not http(s)", () => {
    const out = toSources([
      { title: "a", url: "javascript:alert(1)", content: "$5", rawContent: null },
      { title: "b", url: "not a url", content: "$5", rawContent: null },
      { title: "c", url: "https://ok.example/p", content: "$5", rawContent: null },
    ]);
    expect(out.map((s) => s.title)).toEqual(["c"]);
  });
});

describe("identify", () => {
  it("tells an item page from a search page on the same site", () => {
    expect(identify("https://www.ebay.com/itm/166000000001?hash=x")).toEqual({
      platform: "eBay",
      isItemPage: true,
    });
    expect(identify("https://www.ebay.com/sch/i.html?_nkw=iphone")).toEqual({
      platform: "eBay",
      isItemPage: false,
    });
    expect(identify("https://swappa.com/listing/view/ABCD")?.isItemPage).toBe(true);
    expect(identify("https://swappa.com/mobile/iphone-13")?.isItemPage).toBe(false);
    expect(identify("https://www.facebook.com/marketplace/item/123/")?.platform).toBe(
      "Facebook Marketplace",
    );
  });

  it("matches subdomains but not lookalikes", () => {
    expect(identify("https://m.ebay.com/itm/1")?.platform).toBe("eBay");
    expect(identify("https://notebay.com/itm/1")?.platform).toBe("notebay.com");
  });

  it("falls back to the hostname and a generic item-path rule for unknown sites", () => {
    expect(identify("https://www.example-shop.com/product/42")).toEqual({
      platform: "example-shop.com",
      isItemPage: true,
    });
    expect(identify("https://www.example-shop.com/category/phones")?.isItemPage).toBe(false);
  });
});

describe("SEARCH_DOMAINS", () => {
  it("lists the used-item marketplaces and leaves out what the search cannot use", () => {
    expect(SEARCH_DOMAINS).toEqual(expect.arrayContaining(["ebay.com", "swappa.com", "mercari.com"]));
    // Needs a login: the search cannot read inside it.
    expect(SEARCH_DOMAINS).not.toContain("facebook.com");
    // Sell new stock: a new price is not a used one.
    expect(SEARCH_DOMAINS).not.toContain("amazon.com");
    expect(SEARCH_DOMAINS).not.toContain("bestbuy.com");
  });
});

describe("groundListing", () => {
  const listing: ExtractedListing = {
    title: "t",
    priceText: "US $312.00",
    kind: "sold",
    condition: "good",
    platform: "Claimed",
    sourceIndex: 0,
  };
  const source = (text: string, url = "https://www.ebay.com/itm/1"): Source => ({
    url,
    title: "t",
    text,
  });

  it("verifies a price that is in the cited text, and names the platform from the URL", () => {
    expect(groundListing(listing, [source("Sold for US $312.00")])).toMatchObject({
      match: "verified",
      platform: "eBay",
      url: "https://www.ebay.com/itm/1",
    });
  });

  it("does not verify a price the text does not contain, but keeps the real source", () => {
    const grounded = groundListing(listing, [source("Sold for US $299.00")]);
    expect(grounded.match).toBe("unverified");
    expect(grounded.url).toBe("https://www.ebay.com/itm/1");
  });

  it("does not verify a price with its cents dropped", () => {
    expect(
      groundListing({ ...listing, priceText: "US $312" }, [source("Sold for US $312.00")]).match,
    ).toBe("unverified");
  });

  it("verifies a price on a list or price-guide page, not only on an item page", () => {
    const guide = source("| Good | $305 |", "https://swappa.com/prices/apple-iphone-13");
    expect(groundListing({ ...listing, priceText: "$305", sourceIndex: 0 }, [guide])).toMatchObject({
      match: "verified",
      platform: "Swappa",
    });
    const search = source("US $312.00", "https://www.ebay.com/sch/i.html?_nkw=x");
    expect(groundListing(listing, [search]).match).toBe("verified");
  });

  it("checks the price against the cited source and no other", () => {
    // $312 is in source 0 but the listing cites source 1.
    const sources = [source("US $312.00"), source("nothing here", "https://swappa.com/prices/x")];
    expect(groundListing({ ...listing, sourceIndex: 1 }, sources).match).toBe("unverified");
  });

  it("has no source for an index that does not exist", () => {
    expect(groundListing({ ...listing, sourceIndex: 9 }, [source("US $312.00")])).toMatchObject({
      match: "none",
      url: null,
      platform: "Claimed",
    });
  });
});

describe("against the sample search response", () => {
  const sources = toSources(hits);
  const base = { title: "t", kind: "sold" as const, condition: "good" as const, platform: "?" };

  it("grounds each listing by what its source says", () => {
    const grounded = groundListings(
      [
        { ...base, priceText: "US $312.00", sourceIndex: 0 },
        { ...base, priceText: "$305", sourceIndex: 1 },
        { ...base, priceText: "$1,049", sourceIndex: 2 }, // the source says $1,049.99
        { ...base, priceText: "$1,049.99", sourceIndex: 2 },
        { ...base, priceText: "$400", sourceIndex: 1 }, // not on that page
        { ...base, priceText: "$310", sourceIndex: 9 }, // no such source
      ],
      sources,
    );
    expect(grounded.map((l) => [l.platform, l.match])).toEqual([
      ["eBay", "verified"],
      ["Swappa", "verified"],
      ["Mercari", "unverified"],
      ["Mercari", "verified"],
      ["Swappa", "unverified"],
      ["?", "none"],
    ]);
  });

  it("shows only addresses the search returned: listings carry no url of their own", () => {
    const grounded = groundListings([{ ...base, priceText: "US $312.00", sourceIndex: 0 }], sources);
    expect(grounded[0].url).toBe(hits[0].url);
    expect(JSON.stringify({ ...base, priceText: "x", sourceIndex: 0 })).not.toContain("url");
  });
});

describe("against a real search response", () => {
  const sources = toSources(realHits);

  it("keeps every result that has an http(s) address, in order", () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.map((s) => s.url)).toEqual(realHits.map((h) => h.url));
    for (const source of sources) expect(source.url).toMatch(/^https?:\/\//);
  });

  it("builds text for the model that is bounded and starts with the search's own summary", () => {
    for (const [index, source] of sources.entries()) {
      expect(source.text.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
      expect(source.text.startsWith(realHits[index].content.replace(/\s+/g, " ").trim().slice(0, 40))).toBe(true);
    }
  });

  it("finds a dollar amount in the text of at least some sources, which is the whole point", () => {
    expect(sources.filter((s) => /\$\s?\d/.test(s.text)).length).toBeGreaterThan(0);
  });

  it("names the platform of every source it can, from the address alone", () => {
    for (const source of sources) expect(identify(source.url)?.platform).toBeTruthy();
    expect(sources.some((s) => identify(s.url)?.platform === "Swappa")).toBe(true);
  });

  it("verifies a price taken straight from a source's text and rejects one that is not in it", () => {
    // Take the first dollar amount that actually appears in a source: it must
    // verify against that source, and must not verify against a made-up amount.
    const index = sources.findIndex((s) => /\$\d+(?:,\d{3})*(?:\.\d\d)?/.test(s.text));
    const price = sources[index].text.match(/\$\d+(?:,\d{3})*(?:\.\d\d)?/)![0];
    const listing = { title: "t", kind: "sold" as const, condition: "good" as const, platform: "?", sourceIndex: index };

    expect(groundListing({ ...listing, priceText: price }, sources).match).toBe("verified");
    expect(groundListing({ ...listing, priceText: "$987,654.32" }, sources).match).toBe("unverified");
  });
});
