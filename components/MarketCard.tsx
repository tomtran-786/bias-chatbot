"use client";

import { useEffect, useState } from "react";
import {
  citeListings,
  conversionNote,
  hostLabel,
  originalPrice,
  safeHref,
  type CitedListing,
  type CitedPlatform,
} from "@/lib/citations";
import {
  NEW_PRICE_CEILING,
  OVERPRICED_AT,
  SALVAGE_FRACTION,
  basisPhrase,
  depreciationUse,
  formatUsd,
  formatUsdWhole,
  marketHeadline,
  priceName,
  marketOnlyHeadline,
  type AppraiseResponse,
  type MarketResponse,
} from "@/lib/pricing";

/**
 * True a moment after the card appears. The card can show up under the pointer
 * that caused it, and a second click of a double-click would otherwise press its
 * button before anything was read.
 */
function useSettled(): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), 800);
    return () => clearTimeout(timer);
  }, []);
  return settled;
}

/**
 * The market, laid out for one decision: what are people paying for this?
 *
 * Two cards tell it in two moments. `MarketCard` comes first, before the person has
 * named a price, and is all the evidence: the market's figure, where the listings
 * sit, the suggested price and the sources it stands on. `ComparisonCard` comes
 * after they have named one, and sets the two side by side without repeating the
 * evidence.
 *
 * One story, told top to bottom. The title is the takeaway ("Market median for your
 * iPad Air: $410", then "Your $520 is 24% above the market median"), and everything
 * under it is the evidence for it.
 *
 * The forms follow from what each piece of data has to do. Two numbers the
 * reader compares — their price and the market median — are a pair of large
 * figures, not a chart. The spread of listings is a strip of dots on one shared
 * price axis, because the question is "where does my price sit among them", and
 * a strip answers that with position alone. It uses the emphasis form: every
 * listing is the same neutral grey, and the one accent is their own price,
 * the thing the story is about. Before they have named one the strip carries the
 * median alone. There are no gridlines and no legend: the lines that matter are
 * labelled where they are, and one caption says the rest.
 *
 * Every price that came from the web is a numbered, clickable source. The same
 * `[n]` marks the dot, the row below and the verdict's sources line
 * (lib/citations.ts). Colour never carries meaning alone, and every value the
 * strip's hover would show is also in the rows below it, so there is no
 * information only a pointer can reach.
 */

