/**
 * The scorecard.
 *
 * The one turn that is not streamed. It asks the model for the five dimension
 * scores against a response schema, checks them against the rubric, and computes
 * the headline itself — the model is never allowed to state an overall number,
 * because a model asked for parts and a total will bend the total toward the
 * verdict it has already formed.
 *
 * Refuses to grade before the assistant has asked its questions and before the
 * person has locked in their own pick. The locked pick is the uncoached baseline
 * the whole exercise rests on; grading first would destroy it.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { commitmentSchema, frameSchema } from "@/lib/decision";
import { RateLimitError, gradeDecision, type TurnContext } from "@/lib/gemini";
import { RUBRIC } from "@/lib/protocol";
import { headline, scoreCard } from "@/lib/rubric";
import { canEnter } from "@/lib/stages";
import { assistantTurns, transcriptSchema } from "@/lib/transcript";

const bodySchema = z.object({
  frame: frameSchema,
  commitment: commitmentSchema,
  transcript: transcriptSchema,
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { frame, commitment, transcript } = parsed.data;

  const gate = canEnter("grade", {
    assistantTurns: assistantTurns(transcript),
    hasCommitment: true,
    hasGrade: false,
  });
  if (!gate.ok) {
    return NextResponse.json(
      { error: "out_of_order", reason: gate.reason },
      { status: 409 },
    );
  }

  const context: TurnContext = { frame, commitment };

  try {
    const scores = await gradeDecision(transcript, context);
    // Throws on a missing, duplicated or out-of-range dimension: a scorecard
    // that is wrong in those ways would still render as though it meant
    // something, which is worse than showing nothing.
    const dimensions = scoreCard(RUBRIC, scores);
    return NextResponse.json({
      dimensions,
      headline: headline(dimensions),
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    console.error("grading failed", error);
    // The message is surfaced deliberately: "the grade is missing dimension
    // forward_accounting" is the difference between a fixable protocol problem
    // and an opaque failure, and there is no participant here to leak it to.
    return NextResponse.json(
      {
        error: "grade_failed",
        reason: error instanceof Error ? error.message : undefined,
      },
      { status: 502 },
    );
  }
}
