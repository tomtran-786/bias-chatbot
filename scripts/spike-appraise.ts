/**
 * Spike: can Gemini + Google Search find used-item listings we can price from?
 *
 * Standalone on purpose (only `@google/genai`, no imports from `lib/`), so it
 * answers the design questions before any app code depends on the answers:
 *
 *   1. Do `googleSearch` and `responseJsonSchema` work in the same call?
 *   2. Are `groundingChunks` / `groundingSupports` still returned in JSON mode?
 *   3. Do the chunk redirect links resolve to real URLs?
 *   4. How many search queries does one call run, and how long does it take?
 *   5. Do the prices the model reports match the pages they came from? (This
 *      one is manual: the script prints a table to check by hand.)
 *
 * Run: npm run spike            (reads .env.local)
 * Writes a sanitised response per item to tests/fixtures/ for the grounding tests.
 *
 * Not part of `npm test`: it spends real quota.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
const FIXTURE_DIR = "tests/fixtures";

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY is not set. Run via `npm run spike`.");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: key });

const ITEMS = [
  { slug: "phone", query: "Apple iPhone 13 128GB unlocked, used, good condition" },
  { slug: "headphones", query: "Sony WH-1000XM4 wireless headphones, used, good condition" },
  { slug: "rare", query: "Heathkit ET-3400 microprocessor trainer, used, working" },
] as const;

const LISTING_SCHEMA = {
  type: "object",
  properties: {
    listings: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          priceText: {
            type: "string",
            description: "The price exactly as the page shows it, currency symbol included.",
          },
          kind: { type: "string", enum: ["sold", "active"] },
          condition: {
            type: "string",
            enum: ["new", "like_new", "good", "fair", "for_parts", "unknown"],
          },
          platform: { type: "string", description: "e.g. eBay, Swappa, Mercari" },
        },
        required: ["title", "priceText", "kind", "condition", "platform"],
      },
    },
    newPrice: { type: "number", description: "Typical current price of the item new, in USD, if found." },
  },
  required: ["listings"],
};

const SEARCH_PROMPT = (query: string) =>
  [
    `Find used-item listings for: ${query}.`,
    "Search eBay (sold and active), Facebook Marketplace, Swappa, Mercari and similar US marketplaces.",
    "I want real listings with a price shown on the page, for this exact model in used condition.",
    "Report up to 10 of them: title, the price exactly as shown, whether it is a SOLD or an ACTIVE listing, condition, and the platform.",
    "Also report the typical price new, if you can find it. Do not invent listings; report fewer if that is all there is.",
  ].join("\n");

type Chunk = { uri: string; title: string; resolved: string | null };

async function resolve(uri: string): Promise<string | null> {
  try {
    const response = await fetch(uri, { redirect: "manual" });
    return response.headers.get("location");
  } catch {
    return null;
  }
}

async function chunksOf(response: GenerateContentResponse): Promise<Chunk[]> {
  const raw = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  return Promise.all(
    raw.map(async (chunk) => ({
      uri: chunk.web?.uri ?? "",
      title: chunk.web?.title ?? "",
      resolved: chunk.web?.uri ? await resolve(chunk.web.uri) : null,
    })),
  );
}

function summarise(label: string, response: GenerateContentResponse, chunks: Chunk[], ms: number) {
  const meta = response.candidates?.[0]?.groundingMetadata;
  console.log(`  [${label}] ${ms} ms`);
  console.log(`    search queries : ${meta?.webSearchQueries?.length ?? 0}`);
  console.log(`    chunks         : ${chunks.length}  (resolved ${chunks.filter((c) => c.resolved).length})`);
  console.log(`    supports       : ${meta?.groundingSupports?.length ?? 0}`);
  console.log(`    entry point    : ${meta?.searchEntryPoint?.renderedContent ? "yes" : "no"}`);
}

/** Keeps the structure the tests need and drops the bulky rendered HTML. */
function sanitise(response: GenerateContentResponse, chunks: Chunk[]) {
  const candidate = response.candidates?.[0];
  const meta = candidate?.groundingMetadata;
  return {
    text: response.text ?? "",
    groundingMetadata: {
      webSearchQueries: meta?.webSearchQueries ?? [],
      groundingChunks: meta?.groundingChunks ?? [],
      groundingSupports: meta?.groundingSupports ?? [],
      searchEntryPoint: {
        renderedContent: (meta?.searchEntryPoint?.renderedContent ?? "").slice(0, 400),
      },
    },
    resolved: chunks.map((c) => c.resolved),
  };
}

async function oneCall(query: string) {
  const started = Date.now();
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: SEARCH_PROMPT(query),
    config: {
      temperature: 0.2,
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      responseJsonSchema: LISTING_SCHEMA,
    },
  });
  return { response, ms: Date.now() - started };
}

