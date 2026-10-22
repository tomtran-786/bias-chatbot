/**
 * The same `[n]` has to mean the same listing in the strip, the list under it
 * and the sources line under the verdict, so the numbering is pinned here.
 */
import { describe, expect, it } from "vitest";
import { citeListings, hostLabel, safeHref } from "@/lib/citations";
import { computeAppraisal } from "@/lib/pricing";
import type { GroundedListing } from "@/lib/sources";

let counter = 0;
function listing(price: number, over: Partial<GroundedListing> = {}): GroundedListing {
  counter += 1;
  return {
    title: `Listing ${counter}`,
    priceText: `$${price}`,
    kind: "sold",
    condition: "good",
    platform: "eBay",
    sourceIndex: counter,
    url: `https://www.ebay.com/itm/${counter}`,
    match: "verified",
    ...over,
  };
}

const swappa = (price: number, over: Partial<GroundedListing> = {}) =>
  listing(price, {
    platform: "Swappa",
    url: `https://swappa.com/listing/${price}`,
    ...over,
  });

function appraise(listings: GroundedListing[]) {
  return computeAppraisal(
    { listings, newPrice: null, position: "typical", positionEvidence: "" },
    300,
  );
}

describe("citeListings", () => {
  // eBay has three of the five counted listings, Swappa two, and one extra
  // price on a page that never showed it.
  const build = () =>
    appraise([
      swappa(310),
      listing(200),
      swappa(330, { sourceIndex: 90 }),
      listing(250),
      listing(300),
      listing(999, { match: "unverified", url: "https://www.mercari.com/us/item/m1/" }),
    ]);

  it("groups the counted listings by platform, in the order the platforms are summarised", () => {
    const appraisal = build();
    const cited = citeListings(appraisal);

    expect(cited.platforms.map((p) => p.platform)).toEqual(appraisal.platforms.map((p) => p.platform));
    expect(cited.platforms.map((p) => p.platform)).toEqual(["eBay", "Swappa"]);
    for (const platform of cited.platforms) {
      expect(platform.listings.every((c) => c.listing.platform === platform.platform)).toBe(true);
      expect(platform.listings).toHaveLength(platform.count);
    }
  });

  it("numbers the counted listings 1..k in the order they are displayed", () => {
    const cited = citeListings(build());

    expect(cited.counted.map((c) => c.n)).toEqual([1, 2, 3, 4, 5]);
    expect(cited.counted.map((c) => c.listing.price)).toEqual([200, 250, 300, 310, 330]);
    // The flat list is the grouped one, read down.
    expect(cited.counted).toEqual(cited.platforms.flatMap((p) => p.listings));
  });

  it("numbers the unverified ones after the counted ones", () => {
    const cited = citeListings(build());

    expect(cited.unverified.map((c) => c.n)).toEqual([6]);
    expect(cited.unverified[0].listing.price).toBe(999);
  });

  it("gives the same listing the same number every time it is asked", () => {
    const appraisal = build();
    const first = citeListings(appraisal);
    const again = citeListings(appraisal);

    expect(again.counted.map((c) => [c.n, c.listing.title])).toEqual(
      first.counted.map((c) => [c.n, c.listing.title]),
    );
    expect(again.unverified.map((c) => [c.n, c.listing.title])).toEqual(
      first.unverified.map((c) => [c.n, c.listing.title]),
    );
  });

  it("links only http and https addresses", () => {
    const appraisal = appraise([
      listing(200),
      listing(250, { url: "javascript:alert(1)" }),
      listing(300, { url: "data:text/html,<script>1</script>" }),
      listing(350, { url: null }),
      listing(400, { url: "http://www.ebay.com/itm/plain" }),
    ]);
    const hrefs = citeListings(appraisal).counted.map((c) => [c.listing.price, c.href]);

    expect(hrefs).toEqual([
      [200, "https://www.ebay.com/itm/" + (counter - 4)],
      [250, null],
      [300, null],
      [350, null],
      [400, "http://www.ebay.com/itm/plain"],
    ]);
  });

  it("is empty when nothing was found", () => {
    const cited = citeListings(appraise([]));
    expect(cited).toEqual({ platforms: [], counted: [], unverified: [] });
  });
});

describe("safeHref and hostLabel", () => {
  it("lets only http(s) through", () => {
    expect(safeHref("https://a.example/x")).toBe("https://a.example/x");
    expect(safeHref("http://a.example/x")).toBe("http://a.example/x");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("//a.example/x")).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
  });

  it("names the site without www", () => {
    expect(hostLabel("https://www.ebay.com/itm/123?x=1")).toBe("ebay.com");
    expect(hostLabel("https://shop.bestbuy.com/p")).toBe("shop.bestbuy.com");
    expect(hostLabel("javascript:alert(1)")).toBeNull();
    expect(hostLabel(null)).toBeNull();
  });
});
