/**
 * Thin wrapper over the Gemini SDK.
 *
 * Three shapes of call, because the appraisal has three kinds of work:
 *
 * - **Conversation** (`streamReply`): intake, the questions and the verdict are
 *   streamed text, with the photos attached where they first appear.
 * - **Facts** (`extractFacts`): one non-streaming call against a response
 *   schema, no tools. It reads the whole conversation and the photos and
 *   returns the item as data.
 * - **Market** (`searchMarket`): two calls. The first has the Google Search tool
 *   and returns prose with citations; the second has no tools and turns that
 *   prose into listings against a response schema, each pointing at one of the
 *   sources the search actually retrieved.
 *
 * It is two calls rather than one because a listing needs a pointer into the
 * search's grounding chunks, and those do not exist until the search has run:
 * a single call cannot cite a source it has not yet been given. (The spike in
 * scripts/spike-appraise.ts exists to confirm or overturn that.)
 *
 * The system instruction is assembled from the protocol's Gem-portable core, not
 * the whole document. Sending the model exactly the span that gets pasted into
 * the Gem builder is the entire basis for claiming the two are the same
 * instrument.
 */
import "server-only";
import {
  ApiError,
  GoogleGenAI,
  PartMediaResolutionLevel,
  type Content,
  type Part,
} from "@google/genai";
import { z } from "zod";
import { env } from "./env";
import {
  LISTING_CONDITIONS,
  annotateCitations,
  resolveSources,
  type ExtractedListing,
  type ResolvedSource,
} from "./grounding";
import {
  ITEM_CONDITIONS,
  describeAskingPrice,
  describeIntake,
  describeItem,
  forSearch,
  itemFactsSchema,
  type AskingPrice,
  type Intake,
  type ItemFacts,
  type Photo,
} from "./item";
import { GEM_CORE, PROTOCOL_VERSION } from "./protocol";
import {
  POSITIONS,
  describeAppraisal,
  formatUsd,
  type Appraisal,
  type Position,
} from "./pricing";
import { stageInstruction, type Stage } from "./stages";
import type { TranscriptMessage } from "./transcript";

export type { TranscriptMessage };

/** Thrown when the Gemini quota is exhausted (HTTP 429). */
export class RateLimitError extends Error {
  constructor() {
    super("Gemini quota exhausted");
    this.name = "RateLimitError";
  }
}

/** Thrown when the model returns something that is not a usable appraisal step. */
export class MalformedAppraisalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedAppraisalError";
  }
}

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: env.geminiApiKey });
  return client;
}

/**
 * The marker rule. Appended by the app and absent from the Gem core, because a
 * Gem has nowhere to hide control text — it would print the markers to the
 * person reading.
 */
const MARKER_RULE = [
  "## Control markers",
  "",
  "When, and only when, the current phase's goal is met, emit a marker on its own line at the very end of your turn:",
  "",
  "```",
  "[[STAGE:commit]]      — you have all four facts: the model, what they paid and when, how long they have used it, and the condition",
  "[[STAGE:complete]]    — you have delivered the verdict",
  "```",
  "",
  "These two are the only markers you ever emit. Emit at most one per turn, only at a genuine transition, and never in the same turn that a phase began. The person does not see them. Do not mention them.",
].join("\n");

/**
 * Everything about this particular item that the model needs, assembled fresh on
 * every call because nothing is stored between turns.
 */
export type TurnContext = {
  intake: Intake;
  photoCount: number;
  /** Present from the verdict turn onward, together with the two below. */
  askingPrice?: AskingPrice;
  item?: ItemFacts;
  appraisal?: Appraisal;
};

