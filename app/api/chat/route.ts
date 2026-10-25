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
import { BudgetExhaustedError, spend } from "@/lib/budget";
import { env } from "@/lib/env";
import {
  ModelOverloadedError,
  RateLimitError,
  type TranscriptMessage,
  type TurnContext,
} from "@/lib/gemini";
import { primaryOf, streamReply } from "@/lib/model";
import {
  MAX_PHOTOS,
  askingPriceSchema,
  checkPhotos,
  intakeSchema,
  photoSchema,
} from "@/lib/item";
import { appraisalInputSchema, computeAppraisal } from "@/lib/pricing";
import {
  VERDICT_CHECK_LENGTH,
  askedEnough,
  canEnter,
  opensLikePrompt,
  opensLikeVerdict,
  type Stage,
} from "@/lib/stages";
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

/** The market lookup has its own route; only the streaming phases are served here. */
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
  /**
   * Their price is locked in, though not sent: a lookup that sent them back to the
   * questions leaves it so. Tells the assistant not to ask for it again.
   */
  priceLocked: z.boolean().optional(),
});

type Event =
  | { t: "text"; v: string }
  | { t: "stage"; v: Stage }
  /** Told to the person when the backup model is the one answering. */
  | { t: "notice"; v: "backup_model"; provider: string }
  | { t: "error"; code: "rate_limited" | "model_overloaded" | "server_error" };

/**
 * What the person is told instead when a reply outside the verdict opens like one.
 * Written by the app, so it can be trusted to say the right thing: the model has
 * just shown it will answer a price typed into the chat as if it had a market.
 */
const TAKE_PRICE_IN_BOX =
  "Thanks. Enter your price in the box below and lock it in, and I'll look up the market against it.";
/** The same, once the price is already locked and the way on is the lookup button. */
const PRICE_ALREADY_LOCKED =
  "Your price is locked in — press Look up the market when you're ready.";
const REPLY_WENT_WRONG =
  "Sorry, that reply went wrong. Please send your last message again.";
const FINISH_QUESTIONS_FIRST =
  "I can't weigh in on a price yet: I have no market data, and I'm still getting the details I need. Let's finish the questions first, then you'll set your price before I look anything up.";

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
    priceLocked,
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

  // One model call per turn. Checked before the stream opens so a refusal is a
  // plain 429 the client can read, not an error half way through a reply.
  try {
    spend([["model", 1]]);
  } catch (error) {
    if (error instanceof BudgetExhaustedError) {
      return NextResponse.json({ error: "budget_exhausted" }, { status: 429 });
    }
    throw error;
  }

  // Everything below is the verdict's alone. After a failed lookup the person
  // goes back to the questions with their price still locked, and a probe turn
  // that could see it would be answering with the number in its prompt.
  const context: TurnContext = {
    intake,
    photoCount: phaseContext.photoCount,
    ...(phase !== "verdict" && priceLocked ? { priceLocked: true } : {}),
  };
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
            // The reply being written is itself an assistant turn, and counts. The
            // assistant decides when it has the facts, so one reply is enough.
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

      // Outside the verdict, the first few words are held until they can be
      // judged: a reply that opens as a verdict is never shown (see
      // `opensLikeVerdict`). After that the reply streams as before.
      let judged = phase === "verdict";
      let held = "";

      try {
        const onFallback = (provider: string) =>
          send({ t: "notice", v: "backup_model", provider });

        /** What a held reply turned out to be, if it should not be shown. */
        const driftOf = (text: string) =>
          opensLikeVerdict(text) ? "verdict" : opensLikePrompt(text) ? "prompt" : null;
        let drifted: "verdict" | "prompt" | null = null;
        for await (const chunk of streamReply(history, photos, phase, context, onFallback)) {
          if (judged) {
            filter.push(chunk);
            continue;
          }
          held += chunk;
          if (held.trim().length < VERDICT_CHECK_LENGTH) continue;
          judged = true;
          drifted = driftOf(held);
          if (drifted) break;
          filter.push(held);
        }
        if (!judged && held) {
          // A reply too short to have been judged mid-stream.
          drifted = driftOf(held);
          if (!drifted) filter.push(held);
        }

        if (drifted) {
          console.warn(
            `dropped a reply that ${drifted === "prompt" ? "began with the system prompt" : "was shaped like a verdict"} in the ${phase} phase`,
          );
          // Once the questions are done the next step is the price box whatever
          // the model said, so that is where the person is sent; with the price
          // already locked it is the lookup button. Before then the reply is
          // replaced and nothing else changes.
          const ready = askedEnough({
            ...phaseContext,
            assistantTurns: phaseContext.assistantTurns + 1,
          });
          send({
            t: "text",
            v: ready
              ? priceLocked
                ? PRICE_ALREADY_LOCKED
                : TAKE_PRICE_IN_BOX
              : drifted === "prompt"
                ? REPLY_WENT_WRONG
                : FINISH_QUESTIONS_FIRST,
          });
          if (ready && !priceLocked) send({ t: "stage", v: "commit" });
        } else {
          filter.end();
        }
      } catch (error) {
        // Whatever was generated before the failure still reaches the person,
        // including the few words held back above.
        if (!judged && held && !opensLikeVerdict(held) && !opensLikePrompt(held)) {
          filter.push(held);
        }

        // Classified by Gemini's error even when the backup failed too: that is
        // the failure the person ran into first, and the backup's is logged.
        const cause = primaryOf(error);
        if (cause instanceof RateLimitError) {
          send({ t: "error", code: "rate_limited" });
        } else if (cause instanceof ModelOverloadedError) {
          send({ t: "error", code: "model_overloaded" });
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
