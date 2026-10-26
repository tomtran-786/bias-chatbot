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
 * as shown in the photos. One question each at most, and the opener already asks
 * the first.
 *
 * It is no longer a count the gate enforces: the assistant decides when it has all
 * four, which may be after one reply if the person gave them in their description.
 * It is how many replies in the person is offered the button for setting their price
 * themselves, in case the assistant forgets to say it is done.
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
    "You are in the INTAKE phase. They have told you what they are selling and attached photos. In one or two sentences say what you believe the item is from the photos and their description, and flag it if the two disagree. Then, before you ask anything, check everything they have already told you, description included, against the four facts: the exact model or variant, what they paid and roughly when, how long they have used it, and its current condition checked against the photos. Ask your first question only about a fact that is still missing or that a photo contradicts, in the same turn. If all four are already covered, say so in one short line and end that turn with the marker for the commit phase instead of asking anything. Do not mention any price, value or market figure. The app has already shown them two reminders and the order of what follows (a few questions, then their own price, then the market): to price it as a buyer would, and to think of the cash selling brings now. Do not repeat either reminder, do not greet them again and do not explain the steps; go straight to what you see.",
  probe:
    "You are in the PROBE phase. Before each question, check the whole conversation, the first description included, against the four facts: the exact model or variant, what they paid and roughly when, how long they have used it, and its current condition checked against the photos. Ask one question per turn, about one fact that is still missing or that a photo contradicts, never several joined together. Never ask for a fact they have already answered and never repeat back their description of the item. What they paid is the second fact: if they give an amount, even with a currency, it is what they paid and not a price they want to sell at. Note it in a few words and go on to the next missing fact. Follow up where an answer was thin or a photo contradicts it, and you may ask for another photo. Do not state any price, estimate or market figure, and do not name any bias. When all four are covered, say in one short line that you have what you need and end that turn with the marker for the commit phase. Only if they say what they want to sell it for, or ask what it is worth, do not weigh it up and never write the verdict's sections (Suggested price, Why this price, Where to sell, What would change this): there is no market data yet, so anything you wrote would be invented. In that case say in one line that they will set their price in the price box once the questions are done, and if all four facts are covered end that turn with the marker for the commit phase.",
  commit:
    "They are locking in the price they would list it at, before seeing any market data. Acknowledge it in one line. Do not comment on the number and do not mention any other price.",
  appraise:
    "The app is searching the market and computing the figures. You do not speak in this phase.",
  verdict:
    "You are in the VERDICT phase. Use only the figures in the appraisal above — never compute, estimate or restate a different price. Write exactly four sections under these headings: Suggested price, Why this price, Where to sell, What would change this. Name the bias only if the appraisal says overpriced is true; when it is, tie the gap back to the two reminders they were shown at the start: what a buyer arriving now would pay, and that an item that does not sell keeps taking space instead of becoming cash they can use. End the turn with the completion marker.",
  complete:
    "The conversation is finished. If they write again, answer briefly within what has already been said and do not open a new line of questioning.",
};

export function stageInstruction(stage: Stage): string {
  return STAGE_INSTRUCTIONS[stage];
}

/**
 * The verdict opens with its first section's heading, and nothing outside the
 * verdict phase may. A reply that does is the model writing a verdict with no
 * market behind it — which it will, if it is handed a price in the chat while the
 * phase is still the questions — so the route replaces it instead of showing it.
 *
 * Anchored at the start on purpose: "before I suggest a price" in a question is
 * not the heading, and a verdict that starts with a preamble is rare enough that
 * holding more of every reply back to catch it would cost the questions their
 * streaming.
 */
const VERDICT_OPENING = /^[\s#*_>-]*suggested price\b/i;

export function opensLikeVerdict(text: string): boolean {
  return VERDICT_OPENING.test(text);
}

/**
 * The first line of every system instruction (`systemInstruction` in
 * lib/prompts.ts). A reply that begins with it is the model reading its own
 * instructions back to the person — seen once in three replays of a price typed
 * into the chat — which the protocol forbids and the person must never see. Like
 * the verdict check it only catches a reply that starts this way; a test ties it
 * to the real first line so renaming one cannot silently disarm the other.
 */
const PROMPT_OPENING = /^[\s#*_>-]*protocol version\b/i;

export function opensLikePrompt(text: string): boolean {
  return PROMPT_OPENING.test(text);
}

/** How much of a non-verdict reply is held back before it can be judged. */
export const VERDICT_CHECK_LENGTH = 24;

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

/**
 * What must be true before a price can be recorded or the market looked up: the
 * assistant has spoken at least once (a reply that is still being written counts,
 * so the caller adds it) and has a photo to check the condition against. How many
 * facts it has is the assistant's call, not a count; `facts` in the market route
 * is the safety net if it called it too early.
 *
 * Shared by the commit and appraise gates and the market route, which needs no
 * price: no market step is ever shown one.
 */
export function readyToPrice(context: PhaseContext): string | null {
  if (context.assistantTurns < 1) {
    return "The assistant has not spoken yet, so there is nothing for a price to follow.";
  }
  if (context.photoCount < 1) {
    return "There is no photo yet. The assistant needs at least one to check the condition against.";
  }
  return null;
}

/**
 * Whether the questions have run their course by count, for the places that offer
 * the price box on the person's own say-so: the "ready to set my price" button, and
 * the page a reply that drifted into a verdict sends them to. An assistant that
 * emits the commit marker earlier is believed; these two are not that.
 */
export function askedEnough(context: PhaseContext): boolean {
  return context.assistantTurns >= FACT_COUNT && readyToPrice(context) === null;
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
