"use client";

import { useState } from "react";
import {
  OVERPRICED_AT,
  formatPct,
  formatUsd,
  formatUsdWhole,
  type AppraiseResponse,
  type PricedListing,
} from "@/lib/pricing";

/**
 * The market, laid out for one decision: is my price in line with what people
 * are paying?
 *
 * The forms follow from what each piece of data has to do. Two numbers the
 * reader compares — their price and the market median — are a pair of large
 * figures, not a chart. The spread of listings is a strip of dots on one shared
 * price axis, because the question is "where does my price sit among them", and
 * a strip answers that with position alone. It uses the emphasis form: every
 * listing is the same neutral grey, and the one accent is their own price,
 * the thing the story is about. The platforms are a small table.
 *
 * Colour never carries meaning alone. The two figures, the median and their
 * price are all labelled in words; the legend names every mark; and every value
 * the strip's hover would show is also in the listings below it, so there is no
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
  const { market, suggested, gap } = appraisal;
  const counted = appraisal.listings.filter((l) => l.status === "used");
  const uncounted = appraisal.listings.filter((l) => l.status === "unverified");

  return (
    <article className="rise overflow-hidden rounded-2xl border border-rule bg-surface">
      <header className="flex flex-col gap-1.5 border-b border-rule px-5 py-5 sm:px-6">
        <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          The market for your {appraisal.item.model || "item"}
        </p>
        <p className="text-sm leading-relaxed text-ink-secondary">{basisSentence(appraisal)}</p>
      </header>

      <PricePair appraisal={appraisal} />

      {gap ? (
        <p className="border-b border-rule px-5 py-3.5 text-sm leading-relaxed sm:px-6">
          <span className="font-medium">
            {Math.abs(gap.pct) < 0.005
              ? "Right at the market median."
              : `${formatPct(gap.pct)} ${gap.pct > 0 ? "above" : "below"} the market median.`}
          </span>{" "}
          <span className="text-ink-secondary">
            {appraisal.overpriced
              ? `That is past the ${Math.round(OVERPRICED_AT * 100)}% mark this check uses for a price that is running high.`
              : gap.pct < 0
                ? "You would be listing under what similar items are asking."
                : "That is within the range of the market."}
          </span>
        </p>
      ) : (
        <p className="border-b border-rule px-5 py-3.5 text-sm leading-relaxed text-ink-secondary sm:px-6">
          Too few listings could be checked against their source to state a market
          price, so there is no comparison to your {formatUsd(appraisal.asking)}.
        </p>
      )}

      {market.tier !== "none" ? <Strip appraisal={appraisal} counted={counted} /> : null}

      {suggested ? (
        <section className="flex flex-col gap-1.5 border-b border-rule px-5 py-5 sm:px-6">
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            Suggested price
          </p>
          <p className="text-3xl font-semibold tracking-tight">{formatUsd(suggested.price)}</p>
          <p className="text-sm leading-relaxed text-ink-secondary">{suggestionNote(appraisal)}</p>
        </section>
      ) : null}

      {appraisal.platforms.length > 0 && market.tier !== "none" ? (
        <section className="border-b border-rule px-5 py-4 sm:px-6">
          <h3 className="text-sm font-medium">By platform</h3>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-muted">
                <th className="py-1 font-normal">Platform</th>
                <th className="py-1 text-right font-normal">Listings</th>
                <th className="py-1 text-right font-normal">Median</th>
              </tr>
            </thead>
            <tbody>
              {appraisal.platforms.map((row) => (
                <tr key={row.platform} className="border-t border-rule">
                  <td className="py-1.5">{row.platform}</td>
                  <td className="nums py-1.5 text-right text-ink-secondary">{row.count}</td>
                  <td className="nums py-1.5 text-right">{formatUsd(row.median)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {counted.length > 0 ? (
        <ListingList
          title={
            market.tier === "none"
              ? `Verified listings, too few to price from (${counted.length})`
              : `Listings counted (${counted.length})`
          }
          listings={counted}
        />
      ) : null}
      {uncounted.length > 0 ? (
        <ListingList
          title={`Shown, not counted (${uncounted.length})`}
          note="These prices did not appear word for word in the text the search returned for that page, so they could not be tied to a real listing."
          listings={uncounted}
          dim
        />
      ) : null}

      <footer className="flex flex-col gap-4 bg-sunken px-5 py-5 sm:px-6">
        {appraisal.queries.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-ink-secondary">Searched for</p>
            <ul className="flex flex-col gap-1">
              {appraisal.queries.map((query) => (
                <li key={query} className="text-xs text-ink-muted">
                  “{query}”
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {appraisal.backup.length > 0 ? (
          <p className="text-xs leading-relaxed text-ink-secondary">
            Gemini’s quota was used up, so a backup model did part of this:{" "}
            {appraisal.backup
              .map((entry) =>
                entry.step === "facts"
                  ? `${entry.provider} worked out the item from your messages alone, since it cannot see photos`
                  : `${entry.provider} read the search results`,
              )
              .join(", and ")}
            .
          </p>
        ) : null}
        <p className="text-xs leading-relaxed text-ink-muted">
          Search results via Tavily, read by an AI model. A price is counted only
          if it appears word for word in the page text the search returned. They
          are asking or sold prices, not offers you will receive, and a search can
          miss listings or pick up the wrong model.
        </p>
        {canContinue ? (
          <button
            type="button"
            onClick={onContinue}
            disabled={pending}
            className="self-start rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-plane transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {pending ? "Thinking…" : "See my verdict"}
          </button>
        ) : null}
      </footer>
    </article>
  );
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
  if (suggested.capped && a.newPrice !== null) {
    parts.push(`Held below 90% of the new price (${formatUsd(a.newPrice)}).`);
  }
  return parts.join(" ");
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

/** Round tick values spanning [lo, hi]: the smallest round step giving at most about five. */
function niceTicks(lo: number, hi: number): number[] {
  const span = hi - lo;
  const raw = span / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(Math.round(t * 100) / 100);
  return ticks;
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
  counted: PricedListing[];
}) {
  const [active, setActive] = useState<number | null>(null);
  const { market } = appraisal;
  const median = market.median!;

  const values = [...counted.map((l) => l.price), appraisal.asking];
  const lo0 = Math.min(...values);
  const hi0 = Math.max(...values);
  const pad = (hi0 - lo0) * 0.08 || hi0 * 0.1;
  const lo = Math.max(0, lo0 - pad);
  const hi = hi0 + pad;
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100;

  // Stack dots that would overlap into rows, in price order.
  const rows: number[] = [];
  const placed = [...counted]
    .sort((a, b) => a.price - b.price)
    .map((listing) => {
      const at = x(listing.price);
      let row = rows.findIndex((last) => at - last >= 3.4);
      if (row === -1) row = rows.length;
      rows[row] = at;
      return { listing, at, row };
    });
  const height = Math.max(rows.length, 1) * ROW + 16;

  const xMedian = x(median);
  const xAsking = x(appraisal.asking);
  const ticks = niceTicks(lo, hi);
  const hovered = active === null ? null : placed[active];

  return (
    <section className="flex flex-col gap-3 border-b border-rule px-5 py-5 sm:px-6" aria-label="Where your price sits among the listings">
      {/* Labels for the two markers that matter, above the plot. */}
      <div className="relative h-5 text-xs font-medium">
        <span
          className="absolute px-1.5 whitespace-nowrap"
          style={{ left: `${xMedian}%`, transform: `translateX(${ANCHOR_SHIFT[anchorFor(xMedian, xAsking, true)]})` }}
        >
          Median {formatUsd(median)}
        </span>
        <span
          className="absolute px-1.5 whitespace-nowrap"
          style={{ left: `${xAsking}%`, transform: `translateX(${ANCHOR_SHIFT[anchorFor(xAsking, xMedian, false)]})`, top: 0 }}
        >
          {/* Two labels may share a row; the anchor rule keeps them apart. */}
          Yours {formatUsd(appraisal.asking)}
        </span>
      </div>

      <div className="relative mx-3" style={{ height }}>
        {/* Recessive grid: hairlines, solid. */}
        {ticks.map((t) => (
          <span key={t} aria-hidden className="absolute top-0 bottom-0 w-px bg-rule" style={{ left: `${x(t)}%` }} />
        ))}

        {/* The middle half of the listings, as a wash. */}
        {market.q1 !== null && market.q3 !== null ? (
          <span
            aria-hidden
            className="absolute top-0 bottom-0 bg-track/60"
            style={{ left: `${x(market.q1)}%`, width: `${x(market.q3) - x(market.q1)}%` }}
          />
        ) : null}

        <span aria-hidden className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${xMedian}%` }} />
        <span aria-hidden className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-accent" style={{ left: `${xAsking}%` }} />

        {placed.map(({ listing, at, row }, index) => {
          const label = `${formatUsd(listing.price)}, ${listing.platform}, ${listing.kind === "sold" ? "sold" : "asking price"}`;
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
          return listing.url && /^https?:\/\//.test(listing.url) ? (
            <a key={index} href={listing.url} target="_blank" rel="noopener noreferrer" {...common}>
              {dot}
            </a>
          ) : (
            <span key={index} tabIndex={0} role="img" {...common}>
              {dot}
            </span>
          );
        })}

        {hovered ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-rule-strong bg-surface px-2.5 py-1.5 text-xs shadow-sm whitespace-nowrap"
            style={{ left: `${Math.min(Math.max(hovered.at, 12), 88)}%`, top: 8 + hovered.row * ROW - 6 }}
          >
            <span className="nums block text-sm font-semibold">{formatUsd(hovered.listing.price)}</span>
            <span className="text-ink-secondary">
              {hovered.listing.platform} · {hovered.listing.kind === "sold" ? "Sold" : "Asking"}
            </span>
          </div>
        ) : null}
      </div>

      {/* The axis, with ticks that carry the values nothing is labelled with. */}
      <div className="relative mx-3 h-4 border-t border-rule-strong text-[11px] text-ink-muted" aria-hidden>
        {ticks.map((t) => (
          <span key={t} className="nums absolute top-1 -translate-x-1/2" style={{ left: `${x(t)}%` }}>
            {formatUsd(t)}
          </span>
        ))}
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-secondary">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full bg-mark-muted" />
          Listings counted
        </li>
        {market.q1 !== null ? (
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-4 bg-track/60" />
            Middle half
          </li>
        ) : null}
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-0.5 bg-ink" />
          Median
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-0.5 bg-accent" />
          Your price
        </li>
      </ul>
    </section>
  );
}

function ListingList({
  title,
  note,
  listings,
  dim,
}: {
  title: string;
  note?: string;
  listings: PricedListing[];
  dim?: boolean;
}) {
  return (
    <section className="border-b border-rule px-5 py-4 sm:px-6">
      <h3 className="text-sm font-medium">{title}</h3>
      {note ? <p className="mt-1 text-xs leading-relaxed text-ink-muted">{note}</p> : null}
      <ul className={`mt-2 flex flex-col ${dim ? "opacity-60" : ""}`}>
        {listings.map((listing, index) => {
          const safe = listing.url && /^https?:\/\//.test(listing.url) ? listing.url : null;
          return (
            <li key={index} className="grid grid-cols-[4.5rem_1fr] gap-x-3 border-t border-rule py-2 text-sm first:border-t-0">
              <span className="nums font-medium">{formatUsd(listing.price)}</span>
              <span className="flex min-w-0 flex-col">
                {safe ? (
                  <a
                    href={safe}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate underline decoration-rule-strong underline-offset-4 transition-colors hover:decoration-ink"
                  >
                    {listing.title || "Listing"}
                  </a>
                ) : (
                  <span className="truncate">{listing.title || "Listing"}</span>
                )}
                <span className="text-xs text-ink-muted">
                  {listing.platform} · {listing.kind === "sold" ? "Sold" : "Asking price"} ·{" "}
                  {listing.condition.replace("_", " ")}
                  {safe ? "" : " · no link"}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
