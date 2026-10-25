/**
 * The browser's three-step lookup: the order it runs them in, what it reuses, and
 * which failures it tries again.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MarketError,
  isAbort,
  runMarket,
  type MarketCache,
  type MarketRun,
} from "@/lib/market-client";

const at = new Date().toISOString();
const photo = { id: "p1", mime: "image/jpeg" as const, data: "eA==" };
const run: MarketRun = {
  intake: { item: "iPhone 13" },
  photos: [photo],
  transcript: [
    { role: "user", text: "I'm selling: iPhone 13", at, photoIds: ["p1"] },
    { role: "model", text: "How much did you pay?", at },
  ],
};

const item = (over: Record<string, unknown> = {}) => ({
  searchQuery: "iPhone 13 128GB",
  model: "iPhone 13",
  variant: null,
  ageMonths: null,
  condition: "good",
  included: [],
  defects: [],
  purchasePrice: 600,
  ...over,
});
const raw = (i = item()) => ({
  item: i,
  listings: [],
  newPrice: null,
  newPriceUrl: null,
  position: "typical",
  positionEvidence: "",
  vndPerUsd: 26_000,
});
const sources = [{ url: "https://www.chotot.com/1.htm", title: "t", text: "5.500.000 ₫" }];

type Answer = { status?: number; body: unknown } | Error;

/** A server that answers each step from a queue, and remembers what it was sent. */
function server(answers: Partial<Record<"facts" | "search" | "read", Answer[]>> = {}) {
  const queues = {
    facts: [...(answers.facts ?? [{ body: { item: item(), backup: [] } }])],
    search: [...(answers.search ?? [{ body: { sources, queries: ["q1", "q2", "q3"] } }])],
    read: [...(answers.read ?? [{ body: { raw: raw(), backup: [{ step: "reading", provider: "OpenRouter" }] } }])],
  };
  const sent: Array<{ step: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push({ step: body.step, body });
    const next = queues[body.step as keyof typeof queues].shift();
    if (!next) throw new Error(`unexpected extra ${body.step} request`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, steps: () => sent.map((s) => s.step) };
}

const fail = (status: number, error: string) => ({ status, body: { error, reason: "why" } });

describe("running the lookup", () => {
  it("runs facts, search and read in order, and returns what the card is built from", async () => {
    const { fetchImpl, steps } = server();
    const result = await runMarket(run, {}, { fetchImpl });

    expect(steps()).toEqual(["facts", "search", "read"]);
    expect(result.item.model).toBe("iPhone 13");
    expect(result.queries).toEqual(["q1", "q2", "q3"]);
    expect(result.raw.vndPerUsd).toBe(26_000);
    expect(result.backup).toEqual([{ step: "reading", provider: "OpenRouter" }]);
  });

  it("sends each step only what it needs", async () => {
    const { fetchImpl, sent } = server();
    await runMarket(run, {}, { fetchImpl });

    expect(Object.keys(sent[0].body).sort()).toEqual(["intake", "photos", "step", "transcript"]);
    expect(Object.keys(sent[1].body).sort()).toEqual(["item", "step", "transcript"]);
    expect(Object.keys(sent[2].body).sort()).toEqual(["item", "sources", "step", "transcript"]);
    // No photo goes anywhere but the step that reads them.
    expect(JSON.stringify([sent[1], sent[2]])).not.toContain(photo.data);
  });

  it("is never given a price to send: there is none in a run", () => {
    expect(Object.keys(run).sort()).toEqual(["intake", "photos", "transcript"]);
  });

  it("reports each step as it starts, and 'done' at the end", async () => {
    const { fetchImpl } = server();
    const seen: string[] = [];
    await runMarket(run, {}, { fetchImpl, onStep: (s) => seen.push(s) });
    expect(seen).toEqual(["facts", "search", "read", "done"]);
  });

  it("stops with needs_identity when the item was never pinned down, and keeps the facts", async () => {
    const cache: MarketCache = {};
    const { fetchImpl, steps } = server({ facts: [fail(422, "needs_identity")] });
    const error = await runMarket(run, cache, { fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(MarketError);
    expect(error.code).toBe("needs_identity");
    expect(steps()).toEqual(["facts"]);
  });
});

describe("trying a step again", () => {
  it.each([
    ["a server error", fail(502, "appraisal_failed")],
    ["a timeout", fail(504, "appraisal_failed")],
    ["a failed search", fail(502, "search_failed")],
  ])("tries %s once more, and that is all", async (_label, failure) => {
    const { fetchImpl, steps } = server({ search: [failure, { body: { sources, queries: ["q"] } }] });
    await expect(runMarket(run, {}, { fetchImpl })).resolves.toBeDefined();
    expect(steps()).toEqual(["facts", "search", "search", "read"]);

    const hopeless = server({ search: [failure, failure, { body: { sources, queries: [] } }] });
    const error = await runMarket(run, {}, { fetchImpl: hopeless.fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(MarketError);
    expect(hopeless.steps()).toEqual(["facts", "search", "search"]);
  });

  it("tries a dropped connection once more", async () => {
    const { fetchImpl, steps } = server({
      facts: [new TypeError("fetch failed"), { body: { item: item(), backup: [] } }],
    });
    await runMarket(run, {}, { fetchImpl });
    expect(steps().slice(0, 2)).toEqual(["facts", "facts"]);
  });

  it.each([
    ["quota", fail(429, "search_quota")],
    ["a rate limit", fail(429, "rate_limited")],
    ["a spent budget", fail(429, "budget_exhausted")],
    ["a bad key", fail(503, "search_unavailable")],
    ["an unfinished conversation", fail(409, "out_of_order")],
  ])("never tries again after %s", async (_label, failure) => {
    const { fetchImpl, steps } = server({ search: [failure, { body: { sources, queries: [] } }] });
    const error = await runMarket(run, {}, { fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(MarketError);
    expect(steps()).toEqual(["facts", "search"]);
  });

  it("carries the server's reason and code up", async () => {
    const { fetchImpl } = server({ facts: [fail(429, "rate_limited")] });
    const error = await runMarket(run, {}, { fetchImpl }).catch((e) => e);
    expect(error).toMatchObject({ code: "rate_limited", status: 429, reason: "why" });
  });

  it("does not try again once it has been told to stop", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    const error = await runMarket(run, {}, { fetchImpl, signal: controller.signal }).catch((e) => e);
    expect(isAbort(error)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("what a second run reuses", () => {
  it("does nothing at all when the conversation has not moved on", async () => {
    const cache: MarketCache = {};
    const first = server();
    await runMarket(run, cache, { fetchImpl: first.fetchImpl });

    const second = server({ facts: [], search: [], read: [] });
    const result = await runMarket(run, cache, { fetchImpl: second.fetchImpl });
    expect(second.sent).toHaveLength(0);
    expect(result.queries).toEqual(["q1", "q2", "q3"]);
  });

  it("reads the facts again when the person said more, but not the search if the item is the same", async () => {
    const cache: MarketCache = {};
    await runMarket(run, cache, { fetchImpl: server().fetchImpl });

    const longer: MarketRun = {
      ...run,
      transcript: [...run.transcript, { role: "user", text: "two years, scratches", at }],
    };
    const second = server({
      facts: [{ body: { item: item({ defects: ["scratches"] }), backup: [] } }],
      search: [],
      read: [{ body: { raw: raw(item({ defects: ["scratches"] })), backup: [] } }],
    });
    const result = await runMarket(longer, cache, { fetchImpl: second.fetchImpl });

    expect(second.steps()).toEqual(["facts", "read"]);
    expect(result.item.defects).toEqual(["scratches"]);
  });

  it("searches again when the item turned out to be a different one", async () => {
    const cache: MarketCache = {};
    await runMarket(run, cache, { fetchImpl: server().fetchImpl });

    const longer: MarketRun = {
      ...run,
      transcript: [...run.transcript, { role: "user", text: "actually it is a 13 Pro", at }],
    };
    const pro = item({ searchQuery: "iPhone 13 Pro", model: "iPhone 13 Pro" });
    const second = server({
      facts: [{ body: { item: pro, backup: [] } }],
      search: [{ body: { sources, queries: ["pro"] } }],
      read: [{ body: { raw: raw(pro), backup: [] } }],
    });
    const result = await runMarket(longer, cache, { fetchImpl: second.fetchImpl });
    expect(second.steps()).toEqual(["facts", "search", "read"]);
    expect(result.queries).toEqual(["pro"]);
  });

  it("does not read again when only what they paid changed: the reading never sees it", async () => {
    const cache: MarketCache = {};
    await runMarket(run, cache, { fetchImpl: server().fetchImpl });

    const longer: MarketRun = {
      ...run,
      transcript: [...run.transcript, { role: "user", text: "I paid 700", at }],
    };
    const second = server({
      facts: [{ body: { item: item({ purchasePrice: 700 }), backup: [] } }],
      search: [],
      read: [],
    });
    const result = await runMarket(longer, cache, { fetchImpl: second.fetchImpl });
    expect(second.steps()).toEqual(["facts"]);
    // ...but the verdict is told the latest figure.
    expect(result.raw.item.purchasePrice).toBe(700);
  });

  it("picks up where a failed run stopped", async () => {
    const cache: MarketCache = {};
    const failing = server({ read: [fail(429, "rate_limited")] });
    await runMarket(run, cache, { fetchImpl: failing.fetchImpl }).catch(() => {});

    const again = server({ facts: [], search: [] });
    const result = await runMarket(run, cache, { fetchImpl: again.fetchImpl });
    expect(again.steps()).toEqual(["read"]);
    expect(result.raw.listings).toEqual([]);
  });
});
