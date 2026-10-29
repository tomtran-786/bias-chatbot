/**
 * Turns web search results into numbered sources, and ties each listing the
 * model reports back to the source it came from.
 *
 * Pure, with no SDK and no `server-only` import, so it can be tested against a
 * captured response and imported by the spike.
 *
 * Two rules shape everything here, and both exist because the model reading
 * these sources is not to be believed:
 *
 * 1. **The link a person sees is always a URL the search returned, never one the
 *    model wrote.** A listing carries only a `sourceIndex`; the URL is looked up
 *    from there.
 * 2. **A listing only counts if its price appears, word for word, in the text of
 *    the source it cites.** The model is handed the source text and told to copy
 *    the price as written; this check is what makes that an enforced property
 *    rather than a request. A price the model rounded, converted, or took from a
 *    different page does not appear in the cited text and is shown dimmed and
 *    left out of the median.
 *
 * Because the price is checked against the text rather than the page's shape,
 * list pages and price-guide pages count when their price matches. An earlier
 * design only counted single-item pages, and that would have discarded almost
 * everything a search returns.
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
  /** The price exactly as the source text shows it, e.g. "US $1,049.99". */
  priceText: string;
  kind: ListingKind;
  condition: ListingCondition;
  /** What the model says the platform is. Replaced from the URL when known. */
  platform: string;
  /** Index into the numbered sources the model was given. */
  sourceIndex: number;
};

/**
 * The new price as the extraction step reports it: the same two handles a
 * listing gets, so it can be checked the same way.
 */
export type ExtractedNewPrice = {
  /** The price exactly as the source text shows it, e.g. "$699.99". */
  priceText: string;
  /** Index into the numbered sources the model was given. */
  sourceIndex: number;
};

/** One web search result, as far as this module cares. */
export type SearchHit = {
  title: string;
  url: string;
  content: string;
  /** The page body, when the search was asked for it. */
  rawContent: string | null;
};

/** A source as the model sees it: numbered by position, with the text it may quote. */
export type Source = {
  url: string;
  title: string;
  /** The only text a listing's price is checked against. */
  text: string;
};

/**
 * "verified": the price appears verbatim in the cited source.
 * "unverified": a real source, but the price is not in its text.
 * "none": no such source at all.
 */
export type SourceMatch = "verified" | "unverified" | "none";

export type GroundedListing = ExtractedListing & {
  /** From the cited source. Null when there is no such source. */
  url: string | null;
  match: SourceMatch;
};

/** Enough text to carry the prices on a page; more only costs tokens. */
export const MAX_SOURCE_CHARS = 3000;
/**
 * The longest title and address a source may carry, and the longest platform name a
 * listing may. The browser posts sources back to the reading step and listings back
 * with the verdict, and both requests are checked against these (app/api/market,
 * `appraisalInputSchema`), so a source that broke them would fail every retry.
 */
export const MAX_SOURCE_TITLE = 400;
export const MAX_URL = 2000;
export const MAX_PLATFORM = 120;
const MAX_LINE_CHARS = 300;
/** A dollar amount, or one in đồng ("5.500.000 ₫", "5.500.000đ", "VND 5500000", "5,5 triệu", "5.5tr"). */
const PRICE_LINE = /\$\s?\d|(?:₫|\bvn[dđ])\s?\d|\d\s?(?:₫|đ|vn[dđ]|triệu|tr|củ|tỷ)\d{0,3}(?![\p{L}\d])/iu;

/** Whether the text a source offers carries any price at all. */
export function hasPrice(source: Pick<Source, "text">): boolean {
  return PRICE_LINE.test(source.text);
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function isHttp(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The text a source offers the model: the search's own summary of the page,
 * then every line of the page body that carries a dollar or đồng amount.
 *
 * Whole-page text would be thousands of tokens per source and mostly navigation;
 * the lines with a price are the ones a price can come from. The cut is a hard
 * cap, applied last, so it can trim a long page but never reorder it.
 */
function textOf(hit: SearchHit): string {
  const summary = collapse(hit.content);
  const seen = new Set<string>([summary]);
  const priced: string[] = [];

  for (const line of (hit.rawContent ?? "").split("\n")) {
    const text = collapse(line);
    if (!text || !PRICE_LINE.test(text) || seen.has(text)) continue;
    seen.add(text);
    priced.push(text.slice(0, MAX_LINE_CHARS));
  }

  return [summary, ...priced]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_SOURCE_CHARS);
}

/**
 * Numbers the results `[0]..[n]` for the model, dropping any without a usable
 * http(s) address. The index is the only handle a listing gets on its source.
 */
export function toSources(hits: readonly SearchHit[]): Source[] {
  return hits
    .filter((hit) => isHttp(hit.url) && hit.url.length <= MAX_URL)
    .map((hit) => ({
      url: hit.url,
      title: collapse(hit.title).slice(0, MAX_SOURCE_TITLE),
      text: textOf(hit),
    }));
}

/** Sources the model reads at once. More only costs tokens: the cut keeps the ones with prices. */
export const MAX_SOURCES = 24;

/**
 * At most `MAX_SOURCES`, those that carry a price first and each group in the order
 * the search returned them. Numbered afterwards, so the cut never leaves a gap.
 */
export function limitSources(sources: readonly Source[]): Source[] {
  return [
    ...sources.filter((source) => hasPrice(source)),
    ...sources.filter((source) => !hasPrice(source)),
  ].slice(0, MAX_SOURCES);
}

/**
 * Whether `price` appears in `text` as a whole amount, not as the front of a
 * longer one.
 *
 * Plain substring search would call "$1,049" present in "US $1,049.99" and
 * "$49" present in "$49.99", which is the model dropping cents or digits and
 * being waved through. So the match must not be followed by a digit, or by a
 * separator and a digit, and must not be preceded by one. Whitespace is
 * collapsed on both sides first, so a price split across a line break still
 * matches.
 */
export function priceAppearsIn(text: string, price: string): boolean {
  const needle = collapse(price);
  if (!needle) return false;
  const haystack = collapse(text);

  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;

    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    const next = haystack[at + needle.length + 1];

    // "500.000 ₫" is the tail of "5.500.000 ₫", not a price of its own.
    const startsClean =
      before === undefined ||
      (!/\d/.test(before) && !(/[.,]/.test(before) && /\d/.test(haystack[at - 2] ?? "")));
    const endsClean =
      after === undefined ||
      (!/\d/.test(after) && !(/[.,]/.test(after) && next !== undefined && /\d/.test(next)));
    if (startsClean && endsClean) return true;
    from = at + 1;
  }
}

