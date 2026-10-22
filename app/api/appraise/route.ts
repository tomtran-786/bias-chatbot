/**
 * The market lookup.
 *
 * The one step that is not streamed and not a conversation turn. It reads the
 * item out of the conversation, searches the web for used listings of it, has
 * the model read the results, checks every price the model reports against the
 * text it came from, and works out the market price, a suggested price and the
 * gap to theirs.
 *
 *   gate -> budget -> facts -> queries -> search -> sources -> read -> ground -> price
 *
 * The app searches and the model reads: no call here gives the model a tool.
 *
 * Every figure in the response is computed here, by lib/pricing.ts, from the
 * listings. The model reports listings and a position; it never states a number
 * that is shown to the person.
 *
 * Refuses to run before the assistant has asked its questions and before the
 * person has locked in their own price. The locked price is the uncoached
 * baseline the whole exercise rests on; looking at the market first would
 * destroy it. And neither the search queries nor the model that reads the
 * results are ever shown that price, or what they paid.
 *
 * Nothing in this route retries. Every failure ends the request once.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { BudgetExhaustedError, spend } from "@/lib/budget";
import {
  MalformedAppraisalError,
  ModelOverloadedError,
  ModelTimeoutError,
  RateLimitError,
} from "@/lib/gemini";
import { backupNote, extractFacts, primaryOf, readListings } from "@/lib/model";
import {
  QUERY_COUNT,
  askingPriceSchema,
  checkPhotos,
  forSearch,
  intakeSchema,
  photoSchema,
  searchQueries,
} from "@/lib/item";
import {
  computeAppraisal,
  type AppraiseResponse,
  type AppraisalInput,
} from "@/lib/pricing";
import {
  SearchFailedError,
  SearchQuotaError,
  SearchRateLimitError,
  SearchUnavailableError,
  searchListings,
} from "@/lib/search";
import { groundListings, toSources } from "@/lib/sources";
import { canEnter } from "@/lib/stages";
import {
  assistantTurns,
  photoCount,
  referencedPhotoIds,
  transcriptSchema,
} from "@/lib/transcript";

/** Facts, a few searches, and the reading, in sequence. */
export const maxDuration = 60;

/** The model calls one appraisal makes: the facts, and the reading. */
const MODEL_CALLS = 2;

const bodySchema = z.object({
  intake: intakeSchema,
  photos: z.array(photoSchema),
  askingPrice: askingPriceSchema,
  transcript: transcriptSchema,
});

const refuse = (error: string, status: number, reason?: string) =>
  NextResponse.json(reason ? { error, reason } : { error }, { status });

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return refuse("invalid_body", 400);
  const { intake, askingPrice, transcript } = parsed.data;

  const checked = checkPhotos(parsed.data.photos, referencedPhotoIds(transcript));
  if (!checked.ok) return refuse(checked.error, checked.status);

  const gate = canEnter("appraise", {
    assistantTurns: assistantTurns(transcript),
    photoCount: photoCount(transcript),
    hasAskingPrice: true,
    hasAppraisal: false,
  });
  if (!gate.ok) return refuse("out_of_order", 409, gate.reason);

  // Reserved all at once and before anything is called, so a request that
  // cannot be afforded costs nothing and cannot be half-run.
  try {
    spend([
      ["search", QUERY_COUNT],
      ["model", MODEL_CALLS],
    ]);
  } catch (error) {
    if (error instanceof BudgetExhaustedError) return refuse("budget_exhausted", 429);
    throw error;
  }

  // Which steps the backup model took over, so the card can say so.
  const backup: Array<"facts" | "reading"> = [];

  try {
    const item = await extractFacts(transcript, checked.photos, intake, () => {
      backup.push("facts");
    });

    // Without a model name there is nothing to search for, and a search for
    // "phone" would return a market for the wrong thing. Send them back to the
    // questions rather than price a guess.
    if (!item.model.trim()) return refuse("needs_identity", 422);

    const search = await searchListings(searchQueries(forSearch(item)));
    const sources = toSources(search.results);
    const reading = await readListings(item, sources, () => {
      backup.push("reading");
    });

    const raw: AppraisalInput = {
      item,
      listings: groundListings(reading.listings, sources),
      newPrice: reading.newPrice,
      position: reading.position,
      positionEvidence: reading.positionEvidence,
    };

    const appraisal = computeAppraisal(raw, askingPrice.usd);
    const body: AppraiseResponse = {
      ...appraisal,
      item,
      raw,
      queries: search.queries,
      backup,
    };
    return NextResponse.json(body);
  } catch (thrown) {
    // Classified by Gemini's error even when the backup also failed: that is what
    // the person ran into first. What happened to the backup goes in the reason.
    const error = primaryOf(thrown);
    const note = backupNote(thrown);

    // Both are "rate_limited" to the client, but which service said so is the
    // first thing anyone debugging a free tier needs to know.
    if (error instanceof RateLimitError) {
      return refuse(
        "rate_limited",
        429,
        `Gemini is rate limiting this key (its free quota may be used up).${note}`,
      );
    }
    if (error instanceof ModelOverloadedError) {
      return refuse("appraisal_failed", 503, `Gemini is overloaded right now. Try again in a moment.${note}`);
    }
    if (error instanceof SearchRateLimitError) {
      return refuse("rate_limited", 429, "The search service is rate limiting this key.");
    }
    if (error instanceof ModelTimeoutError) {
      return refuse("appraisal_failed", 504, "The model took too long to answer. Try again in a moment.");
    }
    if (error instanceof SearchQuotaError) return refuse("search_quota", 429);
    if (error instanceof SearchUnavailableError) {
      return refuse("search_unavailable", 503, error.message);
    }
    if (error instanceof SearchFailedError) {
      return refuse("search_failed", 502, error.message);
    }

    console.error("appraisal failed", error);
    // The message is surfaced deliberately: "the listing extraction did not match
    // the schema" is the difference between a fixable prompt problem and an
    // opaque failure, and the only person it reaches is the one running this.
    return refuse(
      "appraisal_failed",
      502,
      error instanceof MalformedAppraisalError ? `${error.message}${note}` : undefined,
    );
  }
}
