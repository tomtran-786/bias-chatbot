/**
 * The market lookup, one step per request.
 *
 *   facts   conversation + photos        -> the item                       (1 model call)
 *   search  the item                     -> numbered sources               (3-4 searches)
 *   read    the item + the sources       -> listings, checked against them (1 model call)
 *
 * Split so that each step has a whole 60-second function to itself, a step that
 * fails can be tried again without redoing the ones before it, and the browser can
 * start the lot while the person is still deciding on a price. The browser runs the
 * steps in order (lib/market-client.ts) and computes the figures itself from what
 * `read` returns (lib/pricing.ts); nothing here prices anything.
 *
 * The app searches and the model reads: no call here gives the model a tool.
 * Every price the model reports is checked against the text of the source it cites,
 * in `groundListings`, and a listing in đồng carries the rate it is converted at.
 *
 * None of the steps is shown, or needs, the price the person locks in, which is why
 * the lookup may run before they have set one. What they paid is stripped before
 * anything is searched or read (`forSearch`), exactly as before.
 *
 * Refuses to run before the assistant has spoken and there is a photo. A fact the
 * assistant called complete too early surfaces as `needs_identity` from `facts`,
 * which sends the person back to the questions.
 *
 * Nothing here retries a model call within one step, other than moving to the
 * next model in the chain. The browser retries a whole step once when the failure
 * may pass, and never one that quota, a budget or a refused key caused.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { BudgetExhaustedError, spend } from "@/lib/budget";
import { env } from "@/lib/env";
import {
  MalformedAppraisalError,
  ModelNotFoundError,
  ModelOverloadedError,
  ModelTimeoutError,
  RateLimitError,
  triedNote,
} from "@/lib/gemini";
import { backupNote, extractFacts, primaryOf, readListings } from "@/lib/model";
import {
  WIDEN_BELOW,
  checkPhotos,
  forSearch,
  intakeSchema,
  itemFactsSchema,
  photoSchema,
  searchQueries,
  wideningQuery,
} from "@/lib/item";
import { groundNewPrice, type AppraisalInput } from "@/lib/pricing";
import {
  SearchFailedError,
  SearchQuotaError,
  SearchRateLimitError,
  SearchUnavailableError,
  mergeHits,
  searchListings,
} from "@/lib/search";
import {
  MAX_SOURCES,
  groundListings,
  hasPrice,
  limitSources,
  toSources,
} from "@/lib/sources";
import { readyToPrice } from "@/lib/stages";
import {
  assistantTurns,
  photoCount,
  referencedPhotoIds,
  transcriptSchema,
} from "@/lib/transcript";

/** One step has the whole function: a model chain of two, or a few searches at once. */
export const maxDuration = 60;

const sourceSchema = z.object({
  url: z.string().min(1).max(2000),
  title: z.string().max(400),
  text: z.string().max(4000),
});

const bodySchema = z.discriminatedUnion("step", [
  z.object({
    step: z.literal("facts"),
    intake: intakeSchema,
    photos: z.array(photoSchema),
    transcript: transcriptSchema,
  }),
  z.object({
    step: z.literal("search"),
    item: itemFactsSchema,
    transcript: transcriptSchema,
  }),
  z.object({
    step: z.literal("read"),
    item: itemFactsSchema,
    sources: z.array(sourceSchema).max(MAX_SOURCES),
    transcript: transcriptSchema,
  }),
]);

type Step = z.infer<typeof bodySchema>["step"];

const refuse = (step: Step | "request", error: string, status: number, reason?: string) => {
  // The reason is for whoever is running this; the screen gets plain copy.
  console.warn(`market ${step} refused (${error}, ${status})${reason ? `: ${reason}` : ""}`);
  return NextResponse.json(reason ? { error, reason } : { error }, { status });
};

/** Reserves the calls a step is about to make; a request that cannot be afforded costs nothing. */
function reserve(
  step: Step,
  requests: Parameters<typeof spend>[0],
): NextResponse | null {
  try {
    spend(requests);
    return null;
  } catch (error) {
    if (error instanceof BudgetExhaustedError) return refuse(step, "budget_exhausted", 429);
    throw error;
  }
}

