/**
 * Ties each listing the model reports back to a page the search actually
 * retrieved.
 *
 * Pure, with no SDK and no `server-only` import, so it can be tested against a
 * captured response. The one side effect — following Google's redirect links —
 * takes the fetch function as a parameter.
 *
 * The rule that shapes everything here: **the link a person sees is always a URL
 * that came out of the search's own grounding metadata, never a URL the model
 * wrote.** A model asked to cite a listing will happily produce a plausible
 * eBay URL that does not exist. So a listing carries only a `sourceIndex` into
 * the retrieved chunks; the URL is looked up from there.
 *
 * A listing counts toward the market price only if its source is an item page
 * ("listing"). A source that is merely the right site — a search results page, a
 * category page — says nothing about whether the price on it is real, so those
 * are shown dimmed and kept out of the median ("domain").
 */

export const LISTING_CONDITIONS = [
  "new",
  "like_new",
  "good",
  "fair",
  "for_parts",
  "unknown",
] as const;
export type ListingCondition = (typeof LISTING_CONDITIONS)[number];

export type ListingKind = "sold" | "active";

/** A listing as the extraction step reports it: no URL, only a pointer. */
export type ExtractedListing = {
  title: string;
  /** The price exactly as the page shows it, e.g. "US $1,049.99". */
  priceText: string;
  kind: ListingKind;
  condition: ListingCondition;
  /** What the model says the platform is. Replaced from the URL when known. */
  platform: string;
  /** Index into the search's grounding chunks. */
  sourceIndex: number;
};

/** A grounding chunk after its redirect has been followed. */
export type ResolvedSource = {
  /** Google's redirect link, as returned. */
  uri: string;
  /** The page title the search reported; often just the site's name. */
  title: string;
  /** Where the redirect points. Null when it could not be followed. */
  url: string | null;
};

export type SourceMatch = "listing" | "domain" | "none";

export type GroundedListing = ExtractedListing & {
  /** From the resolved source. Null when there is no usable source. */
  url: string | null;
  match: SourceMatch;
};

/** The part of a grounding support this module needs. */
export type Support = {
  segment?: { endIndex?: number };
  groundingChunkIndices?: number[];
};

/**
 * The search summary with `[n]` after each claim, n being the chunk that backs
 * it, so the extraction step can see which source a price came from instead of
 * guessing from a list of titles.
 *
 * Segment offsets are UTF-8 byte offsets, not string indices, so the text is
 * cut as bytes; slicing the string would drift as soon as a price carries a
 * "£" or a title an accent.
 */
export function annotateCitations(
  text: string,
  supports: readonly Support[],
): string {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();

  const inserts = supports
    .flatMap((support) => {
      const end = support.segment?.endIndex;
      const indices = support.groundingChunkIndices ?? [];
      if (end === undefined || indices.length === 0) return [];
      return [
        {
          at: Math.min(Math.max(end, 0), bytes.length),
          marker: indices.map((index) => `[${index}]`).join(""),
        },
      ];
    })
    .sort((a, b) => a.at - b.at);

  let out = "";
  let position = 0;
  for (const { at, marker } of inserts) {
    out += decoder.decode(bytes.slice(position, at)) + marker;
    position = at;
  }
  return out + decoder.decode(bytes.slice(position));
}

const REDIRECT_HOST = "vertexaisearch.cloud.google.com";

/**
 * Whether `uri` is one of Google's grounding redirect links.
 *
 * Only these are ever fetched. The URI comes from the API response rather than
 * from the model's text, but an allowlist costs nothing and means this function
 * cannot be turned into a way to make the server request an arbitrary address.
 */
export function isGroundingRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" && url.hostname === REDIRECT_HOST;
  } catch {
    return false;
  }
}

function asHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Follows one redirect link without following the destination: it reads the
 * `Location` header and stops, so the server never requests a third-party page.
 */
