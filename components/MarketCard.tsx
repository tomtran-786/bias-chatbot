"use client";

import { useState } from "react";
import {
  citeListings,
  hostLabel,
  safeHref,
  type CitedListing,
  type CitedPlatform,
} from "@/lib/citations";
import {
  NEW_PRICE_CEILING,
  OVERPRICED_AT,
  formatUsd,
  formatUsdWhole,
  marketHeadline,
  type AppraiseResponse,
} from "@/lib/pricing";

/**
 * The market, laid out for one decision: is my price in line with what people
 * are paying?
 *
 * One story, told top to bottom. The title is the takeaway ("Your $520 is 24%
 * above the market median"), and everything under it is the evidence for it,
 * ending at the conclusion — the suggested price — and the sources it stands on.
 *
 * The forms follow from what each piece of data has to do. Two numbers the
 * reader compares — their price and the market median — are a pair of large
 * figures, not a chart. The spread of listings is a strip of dots on one shared
 * price axis, because the question is "where does my price sit among them", and
 * a strip answers that with position alone. It uses the emphasis form: every
 * listing is the same neutral grey, and the one accent is their own price,
 * the thing the story is about. There are no gridlines and no legend: the two
 * lines that matter are labelled where they are, and one caption says the rest.
 *
 * Every price that came from the web is a numbered, clickable source. The same
 * `[n]` marks the dot, the row below and the verdict's sources line
 * (lib/citations.ts). Colour never carries meaning alone, and every value the
 * strip's hover would show is also in the rows below it, so there is no
 * information only a pointer can reach.
 */
