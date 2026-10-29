/**
 * Exercises the chat route with only the model call replaced.
 *
 * What is worth proving here is the gating and the withholding. The design rests
 * on the claims that the assistant cannot ask for a price before it has asked its
 * questions, cannot give a verdict before there is a market, and never sees the
 * locked price or the market until the verdict — and those claims live in this
 * route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamReply = vi.hoisted(() => vi.fn());

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return { ...actual, streamReply };
});

const { POST: chat } = await import("@/app/api/chat/route");
const { ModelOverloadedError, RateLimitError } = await import("@/lib/gemini");
const { env } = await import("@/lib/env");
const { FACT_COUNT } = await import("@/lib/stages");
const { MAX_PHOTO_BYTES, MAX_PHOTOS } = await import("@/lib/item");
const { resetBudget } = await import("@/lib/budget");

/** Yields `chunks` as though they arrived from the model. */
function modelSays(...chunks: string[]) {
  streamReply.mockImplementation(async function* () {
    for (const chunk of chunks) yield chunk;
  });
}

const at = new Date().toISOString();

const photo = (id: string, bytes = 16) => ({
  id,
  mime: "image/jpeg" as const,
  data: Buffer.alloc(bytes, 7).toString("base64"),
});

const intake = { item: "iPhone 13, 128GB, blue" };
const asking = { usd: 450 };

/** A transcript in which the assistant has asked `modelTurns` questions. */
function conversation(modelTurns: number, photoIds: string[] = ["p1"]) {
  return Array.from({ length: modelTurns }, (_, index) => [
    {
      role: "user" as const,
      text: index === 0 ? "I'm selling: iPhone 13" : `answer ${index}`,
      at,
      photoIds: index === 0 ? photoIds : undefined,
    },
    { role: "model" as const, text: `question ${index + 1}`, at },
  ]).flat();
}

/** Five counted listings: median 300, so a locked 450 is 50% over. */
const appraisal = {
  item: {
    searchQuery: "iPhone 13 128GB",
    model: "iPhone 13",
    condition: "good" as const,
    included: [],
    defects: [],
    purchasePrice: 849,
  },
  listings: [200, 250, 300, 350, 400].map((price, index) => ({
    title: `iPhone 13 #${index}`,
    priceText: `$${price}`,
    kind: "sold" as const,
    condition: "good" as const,
    platform: `Site ${index}`,
    sourceIndex: index,
    url: `https://site${index}.example/item/${index}`,
    match: "verified" as const,
  })),
  newPrice: null,
  position: "typical" as const,
  positionEvidence: "light wear",
};

const base = {
  phase: "probe" as const,
  intake,
  photos: [photo("p1")],
  transcript: conversation(2),
  message: "about two years",
};

async function postChat(body: unknown) {
  const response = await chat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!response.headers.get("Content-Type")?.includes("ndjson")) {
    return { status: response.status, events: [], json: await response.json() };
  }
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  return { status: response.status, events, json: null };
}

const texts = (events: Array<{ t: string; v?: string }>) =>
  events.filter((e) => e.t === "text").map((e) => e.v).join("");

beforeEach(() => {
  streamReply.mockReset();
  modelSays("Noted.");
  resetBudget();
});

describe("streaming", () => {
  it("streams a reply and keeps markers out of the text", async () => {
    modelSays("What did you", " pay for it?", "[[STAGE:appraise]]");

    const { events } = await postChat({
      ...base,
      transcript: conversation(FACT_COUNT - 1),
    });

    expect(texts(events)).toBe("What did you pay for it?");
    expect(texts(events)).not.toContain("[[STAGE:");
  });

  it("ends a finished reply with done, so the browser can tell it from one cut off", async () => {
    const { events } = await postChat(base);
    expect(events.at(-1)).toEqual({ t: "done" });
    expect(events.filter((e) => e.t === "done")).toHaveLength(1);
  });

  it("ends a replaced reply with done too", async () => {
    modelSays("## Suggested price\nList it at $300.");
    const { events } = await postChat(base);
    expect(events.at(-1)).toEqual({ t: "done" });
  });

  it("never sends done after a failure", async () => {
    streamReply.mockImplementation(async function* () {
      yield "Half a";
      throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { events } = await postChat(base);
    expect(events.at(-1)).toEqual({ t: "error", code: "server_error" });
    expect(events.some((e) => e.t === "done")).toBe(false);
  });

  it("opens the conversation from the intake phase with no transcript", async () => {
    modelSays("A blue iPhone 13 — how long have you had it?");

    const { status, events } = await postChat({
      ...base,
      phase: "intake",
      transcript: [],
      message: "I'm selling: iPhone 13, 128GB, blue",
      messagePhotoIds: ["p1"],
    });

    expect(status).toBe(200);
    expect(texts(events)).toContain("iPhone 13");
    const [history] = streamReply.mock.calls[0];
    expect(history.at(-1)).toMatchObject({ role: "user", photoIds: ["p1"] });
  });

  it("reports a quota failure rather than failing silently", async () => {
    streamReply.mockImplementation(async function* () {
      yield "I was saying";
      throw new RateLimitError();
    });

    const { events } = await postChat(base);

    expect(events).toContainEqual({ t: "error", code: "rate_limited" });
    // Whatever was generated before the failure still reaches the person.
    expect(texts(events)).toContain("I was saying");
  });

  it("reports any other failure as a server error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    streamReply.mockImplementation(async function* () {
      throw new Error("boom");
    });
    const { events } = await postChat(base);
    expect(events).toContainEqual({ t: "error", code: "server_error" });
  });
});

