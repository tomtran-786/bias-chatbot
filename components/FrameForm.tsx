"use client";

import { useState } from "react";
import {
  FRAME_FIELDS,
  MAX_OPTIONS,
  MIN_OPTIONS,
  OPTIONS_FIELD,
  type Frame,
} from "@/lib/decision";

/**
 * The intake form.
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

  const filledOptions = options.map((o) => o.trim()).filter(Boolean);
  const complete =
    FRAME_FIELDS.every((field) => text[field.name]?.trim()) &&
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

  return (
    <section className="mx-auto flex w-full max-w-xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          A decision you have not made yet
        </h1>
        <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          A few questions about how you are thinking about it, then a graded read
          of your reasoning, then a recommendation. Around ten minutes.
        </p>
      </header>

      {FRAME_FIELDS.map((field) => (
        <label key={field.name} className="flex flex-col gap-2">
          <span className="text-sm font-medium">{field.label}</span>
          <span className="text-xs text-neutral-500">{field.hint}</span>
          {field.lines > 1 ? (
            <textarea
              rows={field.lines}
              value={text[field.name] ?? ""}
              onChange={(event) =>
                setText((current) => ({
                  ...current,
                  [field.name]: event.target.value,
                }))
              }
              placeholder={field.placeholder}
              className="resize-none rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
            />
          ) : (
            <input
              type="text"
              value={text[field.name] ?? ""}
              onChange={(event) =>
                setText((current) => ({
                  ...current,
                  [field.name]: event.target.value,
                }))
              }
              placeholder={field.placeholder}
              className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
            />
          )}
        </label>
      ))}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{OPTIONS_FIELD.label}</legend>
        <p className="text-xs text-neutral-500">{OPTIONS_FIELD.hint}</p>
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
              className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
            />
          ))}
        </div>
        {options.length < MAX_OPTIONS ? (
          <button
            type="button"
            onClick={() => setOptions((current) => [...current, ""])}
            className="self-start text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Add another option
          </button>
        ) : null}
      </fieldset>

      <button
        type="button"
        disabled={!complete}
        onClick={submit}
        className="self-start rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
      >
        Start
      </button>
    </section>
  );
}