export function MarketCard({
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
  const { market, suggested } = appraisal;
  const citations = citeListings(appraisal);

  return (
    <article className="rise overflow-hidden rounded-2xl border border-rule bg-surface">
      <header className="flex flex-col gap-1.5 border-b border-rule px-5 py-5 sm:px-6">
        <h2 className="text-lg leading-snug font-semibold tracking-tight text-pretty">
          {marketHeadline(appraisal)}
        </h2>
        <p className="text-sm leading-relaxed text-ink-secondary">{subtitle(appraisal)}</p>
      </header>

      <PricePair appraisal={appraisal} />

      {market.tier !== "none" ? (
        <Strip appraisal={appraisal} counted={citations.counted} />
      ) : null}

      {suggested ? (
        <Suggestion appraisal={appraisal} countedCount={citations.counted.length} />
      ) : null}

      {citations.counted.length > 0 ? (
        <section id="sources" className="scroll-mt-4 border-b border-rule px-5 py-4 sm:px-6">
          <h3 className="text-sm font-medium">
            {market.tier === "none" ? "Verified listings, too few to price from" : "Sources"}
          </h3>
          {citations.platforms
            .filter((platform) => platform.listings.length > 0)
            .map((platform) => (
              <PlatformGroup
                key={platform.platform}
                platform={platform}
                showMedian={market.tier !== "none"}
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
            so they are not part of the median.
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
          Prices from public listings found by web search. Asking and sold prices,
          not offers you’ll receive.
        </p>
        <details>
          <summary className="cursor-pointer text-xs font-medium text-ink-secondary">
            How this was worked out
          </summary>
          <div className="mt-2 flex flex-col gap-3 text-xs leading-relaxed text-ink-muted">
            {appraisal.queries.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="font-medium text-ink-secondary">Searched for</p>
                <ul className="flex flex-col gap-0.5">
                  {appraisal.queries.map((query) => (
                    <li key={query}>“{query}”</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p>
              An AI reads the search results and reports each listing. A price counts
              only if it appears word for word in the text of the page it came from.
              The median uses sold prices when there are five or more, otherwise
              asking prices, and the app works out every figure itself. A search can
              miss listings or pick up the wrong model.
            </p>
          </div>
        </details>
        {canContinue ? (
          <button
            type="button"
            onClick={onContinue}
            disabled={pending}
            className="mt-1 self-start rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-plane transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {pending ? "Thinking…" : "See my verdict"}
          </button>
        ) : null}
      </footer>
    </article>
  );
}

/** The model, then what the median was made of; and, if it applies, why the price is flagged. */
function subtitle(a: AppraiseResponse): string {
  return [
    a.item.model ? `${a.item.model}.` : null,
    basisSentence(a),
    a.overpriced
      ? `Past the ${Math.round(OVERPRICED_AT * 100)}% mark this check uses for a price that is running high.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function basisSentence(a: AppraiseResponse): string {
  const { market } = a;
  if (market.tier === "none") {
    return `Found ${a.listings.length} listing${a.listings.length === 1 ? "" : "s"}, but only ${market.count} could be verified. That is not enough for a market price.`;
  }
  const what =
    market.basis === "sold"
      ? `${market.count} sold listing${market.count === 1 ? "" : "s"}`
      : `${market.count} listings, asking prices`;
  const caveats = [
    market.askingRunHigh ? "Asking prices run higher than what things sell for." : null,
    market.tier === "thin" ? "Only a few listings, so treat this as a rough guide." : null,
  ].filter(Boolean);
  return [`Median of ${what}.`, ...caveats].join(" ");
}

/** Why the suggestion sits where it does. The new-price cap is added by the caller, as a link. */
function suggestionNote(a: AppraiseResponse): string {
  const { suggested, market } = a;
  if (!suggested) return "";
  const parts: string[] = [];
  if (market.tier === "thin") {
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
  appraisal,
  countedCount,
}: {
  appraisal: AppraiseResponse;
  countedCount: number;
}) {
  const { suggested, newPrice } = appraisal;
  if (!suggested) return null;

  const newHref = safeHref(appraisal.newPriceUrl);
  const newHost = hostLabel(newHref);

  return (
    <section className="flex flex-col gap-1.5 border-b border-rule px-5 py-5 sm:px-6">
      <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
        Suggested price
      </p>
      <p className="text-3xl font-semibold tracking-tight">{formatUsd(suggested.price)}</p>
      <p className="text-sm leading-relaxed text-ink-secondary">
        {suggestionNote(appraisal)}
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
        note="Locked before the lookup"
      />
      <Figure
        label="Market median"
        keyColor="var(--ink)"
        value={market.median === null ? "—" : formatUsd(market.median)}
        note={
          market.q1 !== null && market.q3 !== null
            ? `Middle half: ${formatUsdWhole(market.q1)}–${formatUsdWhole(market.q3)}`
            : market.tier === "thin"
              ? `${market.count} listings`
              : "Not enough listings"
        }
      />
    </div>
  );
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

const ANCHOR_SHIFT = { start: "0%", center: "-50%", end: "-100%" } as const;

const DOT = 10; // px, the visible dot
const HIT = 24; // px, the target around it
const ROW = 20; // px between stacked dots

function Strip({
  appraisal,
  counted,
}: {
  appraisal: AppraiseResponse;
  counted: CitedListing[];
}) {
  const [active, setActive] = useState<number | null>(null);
  const { market } = appraisal;
  const median = market.median!;

  const values = [...counted.map((c) => c.listing.price), appraisal.asking];
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
  const xAsking = x(appraisal.asking);
  const ticks = niceTicks(lo, hi);
  const hovered = active === null ? null : placed[active];
  const hasLinks = counted.some((c) => c.href !== null);

  return (
    <section className="flex flex-col gap-3 border-b border-rule px-5 py-5 sm:px-6" aria-label="Where your price sits among the listings">
      {/* Direct labels for the two markers that matter, above the plot. */}
      <div className="relative h-5 text-xs font-medium">
        <span
          className="absolute whitespace-nowrap"
          style={{ left: `${xMedian}%`, transform: `translateX(${ANCHOR_SHIFT[anchorFor(xMedian, xAsking, true)]})` }}
        >
          Median {formatUsd(median)}
        </span>
        <span
          className="absolute whitespace-nowrap"
          style={{ left: `${xAsking}%`, transform: `translateX(${ANCHOR_SHIFT[anchorFor(xAsking, xMedian, false)]})`, top: 0 }}
        >
          {/* Two labels may share a row; the anchor rule keeps them apart. */}
          Yours {formatUsd(appraisal.asking)}
        </span>
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
        <span aria-hidden className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-accent" style={{ left: `${xAsking}%` }} />

        {placed.map(({ cited, at, row }, index) => {
          const { listing, href, n } = cited;
          const label = `[${n}] ${formatUsd(listing.price)}, ${listing.platform}, ${listing.kind === "sold" ? "sold" : "asking price"}`;
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
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-rule-strong bg-surface px-2.5 py-1.5 text-xs shadow-sm whitespace-nowrap"
            style={{ left: `${Math.min(Math.max(hovered.at, 22), 78)}%`, top: 8 + hovered.row * ROW - 6 }}
          >
            <span className="nums font-semibold">
              [{hovered.cited.n}] {formatUsd(hovered.cited.listing.price)}
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
  /** A median of one or two listings is the number the app withholds, so it is not shown then. */
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
      <span className="nums font-semibold">{formatUsd(listing.price)}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{listing.title || "Listing"}</span>
        <span className="truncate text-xs text-ink-muted">
          {meta}
          {href ? <span aria-hidden> ↗</span> : null}
          {href ? <span className="sr-only"> (opens in a new tab)</span> : null}
        </span>
      </span>
    </>
  );
  const row =
    "-mx-2 grid grid-cols-[2rem_5rem_minmax(0,1fr)] items-baseline gap-x-2 rounded-lg px-2 py-2 text-sm";

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