export function MarketCard({
  market: view,
  canContinue,
  onContinue,
}: {
  market: MarketResponse;
  canContinue: boolean;
  onContinue: () => void;
}) {
  const { market, suggested } = view;
  const citations = citeListings(view);
  const settled = useSettled();

  return (
    <article className="rise overflow-hidden rounded-3xl bg-surface shadow-soft">
      <header className="flex flex-col gap-1.5 border-b border-rule px-5 py-5 sm:px-6">
        <h2 className="text-lg leading-snug font-semibold tracking-tight text-pretty">
          {marketOnlyHeadline(view)}
        </h2>
        <p className="text-sm leading-relaxed text-ink-secondary">{subtitle(view)}</p>
      </header>

      <div className="border-b border-rule bg-surface">
        <Figure
          label={marketLabel(market.method)}
          keyColor="var(--ink)"
          value={market.median === null ? "—" : formatUsd(market.median)}
          note={rangeNote(market)}
        />
      </div>

      {market.count > 0 ? (
        <Strip view={view} asking={null} counted={citations.counted} />
      ) : null}

      {suggested ? (
        <Suggestion view={view} countedCount={citations.counted.length} />
      ) : null}

      {citations.counted.length > 0 ? (
        <section id="sources" className="scroll-mt-4 border-b border-rule px-5 py-4 sm:px-6">
          <h3 className="text-sm font-medium">Sources</h3>
          {citations.platforms
            .filter((platform) => platform.listings.length > 0)
            .map((platform) => (
              <PlatformGroup
                key={platform.platform}
                platform={platform}
                showMedian={market.method === "median"}
              />
            ))}
        </section>
      ) : null}

      {citations.unverified.length > 0 ? (
        <details className="border-b border-rule px-5 py-3.5 sm:px-6">
          <summary className="cursor-pointer text-sm text-ink-secondary">
            {citations.unverified.length === 1
              ? "1 more price couldn’t be confirmed on its page"
              : `${citations.unverified.length} more prices couldn’t be confirmed on their page`}
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">
            These prices didn’t appear in the text of the page they were found on,
            so they are not part of the price.
          </p>
          <ul className="mt-1 flex flex-col opacity-60">
            {citations.unverified.map((cited) => (
              <li key={cited.n}>
                <SourceRow cited={cited} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <footer className="flex flex-col gap-3 bg-sunken px-5 py-5 sm:px-6">
        <p className="text-xs leading-relaxed text-ink-secondary">
          {market.tier === "estimate"
            ? "No listings could be confirmed, so this is calculated from what you paid, not seen in the market."
            : "Prices from public listings found by web search. Asking and sold prices, not offers you’ll receive."}
          {conversionNote(view) ? ` ${conversionNote(view)}` : ""}
        </p>
        <details>
          <summary className="cursor-pointer text-xs font-medium text-ink-secondary">
            How this was worked out
          </summary>
          <div className="mt-2 flex flex-col gap-3 text-xs leading-relaxed text-ink-muted">
            {view.queries.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="font-medium text-ink-secondary">Searched for</p>
                <ul className="flex flex-col gap-0.5">
                  {view.queries.map((query) => (
                    <li key={query}>“{query}”</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {market.depreciation ? (
              <p>
                With no listings to go on, the app takes the same amount off every
                month, from what you paid down to {Math.round(SALVAGE_FRACTION * 100)}% of it
                over {market.depreciation.lifeMonths / 12} years, and counts the months you
                have used it. That is straight-line depreciation: it knows nothing about
                demand, condition or newer models.
              </p>
            ) : null}
            <p>
              An AI reads the search results and reports each listing. A price counts
              only if it appears word for word in the text of the page it came from.
              The median uses sold prices alone when there are five or more, otherwise
              every listing found, sold or still for sale; with one or two listings the
              price is their average. The
              app works out every figure itself. A search can miss listings or pick up
              the wrong model.
            </p>
          </div>
        </details>
        {canContinue ? (
          <button
            type="button"
            onClick={onContinue}
            disabled={!settled}
            className="btn-primary mt-1 self-start px-6 py-3 text-sm font-medium"
          >
            Set my price
          </button>
        ) : null}
      </footer>
    </article>
  );
}

/**
 * Their price against the market, once they have named one. The evidence is the
 * card above; this is only the comparison and the way on to the verdict.
 */
export function ComparisonCard({
  appraisal,
  canContinue,
  pending,
  onContinue,
}: {
  appraisal: AppraiseResponse;
  canContinue: boolean;
  pending: boolean;
  onContinue: () => void;
}) {
  const { market } = appraisal;
  const citations = citeListings(appraisal);
  const settled = useSettled();

  return (
    <article className="rise overflow-hidden rounded-3xl bg-surface shadow-soft">
      <header className="flex flex-col gap-1.5 border-b border-rule px-5 py-5 sm:px-6">
        <h2 className="text-lg leading-snug font-semibold tracking-tight text-pretty">
          {marketHeadline(appraisal)}
        </h2>
        {appraisal.overpriced ? (
          <p className="text-sm leading-relaxed text-ink-secondary">
            {`${Math.round(OVERPRICED_AT * 100)}% or more above the ${priceName(market.method)} counts as running high.`}
          </p>
        ) : null}
      </header>

      <PricePair appraisal={appraisal} />

      {market.count > 0 ? (
        <Strip view={appraisal} asking={appraisal.asking} counted={citations.counted} />
      ) : null}

      {canContinue ? (
        <footer className="bg-sunken px-5 py-5 sm:px-6">
          <button
            type="button"
            onClick={onContinue}
            disabled={pending || !settled}
            className="btn-primary self-start px-6 py-3 text-sm font-medium"
          >
            {pending ? "Thinking…" : "See my verdict"}
          </button>
        </footer>
      ) : null}
    </article>
  );
}

/** What the figure in the title was made of. The title already names the model. */
function subtitle(a: MarketResponse): string {
  const { market } = a;
  if (market.tier === "none") {
    const found =
      a.listings.length === 0
        ? "No listings were found"
        : `Found ${a.listings.length} listing${a.listings.length === 1 ? "" : "s"}, but none could be verified`;
    return `${found}, and there is not enough about what you paid and how long you used it to estimate a price.`;
  }
  if (market.depreciation) {
    const d = market.depreciation;
    return `No listings could be verified, so this is an estimate: ${formatUsd(d.cost)} paid, written off evenly over ${d.lifeMonths / 12} years, used for ${depreciationUse(d)}.`;
  }
  const what =
    market.basis === "sold"
      ? `${market.count} sold listing${market.count === 1 ? "" : "s"}`
      : `${market.count} listing${market.count === 1 ? "" : "s"} (${basisPhrase(market)})`;
  const caveats = [
    market.askingRunHigh ? "Listings still for sale ask more than things sell for." : null,
    market.tier === "thin" ? "Only a few listings, so treat this as a rough guide." : null,
    market.tier === "sparse" ? "Very few listings, so treat this as a rough guide." : null,
  ].filter(Boolean);
  return [`${market.tier === "sparse" ? "Average" : "Median"} of ${what}.`, ...caveats].join(" ");
}

/** Why the suggestion sits where it does. The new-price cap is added by the caller, as a link. */
function suggestionNote(a: MarketResponse): string {
  const { suggested, market } = a;
  if (!suggested) return "";
  const parts: string[] = [];
  if (market.tier === "estimate") {
    parts.push(
      "The depreciated value, with no adjustment for condition. Check recently sold listings of the same model before you list.",
    );
  } else if (market.tier === "sparse") {
    parts.push("The average of the one or two listings found, with no adjustment for condition.");
  } else if (market.tier === "thin") {
    parts.push("The median of the few listings found, with no adjustment for condition.");
  } else {
    const where =
      suggested.anchor === "p25"
        ? "toward the low end of the middle half, because your item reads as worse than a typical listing"
        : suggested.anchor === "p75"
          ? "toward the high end of the middle half, because your item reads as better than a typical listing"
          : "at the median, because your item reads as typical";
    parts.push(`Sits ${where}.`);
    if (a.positionEvidence) {
      const evidence = a.positionEvidence.trim().replace(/\.?$/, ".");
      parts.push(evidence.charAt(0).toUpperCase() + evidence.slice(1));
    }
  }
  return parts.join(" ");
}

const linkClass =
  "underline decoration-rule-strong underline-offset-4 transition-colors hover:decoration-ink";

function Suggestion({
  view,
  countedCount,
}: {
  view: MarketResponse;
  countedCount: number;
}) {
  const { suggested, newPrice } = view;
  if (!suggested) return null;

  const newHref = safeHref(view.newPriceUrl);
  const newHost = hostLabel(newHref);

  return (
    <section className="flex flex-col gap-1.5 border-b border-rule px-5 py-5 sm:px-6">
      <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
        Suggested price
      </p>
      <p className="text-3xl font-semibold tracking-tight">{formatUsd(suggested.price)}</p>
      <p className="text-sm leading-relaxed text-ink-secondary">
        {suggestionNote(view)}
        {suggested.capped && newPrice !== null ? (
          <>
            {" "}
            Held below {Math.round(NEW_PRICE_CEILING * 100)}% of the new price (
            {newHref ? (
              <a href={newHref} target="_blank" rel="noopener noreferrer" className={linkClass}>
                {formatUsd(newPrice)}
                {newHost ? ` · ${newHost}` : ""} ↗
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              formatUsd(newPrice)
            )}
            ).
          </>
        ) : null}
      </p>
      {countedCount > 0 ? (
        <p className="text-xs text-ink-muted">
          <a href="#sources" className={linkClass}>
            From listings {countedCount === 1 ? "[1]" : `[1]–[${countedCount}]`}
          </a>
        </p>
      ) : null}
    </section>
  );
}

function PricePair({ appraisal }: { appraisal: AppraiseResponse }) {
  const { market } = appraisal;
  return (
    <div className="grid grid-cols-2 gap-px border-b border-rule bg-rule">
      <Figure
        label="Your price"
        keyColor="var(--accent)"
        value={formatUsd(appraisal.asking)}
        note="Locked in after seeing the market"
      />
      <Figure
        label={marketLabel(market.method)}
        keyColor="var(--ink)"
        value={market.median === null ? "—" : formatUsd(market.median)}
        note={rangeNote(market)}
      />
    </div>
  );
}

function marketLabel(method: MarketResponse["market"]["method"]): string {
  return method === "mean"
    ? "Market average"
    : method === "depreciation"
      ? "Estimated value"
      : "Market median";
}

/** What stands behind the market's figure, in a few words. */
function rangeNote(market: MarketResponse["market"]): string {
  return market.q1 !== null && market.q3 !== null
    ? `Middle half: ${formatUsdWhole(market.q1)}–${formatUsdWhole(market.q3)}`
    : market.tier === "thin" || market.tier === "sparse"
      ? `${market.count} listing${market.count === 1 ? "" : "s"}`
      : market.tier === "estimate"
        ? "Straight-line depreciation"
        : "Not enough to price";
}

function Figure({
  label,
  keyColor,
  value,
  note,
}: {
  label: string;
  keyColor: string;
  value: string;
  note: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 bg-surface px-5 py-5 sm:px-6">
      <p className="flex items-center gap-2 text-sm text-ink-secondary">
        <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: keyColor }} />
        {label}
      </p>
      {/* Proportional figures: tabular digits look loose at this size. */}
      <p className="text-4xl leading-none font-semibold tracking-tight sm:text-5xl">{value}</p>
      <p className="text-xs text-ink-muted">{note}</p>
    </div>
  );
}

/**
 * Round tick values spanning [lo, hi]: the finest round step that still gives no
 * more than four, so the axis stays quiet but never shrinks to a lone label.
 */
function niceTicks(lo: number, hi: number): number[] {
  const magnitude = 10 ** Math.floor(Math.log10((hi - lo) / 4));
  const steps = [0.1, 1, 10].flatMap((scale) =>
    [1, 2, 2.5, 5].map((m) => m * magnitude * scale),
  );
  for (const step of steps) {
    const ticks: number[] = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
      ticks.push(Math.round(t * 100) / 100);
    }
    if (ticks.length <= 4) return ticks;
  }
  return [];
}

/**
 * Which way a label hangs from its marker, so neighbours do not overprint.
 * When the two markers sit on the same spot, `leftIfEqual` decides which label
 * takes the left side; without it both would pick the same side.
 */
function anchorFor(
  x: number,
  other: number,
  leftIfEqual: boolean,
): "start" | "center" | "end" {
  if (Math.abs(x - other) < 26) {
    return x < other || (x === other && leftIfEqual) ? "end" : "start";
  }
  if (x < 14) return "start";
  if (x > 86) return "end";
  return "center";
}

/** Which way a label hangs when it has no neighbour: toward the middle, away from the edge. */
function anchorAlone(x: number): "start" | "center" | "end" {
  if (x < 14) return "start";
  if (x > 86) return "end";
  return "center";
}

const ANCHOR_SHIFT = { start: "0%", center: "-50%", end: "-100%" } as const;

const DOT = 10; // px, the visible dot
const HIT = 24; // px, the target around it
const ROW = 20; // px between stacked dots

function Strip({
  view,
  asking,
  counted,
}: {
  view: MarketResponse;
  /** Their price, once they have named one. Before that the strip has no line of theirs. */
  asking: number | null;
  counted: CitedListing[];
}) {
  const [active, setActive] = useState<number | null>(null);
  const { market } = view;
  const median = market.median!;

  const values = [
    ...counted.map((c) => c.listing.price),
    ...(asking === null ? [] : [asking]),
  ];
  const lo0 = Math.min(...values);
  const hi0 = Math.max(...values);
  const pad = (hi0 - lo0) * 0.08 || hi0 * 0.1;
  const lo = Math.max(0, lo0 - pad);
  const hi = hi0 + pad;
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100;

  // Stack dots that would overlap into rows, in price order.
  const rows: number[] = [];
  const placed = [...counted]
    .sort((a, b) => a.listing.price - b.listing.price)
    .map((cited) => {
      const at = x(cited.listing.price);
      let row = rows.findIndex((last) => at - last >= 3.4);
      if (row === -1) row = rows.length;
      rows[row] = at;
      return { cited, at, row };
    });
  const height = Math.max(rows.length, 1) * ROW + 16;

  const xMedian = x(median);
  const xAsking = asking === null ? null : x(asking);
  const ticks = niceTicks(lo, hi);
  const hovered = active === null ? null : placed[active];
  const hasLinks = counted.some((c) => c.href !== null);

  return (
    <section
      className="flex flex-col gap-3 border-b border-rule px-5 py-5 sm:px-6"
      aria-label={asking === null ? "Where the listings sit" : "Where your price sits among the listings"}
    >
      {/* Direct labels for the two markers that matter, above the plot. */}
      <div className="relative h-5 text-xs font-medium">
        <span
          className="absolute whitespace-nowrap"
          style={{
            left: `${xMedian}%`,
            transform: `translateX(${ANCHOR_SHIFT[xAsking === null ? anchorAlone(xMedian) : anchorFor(xMedian, xAsking, true)]})`,
          }}
        >
          {market.method === "mean" ? "Average" : "Median"} {formatUsd(median)}
        </span>
        {xAsking !== null && asking !== null ? (
          <span
            className="absolute whitespace-nowrap"
            style={{ left: `${xAsking}%`, transform: `translateX(${ANCHOR_SHIFT[anchorFor(xAsking, xMedian, false)]})`, top: 0 }}
          >
            {/* Two labels may share a row; the anchor rule keeps them apart. */}
            Yours {formatUsd(asking)}
          </span>
        ) : null}
      </div>

      <div className="relative" style={{ height }}>
        {/* The middle half of the listings, as a wash. No gridlines: the axis below carries the values. */}
        {market.q1 !== null && market.q3 !== null ? (
          <span
            aria-hidden
            className="absolute top-0 bottom-0 bg-track/60"
            style={{ left: `${x(market.q1)}%`, width: `${x(market.q3) - x(market.q1)}%` }}
          />
        ) : null}

        <span aria-hidden className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${xMedian}%` }} />
        {xAsking !== null ? (
          <span aria-hidden className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-accent" style={{ left: `${xAsking}%` }} />
        ) : null}

        {placed.map(({ cited, at, row }, index) => {
          const { listing, href, n } = cited;
          const label = `[${n}] ${originalPrice(listing) ? "about " : ""}${formatUsd(listing.price)}, ${listing.platform}, ${listing.kind === "sold" ? "sold" : "asking price"}`;
          const style = {
            left: `${at}%`,
            top: 8 + row * ROW + DOT / 2,
            width: HIT,
            height: HIT,
          };
          const common = {
            className:
              "absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ink",
            style,
            onPointerEnter: () => setActive(index),
            onPointerLeave: () => setActive((current) => (current === index ? null : current)),
            onFocus: () => setActive(index),
            onBlur: () => setActive((current) => (current === index ? null : current)),
            "aria-label": label,
          };
          const dot = (
            <span
              aria-hidden
              className="rounded-full bg-mark-muted"
              style={{
                width: DOT,
                height: DOT,
                // The 2px ring in the surface colour is what keeps overlapping
                // dots and the lines they cross legible.
                boxShadow: `0 0 0 2px var(--surface)${active === index ? ", 0 0 0 4px var(--ink)" : ""}`,
              }}
            />
          );
          return href ? (
            <a key={n} href={href} target="_blank" rel="noopener noreferrer" {...common}>
              {dot}
            </a>
          ) : (
            <span key={n} tabIndex={0} role="img" {...common}>
              {dot}
            </span>
          );
        })}

        {hovered ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-xl bg-surface px-3 py-2 text-xs shadow-soft whitespace-nowrap"
            style={{ left: `${Math.min(Math.max(hovered.at, 22), 78)}%`, top: 8 + hovered.row * ROW - 6 }}
          >
            <span className="nums font-semibold">
              [{hovered.cited.n}] {originalPrice(hovered.cited.listing) ? "≈ " : ""}
              {formatUsd(hovered.cited.listing.price)}
            </span>
            <span className="text-ink-secondary">
              {" "}
              · {hovered.cited.listing.platform} ·{" "}
              {hovered.cited.listing.kind === "sold" ? "Sold" : "Asking"}
            </span>
          </div>
        ) : null}
      </div>

      {/* The axis: a few muted values, since nothing in the plot is labelled with one. */}
      <div className="relative h-4 border-t border-rule-strong text-[11px] text-ink-muted" aria-hidden>
        {ticks.map((t) => (
          <span key={t} className="nums absolute top-1 -translate-x-1/2" style={{ left: `${x(t)}%` }}>
            {formatUsd(t)}
          </span>
        ))}
      </div>

      <p className="text-xs leading-relaxed text-ink-secondary">
        Each dot is one listing{hasLinks ? " — select it to open the source" : ""}.
        {market.q1 !== null && market.q3 !== null
          ? ` Shaded: middle half (${formatUsdWhole(market.q1)}–${formatUsdWhole(market.q3)}).`
          : ""}
      </p>
    </section>
  );
}

function PlatformGroup({
  platform,
  showMedian,
}: {
  platform: CitedPlatform;
  /** A median of one or two listings is not shown: the market price there is their average. */
  showMedian: boolean;
}) {
  const count = `${platform.count} listing${platform.count === 1 ? "" : "s"}`;
  return (
    <div className="mt-3 first-of-type:mt-2">
      <p className="nums text-sm">
        <span className="font-medium">{platform.platform}</span>
        <span className="text-ink-secondary">
          {showMedian ? ` — median ${formatUsd(platform.median)} · ${count}` : ` · ${count}`}
        </span>
      </p>
      <ul className="mt-1 flex flex-col">
        {platform.listings.map((cited) => (
          <li key={cited.n}>
            <SourceRow cited={cited} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One listing, as one row: its number, its price, what it is, where it is from.
 * The whole row is the link, so the target is as large as the row.
 */
function SourceRow({ cited }: { cited: CitedListing }) {
  const { n, listing, href } = cited;
  const host = hostLabel(href);
  const original = originalPrice(listing);
  const meta = [
    listing.kind === "sold" ? "Sold" : "Asking",
    listing.condition === "unknown" ? null : listing.condition.replace("_", " "),
    href ? host : "no link",
  ]
    .filter(Boolean)
    .join(" · ");

  const body = (
    <>
      <span className="nums text-xs text-ink-muted">[{n}]</span>
      <span className="nums font-semibold">
        {original ? "≈ " : ""}
        {formatUsd(listing.price)}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{listing.title || "Listing"}</span>
        <span className="truncate text-xs text-ink-muted">
          {original ? <span className="nums">{original} · </span> : null}
          {meta}
          {href ? <span aria-hidden> ↗</span> : null}
          {href ? <span className="sr-only"> (opens in a new tab)</span> : null}
        </span>
      </span>
    </>
  );
  const row =
    "-mx-2 grid grid-cols-[2rem_6rem_minmax(0,1fr)] items-baseline gap-x-2 rounded-lg px-2 py-2 text-sm";

  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${row} outline-none transition-colors hover:bg-sunken focus-visible:bg-sunken focus-visible:ring-2 focus-visible:ring-ink`}
    >
      {body}
    </a>
  ) : (
    <div className={row}>{body}</div>
  );
}
