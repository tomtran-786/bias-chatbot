/**
 * What the app knows about the item itself: the photos and one-line description
 * the seller supplies up front, the facts extracted from the conversation, and
 * the asking price they lock in before seeing the market.
 *
 * The wording here is study content rather than UI copy. The asking-price
 * prompt in particular is the measurement the anchor study (Novemsky & Kahneman
 * 2005) rests on — what an owner would sell for — so changing it changes the
 * instrument. Treat it the way you would treat a protocol edit.
 */
import { z } from "zod";

/** Photos the intake form accepts. More can be added during the questions. */
export const INTAKE_MAX_PHOTOS = 4;
/** Photos in one conversation, intake and follow-ups together. */
export const MAX_PHOTOS = 6;

export const PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoMime = (typeof PHOTO_MIMES)[number];

/** Decoded size ceiling per photo. The browser re-encodes well under this. */
export const MAX_PHOTO_BYTES = 400 * 1024;

/**
 * A photo as it travels between browser and API. The server holds nothing, so
 * the browser re-posts every photo with every turn; transcript messages refer to
 * them by `id` so each is sent once rather than once per message.
 */
export type Photo = {
  id: string;
  mime: PhotoMime;
  /** Base64, no `data:` prefix. */
  data: string;
};

export const photoSchema = z.object({
  id: z.string().min(1).max(64),
  mime: z.enum(PHOTO_MIMES),
  data: z.string().min(1),
});

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded byte length of a base64 string, without decoding it. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * What is wrong with a set of photos, if anything. Separate from the zod schema
 * so an oversized photo can be told apart from a malformed one: the first is a
 * 413 the client can act on by re-encoding, the second is a plain 400.
 */
export function photoProblem(
  photos: readonly Photo[],
): "payload_too_large" | "invalid_photo" | null {
  if (photos.length > MAX_PHOTOS) return "payload_too_large";
  if (photos.some((photo) => base64Bytes(photo.data) > MAX_PHOTO_BYTES)) {
    return "payload_too_large";
  }
  if (photos.some((photo) => !BASE64.test(photo.data))) return "invalid_photo";
  return null;
}

/** First occurrence wins. The client dedupes already; this is the backstop. */
export function dedupePhotos(photos: readonly Photo[]): Photo[] {
  const seen = new Set<string>();
  return photos.filter((photo) => {
    if (seen.has(photo.id)) return false;
    seen.add(photo.id);
    return true;
  });
}

export type PhotoCheck =
  | { ok: true; photos: Photo[] }
  | { ok: false; status: 400 | 413; error: string };

/**
 * The photo checks both routes make before touching the model: dedupe, size and
 * count, encoding, and that every photo a message points at was actually sent.
 */
export function checkPhotos(
  photos: readonly Photo[],
  referencedIds: readonly string[],
): PhotoCheck {
  const unique = dedupePhotos(photos);

  const problem = photoProblem(unique);
  if (problem) {
    return {
      ok: false,
      status: problem === "payload_too_large" ? 413 : 400,
      error: problem,
    };
  }

  const known = new Set(unique.map((photo) => photo.id));
  if (referencedIds.some((id) => !known.has(id))) {
    return { ok: false, status: 400, error: "unknown_photo" };
  }
  return { ok: true, photos: unique };
}

/** What they typed in the intake form. The photos travel separately. */
export type Intake = {
  /** "What are you selling?" in their own words. */
  item: string;
};

export const intakeSchema = z.object({
  item: z.string().trim().min(1).max(300),
});

export const INTAKE_FIELD = {
  label: "What are you selling?",
  hint: "The item, as you would describe it to a friend. Details come next.",
  placeholder: "iPhone 13, 128GB, blue",
} as const;

export const PHOTO_FIELD = {
  label: "Photos",
  hint: `Up to ${INTAKE_MAX_PHOTOS}. Front, back, and any wear or damage — the assistant compares what you say about its condition with what it can see.`,
} as const;

/**
 * The asking price, recorded before the market is looked up.
 *
 * This is the step a Gem cannot hold. The anchor study measures what owners
 * would sell for, and that measurement only means something if it is taken
 * before anything else has had a chance to move it. In a chat window the person
 * can read ahead; here the market data does not exist until this is submitted.
 */
export type AskingPrice = {
  /** US dollars. */
  usd: number;
};

export const MAX_ASKING_USD = 1_000_000;

export const askingPriceSchema = z.object({
  usd: z.number().positive().max(MAX_ASKING_USD),
});

