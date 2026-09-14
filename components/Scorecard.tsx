"use client";

import type { Commitment } from "@/lib/decision";
import { SCORE_MAX, SCORE_MIN, type Headline, type ScoredDimension } from "@/lib/rubric";

export type Grade = {
  dimensions: ScoredDimension[];
  headline: Headline;
};

/**
 * A score at or below this is what the recommendation will argue from, so it is
 * what gets the accent. Everything else is context and stays grey.
 */
const WEAK_AT_OR_BELOW = 2;

/**
 * The graded read.
 *
 * Two forms, chosen by what each piece of data has to do. The headline is a
 * single number, so it is a hero figure with a meter underneath rather than a
 * one-bar chart. The five dimensions are magnitude on a shared 1-5 scale, drawn
 * as horizontal bars — horizontal because the labels are long — using the
 * emphasis form: the dimensions dragging the decision down carry the one accent
 * hue, the rest are grey.
 *
 * Colour never carries meaning alone here. Every bar is direct-labelled with its
 * score, the weak ones are tagged in words, and the row's reasoning sits beside
 * it in text. There is no hover layer for the same reason — everything a tooltip
 * would reveal is already on the page.
 */
export function Scorecard({
  grade,
  commitment,
  onContinue,
  pending,
}: {
  grade: Grade;
  commitment: Commitment;
  onContinue: () => void;
  pending: boolean;
}) {
  const gap = grade.headline.mean - commitment.selfScore;
  const weak = grade.dimensions.filter((d) => d.score <= WEAK_AT_OR_BELOW);
  const pct = (score: number) =>
    ((score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)) * 100;

  return (
    <article className="rise overflow-hidden rounded-2xl border border-rule bg-surface">
      <header className="flex flex-col gap-4 border-b border-rule px-5 py-5 sm:px-6">
        <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          Your decision, graded
        </p>

        <div className="flex items-end gap-3">
          <span className="nums text-5xl leading-none font-semibold tracking-tight">
            {grade.headline.mean.toFixed(1)}
          </span>
          <span className="nums pb-1 text-sm text-ink-muted">
            out of {SCORE_MAX}
          </span>
        </div>

        {/* A single ratio against a limit: a meter, not a chart. */}
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-track"
          role="img"
          aria-label={`${grade.headline.mean} out of ${SCORE_MAX}: ${grade.headline.band}`}
        >
          <div
            className="grow h-full origin-left rounded-full bg-accent"
            style={{ width: `${pct(grade.headline.mean)}%` }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-base font-medium">{grade.headline.band}</p>
          <p className="text-sm leading-relaxed text-ink-secondary">
            {grade.headline.gloss}
          </p>
        </div>
      </header>

      <div className="flex flex-col">
        {grade.dimensions.map((dimension) => {
          const isWeak = dimension.score <= WEAK_AT_OR_BELOW;
          return (
            <section
              key={dimension.id}
              className="flex flex-col gap-2 border-b border-rule px-5 py-4 last:border-b-0 sm:px-6"
            >
              <div className="flex items-baseline justify-between gap-4">
                <h4 className="text-sm font-medium">
                  {dimension.label}
                  {isWeak ? (
                    <span className="ml-2 align-middle text-[11px] font-medium tracking-wide text-accent uppercase">
                      Weak point
                    </span>
                  ) : null}
                </h4>
                {/* Direct label. Ink, never the mark's colour. */}
                <span className="nums shrink-0 text-sm font-medium">
                  {dimension.score}
                  <span className="text-ink-muted">/{SCORE_MAX}</span>
                </span>
              </div>

              <div className="h-1.5 w-full overflow-hidden rounded-full bg-track">
                <div
                  className="grow h-full origin-left rounded-full"
                  style={{
                    width: `${Math.max(pct(dimension.score), 3)}%`,
                    background: isWeak
                      ? "var(--accent)"
                      : "var(--mark-muted)",
                  }}
                />
              </div>

              <p className="text-sm leading-relaxed text-ink-secondary">
                {dimension.why}
              </p>
              <blockquote className="border-l-2 border-rule-strong pl-3 text-sm leading-relaxed text-ink-muted">
                {dimension.quote}
              </blockquote>
            </section>
          );
        })}
      </div>

      <footer className="flex flex-col gap-4 bg-sunken px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-1.5 text-sm">
          <p className="text-ink-secondary">
            You rated your own thinking{" "}
            <span className="nums font-medium text-ink">
              {commitment.selfScore}/{SCORE_MAX}
            </span>{" "}
            and picked{" "}
            <span className="font-medium text-ink">{commitment.option}</span>.
          </p>
          <p className="text-ink-secondary">
            {Math.abs(gap) < 0.5
              ? "That is close to where the scorecard landed."
              : gap < 0
                ? "The scorecard is harder on it than you were."
                : "The scorecard is easier on it than you were."}
            {weak.length > 0 ? (
              <>
                {" "}
                The{" "}
                {weak.length === 1 ? "weak point is" : "weak points are"}{" "}
                <span className="font-medium text-ink">
                  {weak.map((d) => d.label.toLowerCase()).join(", ")}
                </span>
                .
              </>
            ) : null}
          </p>
        </div>

        <button
          type="button"
          onClick={onContinue}
          disabled={pending}
          className="self-start rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-plane transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {pending ? "Thinking…" : "See the recommendation"}
        </button>
      </footer>
    </article>
  );
}