function systemInstruction(stage: Stage, context: TurnContext): string {
  return [
    `Protocol version: ${PROTOCOL_VERSION}`,
    "",
    GEM_CORE,
    "",
    "---",
    "",
    describeIntake(context.intake, context.photoCount),
    ...(context.item ? ["", describeItem(context.item, formatUsd)] : []),
    ...(context.askingPrice
      ? ["", describeAskingPrice(context.askingPrice, formatUsd)]
      : []),
    ...(context.appraisal ? ["", describeAppraisal(context.appraisal)] : []),
    "",
    "---",
    "",
    MARKER_RULE,
    "",
    `Current phase: ${stage}. ${stageInstruction(stage)}`,
  ].join("\n");
}

/**
 * The conversation as Gemini wants it, with each photo attached to the message
 * it first appeared in.
 *
 * Photos are only worth their tokens while there is something to check against
 * them, so callers pass `withPhotos: false` for the verdict, which argues from
 * the facts already extracted. MEDIUM resolution is enough to read wear and a
 * model label and costs a fraction of HIGH.
 */
function toContents(
  transcript: readonly TranscriptMessage[],
  photos: readonly Photo[],
  withPhotos: boolean,
): Content[] {
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  const attached = new Set<string>();

  return transcript.map((message) => {
    const parts: Part[] = [];
    if (withPhotos && message.role === "user") {
      for (const id of message.photoIds ?? []) {
        const photo = byId.get(id);
        if (!photo || attached.has(id)) continue;
        attached.add(id);
        parts.push({
          inlineData: { mimeType: photo.mime, data: photo.data },
          mediaResolution: {
            level: PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM,
          },
        });
      }
    }
    parts.push({ text: message.text });
    return { role: message.role, parts };
  });
}

/**
 * Low but not zero. The instrument wants comparable behaviour from one run to
 * the next, which is a reproducibility concern rather than a stylistic one.
 */
const TEMPERATURE = 0.4;

/**
 * Streams the model's reply. Raw text — stage markers are still embedded and
 * must be stripped by the caller before the person sees it.
 */
export async function* streamReply(
  transcript: TranscriptMessage[],
  photos: Photo[],
  stage: Stage,
  context: TurnContext,
): AsyncGenerator<string> {
  let stream;
  try {
    stream = await getClient().models.generateContentStream({
      model: env.model,
      contents: toContents(transcript, photos, stage !== "verdict"),
      config: {
        systemInstruction: systemInstruction(stage, context),
        temperature: TEMPERATURE,
      },
    });
  } catch (error) {
    throw normalise(error);
  }

  try {
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) yield text;
    }
  } catch (error) {
    throw normalise(error);
  }
}

const FACTS_SCHEMA = {
  type: "object",
  properties: {
    searchQuery: {
      type: "string",
      description:
        "What to type into a search box to find this exact item used: brand, model, storage or size. No adjectives, and no prices.",
    },
    model: {
      type: "string",
      description:
        "The exact model name. Empty string if the conversation and photos do not pin it down.",
    },
    variant: {
      type: "string",
      description: "Storage, size, colour or year, if it affects the value.",
    },
    ageMonths: {
      type: "number",
      description: "How long they have used it, in months. Omit if not said.",
    },
    condition: { type: "string", enum: [...ITEM_CONDITIONS] },
    included: {
      type: "array",
      items: { type: "string" },
      description: "What comes with it: box, charger, case.",
    },
    defects: {
      type: "array",
      items: { type: "string" },
      description:
        "Wear and damage, from what they said or what the photos show. Include anything visible they did not mention.",
    },
    purchasePrice: {
      type: "number",
      description: "What they paid, in US dollars. Omit if not said.",
    },
  },
  required: ["searchQuery", "model", "condition", "included", "defects"],
  propertyOrdering: [
    "searchQuery",
    "model",
    "variant",
    "ageMonths",
    "condition",
    "included",
    "defects",
    "purchasePrice",
  ],
};

const FACTS_INSTRUCTION = [
  "You extract facts about a used item from a conversation and its photos.",
  "Report only what was said or can be seen. Do not guess a model you cannot identify, and do not estimate a price.",
  "Where what they say about condition and what the photos show disagree, record the visible wear as a defect.",
].join(" ");