describe("the price and the market", () => {
  it("are kept out of the questions, even if the request carries them", async () => {
    await postChat({
      ...base,
      askingPrice: asking,
      appraisal,
      transcript: conversation(FACT_COUNT),
    });
    const [, , , context] = streamReply.mock.calls[0];
    expect(context.askingPrice).toBeUndefined();
    expect(context.appraisal).toBeUndefined();
    expect(context.item).toBeUndefined();
  });

  it("reach the verdict, and only the verdict", async () => {
    await postChat({
      ...base,
      phase: "verdict",
      askingPrice: asking,
      appraisal,
      transcript: conversation(FACT_COUNT),
      message: "what do you suggest?",
    });
    const [, , , context] = streamReply.mock.calls[0];
    expect(context.askingPrice).toEqual(asking);
    expect(context.appraisal).toBeDefined();
  });
});

describe("the appraise marker", () => {
  it("is honoured at the very first reply: the assistant decides when it has the facts", async () => {
    modelSays("You have told me everything I need.[[STAGE:appraise]]");

    const { events } = await postChat({
      ...base,
      phase: "intake",
      transcript: [],
      message: "I'm selling: iPhone 13 128GB, bought for $800 in March 2023, used two years, light scratches",
      messagePhotoIds: ["p1"],
    });
    expect(events).toContainEqual({ t: "stage", v: "appraise" });
    expect(texts(events)).toBe("You have told me everything I need.");
  });

  it("goes through after the usual number of questions too", async () => {
    modelSays("That is all I need.[[STAGE:appraise]]");

    // Three so far; this reply is the fourth.
    const ok = await postChat({ ...base, transcript: conversation(FACT_COUNT - 1) });
    expect(ok.events).toContainEqual({ t: "stage", v: "appraise" });
  });

  it("is dropped when no photo has been shown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    modelSays("All set.[[STAGE:appraise]]");

    const { events } = await postChat({
      ...base,
      photos: [],
      transcript: conversation(FACT_COUNT, []).map(({ photoIds: _ignored, ...rest }) => {
        void _ignored;
        return rest;
      }),
    });
    expect(events.some((e) => e.t === "stage")).toBe(false);
  });

  it("is never honoured in the verdict, and only the verdict may complete", async () => {
    modelSays("Here.[[STAGE:appraise]][[STAGE:complete]]");
    const verdict = await postChat({
      ...base,
      phase: "verdict",
      askingPrice: asking,
      appraisal,
      transcript: conversation(FACT_COUNT),
      message: "what do you suggest?",
    });
    expect(verdict.events.filter((e) => e.t === "stage")).toEqual([
      { t: "stage", v: "complete" },
    ]);

    modelSays("Sure.[[STAGE:complete]]");
    const probe = await postChat(base);
    expect(probe.events.some((e) => e.t === "stage")).toBe(false);
  });
});

