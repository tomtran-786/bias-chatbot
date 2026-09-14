/**
 * The five phases of a decision, the per-phase instruction appended to the
 * system prompt, the parser for the `[[STAGE:x]]` markers the model emits, and
 * the reachability rules the API enforces.
 *
 * Two phases are driven by the model (it knows when it has probed enough, and
 * when the recommendation is delivered) and the rest by the app. Hard-coding
 * every transition on the server would mean maintaining a second, competing copy
 * of the protocol; leaving every transition to the model means watching it grade
 * before it has asked anything. The split puts each decision where the
 * information is.
 *
 * The marker token is still spelled `[[STAGE:` rather than `[[PHASE:`. That is
 * deliberate: `lib/stream.ts` and its chunk-boundary tests are the one place a
 * bug would leak control text into what the person reads, and they are worth
 * more intact than renamed.
 */
import { DIMENSION_COUNT } from "./rubric";

export const STAGES = [
  "frame",
  "probe",
  "commit",
  "grade",
  "recommend",
  "complete",
] as const;

export type Stage = (typeof STAGES)[number];

export const FIRST_STAGE: Stage = "frame";

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/** Labels for the progress rail. */
export const STAGE_LABELS: Record<Stage, string> = {
  frame: "Your decision",
  probe: "Questions",
  commit: "Your call",
  grade: "The grade",
  recommend: "Recommendation",
  complete: "Finished",
};

const STAGE_INSTRUCTIONS: Record<Stage, string> = {
  frame:
    "You are in the FRAME phase. Restate their decision in one sentence and say what is about to happen. Do not start scoring.",
  probe:
    "You are in the PROBE phase. Ask one question per turn, working through the probe questions and following up where an answer was thin. Do not grade, do not advise, and do not name the bias. When you could quote them on all five dimensions, say so and end that turn with the marker for the commit phase.",
  commit:
    "They are recording their own provisional pick. Acknowledge it in one line and do not comment on it or try to influence it.",
  grade:
    "You are in the GRADE phase. Emit the five dimension scores and nothing else — no preamble, no recommendation, and no overall or average score.",
  recommend:
    "You are in the RECOMMEND phase. Recommend exactly one of the options they listed, under the four required headings, leaning on their lowest-scoring dimensions and applying the anchor study's corrected framing to their situation. End the turn with the completion marker.",
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
  hasCommitment: boolean;
  hasGrade: boolean;
};

const plural = (n: number) => `${n} question${n === 1 ? "" : "s"}`;

/**
 * Whether `stage` is legally reachable given what the client has sent.
 *
 * This guards against the model drifting out of order — grading after two
 * questions, recommending before it has graded — which is the failure this
 * design exists to prevent. It is not a security boundary: there is no
 * server-side state, so the person holding the conversation could construct any
 * payload they liked. They are the person being helped, so that is fine; it is
 * worth being clear that the guarantee is against drift, not against tampering.
 */
export function canEnter(
  stage: Stage,
  context: PhaseContext,
): { ok: true } | { ok: false; reason: string } {
  switch (stage) {
    case "frame":
    case "probe":
      return { ok: true };

    case "commit":
      return context.assistantTurns >= DIMENSION_COUNT
        ? { ok: true }
        : {
            ok: false,
            reason: `The assistant must ask at least ${DIMENSION_COUNT} questions — one per scored dimension — before a pick can be recorded. It has asked ${context.assistantTurns}.`,
          };

    case "grade":
      if (context.assistantTurns < DIMENSION_COUNT) {
        return {
          ok: false,
          reason: `Cannot grade after ${plural(context.assistantTurns)}; every one of the ${DIMENSION_COUNT} dimensions has to have been asked about.`,
        };
      }
      return context.hasCommitment
        ? { ok: true }
        : {
            ok: false,
            reason:
              "Cannot grade before they have recorded their own pick. The uncoached baseline has to be locked in first.",
          };

    case "recommend":
      return context.hasGrade
        ? { ok: true }
        : { ok: false, reason: "Cannot recommend before the grade exists." };

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
