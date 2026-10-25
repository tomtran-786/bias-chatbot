/**
 * The chain of Gemini models: when the next one is tried, when it must not be, what
 * the person is told when every one has refused, and how a model that just refused
 * is remembered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.hoisted(() => vi.fn());
const generateContentStream = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  class FakeGoogleGenAI {
    models = { generateContent, generateContentStream };
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

const { ApiError, ThinkingLevel } = await import("@google/genai");
const {
  MalformedAppraisalError,
  ModelNotFoundError,
  ModelOverloadedError,
  ModelTimeoutError,
  RateLimitError,
  extractFacts,
  readListings,
  streamReply,
  triedNote,
} = await import("@/lib/gemini");
const { env } = await import("@/lib/env");
const { isCoolingDown } = await import("@/lib/model-health");

const PRIMARY = "primary-model";
const SECOND = "second-model";
const THIRD = "third-model";

const at = new Date().toISOString();
const transcript = [{ role: "user" as const, text: "hi", at, photoIds: ["p1"] }];
const photos = [{ id: "p1", mime: "image/jpeg" as const, data: "eA==" }];
const intake = { item: "iPhone 13" };
const context = { intake, photoCount: 1 };
const facts = {
  searchQuery: "x", model: "x", variant: null, ageMonths: null, condition: "good" as const, included: [], defects: [], purchasePrice: null,
};
const sources = [{ url: "https://a.example/1", title: "t", text: "$5" }];

const FACTS_JSON = JSON.stringify({ searchQuery: "x", model: "x", condition: "good", included: [], defects: [] });
const READING_JSON = JSON.stringify({ listings: [], position: "typical", positionEvidence: "" });

const refuse = (status: number) => new ApiError({ message: "refused", status });
const modelsAsked = () => generateContent.mock.calls.map(([request]) => request.model as string);

/** Answers per model: an Error is thrown, anything else is the response text. */
function answers(byModel: Record<string, Error | string>, fallback: string = FACTS_JSON) {
  generateContent.mockImplementation(async (request: { model: string }) => {
    const answer = byModel[request.model] ?? fallback;
    if (answer instanceof Error) throw answer;
    return { text: answer };
  });
}

async function* says(...chunks: string[]) {
  for (const chunk of chunks) yield { text: chunk };
}
async function* failsBeforeSaying(error: Error) {
  throw error;
  yield { text: "" };
}
async function* failsAfterSaying(error: Error, ...chunks: string[]) {
  for (const chunk of chunks) yield { text: chunk };
  throw error;
}
const collect = async (generator: AsyncGenerator<string>) => {
  let out = "";
  for await (const chunk of generator) out += chunk;
  return out;
};

beforeEach(() => {
  process.env.GEMINI_MODEL = PRIMARY;
  process.env.GEMINI_FALLBACK_MODELS = `${SECOND},${THIRD}`;
  generateContent.mockReset();
  generateContentStream.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_FALLBACK_MODELS;
  vi.useRealTimers();
});