/** Where a platform sells, which decides which of the searches look for it. */
export type Region = "us" | "vn";

type PlatformRule = {
  name: string;
  region: Region;
  /** Matches the host itself or any subdomain of it. */
  hosts: string[];
  /** Paths on this site that are a single item rather than a list of them. */
  item: RegExp;
  /**
   * Worth searching for used-item prices. Left false for a site that sells new
   * stock (a new price is not a used one) or that needs a login to read (the
   * search cannot see inside it). Such sites are still named if they turn up.
   */
  usedMarket: boolean;
};

/**
 * The marketplaces we recognise. Used to name a platform from its URL and to
 * choose where the search looks.
 */
const PLATFORMS: PlatformRule[] = [
  { region: "us", name: "eBay", hosts: ["ebay.com"], item: /^\/itm\//, usedMarket: true },
  { region: "us", name: "Swappa", hosts: ["swappa.com"], item: /^\/listing\//, usedMarket: true },
  { region: "us", name: "Mercari", hosts: ["mercari.com"], item: /^\/(?:us\/)?item\//, usedMarket: true },
  {
    region: "us",
    name: "Facebook Marketplace",
    hosts: ["facebook.com"],
    item: /^\/marketplace\/item\//,
    usedMarket: false,
  },
  { region: "us", name: "OfferUp", hosts: ["offerup.com"], item: /^\/item\/detail\//, usedMarket: true },
  { region: "us", name: "Craigslist", hosts: ["craigslist.org"], item: /\.html$/, usedMarket: true },
  { region: "us", name: "Reverb", hosts: ["reverb.com"], item: /^\/item\//, usedMarket: true },
  { region: "us", name: "Poshmark", hosts: ["poshmark.com"], item: /^\/listing\//, usedMarket: true },
  { region: "us", name: "Depop", hosts: ["depop.com"], item: /^\/products\//, usedMarket: true },
  { region: "us", name: "Back Market", hosts: ["backmarket.com"], item: /\/p\//, usedMarket: true },
  { region: "us", name: "Gazelle", hosts: ["gazelle.com"], item: /\/(?:buy|products?)\//, usedMarket: true },
  { region: "us", name: "Amazon", hosts: ["amazon.com"], item: /\/dp\//, usedMarket: false },
  { region: "us", name: "Best Buy", hosts: ["bestbuy.com"], item: /\/site\/.+\.p/, usedMarket: false },
  { region: "us", name: "Etsy", hosts: ["etsy.com"], item: /\/listing\//, usedMarket: false },
  // Vietnam. Shopee and Lazada sell mostly new stock, but their used-item listings
  // are worth reading; the reading prompt tells the model to report only those.
  { region: "vn", name: "Chợ Tốt", hosts: ["chotot.com"], item: /\.htm$/, usedMarket: true },
  { region: "vn", name: "Shopee", hosts: ["shopee.vn"], item: /-i\.\d+\.\d+/, usedMarket: true },
  { region: "vn", name: "Lazada", hosts: ["lazada.vn"], item: /\/products\/.+\.html/, usedMarket: true },
];

const domainsOf = (region: Region): string[] =>
  PLATFORMS.filter((p) => p.usedMarket && p.region === region).flatMap((p) => p.hosts);

/** Where the searches are told to look, by market. */
export const SEARCH_DOMAINS_US: string[] = domainsOf("us");
export const SEARCH_DOMAINS_VN: string[] = domainsOf("vn");

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
 * Which platform a URL belongs to, and whether it is a single-item page on it.
 * Unknown sites keep their hostname as the platform name.
 *
 * `isItemPage` no longer decides whether a listing counts — the verbatim price
 * check does — but it is still returned so a caller can describe the page.
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
 * Attaches the source to one listing and checks its price against the source's
 * text.
 *
 * `platform` is overwritten from the URL: the model's own claim ("eBay") is only
 * kept when there is no source to check it against, and then the listing is not
 * counted anyway.
 */
export function groundListing(
  listing: ExtractedListing,
  sources: readonly Source[],
): GroundedListing {
  const source = sources[listing.sourceIndex];
  const identity = source ? identify(source.url) : null;

  if (!source || !identity) {
    return { ...listing, url: null, match: "none" };
  }
  return {
    ...listing,
    platform: identity.platform.slice(0, MAX_PLATFORM),
    url: source.url,
    match: priceAppearsIn(source.text, listing.priceText) ? "verified" : "unverified",
  };
}

export function groundListings(
  listings: readonly ExtractedListing[],
  sources: readonly Source[],
): GroundedListing[] {
  return listings.map((listing) => groundListing(listing, sources));
}