/** What went wrong, as the response the browser understands. */
function failure(step: Step, thrown: unknown): NextResponse {
  // Classified by Gemini's error even when the backup also failed: that is what
  // the person ran into first. What happened to the backup goes in the reason.
  const error = primaryOf(thrown);
  const note = backupNote(thrown);

  // Both are "rate_limited" to the client, but which service said so is the
  // first thing anyone debugging a free tier needs to know.
  if (error instanceof RateLimitError) {
    return refuse(
      step,
      "rate_limited",
      429,
      `Gemini is rate limiting this key (its free quota may be used up).${triedNote(error)}${note}`,
    );
  }
  if (error instanceof ModelOverloadedError) {
    return refuse(
      step,
      "appraisal_failed",
      503,
      `Gemini is overloaded right now. Try again in a moment.${triedNote(error)}${note}`,
    );
  }
  if (error instanceof ModelNotFoundError) {
    return refuse(
      step,
      "appraisal_failed",
      503,
      `None of the configured Gemini models is available to this key.${triedNote(error)} Check GEMINI_MODEL and GEMINI_FALLBACK_MODELS.`,
    );
  }
  if (error instanceof SearchRateLimitError) {
    return refuse(step, "rate_limited", 429, "The search service is rate limiting this key.");
  }
  if (error instanceof ModelTimeoutError) {
    return refuse(step, "appraisal_failed", 504, "The model took too long to answer.");
  }
  if (error instanceof SearchQuotaError) return refuse(step, "search_quota", 429, error.message);
  if (error instanceof SearchUnavailableError) {
    return refuse(step, "search_unavailable", 503, error.message);
  }
  if (error instanceof SearchFailedError) {
    return refuse(step, "search_failed", 502, error.message);
  }

  console.error(`market ${step} failed`, error);
  // The message is surfaced deliberately: "the listing extraction did not match
  // the schema" is the difference between a fixable prompt problem and an
  // opaque failure, and the only person it reaches is the one running this.
  return refuse(
    step,
    "appraisal_failed",
    502,
    error instanceof MalformedAppraisalError ? `${error.message}${note}` : undefined,
  );
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return refuse("request", "invalid_body", 400);
  const body = parsed.data;
  const { step, transcript } = body;

  const photos =
    body.step === "facts" ? checkPhotos(body.photos, referencedPhotoIds(transcript)) : null;
  if (photos && !photos.ok) return refuse(step, photos.error, photos.status);

  const problem = readyToPrice({
    assistantTurns: assistantTurns(transcript),
    photoCount: photoCount(transcript),
    hasAskingPrice: false,
    hasAppraisal: false,
  });
  if (problem) return refuse(step, "out_of_order", 409, `Cannot look up the market yet. ${problem}`);

  const started = Date.now();
  const done = (response: NextResponse) => {
    console.info(`market ${step} took ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return response;
  };

  try {
    switch (body.step) {
      case "facts": {
        const over = reserve(step, [["model", 1]]);
        if (over) return over;

        const backup: Array<{ step: "facts" | "reading"; provider: string }> = [];
        const item = await extractFacts(
          transcript,
          photos?.ok ? photos.photos : [],
          body.intake,
          (provider) => backup.push({ step: "facts", provider }),
        );

        // Without a model name there is nothing to search for, and a search for
        // "phone" would return a market for the wrong thing. Send them back to the
        // questions rather than price a guess.
        if (!item.model.trim()) return refuse(step, "needs_identity", 422);
        return done(NextResponse.json({ item, backup }));
      }

      case "search": {
        if (!body.item.model.trim()) return refuse(step, "needs_identity", 422);

        const safe = forSearch(body.item);
        const queries = searchQueries(safe);
        const over = reserve(step, [["search", queries.length]]);
        if (over) return over;

        const first = await searchListings(queries);
        let hits = first.results;
        const ran = [...first.queries];

        // Thin results are widened once: the model alone, on any site. A failure
        // here costs nothing already found, and a spent budget skips it quietly.
        if (toSources(hits).filter(hasPrice).length < WIDEN_BELOW) {
          try {
            spend([["search", 1]]);
            const wider = await searchListings([wideningQuery(safe)]);
            hits = mergeHits(hits, wider.results);
            ran.push(...wider.queries);
          } catch (error) {
            console.warn("market search: widening skipped:", error instanceof Error ? error.message : error);
          }
        }

        return done(NextResponse.json({ sources: limitSources(toSources(hits)), queries: ran }));
      }

      case "read": {
        const { item, sources } = body;
        if (sources.length > 0) {
          const over = reserve(step, [["model", 1]]);
          if (over) return over;
        }

        const backup: Array<{ step: "facts" | "reading"; provider: string }> = [];
        const reading = await readListings(item, sources, (provider) =>
          backup.push({ step: "reading", provider }),
        );

        // The new price is a ceiling on the suggestion, so it gets the same check a
        // listing does; one the page did not show is left out rather than trusted.
        const newPrice = groundNewPrice(reading.newPrice, sources, env.vndPerUsd);

        const raw: AppraisalInput = {
          item,
          listings: groundListings(reading.listings, sources),
          newPrice: newPrice?.price ?? null,
          newPriceUrl: newPrice?.url ?? null,
          position: reading.position,
          positionEvidence: reading.positionEvidence,
          vndPerUsd: env.vndPerUsd,
        };
        return done(NextResponse.json({ raw, backup }));
      }
    }
  } catch (thrown) {
    return failure(step, thrown);
  }
}
