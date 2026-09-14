/**
 * One conversational turn.
 *
 * Stateless: there is no database and no session, so the browser sends the whole
 * conversation and gets a reply streamed back. Nothing is persisted anywhere.
 *
 * The one thing the server does insist on is that the phase being requested is
 * reachable — that the assistant has actually asked its questions before a grade
 * can follow, and has actually graded before it recommends. That guards against
 * the model drifting out of order, which is the failure this design exists to
 * prevent. It is not a security boundary; see `canEnter` in lib/stages.ts.
 *
 * Replies come back as newline-delimited JSON rather than raw text so that phase
 * transitions and quota errors can be signalled mid-stream alongside the words.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { commitmentSchema, frameSchema } from "@/lib/decision";
import { env } from "@/lib/env";
import {
  RateLimitError,
  streamReply,
  type TranscriptMessage,
  type TurnContext,
} from "@/lib/gemini";
import { headline, type ScoredDimension } from "@/lib/rubric";
import { canEnter, isStage, type Stage } from "@/lib/stages";
import { MarkerFilter } from "@/lib/stream";
import { assistantTurns, transcriptSchema, userTurns } from "@/lib/transcript";

const scoredSchema = z.array(
  z.object({
    id: z.string(),
    label: z.string(),
    score: z.number().int().min(1).max(5),
    why: z.string(),
    quote: z.string(),
  }),
);

/** Only the two streaming phases are served here; grading has its own route. */
const bodySchema = z.object({
  phase: z.enum(["frame", "probe", "recommend"]),
  frame: frameSchema,
  commitment: commitmentSchema.optional(),
  grade: scoredSchema.optional(),
  transcript: transcriptSchema,
  message: z.string().trim().min(1).max(4000),
});

type Event =
  | { t: "text"; v: string }
  | { t: "stage"; v: Stage }
  | { t: "error"; code: "rate_limited" | "server_error" };

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { phase, frame, commitment, grade, transcript, message } = parsed.data;

  if (!isStage(phase)) {
    return NextResponse.json({ error: "unknown_phase" }, { status: 400 });
  }

  const gate = canEnter(phase, {
    assistantTurns: assistantTurns(transcript),
    hasCommitment: commitment !== undefined,
    hasGrade: grade !== undefined,
  });
  if (!gate.ok) {
    return NextResponse.json(
      { error: "out_of_order", reason: gate.reason },
      { status: 409 },
    );
  }

  if (userTurns(transcript) >= env.maxTurns) {
    return NextResponse.json({ error: "turn_limit" }, { status: 429 });
  }

  const context: TurnContext = {
    frame,
    commitment,
    grade: grade
      ? {
          dimensions: grade as ScoredDimension[],
          headline: headline(grade),
        }
      : undefined,
  };

  const history: TranscriptMessage[] = [
    ...transcript,
    { role: "user", text: message, at: new Date().toISOString() },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Event) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      const filter = new MarkerFilter({
        onText: (text) => send({ t: "text", v: text }),
        onStage: (next) => send({ t: "stage", v: next }),
      });

      try {
        for await (const chunk of streamReply(history, phase, context)) {
          filter.push(chunk);
        }
        filter.end();
      } catch (error) {
        if (error instanceof RateLimitError) {
          send({ t: "error", code: "rate_limited" });
        } else {
          console.error("chat turn failed", error);
          send({ t: "error", code: "server_error" });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