export async function resolveUri(
  uri: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<string | null> {
  if (!isGroundingRedirect(uri)) return asHttpUrl(uri);

  try {
    const response = await fetchImpl(uri, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const location = response.headers.get("location");
    return location ? asHttpUrl(new URL(location, uri).toString()) : null;
  } catch {
    return null;
  }
}

export async function resolveSources(
  chunks: ReadonlyArray<{ uri?: string; title?: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedSource[]> {
  return Promise.all(
    chunks.map(async (chunk) => ({
      uri: chunk.uri ?? "",
      title: chunk.title ?? "",
      url: chunk.uri ? await resolveUri(chunk.uri, fetchImpl) : null,
    })),
  );
}

type PlatformRule = {
  name: string;
  /** Matches the host itself or any subdomain of it. */
  hosts: string[];
  /** Paths on this site that are a single item rather than a list of them. */
  item: RegExp;
};

/**
 * The marketplaces we recognise, and what an item page looks like on each.
 *
 * Written from how these sites structure their URLs, not from captured search
 * results — run `npm run spike` and check real sources against it before
 * trusting the "listing" level. Too strict and nearly every listing falls back
 * to "domain" and the app reports thin data; too loose and a category page's
 * price gets into the median. Extending the table is the intended fix.
 */
const PLATFORMS: PlatformRule[] = [
  { name: "eBay", hosts: ["ebay.com"], item: /^\/itm\// },
  { name: "Swappa", hosts: ["swappa.com"], item: /^\/listing\// },
  { name: "Mercari", hosts: ["mercari.com"], item: /^\/(?:us\/)?item\// },
  {
    name: "Facebook Marketplace",
    hosts: ["facebook.com"],
    item: /^\/marketplace\/item\//,
  },
  { name: "OfferUp", hosts: ["offerup.com"], item: /^\/item\/detail\// },
  { name: "Craigslist", hosts: ["craigslist.org"], item: /\.html$/ },
  { name: "Reverb", hosts: ["reverb.com"], item: /^\/item\// },
  { name: "Poshmark", hosts: ["poshmark.com"], item: /^\/listing\// },
  { name: "Depop", hosts: ["depop.com"], item: /^\/products\// },
  { name: "Back Market", hosts: ["backmarket.com"], item: /\/p\// },
  { name: "Gazelle", hosts: ["gazelle.com"], item: /\/(?:buy|products?)\// },
  { name: "Amazon", hosts: ["amazon.com"], item: /\/dp\// },
  { name: "Best Buy", hosts: ["bestbuy.com"], item: /\/site\/.+\.p/ },
  { name: "Etsy", hosts: ["etsy.com"], item: /\/listing\// },
];

/** For sites we have no rule for: a path that names a single item. */
const GENERIC_ITEM = /\/(?:item|itm|listing|listings|product|products|dp)\/[^/]+/;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Which platform a URL belongs to, and whether it is an item page on it.
 * Unknown sites keep their hostname as the platform name.
 */
export function identify(url: string): {
  platform: string;
  isItemPage: boolean;
} | null {
  const host = hostOf(url);
  if (!host) return null;
  const path = new URL(url).pathname;

  const rule = PLATFORMS.find((p) =>
    p.hosts.some((h) => host === h || host.endsWith(`.${h}`)),
  );
  if (rule) return { platform: rule.name, isItemPage: rule.item.test(path) };
  return { platform: host, isItemPage: GENERIC_ITEM.test(path) };
}

/**
 * Attaches the source to one listing.
 *
 * `platform` is overwritten from the URL when there is one: the model's own
 * claim ("eBay") is only used when there is no source to check it against, and
 * then the listing is not counted anyway.
 */
export function groundListing(
  listing: ExtractedListing,
  sources: readonly ResolvedSource[],
): GroundedListing {
  const source = sources[listing.sourceIndex];
  const identity = source?.url ? identify(source.url) : null;

  if (!source?.url || !identity) {
    return { ...listing, url: null, match: "none" };
  }
  return {
    ...listing,
    platform: identity.platform,
    url: source.url,
    match: identity.isItemPage ? "listing" : "domain",
  };
}

export function groundListings(
  listings: readonly ExtractedListing[],
  sources: readonly ResolvedSource[],
): GroundedListing[] {
  return listings.map((listing) => groundListing(listing, sources));
}