describe("a verdict-shaped reply outside the verdict", () => {
  // Seen on a real deployment: the stage marker never came, so the screen kept
  // the chat box, the person typed "maybe 50" into it, and the model answered
  // with a full verdict, "recently sold listings on eBay" included, with no
  // search behind it.
  const FAKE_VERDICT = "## Suggested price\n$10. Your price of $50 is well above the market.";

  const typedPrice = { ...base, message: "maybe 50" };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("is never shown: the app's own line replaces it and hands over to the market lookup", async () => {
    modelSays(FAKE_VERDICT);

    const { events } = await postChat({
      ...typedPrice,
      transcript: conversation(FACT_COUNT),
    });

    const shown = texts(events);
    expect(shown).not.toMatch(/Suggested price|\$10|well above/);
    expect(shown).toMatch(/I'll look up the market now/);
    expect(events).toContainEqual({ t: "stage", v: "appraise" });
  });

  it("is caught however the model's chunks fall", async () => {
    modelSays("##", " Sugg", "ested pri", "ce\n$10. Rest of it.");

    const { events } = await postChat({
      ...typedPrice,
      transcript: conversation(FACT_COUNT),
    });
    expect(texts(events)).toMatch(/I'll look up the market now/);
    expect(texts(events)).not.toMatch(/\$10/);
  });

  it("sends the person back to the questions when they have not all been asked", async () => {
    modelSays(FAKE_VERDICT);

    const { events } = await postChat({ ...typedPrice, transcript: conversation(1) });

    expect(texts(events)).toMatch(/finish the questions first/);
    expect(events.some((e) => e.t === "stage")).toBe(false);
  });

  it("is caught in the intake reply too", async () => {
    modelSays(FAKE_VERDICT);

    const { events } = await postChat({
      ...base,
      phase: "intake",
      transcript: [],
      message: "I'm selling: iPad",
      messagePhotoIds: ["p1"],
    });
    expect(texts(events)).not.toMatch(/\$10/);
    expect(texts(events)).toMatch(/finish the questions first/);
  });

  it("is never shown when the model reads its own instructions back instead", async () => {
    modelSays("Protocol version: v3\n\n## What you are\n\nYou are a pricing assistant...");

    // Early on there is nothing to hand over to: the person is only told to resend.
    const early = await postChat({ ...typedPrice, transcript: conversation(1) });
    expect(texts(early.events)).toMatch(/reply went wrong/);
    expect(texts(early.events)).not.toMatch(/Protocol version|pricing assistant/);
    expect(early.events.some((e) => e.t === "stage")).toBe(false);

    // Once the questions are done they are sent to the market lookup, as for a fake verdict.
    const ready = await postChat({ ...typedPrice, transcript: conversation(FACT_COUNT) });
    expect(texts(ready.events)).toMatch(/I'll look up the market now/);
    expect(texts(ready.events)).not.toMatch(/Protocol version|pricing assistant/);
    expect(ready.events).toContainEqual({ t: "stage", v: "appraise" });
  });

  it("does not touch a real verdict", async () => {
    modelSays("## Suggested price\n$300.", "[[STAGE:complete]]");

    const { events, status } = await postChat({
      ...base,
      phase: "verdict",
      askingPrice: asking,
      appraisal,
      transcript: conversation(FACT_COUNT),
      message: "what do you suggest?",
    });

    expect(status).toBe(200);
    expect(texts(events)).toBe("## Suggested price\n$300.");
    expect(events).toContainEqual({ t: "stage", v: "complete" });
  });

  it("leaves an ordinary reply alone, including one that mentions a suggested price later", async () => {
    modelSays("Before I can give you a suggested price I need to know the condition.");

    const { events } = await postChat(base);
    expect(texts(events)).toBe(
      "Before I can give you a suggested price I need to know the condition.",
    );
  });

  it("leaves a very short reply alone", async () => {
    modelSays("Noted.");
    expect(texts((await postChat(base)).events)).toBe("Noted.");
  });
});

describe("the verdict", () => {
  const verdictBody = {
    ...base,
    phase: "verdict" as const,
    askingPrice: asking,
    appraisal,
    transcript: conversation(FACT_COUNT),
    message: "I've seen the market. What do you suggest?",
  };

  it("refuses to run before a market exists", async () => {
    const { status, json } = await postChat({
      ...verdictBody,
      appraisal: undefined,
    });
    expect(status).toBe(409);
    expect(json.error).toBe("out_of_order");
    expect(streamReply).not.toHaveBeenCalled();
  });

  it("refuses when there is a market but no locked price", async () => {
    const { status } = await postChat({ ...verdictBody, askingPrice: undefined });
    expect(status).toBe(409);
    expect(streamReply).not.toHaveBeenCalled();
  });

  it("recomputes the figures instead of believing the client's", async () => {
    await postChat({
      ...verdictBody,
      appraisal: {
        ...appraisal,
        // What a tampered or stale client might add. None of it is read.
        market: { median: 9999, tier: "full" },
        suggested: { price: 9999 },
        overpriced: false,
      },
    });

    const [, , phase, context] = streamReply.mock.calls[0];
    expect(phase).toBe("verdict");
    expect(context.appraisal.market.median).toBe(300);
    expect(context.appraisal.gap.pct).toBeCloseTo(0.5);
    expect(context.appraisal.overpriced).toBe(true);
    expect(context.askingPrice).toEqual(asking);
    expect(context.item.model).toBe("iPhone 13");
  });
});

describe("withholding", () => {
  it("keeps the locked price and the market out of the questions", async () => {
    // The person is back at the questions after a failed lookup, price locked.
    await postChat({ ...base, askingPrice: asking, appraisal });

    const [, , phase, context] = streamReply.mock.calls[0];
    expect(phase).toBe("probe");
    expect(context.askingPrice).toBeUndefined();
    expect(context.appraisal).toBeUndefined();
    expect(context.item).toBeUndefined();
  });
});

describe("photos", () => {
  it("hands the model the photos and the message that introduced them", async () => {
    await postChat({
      ...base,
      photos: [photo("p1"), photo("p2")],
      transcript: conversation(2),
      messagePhotoIds: ["p2"],
    });

    const [history, photos] = streamReply.mock.calls[0];
    expect(photos.map((p: { id: string }) => p.id)).toEqual(["p1", "p2"]);
    expect(history[0].photoIds).toEqual(["p1"]);
    expect(history.at(-1).photoIds).toEqual(["p2"]);
  });

  it("dedupes photos the client sent twice", async () => {
    await postChat({ ...base, photos: [photo("p1"), photo("p1"), photo("p1")] });
    const [, photos] = streamReply.mock.calls[0];
    expect(photos).toHaveLength(1);
  });

  it("rejects an oversized photo with 413", async () => {
    const { status, json } = await postChat({
      ...base,
      photos: [photo("p1", MAX_PHOTO_BYTES + 1)],
    });
    expect(status).toBe(413);
    expect(json.error).toBe("payload_too_large");
    expect(streamReply).not.toHaveBeenCalled();
  });

  it("rejects too many photos with 413", async () => {
    const photos = Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => photo(`p${i}`));
    const { status } = await postChat({ ...base, photos, transcript: [], messagePhotoIds: ["p0"] });
    expect(status).toBe(413);
  });

  it("rejects a mime type outside jpeg, png and webp", async () => {
    const { status } = await postChat({
      ...base,
      photos: [{ ...photo("p1"), mime: "image/heic" }],
    });
    expect(status).toBe(400);
  });

  it("rejects data that is not base64", async () => {
    const { status, json } = await postChat({
      ...base,
      photos: [{ ...photo("p1"), data: "data:image/jpeg;base64,AAAA" }],
    });
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_photo");
  });

  it("rejects a message that points at a photo that was not sent", async () => {
    const { status, json } = await postChat({ ...base, photos: [] });
    expect(status).toBe(400);
    expect(json.error).toBe("unknown_photo");
  });
});

describe("errors", () => {
  it("rejects a malformed body", async () => {
    const { status } = await postChat({ phase: "probe", message: "hi" });
    expect(status).toBe(400);
  });

  it("rejects a phase the route does not serve", async () => {
    for (const phase of ["commit", "appraise", "complete", "nonsense"]) {
      const { status } = await postChat({ ...base, phase });
      expect(status).toBe(400);
    }
  });

  it("stops a conversation that has run past the turn limit", async () => {
    const long = Array.from({ length: env.maxTurns }, (_, i) => [
      { role: "user" as const, text: `a${i}`, at, photoIds: i === 0 ? ["p1"] : undefined },
      { role: "model" as const, text: `q${i}`, at },
    ]).flat();
    const { status, json } = await postChat({ ...base, transcript: long });
    expect(status).toBe(429);
    expect(json.error).toBe("turn_limit");
    expect(streamReply).not.toHaveBeenCalled();
  });

  it("still lets a long conversation reach its verdict", async () => {
    // Market lookups have no turn limit, so someone who answered at length gets a
    // market and a price; refusing the verdict then would leave them stuck.
    const long = Array.from({ length: env.maxTurns }, (_, i) => [
      { role: "user" as const, text: `a${i}`, at, photoIds: i === 0 ? ["p1"] : undefined },
      { role: "model" as const, text: `q${i}`, at },
    ]).flat();
    const { status } = await postChat({
      ...base,
      phase: "verdict",
      askingPrice: asking,
      appraisal,
      transcript: long,
      message: "I've seen the market. What do you suggest?",
    });
    expect(status).toBe(200);
    expect(streamReply).toHaveBeenCalled();
  });

  it("keeps its default when MAX_TURNS is not a number, rather than lifting the limit", () => {
    process.env.MAX_TURNS = "twenty";
    try {
      expect(env.maxTurns).toBe(20);
    } finally {
      delete process.env.MAX_TURNS;
    }
  });
});

describe("the daily budget", () => {
  afterEach(() => {
    delete process.env.DAILY_MODEL_BUDGET;
  });

  it("counts a model call per turn and refuses the next one before calling the model", async () => {
    process.env.DAILY_MODEL_BUDGET = "2";

    expect((await postChat(base)).status).toBe(200);
    expect((await postChat(base)).status).toBe(200);
    expect(streamReply).toHaveBeenCalledTimes(2);

    const refused = await postChat(base);
    expect(refused.status).toBe(429);
    expect(refused.json.error).toBe("budget_exhausted");
    expect(streamReply).toHaveBeenCalledTimes(2);
  });

  it("does not spend on a request it rejects", async () => {
    process.env.DAILY_MODEL_BUDGET = "1";
    await postChat({ ...base, phase: "nonsense" }); // 400
    await postChat({ ...base, phase: "verdict" }); // 409: no market
    expect((await postChat(base)).status).toBe(200);
  });
});

describe("the backup model", () => {
  const sseBody = (...pieces: string[]) =>
    new Response(
      pieces.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200 },
    );

  /** Gemini out of quota before saying a word. */
  const geminiOutOfQuota = () =>
    streamReply.mockImplementation(async function* () {
      throw new RateLimitError();
    });

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    vi.unstubAllGlobals();
  });

  it("answers in Gemini's place, tells the browser first, and keeps markers out of the text", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    geminiOutOfQuota();
    const fetchStub = vi.fn(async () => sseBody("Got it. ", "That is all I need.[[STAGE:appraise]]"));
    vi.stubGlobal("fetch", fetchStub);

    const { events } = await postChat({ ...base, transcript: conversation(FACT_COUNT - 1) });

    expect(events[0]).toEqual({ t: "notice", v: "backup_model", provider: "DeepSeek" });
    expect(texts(events)).toBe("Got it. That is all I need.");
    expect(events).toContainEqual({ t: "stage", v: "appraise" });
    expect(events.some((e) => e.t === "error")).toBe(false);
  });

  it("sends DeepSeek the conversation as text and never a photo", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    geminiOutOfQuota();
    const fetchStub = vi.fn(async () => sseBody("ok"));
    vi.stubGlobal("fetch", fetchStub);

    await postChat({ ...base, photos: [photo("p1", 64)] });

    const sent = (fetchStub.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    expect(sent).not.toContain(photo("p1", 64).data);
    expect(sent).toMatch(/cannot see them/);
  });

  it("does not use it for the verdict's figures any differently: the same context, text only", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    geminiOutOfQuota();
    const fetchStub = vi.fn(async () => sseBody("## Suggested price\n$300", "[[STAGE:complete]]"));
    vi.stubGlobal("fetch", fetchStub);

    const { events } = await postChat({
      ...base,
      phase: "verdict",
      askingPrice: asking,
      appraisal,
      transcript: conversation(FACT_COUNT),
      message: "what do you suggest?",
    });

    const system = JSON.parse((fetchStub.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).messages[0].content;
    expect(system).toContain("Market median: $300");
    expect(events).toContainEqual({ t: "stage", v: "complete" });
  });

  it("is not used without a key: the quota error reaches the person as it did before", async () => {
    geminiOutOfQuota();
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    const { events } = await postChat(base);

    expect(events).toEqual([{ t: "error", code: "rate_limited" }]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("reports an overloaded Gemini with its own code", async () => {
    streamReply.mockImplementation(async function* () {
      throw new ModelOverloadedError();
    });
    const { events } = await postChat(base);
    expect(events).toContainEqual({ t: "error", code: "model_overloaded" });
  });

  it("answers with OpenRouter's free model first when it is set up, and names it", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.OPENROUTER_MODELS = "free-a/m:free";
    process.env.DEEPSEEK_API_KEY = "sk-test";
    geminiOutOfQuota();
    const fetchStub = vi.fn(async (url: string) => {
      void url;
      return sseBody("From the free model.");
    });
    vi.stubGlobal("fetch", fetchStub);

    const { events } = await postChat(base);

    expect(events[0]).toEqual({ t: "notice", v: "backup_model", provider: "OpenRouter" });
    expect(texts(events)).toBe("From the free model.");
    // DeepSeek, which costs money, was never asked.
    expect(fetchStub.mock.calls.map(([url]) => new URL(url).hostname)).toEqual(["openrouter.ai"]);
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODELS;
  });

  it("does not claim a backup answered when none did: only the error reaches the browser", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    geminiOutOfQuota();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 402 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { events } = await postChat(base);

    expect(events).toEqual([
      { t: "error", code: "rate_limited" },
    ]);
  });
});
