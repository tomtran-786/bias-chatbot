"use client";

import { useState } from "react";
import { ScaleQuestion } from "@/components/ScaleQuestion";
import { COMMITMENT_PROMPT, type Commitment, type Frame } from "@/lib/decision";

/**
 * Their own call, recorded before the grade exists.
 *
 * This is the step the app has that a Gem does not. The corrective framing only
 * does any work if the person has committed to a position first — in a chat
 * window they can read the assistant's verdict before forming one of their own,
 * and the commitment becomes a formality. Here the grade is not requested until
 * this is submitted, so there is nothing to read ahead to.
 *
 * Submit-once, deliberately. Being able to revise the baseline after seeing the
 * grade would make it worthless as a baseline.
 */
export function CommitmentGate({
  frame,
  pending,
  onSubmit,
}: {
  frame: Frame;
  pending: boolean;
  onSubmit: (commitment: Commitment) => void;
}) {
  const [option, setOption] = useState<string | null>(null);
  const [selfScore, setSelfScore] = useState<number | null>(null);

  const complete = option !== null && selfScore !== null;

  return (
    <section className="rise flex flex-col gap-7 rounded-2xl border border-rule bg-surface px-5 py-6 sm:px-6">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          Before the grade
        </p>
        <h2 className="text-xl font-semibold tracking-tight">Your call, first</h2>
        <p className="text-sm leading-relaxed text-ink-secondary">
          Answer these before the grade is produced. They are recorded as they
          stand and cannot be changed afterwards — that is what makes them worth
          comparing against.
        </p>
      </header>

      <fieldset className="flex flex-col gap-2.5" disabled={pending}>
        <legend className="mb-2.5 text-sm font-medium">
          {COMMITMENT_PROMPT.pick}
        </legend>
        <div className="flex flex-col gap-2">
          {frame.options.map((candidate) => {
            const selected = option === candidate;
            return (
              <label
                key={candidate}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm leading-relaxed transition-colors ${
                  selected
                    ? "border-ink bg-ink text-plane"
                    : "border-rule hover:border-rule-strong"
                }`}
              >
                <input
                  type="radio"
                  name="pick"
                  value={candidate}
                  checked={selected}
                  onChange={() => setOption(candidate)}
                  className="sr-only"
                />
                {candidate}
              </label>
            );
          })}
        </div>
      </fieldset>

      <ScaleQuestion
        question={COMMITMENT_PROMPT.scale}
        lowAnchor={COMMITMENT_PROMPT.lowAnchor}
        highAnchor={COMMITMENT_PROMPT.highAnchor}
        value={selfScore}
        onChange={setSelfScore}
        disabled={pending}
      />

      <button
        type="button"
        disabled={!complete || pending}
        onClick={() =>
          complete && onSubmit({ option, selfScore })
        }
        className="self-start rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-plane transition-opacity hover:opacity-90 disabled:opacity-30"
      >
        {pending ? "Grading…" : "Lock it in and see the grade"}
      </button>
    </section>
  );
}