function parseJson(text: string | undefined, what: string): unknown {
  if (!text) throw new MalformedAppraisalError(`The model returned an empty ${what}.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new MalformedAppraisalError(`The ${what} was not valid JSON.`);
  }
}

/**
 * The item as data, from the conversation and the photos.
 *
 * Runs with no tools and no knowledge of the price they locked in; it does see
 * what they said they paid, because the verdict talks about it. An empty `model`
 * is a valid result — it means the conversation never pinned the item down, and
 * the route turns that into a request for more questions.
 */
export async function extractFacts(
  transcript: TranscriptMessage[],
  photos: Photo[],
  intake: Intake,
): Promise<ItemFacts> {
  let response;
  try {
    response = await getClient().models.generateContent({
      model: env.model,
      contents: [
        ...toContents(transcript, photos, true),
        {
          role: "user",
          parts: [{ text: "Extract the facts about the item now." }],
        },
      ],
      config: {
        systemInstruction: `${FACTS_INSTRUCTION}\n\nThey described it as: ${intake.item}`,
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: FACTS_SCHEMA,
      },
    });
  } catch (error) {
    throw normalise(error);
  }

  const parsed = itemFactsSchema.safeParse(parseJson(response.text, "item facts"));
  if (!parsed.success) {
    throw new MalformedAppraisalError(
      `The item facts did not match the schema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

const searchPrompt = (facts: ReturnType<typeof forSearch>) =>
  [
    "Find used-item listings for this exact item, so that a seller can see what it is worth.",
    "",
    `Item: ${facts.searchQuery}`,
    `Model: ${facts.model}${facts.variant ? `, ${facts.variant}` : ""}`,
    `Condition: ${facts.condition.replace("_", " ")}`,
    ...(facts.defects.length ? [`Wear: ${facts.defects.join("; ")}`] : []),
    ...(facts.included.length ? [`Included: ${facts.included.join(", ")}`] : []),
    "",
    "Search sold and active used listings on eBay, Facebook Marketplace, Swappa, Mercari and similar US marketplaces. Prefer sold (completed) listings.",
    "Report up to 12 listings of this exact model, one per line: the title, the price exactly as the page shows it, whether it is SOLD or ACTIVE, the condition, and the platform.",
    "Only report a listing you actually found with a price on the page. Never invent one; report fewer if that is all there is. Prices must be in US dollars.",
    "Also give the typical price of this item new, in US dollars, if you can find it.",
    "Do not suggest a price for the seller.",
  ].join("\n");

const EXTRACT_INSTRUCTION = [
  "You turn a search summary into structured listings.",
  "Each [n] in the summary marks the source that backs the text before it.",
  "For every listing set sourceIndex to the n of the source the listing came from. Use only the sources given.",
  "Include only listings that state a price. Copy the price text exactly as written. Do not invent or adjust anything.",
  "Then judge the seller's item against the listings. position is 'below' if it is clearly worse than the typical listing, 'above' if clearly better, otherwise 'typical'. positionEvidence quotes the specific facts about their item that justify it.",
].join(" ");

function extractionSchema(sourceCount: number) {
  return {
    type: "object",
    properties: {
      listings: {
        type: "array",
        maxItems: 15,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            priceText: {
              type: "string",
              description:
                "The price exactly as the page shows it, currency included, e.g. 'US $1,049.99'.",
            },
            kind: { type: "string", enum: ["sold", "active"] },
            condition: { type: "string", enum: [...LISTING_CONDITIONS] },
            platform: { type: "string" },
            sourceIndex: {
              type: "integer",
              enum: Array.from({ length: sourceCount }, (_, index) => index),
            },
          },
          required: ["title", "priceText", "kind", "condition", "platform", "sourceIndex"],
          propertyOrdering: [
            "title",
            "priceText",
            "kind",
            "condition",
            "platform",
            "sourceIndex",
          ],
        },
      },
      newPrice: {
        type: "number",
        description: "Typical price new, in US dollars. Omit if the summary gives none.",
      },
      position: { type: "string", enum: [...POSITIONS] },
      positionEvidence: { type: "string" },
    },
    required: ["listings", "position", "positionEvidence"],
    propertyOrdering: ["listings", "newPrice", "position", "positionEvidence"],
  };
}

