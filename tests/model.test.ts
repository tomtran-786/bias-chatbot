/**
 * When a backup model takes over, which one, and when it must not.
 *
 * Gemini and both backends are replaced, so these tests are about the routing alone:
 * which errors count as "Gemini is unavailable", the order the backups are tried in
 * (free before paid), what they are and are not handed, and what the caller is told.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gemini = vi.hoisted(() => ({
  extractFacts: vi.fn(),
  readListings: vi.fn(),
  streamReply: vi.fn(),
}));
const makeBackend = (name: string) => ({
  name,
  configured: true,
  isConfigured() {
    return this.configured;
  },
  extractFacts: vi.fn(),
  readListings: vi.fn(),
  streamReply: vi.fn(),
});
const backends = vi.hoisted(() => ({
  openrouter: null as unknown as ReturnType<typeof makeBackend>,
  deepseek: null as unknown as ReturnType<typeof makeBackend>,
}));
// Built inside the hoisted factory scope so vi.mock can see them.
backends.openrouter = makeBackend("OpenRouter");
backends.deepseek = makeBackend("DeepSeek");

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return { ...actual, ...gemini };
});
vi.mock("@/lib/openrouter", () => ({ openrouter: backends.openrouter }));
vi.mock("@/lib/deepseek", () => ({ deepseek: backends.deepseek }));

const { BackupFailedError, backupNote, extractFacts, primaryOf, readListings, streamReply } = await import("@/lib/model");
const { MalformedAppraisalError, ModelOverloadedError, ModelTimeoutError, RateLimitError } = await import("@/lib/gemini");
const { BackendQuotaError } = await import("@/lib/backup");

const { openrouter, deepseek } = backends;

const at = new Date().toISOString();
const transcript = [{ role: "user" as const, text: "hi", at, photoIds: ["p1"] }];
const photos = [{ id: "p1", mime: "image/jpeg" as const, data: "eA==" }];
const intake = { item: "iPhone 13" };
const facts = {
  searchQuery: "x", model: "x", variant: null, ageMonths: null, condition: "good" as const, category: "other" as const, included: [], defects: [], purchasePrice: null,
};
const reading = { listings: [], newPrice: null, position: "typical" as const, positionEvidence: "" };
const context = { intake, photoCount: 1 };

async function* says(...chunks: string[]) {
  for (const chunk of chunks) yield chunk;
}
async function* failsWith(error: Error, ...before: string[]) {
  for (const chunk of before) yield chunk;
  throw error;
}
const collect = async (generator: AsyncGenerator<string>) => {
  let out = "";
  for await (const chunk of generator) out += chunk;
  return out;
};

beforeEach(() => {
  for (const mock of [...Object.values(gemini)]) mock.mockReset();
  for (const b of [openrouter, deepseek]) {
    b.extractFacts.mockReset();
    b.readListings.mockReset();
    b.streamReply.mockReset();
    b.configured = true;
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("extractFacts", () => {
  it("uses Gemini when it works, and never touches a backup", async () => {
    gemini.extractFacts.mockResolvedValue(facts);
    const onFallback = vi.fn();
    expect(await extractFacts(transcript, photos, intake, onFallback)).toBe(facts);
    expect(openrouter.extractFacts).not.toHaveBeenCalled();
    expect(deepseek.extractFacts).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it.each([
    ["a quota error", () => new RateLimitError()],
    ["an overload", () => new ModelOverloadedError()],
  ])("falls back on %s, to the free backup first, and says which answered", async (_label, error) => {
    gemini.extractFacts.mockRejectedValue(error());
    openrouter.extractFacts.mockResolvedValue(facts);
    const onFallback = vi.fn();

    expect(await extractFacts(transcript, photos, intake, onFallback)).toBe(facts);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith("OpenRouter");
    expect(deepseek.extractFacts).not.toHaveBeenCalled(); // never reached for money while a free one answers
  });

  it("hands over to DeepSeek only when OpenRouter failed", async () => {
    gemini.extractFacts.mockRejectedValue(new RateLimitError());
    openrouter.extractFacts.mockRejectedValue(new Error("free models are all busy"));
    deepseek.extractFacts.mockResolvedValue(facts);
    const onFallback = vi.fn();

    expect(await extractFacts(transcript, photos, intake, onFallback)).toBe(facts);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith("DeepSeek"); // not told about the one that failed
  });

  it("hands over even when the free backup answered badly: Gemini has refused, so any answer beats none", async () => {
    gemini.extractFacts.mockRejectedValue(new RateLimitError());
    openrouter.extractFacts.mockRejectedValue(new MalformedAppraisalError("not json"));
    deepseek.extractFacts.mockResolvedValue(facts);
    expect(await extractFacts(transcript, photos, intake)).toBe(facts);
  });

  it("uses whichever backup is set up, and skips one that is not", async () => {
    gemini.extractFacts.mockRejectedValue(new RateLimitError());
    openrouter.configured = false;
    deepseek.extractFacts.mockResolvedValue(facts);
    const onFallback = vi.fn();
    await extractFacts(transcript, photos, intake, onFallback);
    expect(onFallback).toHaveBeenCalledWith("DeepSeek");
    expect(openrouter.extractFacts).not.toHaveBeenCalled();
  });

  it("hands every backup the conversation and no photos", async () => {
    gemini.extractFacts.mockRejectedValue(new RateLimitError());
    openrouter.extractFacts.mockRejectedValue(new Error("busy"));
    deepseek.extractFacts.mockResolvedValue(facts);
    await extractFacts(transcript, photos, intake);
    for (const b of [openrouter, deepseek]) expect(b.extractFacts).toHaveBeenCalledWith(transcript, intake);
    expect(JSON.stringify([openrouter.extractFacts.mock.calls, deepseek.extractFacts.mock.calls])).not.toContain("eA==");
  });

  it("does not fall back when no backup is configured: the Gemini error is reported as it is", async () => {
    openrouter.configured = false;
    deepseek.configured = false;
    const error = new RateLimitError();
    gemini.extractFacts.mockRejectedValue(error);
    await expect(extractFacts(transcript, photos, intake)).rejects.toBe(error);
  });

  it.each([
    ["a timeout", () => new ModelTimeoutError()],
    ["a malformed answer from Gemini", () => new MalformedAppraisalError("bad")],
    ["any other failure", () => new Error("boom")],
  ])("does not fall back on %s", async (_label, error) => {
    const thrown = error();
    gemini.extractFacts.mockRejectedValue(thrown);
    await expect(extractFacts(transcript, photos, intake)).rejects.toBe(thrown);
    expect(openrouter.extractFacts).not.toHaveBeenCalled();
    expect(deepseek.extractFacts).not.toHaveBeenCalled();
  });

  it("reports every backup's failure, in the order tried, with Gemini's as the one to classify", async () => {
    const primary = new RateLimitError();
    const first = new Error("the free models are rate limited");
    const second = new BackendQuotaError("DeepSeek");
    gemini.extractFacts.mockRejectedValue(primary);
    openrouter.extractFacts.mockRejectedValue(first);
    deepseek.extractFacts.mockRejectedValue(second);

    const error = await extractFacts(transcript, photos, intake).catch((e) => e);

    expect(error).toBeInstanceOf(BackupFailedError);
    expect(primaryOf(error)).toBe(primary);
    expect(error.backups).toEqual([
      { provider: "OpenRouter", error: first },
      { provider: "DeepSeek", error: second },
    ]);
    const note = backupNote(error);
    expect(note).toContain("OpenRouter: the free models are rate limited");
    expect(note).toContain("DeepSeek: The DeepSeek balance is empty");
  });

  it("names the one backup when only one was tried", async () => {
    openrouter.configured = false;
    gemini.extractFacts.mockRejectedValue(new RateLimitError());
    deepseek.extractFacts.mockRejectedValue(new BackendQuotaError("DeepSeek"));
    const error = await extractFacts(transcript, photos, intake).catch((e) => e);
    expect(backupNote(error)).toBe(" The backup model (DeepSeek) failed too: The DeepSeek balance is empty.");
  });

  it("has no note and no unwrapping for an ordinary error", () => {
    const error = new Error("plain");
    expect(primaryOf(error)).toBe(error);
    expect(backupNote(error)).toBe("");
  });
});

describe("readListings", () => {
  const sources = [{ url: "https://a.example/1", title: "t", text: "$5" }];

  it("falls back on quota, handing the backup the same facts and sources", async () => {
    gemini.readListings.mockRejectedValue(new RateLimitError());
    openrouter.readListings.mockResolvedValue(reading);
    const onFallback = vi.fn();

    expect(await readListings(facts, sources, onFallback)).toBe(reading);
    expect(openrouter.readListings).toHaveBeenCalledWith(facts, sources);
    expect(onFallback).toHaveBeenCalledWith("OpenRouter");
  });

  it("does not fall back when Gemini answered, even if the answer was bad", async () => {
    gemini.readListings.mockRejectedValue(new MalformedAppraisalError("bad"));
    await expect(readListings(facts, sources)).rejects.toBeInstanceOf(MalformedAppraisalError);
    expect(openrouter.readListings).not.toHaveBeenCalled();
  });
});

describe("streamReply", () => {
  it("streams Gemini's reply untouched when it works", async () => {
    gemini.streamReply.mockReturnValue(says("a", "b"));
    const onFallback = vi.fn();
    expect(await collect(streamReply(transcript, photos, "probe", context, onFallback))).toBe("ab");
    expect(openrouter.streamReply).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("falls back when Gemini fails before saying anything, telling the caller before the first words", async () => {
    gemini.streamReply.mockReturnValue(failsWith(new RateLimitError()));
    openrouter.streamReply.mockReturnValue(says("from ", "openrouter"));
    const order: string[] = [];

    for await (const chunk of streamReply(transcript, photos, "probe", context, (p) => order.push(`notice:${p}`))) {
      order.push(chunk);
    }

    expect(order).toEqual(["notice:OpenRouter", "from ", "openrouter"]);
  });

  it("announces only the backup that answered: one that fails to start is not mistaken for it", async () => {
    gemini.streamReply.mockReturnValue(failsWith(new RateLimitError()));
    openrouter.streamReply.mockReturnValue(failsWith(new Error("429 from the free provider")));
    deepseek.streamReply.mockReturnValue(says("deepseek here"));
    const onFallback = vi.fn();

    expect(await collect(streamReply(transcript, photos, "probe", context, onFallback))).toBe("deepseek here");
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith("DeepSeek");
  });

  it("treats a backup that says nothing as having failed", async () => {
    gemini.streamReply.mockReturnValue(failsWith(new ModelOverloadedError()));
    openrouter.streamReply.mockReturnValue(says());
    deepseek.streamReply.mockReturnValue(says("ok"));
    const onFallback = vi.fn();
    expect(await collect(streamReply(transcript, photos, "probe", context, onFallback))).toBe("ok");
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith("DeepSeek");
  });

  it("hands the backups no photos", async () => {
    gemini.streamReply.mockReturnValue(failsWith(new ModelOverloadedError()));
    openrouter.streamReply.mockReturnValue(says("ok"));
    await collect(streamReply(transcript, photos, "probe", context));
    expect(openrouter.streamReply).toHaveBeenCalledWith(transcript, "probe", context);
  });

  it("does not splice a backup onto a Gemini reply that has already started", async () => {
    const error = new RateLimitError();
    gemini.streamReply.mockReturnValue(failsWith(error, "half a rep"));
    const onFallback = vi.fn();

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of streamReply(transcript, photos, "probe", context, onFallback)) seen.push(chunk);
      })(),
    ).rejects.toBe(error);
    expect(seen).toEqual(["half a rep"]);
    expect(openrouter.streamReply).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("does not let a second backup continue one that has already spoken", async () => {
    gemini.streamReply.mockReturnValue(failsWith(new RateLimitError()));
    openrouter.streamReply.mockReturnValue(failsWith(new Error("connection dropped"), "half a rep"));

    const seen: string[] = [];
    const error = await (async () => {
      for await (const chunk of streamReply(transcript, photos, "probe", context)) seen.push(chunk);
    })().catch((e) => e);

    expect(seen).toEqual(["half a rep"]);
    expect(error).toBeInstanceOf(BackupFailedError);
    expect(deepseek.streamReply).not.toHaveBeenCalled();
  });

  it("does not fall back without a backup, or for an error that is not about availability", async () => {
    openrouter.configured = false;
    deepseek.configured = false;
    gemini.streamReply.mockReturnValue(failsWith(new RateLimitError()));
    await expect(collect(streamReply(transcript, photos, "probe", context))).rejects.toBeInstanceOf(RateLimitError);

    openrouter.configured = true;
    gemini.streamReply.mockReturnValue(failsWith(new ModelTimeoutError()));
    await expect(collect(streamReply(transcript, photos, "probe", context))).rejects.toBeInstanceOf(ModelTimeoutError);
    expect(openrouter.streamReply).not.toHaveBeenCalled();
  });

  it("reports every backup when they all fail", async () => {
    const primary = new RateLimitError();
    gemini.streamReply.mockReturnValue(failsWith(primary));
    openrouter.streamReply.mockReturnValue(failsWith(new Error("busy")));
    deepseek.streamReply.mockReturnValue(failsWith(new BackendQuotaError("DeepSeek")));

    const error = await collect(streamReply(transcript, photos, "probe", context)).catch((e) => e);
    expect(error).toBeInstanceOf(BackupFailedError);
    expect(primaryOf(error)).toBe(primary);
    expect(error.backups.map((b: { provider: string }) => b.provider)).toEqual(["OpenRouter", "DeepSeek"]);
  });
});
