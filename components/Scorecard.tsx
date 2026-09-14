"use client";

import type { Commitment } from "@/lib/decision";
import { SCORE_MAX, type Headline, type ScoredDimension } from "@/lib/rubric";

export type Grade = {
  dimensions: ScoredDimension[];
  headline: Headline;
};

/**
 * The graded read of the decision.
 *
 * The headline number arrives already computed by the server from the five
 * dimension scores; the model is never asked for it and never sees it before
 * the recommendation turn. Rendering it next to the person's own self-rating is
 * the point of the whole exercise — the gap between the two is the finding.
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

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold tracking-tight">
          How this decision grades out
        </h2>
        <div className="flex items-baseline gap-3">
          <span className="text-4xl font-semibold tabular-nums">
            {grade.headline.mean.toFixed(1)}
          </span>
          <span className="text-sm text-neutral-500">/ {SCORE_MAX}</span>
          <span className="text-base font-medium">{grade.headline.band}</span>
        </div>
        <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          {grade.headline.gloss}
        </p>
      </header>

      <dl className="flex flex-col divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {grade.dimensions.map((dimension) => (
          <div key={dimension.id} className="flex gap-4 py-4">
            <div
              className="flex size-9 shrink-0 items-center justify-center rounded-md border border-neutral-300 text-sm font-semibold tabular-nums dark:border-neutral-700"
              aria-hidden
            >
              {dimension.score}
            </div>
            <div className="flex flex-col gap-1.5">
              <dt className="text-sm font-medium">
                {dimension.label}
                <span className="sr-only">
                  : {dimension.score} out of {SCORE_MAX}
                </span>
              </dt>
              <dd className="flex flex-col gap-1.5 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
                <span>{dimension.why}</span>
                <span className="border-l-2 border-neutral-300 pl-3 text-neutral-500 dark:border-neutral-700">
                  &ldquo;{dimension.quote}&rdquo;
                </span>
              </dd>
            </div>
          </div>
        ))}
      </dl>

      <div className="flex flex-col gap-2 rounded-md bg-neutral-100 px-4 py-3 text-sm dark:bg-neutral-900">
        <p>
          You rated your own thinking at{" "}
          <strong className="font-medium">
            {commitment.selfScore}/{SCORE_MAX}
          </strong>{" "}
          and picked{" "}
          <strong className="font-medium">{commitment.option}</strong>.
        </p>
        <p className="text-neutral-600 dark:text-neutral-400">
          {Math.abs(gap) < 0.5
            ? "That is close to where the scorecard landed."
            : gap < 0
              ? "The scorecard is harder on it than you were."
              : "The scorecard is easier on it than you were."}
        </p>
      </div>

      <button
        type="button"
        onClick={onContinue}
        disabled={pending}
        className="self-start rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {pending ? "Thinking…" : "See the recommendation"}
      </button>
    </section>
  );
}