const extractionResultSchema = z.object({
  listings: z.array(
    z.object({
      title: z.string().max(300),
      priceText: z.string().max(80),
      kind: z.enum(["sold", "active"]),
      condition: z.enum(LISTING_CONDITIONS),
      platform: z.string().max(120),
      sourceIndex: z.number().int().min(0),
    }),
  ),
  newPrice: z.number().positive().nullish(),
  position: z.enum(POSITIONS),
  positionEvidence: z.string().max(600),
});

export type MarketSearch = {
  listings: ExtractedListing[];
  sources: ResolvedSource[];
  newPrice: number | null;
  position: Position;
  positionEvidence: string;
  /**
   * Google's search suggestions widget. Showing it next to the results is a
   * condition of using Search grounding, so it travels to the browser as is.
   */
  searchEntryPoint: { renderedContent: string } | null;
  queries: string[];
};

/**
 * Finds used listings for the item and reports them against the sources the
 * search retrieved.
 *
 * Takes the facts through `forSearch`, so neither what they paid nor anything
 * they said about price can reach the model that is reading listings. The price
 * they locked in is never passed to this module at all.
 */
export async function searchMarket(facts: ItemFacts): Promise<MarketSearch> {
  const visible = forSearch(facts);

  let search;
  try {
    search = await getClient().models.generateContent({
      model: env.model,
      contents: searchPrompt(visible),
      config: { temperature: 0.2, tools: [{ googleSearch: {} }] },
    });
  } catch (error) {
    throw normalise(error);
  }

  const metadata = search.candidates?.[0]?.groundingMetadata;
  const chunks = metadata?.groundingChunks ?? [];
  const sources = await resolveSources(chunks.map((chunk) => chunk.web ?? {}));
  const entry = metadata?.searchEntryPoint?.renderedContent;
  const searchEntryPoint = entry ? { renderedContent: entry } : null;
  const queries = metadata?.webSearchQueries ?? [];
  const summary = search.text?.trim();

  // Nothing retrieved means nothing a listing could point at. That is a valid
  // answer for a rare item, not an error.
  if (!summary || sources.length === 0) {
    return {
      listings: [],
      sources,
      newPrice: null,
      position: "typical",
      positionEvidence: "",
      searchEntryPoint,
      queries,
    };
  }

  let extraction;
  try {
    extraction = await getClient().models.generateContent({
      model: env.model,
      contents: [
        `The seller's item:\n${JSON.stringify(visible, null, 2)}`,
        "",
        "Search summary:",
        annotateCitations(summary, metadata?.groundingSupports ?? []),
        "",
        "Sources:",
        ...sources.map(
          (source, index) =>
            `[${index}] ${source.title}${source.url ? ` — ${source.url}` : ""}`,
        ),
      ].join("\n"),
      config: {
        systemInstruction: EXTRACT_INSTRUCTION,
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: extractionSchema(sources.length),
      },
    });
  } catch (error) {
    throw normalise(error);
  }

  const parsed = extractionResultSchema.safeParse(
    parseJson(extraction.text, "listing extraction"),
  );
  if (!parsed.success) {
    throw new MalformedAppraisalError(
      `The listing extraction did not match the schema: ${parsed.error.message}`,
    );
  }

  return {
    listings: parsed.data.listings,
    sources,
    newPrice: parsed.data.newPrice ?? null,
    position: parsed.data.position,
    positionEvidence: parsed.data.positionEvidence,
    searchEntryPoint,
    queries,
  };
}

function normalise(error: unknown): unknown {
  if (error instanceof ApiError && error.status === 429) {
    return new RateLimitError();
  }
  return error;
}
