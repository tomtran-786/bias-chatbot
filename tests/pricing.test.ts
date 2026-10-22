/**
 * The numbers the person is shown all come from here, so these tests pin the
 * policy: what counts as a listing, how many are enough, and how a market turns
 * into a suggested price and a gap.
 */
import { describe, expect, it } from "vitest";
import type { GroundedListing, Source } from "@/lib/sources";
import {
  MAX_LISTINGS,
  appraisalInputSchema,
  byPlatform,
  computeAppraisal,
  describeAppraisal,
  formatPct,
  formatUsd,
  formatUsdWhole,
  gap,
  groundNewPrice,
  listingPrice,
  marketHeadline,
  median,
  parsePriceText,
  quartiles,
  type Position,
} from "@/lib/pricing";

let counter = 0;

/** A counted listing on its own site, so the per-site cap never gets in the way. */
function listing(price: number, over: Partial<GroundedListing> = {}): GroundedListing {
  counter += 1;
  return {
    title: `Listing ${counter}`,
    priceText: `$${price}`,
    kind: "sold",
    condition: "good",
    platform: `Site ${counter}`,
    sourceIndex: counter,
    url: `https://site${counter}.example/item/${counter}`,
    match: "verified",
    ...over,
  };
}

const many = (prices: number[], over: Partial<GroundedListing> = {}) =>
  prices.map((price) => listing(price, over));

function run(
  listings: GroundedListing[],
  asking = 300,
  extra: { newPrice?: number | null; position?: Position } = {},
) {
  return computeAppraisal(
    {
      listings,
      newPrice: extra.newPrice ?? null,
      position: extra.position ?? "typical",
      positionEvidence: "photos show light wear",
    },
    asking,
  );
}

describe("parsePriceText", () => {
  it("reads US dollar amounts the way pages print them", () => {
    expect(parsePriceText("US $1,049.99")).toBe(1049.99);
    expect(parsePriceText("$300")).toBe(300);
    expect(parsePriceText("USD 250")).toBe(250);
    expect(parsePriceText("$1049.99")).toBe(1049.99);
    expect(parsePriceText("Price: $12.50 or Best Offer")).toBe(12.5);
  });

  it("drops other currencies instead of reading them as dollars", () => {
    expect(parsePriceText("£300")).toBeNull();
    expect(parsePriceText("€300")).toBeNull();
    expect(parsePriceText("C $400")).toBeNull();
    expect(parsePriceText("AU $300")).toBeNull();
    expect(parsePriceText("EUR 300")).toBeNull();
    expect(parsePriceText("CAD 300")).toBeNull();
  });

  it("does not guess at ranges, comparisons or non-prices", () => {
    expect(parsePriceText("$300 to $400")).toBeNull();
    expect(parsePriceText("$300 (was $400)")).toBeNull();
    expect(parsePriceText("Free")).toBeNull();
    expect(parsePriceText("$0")).toBeNull();
    expect(parsePriceText("")).toBeNull();
  });

  it("takes the item price when shipping is listed beside it", () => {
    expect(parsePriceText("$300 + $20 shipping")).toBe(300);
  });
});

