/**
 * The scorecard: its dimensions, and the headline score derived from them.
 *
 * The dimensions are not defined here. They live in the ```rubric block of the
 * protocol document, because the Gem reads that same block as instructions and
 * two copies of a rubric drifting apart would mean the app and the Gem were
 * quietly grading different things. This module only parses and validates it.
 *
 * Deliberately free of `server-only` imports: the grade route sends dimension
 * labels to the browser, and the headline is computed from the model's scores
 * rather than asked for, so both sides need these types.
 */

export const SCORE_MIN = 1;
export const SCORE_MAX = 5;

/** Exactly five, always: two fixed, three bias-specific. */
export const DIMENSION_COUNT = 5;

export type Dimension = {
  id: string;
  label: string;
  /** What a score of SCORE_MIN looks like in the person's own reasoning. */
  low: string;
  /** What a score of SCORE_MAX looks like. */
  high: string;
};

export type DimensionScore = {
  id: string;
  score: number;
  /** One line on why this score, in the assistant's words. */
  why: string;
  /** The participant's own words the score rests on. */
  quote: string;
};

/** A scored dimension joined to its definition, ready to render. */
export type ScoredDimension = DimensionScore & { label: string };

export type Headline = {
  /** Mean of the five dimension scores, to one decimal place. */
  mean: number;
  band: string;
  /** Plain-language gloss on the band, shown under the number. */
  gloss: string;
};

/**
 * Bands, highest first. Read the first whose threshold the mean clears.
 *
 * The bands are deliberately coarse. A mean of five subjective 1-5 judgements
 * does not support finer resolution than this, and presenting it as though it
 * did would be the same overclaiming the rubric tells the model to avoid.
 */
const BANDS: ReadonlyArray<{ min: number; band: string; gloss: string }> = [
  {
    min: 4.2,
    band: "Ready to decide",
    gloss: "The reasoning holds up on every dimension we looked at.",
  },
  {
    min: 3.4,
    band: "Mostly sound",
    gloss: "Broadly well reasoned, with one or two soft spots worth closing.",
  },
  {
    min: 2.6,
    band: "Worth another look",
    gloss: "Real gaps in the reasoning, but nothing that cannot be filled in.",
  },
  {
    min: 1.8,
    band: "Shaky",
    gloss: "Most of the decision is resting on things that have not been checked.",
  },
  {
    min: 0,
    band: "Not ready",
    gloss: "There is not yet enough here to choose between the options.",
  },
];

/**
 * The overall score, computed here rather than asked of the model.
 *
 * A model asked for both parts and a total will nudge the total toward whatever
 * verdict it has already formed. Deriving it means the only thing the model can
 * assert is a per-dimension score it had to quote the person to justify.
 */
export function headline(scores: readonly DimensionScore[]): Headline {
  if (scores.length === 0) throw new Error("headline() needs at least one score");
  const raw = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  const mean = Math.round(raw * 10) / 10;
  const match = BANDS.find((b) => mean >= b.min) ?? BANDS[BANDS.length - 1];
  return { mean, band: match.band, gloss: match.gloss };
}

const RUBRIC_BLOCK = /```rubric\s*\n([\s\S]*?)```/;

/**
 * Pulls the rubric out of a protocol document.
 *
 * Throws rather than degrades: a protocol whose rubric is missing, malformed or
 * still carrying template placeholders would otherwise produce a scorecard that
 * looks authoritative and grades nothing. Called at module load, so that failure
 * lands at startup.
 */
export function parseRubric(protocolText: string): Dimension[] {
  const block = protocolText.match(RUBRIC_BLOCK);
  if (!block) {
    throw new Error(
      "The protocol has no ```rubric block. See protocols/README.md.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block[1]);
  } catch (error) {
    throw new Error(
      `The protocol's rubric block is not valid JSON: ${(error as Error).message}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length !== DIMENSION_COUNT) {
    throw new Error(
      `The rubric must define exactly ${DIMENSION_COUNT} dimensions; found ${
        Array.isArray(parsed) ? parsed.length : typeof parsed
      }.`,
    );
  }

  const dimensions = parsed.map((entry, index) => {
    const fields = ["id", "label", "low", "high"] as const;
    for (const field of fields) {
      const value = (entry as Record<string, unknown>)[field];
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
          `Rubric dimension ${index + 1} is missing a non-empty "${field}".`,
        );
      }
      if (value.includes("TODO")) {
        throw new Error(
          `Rubric dimension ${index + 1} still has a TODO in "${field}". Fill the template in before running it — see protocols/README.md.`,
        );
      }
    }
    return entry as Dimension;
  });

  const ids = new Set(dimensions.map((d) => d.id));
  if (ids.size !== dimensions.length) {
    throw new Error("Rubric dimension ids must be unique.");
  }

  return dimensions;
}

/**
 * Validates a scorecard from the model and joins it to the rubric.
 *
 * The response schema constrains shape but not values: it cannot require that
 * every dimension is present exactly once, that no extra id is invented, or that
 * scores sit in range. Checked here so a bad scorecard is rejected rather than
 * rendered as though it were a real assessment.
 */
export function scoreCard(
  dimensions: readonly Dimension[],
  scores: readonly DimensionScore[],
): ScoredDimension[] {
  const byId = new Map(scores.map((s) => [s.id, s]));
  if (byId.size !== scores.length) {
    throw new Error("The grade scored the same dimension more than once.");
  }

  return dimensions.map((dimension) => {
    const scored = byId.get(dimension.id);
    if (!scored) {
      throw new Error(`The grade is missing dimension "${dimension.id}".`);
    }
    if (
      !Number.isInteger(scored.score) ||
      scored.score < SCORE_MIN ||
      scored.score > SCORE_MAX
    ) {
      throw new Error(
        `Dimension "${dimension.id}" was scored ${scored.score}, outside ${SCORE_MIN}-${SCORE_MAX}.`,
      );
    }
    return { ...scored, label: dimension.label };
  });
}

/**
 * The scorecard as the model receives it back on the recommendation turn.
 *
 * The grade is a separate, stateless call, so by the time the assistant is asked
 * to recommend it has no memory of what it scored. Without this the
 * recommendation would be argued from a scorecard the model is reconstructing
 * from impression — which is exactly the drift the split was meant to remove.
 */
export function describeGrade(
  scored: readonly ScoredDimension[],
  overall: Headline,
): string {
  return [
    "## The grade you already gave this decision",
    "",
    ...scored.map(
      (dimension) =>
        `- **${dimension.label}** — ${dimension.score}/${SCORE_MAX}. ${dimension.why} (Their words: "${dimension.quote}")`,
    ),
    "",
    `Overall, computed from those scores: ${overall.mean}/${SCORE_MAX} — ${overall.band}.`,
    "",
    "Argue from these scores. Do not re-grade, do not contradict a score you gave, and do not state a different overall figure.",
  ].join("\n");
}
