"use client";

import { SCORE_MAX, SCORE_MIN } from "@/lib/rubric";

const VALUES = Array.from(
  { length: SCORE_MAX - SCORE_MIN + 1 },
  (_, index) => SCORE_MIN + index,
);

/**
 * The 1-5 control, on the same scale the assistant grades on.
 *
 * Controlled and without a submit button of its own, so it composes into a
 * larger form. Sharing the rubric's scale is deliberate: the point of asking is
 * to put their number and the assistant's side by side, which only means
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
    <fieldset className="flex flex-col gap-2.5" disabled={disabled}>
      <legend className="mb-2.5 text-sm font-medium">{question}</legend>
      <div className="flex gap-2">
        {VALUES.map((option) => {
          const selected = value === option;
          return (
            <label
              key={option}
              className={`nums flex h-11 flex-1 items-center justify-center rounded-xl border text-sm font-medium transition-colors ${
                disabled ? "cursor-default" : "cursor-pointer"
              } ${
                selected
                  ? "border-ink bg-ink text-plane"
                  : "border-rule hover:border-rule-strong"
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
      <div className="flex justify-between text-xs text-ink-muted">
        <span>{lowAnchor}</span>
        <span>{highAnchor}</span>
      </div>
    </fieldset>
  );
}
