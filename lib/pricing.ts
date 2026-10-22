/**
 * Every number the person is shown, computed here and nowhere else.
 *
 * The model reports listings and picks a position — below, typical or above the
 * market — and that is all it may assert. The median, the quartiles, the
 * per-platform split, the suggested price and the gap to theirs are derived
 * here from the listings, for the same reason the old scorecard's headline was:
 * a model asked for both the parts and the total bends the total toward the
 * verdict it has already formed.
 *
 * Deliberately free of `server-only`: the appraise route sends these figures to
 * the browser, the chat route recomputes them from the raw listings the browser
 * posts back, and both sides need the types.
 */
import { z } from "zod";
import {
  LISTING_CONDITIONS,
  priceAppearsIn,
  type ExtractedNewPrice,
  type GroundedListing,
  type Source,
} from "./sources";
import { itemFactsSchema, type ItemFacts } from "./item";

/** A market needs this many listings before it gets a range and an adjustment. */
export const FULL_MIN = 5;
/** Below this there is no market price at all. */
export const THIN_MIN = 3;
/** Listings that go into one median. */
export const MAX_LISTINGS = 10;
/**
 * One page can carry a dozen prices (a search results page, a price guide) and
 * would otherwise be the whole market by itself; cap what a single source
 * contributes.
 */
export const MAX_PER_SOURCE = 3;
/** A listing outside this band of the first-pass median is treated as an error. */
export const OUTLIER_LOW = 0.33;
export const OUTLIER_HIGH = 3;
/** The suggested price is held to this fraction of the new price. */
export const NEW_PRICE_CEILING = 0.9;
/** Asking this far above the market median marks the price as high. */
export const OVERPRICED_AT = 0.15;

export const POSITIONS = ["below", "typical", "above"] as const;
export type Position = (typeof POSITIONS)[number];

const OTHER_CURRENCY =
  /[£€¥₹₩₫₱฿₪₺₽]|\b(?:EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|MXN|CHF|SEK|NOK|DKK|PLN|BRL|SGD|HKD|KRW|VND)\b|\b(?:C|CA|AU|A|NZ|MX|HK|S|R)\s?\$/;

const USD_AMOUNT =
  /(?:US\s?)?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\bUSD\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;

/**
 * Reads a price off the text a page showed, in US dollars, or null.
 *
 * Done here rather than asked of the model because "US $1,049.99" is exactly the
 * kind of string a model silently turns into 1049 or 104999. Null covers every
 * case where the honest answer is "not a single USD amount": another currency,
 * a range, a price with a second price beside it, free, or nothing parseable.
 */
