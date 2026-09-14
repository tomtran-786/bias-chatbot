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
    <section className="mx-auto flex w-full max-w-xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Your call, first</h2>
        <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          Answer these before the grade is produced. They are recorded as they
          stand and cannot be changed afterwards — that is what makes them worth
          comparing against.
        </p>
      </header>

      <fieldset className="flex flex-col gap-3" disabled={pending}>
        <legend className="mb-3 text-sm font-medium">
          {COMMITMENT_PROMPT.pick}
        </legend>
        <div className="flex flex-col gap-2">
          {frame.options.map((candidate) => {
            const selected = option === candidate;
            return (
              <label
                key={candidate}
                className={`flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 text-sm transition-colors ${
                  selected
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                    : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700 dark:hover:border-neutral-500"
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
        className="self-start rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {pending ? "Grading…" : "Lock it in and see the grade"}
      </button>
    </section>
  );
}
