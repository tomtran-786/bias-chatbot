/**
 * The six phases of an appraisal, the per-phase instruction appended to the
 * system prompt, the parser for the `[[STAGE:x]]` markers the model emits, and
 * the reachability rules the API enforces.
 *
 * Two phases are driven by the model (it knows when it has asked enough, and
 * when the verdict is delivered) and the rest by the app. Hard-coding every
 * transition on the server would mean maintaining a second, competing copy of
 * the protocol; leaving every transition to the model means watching it quote a
 * price before it has asked anything. The split puts each decision where the
 * information is.
 *
 * The marker token is still spelled `[[STAGE:` rather than `[[PHASE:`. That is
 * deliberate: `lib/stream.ts` and its chunk-boundary tests are the one place a
 * bug would leak control text into what the person reads, and they are worth
 * more intact than renamed.
 */

export const STAGES = [
  "intake",
  "probe",
  "commit",
  "appraise",
  "verdict",
  "complete",
] as const;

export type Stage = (typeof STAGES)[number];

export const FIRST_STAGE: Stage = "intake";

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/**
 * The facts the assistant has to cover before the price is asked for: which
 * model, what was paid and when, how long it has been used, and the condition
 * as shown in the photos. One question each, and the opener already asks the
 * first, so this is also the number of assistant turns needed.
 */
export const FACT_COUNT = 4;

/** Labels for the progress rail. */
export const STAGE_LABELS: Record<Stage, string> = {
  intake: "Your item",
  probe: "Questions",
  commit: "Your price",
  appraise: "The market",
  verdict: "Verdict",
  complete: "Finished",
};

export const STAGE_INSTRUCTIONS: Record<Stage, string> = {
  intake:
    "You are in the INTAKE phase. They have told you what they are selling and attached photos. In one or two sentences say what you believe the item is from the photos and their description, and flag it if the two disagree. Then ask your first question in the same turn. Do not mention any price, value or market figure.",
  probe:
    "You are in the PROBE phase. Ask one question per turn — one thing, never several joined together — until you have all four facts: the exact model or variant, what they paid and roughly when, how long they have used it, and its current condition checked against the photos. Follow up where an answer was thin or a photo contradicts it, and you may ask for another photo. Do not state any price, estimate or market figure, and do not name any bias. When all four are covered, say you have what you need and end that turn with the marker for the commit phase.",
  commit:
    "They are locking in the price they would list it at, before seeing any market data. Acknowledge it in one line. Do not comment on the number and do not mention any other price.",
  appraise:
    "The app is searching the market and computing the figures. You do not speak in this phase.",
  verdict:
    "You are in the VERDICT phase. Use only the figures in the appraisal above — never compute, estimate or restate a different price. Write exactly four sections under these headings: Suggested price, Why this price, Where to sell, What would change this. Name the bias only if the appraisal says overpriced is true. End the turn with the completion marker.",
  complete:
    "The conversation is finished. If they write again, answer briefly within what has already been said and do not open a new line of questioning.",
};

export function stageInstruction(stage: Stage): string {
  return STAGE_INSTRUCTIONS[stage];
}

/** What the server knows about a request, for deciding whether it is in order. */
export type PhaseContext = {
  /** Assistant turns so far. One question per turn, so this counts questions. */
  assistantTurns: number;
  /** Distinct photos the conversation has shown the assistant. */
  photoCount: number;
  hasAskingPrice: boolean;
  hasAppraisal: boolean;
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The two checks that both the commit and appraise gates share. */
function readyToPrice(context: PhaseContext): string | null {
  if (context.assistantTurns < FACT_COUNT) {
    return `The assistant must ask at least ${FACT_COUNT} questions — one per fact it needs — before a price can be recorded. It has asked ${context.assistantTurns}.`;
  }
  if (context.photoCount < 1) {
    return "There is no photo yet. The assistant needs at least one to check the condition against.";
  }
  return null;
}

/**
 * Whether `stage` is legally reachable given what the client has sent.
 *
 * This guards against the model drifting out of order — asking for a price after
 * one question, delivering a verdict before there is a market — which is the
 * failure this design exists to prevent. It is not a security boundary: there is
 * no server-side state, so the person holding the conversation could construct
 * any payload they liked. They are the person being helped, so that is fine; it
 * is worth being clear that the guarantee is against drift, not against
 * tampering.
 */
export function canEnter(
  stage: Stage,
  context: PhaseContext,
): { ok: true } | { ok: false; reason: string } {
  switch (stage) {
    case "intake":
    case "probe":
      return { ok: true };

    case "commit": {
      const problem = readyToPrice(context);
      return problem ? { ok: false, reason: problem } : { ok: true };
    }

    case "appraise": {
      const problem = readyToPrice(context);
      if (problem) {
        return {
          ok: false,
          reason: `Cannot look up the market yet. ${problem}`,
        };
      }
      return context.hasAskingPrice
        ? { ok: true }
        : {
            ok: false,
            reason:
              "Cannot look up the market before they have locked in their own price. The uncoached baseline has to be recorded first.",
          };
    }

    case "verdict":
      return context.hasAppraisal
        ? { ok: true }
        : {
            ok: false,
            reason: `Cannot give a verdict before the market has been looked up (${plural(context.assistantTurns, "question")} asked so far).`,
          };

    case "complete":
      return { ok: true };
  }
}

const MARKER_OPEN = "[[STAGE:";
const MARKER_RE = /\[\[STAGE:([a-z_]+)\]\]/g;

/**
 * Strips every complete stage marker from `text` and returns the stages found.
 */
export function extractMarkers(text: string): {
  cleaned: string;
  stages: Stage[];
} {
  const stages: Stage[] = [];
  const cleaned = text.replace(MARKER_RE, (_match, name: string) => {
    if (isStage(name)) stages.push(name);
    return "";
  });
  return { cleaned, stages };
}

/**
 * True when `tail` could still grow into a complete marker, and so must be held
 * back rather than streamed to the person. Markers can straddle chunk
 * boundaries, so without this they briefly see "[[STAGE:".
 */
function isPartialMarker(tail: string): boolean {
  if (MARKER_OPEN.startsWith(tail)) return true;
  if (tail.startsWith(MARKER_OPEN)) return !tail.includes("]]");
  return false;
}

/** Derived from the stage names, so renaming a phase cannot invalidate it. */
const MAX_MARKER_LENGTH =
  MARKER_OPEN.length +
  Math.max(...STAGES.map((stage) => stage.length)) +
  "]]".length;

/**
 * Given the unemitted buffer, returns the index up to which it is safe to emit.
 * Anything after that index might be the beginning of a marker.
 *
 * Scans forward from the earliest position a marker could still start, because
 * the *earliest* such position is the one that must be held back: searching
 * backwards from the end would find the second "[" of "[[STAGE:" and emit the
 * first one.
 */
export function safeEmitLength(buffer: string): number {
  const from = Math.max(0, buffer.length - MAX_MARKER_LENGTH);
  for (let i = from; i < buffer.length; i++) {
    if (buffer[i] === "[" && isPartialMarker(buffer.slice(i))) return i;
  }
  return buffer.length;
}
