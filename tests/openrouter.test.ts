/**
 * OpenRouter as a backup, and above all the guarantee that it never costs anything:
 * only `:free` models (and the free router) are ever called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackendFailedError,
  BackendNotFoundError,
  BackendQuotaError,
  BackendRateLimitError,
  BackendUnavailableError,
  detailFromBody,
} from "@/lib/backup";
import { env } from "@/lib/env";
import { allowedModels, isFreeModel, openrouter } from "@/lib/openrouter";

const KEY = "sk-or-test-key-0123456789";
const at = new Date().toISOString();
const transcript = [
  { role: "user" as const, text: "I'm selling: iPhone 13", at, photoIds: ["secret-photo-id"] },
  { role: "model" as const, text: "What did you pay?", at },
  { role: "user" as const, text: "About $700", at },
];
const intake = { item: "iPhone 13" };
const FACTS = { searchQuery: "iPhone 13", model: "iPhone 13", condition: "good", included: [], defects: [] };
const A = "free-a/model-a:free";
const B = "free-b/model-b:free";

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const status = (code: number) => new Response(JSON.stringify({ error: { message: "x" } }), { status: code });
const inBodyError = (code: number) => new Response(JSON.stringify({ error: { code, message: "upstream" } }), { status: 200 });

function stub(...answers: Array<Response | Error>) {
  const queue = [...answers];
  return vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch called more times than expected");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const bodyOf = (fetchImpl: ReturnType<typeof stub>, call = 0) =>
  JSON.parse((fetchImpl.mock.calls[call] as [string, RequestInit])[1].body as string);
const modelsAsked = (fetchImpl: ReturnType<typeof stub>) => fetchImpl.mock.calls.map((_, i) => bodyOf(fetchImpl, i).model);

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = KEY;
  process.env.OPENROUTER_MODELS = `${A},${B}`;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODELS;
});

describe("what counts as free", () => {
  it("accepts a :free model and OpenRouter's own router over the free ones", () => {
    expect(isFreeModel("nvidia/nemotron-3-super-120b-a12b:free")).toBe(true);
    expect(isFreeModel("google/gemma-4-31b-it:free")).toBe(true);
    expect(isFreeModel("openrouter/free")).toBe(true);
  });

  it("rejects anything that is billed per token, however it is spelled", () => {
    for (const paid of [
      "openai/gpt-4o",
      "anthropic/claude-sonnet",
      "openrouter/auto", // chooses among paid models too
      "openrouter/free-ish",
      "google/gemma-4-31b-it", // the paid variant of a model that also has a :free one
      "vendor/model:free-trial",
      "vendor/model:FREE", // the suffix is lowercase; do not guess at others
      "vendor/model:free:nitro", // a routing suffix after :free is a different, paid, route
      "",
    ]) {
      expect(isFreeModel(paid), paid).toBe(false);
    }
  });
});

describe("the guard that keeps it free", () => {
  it("drops a paid model from the list, with a warning, and keeps the free ones in order", () => {
    expect(allowedModels(["openai/gpt-4o", A, "anthropic/claude-sonnet", B])).toEqual([A, B]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("openai/gpt-4o"));
  });

  it("never sends a request naming a paid model, even one that was configured", async () => {
    process.env.OPENROUTER_MODELS = `openai/gpt-4o,${A}`;
    const fetchImpl = stub(completion(JSON.stringify(FACTS)));
    await openrouter.extractFacts(transcript, intake, fetchImpl);
    expect(modelsAsked(fetchImpl)).toEqual([A]);
  });

  it("is not configured, and makes no call, when every configured model is paid", async () => {
    process.env.OPENROUTER_MODELS = "openai/gpt-4o,anthropic/claude-sonnet";
    expect(openrouter.isConfigured()).toBe(false);

    const fetchImpl = stub(completion("{}"));
    await expect(openrouter.extractFacts(transcript, intake, fetchImpl)).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(openrouter.readListings({ searchQuery: "x", model: "x", variant: null, ageMonths: null, condition: "good", included: [], defects: [], purchasePrice: null }, [{ url: "https://a.example", title: "t", text: "$5" }], fetchImpl)).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not let a request through for a paid model on any call, streamed or not", async () => {
    process.env.OPENROUTER_MODELS = "openai/gpt-4o";
    const fetchImpl = stub(new Response("data: [DONE]\n\n"));
    await expect(
      (async () => {
        for await (const chunk of openrouter.streamReply(transcript, "probe", { intake, photoCount: 0 }, fetchImpl)) void chunk;
      })(),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("configuration", () => {
  it("is configured with a key and at least one free model", () => {
    expect(openrouter.isConfigured()).toBe(true);
    delete process.env.OPENROUTER_API_KEY;
    expect(openrouter.isConfigured()).toBe(false);
    process.env.OPENROUTER_API_KEY = "  ";
    expect(openrouter.isConfigured()).toBe(false);
  });

  it("has a default list of free models, and an empty setting means none", () => {
    delete process.env.OPENROUTER_MODELS;
    expect(env.openrouterModels.length).toBeGreaterThan(1);
    expect(env.openrouterModels.every(isFreeModel)).toBe(true);

    process.env.OPENROUTER_MODELS = "";
    expect(env.openrouterModels).toEqual([]);
    expect(openrouter.isConfigured()).toBe(false);
  });

  it("trims names and drops blanks and repeats", () => {
    process.env.OPENROUTER_MODELS = ` ${A} , ,${A},${B} `;
    expect(env.openrouterModels).toEqual([A, B]);
  });
});

describe("the request", () => {
  it("posts to OpenRouter with a bearer key, JSON mode, and the first free model", async () => {
    const fetchImpl = stub(completion(JSON.stringify(FACTS)));
    await openrouter.extractFacts(transcript, intake, fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(bodyOf(fetchImpl)).toMatchObject({
      model: A,
      stream: false,
      temperature: 0,
      response_format: { type: "json_object" },
    });
    // DeepSeek's switch for its own thinking mode is not OpenRouter's.
    expect(bodyOf(fetchImpl)).not.toHaveProperty("thinking");
  });

  it("sends text only: no photo, and no mention of one that could be resolved", async () => {
    const fetchImpl = stub(completion(JSON.stringify(FACTS)));
    await openrouter.extractFacts(transcript, intake, fetchImpl);
    const sent = JSON.stringify(bodyOf(fetchImpl));
    expect(sent).not.toContain("secret-photo-id");
    expect(sent).not.toMatch(/image_url|image\/|base64/);
    expect(bodyOf(fetchImpl).messages[0].content).toMatch(/cannot see their photos/);
  });

  it("is never shown what they paid when reading the listings", async () => {
    const fetchImpl = stub(completion(JSON.stringify({ listings: [], position: "typical", positionEvidence: "" })));
    await openrouter.readListings(
      { searchQuery: "iPhone 13", model: "iPhone 13", variant: "paid $849", ageMonths: 1, condition: "good", included: [], defects: [], purchasePrice: 849 },
      [{ url: "https://a.example", title: "t", text: "$5" }],
      fetchImpl,
    );
    expect(JSON.stringify(bodyOf(fetchImpl))).not.toContain("849");
  });

  it("accepts an answer the model wrapped in a code fence or a sentence", async () => {
    const wrapped = ["```json\n" + JSON.stringify(FACTS) + "\n```", `Sure! Here you go: ${JSON.stringify(FACTS)} Hope that helps.`];
    for (const content of wrapped) {
      const facts = await openrouter.extractFacts(transcript, intake, stub(completion(content)));
      expect(facts.model).toBe("iPhone 13");
    }
  });
});

describe("down the list of free models", () => {
  it.each([
    ["rate limited (429)", () => status(429)],
    ["overloaded (503)", () => status(503)],
    ["a bad gateway (502)", () => status(502)],
    ["removed (404)", () => status(404)],
    ["an upstream error reported inside a 200", () => inBodyError(429)],
  ])("moves on to the next model when one is %s", async (_label, refusal) => {
    const fetchImpl = stub(refusal(), completion(JSON.stringify(FACTS)));
    const facts = await openrouter.extractFacts(transcript, intake, fetchImpl);
    expect(facts.model).toBe("iPhone 13");
    expect(modelsAsked(fetchImpl)).toEqual([A, B]);
  });

  it("does not move on for something that is not about the model", async () => {
    for (const refusal of [status(401), status(402), status(400), status(500)]) {
      const fetchImpl = stub(refusal, completion(JSON.stringify(FACTS)));
      await expect(openrouter.extractFacts(transcript, intake, fetchImpl)).rejects.toBeInstanceOf(Error);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("maps the statuses to the right errors", async () => {
    const ask = (answer: Response) => openrouter.extractFacts(transcript, intake, stub(answer, answer));
    await expect(ask(status(401))).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(ask(status(402))).rejects.toBeInstanceOf(BackendQuotaError);
    await expect(ask(status(429))).rejects.toBeInstanceOf(BackendRateLimitError);
    await expect(ask(status(404))).rejects.toBeInstanceOf(BackendNotFoundError);
    await expect(ask(status(500))).rejects.toBeInstanceOf(BackendFailedError);
  });

  // The shapes below are what OpenRouter really answered during the first live run.
  const upstream404 = new Response(
    JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 404,
        metadata: {
          raw: JSON.stringify({ status: 404, title: "Not Found", detail: "Function 'ac74040f': Not found for account 'abc'" }),
          provider_name: "Nvidia",
        },
      },
    }),
    { status: 404 },
  );
  const upstream429 = () =>
    new Response(
      JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 429,
          metadata: {
            raw: "google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly.",
            provider_name: "Google AI Studio",
            limit_source: "upstream_provider_shared_pool",
          },
        },
      }),
      { status: 429 },
    );

  it("says what the provider said about a 404, rather than guessing at the account's settings", async () => {
    const error = (await openrouter.extractFacts(transcript, intake, stub(upstream404.clone(), upstream404.clone())).catch((e: Error) => e)) as Error;
    expect(error).toBeInstanceOf(BackendNotFoundError);
    expect(error.message).toContain("Nvidia: Function 'ac74040f': Not found for account");
    expect(error.message).not.toMatch(/privacy settings/); // that was not the cause, and would send someone to the wrong place
  });

  it("points at the privacy settings only when the provider's own message is about a data policy", async () => {
    const policy = () =>
      new Response(JSON.stringify({ error: { message: "No endpoints found matching your data policy (Free model training)", code: 404 } }), { status: 404 });
    const error = (await openrouter.extractFacts(transcript, intake, stub(policy(), policy())).catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(/matching your data policy/);
    expect(error.message).toMatch(/openrouter\.ai\/settings\/privacy/);
  });

  it("names the upstream provider behind a rate limit", async () => {
    const error = (await openrouter.extractFacts(transcript, intake, stub(upstream429(), upstream429())).catch((e: Error) => e)) as Error;
    expect(error).toBeInstanceOf(BackendRateLimitError);
    expect(error.message).toMatch(/Google AI Studio: .*temporarily rate-limited upstream/);
  });

  it("says why a model that must reason refused to have reasoning switched off", async () => {
    const mandatory = new Response(JSON.stringify({ error: { message: "Reasoning is mandatory for this endpoint and cannot be disabled.", code: 400 } }), { status: 400 });
    const error = (await openrouter.extractFacts(transcript, intake, stub(mandatory)).catch((e: Error) => e)) as Error;
    expect(error).toBeInstanceOf(BackendFailedError);
    expect(error.message).toMatch(/Reasoning is mandatory/);
  });

  it("reports a rate limit over an overload when every model refused, naming neither as the only cause", async () => {
    const error = await openrouter.extractFacts(transcript, intake, stub(status(503), status(429))).catch((e) => e);
    expect(error).toBeInstanceOf(BackendRateLimitError);
  });

  it("asks a model that just refused last on the next call", async () => {
    await openrouter.extractFacts(transcript, intake, stub(status(429), completion(JSON.stringify(FACTS))));

    const fetchImpl = stub(completion(JSON.stringify(FACTS)));
    await openrouter.extractFacts(transcript, intake, fetchImpl);
    expect(modelsAsked(fetchImpl)).toEqual([B]); // straight to the one that worked
  });

  it("makes exactly one request per model, never retrying the same one", async () => {
    const fetchImpl = stub(status(429), status(429), completion("{}"));
    await expect(openrouter.extractFacts(transcript, intake, fetchImpl)).rejects.toBeInstanceOf(BackendRateLimitError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // A and B, once each
  });

  it("never lets the key into an error message", async () => {
    for (const code of [401, 402, 429, 404, 500]) {
      const error = await openrouter.extractFacts(transcript, intake, stub(status(code), status(code))).catch((e: Error) => e);
      expect((error as Error).message).not.toContain(KEY);
    }
  });
});

describe("a streamed reply", () => {
  const sse = (...pieces: string[]) =>
    new Response(pieces.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
  const collect = async (fetchImpl: typeof fetch) => {
    let text = "";
    for await (const chunk of openrouter.streamReply(transcript, "probe", { intake, photoCount: 1 }, fetchImpl)) text += chunk;
    return text;
  };

  it("streams from the first free model, in text only, with the no-photos instruction", async () => {
    const fetchImpl = stub(sse("Hello", " there"));
    expect(await collect(fetchImpl)).toBe("Hello there");
    expect(bodyOf(fetchImpl)).toMatchObject({ model: A, stream: true });
    expect(bodyOf(fetchImpl).messages[0].content).toMatch(/text-only model and cannot see them/);
  });

  it("moves to the next free model when the first refuses before saying anything", async () => {
    const fetchImpl = stub(status(429), sse("ok"));
    expect(await collect(fetchImpl)).toBe("ok");
    expect(modelsAsked(fetchImpl)).toEqual([A, B]);
  });

  it("moves on when a model sends an error event before any words, and treats an empty reply as a failure", async () => {
    const errorEvent = new Response(`data: ${JSON.stringify({ error: { code: 429, message: "x" } })}\n\n`, { status: 200 });
    expect(await collect(stub(errorEvent, sse("ok")))).toBe("ok");
    expect(await collect(stub(new Response("data: [DONE]\n\n", { status: 200 }), sse("ok")))).toBe("ok");
  });

  it("does not switch models once a reply has started", async () => {
    const dropped = new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "half" } }] })}\n\ndata: ${JSON.stringify({ error: { code: 502, message: "x" } })}\n\n`,
      { status: 200 },
    );
    const fetchImpl = stub(dropped, sse("never"));
    let seen = "";
    await expect(
      (async () => {
        for await (const chunk of openrouter.streamReply(transcript, "probe", { intake, photoCount: 0 }, fetchImpl)) seen += chunk;
      })(),
    ).rejects.toBeInstanceOf(BackendFailedError);
    expect(seen).toBe("half");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("reasoning", () => {
  it("is switched off on every request, since it only spends the token budget before a word is written", async () => {
    const fetchImpl = stub(completion(JSON.stringify(FACTS)));
    await openrouter.extractFacts(transcript, intake, fetchImpl);
    expect(bodyOf(fetchImpl).reasoning).toEqual({ effort: "none" });
  });

  it("is also off for a streamed reply", async () => {
    const fetchImpl = stub(new Response("data: [DONE]\n\n"));
    await openrouter.streamReply(transcript, "probe", { intake, photoCount: 0 }, fetchImpl).next().catch(() => {});
    expect(bodyOf(fetchImpl).reasoning).toEqual({ effort: "none" });
  });

  it("is never shown to the person if a model streams it anyway", async () => {
    const reasoningThenAnswer = new Response(
      [
        { choices: [{ delta: { content: "", reasoning: "The user wants a greeting." } }] },
        { choices: [{ delta: { content: "", reasoning_details: [{ type: "reasoning.text", text: "more thinking" }] } }] },
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " there" } }] },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200 },
    );
    let text = "";
    for await (const chunk of openrouter.streamReply(transcript, "probe", { intake, photoCount: 0 }, stub(reasoningThenAnswer))) text += chunk;
    expect(text).toBe("Hello there");
  });

  it("treats a stream that was all reasoning and no answer as a failure, and moves to the next model", async () => {
    const onlyReasoning = new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "", reasoning: "thinking…" } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
    const answer = new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
    const fetchImpl = stub(onlyReasoning, answer);
    let text = "";
    for await (const chunk of openrouter.streamReply(transcript, "probe", { intake, photoCount: 0 }, fetchImpl)) text += chunk;
    expect(text).toBe("ok");
    expect(modelsAsked(fetchImpl)).toEqual([A, B]);
  });
});

describe("a deadline that passes while the body is still arriving", () => {
  it("is a timeout, not a response that could not be read", async () => {
    const slow = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }));
        },
      }),
      { status: 200 },
    );
    await expect(openrouter.extractFacts(transcript, intake, stub(slow))).rejects.toThrow(/timed out/);
  });
});

describe("the default models", () => {
  it("are named free models, with no router, from more than one provider", () => {
    delete process.env.OPENROUTER_MODELS;
    const models = env.openrouterModels;
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.every(isFreeModel)).toBe(true);
    expect(models).not.toContain("openrouter/free"); // it once routed to a safety classifier
    expect(new Set(models.map((m) => m.split("/")[0])).size).toBe(models.length); // one per vendor
  });

  it("still allow the router when someone asks for it", () => {
    expect(allowedModels(["openrouter/free"])).toEqual(["openrouter/free"]);
  });
});

describe("detailFromBody", () => {
  it("pulls the upstream provider and its complaint out of OpenRouter's wrapper", () => {
    expect(
      detailFromBody({ error: { message: "Provider returned error", metadata: { raw: '{"detail":"Function x: Not found"}', provider_name: "Nvidia" } } }),
    ).toBe("Nvidia: Function x: Not found");
    expect(detailFromBody({ error: { message: "Provider returned error", metadata: { raw: "rate-limited upstream", provider_name: "Google AI Studio" } } })).toBe(
      "Google AI Studio: rate-limited upstream",
    );
  });

  it("uses the provider's own message when there is one, and says nothing for a bare wrapper", () => {
    expect(detailFromBody({ error: { message: "Reasoning is mandatory for this endpoint" } })).toBe("Reasoning is mandatory for this endpoint");
    expect(detailFromBody({ error: { message: "Provider returned error" } })).toBe("");
  });

  it("copes with anything that is not an error body", () => {
    for (const odd of [null, undefined, "text", 3, [], {}, { error: null }, { error: "string" }]) expect(detailFromBody(odd)).toBe("");
  });

  it("drops a link, which would only be cut off at the length limit", () => {
    expect(
      detailFromBody({ error: { message: "Provider returned error", metadata: { raw: "busy. Please retry, or add your own key: https://openrouter.ai/settings/integrations", provider_name: "Phala" } } }),
    ).toBe("Phala: busy. Please retry, or add your own key:");
  });

  it("keeps it to one bounded line", () => {
    const detail = detailFromBody({ error: { message: `line one\nline two\t${"x".repeat(500)}` } });
    expect(detail).not.toMatch(/[\n\t]/);
    expect(detail.length).toBeLessThanOrEqual(180);
  });
});