export const ASKING_PRICE_PROMPT = {
  eyebrow: "Before you see the market",
  question: "What price would you list it at?",
  hint: "In US dollars. It is recorded as you enter it and cannot be changed afterwards — that is what makes it worth comparing against.",
} as const;

/** Condition as extracted from the conversation. Distinct from a listing's. */
export const ITEM_CONDITIONS = [
  "like_new",
  "good",
  "fair",
  "poor",
  "unknown",
] as const;

/**
 * The facts the appraisal needs, lifted out of the conversation by a separate
 * structured call. `purchasePrice` is here because the verdict talks about it,
 * and is stripped before anything is sent to a search — see `forSearch`.
 */
export type ItemFacts = {
  /** What to type into a search box: brand, model, storage/size, no adjectives. */
  searchQuery: string;
  /** The model name. Empty when the conversation never pinned it down. */
  model: string;
  variant: string | null;
  /** How long they have used it, in months. */
  ageMonths: number | null;
  condition: (typeof ITEM_CONDITIONS)[number];
  /** What comes with it: box, charger, case. */
  included: string[];
  /** Wear and damage, from their words or the photos. */
  defects: string[];
  /** What they paid, in USD. */
  purchasePrice: number | null;
};

export const itemFactsSchema = z.object({
  searchQuery: z.string().trim().max(200),
  model: z.string().trim().max(200),
  variant: z.string().trim().max(200).nullable().default(null),
  ageMonths: z.number().min(0).max(1200).nullable().default(null),
  condition: z.enum(ITEM_CONDITIONS),
  included: z.array(z.string().trim().max(200)).max(20).default([]),
  defects: z.array(z.string().trim().max(300)).max(20).default([]),
  purchasePrice: z.number().min(0).max(MAX_ASKING_USD).nullable().default(null),
});

const CURRENCY_AMOUNT = /(?:US\s?)?\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars?|bucks)\b/gi;

/** Removes anything that reads as a dollar amount from free text. */
export function scrubPrices(text: string): string {
  return text.replace(CURRENCY_AMOUNT, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * The facts as the search is allowed to see them.
 *
 * The search must not know what they paid or what they plan to ask: a model
 * that has read "$800" will drift toward $800 when it summarises listings, and
 * the whole comparison is then contaminated. The structural field is dropped
 * and free-text fields are scrubbed of dollar amounts in case it leaked there.
 */
export function forSearch(facts: ItemFacts): Omit<ItemFacts, "purchasePrice"> {
  const { purchasePrice: _dropped, ...rest } = facts;
  void _dropped;
  return {
    ...rest,
    searchQuery: scrubPrices(rest.searchQuery),
    model: scrubPrices(rest.model),
    variant: rest.variant === null ? null : scrubPrices(rest.variant),
    included: rest.included.map(scrubPrices).filter(Boolean),
    defects: rest.defects.map(scrubPrices).filter(Boolean),
  };
}

/** The intake as the model receives it, appended to the system instruction. */
export function describeIntake(intake: Intake, photoCount: number): string {
  return [
    "## What they are selling",
    "",
    `**In their words:** ${intake.item}`,
    "",
    photoCount > 0
      ? `They attached ${photoCount} photo${photoCount === 1 ? "" : "s"}, shown to you alongside their messages. What they say about condition must be checked against what you can see.`
      : "They have not attached any photos yet.",
  ].join("\n");
}

/** The extracted facts as the model receives them on the verdict turn. */
export function describeItem(
  item: ItemFacts,
  format: (usd: number) => string,
): string {
  return [
    "## The item, as established in the conversation",
    "",
    `- Model: ${item.model}${item.variant ? ` (${item.variant})` : ""}`,
    `- Condition: ${item.condition.replace("_", " ")}`,
    ...(item.ageMonths !== null ? [`- Used for about ${item.ageMonths} months`] : []),
    ...(item.purchasePrice !== null
      ? [`- They paid ${format(item.purchasePrice)}`]
      : []),
    ...(item.included.length ? [`- Included: ${item.included.join(", ")}`] : []),
    ...(item.defects.length ? [`- Wear and damage: ${item.defects.join("; ")}`] : []),
  ].join("\n");
}

/** The locked-in price as the model receives it, once it exists. */
export function describeAskingPrice(
  asking: AskingPrice,
  format: (usd: number) => string,
): string {
  return [
    "## The price they locked in before seeing the market",
    "",
    `They would list it at ${format(asking.usd)}.`,
    "",
    "It is a baseline, not a constraint on what you recommend. Do not flatter it and do not defer to it.",
  ].join("\n");
}
