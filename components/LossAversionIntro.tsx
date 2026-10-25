"use client";

import { useEffect, useRef, useState } from "react";

/**
 * What the study found, as the protocol states it (protocols/protocol_v2.md,
 * Novemsky & Kahneman 2005): owners put a price on an item of roughly this many
 * times what people who did not own it would pay. The diagram below is an
 * illustration of a $100 item, not a measurement, and says so.
 */
const OWNER_RATIO = 1.85;
const BUYER_PRICE = 100;

type Point = [number, number];
type Bezier = [Point, Point, Point, Point];

function at(curve: Bezier, t: number): Point {
  const u = 1 - t;
  const [a, b, c, d] = curve;
  return [
    u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
    u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
  ];
}

/** The height of a monotone-in-x curve at `x`, by bisection. */
function yAtX(curve: Bezier, x: number): number {
  const rising = curve[3][0] > curve[0][0];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (at(curve, mid)[0] < x === rising) lo = mid;
    else hi = mid;
  }
  return at(curve, (lo + hi) / 2)[1];
}

const ORIGIN: Point = [160, 100];
/** Gains: a gentle slope that flattens. */
const GAIN: Bezier = [ORIGIN, [186, 78], [236, 66], [292, 60]];
/** Losses: about twice as steep through the middle, the kink that is the whole idea. */
const LOSS: Bezier = [ORIGIN, [152, 132], [122, 160], [40, 172]];
const STEP = 60;

const curvePath = ([a, b, c, d]: Bezier) =>
  `M${a[0]} ${a[1]} C${b[0]} ${b[1]}, ${c[0]} ${c[1]}, ${d[0]} ${d[1]}`;

/**
 * The two ideas the app is built around, drawn rather than described, above the
 * form so the person knows what the questions are for.
 *
 * Two small figures. The first is the textbook value curve reduced to its one
 * claim: the same $100, once gained and once lost, does not weigh the same. The
 * second puts that to work in the only place it costs them money, a price: what a
 * buyer would pay beside what an owner asks.
 *
 * Both draw themselves once, when they scroll into view, and can be replayed. With
 * reduced motion they are simply drawn. Colour never carries the meaning alone:
 * every mark is labelled where it is, and the captions say what the picture shows.
 */
export function LossAversionIntro() {
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
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          The bias this assistant works against
        </p>
        <h2 className="text-2xl leading-tight font-semibold tracking-tight text-balance">
          Loss aversion: giving something up hurts more than getting it feels good
        </h2>
        <p className="max-w-[62ch] text-[15px] leading-relaxed text-ink-secondary">
          The moment something is yours, parting with it registers as a loss, so you
          value it above what a stranger would pay. In the study this is built on,
          owners put a price on an item of roughly{" "}
          <strong className="font-semibold text-ink nums">{OWNER_RATIO}×</strong> what
          people who did not own it would pay for the same thing.
        </p>
      </header>

      <div
        ref={figures}
        className={`fig flex flex-col gap-3 ${playing ? "play" : ""}`}
      >
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-medium">Why it happens, and what it costs you</h3>
          <button
            type="button"
            onClick={() => {
              setPlaying(true);
              setRun((n) => n + 1);
            }}
            className="replay -mr-2 rounded-full px-2.5 py-1 text-xs text-ink-secondary transition-colors hover:text-ink focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-ink focus-visible:outline-none"
          >
            <span aria-hidden>↻ </span>Replay
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <ValueCurve key={`curve-${run}`} />
          <OwnerPremium key={`price-${run}`} />
        </div>
      </div>

      <p className="max-w-[62ch] border-l-2 border-accent pl-4 text-[15px] leading-relaxed">
        <span className="font-medium">Avoid it by pricing as a buyer would:</span> what
        would you pay for this exact item, in this exact condition, today? That is the
        question the next few minutes are for. You will name your own price first, and
        only then see the market.
      </p>
    </div>
  );
}

