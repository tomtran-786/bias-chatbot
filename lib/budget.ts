/**
 * A daily tripwire on outbound calls, held in memory.
 *
 * Every call to the search service and to the model counts against a ceiling,
 * and going over it fails the request *before* any API is called. It exists to
 * stop a loop or a runaway client from burning a free quota in minutes.
 *
 * It is deliberately not the thing that keeps this free. The counter lives in
 * one process and resets on restart, so it cannot be a guarantee. The guarantee
 * is the account tier: a Gemini key from a project with no billing account and a
 * Tavily plan with pay-as-you-go left off, where running out of quota can only
 * produce an error. This is the second line of defence, not the first.
 */
import "server-only";
import { env } from "./env";

export type BudgetKind = "search" | "model";

export class BudgetExhaustedError extends Error {
  constructor(readonly kind: BudgetKind) {
    super(`The daily ${kind} budget is used up`);
    this.name = "BudgetExhaustedError";
  }
}

const used: Record<BudgetKind, number> = { search: 0, model: 0 };
let day = "";

/** UTC, so the budget turns over at the same moment for everyone. */
const dayOf = (now: Date) => now.toISOString().slice(0, 10);

function rollOver(now: Date) {
  const today = dayOf(now);
  if (today !== day) {
    day = today;
    used.search = 0;
    used.model = 0;
  }
}

const limitFor = (kind: BudgetKind) =>
  kind === "search" ? env.dailySearchBudget : env.dailyModelBudget;

/**
 * Reserves `n` calls of each kind, or throws having reserved none.
 *
 * All-or-nothing, so a request that needs both a search and a model call cannot
 * spend the search and then be refused the model call.
 */
export function spend(
  requests: ReadonlyArray<readonly [BudgetKind, number]>,
  now: Date = new Date(),
): void {
  rollOver(now);

  const totals: Record<BudgetKind, number> = { search: 0, model: 0 };
  for (const [kind, n] of requests) totals[kind] += n;

  for (const kind of ["search", "model"] as const) {
    if (used[kind] + totals[kind] > limitFor(kind)) {
      throw new BudgetExhaustedError(kind);
    }
  }
  used.search += totals.search;
  used.model += totals.model;
}

/** What is left today, for logging and tests. */
export function remaining(kind: BudgetKind, now: Date = new Date()): number {
  rollOver(now);
  return Math.max(0, limitFor(kind) - used[kind]);
}

/** Test helper. Not used by the app. */
export function resetBudget(): void {
  used.search = 0;
  used.model = 0;
  day = "";
}
