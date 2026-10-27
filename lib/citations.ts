/**
 * The numbers on the sources.
 *
 * Every price that came from the web is a numbered source, and the same listing
 * has the same number wherever it appears: on its dot in the strip, in the list
 * under the strip, and in the sources line under the verdict. Computed once here
 * so those three cannot drift apart.
 *
 * Numbering follows the order the list is shown in — counted listings grouped by
 * platform in `byPlatform` order, then the ones that could not be confirmed — so
 * reading down the list reads 1, 2, 3 …
 *
 * Pure, and free of `server-only`: the cards and the verdict strip both use it.
 */
import { isVndText } from "./currency";
import type { MarketView, PlatformSummary, PricedListing } from "./pricing";

export type CitedListing = {
  /** 1-based; the `[n]` shown wherever this listing is mentioned. */
  n: number;
  listing: PricedListing;
  /** The listing's page, only when it is an http(s) address. */
  href: string | null;
};

export type CitedPlatform = PlatformSummary & { listings: CitedListing[] };

export type Citations = {
  /** The counted listings, grouped by platform. */
  platforms: CitedPlatform[];
  /** The same counted listings, flat, in display order. */
  counted: CitedListing[];
  /** Real sources whose price could not be confirmed, numbered after the counted ones. */
  unverified: CitedListing[];
};

const HTTP_URL = /^https?:\/\//;

/**
 * The URL if it is safe to put in an `href`, otherwise null. A `javascript:` or
 * `data:` address must never become a link, whatever wrote it.
 */
export function safeHref(url: string | null | undefined): string | null {
  return url && HTTP_URL.test(url) ? url : null;
}

/** "ebay.com" for "https://www.ebay.com/itm/123", or null when it is not a URL. */
export function hostLabel(url: string | null | undefined): string | null {
  const href = safeHref(url);
  if (!href) return null;
  try {
    return new URL(href).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The price as the page wrote it, when it was not written in dollars ("5.500.000 ₫"),
 * so the card can show it beside the converted figure. Null for a dollar price.
 */
export function originalPrice(listing: Pick<PricedListing, "priceText">): string | null {
  return isVndText(listing.priceText) ? listing.priceText.trim() : null;
}

/** One line on the conversion, when any listing shown was priced in đồng; otherwise null. */
export function conversionNote(
  appraisal: Pick<MarketView, "listings"> & { raw: { vndPerUsd: number } },
): string | null {
  const shown = appraisal.listings.some((listing) => originalPrice(listing) !== null);
  return shown
    ? `VND converted at 1 USD = ${appraisal.raw.vndPerUsd.toLocaleString("en-US")} ₫.`
    : null;
}

export function citeListings(
  appraisal: Pick<MarketView, "listings" | "platforms">,
): Citations {
  let n = 0;
  const cite = (listing: PricedListing): CitedListing => ({
    n: ++n,
    listing,
    href: safeHref(listing.url),
  });

  const used = appraisal.listings.filter((listing) => listing.status === "used");
  const platforms = appraisal.platforms.map((platform) => ({
    ...platform,
    listings: used.filter((listing) => listing.platform === platform.platform).map(cite),
  }));
  const unverified = appraisal.listings
    .filter((listing) => listing.status !== "used")
    .map(cite);

  return {
    platforms,
    counted: platforms.flatMap((platform) => platform.listings),
    unverified,
  };
}
