"use client";

import { useState } from "react";
import {
  FRAME_FIELDS,
  MAX_OPTIONS,
  MIN_OPTIONS,
  OPTIONS_FIELD,
  type Frame,
} from "@/lib/decision";

const field =
  "w-full rounded-xl border border-rule bg-surface px-3.5 py-2.5 text-[15px] outline-none transition-colors placeholder:text-ink-muted focus:border-rule-strong";

/**
 * The intake, as the first card in the thread rather than a screen before it.
 *
 * A form rather than a conversation, because it is the one place the app can
 * guarantee the assistant starts from the same four facts every time. A Gem can
 * only ask for these in prose and hope the person answers all of them.
 *
 * The options list is the load-bearing field: the recommendation at the end must
 * name one of these, so a decision framed with only one option would leave
 * nothing to recommend.
 */
export function FrameForm({ onSubmit }: { onSubmit: (frame: Frame) => void }) {
  const [text, setText] = useState<Record<string, string>>({
    decision: "",
    deadline: "",
    stakes: "",
  });
  const [options, setOptions] = useState<string[]>(
    Array.from({ length: MIN_OPTIONS }, () => ""),
  );

  const filledOptions = options.map((option) => option.trim()).filter(Boolean);
  const complete =
    FRAME_FIELDS.every((entry) => text[entry.name]?.trim()) &&
    filledOptions.length >= MIN_OPTIONS;

  function submit() {
    if (!complete) return;
    onSubmit({
      decision: text.decision.trim(),
      deadline: text.deadline.trim(),
      stakes: text.stakes.trim(),
      options: filledOptions,
    });
  }

  const update = (name: string, value: string) =>
    setText((current) => ({ ...current, [name]: value }));

  return (
    <section className="rise flex flex-col gap-7 rounded-2xl border border-rule bg-surface px-5 py-6 sm:px-6">
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">
          A decision you have not made yet
        </h2>
        <p className="text-sm leading-relaxed text-ink-secondary">
          A few questions about how you are thinking about it, then a graded read
          of your reasoning, then a recommendation. Around ten minutes.
        </p>
      </header>

      {FRAME_FIELDS.map((entry) => (
        <label key={entry.name} className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{entry.label}</span>
          <span className="text-xs leading-relaxed text-ink-muted">
            {entry.hint}
          </span>
          {entry.lines > 1 ? (
            <textarea
              rows={entry.lines}
              value={text[entry.name] ?? ""}
              onChange={(event) => update(entry.name, event.target.value)}
              placeholder={entry.placeholder}
              className={`${field} mt-1 resize-none`}
            />
          ) : (
            <input
              type="text"
              value={text[entry.name] ?? ""}
              onChange={(event) => update(entry.name, event.target.value)}
              placeholder={entry.placeholder}
              className={`${field} mt-1`}
            />
          )}
        </label>
      ))}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium">{OPTIONS_FIELD.label}</legend>
        <p className="text-xs leading-relaxed text-ink-muted">
          {OPTIONS_FIELD.hint}
        </p>
        <div className="mt-1 flex flex-col gap-2">
          {options.map((option, index) => (
            <input
              key={index}
              type="text"
              value={option}
              onChange={(event) =>
                setOptions((current) =>
                  current.map((existing, i) =>
                    i === index ? event.target.value : existing,
                  ),
                )
              }
              placeholder={`Option ${index + 1}`}
              aria-label={`Option ${index + 1}`}
              className={field}
            />
          ))}
        </div>
        {options.length < MAX_OPTIONS ? (
          <button
            type="button"
            onClick={() => setOptions((current) => [...current, ""])}
            className="mt-1 self-start text-sm text-ink-muted underline underline-offset-4 transition-colors hover:text-ink"
          >
            Add another option
          </button>
        ) : null}
      </fieldset>

      <button
        type="button"
        disabled={!complete}
        onClick={submit}
        className="self-start rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-plane transition-opacity hover:opacity-90 disabled:opacity-30"
      >
        Start
      </button>
    </section>
  );
}