export function parsePriceText(text: string): number | null {
  if (OTHER_CURRENCY.test(text)) return null;

  const amounts = [...text.matchAll(USD_AMOUNT)];
  if (amounts.length === 0) return null;

  if (amounts.length > 1) {
    // "$300 + $20 shipping" is one price; "$300 to $400" and "$300 (was $400)"
    // are not, and picking one would be a guess.
    const between = text.slice(
      (amounts[0].index ?? 0) + amounts[0][0].length,
      amounts[1].index,
    );
    if (!/\+|ship|deliver|tax|fee/i.test(between)) return null;
  }

  const [, whole1, cents1, whole2, cents2] = amounts[0];
  const whole = whole1 ?? whole2;
  const cents = cents1 ?? cents2;
  const value = Number(`${whole.replace(/,/g, "")}${cents ? `.${cents}` : ""}`);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The new price as a number and the page it came from, or null.
 *
 * Held to the same standard as a listing, because it is used as a ceiling: the
 * cited source must exist, the price must appear word for word in that source's
 * text, and it must be a single USD amount. A new price that fails any of these
 * is not used, so a number the model remembered or took from another page cannot
 * pull the suggested price down.
 */
export function groundNewPrice(
  claim: ExtractedNewPrice | null | undefined,
  sources: readonly Source[],
): { price: number; url: string } | null {
  if (!claim) return null;
  const source = sources[claim.sourceIndex];
  if (!source || !priceAppearsIn(source.text, claim.priceText)) return null;
  const price = parsePriceText(claim.priceText);
  return price === null ? null : { price, url: source.url };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median() needs at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round2(
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
  );
}

/** Linear-interpolation quantile (R-7), the one spreadsheets use. */
function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function quartiles(values: readonly number[]): { q1: number; q3: number } {
  if (values.length === 0) throw new Error("quartiles() needs at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    q1: round2(quantile(sorted, 0.25)),
    q3: round2(quantile(sorted, 0.75)),
  };
}

export type PricedListing = GroundedListing & {
  /** Parsed from `priceText`, USD. */
  price: number;
  /** "used" counts toward the median; "unverified" is shown dimmed. */
  status: "used" | "unverified";
};

export type PlatformSummary = {
  platform: string;
  count: number;
  median: number;
};

export function byPlatform(listings: readonly PricedListing[]): PlatformSummary[] {
  const groups = new Map<string, number[]>();
  for (const listing of listings) {
    groups.set(listing.platform, [
      ...(groups.get(listing.platform) ?? []),
      listing.price,
    ]);
  }
  return [...groups]
    .map(([platform, prices]) => ({
      platform,
      count: prices.length,
      median: median(prices),
    }))
    .sort((a, b) => b.count - a.count || a.platform.localeCompare(b.platform));
}

export function gap(
  asking: number,
  marketMedian: number,
): { amount: number; pct: number } {
  // `pct` stays unrounded: it is compared to OVERPRICED_AT, and rounding first
  // would let 14.96% read as 15%. Round when displaying (see `formatPct`).
  return {
    amount: round2(asking - marketMedian),
    pct: (asking - marketMedian) / marketMedian,
  };
}

/** Rounds to the increments sellers actually list at, not to the cent. */
function listingStep(value: number): number {
  if (value < 25) return 1;
  if (value < 250) return 5;
  if (value < 1000) return 10;
  return 25;
}

/**
 * Rounds `value` to a price someone would list at, never above `ceiling`.
 * Rounds down to the step when the nearest step would break the ceiling, so a
 * cap is a cap and not a suggestion.
 */
export function listingPrice(value: number, ceiling?: number): number {
  const step = listingStep(value);
  const rounded = Math.round(value / step) * step;
  if (ceiling === undefined || rounded <= ceiling) return rounded;
  return Math.floor(ceiling / listingStep(ceiling)) * listingStep(ceiling);
}

/**
 * What the screen leaves in, in order: another currency or no price at all,
 * for-parts listings, listings above the new price, and duplicates all go.
 */
function screen(
  listings: readonly GroundedListing[],
  newPrice: number | null,
): Array<GroundedListing & { price: number }> {
  const seen = new Set<string>();
  const kept: Array<GroundedListing & { price: number }> = [];

  for (const listing of listings) {
    const price = parsePriceText(listing.priceText);
    if (price === null) continue;
    if (listing.condition === "for_parts") continue;
    if (newPrice !== null && price > newPrice) continue;

    const title = listing.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const key = `${listing.url ?? listing.platform}|${price}|${title}`;
    if (seen.has(key)) continue;
    seen.add(key);

    kept.push({ ...listing, price });
  }
  return kept;
}

/** At most `MAX_PER_SOURCE` from any one page, at most `MAX_LISTINGS` overall. */
function capListings<T extends { url: string | null }>(listings: readonly T[]): T[] {
  const perSource = new Map<string, number>();
  const out: T[] = [];
  for (const listing of listings) {
    const source = listing.url ?? "";
    const used = perSource.get(source) ?? 0;
    if (used >= MAX_PER_SOURCE) continue;
    perSource.set(source, used + 1);
    out.push(listing);
    if (out.length >= MAX_LISTINGS) break;
  }
  return out;
}

export const rawListingSchema = z.object({
  title: z.string().max(300),
  priceText: z.string().max(80),
  kind: z.enum(["sold", "active"]),
  condition: z.enum(LISTING_CONDITIONS),
  platform: z.string().max(120),
  sourceIndex: z.number().int().min(0).max(1000),
  url: z.string().max(2000).nullable(),
  match: z.enum(["verified", "unverified", "none"]),
});

/**
 * Everything the figures are computed from. The browser keeps this and posts it
 * back with the verdict request; the server recomputes rather than trusting a
 * median the client sends.
 */
export const appraisalInputSchema = z.object({
  item: itemFactsSchema,
  listings: z.array(rawListingSchema).max(40),
  /** Grounded: only set when the page it came from showed this price. */
  newPrice: z.number().positive().nullable().default(null),
  /** The page `newPrice` came from, so the card can link it. */
  newPriceUrl: z.string().max(2000).nullable().default(null),
  position: z.enum(POSITIONS),
  positionEvidence: z.string().max(600),
});

export type AppraisalInput = z.output<typeof appraisalInputSchema>;

export type Tier = "full" | "thin" | "none";

export type Market = {
  tier: Tier;
  /** "sold" only when five or more sold listings carried the median. */
  basis: "sold" | "asking" | null;
  /** Asking prices overstate what things sell for; say so when they are used. */
  askingRunHigh: boolean;
  count: number;
  median: number | null;
  /** The interquartile range. Only with a full market. */
  q1: number | null;
  q3: number | null;
};

export type Suggested = {
  price: number;
  anchor: "p25" | "median" | "p75";
  /** True when the new-price ceiling pulled it below where it would have sat. */
  capped: boolean;
};

export type Appraisal = {
  asking: number;
  market: Market;
  platforms: PlatformSummary[];
  suggested: Suggested | null;
  gap: { amount: number; pct: number } | null;
  overpriced: boolean;
  newPrice: number | null;
  /** Where the new price was read from. Null whenever `newPrice` is. */
  newPriceUrl: string | null;
  position: Position;
  positionEvidence: string;
  /** The listings to show: those counted, then those shown dimmed. */
  listings: PricedListing[];
};

const ANCHOR_FOR: Record<Position, Suggested["anchor"]> = {
  below: "p25",
  typical: "median",
  above: "p75",
};

/**
 * The market, the suggested price and the gap, from raw grounded listings.
 *
 * The thresholds are the whole policy: five or more listings earns a median, a
 * range and a condition adjustment; three or four earns a median and a flag;
 * fewer than that earns no price, because a number built from two listings is
 * worse than saying so.
 */
export function computeAppraisal(
  input: Pick<AppraisalInput, "listings" | "newPrice" | "position" | "positionEvidence"> & {
    newPriceUrl?: string | null;
  },
  asking: number,
): Appraisal {
  const newPrice = input.newPrice ?? null;
  const screened = screen(input.listings, newPrice);

  const verified = screened.filter((l) => l.match === "verified");
  const unverified = screened
    .filter((l) => l.match !== "verified")
    .map((l): PricedListing => ({ ...l, status: "unverified" }));

  // The outlier band is anchored on the first-pass median of everything that
  // could count, so one absurd listing cannot drag the band toward itself.
  const firstPass = verified.length ? median(verified.map((l) => l.price)) : null;
  const inBand =
    firstPass === null
      ? []
      : verified.filter(
          (l) =>
            l.price >= firstPass * OUTLIER_LOW &&
            l.price <= firstPass * OUTLIER_HIGH,
        );

  // Sold prices are what things went for; asking prices are what sellers hope.
  // Use sold alone once there are enough of them, otherwise fall back to
  // everything and say that asking prices run high.
  const sold = capListings(inBand.filter((l) => l.kind === "sold"));
  const soldCarries = sold.length >= FULL_MIN;
  const pool = soldCarries ? sold : capListings(inBand);
  const used = pool.map((l): PricedListing => ({ ...l, status: "used" }));
  const prices = used.map((l) => l.price);

  const tier: Tier =
    used.length >= FULL_MIN ? "full" : used.length >= THIN_MIN ? "thin" : "none";

  const basis: Market["basis"] =
    tier === "none" ? null : soldCarries || used.every((l) => l.kind === "sold") ? "sold" : "asking";

  const marketMedian = tier === "none" ? null : median(prices);
  const range = tier === "full" ? quartiles(prices) : null;

  const market: Market = {
    tier,
    basis,
    askingRunHigh: basis === "asking",
    count: used.length,
    median: marketMedian,
    q1: range?.q1 ?? null,
    q3: range?.q3 ?? null,
  };

  const ceilingFromNew = newPrice === null ? undefined : newPrice * NEW_PRICE_CEILING;

  let suggested: Suggested | null = null;
  if (marketMedian !== null) {
    // Only a full market has quartiles to adjust along; a thin one stays on the
    // median, whatever the position says. Where it does adjust, P75 is also the
    // most it may ever suggest.
    const anchor = range ? ANCHOR_FOR[input.position] : "median";
    const target = !range
      ? marketMedian
      : anchor === "p25"
        ? range.q1
        : anchor === "p75"
          ? range.q3
          : marketMedian;
    const ceiling = Math.min(ceilingFromNew ?? Infinity, range?.q3 ?? Infinity);
    const price = listingPrice(target, Number.isFinite(ceiling) ? ceiling : undefined);
    suggested = { price, anchor, capped: price < listingPrice(target) };
  }

  const gapToMarket = marketMedian === null ? null : gap(asking, marketMedian);

  return {
    asking,
    market,
    platforms: byPlatform(used),
    suggested,
    gap: gapToMarket,
    overpriced: gapToMarket !== null && gapToMarket.pct >= OVERPRICED_AT,
    newPrice,
    newPriceUrl: newPrice === null ? null : (input.newPriceUrl ?? null),
    position: input.position,
    positionEvidence: input.positionEvidence,
    listings: [...used, ...unverified],
  };
}

/** What the appraise route returns: the figures, plus what they came from. */
export type AppraiseResponse = Appraisal & {
  item: ItemFacts;
  /**
   * The grounded listings before screening, and the rest of what the figures
   * were computed from. The browser posts this back with the verdict request so
   * the server can recompute rather than trust a median the client sends.
   */
  raw: AppraisalInput;
  /** The searches that were run, so the person can see what was looked up. */
  queries: string[];
  /**
   * Which steps a backup model answered because Gemini could not, and which one.
   * Empty normally. Sent for whoever is debugging; the screen does not show it.
   */
  backup: Array<{ step: "facts" | "reading"; provider: string }>;
};

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const dollarsAndCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** "$250" for a round amount, "$352.50" (never "$352.5") when there are cents. */
export function formatUsd(value: number): string {
  return Number.isInteger(value) ? dollars.format(value) : dollarsAndCents.format(value);
}

/** Whole dollars, for a quartile: the cents of an interpolated value mean nothing. */
export function formatUsdWhole(value: number): string {
  return formatUsd(Math.round(value));
}

export function formatPct(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(Math.round(pct * 100))}%`;
}

/**
 * The takeaway the market card opens with: what the comparison says, in one
 * sentence, before any of the evidence. The percentage is rounded and signed
 * exactly as `formatPct` does it, so the title never disagrees with a figure
 * shown elsewhere.
 */
export function marketHeadline({
  asking,
  gap: gapToMarket,
  item,
}: Pick<Appraisal, "asking" | "gap"> & { item: Pick<ItemFacts, "model"> }): string {
  if (gapToMarket === null) {
    return `Too few verified listings to price your ${item.model || "item"}`;
  }
  // Under half a percent rounds to "0%", which would read as a gap that is not
  // there; say what it is instead.
  if (Math.abs(gapToMarket.pct) < 0.005) {
    return `Your ${formatUsd(asking)} is right at the market median`;
  }
  const size = formatPct(gapToMarket.pct).replace(/^[+−]/, "");
  return `Your ${formatUsd(asking)} is ${size} ${gapToMarket.pct > 0 ? "above" : "below"} the market median`;
}

/**
 * The appraisal as the model receives it on the verdict turn.
 *
 * The search is a separate, stateless call, so by the time the assistant writes
 * the verdict it has no memory of what was found. Handing it the computed
 * figures, and telling it to argue only from them, is what stops it
 * reconstructing a market from impression.
 */
export function describeAppraisal(appraisal: Appraisal): string {
  const { market, suggested, gap: gapToMarket } = appraisal;
  const lines = ["## The market, as the app computed it", ""];

  if (market.tier === "none") {
    lines.push(
      `Only ${market.count} usable listing${market.count === 1 ? "" : "s"} could be verified, which is not enough to state a market price.`,
      "",
      "Do not give a price, a range or a comparison to theirs. Instead explain how they should price this themselves: check recently sold listings of the exact model on the platforms below, price against what has sold rather than what is listed, and adjust for the condition you saw in the photos.",
    );
  } else {
    lines.push(
      `- Listings counted: ${market.count} (${market.basis === "sold" ? "sold listings" : "asking prices"})`,
      `- Market median: ${formatUsd(market.median!)}`,
    );
    if (market.q1 !== null && market.q3 !== null) {
      lines.push(
        `- Middle half of listings: ${formatUsdWhole(market.q1)} to ${formatUsdWhole(market.q3)}`,
      );
    }
    if (market.askingRunHigh) {
      lines.push(
        "- These are asking prices, which run higher than what things sell for. Say so.",
      );
    }
    if (market.tier === "thin") {
      lines.push(
        "- Only a few listings were found. Say plainly that this is thin evidence and keep the tone tentative.",
      );
    }
    if (appraisal.newPrice !== null) {
      lines.push(`- New price, as a ceiling only: ${formatUsd(appraisal.newPrice)}`);
    }
    lines.push(
      `- Their locked price: ${formatUsd(appraisal.asking)} (${formatPct(gapToMarket!.pct)} against the median)`,
      `- overpriced: ${appraisal.overpriced ? "true" : "false"}`,
    );
    if (suggested) {
      lines.push(
        `- Suggested price: ${formatUsd(suggested.price)}${suggested.capped ? " (held down by the new-price ceiling)" : ""}`,
      );
      lines.push(
        market.tier === "full"
          ? `- Condition against the listings: ${appraisal.position} (below = worse than the typical listing, above = better). Evidence: ${appraisal.positionEvidence || "none given"}`
          : "- The suggested price is the plain median: with so few listings there is no condition adjustment.",
      );
    }
  }

  if (appraisal.platforms.length > 0) {
    if (market.tier === "none") {
      // A "median" of one or two listings is exactly the number this branch
      // exists to withhold, so only the names go through.
      lines.push(
        "",
        `Platforms where listings turned up: ${appraisal.platforms.map((p) => p.platform).join(", ")}.`,
      );
    } else {
      lines.push("", "By platform (median of counted listings):");
      for (const p of appraisal.platforms) {
        lines.push(`- ${p.platform}: ${formatUsd(p.median)} across ${p.count}`);
      }
    }
  }

  lines.push(
    "",
    "Use these figures and no others. Do not recompute, round differently, or restate a price that is not in this list.",
  );
  return lines.join("\n");
}
