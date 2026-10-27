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
import { DEFAULT_VND_PER_USD, scrubVnd, vndToUsd } from "./currency";
import { SEARCH_DOMAINS_US, SEARCH_DOMAINS_VN } from "./sources";

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

/** The scene the conversation opens with, from what they typed in the intake. */
export const SITUATION = {
  eyebrow: "The situation",
  line: (item: string) => `You need to sell your used ${item}.`,
} as const;

/**
 * Two ways to see the price before the questions start. Shown by the app, never
 * sent as a turn, so they are not part of the transcript the server counts.
 * `reminder` is the one-line form kept beside the price box.
 */
export const SELLING_LENSES = [
  {
    title: "Stand where the buyer stands",
    body: "If you were the one buying this, what price would you be happy to pay? Pick a smart price, one that gets it sold.",
    reminder: "As the buyer: what would you pay for it today?",
  },
  {
    title: "Think about what selling gets you",
    body: "Kept, it takes up space. Sold, it is cash in hand right now, for whatever you need it for today.",
    reminder: "And what is the cash for, today?",
  },
] as const;

export const FRAMING = {
  intro:
    "Before we get to condition and price, keep two things in mind. They help you pick a price that actually sells:",
  outro:
    "Now you have a good point of view. Let’s get it sold: a few quick questions about its condition, then we look at what the market is paying, and then you set your price.",
} as const;

/**
 * The asking price, recorded once and then fixed.
 *
 * It is asked for after the market has been shown, so it is a price set with the
 * market in view and not an uncoached baseline. Fixing it on submit is what lets
 * the comparison, and the verdict that follows, be set against the number the
 * person actually committed to.
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
  eyebrow: "Now it’s your call",
  question: "What price would you list it at?",
  hint: "In US dollars, now that you have seen what the market is paying. It is recorded as you enter it and cannot be changed afterwards.",
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
 * What kind of thing it is, only so the app can look up how long it lasts for the
 * depreciation estimate (`USEFUL_LIFE_YEARS` in lib/pricing.ts). The model labels;
 * it never supplies the number of years.
 */
export const ITEM_CATEGORIES = ["phone_tablet", "computer", "other"] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

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
  category: ItemCategory;
  /** What comes with it: box, charger, case. */
  included: string[];
  /** Wear and damage, from their words or the photos. */
  defects: string[];
  /** What they paid, in USD (converted from đồng in code when they said it in đồng). */
  purchasePrice: number | null;
};

/**
 * The facts as the model returns them. The detail fields fall back to "unknown"
 * instead of failing the lookup: a purchase price the model got wrong, or an age
 * it wrote as text, must not make every retry fail the same way. Only the model
 * and the condition are required, because without them there is nothing to price.
 */
const optionalFacts = {
  category: z.enum(ITEM_CATEGORIES).default("other").catch("other"),
  variant: z.string().trim().max(200).nullable().default(null).catch(null),
  ageMonths: z.number().min(0).max(1200).nullable().default(null).catch(null),
  included: z.array(z.string().trim().max(200)).max(20).default([]).catch([]),
  defects: z.array(z.string().trim().max(300)).max(20).default([]).catch([]),
};

export const itemFactsSchema = z.object({
  searchQuery: z.string().trim().max(200),
  model: z.string().trim().max(200),
  condition: z.enum(ITEM_CONDITIONS),
  ...optionalFacts,
  purchasePrice: z.number().min(0).max(MAX_ASKING_USD).nullable().default(null).catch(null),
});

export const PURCHASE_CURRENCIES = ["USD", "VND"] as const;

/**
 * What the facts call returns: `itemFactsSchema` with the price in whatever
 * currency they named it in. Turned into dollars by `toItemFacts`, in code, since a
 * model asked to convert "15 triệu" will round it, drop a zero or refuse.
 */
export const factsAnswerSchema = z.object({
  searchQuery: z.string().trim().max(200),
  model: z.string().trim().max(200),
  condition: z.enum(ITEM_CONDITIONS),
  ...optionalFacts,
  purchasePrice: z.number().min(0).nullable().default(null).catch(null),
  purchaseCurrency: z.enum(PURCHASE_CURRENCIES).nullable().default("USD").catch("USD"),
});

