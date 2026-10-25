"use client";

import { useState } from "react";
import type { MarketStep } from "@/lib/market-client";
import {
  ASKING_PRICE_PROMPT,
  MAX_ASKING_USD,
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
 * The price they would list it at, recorded before the market is looked up.
 *
 * This is the step the app has that a Gem does not. The anchor study measures
 * what owners would sell for, and that only means something if it is taken
 * before anything else has had a chance to move it — in a chat window the
 * assistant's market figures can be read before a number of one's own is formed.
 *
 * The market is looked up while they decide (lib/market-client.ts), so it is
 * ready the moment they lock in, but nothing it finds is held anywhere a screen
 * reads until they have: the lookup never sees the price, and this card shows
 * nothing of it. Before they submit it can only be waiting; the progress line
 * below appears after, if the lookup has not finished.
 *
 * Submit-once, deliberately. Being able to revise the price after seeing the
 * market would make it worthless as a baseline.
 */
const PROGRESS: Record<MarketStep | "done", string> = {
  facts: "Reading your conversation…",
  search: "Searching used listings…",
  read: "Checking each price against its page…",
  done: "Working out the figures…",
};

export function PriceGate({
  pending,
  step,
  onSubmit,
}: {
  pending: boolean;
  /** Which part of the market lookup is running, to say so while they wait. */
  step: MarketStep | "done" | null;
  onSubmit: (asking: AskingPrice) => void;
}) {
  const [text, setText] = useState("");
  const amount = parseAmount(text);

  return (
    <section className="rise flex flex-col gap-6 rounded-2xl border border-rule bg-surface px-5 py-6 sm:px-6">
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
      </header>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (amount !== null && !pending) onSubmit({ usd: amount });
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="sr-only">Listing price in US dollars</span>
          <span className="flex items-center gap-2 rounded-xl border border-rule bg-surface px-4 py-3 focus-within:border-rule-strong">
            <span aria-hidden className="text-2xl text-ink-muted">$</span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={pending}
              placeholder="0"
              aria-describedby="price-hint"
              className="w-full bg-transparent text-2xl font-semibold outline-none placeholder:text-ink-muted disabled:opacity-50"
            />
            <span className="text-sm text-ink-muted">USD</span>
          </span>
        </label>
        <p id="price-hint" className="text-xs text-ink-muted">
          {text && amount === null
            ? "Enter a positive amount, for example 450 or 449.99."
            : "Going by your gut is the point. Don’t look anything up yet."}
        </p>

        <button
          type="submit"
          disabled={amount === null || pending}
          className="self-start rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-plane transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          {pending ? "Looking up the market…" : "Lock it in and see the market"}
        </button>
        {pending ? (
          <p className="text-xs text-ink-muted" role="status">
            {step ? PROGRESS[step] : "Getting the market ready…"} This can take up
            to a minute.
          </p>
        ) : null}
      </form>
    </section>
  );
}