async function twoCalls(query: string) {
  const started = Date.now();
  const search = await ai.models.generateContent({
    model: MODEL,
    contents: SEARCH_PROMPT(query),
    config: { temperature: 0.2, tools: [{ googleSearch: {} }] },
  });
  const searchMs = Date.now() - started;
  const chunks = await chunksOf(search);

  const sources = chunks.map((c, i) => `[${i}] ${c.title} — ${c.resolved ?? c.uri}`).join("\n");
  const extractStarted = Date.now();
  const extract = await ai.models.generateContent({
    model: MODEL,
    contents: [
      "Extract the used-item listings from this search summary as JSON.",
      "Only include listings that state a price. Do not invent any.",
      "",
      "Summary:",
      search.text ?? "",
      "",
      "Sources:",
      sources,
    ].join("\n"),
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      responseJsonSchema: {
        ...LISTING_SCHEMA,
        properties: {
          ...LISTING_SCHEMA.properties,
          listings: {
            ...LISTING_SCHEMA.properties.listings,
            items: {
              ...LISTING_SCHEMA.properties.listings.items,
              properties: {
                ...LISTING_SCHEMA.properties.listings.items.properties,
                sourceIndex: { type: "integer", minimum: 0, maximum: Math.max(0, chunks.length - 1) },
              },
              required: [...LISTING_SCHEMA.properties.listings.items.required, "sourceIndex"],
            },
          },
        },
      },
    },
  });
  return { search, searchChunks: chunks, extract, searchMs, extractMs: Date.now() - extractStarted };
}

function printListings(text: string | undefined, chunks: Chunk[]) {
  let parsed: { listings?: Array<Record<string, unknown>>; newPrice?: number };
  try {
    parsed = JSON.parse(text ?? "");
  } catch {
    console.log("    (response was not valid JSON)");
    return;
  }
  for (const [i, l] of (parsed.listings ?? []).entries()) {
    const idx = typeof l.sourceIndex === "number" ? l.sourceIndex : null;
    const url = idx !== null ? (chunks[idx]?.resolved ?? chunks[idx]?.uri ?? "?") : "";
    console.log(`    ${String(i + 1).padStart(2)}. ${l.priceText} | ${l.kind} | ${l.condition} | ${l.platform} | ${String(l.title).slice(0, 60)} ${url}`);
  }
  console.log(`    new price: ${parsed.newPrice ?? "-"}`);
}

/**
 * A free-tier key can answer plain calls and still have no quota at all for the
 * Search tool, which is billed separately. Telling those apart up front turns a
 * wall of identical 429s into one sentence about what to change.
 */
async function preflight(): Promise<boolean> {
  const attempt = async (tools?: Array<{ googleSearch: Record<string, never> }>) => {
    try {
      await ai.models.generateContent({
        model: MODEL,
        contents: "Reply with the single word: ok",
        config: tools ? { tools } : {},
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const plain = await attempt();
  if (plain) {
    console.error(`Plain call to ${MODEL} failed, so this is not about Search:\n${plain.slice(0, 300)}`);
    return false;
  }
  const search = await attempt([{ googleSearch: {} }]);
  if (search) {
    console.error(
      [
        `A plain call to ${MODEL} works, but a call with the googleSearch tool does not:`,
        search.slice(0, 300),
        "",
        "Grounding with Google Search has its own quota. On the free tier it is often",
        "zero for newer models. Use a key on a billed project, or point GEMINI_MODEL at",
        "a model whose free tier includes grounding, then run this again.",
      ].join("\n"),
    );
    return false;
  }
  return true;
}

mkdirSync(FIXTURE_DIR, { recursive: true });
console.log(`Model: ${MODEL}\n`);
if (!(await preflight())) process.exit(2);

for (const item of ITEMS) {
  console.log(`== ${item.slug}: ${item.query}`);

  try {
    const { response, ms } = await oneCall(item.query);
    const chunks = await chunksOf(response);
    summarise("one call: search + JSON schema", response, chunks, ms);
    printListings(response.text, chunks);
    writeFileSync(
      `${FIXTURE_DIR}/spike-${item.slug}-onecall.json`,
      JSON.stringify(sanitise(response, chunks), null, 2),
    );
  } catch (error) {
    console.log(`  [one call] FAILED: ${error instanceof Error ? error.message : error}`);
  }

  try {
    const two = await twoCalls(item.query);
    summarise("two calls: search text", two.search, two.searchChunks, two.searchMs);
    console.log(`  [two calls] extraction ${two.extractMs} ms`);
    printListings(two.extract.text, two.searchChunks);
    writeFileSync(
      `${FIXTURE_DIR}/spike-${item.slug}-twocalls.json`,
      JSON.stringify(
        { ...sanitise(two.search, two.searchChunks), extraction: two.extract.text ?? "" },
        null,
        2,
      ),
    );
  } catch (error) {
    console.log(`  [two calls] FAILED: ${error instanceof Error ? error.message : error}`);
  }
  console.log();
}
