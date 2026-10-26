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
 * Deliberately free of `server-only`: the browser computes these figures from the
 * listings the market route returns, the chat route recomputes them from the raw
 * listings the browser posts back, and both sides need the code and the types.
 */
import { z } from "zod";
import {
  LISTING_CONDITIONS,
  priceAppearsIn,
  type ExtractedNewPrice,
  type GroundedListing,
  type Source,
} from "./sources";
import { DEFAULT_VND_PER_USD, vndAmounts, vndToUsd } from "./currency";
import { itemFactsSchema, type ItemCategory, type ItemFacts } from "./item";

/** A market needs this many listings before it gets a range and an adjustment. */
export const FULL_MIN = 5;
/**
 * Below this a market has no median. One or two listings are averaged instead
 * (`mean`), and with none at all the price is estimated by straight-line
 * depreciation of what they paid.
 */
export const THIN_MIN = 3;
/**
 * Years each kind of item is written off over in the depreciation estimate. The
 * model only says which kind it is (`category`); the years are the app's.
 */
export const USEFUL_LIFE_YEARS: Record<ItemCategory, number> = {
  phone_tablet: 3,
  computer: 5,
  other: 5,
};
/** The share of what they paid that is left when the useful life is over. */
export const SALVAGE_FRACTION = 0.1;
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
  /[£€¥₹₩₱฿₪₺₽]|\b(?:EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|MXN|CHF|SEK|NOK|DKK|PLN|BRL|SGD|HKD|KRW)\b|\b(?:C|CA|AU|A|NZ|MX|HK|S|R)\s?\$/;

const USD_AMOUNT =
  /(?:US\s?)?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\bUSD\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;

/**
 * Reads a price off the text a page showed, in US dollars, or null.
 *
 * Done here rather than asked of the model because "US $1,049.99" is exactly the
 * kind of string a model silently turns into 1049 or 104999. Null covers every
 * case where the honest answer is "not a single amount": another currency, a
 * range, a price with a second price beside it, free, or nothing parseable.
 *
 * Dollars and đồng are both read ("5.500.000 ₫", "5,5 triệu", "5.5tr"), the
 * latter converted at `vndPerUsd`. A text with both is two prices, so it is null.
 */
