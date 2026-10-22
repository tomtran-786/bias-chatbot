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
const { RateLimitError } = await import("@/lib/gemini");
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
    modelSays("What did you", " pay for it?", "[[STAGE:commit]]");

    const { events } = await postChat({
      ...base,
      transcript: conversation(FACT_COUNT - 1),
    });

    expect(texts(events)).toBe("What did you pay for it?");
    expect(texts(events)).not.toContain("[[STAGE:");
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

describe("the commit marker", () => {
  it("is dropped while too few questions have been asked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    modelSays("I think I have enough.[[STAGE:commit]]");

    // Two questions so far; this reply is the third.
    const early = await postChat({ ...base, transcript: conversation(2) });
    expect(early.events.some((e) => e.t === "stage")).toBe(false);
    expect(texts(early.events)).toBe("I think I have enough.");
  });

  it("goes through once the reply completes the questions", async () => {
    modelSays("That is all I need.[[STAGE:commit]]");

    // Three so far; this reply is the fourth.
    const ok = await postChat({ ...base, transcript: conversation(FACT_COUNT - 1) });
    expect(ok.events).toContainEqual({ t: "stage", v: "commit" });
  });

  it("is dropped when no photo has been shown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    modelSays("All set.[[STAGE:commit]]");

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
    modelSays("Here.[[STAGE:commit]][[STAGE:complete]]");
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
