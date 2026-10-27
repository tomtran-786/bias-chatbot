"use client";

import { useState } from "react";
import {
  ASKING_PRICE_PROMPT,
  MAX_ASKING_USD,
  SELLING_LENSES,
  type AskingPrice,
} from "@/lib/item";

/** "1,049.99", "$450", "450.5" → a number, or null when it is not a price. */
function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value > 0 && value <= MAX_ASKING_USD ? value : null;
}

/**
 * The price they would list it at, asked for once the market is on screen.
 *
 * The market has already been looked up and shown by the time this appears, so
 * the number is set with it in view. The lookup itself never saw a price, and
 * still does not.
 *
 * Submit-once, deliberately. The comparison and the verdict that follow are set
 * against the number the person committed to; letting it be revised would make
 * both a moving target.
 */
export function PriceGate({ onSubmit }: { onSubmit: (asking: AskingPrice) => void }) {
  const [text, setText] = useState("");
  const amount = parseAmount(text);

  return (
    <section className="rise flex flex-col gap-6 rounded-3xl bg-surface px-5 py-7 shadow-soft sm:px-7">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          {ASKING_PRICE_PROMPT.eyebrow}
        </p>
        <h2 className="text-xl font-semibold tracking-tight">
          {ASKING_PRICE_PROMPT.question}
        </h2>
        <p className="text-sm leading-relaxed text-ink-secondary">
          {ASKING_PRICE_PROMPT.hint}
        </p>
        <ul className="mt-1 flex flex-col gap-1 border-l-2 border-accent pl-3 text-sm text-ink-secondary">
          {SELLING_LENSES.map((lens) => (
            <li key={lens.title}>{lens.reminder}</li>
          ))}
        </ul>
      </header>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (amount !== null) onSubmit({ usd: amount });
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="sr-only">Listing price in US dollars</span>
          <span className="flex items-center gap-2 rounded-full bg-sunken px-6 py-3 ring-1 ring-transparent transition-shadow focus-within:ring-action/40">
            <span aria-hidden className="text-2xl text-ink-muted">$</span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="0"
              aria-describedby="price-hint"
              className="w-full bg-transparent text-2xl font-semibold outline-none placeholder:text-ink-muted"
            />
            <span className="text-sm text-ink-muted">USD</span>
          </span>
        </label>
        <p id="price-hint" className="text-xs text-ink-muted">
          {text && amount === null
            ? "Enter a positive amount, for example 450 or 449.99."
            : "The amount you would put on the listing."}
        </p>

        <button
          type="submit"
          disabled={amount === null}
          className="btn-primary self-start px-6 py-3 text-sm font-medium"
        >
          Lock in my price
        </button>
      </form>
    </section>
  );
}