export function parsePriceText(
  text: string,
  vndPerUsd: number = DEFAULT_VND_PER_USD,
): number | null {
  const dong = vndAmounts(text);
  if (dong.length > 0) {
    if (OTHER_CURRENCY.test(text) || /\$\s?\d|\bUSD\b/i.test(text)) return null;
    if (dong.length > 1) {
      const between = text.slice(dong[0].end, dong[1].index);
      if (!/\+|ship|giao|vận chuyển|phí|deliver|fee/i.test(between)) return null;
    }
    return vndToUsd(dong[0].vnd, vndPerUsd);
  }

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
  vndPerUsd: number = DEFAULT_VND_PER_USD,
): { price: number; url: string } | null {
  if (!claim) return null;
  const source = sources[claim.sourceIndex];
  if (!source || !priceAppearsIn(source.text, claim.priceText)) return null;
  const price = parsePriceText(claim.priceText, vndPerUsd);
  return price === null ? null : { price, url: source.url };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("mean() needs at least one value");
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

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

/** The workings of a straight-line depreciation, so the person can follow the number. */
export type Depreciation = {
  /** What they paid, USD. */
  cost: number;
  /** What is left of it at the end of the useful life. */
  salvage: number;
  lifeMonths: number;
  /** Months used, as they said it. Past the useful life it stops counting. */
  ageMonths: number;
  /** cost − (cost − salvage) ÷ lifeMonths × months used. */
  value: number;
};

/**
 * Straight-line depreciation: the same amount comes off every month, from what
 * they paid down to the salvage value over the useful life, and stops there.
 * Null when what they paid or how long they used it is not known, because a price
 * guessed for either would be the model's, not the app's.
 *
 * Months of use stand in for months since purchase, which the conversation does not
 * ask for separately.
 */
export function straightLineValue(
  item: Pick<ItemFacts, "purchasePrice" | "ageMonths" | "category">,
): Depreciation | null {
  const { purchasePrice: cost, ageMonths } = item;
  if (cost === null || cost <= 0 || ageMonths === null) return null;

  const lifeMonths = USEFUL_LIFE_YEARS[item.category] * 12;
  const salvage = round2(cost * SALVAGE_FRACTION);
  const used = Math.min(ageMonths, lifeMonths);
  return {
    cost,
    salvage,
    lifeMonths,
    ageMonths: used,
    value: round2(cost - ((cost - salvage) / lifeMonths) * used),
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
  vndPerUsd: number,
): Array<GroundedListing & { price: number }> {
  const seen = new Set<string>();
  const kept: Array<GroundedListing & { price: number }> = [];

  for (const listing of listings) {
    const price = parsePriceText(listing.priceText, vndPerUsd);
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
  /** The rate listings in đồng were converted at, so server and browser agree on every figure. */
  vndPerUsd: z.number().positive().max(1_000_000).default(DEFAULT_VND_PER_USD),
});

export type AppraisalInput = z.output<typeof appraisalInputSchema>;

/**
 * full: five or more listings. thin: three or four. sparse: one or two, averaged.
 * estimate: none, so depreciated from what they paid. none: nothing to go on.
 */
export type Tier = "full" | "thin" | "sparse" | "estimate" | "none";

/** How `Market.median` was arrived at. */
export type MarketMethod = "median" | "mean" | "depreciation";

export type Market = {
  tier: Tier;
  method: MarketMethod | null;
  /** "sold" only when five or more sold listings carried the median. Null for an estimate. */
  basis: "sold" | "asking" | null;
  /** Asking prices overstate what things sell for; say so when they are used. */
  askingRunHigh: boolean;
  /** Listings counted. Zero for an estimate. */
  count: number;
  /**
   * The market price the figures are set against. Named for the usual case: it is
   * the mean when `method` is "mean" and the depreciated value when it is
   * "depreciation".
   */
  median: number | null;
  /** The workings, only for an estimate. */
  depreciation: Depreciation | null;
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
 * range and a condition adjustment; three or four earns a median and a flag; one
 * or two are averaged and flagged; and with none, what they paid is depreciated
 * in a straight line (`straightLineValue`). Only when even that cannot be worked
 * out is there no price.
 */
export function computeAppraisal(
  input: Pick<AppraisalInput, "listings" | "newPrice" | "position" | "positionEvidence"> & {
    /** What the depreciation estimate needs, for when there are no listings. */
    item?: Pick<ItemFacts, "purchasePrice" | "ageMonths" | "category">;
    newPriceUrl?: string | null;
    vndPerUsd?: number;
  },
  asking: number,
): Appraisal {
  const newPrice = input.newPrice ?? null;
  const screened = screen(input.listings, newPrice, input.vndPerUsd ?? DEFAULT_VND_PER_USD);

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

  const depreciation =
    used.length === 0 && input.item ? straightLineValue(input.item) : null;

  const tier: Tier =
    used.length >= FULL_MIN
      ? "full"
      : used.length >= THIN_MIN
        ? "thin"
        : used.length > 0
          ? "sparse"
          : depreciation
            ? "estimate"
            : "none";

  const method: Market["method"] =
    tier === "full" || tier === "thin"
      ? "median"
      : tier === "sparse"
        ? "mean"
        : tier === "estimate"
          ? "depreciation"
          : null;

  const basis: Market["basis"] =
    used.length === 0 ? null : soldCarries || used.every((l) => l.kind === "sold") ? "sold" : "asking";

  const marketMedian =
    method === "median"
      ? median(prices)
      : method === "mean"
        ? mean(prices)
        : (depreciation?.value ?? null);
  const range = tier === "full" ? quartiles(prices) : null;

  const market: Market = {
    tier,
    method,
    basis,
    askingRunHigh: basis === "asking",
    count: used.length,
    median: marketMedian,
    depreciation,
    q1: range?.q1 ?? null,
    q3: range?.q3 ?? null,
  };

  const ceilingFromNew = newPrice === null ? undefined : newPrice * NEW_PRICE_CEILING;

  let suggested: Suggested | null = null;
  if (marketMedian !== null) {
    // Only a full market has quartiles to adjust along; every other one stays on
    // its single figure, whatever the position says. Where it does adjust, P75 is also the
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

/** The market card's data: the figures, plus what they came from. Built in the browser from the market steps. */
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
const PRICE_NAME: Record<MarketMethod, string> = {
  median: "market median",
  mean: "market average",
  depreciation: "depreciated value",
};

export function marketHeadline({
  asking,
  gap: gapToMarket,
  item,
  market,
}: Pick<Appraisal, "asking" | "gap"> & {
  item: Pick<ItemFacts, "model">;
  market?: Pick<Market, "method">;
}): string {
  const name = PRICE_NAME[market?.method ?? "median"];
  if (gapToMarket === null) {
    return `Too few verified listings to price your ${item.model || "item"}`;
  }
  // Under half a percent rounds to "0%", which would read as a gap that is not
  // there; say what it is instead.
  if (Math.abs(gapToMarket.pct) < 0.005) {
    return `Your ${formatUsd(asking)} is right at the ${name}`;
  }
  const size = formatPct(gapToMarket.pct).replace(/^[+−]/, "");
  return `Your ${formatUsd(asking)} is ${size} ${gapToMarket.pct > 0 ? "above" : "below"} the ${name}`;
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
      `Only ${market.count} usable listing${market.count === 1 ? "" : "s"} could be verified, and there is not enough about what they paid and how long they used it to estimate a price by depreciation. That is not enough to state a market price.`,
      "",
      "Do not give a price, a range or a comparison to theirs. Instead explain how they should price this themselves: check recently sold listings of the exact model on the platforms below, price against what has sold rather than what is listed, and adjust for the condition you saw in the photos.",
    );
  } else if (market.tier === "estimate") {
    const d = market.depreciation!;
    lines.push(
      "- No listings could be verified, so there is no market evidence. The app estimated the price by straight-line depreciation instead.",
      `- They paid ${formatUsd(d.cost)} and used it for ${d.ageMonths} months. It is written off evenly over ${d.lifeMonths / 12} years down to ${formatUsd(d.salvage)}.`,
      `- Estimated value: ${formatUsd(market.median!)}`,
      "- Say plainly that this is an accounting estimate from what they paid and how long they have used it, not what buyers are paying, and that it ignores demand, condition and new models. There are no per-platform figures: in \"Where to sell\" say you have no platform data and name no platform. Do not mention listings, and keep the tone tentative.",
    );
    if (appraisal.newPrice !== null) {
      lines.push(`- New price, as a ceiling only: ${formatUsd(appraisal.newPrice)}`);
    }
    lines.push(
      `- Their locked price: ${formatUsd(appraisal.asking)} (${formatPct(gapToMarket!.pct)} against the estimate)`,
      `- overpriced: ${appraisal.overpriced ? "true" : "false"}`,
    );
    if (suggested) {
      lines.push(
        `- Suggested price: ${formatUsd(suggested.price)}${suggested.capped ? " (held down by the new-price ceiling)" : ""}`,
        "- The suggested price is the plain estimate, with no adjustment for condition. Tell them to check recently sold listings of the exact model before they list.",
      );
    }
  } else {
    lines.push(
      `- Listings counted: ${market.count} (${market.basis === "sold" ? "sold listings" : "asking prices"})`,
      market.tier === "sparse"
        ? `- Market average: ${formatUsd(market.median!)}`
        : `- Market median: ${formatUsd(market.median!)}`,
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
    if (market.tier === "sparse") {
      lines.push(
        `- Only ${market.count === 1 ? "one listing was" : "two listings were"} found, so the price is their average and not a median. Say plainly that it rests on very little evidence and keep the tone tentative.`,
      );
    }
    if (appraisal.newPrice !== null) {
      lines.push(`- New price, as a ceiling only: ${formatUsd(appraisal.newPrice)}`);
    }
    lines.push(
      `- Their locked price: ${formatUsd(appraisal.asking)} (${formatPct(gapToMarket!.pct)} against the ${market.tier === "sparse" ? "average" : "median"})`,
      `- overpriced: ${appraisal.overpriced ? "true" : "false"}`,
    );
    if (suggested) {
      lines.push(
        `- Suggested price: ${formatUsd(suggested.price)}${suggested.capped ? " (held down by the new-price ceiling)" : ""}`,
      );
      lines.push(
        market.tier === "full"
          ? `- Condition against the listings: ${appraisal.position} (below = worse than the typical listing, above = better). Evidence: ${appraisal.positionEvidence || "none given"}`
          : `- The suggested price is the plain ${market.tier === "sparse" ? "average" : "median"}: with so few listings there is no condition adjustment.`,
      );
    }
  }

  // Only a market with counted listings has platforms: an estimate or no price
  // has none to name.
  if (appraisal.platforms.length > 0) {
    lines.push(
      "",
      `By platform (${market.tier === "sparse" ? "average" : "median"} of counted listings):`,
    );
    for (const p of appraisal.platforms) {
      lines.push(`- ${p.platform}: ${formatUsd(p.median)} across ${p.count}`);
    }
  }

  lines.push(
    "",
    "Use these figures and no others. Do not recompute, round differently, or restate a price that is not in this list.",
  );
  return lines.join("\n");
}
