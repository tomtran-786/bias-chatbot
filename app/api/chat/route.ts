/**
 * One conversational turn.
 *
 * Stateless: there is no database and no session, so the browser sends the whole
 * conversation, the photos and whatever has been locked in, and gets a reply
 * streamed back. Nothing is persisted anywhere.
 *
 * The one thing the server does insist on is that the phase being requested is
 * reachable — that the assistant has actually asked its questions before a price
 * can be recorded, and that there is a market before a verdict. That guards
 * against the model drifting out of order, which is the failure this design
 * exists to prevent. It is not a security boundary; see `canEnter` in
 * lib/stages.ts.
 *
 * Two things it does on the model's behalf. It recomputes every number from the
 * raw listings the browser posts back, so a median the client sends is never
 * believed. And it keeps the locked price and the market out of the intake and
 * question turns, so the assistant cannot be nudged by a figure it must not
 * mention yet.
 *
 * Replies come back as newline-delimited JSON rather than raw text so that phase
 * transitions and quota errors can be signalled mid-stream alongside the words.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import {
  RateLimitError,
  streamReply,
  type TranscriptMessage,
  type TurnContext,
} from "@/lib/gemini";
import {
  MAX_PHOTOS,
  askingPriceSchema,
  checkPhotos,
  intakeSchema,
  photoSchema,
} from "@/lib/item";
import { appraisalInputSchema, computeAppraisal } from "@/lib/pricing";
import { canEnter, type Stage } from "@/lib/stages";
import { MarkerFilter } from "@/lib/stream";
import {
  assistantTurns,
  photoCount,
  referencedPhotoIds,
  transcriptSchema,
  userTurns,
} from "@/lib/transcript";

/** The verdict streams for a while, and a platform's default would cut it off. */
export const maxDuration = 60;

/** The appraise step has its own route; only the streaming phases are served here. */
const bodySchema = z.object({
  phase: z.enum(["intake", "probe", "verdict"]),
  intake: intakeSchema,
  // Size and count are checked by `checkPhotos` rather than here, so an
  // oversized photo is a 413 the client can act on and not a generic 400.
  photos: z.array(photoSchema),
  askingPrice: askingPriceSchema.optional(),
  appraisal: appraisalInputSchema.optional(),
  transcript: transcriptSchema,
  message: z.string().trim().min(1).max(4000),
  /** Photos that first appear in `message`. */
  messagePhotoIds: z.array(z.string().min(1).max(64)).max(MAX_PHOTOS).optional(),
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
  const {
    phase,
    intake,
    askingPrice,
    appraisal: appraisalInput,
    transcript,
    message,
    messagePhotoIds,
  } = parsed.data;

  const history: TranscriptMessage[] = [
    ...transcript,
    {
      role: "user",
      text: message,
      at: new Date().toISOString(),
      photoIds: messagePhotoIds,
    },
  ];

  const checked = checkPhotos(parsed.data.photos, referencedPhotoIds(history));
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error }, { status: checked.status });
  }
  const photos = checked.photos;

  const phaseContext = {
    assistantTurns: assistantTurns(transcript),
    photoCount: photoCount(history),
    hasAskingPrice: askingPrice !== undefined,
    // The figures are computed from the price, so one without the other is none.
    hasAppraisal: appraisalInput !== undefined && askingPrice !== undefined,
  };

  const gate = canEnter(phase, phaseContext);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "out_of_order", reason: gate.reason },
      { status: 409 },
    );
  }

  if (userTurns(transcript) >= env.maxTurns) {
    return NextResponse.json({ error: "turn_limit" }, { status: 429 });
  }

  // Everything below is the verdict's alone. After a failed lookup the person
  // goes back to the questions with their price still locked, and a probe turn
  // that could see it would be answering with the number in its prompt.
  const context: TurnContext = { intake, photoCount: phaseContext.photoCount };
  if (phase === "verdict" && appraisalInput && askingPrice) {
    context.askingPrice = askingPrice;
    context.item = appraisalInput.item;
    context.appraisal = computeAppraisal(appraisalInput, askingPrice.usd);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Event) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      const filter = new MarkerFilter({
        onText: (text) => send({ t: "text", v: text }),
        onStage: (next) => {
          if (next === "complete" && phase === "verdict") {
            send({ t: "stage", v: next });
            return;
          }
          if (next === "commit" && phase !== "verdict") {
            // The reply being written is itself an assistant turn, and counts.
            const early = canEnter("commit", {
              ...phaseContext,
              assistantTurns: phaseContext.assistantTurns + 1,
            });
            if (early.ok) send({ t: "stage", v: next });
            else console.warn("dropped an early commit marker:", early.reason);
          }
          // Anything else is a marker the model was never given.
        },
      });

      try {
        for await (const chunk of streamReply(history, photos, phase, context)) {
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