describe("median and quartiles", () => {
  it("takes the middle, or the mean of the middle two", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("interpolates quartiles", () => {
    expect(quartiles([1, 2, 3, 4, 5])).toEqual({ q1: 2, q3: 4 });
    expect(quartiles([10, 20, 30, 40])).toEqual({ q1: 17.5, q3: 32.5 });
  });
});

describe("listingPrice", () => {
  it("rounds to the increments sellers list at", () => {
    expect(listingPrice(17.3)).toBe(17);
    expect(listingPrice(87)).toBe(85);
    expect(listingPrice(249)).toBe(250);
    expect(listingPrice(262)).toBe(260);
    expect(listingPrice(1013)).toBe(1025);
  });

  it("never exceeds a ceiling, rounding down to stay under it", () => {
    expect(listingPrice(1013, 1010)).toBe(1000);
    expect(listingPrice(252, 251)).toBe(250);
    expect(listingPrice(100, 500)).toBe(100);
  });
});

describe("the thresholds", () => {
  const prices = [90, 95, 100, 105, 110, 98, 102, 99, 101, 103, 97, 104];

  it.each([0, 1, 2])("gives no price from %i listings", (n) => {
    const result = run(many(prices.slice(0, n)));
    expect(result.market.tier).toBe("none");
    expect(result.market.median).toBeNull();
    expect(result.suggested).toBeNull();
    expect(result.gap).toBeNull();
    expect(result.overpriced).toBe(false);
  });

  it.each([3, 4])("gives only a median from %i listings, and flags it thin", (n) => {
    const result = run(many(prices.slice(0, n)));
    expect(result.market.tier).toBe("thin");
    expect(result.market.median).not.toBeNull();
    expect(result.market.q1).toBeNull();
    expect(result.market.q3).toBeNull();
    expect(result.suggested?.anchor).toBe("median");
    expect(result.gap).not.toBeNull();
  });

  it.each([5, 10])("gives a median and a range from %i listings", (n) => {
    const result = run(many(prices.slice(0, n)));
    expect(result.market.tier).toBe("full");
    expect(result.market.count).toBe(n);
    expect(result.market.q1).not.toBeNull();
    expect(result.market.q3).not.toBeNull();
  });

  it("uses at most ten listings", () => {
    const result = run(many(prices));
    expect(prices.length).toBeGreaterThan(MAX_LISTINGS);
    expect(result.market.count).toBe(MAX_LISTINGS);
  });
});

describe("what counts as a listing", () => {
  const five = [90, 100, 110, 120, 130];

  it("leaves out for-parts listings", () => {
    const result = run([...many(five), listing(10, { condition: "for_parts" })]);
    expect(result.market.count).toBe(5);
  });

  it("leaves out listings in another currency", () => {
    const result = run([...many(five), listing(0, { priceText: "£110" })]);
    expect(result.market.count).toBe(5);
  });

  it("leaves out anything priced above the new price", () => {
    const result = run([...many(five), listing(900)], 300, { newPrice: 500 });
    expect(result.market.count).toBe(5);
    expect(result.listings.every((l) => l.price <= 500)).toBe(true);
  });

  it("leaves out outliers beyond a third of, or three times, the first-pass median", () => {
    const result = run([...many(five), listing(1000), listing(20)]);
    expect(result.market.count).toBe(5);
    expect(result.market.median).toBe(110);
  });

  it("dedupes on source, price and title", () => {
    const a = listing(100, { platform: "eBay", title: "Same Phone!" });
    const b = { ...a, sourceIndex: 99 };
    const result = run([a, b, ...many([110, 120, 130, 140])]);
    expect(result.market.count).toBe(5);
  });

  it("takes at most three from any one page", () => {
    // Six prices read off one search page: that page is not six listings' worth
    // of evidence.
    const onePage = many([100, 101, 102, 103, 104, 105], {
      platform: "eBay",
      url: "https://www.ebay.com/sch/i.html?_nkw=iphone",
    });
    const result = run(onePage);
    expect(result.market.count).toBe(3);
    expect(result.platforms).toEqual([{ platform: "eBay", count: 3, median: 101 }]);
  });

  it("does not cap a platform that supplies many separate pages", () => {
    const manyPages = many([100, 101, 102, 103, 104, 105], { platform: "eBay" });
    const result = run(manyPages);
    expect(result.market.count).toBe(6);
    expect(result.platforms).toEqual([{ platform: "eBay", count: 6, median: 102.5 }]);
  });

  it("keeps a repeated price from two different pages, and drops it from the same page", () => {
    const a = listing(100, { title: "Same Phone", url: "https://a.example/1" });
    const otherPage = { ...a, url: "https://b.example/2" };
    const samePage = { ...a };
    const result = run([a, otherPage, samePage, ...many([110, 120, 130])]);
    expect(result.market.count).toBe(5);
  });

  it("shows listings it cannot verify, dimmed, and leaves them out of the median", () => {
    const result = run([
      ...many([100, 110, 120], { match: "verified" }),
      ...many([500, 600], { match: "unverified" }),
      ...many([700], { match: "none", url: null }),
    ]);
    expect(result.market.count).toBe(3);
    expect(result.market.median).toBe(110);
    expect(result.listings.filter((l) => l.status === "used")).toHaveLength(3);
    expect(result.listings.filter((l) => l.status === "unverified")).toHaveLength(3);
  });

  it("gives no price when the only listings it has are unverified", () => {
    const result = run(many([100, 110, 120, 130, 140], { match: "unverified" }));
    expect(result.market.tier).toBe("none");
    expect(result.listings).toHaveLength(5);
  });
});

describe("sold against asking", () => {
  it("prefers sold listings once there are five of them", () => {
    const result = run([
      ...many([100, 100, 100, 100, 100], { kind: "sold" }),
      ...many([200, 200, 200, 200, 200], { kind: "active" }),
    ]);
    expect(result.market.basis).toBe("sold");
    expect(result.market.median).toBe(100);
    expect(result.market.askingRunHigh).toBe(false);
  });

  it("falls back to everything, and warns that asking prices run high", () => {
    const result = run([
      ...many([100, 100, 100, 100], { kind: "sold" }),
      ...many([200, 200, 200, 200], { kind: "active" }),
    ]);
    expect(result.market.basis).toBe("asking");
    expect(result.market.count).toBe(8);
    expect(result.market.askingRunHigh).toBe(true);
  });

  it("does not warn about asking prices when everything it has sold", () => {
    const result = run(many([100, 110, 120], { kind: "sold" }));
    expect(result.market.tier).toBe("thin");
    expect(result.market.basis).toBe("sold");
    expect(result.market.askingRunHigh).toBe(false);
  });
});

describe("the suggested price", () => {
  // Median 300, P25 200, P75 400.
  const market = () => many([100, 200, 300, 400, 500]);

  it.each([
    ["below", "p25", 200],
    ["typical", "median", 300],
    ["above", "p75", 400],
  ] as const)("maps %s to %s", (position, anchor, price) => {
    const result = run(market(), 300, { position });
    expect(result.suggested).toEqual({ price, anchor, capped: false });
  });

  it("ignores the position when there are too few listings to adjust along", () => {
    const result = run(many([100, 200, 300]), 300, { position: "above" });
    expect(result.suggested).toMatchObject({ price: 200, anchor: "median" });
  });

  it("is held below 0.9 of the new price", () => {
    const result = run(many([500, 520, 540, 560, 580]), 540, {
      newPrice: 600,
      position: "above",
    });
    expect(result.suggested).toEqual({ price: 540, anchor: "p75", capped: true });
  });

  it("is rounded to a price someone would list at", () => {
    const result = run(many([251, 262, 273, 284, 295]), 300);
    expect(result.suggested?.price).toBe(270);
  });
});

describe("the gap to their price", () => {
  const market = () => many([90, 95, 100, 105, 110]); // median 100

  it("measures it against the median", () => {
    expect(run(market(), 120).gap).toEqual({ amount: 20, pct: 0.2 });
    expect(run(market(), 80).gap).toEqual({ amount: -20, pct: -0.2 });
  });

  it("calls a price overpriced from fifteen percent over the median", () => {
    expect(run(market(), 115).overpriced).toBe(true);
    expect(run(market(), 114).overpriced).toBe(false);
    expect(run(market(), 100).overpriced).toBe(false);
    expect(run(market(), 60).overpriced).toBe(false);
  });

  it("does not round the percentage before comparing it", () => {
    expect(gap(114.96, 100).pct).toBeLessThan(0.15);
  });
});

describe("formatting", () => {
  it("prints dollars and signed percentages", () => {
    expect(formatUsd(1049.99)).toBe("$1,049.99");
    expect(formatUsd(250)).toBe("$250");
    expect(formatUsd(352.5)).toBe("$352.50");
    expect(formatPct(0.2)).toBe("+20%");
    expect(formatPct(-0.126)).toBe("−13%");
    expect(formatPct(0)).toBe("0%");
  });

  it("shows a quartile in whole dollars, so interpolated cents never reach the person or the model", () => {
    expect(formatUsdWhole(291.25)).toBe("$291");
    expect(formatUsdWhole(321.75)).toBe("$322");
    const text = describeAppraisal(run(many([100, 210, 300, 410, 500]), 400));
    expect(text).not.toMatch(/\.\d\d/);
  });
});

describe("byPlatform", () => {
  it("sums up each site, busiest first", () => {
    const result = run([
      ...many([100, 110], { platform: "Swappa" }),
      ...many([200, 220, 240], { platform: "eBay" }),
    ]);
    expect(result.platforms).toEqual([
      { platform: "eBay", count: 3, median: 220 },
      { platform: "Swappa", count: 2, median: 105 },
    ]);
    expect(byPlatform([])).toEqual([]);
  });
});

describe("describeAppraisal", () => {
  it("states every figure the verdict may use, and forbids others", () => {
    const text = describeAppraisal(
      run(many([100, 200, 300, 400, 500]), 400, { newPrice: 900 }),
    );
    expect(text).toContain("Market median: $300");
    expect(text).toContain("$200 to $400");
    expect(text).toContain("Suggested price: $300");
    expect(text).toContain("overpriced: true");
    expect(text).toContain("+33%");
    expect(text).toContain("Use these figures and no others");
  });

  it("withholds a price entirely when there is no market", () => {
    const text = describeAppraisal(run(many([100, 200]), 400));
    expect(text).toContain("Do not give a price");
    expect(text).not.toContain("Suggested price");
    expect(text).not.toContain("Market median");
    // Not even a per-platform "median" of a listing or two: only the names.
    expect(text).toContain("Platforms where listings turned up");
    expect(text).not.toMatch(/\$\d/);
  });

  it("says when the evidence is thin or is asking prices", () => {
    const thin = describeAppraisal(run(many([100, 110, 120], { kind: "active" })));
    expect(thin).toContain("thin evidence");
    expect(thin).toContain("asking prices");
  });
});

describe("appraisalInputSchema", () => {
  it("accepts the shape the appraise route hands out and fills the defaults", () => {
    const parsed = appraisalInputSchema.parse({
      item: { searchQuery: "iphone 13", model: "iPhone 13", condition: "good" },
      listings: many([100]),
      position: "typical",
      positionEvidence: "",
    });
    expect(parsed.newPrice).toBeNull();
    expect(parsed.item.included).toEqual([]);
    expect(parsed.item.purchasePrice).toBeNull();
  });

  it("rejects a position the app has no mapping for", () => {
    expect(
      appraisalInputSchema.safeParse({
        item: { searchQuery: "x", model: "x", condition: "good" },
        listings: [],
        position: "cheap",
        positionEvidence: "",
      }).success,
    ).toBe(false);
  });
});

describe("groundNewPrice", () => {
  const sources: Source[] = [
    { url: "https://www.ebay.com/itm/1", title: "listing", text: "Sold for US $312.00" },
    { url: "https://www.bestbuy.com/site/iphone-13/1.p", title: "new", text: "iPhone 13 128GB\n$699.99\nIn stock" },
    { url: "https://example.co.uk/phone", title: "uk", text: "Now £649.00" },
  ];

  it("keeps a price the cited page shows, with the page it came from", () => {
    expect(groundNewPrice({ priceText: "$699.99", sourceIndex: 1 }, sources)).toEqual({
      price: 699.99,
      url: "https://www.bestbuy.com/site/iphone-13/1.p",
    });
  });

  it("drops one cited to a source that does not exist", () => {
    expect(groundNewPrice({ priceText: "$699.99", sourceIndex: 9 }, sources)).toBeNull();
    expect(groundNewPrice({ priceText: "$699.99", sourceIndex: -1 }, sources)).toBeNull();
  });

  it("drops one the model took from a different page than the one it cites", () => {
    expect(groundNewPrice({ priceText: "$699.99", sourceIndex: 0 }, sources)).toBeNull();
  });

  it("drops one that is not in the page text, including one with its cents cut off", () => {
    expect(groundNewPrice({ priceText: "$799.00", sourceIndex: 1 }, sources)).toBeNull();
    expect(groundNewPrice({ priceText: "$699", sourceIndex: 1 }, sources)).toBeNull();
  });

  it("drops one in another currency, even though the page does show it", () => {
    expect(groundNewPrice({ priceText: "£649.00", sourceIndex: 2 }, sources)).toBeNull();
  });

  it("is none when there is no claim", () => {
    expect(groundNewPrice(null, sources)).toBeNull();
    expect(groundNewPrice(undefined, sources)).toBeNull();
  });
});

describe("the new price on the appraisal", () => {
  it("carries the page it came from, and only while there is a new price", () => {
    const listings = many([100, 200, 300, 400, 500]);
    const withSource = computeAppraisal(
      { listings, newPrice: 900, newPriceUrl: "https://shop.example/p", position: "typical", positionEvidence: "" },
      300,
    );
    expect(withSource).toMatchObject({ newPrice: 900, newPriceUrl: "https://shop.example/p" });

    const without = computeAppraisal(
      { listings, newPrice: null, newPriceUrl: "https://shop.example/p", position: "typical", positionEvidence: "" },
      300,
    );
    expect(without.newPriceUrl).toBeNull();
    expect(run(listings).newPriceUrl).toBeNull();
  });

  it("defaults to none in the input the browser posts back", () => {
    const parsed = appraisalInputSchema.parse({
      item: { searchQuery: "x", model: "x", condition: "good" },
      listings: [],
      position: "typical",
      positionEvidence: "",
    });
    expect(parsed.newPriceUrl).toBeNull();
  });
});

describe("marketHeadline", () => {
  const item = { model: "iPhone 13" };
  const headline = (asking: number, marketMedian: number | null) =>
    marketHeadline({
      asking,
      gap: marketMedian === null ? null : gap(asking, marketMedian),
      item,
    });

  it("says there is nothing to compare to when the market is too thin", () => {
    expect(headline(450, null)).toBe("Too few verified listings to price your iPhone 13");
    expect(marketHeadline({ asking: 450, gap: null, item: { model: "" } })).toBe(
      "Too few verified listings to price your item",
    );
  });

  it("says right at the median instead of a gap that rounds to nothing", () => {
    expect(headline(450, 450)).toBe("Your $450 is right at the market median");
    expect(headline(450, 449)).toBe("Your $450 is right at the market median"); // +0.22%
  });

  it("leads with the percentage above the median, for a price that is only a little high", () => {
    expect(headline(480, 450)).toBe("Your $480 is 7% above the market median");
  });

  it("leads with the percentage above the median, for a price past the overpriced mark", () => {
    const a = computeAppraisal(
      { listings: many([400, 420, 420, 440, 450]), newPrice: null, position: "typical", positionEvidence: "" },
      520,
    );
    expect(a.overpriced).toBe(true);
    expect(marketHeadline({ ...a, item })).toBe("Your $520 is 24% above the market median");
  });

  it("leads with the percentage below the median", () => {
    expect(headline(380, 432)).toBe("Your $380 is 12% below the market median");
  });

  it.each([
    [520, 420],
    [380, 432],
    [460, 450],
    [1000, 333],
    [95, 100],
  ])("rounds and signs a gap of %i against %i the way formatPct does", (asking, marketMedian) => {
    const { pct } = gap(asking, marketMedian);
    const shown = formatPct(pct);
    const expected = `${shown.slice(1)} ${shown.startsWith("+") ? "above" : "below"}`;
    expect(headline(asking, marketMedian)).toContain(` is ${expected} the market median`);
  });
});
