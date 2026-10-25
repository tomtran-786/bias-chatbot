/**
 * Vietnamese đồng: reading an amount off a page and converting it to US dollars.
 *
 * Pure and free of `server-only`: the price parser (lib/pricing.ts) runs in the
 * browser as well as on the server, and the scrubber that keeps a purchase price
 * out of a search (lib/item.ts) needs the same patterns.
 *
 * The rate is a fixed number, not a live one. Listings are a rough guide to a
 * market, so a rate that is a few percent stale is well inside their own spread,
 * and a live rate would be one more service that can fail or start charging. It is
 * configurable (VND_PER_USD) and travels with the listings (`AppraisalInput.
 * vndPerUsd`), so the server and the browser always convert with the same number.
 */

/** About right when this was written; override with VND_PER_USD. */
export const DEFAULT_VND_PER_USD = 26_000;

const UNIT = {
  tỷ: 1_000_000_000,
  ty: 1_000_000_000,
  triệu: 1_000_000,
  tr: 1_000_000,
  củ: 1_000_000,
} as const;

/** "5.500.000", "5,500,000" or "5500000": a whole number of đồng, with thousands separators. */
const GROUPED = String.raw`\d{1,3}(?:[.,]\d{3})+|\d+`;

/**
 * "5,5 triệu", "5.5tr", "15 củ", "1,2 tỷ", and the spoken "5tr5" (5.5 million).
 * The unit must end the word, so "5 trong" is not "5 triệu".
 */
const SHORTHAND = new RegExp(
  String.raw`(\d+(?:[.,]\d+)?)\s?(tỷ|ty|triệu|tr|củ)(\d{1,3})?(?![\p{L}\d])`,
  "giu",
);

/** "5.500.000 ₫", "5.500.000đ", "5,500,000 VND", "₫5.500.000", "VND 5500000". */
const PLAIN = new RegExp(
  String.raw`(?:(?:₫|\bvn[dđ])\s?(${GROUPED})(?![.,]?\d)|(${GROUPED})\s?(?:₫|đ|\bvn[dđ]|đồng)(?![\p{L}\d]))`,
  "giu",
);

type Found = { index: number; end: number; vnd: number };

/** Every VND amount in `text`, in the order it appears. */
export function vndAmounts(text: string): Found[] {
  const found: Found[] = [];

  for (const match of text.matchAll(SHORTHAND)) {
    const [whole, number, unit, tail] = match;
    const base = Number(number.replace(",", "."));
    const scale = UNIT[unit.toLowerCase() as keyof typeof UNIT];
    // "5tr5" is 5.5 million, "5tr550" is 5.55 million; ignored beside a decimal.
    const spoken = tail && !/[.,]/.test(number) ? Number(`0.${tail}`) : 0;
    const vnd = Math.round((base + spoken) * scale);
    if (Number.isFinite(vnd) && vnd > 0) {
      found.push({ index: match.index ?? 0, end: (match.index ?? 0) + whole.length, vnd });
    }
  }

  for (const match of text.matchAll(PLAIN)) {
    const digits = (match[1] ?? match[2]).replace(/[.,]/g, "");
    const vnd = Number(digits);
    if (Number.isFinite(vnd) && vnd > 0) {
      found.push({ index: match.index ?? 0, end: (match.index ?? 0) + match[0].length, vnd });
    }
  }

  return found.sort((a, b) => a.index - b.index);
}

/** Whether `text` is priced in đồng at all, even if it cannot be read as one amount. */
export function isVndText(text: string): boolean {
  return vndAmounts(text).length > 0 || /₫|\bvn[dđ]\b|đồng/iu.test(text);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function vndToUsd(vnd: number, vndPerUsd: number): number | null {
  const usd = round2(vnd / vndPerUsd);
  return usd > 0 ? usd : null;
}

/** "5.500.000 ₫" for a whole number of đồng. */
export function formatVnd(vnd: number): string {
  return `${Math.round(vnd).toLocaleString("de-DE")} ₫`;
}

/** Strips every đồng amount from free text; used to keep a purchase price out of a search. */
export function scrubVnd(text: string): string {
  let out = text;
  for (const { index, end } of vndAmounts(text).sort((a, b) => b.index - a.index)) {
    out = out.slice(0, index) + out.slice(end);
  }
  return out;
}
