/**
 * Thin wrapper over the Gemini SDK.
 *
 * Two shapes of call, because the conversation has two shapes of turn. Probe and
 * recommend are streamed text. The grade is a single non-streaming call against
 * a response schema, so the scorecard arrives as data that can be validated and
 * averaged rather than prose to be picked apart — which is the main thing this
 * app can do that a Gem cannot.
 *
 * The system instruction is assembled from the protocol's Gem-portable core, not
 * the whole document. Sending the model exactly the span that gets pasted into
 * the Gem builder is the entire basis for claiming the two are the same
 * instrument.
 */
import "server-only";
import { ApiError, GoogleGenAI, Type, type Content, type Schema } from "@google/genai";
import {
  describeCommitment,
  describeFrame,
  type Commitment,
  type Frame,
} from "./decision";
import { env } from "./env";
import { GEM_CORE, PROTOCOL_VERSION, RUBRIC } from "./protocol";
import type { DimensionScore, Headline, ScoredDimension } from "./rubric";
import {
  DIMENSION_COUNT,
  SCORE_MAX,
  SCORE_MIN,
  describeGrade,
} from "./rubric";
import { stageInstruction, type Stage } from "./stages";
import type { TranscriptMessage } from "./transcript";

export type { TranscriptMessage };

/** Thrown when the Gemini free-tier quota is exhausted (HTTP 429). */
export class RateLimitError extends Error {
  constructor() {
    super("Gemini quota exhausted");
    this.name = "RateLimitError";
  }
}

/** Thrown when the model returns something that is not a usable scorecard. */
export class MalformedGradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedGradeError";
  }
}

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: env.geminiApiKey });
  return client;
}

/**
 * The marker rule. Appended by the app and absent from the Gem core, because a
 * Gem has nowhere to hide control text — it would print the markers to the
 * person reading.
 */
const MARKER_RULE = [
  "## Control markers",
  "",
  "When, and only when, the current phase's goal is met, emit a marker on its own line at the very end of your turn:",
  "",
  "```",
  "[[STAGE:commit]]      — you have probed enough to score all five dimensions",
  "[[STAGE:complete]]    — you have delivered the recommendation",
  "```",
  "",
  "These two are the only markers you ever emit. Emit at most one per turn, only at a genuine transition, and never in the same turn that a phase began. The person does not see them. Do not mention them.",
].join("\n");

/**
 * Everything about this particular decision that the model needs, assembled
 * fresh on every call because nothing is stored between turns.
 */
export type TurnContext = {
  frame: Frame;
  commitment?: Commitment;
  /** Present from the recommendation turn onward. */
  grade?: { dimensions: ScoredDimension[]; headline: Headline };
};

function systemInstruction(stage: Stage, context: TurnContext): string {
  return [
    `Protocol version: ${PROTOCOL_VERSION}`,
    "",
    GEM_CORE,
    "",
    "---",
    "",
    describeFrame(context.frame),
    ...(context.commitment ? ["", describeCommitment(context.commitment)] : []),
    ...(context.grade
      ? ["", describeGrade(context.grade.dimensions, context.grade.headline)]
      : []),
    "",
    "---",
    "",
    MARKER_RULE,
    "",
    `Current phase: ${stage}. ${stageInstruction(stage)}`,
  ].join("\n");
}

function toContents(transcript: TranscriptMessage[]): Content[] {
  return transcript.map((message) => ({
    role: message.role,
    parts: [{ text: message.text }],
  }));
}

/**
 * Low but not zero. The instrument wants comparable behaviour from one run to
 * the next, which is a reproducibility concern rather than a stylistic one.
 */
const TEMPERATURE = 0.4;

/**
 * Streams the model's reply. Raw text — stage markers are still embedded and
 * must be stripped by the caller before the person sees it.
 */
export async function* streamReply(
  transcript: TranscriptMessage[],
  stage: Stage,
  context: TurnContext,
): AsyncGenerator<string> {
  let stream;
  try {
    stream = await getClient().models.generateContentStream({
      model: env.model,
      contents: toContents(transcript),
      config: {
        systemInstruction: systemInstruction(stage, context),
        temperature: TEMPERATURE,
      },
    });
  } catch (error) {
    throw normalise(error);
  }

  try {
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) yield text;
    }
  } catch (error) {
    throw normalise(error);
  }
}

/**
 * The response schema, built from the protocol's rubric rather than hard-coded,
 * so that swapping the bias after the lottery draft stays a content edit.
 *
 * `id` is an enum over the real dimension ids: the model cannot invent a sixth
 * dimension or misspell one into a silent gap in the scorecard. Range and
 * completeness are re-checked in `scoreCard()` regardless — the schema is a
 * strong hint, not a guarantee.
 */
const GRADE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    dimensions: {
      type: Type.ARRAY,
      minItems: String(DIMENSION_COUNT),
      maxItems: String(DIMENSION_COUNT),
      items: {
        type: Type.OBJECT,
        properties: {
          id: {
            type: Type.STRING,
            format: "enum",
            enum: RUBRIC.map((dimension) => dimension.id),
          },
          score: {
            type: Type.INTEGER,
            minimum: SCORE_MIN,
            maximum: SCORE_MAX,
          },
          why: {
            type: Type.STRING,
            description:
              "One sentence on why this score, addressed to the person.",
          },
          quote: {
            type: Type.STRING,
            description:
              "The person's own words this score rests on, quoted from the conversation and not paraphrased.",
          },
        },
        required: ["id", "score", "why", "quote"],
        propertyOrdering: ["id", "score", "why", "quote"],
      },
    },
  },
  required: ["dimensions"],
};

const GRADE_PROMPT =
  "Grade the decision now, using only what they have told you in this conversation. Score every dimension and quote them for each one.";

/**
 * The scorecard, as a single non-streaming call.
 *
 * Returns raw scores. Validating them against the rubric and deriving the
 * headline is `lib/rubric.ts`'s job, deliberately kept out of the model's reach.
 */
export async function gradeDecision(
  transcript: TranscriptMessage[],
  context: TurnContext,
): Promise<DimensionScore[]> {
  let response;
  try {
    response = await getClient().models.generateContent({
      model: env.model,
      contents: toContents([
        ...transcript,
        { role: "user", text: GRADE_PROMPT, at: new Date().toISOString() },
      ]),
      config: {
        systemInstruction: systemInstruction("grade", context),
        temperature: TEMPERATURE,
        responseMimeType: "application/json",
        responseSchema: GRADE_SCHEMA,
      },
    });
  } catch (error) {
    throw normalise(error);
  }

  const text = response.text;
  if (!text) {
    throw new MalformedGradeError("The model returned an empty grade.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MalformedGradeError("The grade was not valid JSON.");
  }

  const dimensions = (parsed as { dimensions?: unknown }).dimensions;
  if (!Array.isArray(dimensions)) {
    throw new MalformedGradeError("The grade had no dimensions array.");
  }
  return dimensions as DimensionScore[];
}

function normalise(error: unknown): unknown {
  if (error instanceof ApiError && error.status === 429) {
    return new RateLimitError();
  }
  return error;
}
