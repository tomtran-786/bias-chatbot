/**
 * What the app knows about the decision itself: the frame the person supplies
 * up front, and the provisional pick they lock in before seeing the grade.
 *
 * The wording here is study content rather than UI copy. What the intake form
 * asks for determines what the assistant has to work with, so changing a label
 * changes the instrument — treat it the way you would treat a protocol edit.
 */
import { z } from "zod";

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;

/**
 * The decision, as stated by the person before the assistant has said anything.
 *
 * Collected as a form rather than elicited in conversation. A Gem can only ask
 * for these in prose and hope; asking for them as fields means the assistant
 * starts from the same four facts every time, which is what makes one run
 * comparable to another.
 */
export type Frame = {
  /** The choice they are about to make, in their own words. */
  decision: string;
  /** The courses of action they see. The recommendation must pick from these. */
  options: string[];
  /** When it has to be settled. */
  deadline: string;
  /** What is riding on it, and how reversible it is. */
  stakes: string;
};

export const frameSchema = z.object({
  decision: z.string().trim().min(1).max(2000),
  options: z
    .array(z.string().trim().min(1).max(300))
    .min(MIN_OPTIONS)
    .max(MAX_OPTIONS),
  deadline: z.string().trim().min(1).max(300),
  stakes: z.string().trim().min(1).max(2000),
});

/** The intake form. Order matters: it is the order the assistant receives them. */
export const FRAME_FIELDS = [
  {
    name: "decision",
    label: "What decision are you about to make?",
    hint: "Something still open. One or two sentences is plenty.",
    placeholder: "Whether to keep going with…",
    lines: 3,
  },
  {
    name: "deadline",
    label: "When do you have to decide by?",
    hint: "A date, or the thing that forces the decision.",
    placeholder: "End of the month, when the renewal comes up",
    lines: 1,
  },
  {
    name: "stakes",
    label: "What is riding on it, and how easily could you undo it?",
    hint: "Money, time, other people — and whether a wrong call is recoverable.",
    placeholder: "About six months of work, and…",
    lines: 3,
  },
] as const;

export const OPTIONS_FIELD = {
  label: "What are the options on the table?",
  hint: `At least ${MIN_OPTIONS}. The recommendation at the end has to be one of these, so list anything you would genuinely consider.`,
} as const;

/**
 * Their own call, recorded before the grade is revealed.
 *
 * This is the step a Gem cannot hold: the corrective only does anything if the
 * person has committed to a position first, and in a chat window they can simply
 * read ahead. Here the grade does not exist until this is submitted.
 */
export type Commitment = {
  /** One of `Frame.options`, verbatim. */
  option: string;
  /** Their own 1-5 rating of how sound their thinking is, on the same scale. */
  selfScore: number;
};

export const commitmentSchema = z.object({
  option: z.string().trim().min(1).max(300),
  selfScore: z.number().int().min(1).max(5),
});

export const COMMITMENT_PROMPT = {
  pick: "Before you see anything: which option would you take right now?",
  scale: "And how sound does your thinking on this feel to you?",
  lowAnchor: "Barely thought it through",
  highAnchor: "Thoroughly worked out",
} as const;

/** The frame as the model receives it, appended to the system instruction. */
export function describeFrame(frame: Frame): string {
  return [
    "## Their decision",
    "",
    `**The decision:** ${frame.decision}`,
    "",
    "**Options on the table** — your recommendation must be one of these, named as they wrote it:",
    ...frame.options.map((option, index) => `${index + 1}. ${option}`),
    "",
    `**Must decide by:** ${frame.deadline}`,
    "",
    `**Stakes and reversibility:** ${frame.stakes}`,
  ].join("\n");
}

/** The locked-in pick as the model receives it, once it exists. */
export function describeCommitment(commitment: Commitment): string {
  return [
    "## Their provisional pick, locked in before you graded",
    "",
    `They would currently choose: ${commitment.option}`,
    `They rate their own thinking at ${commitment.selfScore} out of 5.`,
    "",
    "Do not flatter this and do not defer to it. It is a baseline, not a constraint on what you recommend.",
  ].join("\n");
}