describe("trying the next model", () => {
  it("asks the pinned model first and stops there when it answers", async () => {
    answers({});
    await extractFacts(transcript, photos, intake);
    expect(modelsAsked()).toEqual([PRIMARY]);
  });

  it.each([
    ["is out of quota (429)", 429],
    ["is overloaded (503)", 503],
    ["does not exist for the key (404)", 404],
  ])("moves on to the next model when one %s", async (_label, status) => {
    answers({ [PRIMARY]: refuse(status) });
    const out = await extractFacts(transcript, photos, intake);
    expect(out.model).toBe("x");
    expect(modelsAsked()).toEqual([PRIMARY, SECOND]);
  });

  it("goes on down the chain until one answers", async () => {
    answers({ [PRIMARY]: refuse(429), [SECOND]: refuse(503) });
    await extractFacts(transcript, photos, intake);
    expect(modelsAsked()).toEqual([PRIMARY, SECOND, THIRD]);
  });

  it("still sends the photos to the next model: it is the same family and can see them", async () => {
    answers({ [PRIMARY]: refuse(429) });
    await extractFacts(transcript, photos, intake);
    for (const [request] of generateContent.mock.calls) {
      expect(JSON.stringify(request.contents)).toContain("eA==");
    }
  });

  it("covers reading the listings too, and makes no call at all for no sources", async () => {
    answers({ [PRIMARY]: refuse(429) }, READING_JSON);
    await readListings(facts, sources);
    expect(modelsAsked()).toEqual([PRIMARY, SECOND]);

    generateContent.mockClear();
    await readListings(facts, []);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("gives no call a tool, whichever model it is", async () => {
    answers({ [PRIMARY]: refuse(429) });
    await extractFacts(transcript, photos, intake);
    for (const [request] of generateContent.mock.calls) expect(request.config).not.toHaveProperty("tools");
  });

  it("says in the log which model refused", async () => {
    answers({ [PRIMARY]: refuse(429) });
    await extractFacts(transcript, photos, intake);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(PRIMARY));
  });
});

const timedOut = () => Object.assign(new Error("aborted"), { name: "TimeoutError" });

describe("a call that went wrong without being refused", () => {
  it("a timeout moves on: the next model is not the one that is hanging", async () => {
    answers({ [PRIMARY]: timedOut() });
    const out = await extractFacts(transcript, photos, intake);
    expect(out.model).toBe("x");
    expect(modelsAsked()).toEqual([PRIMARY, SECOND]);
  });

  it("a timeout is remembered, so the next call does not open with the slow model", async () => {
    answers({ [PRIMARY]: timedOut() });
    await extractFacts(transcript, photos, intake);
    expect(isCoolingDown(PRIMARY)).toBe(true);
  });

  it("reports a timeout when every model timed out", async () => {
    answers({ [PRIMARY]: timedOut(), [SECOND]: timedOut(), [THIRD]: timedOut() });
    await expect(extractFacts(transcript, photos, intake)).rejects.toBeInstanceOf(ModelTimeoutError);
    expect(modelsAsked()).toEqual([PRIMARY, SECOND, THIRD]);
  });

  it("an answer that is not the schema moves on too, for facts and for listings", async () => {
    answers({ [PRIMARY]: "this is not json" });
    expect((await extractFacts(transcript, photos, intake)).model).toBe("x");
    expect(modelsAsked()).toEqual([PRIMARY, SECOND]);

    generateContent.mockReset();
    answers({ [PRIMARY]: '{"listings":"none"}' }, READING_JSON);
    await readListings(facts, sources);
    expect(modelsAsked()).toEqual([PRIMARY, SECOND]);
  });

  it("is not remembered against a model that answered badly: that says nothing about its health", async () => {
    answers({ [PRIMARY]: "this is not json" });
    await extractFacts(transcript, photos, intake);
    expect(isCoolingDown(PRIMARY)).toBe(false);
  });

  it("reports the bad answer, not a vague failure, when every model gave one", async () => {
    answers({}, "this is not json");
    const error = await extractFacts(transcript, photos, intake).catch((e) => e);
    expect(error).toBeInstanceOf(MalformedAppraisalError);
    expect(modelsAsked()).toEqual([PRIMARY, SECOND, THIRD]);
  });

  it("a bad request or a server fault: not about which model", async () => {
    for (const status of [400, 401, 500]) {
      generateContent.mockReset();
      answers({ [PRIMARY]: refuse(status) });
      await expect(extractFacts(transcript, photos, intake)).rejects.toBeInstanceOf(ApiError);
      expect(modelsAsked()).toEqual([PRIMARY]);
    }
  });
});

describe("thinking", () => {
  const levels = () =>
    generateContent.mock.calls.map(([request]) => request.config.thinkingConfig?.thinkingLevel);

  it("is kept low for the facts and for reading listings", async () => {
    answers({});
    await extractFacts(transcript, photos, intake);
    answers({}, READING_JSON);
    await readListings(facts, sources);
    expect(levels()).toEqual([ThinkingLevel.LOW, ThinkingLevel.LOW]);
  });

  it("is kept low for a streamed reply", async () => {
    generateContentStream.mockImplementation(async () => says("ok"));
    await collect(streamReply(transcript, photos, "probe", context));
    expect(generateContentStream.mock.calls[0][0].config.thinkingConfig).toEqual({
      thinkingLevel: ThinkingLevel.LOW,
    });
  });

  it("is dropped for a model that answers 400 to it, and not asked of that model again", async () => {
    generateContent.mockImplementation(async (request: { config: { thinkingConfig?: unknown } }) => {
      if (request.config.thinkingConfig) {
        throw new ApiError({ message: "Thinking level is not supported for this model", status: 400 });
      }
      return { text: FACTS_JSON };
    });
    expect((await extractFacts(transcript, photos, intake)).model).toBe("x");
    expect(levels()).toEqual([ThinkingLevel.LOW, undefined]);
    expect(modelsAsked()).toEqual([PRIMARY, PRIMARY]);

    generateContent.mockClear();
    await extractFacts(transcript, photos, intake);
    expect(levels()).toEqual([undefined]);
  });

  it("does not hide any other 400", async () => {
    answers({ [PRIMARY]: refuse(400) });
    await expect(extractFacts(transcript, photos, intake)).rejects.toBeInstanceOf(ApiError);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("when every model refuses", () => {
  const all = (status: number) => answers({ [PRIMARY]: refuse(status), [SECOND]: refuse(status), [THIRD]: refuse(status) });

  it("reports a quota error, naming every model that was asked", async () => {
    all(429);
    const error = await extractFacts(transcript, photos, intake).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.tried).toEqual([PRIMARY, SECOND, THIRD]);
    expect(triedNote(error)).toBe(` Tried ${PRIMARY}, ${SECOND}, ${THIRD}.`);
  });

  it("reports an overload when that is all there was", async () => {
    all(503);
    const error = await extractFacts(transcript, photos, intake).catch((e) => e);
    expect(error).toBeInstanceOf(ModelOverloadedError);
    expect(error.tried).toHaveLength(3);
  });

  it("reports a missing-model configuration problem when every name 404s", async () => {
    all(404);
    const error = await extractFacts(transcript, photos, intake).catch((e) => e);
    expect(error).toBeInstanceOf(ModelNotFoundError);
    expect(error.message).toMatch(/available to this key/);
  });

  it("lets a quota error win over an overload, since it is the one to act on", async () => {
    answers({ [PRIMARY]: refuse(503), [SECOND]: refuse(429), [THIRD]: refuse(503) });
    expect(await extractFacts(transcript, photos, intake).catch((e) => e)).toBeInstanceOf(RateLimitError);
  });

  it("lets an overload win over a missing name", async () => {
    answers({ [PRIMARY]: refuse(404), [SECOND]: refuse(503), [THIRD]: refuse(404) });
    expect(await extractFacts(transcript, photos, intake).catch((e) => e)).toBeInstanceOf(ModelOverloadedError);
  });

  it("adds no note when only one model was ever asked", () => {
    expect(triedNote(new RateLimitError([PRIMARY]))).toBe("");
    expect(triedNote(new RateLimitError())).toBe("");
    expect(triedNote(new Error("plain"))).toBe("");
  });

  it("with no chain configured, asks the one model and reports its error", async () => {
    process.env.GEMINI_FALLBACK_MODELS = "";
    answers({ [PRIMARY]: refuse(429) });
    const error = await extractFacts(transcript, photos, intake).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(modelsAsked()).toEqual([PRIMARY]);
  });
});

describe("remembering a refusal", () => {
  const start = new Date("2026-10-22T12:00:00Z");

  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: start }));

  it("asks a model that just refused last, so the next call does not open with a refusal", async () => {
    answers({ [PRIMARY]: refuse(429) });
    await extractFacts(transcript, photos, intake);
    expect(isCoolingDown(PRIMARY)).toBe(true);

    generateContent.mockClear();
    await extractFacts(transcript, photos, intake);
    expect(modelsAsked()).toEqual([SECOND]); // straight to one that worked
  });

  it("goes back to the pinned model after a minute", async () => {
    answers({ [PRIMARY]: refuse(429) });
    await extractFacts(transcript, photos, intake);

    vi.setSystemTime(new Date(start.getTime() + 61_000));
    generateContent.mockClear();
    answers({});
    await extractFacts(transcript, photos, intake);
    expect(modelsAsked()).toEqual([PRIMARY]);
  });

  it("remembers a name that does not exist for much longer", async () => {
    answers({ [PRIMARY]: refuse(404) });
    await extractFacts(transcript, photos, intake);

    vi.setSystemTime(new Date(start.getTime() + 5 * 60_000));
    expect(isCoolingDown(PRIMARY)).toBe(true);
    vi.setSystemTime(new Date(start.getTime() + 11 * 60_000));
    expect(isCoolingDown(PRIMARY)).toBe(false);
  });

  it("never refuses to try: with every model cooling it asks them all again, in order", async () => {
    answers({ [PRIMARY]: refuse(429), [SECOND]: refuse(429), [THIRD]: refuse(429) });
    await extractFacts(transcript, photos, intake).catch(() => {});

    generateContent.mockClear();
    answers({ [THIRD]: FACTS_JSON, [PRIMARY]: refuse(429), [SECOND]: refuse(429) });
    await extractFacts(transcript, photos, intake);
    expect(modelsAsked()).toEqual([PRIMARY, SECOND, THIRD]);
  });

  it("does not remember a model that answered, nor one that failed for another reason", async () => {
    answers({ [PRIMARY]: refuse(400) });
    await extractFacts(transcript, photos, intake).catch(() => {});
    expect(isCoolingDown(PRIMARY)).toBe(false);
  });
});

describe("a streamed reply", () => {
  it("moves on when the stream cannot be opened", async () => {
    generateContentStream.mockImplementation(async (request: { model: string }) => {
      if (request.model === PRIMARY) throw refuse(429);
      return says("from ", request.model);
    });
    expect(await collect(streamReply(transcript, photos, "probe", context))).toBe(`from ${SECOND}`);
  });

  it("moves on when the first read is refused", async () => {
    generateContentStream.mockImplementation(async (request: { model: string }) =>
      request.model === PRIMARY ? failsBeforeSaying(refuse(503)) : says("ok"),
    );
    expect(await collect(streamReply(transcript, photos, "probe", context))).toBe("ok");
    expect(generateContentStream.mock.calls.map(([r]) => r.model)).toEqual([PRIMARY, SECOND]);
  });

  it("does not splice a second model onto a reply that has started", async () => {
    generateContentStream.mockImplementation(async () => failsAfterSaying(refuse(429), "half a rep"));
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of streamReply(transcript, photos, "probe", context)) seen.push(chunk);
      })(),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(seen).toEqual(["half a rep"]);
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });

  it("reports every model when all of them refuse", async () => {
    generateContentStream.mockImplementation(async () => {
      throw refuse(429);
    });
    const error = await collect(streamReply(transcript, photos, "probe", context)).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.tried).toEqual([PRIMARY, SECOND, THIRD]);
  });

  it("moves on for a timeout before the reply began, and reports it when all of them timed out", async () => {
    generateContentStream.mockImplementation(async () => {
      throw timedOut();
    });
    await expect(collect(streamReply(transcript, photos, "probe", context))).rejects.toBeInstanceOf(ModelTimeoutError);
    expect(generateContentStream).toHaveBeenCalledTimes(3);
  });
});

describe("configuring the chain", () => {
  it("is the pinned model followed by the others, in order", () => {
    expect(env.geminiModels).toEqual([PRIMARY, SECOND, THIRD]);
  });

  it("trims names, drops blanks, and drops repeats including the pinned model", () => {
    process.env.GEMINI_FALLBACK_MODELS = ` ${SECOND} , ,${PRIMARY},${SECOND}, ${THIRD} `;
    expect(env.geminiModels).toEqual([PRIMARY, SECOND, THIRD]);
  });

  it("has a default list when the variable is not set at all", () => {
    delete process.env.GEMINI_FALLBACK_MODELS;
    expect(env.geminiModels[0]).toBe(PRIMARY);
    expect(env.geminiModels.length).toBeGreaterThan(1);
    expect(env.geminiModels).toContain("gemini-3.5-flash");
  });

  it("is just the pinned model when the variable is set to nothing", () => {
    process.env.GEMINI_FALLBACK_MODELS = "";
    expect(env.geminiModels).toEqual([PRIMARY]);
  });
});
