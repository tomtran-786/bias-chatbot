import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  groundListing,
  groundListings,
  identify,
  isGroundingRedirect,
  resolveSources,
  resolveUri,
  type ExtractedListing,
  type ResolvedSource,
} from "@/lib/grounding";

const fixture = JSON.parse(
  readFileSync("tests/fixtures/grounding-sample.json", "utf8"),
) as {
  groundingMetadata: { groundingChunks: Array<{ web: { uri: string; title: string } }> };
  redirects: Record<string, string>;
  listings: ExtractedListing[];
};

/** A fetch that answers like Google's redirector: a 302 with a Location. */
function redirector(table: Record<string, string>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const location = table[String(input)];
    return location
      ? new Response(null, { status: 302, headers: { location } })
      : new Response(null, { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/x";

describe("isGroundingRedirect", () => {
  it("accepts only Google's redirector over https", () => {
    expect(isGroundingRedirect(REDIRECT)).toBe(true);
    expect(isGroundingRedirect("http://vertexaisearch.cloud.google.com/x")).toBe(false);
    expect(isGroundingRedirect("https://evil.example/vertexaisearch.cloud.google.com")).toBe(false);
    expect(isGroundingRedirect("https://vertexaisearch.cloud.google.com.evil.example/x")).toBe(false);
    expect(isGroundingRedirect("not a url")).toBe(false);
  });
});

describe("resolveUri", () => {
  it("reads the Location header without following it", async () => {
    const fetchImpl = redirector({ [REDIRECT]: "https://www.ebay.com/itm/1" });
    await expect(resolveUri(REDIRECT, fetchImpl)).resolves.toBe("https://www.ebay.com/itm/1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("resolves a relative Location against the redirector", async () => {
    const fetchImpl = redirector({ [REDIRECT]: "/elsewhere" });
    await expect(resolveUri(REDIRECT, fetchImpl)).resolves.toBe(
      "https://vertexaisearch.cloud.google.com/elsewhere",
    );
  });

  it("never fetches an address that is not Google's redirector", async () => {
    const fetchImpl = redirector({});
    await expect(resolveUri("https://www.ebay.com/itm/1", fetchImpl)).resolves.toBe(
      "https://www.ebay.com/itm/1",
    );
    await expect(resolveUri("http://169.254.169.254/latest", fetchImpl)).resolves.toBe(
      "http://169.254.169.254/latest",
    );
    await expect(resolveUri("file:///etc/passwd", fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the redirect has no Location, errors, or points off http(s)", async () => {
    await expect(resolveUri(REDIRECT, redirector({}))).resolves.toBeNull();
    await expect(
      resolveUri(REDIRECT, (async () => {
        throw new Error("network");
      }) as typeof fetch),
    ).resolves.toBeNull();
    await expect(
      resolveUri(REDIRECT, redirector({ [REDIRECT]: "javascript:alert(1)" })),
    ).resolves.toBeNull();
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

describe("groundListing", () => {
  const listing: ExtractedListing = {
    title: "t",
    priceText: "$1",
    kind: "sold",
    condition: "good",
    platform: "Claimed",
    sourceIndex: 0,
  };
  const source = (url: string | null): ResolvedSource => ({ uri: "u", title: "t", url });

  it("marks an item page as a listing and takes the platform from the URL", () => {
    const grounded = groundListing(listing, [source("https://www.ebay.com/itm/1")]);
    expect(grounded).toMatchObject({
      match: "listing",
      platform: "eBay",
      url: "https://www.ebay.com/itm/1",
    });
  });

  it("marks a right-site-wrong-page source as domain only", () => {
    const grounded = groundListing(listing, [source("https://www.ebay.com/sch/i.html?_nkw=x")]);
    expect(grounded.match).toBe("domain");
    expect(grounded.url).toContain("ebay.com");
  });

  it("has no source for an out-of-range index or an unresolved link", () => {
    expect(groundListing({ ...listing, sourceIndex: 3 }, [source("https://a.com/itm/1")])).toMatchObject({
      match: "none",
      url: null,
      platform: "Claimed",
    });
    expect(groundListing(listing, [source(null)])).toMatchObject({ match: "none", url: null });
  });
});

describe("against the sample response", () => {
  it("resolves every chunk and grounds each listing", async () => {
    const fetchImpl = redirector(fixture.redirects);
    const sources = await resolveSources(fixture.groundingMetadata.groundingChunks.map((c) => c.web), fetchImpl);

    expect(sources.map((s) => s.url)).toEqual([
      "https://www.ebay.com/itm/166000000001?hash=item2670",
      "https://www.ebay.com/sch/i.html?_nkw=iphone+13+128gb&LH_Sold=1",
      "https://swappa.com/listing/view/ABCD12345",
      null, // the dead link: its redirect did not resolve
    ]);

    const grounded = groundListings(fixture.listings, sources);
    expect(grounded.map((l) => [l.platform, l.match])).toEqual([
      ["eBay", "listing"], // an item page: counts
      ["eBay", "domain"], // a search page: shown dimmed, not counted
      ["Swappa", "listing"],
      ["Mercari", "none"], // claimed Mercari, but nothing resolved to check it
      ["Facebook Marketplace", "none"], // sourceIndex 9 does not exist
    ]);
  });

  it("never lets a model-written URL through: listings carry no url of their own", () => {
    for (const listing of fixture.listings) expect(listing).not.toHaveProperty("url");
  });
});
