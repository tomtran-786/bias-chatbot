/**
 * Which models have just said no, remembered for a short while.
 *
 * With a chain of models, the first in line is the one most likely to be out of
 * quota, and every call would otherwise open by asking it again and being refused
 * before moving on: a wasted round trip per call, several per appraisal. So a model
 * that was refused is tried last for a minute, and the next call goes straight to
 * one that last worked.
 *
 * Only reordering, never skipping. If every model is cooling down they are all
 * still tried, in order, so this can make a request faster and cannot make it fail.
 *
 * Held in memory, per process. It is a latency optimisation and carries no
 * guarantee, so losing it on a restart costs one refused call.
 */

/** A quota or overload answer: per-minute limits clear fast, so look again soon. */
const TRANSIENT_MS = 60_000;
/** A 404: the name does not exist for this key, and will not tomorrow either. */
const MISSING_MS = 10 * 60_000;

const coolingUntil = new Map<string, number>();

export type Refusal = "transient" | "missing";

export function markUnavailable(model: string, kind: Refusal, now: number = Date.now()): void {
  coolingUntil.set(model, now + (kind === "missing" ? MISSING_MS : TRANSIENT_MS));
}

export function isCoolingDown(model: string, now: number = Date.now()): boolean {
  return (coolingUntil.get(model) ?? 0) > now;
}

/** The models in the order to try them: ones that are not cooling down first, then the rest. */
export function inTryOrder(models: readonly string[], now: number = Date.now()): string[] {
  return [
    ...models.filter((model) => !isCoolingDown(model, now)),
    ...models.filter((model) => isCoolingDown(model, now)),
  ];
}

/** Test helper. Not used by the app. */
export function resetModelHealth(): void {
  coolingUntil.clear();
}