/** Equal amounts, unequal weight: the loss bar is the taller. */
function ValueCurve() {
  const gainY = yAtX(GAIN, ORIGIN[0] + STEP);
  const lossY = yAtX(LOSS, ORIGIN[0] - STEP);
  const gainX = ORIGIN[0] + STEP;
  const lossX = ORIGIN[0] - STEP;

  return (
    <figure className="flex flex-col gap-2.5 rounded-xl border border-rule bg-sunken p-4">
      <svg viewBox="0 0 320 196" className="h-auto w-full" aria-hidden>
        {/* Axes: one hairline each, labelled at their ends instead of with a legend. */}
        <g className="anim anim-fade" style={{ ["--delay" as string]: "0ms" }}>
          <line x1="24" y1={ORIGIN[1]} x2="296" y2={ORIGIN[1]} className="stroke-rule-strong" strokeWidth="1" />
          <line x1={ORIGIN[0]} y1="22" x2={ORIGIN[0]} y2="186" className="stroke-rule-strong" strokeWidth="1" />
          <text x="24" y="118" className="fill-ink-muted text-[13px]">Lose</text>
          <text x="296" y="118" textAnchor="end" className="fill-ink-muted text-[13px]">Gain</text>
          <text x="168" y="17" className="fill-ink-muted text-[13px]">How it feels</text>
        </g>

        <path
          d={curvePath(GAIN)}
          pathLength={1}
          fill="none"
          strokeLinecap="round"
          strokeWidth="2.5"
          className="anim anim-draw stroke-ink-secondary"
          style={{ ["--delay" as string]: "200ms", ["--dur" as string]: "700ms" }}
        />
        <path
          d={curvePath(LOSS)}
          pathLength={1}
          fill="none"
          strokeLinecap="round"
          strokeWidth="2.5"
          className="anim anim-draw stroke-accent"
          style={{ ["--delay" as string]: "500ms", ["--dur" as string]: "700ms" }}
        />

        {/* The same $100 each way, from the axis to the curve. */}
        <rect
          x={gainX - 3}
          y={gainY}
          width="6"
          height={ORIGIN[1] - gainY}
          rx="3"
          className="anim anim-grow-y fill-ink-secondary"
          style={{ ["--delay" as string]: "1250ms", ["--origin" as string]: "bottom" }}
        />
        <rect
          x={lossX - 3}
          y={ORIGIN[1]}
          width="6"
          height={lossY - ORIGIN[1]}
          rx="3"
          className="anim anim-grow-y fill-accent"
          style={{ ["--delay" as string]: "1450ms", ["--origin" as string]: "top" }}
        />
        <g className="anim anim-fade" style={{ ["--delay" as string]: "1900ms" }}>
          <text x={gainX} y={ORIGIN[1] + 20} textAnchor="middle" className="fill-ink text-[14px] font-semibold">+$100</text>
          <text x={lossX - 12} y={lossY + 5} textAnchor="end" className="fill-ink text-[14px] font-semibold">−$100</text>
        </g>
      </svg>
      <figcaption className="text-xs leading-relaxed text-ink-secondary">
        <span className="font-medium text-ink">The same $100 does not weigh the same.</span>{" "}
        Losing it (blue) drops further than gaining it (grey) rises, so giving up
        something you own feels bigger than what a buyer is paying for it.
      </figcaption>
    </figure>
  );
}

/** What a buyer would pay, beside what the owner asks. */
function OwnerPremium() {
  const owner = BUYER_PRICE * OWNER_RATIO;
  const buyerShare = (BUYER_PRICE / owner) * 100;

  return (
    <figure className="flex flex-col gap-2.5 rounded-xl border border-rule bg-sunken p-4">
      <div className="flex flex-1 flex-col justify-center gap-5 py-2" aria-hidden>
        <div className="flex flex-col gap-1.5">
          <p className="flex items-baseline justify-between text-xs text-ink-secondary">
            <span>A buyer would pay</span>
            <span className="nums font-semibold text-ink">${BUYER_PRICE}</span>
          </p>
          <div className="flex h-7">
            <span
              className="anim anim-grow-x h-full rounded-l-md bg-mark-muted"
              style={{
                width: `${buyerShare}%`,
                ["--delay" as string]: "0ms",
                ["--dur" as string]: "600ms",
              }}
            />
            <span
              className="anim anim-fade flex h-full flex-1 items-center rounded-r-md border border-dashed border-accent px-2 text-[11px] leading-none text-ink-secondary"
              style={{ ["--delay" as string]: "1250ms" }}
            >
              <span className="truncate">what ownership adds</span>
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="flex items-baseline justify-between text-xs text-ink-secondary">
            <span>You would ask, as the owner</span>
            <span className="nums font-semibold text-ink">≈ ${Math.round(owner)}</span>
          </p>
          <div className="h-7">
            <span
              className="anim anim-grow-x block h-full w-full rounded-md bg-accent"
              style={{ ["--delay" as string]: "450ms", ["--dur" as string]: "700ms" }}
            />
          </div>
        </div>
      </div>
      <figcaption className="text-xs leading-relaxed text-ink-secondary">
        <span className="font-medium text-ink">Ask that, and it waits.</span> An
        illustration for an item a buyer would pay ${BUYER_PRICE} for: the extra{" "}
        {Math.round((OWNER_RATIO - 1) * 100)}% is about you, not about the item, and no
        buyer will pay it.
      </figcaption>
    </figure>
  );
}
