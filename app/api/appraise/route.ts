/**
 * The market lookup.
 *
 * The one step that is not streamed and not a conversation turn. It reads the
 * item out of the conversation, searches for used listings of it, checks each
 * listing against the page it came from, and works out the market price, a
 * suggested price and the gap to theirs.
 *
 * Every figure in the response is computed here, by lib/pricing.ts, from the
 * listings. The model reports listings and a position; it never states a number
 * that is shown to the person.
 *
 * Refuses to run before the assistant has asked its questions and before the
 * person has locked in their own price. The locked price is the uncoached
 * baseline the whole exercise rests on; looking at the market first would
 * destroy it. And the search is never shown that price, or what they paid — see
 * `searchMarket`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MalformedAppraisalError,
  RateLimitError,
  extractFacts,
  searchMarket,
} from "@/lib/gemini";
import { groundListings } from "@/lib/grounding";
import {
  askingPriceSchema,
  checkPhotos,
  intakeSchema,
  photoSchema,
} from "@/lib/item";
import {
  computeAppraisal,
  type AppraiseResponse,
  type AppraisalInput,
} from "@/lib/pricing";
import { canEnter } from "@/lib/stages";
import {
  assistantTurns,
  photoCount,
  referencedPhotoIds,
  transcriptSchema,
} from "@/lib/transcript";

/** Two model calls and a handful of redirects, in sequence. */
export const maxDuration = 60;

const bodySchema = z.object({
  intake: intakeSchema,
  photos: z.array(photoSchema),
  askingPrice: askingPriceSchema,
  transcript: transcriptSchema,
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { intake, askingPrice, transcript } = parsed.data;

  const checked = checkPhotos(parsed.data.photos, referencedPhotoIds(transcript));
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error }, { status: checked.status });
  }

  const gate = canEnter("appraise", {
    assistantTurns: assistantTurns(transcript),
    photoCount: photoCount(transcript),
    hasAskingPrice: true,
    hasAppraisal: false,
  });
  if (!gate.ok) {
    return NextResponse.json(
      { error: "out_of_order", reason: gate.reason },
      { status: 409 },
    );
  }

  try {
    const item = await extractFacts(transcript, checked.photos, intake);

    // Without a model name there is nothing to search for, and a search for
    // "phone" would return a market for the wrong thing. Send them back to the
    // questions rather than price a guess.
    if (!item.model.trim()) {
      return NextResponse.json({ error: "needs_identity" }, { status: 422 });
    }

    const market = await searchMarket(item);
    const raw: AppraisalInput = {
      item,
      listings: groundListings(market.listings, market.sources),
      newPrice: market.newPrice,
      position: market.position,
      positionEvidence: market.positionEvidence,
    };

    const appraisal = computeAppraisal(raw, askingPrice.usd);
    const body: AppraiseResponse = {
      ...appraisal,
      item,
      raw,
      searchEntryPoint: market.searchEntryPoint,
    };
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    console.error("appraisal failed", error);
    // The message is surfaced deliberately: "the listing extraction did not match
    // the schema" is the difference between a fixable prompt problem and an
    // opaque failure, and the only person it reaches is the one running this.
    return NextResponse.json(
      {
        error: "appraisal_failed",
        reason:
          error instanceof MalformedAppraisalError ? error.message : undefined,
      },
      { status: 502 },
    );
  }
}
