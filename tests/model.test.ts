/**
 * When the backup model takes over, and when it must not.
 *
 * Both model modules are replaced, so these tests are about the routing alone:
 * which errors count as "Gemini is unavailable", what the backup is and is not
 * handed, and what the caller is told.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gemini = vi.hoisted(() => ({
  extractFacts: vi.fn(),
  readListings: vi.fn(),
  streamReply: vi.fn(),
}));
const deepseek = vi.hoisted(() => ({
  configured: true,
  extractFacts: vi.fn(),
  readListings: vi.fn(),
  streamReply: vi.fn(),
}));

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return { ...actual, ...gemini };
});
vi.mock("@/lib/deepseek", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/deepseek")>();
  return {
    ...actual,
    isConfigured: () => deepseek.configured,
    extractFacts: deepseek.extractFacts,
    readListings: deepseek.readListings,
    streamReply: deepseek.streamReply,
  };
});

const { BackupFailedError, backupNote, extractFacts, primaryOf, readListings, streamReply } = await import("@/lib/model");
const { MalformedAppraisalError, ModelOverloadedError, ModelTimeoutError, RateLimitError } = await import("@/lib/gemini");
const { DeepSeekQuotaError } = await import("@/lib/deepseek");

const at = new Date().toISOString();
const transcript = [{ role: "user" as const, text: "hi", at, photoIds: ["p1"] }];
const photos = [{ id: "p1", mime: "image/jpeg" as const, data: "eA==" }];
const intake = { item: "iPhone 13" };
const facts = {
  searchQuery: "x", model: "x", variant: null, ageMonths: null, condition: "good" as const, included: [], defects: [], purchasePrice: null,
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
  for (const mock of [...Object.values(gemini), deepseek.extractFacts, deepseek.readListings, deepseek.streamReply]) mock.mockReset();
  deepseek.configured = true;
});

describe("extractFacts", () => {
  it("uses Gemini when it works, and never touches the backup", async () => {
    gemini.extractFacts.mockResolvedValue(facts);
    const onFallback = vi.fn();
    expect(await extractFacts(transcript, photos, intake, onFallback)).toBe(facts);
    expect(deepseek.extractFacts).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it.each([
    ["a quota error", () => new RateLimitError()],
    ["an overload", () => new ModelOverloadedError()],
  ])("falls back on %s, and says so", async (_label, error) => {
    gemini.extractFacts.mockRejectedValue(error());
    deepseek.extractFacts.mockResolvedValue(facts);
    const onFallback = vi.fn();

    expect(await extractFacts(transcript, photos, intake, onFallback)).toBe(facts);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("hands the backup the conversation and no photos", async () => {
    gemini.extractFacts.mockRejectedValue(new RateLimitError());
    deepseek.extractFacts.mockResolvedValue(facts);
    await extractFacts(transcript, photos, intake);
    expect(deepseek.extractFacts).toHaveBeenCalledWith(transcript, intake);
    expect(JSON.stringify(deepseek.extractFacts.mock.calls)).not.toContain("eA==");
  });

  it("does not fall back when there is no backup configured: the Gemini error is reported as it is", async () => {
    deepseek.configured = false;
    const error = new RateLimitError();
    gemini.extractFacts.mockRejectedValue(error);
    await expect(extractFacts(transcript, photos, intake)).rejects.toBe(error);
    expect(deepseek.extractFacts).not.toHaveBeenCalled();
  });

  it.each([
    ["a timeout", () => new ModelTimeoutError()],
    ["a malformed answer", () => new MalformedAppraisalError("bad")],
    ["any other failure", () => new Error("boom")],
  ])("does not fall back on %s", async (_label, error) => {
    const thrown = error();
    gemini.extractFacts.mockRejectedValue(thrown);
    await expect(extractFacts(transcript, photos, intake)).rejects.toBe(thrown);
    expect(deepseek.extractFacts).not.toHaveBeenCalled();
  });

  it("reports both failures, with Gemini's as the one to classify", async () => {
    const primary = new RateLimitError();
    const backup = new DeepSeekQuotaError();
    gemini.extractFacts.mockRejectedValue(primary);
    deepseek.extractFacts.mockRejectedValue(backup);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const error = await extractFacts(transcript, photos, intake).catch((e) => e);
    expect(error).toBeInstanceOf(BackupFailedError);
    expect(error.primary).toBe(primary);
    expect(error.backup).toBe(backup);
    expect(primaryOf(error)).toBe(primary);
    expect(backupNote(error)).toContain("DeepSeek");
    expect(backupNote(error)).toContain("balance is empty");
  });

  it("has no note and no unwrapping for an ordinary error", () => {
    const error = new Error("plain");
    expect(primaryOf(error)).toBe(error);
    expect(backupNote(error)).toBe("");
  });
});

describe("readListings", () => {
  const sources = [{ url: "https://a.example/1", title: "t", text: "$5" }];

  it("falls back on quota, and hands the backup the same facts and sources", async () => {
    gemini.readListings.mockRejectedValue(new RateLimitError());
    deepseek.readListings.mockResolvedValue(reading);
    const onFallback = vi.fn();

    expect(await readListings(facts, sources, onFallback)).toBe(reading);
    expect(deepseek.readListings).toHaveBeenCalledWith(facts, sources);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when Gemini answered, even if the answer was bad", async () => {
    gemini.readListings.mockRejectedValue(new MalformedAppraisalError("bad"));
    await expect(readListings(facts, sources)).rejects.toBeInstanceOf(MalformedAppraisalError);
    expect(deepseek.readListings).not.toHaveBeenCalled();
  });
});

describe("streamReply", () => {
  it("streams Gemini's reply untouched when it works", async () => {
    gemini.streamReply.mockReturnValue(says("a", "b"));
    const onFallback = vi.fn();
    expect(await collect(streamReply(transcript, photos, "probe", context, onFallback))).toBe("ab");
    expect(deepseek.streamReply).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("falls back when Gemini fails before saying anything, telling the caller first", async () => {
    gemini.streamReply.mockReturnValue(failsWith(new RateLimitError()));
    deepseek.streamReply.mockReturnValue(says("from ", "deepseek"));
    const order: string[] = [];

    const stream = streamReply(transcript, photos, "probe", context, () => order.push("notice"));
    for await (const chunk of stream) order.push(chunk);

    expect(order).toEqual(["notice", "from ", "deepseek"]);
  });

  it("hands the backup no photos", async () => {
    gemini.streamReply.mockReturnValue(failsWith(new ModelOverloadedError()));
    deepseek.streamReply.mockReturnValue(says("ok"));
    await collect(streamReply(transcript, photos, "probe", context));
    expect(deepseek.streamReply).toHaveBeenCalledWith(transcript, "probe", context);
  });

  it("does not splice a second model onto a reply that has already started", async () => {
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
    expect(deepseek.streamReply).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("does not fall back without a backup, or for an error that is not about availability", async () => {
    deepseek.configured = false;
    gemini.streamReply.mockReturnValue(failsWith(new RateLimitError()));
    await expect(collect(streamReply(transcript, photos, "probe", context))).rejects.toBeInstanceOf(RateLimitError);

    deepseek.configured = true;
    gemini.streamReply.mockReturnValue(failsWith(new ModelTimeoutError()));
    await expect(collect(streamReply(transcript, photos, "probe", context))).rejects.toBeInstanceOf(ModelTimeoutError);
    expect(deepseek.streamReply).not.toHaveBeenCalled();
  });

  it("reports both when the backup's stream fails too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const primary = new RateLimitError();
    gemini.streamReply.mockReturnValue(failsWith(primary));
    deepseek.streamReply.mockReturnValue(failsWith(new DeepSeekQuotaError()));

    const error = await collect(streamReply(transcript, photos, "probe", context)).catch((e) => e);
    expect(error).toBeInstanceOf(BackupFailedError);
    expect(primaryOf(error)).toBe(primary);
  });
});
