"use client";

import { useEffect, useRef, useState } from "react";
import { SELLING_LENSES } from "@/lib/item";

/**
 * What the study found, as the protocol states it (protocols/protocol_v3.md,
 * Novemsky & Kahneman 2005): owners put a price on an item of roughly this many
 * times what people who did not own it would pay. The figure is an illustration
 * of a $100 item, not a measurement, and says so.
 */
const OWNER_RATIO = 1.85;
const BUYER_PRICE = 100;

/**
 * The two reminders the conversation opens with, each drawn rather than only
 * described: the buyer's price beside the owner's, and a stored item turning into
 * cash.
 *
 * Both figures draw themselves once, when they scroll into view, and can be
 * replayed. With reduced motion they are simply drawn. Colour never carries the
 * meaning alone: every mark is labelled where it is.
 */
export function SellingLenses() {
  const [run, setRun] = useState(0);
  const [playing, setPlaying] = useState(false);
  const figures = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = figures.current;
    if (!node || playing) return;
    if (typeof IntersectionObserver === "undefined") {
      // No way to know what is in view: just play.
      const timer = setTimeout(() => setPlaying(true), 0);
      return () => clearTimeout(timer);
    }
    const watcher = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setPlaying(true);
          watcher.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    watcher.observe(node);
    return () => watcher.disconnect();
  }, [playing]);

  return (
    <div ref={figures} className={`fig flex flex-col gap-2 ${playing ? "play" : ""}`}>
      <ol className="grid gap-3 sm:grid-cols-2">
        {SELLING_LENSES.map((lens, index) => (
          <li
            key={lens.title}
            className="flex flex-col gap-3 rounded-3xl bg-surface p-5 shadow-soft"
          >
            {index === 0 ? (
              <BuyerSeat key={`buyer-${run}`} />
            ) : (
              <CashNow key={`cash-${run}`} />
            )}
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold">
                <span className="nums text-ink-muted">{index + 1}. </span>
                {lens.title}
              </h3>
              <p className="text-xs leading-relaxed text-ink-secondary">{lens.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => {
          setPlaying(true);
          setRun((n) => n + 1);
        }}
        className="replay -mr-2 self-end rounded-full px-2.5 py-1 text-xs text-ink-secondary transition-colors hover:text-ink focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:outline-none"
      >
        <span aria-hidden>↻ </span>Replay
      </button>
    </div>
  );
}

/** What a buyer would pay, beside what the owner asks. */
function BuyerSeat() {
  const owner = BUYER_PRICE * OWNER_RATIO;
  const buyerShare = (BUYER_PRICE / owner) * 100;

  return (
    <figure className="flex flex-col gap-2">
      <div className="flex flex-col gap-3 py-1" aria-hidden>
        <div className="flex flex-col gap-1">
          <p className="flex items-baseline justify-between text-[11px] text-ink-secondary">
            <span>A buyer would pay</span>
            <span className="nums font-semibold text-ink">${BUYER_PRICE}</span>
          </p>
          <div className="flex h-5">
            <span
              className="anim anim-grow-x h-full rounded-l-md bg-mark-muted"
              style={{
                width: `${buyerShare}%`,
                ["--delay" as string]: "0ms",
                ["--dur" as string]: "600ms",
              }}
            />
            <span
              className="anim anim-fade flex h-full flex-1 items-center rounded-r-md border border-dashed border-accent px-1.5 text-[10px] leading-none text-ink-secondary"
              style={{ ["--delay" as string]: "1250ms" }}
            >
              <span className="truncate">what owning it adds</span>
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <p className="flex items-baseline justify-between text-[11px] text-ink-secondary">
            <span>You would ask, as the owner</span>
            <span className="nums font-semibold text-ink">≈ ${Math.round(owner)}</span>
          </p>
          <div className="h-5">
            <span
              className="anim anim-grow-x block h-full w-full rounded-md bg-accent"
              style={{ ["--delay" as string]: "450ms", ["--dur" as string]: "700ms" }}
            />
          </div>
        </div>
      </div>
      <figcaption className="text-[11px] leading-relaxed text-ink-muted">
        Illustration for an item a buyer would pay ${BUYER_PRICE} for. Price it from the
        buyer’s seat and the extra {Math.round((OWNER_RATIO - 1) * 100)}% disappears.
      </figcaption>
    </figure>
  );
}

/** The item taking up space, then the same item as cash. */
function CashNow() {
  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox="0 0 280 124" className="h-auto w-full" aria-hidden>
        {/* A box: the item as it sits at home. */}
        <g>
          <rect x="24" y="38" width="60" height="52" rx="6" className="fill-mark-muted" />
          <rect x="24" y="38" width="60" height="14" rx="6" className="fill-track" />
          <rect x="44" y="62" width="20" height="5" rx="2.5" className="fill-plane" />
          <text x="54" y="112" textAnchor="middle" className="fill-ink-secondary text-[13px]">
            Taking up space
          </text>
        </g>

        <path
          d="M104 64 H146 M137 55 L147 64 L137 73"
          pathLength={1}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.5"
          className="anim anim-draw stroke-ink-secondary"
          style={{ ["--delay" as string]: "300ms", ["--dur" as string]: "600ms" }}
        />

        {/* A banknote: the same item once sold. */}
        <g>
          <rect
            x="162"
            y="38"
            width="88"
            height="52"
            rx="6"
            className="anim anim-grow-y fill-accent"
            style={{ ["--delay" as string]: "950ms", ["--origin" as string]: "center" }}
          />
          <g className="anim anim-fade" style={{ ["--delay" as string]: "1500ms" }}>
            <circle cx="206" cy="64" r="14" className="fill-none stroke-plane" strokeWidth="2" />
            <text
              x="206"
              y="70"
              textAnchor="middle"
              className="fill-plane text-[16px] font-semibold"
            >
              $
            </text>
            <text x="206" y="112" textAnchor="middle" className="fill-ink text-[13px] font-semibold">
              Cash in hand, today
            </text>
          </g>
        </g>
      </svg>
      <figcaption className="text-[11px] leading-relaxed text-ink-muted">
        The same item, once it is sold: money you can use now.
      </figcaption>
    </figure>
  );
}