/** The answer as `ItemFacts`, with a price in đồng converted at `vndPerUsd`. */
export function toItemFacts(
  answer: z.output<typeof factsAnswerSchema>,
  vndPerUsd: number = DEFAULT_VND_PER_USD,
): ItemFacts {
  const { purchaseCurrency, purchasePrice, ...rest } = answer;
  let usd: number | null = purchasePrice;
  if (purchasePrice !== null && purchaseCurrency === "VND") {
    // Below a few thousand đồng it is shorthand ("15" for 15 triệu), not a price.
    usd = purchasePrice >= 10_000 ? vndToUsd(purchasePrice, vndPerUsd) : null;
  }
  return { ...rest, purchasePrice: usd !== null && usd <= MAX_ASKING_USD ? usd : null };
}

const CURRENCY_AMOUNT = /(?:US\s?)?\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars?|bucks)\b/gi;

/** Removes anything that reads as a dollar or đồng amount from free text. */
export function scrubPrices(text: string): string {
  return scrubVnd(text.replace(CURRENCY_AMOUNT, ""))
    .replace(/\s{2,}/g, " ")
    .trim();
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

/** A search to run: the words, and the sites to look on (none means anywhere). */
export type SearchQuery = { query: string; domains: string[] };

/** The most queries one lookup runs: two US, one Vietnamese, one widening. Budgeted by those actually run. */
export const MAX_QUERIES = 4;

/** Below this many sources carrying a price, the search is widened once. */
export const WIDEN_BELOW = 6;

/**
 * What to type into a search box: `searchQuery` leads because it is the one field
 * the extraction was asked to write for exactly this purpose (brand, model, size,
 * no adjectives); the model and variant are the fallback if it came back empty.
 */
export function searchName(
  facts: Pick<ItemFacts, "searchQuery" | "model" | "variant">,
): string {
  return (facts.searchQuery || [facts.model, facts.variant].filter(Boolean).join(" "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

/**
 * The search queries, built by code rather than by the model.
 *
 * Taking `forSearch`'s output makes it a type error to pass the raw facts, so a
 * purchase price cannot reach a query by way of this function. The wording is
 * fixed: US queries aimed at sold prices and at listings for sale, because the two
 * answer different questions and the pricing step prefers sold, and one Vietnamese
 * query aimed at the Vietnamese marketplaces.
 */
export function searchQueries(
  facts: Pick<ReturnType<typeof forSearch>, "searchQuery" | "model" | "variant">,
): SearchQuery[] {
  const name = searchName(facts);
  return [
    { query: `${name} used sold price`, domains: SEARCH_DOMAINS_US },
    { query: `${name} used for sale`, domains: SEARCH_DOMAINS_US },
    { query: `${name} cũ`, domains: SEARCH_DOMAINS_VN },
  ];
}

/**
 * The one extra query when the first round found little: the model alone, without
 * the storage or colour that may have narrowed it too far, and on any site.
 */
export function wideningQuery(
  facts: Pick<ReturnType<typeof forSearch>, "searchQuery" | "model" | "variant">,
): SearchQuery {
  const model = facts.model.replace(/\s+/g, " ").trim();
  return { query: `${model || searchName(facts)} used price`, domains: [] };
}

/**
 * The intake as the model receives it, appended to the system instruction.
 *
 * `canSeePhotos` is false for a text-only backup model. It is told so in plain
 * words, because a model that is told photos exist and cannot see them will
 * describe them anyway.
 */
export function describeIntake(
  intake: Intake,
  photoCount: number,
  canSeePhotos = true,
): string {
  const photos =
    photoCount === 0
      ? "They have not attached any photos yet."
      : canSeePhotos
        ? `They attached ${photoCount} photo${photoCount === 1 ? "" : "s"}, shown to you alongside their messages. What they say about condition must be checked against what you can see.`
        : `They attached ${photoCount} photo${photoCount === 1 ? "" : "s"}, but you are a text-only model and cannot see them. Never describe them or say you have seen them. Where you would normally check what they say about condition against the photos, say you cannot check it, and ask them to describe any wear, damage and what is included in words.`;
  return ["## What they are selling", "", `**In their words:** ${intake.item}`, "", photos].join("\n");
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

/** The locked-in price as the model receives it, once it exists (the verdict turn). */
export function describeAskingPrice(
  asking: AskingPrice,
  format: (usd: number) => string,
): string {
  return [
    "## The price they locked in, having seen the market",
    "",
    `They would list it at ${format(asking.usd)}.`,
    "",
    "It is their number, not a constraint on what you recommend. Do not flatter it and do not defer to it.",
  ].join("\n");
}
