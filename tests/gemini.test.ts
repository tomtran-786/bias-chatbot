/**
 * What `lib/gemini.ts` actually puts in a request: where the photos go, and what
 * the system instruction holds at each stage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.GEMINI_API_KEY ??= "test-key";

const generateContentStream = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  class FakeGoogleGenAI {
    models = { generateContent: vi.fn(), generateContentStream };
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

const { streamReply } = await import("@/lib/gemini");
const { computeAppraisal } = await import("@/lib/pricing");

const at = new Date().toISOString();
const photo = (id: string) => ({ id, mime: "image/jpeg" as const, data: `data-${id}` });
const intake = { item: "iPhone 13" };

const transcript = [
  { role: "user" as const, text: "opener", at, photoIds: ["a"] },
  { role: "model" as const, text: "q1", at },
  { role: "user" as const, text: "here is the back", at, photoIds: ["b", "a"] },
  { role: "model" as const, text: "q2", at },
  { role: "user" as const, text: "no photos here", at },
];

async function run(stage: Parameters<typeof streamReply>[2], context: Parameters<typeof streamReply>[3]) {
  generateContentStream.mockResolvedValue(
    (async function* () {
      yield { text: "ok" };
    })(),
  );
  for await (const chunk of streamReply(transcript, [photo("a"), photo("b")], stage, context)) void chunk;
  return generateContentStream.mock.calls.at(-1)![0] as {
    contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    config: { systemInstruction: string };
  };
}

beforeEach(() => generateContentStream.mockReset());

describe("photos", () => {
  it("attach to the message each first appeared in, once", async () => {
    const { contents } = await run("probe", { intake, photoCount: 2 });

    const images = contents.map((c) => c.parts.filter((p) => "inlineData" in p).length);
    expect(images).toEqual([1, 0, 1, 0, 0]);
    expect(contents[0].parts[0]).toMatchObject({ inlineData: { mimeType: "image/jpeg", data: "data-a" } });
    // "a" is mentioned again in message 3 but is only sent where it first appeared.
    expect(contents[2].parts[0]).toMatchObject({ inlineData: { data: "data-b" } });
  });

  it("ask for medium resolution, which is enough to read wear", async () => {
    const { contents } = await run("probe", { intake, photoCount: 2 });
    expect(contents[0].parts[0]).toMatchObject({
      mediaResolution: { level: "MEDIA_RESOLUTION_MEDIUM" },
    });
  });

  it("are left out of the verdict, which argues from the facts already extracted", async () => {
    const { contents } = await run("verdict", { intake, photoCount: 2 });
    expect(contents.flatMap((c) => c.parts).some((p) => "inlineData" in p)).toBe(false);
  });
});

describe("the system instruction", () => {
  it("says nothing of price while questions are being asked", async () => {
    const { config } = await run("probe", { intake, photoCount: 2 });
    expect(config.systemInstruction).toContain("Current phase: probe");
    expect(config.systemInstruction).toContain("Do not state any price");
    expect(config.systemInstruction).not.toContain("locked in before seeing the market");
    expect(config.systemInstruction).not.toContain("The market, as the app computed it");
  });

  it("carries the locked price and the computed market in the verdict", async () => {
    const item = {
      searchQuery: "iPhone 13",
      model: "iPhone 13",
      variant: null,
      ageMonths: 20,
      condition: "good" as const,
      included: [],
      defects: [],
      purchasePrice: 849,
    };
    const listings = [200, 250, 300, 350, 400].map((price, i) => ({
      title: `t${i}`,
      priceText: `$${price}`,
      kind: "sold" as const,
      condition: "good" as const,
      platform: `Site ${i}`,
      sourceIndex: i,
      url: `https://s${i}.example/item/${i}`,
      match: "listing" as const,
    }));
    const appraisal = computeAppraisal(
      { listings, newPrice: null, position: "typical", positionEvidence: "light wear" },
      450,
    );

    const { config } = await run("verdict", {
      intake,
      photoCount: 2,
      askingPrice: { usd: 450 },
      item,
      appraisal,
    });

    expect(config.systemInstruction).toContain("They would list it at $450");
    expect(config.systemInstruction).toContain("Market median: $300");
    expect(config.systemInstruction).toContain("overpriced: true");
    expect(config.systemInstruction).toContain("They paid $849");
    expect(config.systemInstruction).toContain("Protocol version: v2");
  });
});
