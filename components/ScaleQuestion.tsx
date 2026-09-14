"use client";

import { SCORE_MAX, SCORE_MIN } from "@/lib/rubric";

const VALUES = Array.from(
  { length: SCORE_MAX - SCORE_MIN + 1 },
  (_, index) => SCORE_MIN + index,
);

/**
 * The 1-5 control, on the same scale the assistant grades on.
 *
 * Controlled and without a submit button of its own, so it can be composed into
 * a larger form. Sharing the rubric's scale is deliberate: the point of asking
 * is to put their number and the assistant's side by side, which only means
 * something if the two are measured the same way.
 */
export function ScaleQuestion({
  question,
  lowAnchor,
  highAnchor,
  value,
  onChange,
  disabled,
}: {
  question: string;
  lowAnchor: string;
  highAnchor: string;
  value: number | null;
  onChange: (score: number) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="mb-3 text-sm font-medium">{question}</legend>
      <div className="flex justify-between gap-2">
        {VALUES.map((option) => {
          const selected = value === option;
          return (
            <label
              key={option}
              className={`flex h-12 flex-1 items-center justify-center rounded-md border text-sm font-medium transition-colors ${
                disabled ? "cursor-default" : "cursor-pointer"
              } ${
                selected
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                  : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700 dark:hover:border-neutral-500"
              }`}
            >
              <input
                type="radio"
                name="self-score"
                value={option}
                checked={selected}
                onChange={() => onChange(option)}
                className="sr-only"
              />
              {option}
            </label>
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-neutral-500">
        <span>{lowAnchor}</span>
        <span>{highAnchor}</span>
      </div>
    </fieldset>
  );
}
