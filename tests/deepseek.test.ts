import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeepSeekFailedError,
  DeepSeekQuotaError,
  DeepSeekRateLimitError,
  DeepSeekUnavailableError,
  extractFacts,
  isConfigured,
  readListings,
  streamReply,
} from "@/lib/deepseek";
import { MalformedAppraisalError } from "@/lib/prompts";

const KEY = "sk-test-deepseek-key-0123456789";
const at = new Date().toISOString();

const completion = (content: string | null) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const status = (code: number) => new Response(JSON.stringify({ error: { message: "x" } }), { status: code });

/** A server-sent-events body, delivered in `chunkSize`-character pieces so lines straddle chunks. */
function sse(lines: string[], chunkSize = 1000) {
  const text = lines.join("\n") + "\n";
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < text.length; i += chunkSize) controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

const delta = (content: string, extra: object = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content, ...extra } }] })}`;

function stub(...answers: Array<Response | Error>) {
  const queue = [...answers];
  return vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch called more times than expected");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const bodyOf = (fetchImpl: ReturnType<typeof stub>) =>
  JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);

const transcript = [
  { role: "user" as const, text: "I'm selling: iPhone 13", at, photoIds: ["secret-photo-id"] },
  { role: "model" as const, text: "What did you pay?", at },
  { role: "user" as const, text: "About $700 in 2022", at },
];
const intake = { item: "iPhone 13" };

const FACTS = { searchQuery: "iPhone 13", model: "iPhone 13", condition: "good", included: [], defects: [] };

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = KEY;
});
afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_MODEL;
});

describe("configuration", () => {
  it("is configured only when there is a key", () => {
    expect(isConfigured()).toBe(true);
    delete process.env.DEEPSEEK_API_KEY;
    expect(isConfigured()).toBe(false);
    process.env.DEEPSEEK_API_KEY = "   ";
    expect(isConfigured()).toBe(false);
  });
});

describe("extractFacts", () => {
  it("posts a JSON-mode request with thinking off, to the documented endpoint", async () => {
    const fetchImpl = stub(completion(JSON.stringify(FACTS)));
    await extractFacts(transcript, intake, fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);

    const body = bodyOf(fetchImpl);
    expect(body).toMatchObject({
      model: "deepseek-flash",
      stream: false,
      temperature: 0,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
    });
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("writes the schema and an example into the prompt, since the API cannot enforce a schema", async () => {
    const fetchImpl = stub(completion(JSON.stringify(FACTS)));
    await extractFacts(transcript, intake, fetchImpl);
    const system = bodyOf(fetchImpl).messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toMatch(/json/i);
    expect(system.content).toContain('"searchQuery"');
    expect(system.content).toContain("example");
  });

  it("sends the conversation as text, ending on the request, and never a photo", async () => {
    const fetchImpl = stub(completion(JSON.stringify(FACTS)));
    await extractFacts(transcript, intake, fetchImpl);

    const { messages } = bodyOf(fetchImpl);
    expect(messages.slice(1).map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(messages.at(-1).content).toMatch(/Extract the facts/);
    // The photo id is a pointer to something never sent; none of it may appear.
    const sent = JSON.stringify(bodyOf(fetchImpl));
    expect(sent).not.toContain("secret-photo-id");
    expect(sent).not.toMatch(/image_url|image\/|base64/);
  });

  it("tells the model it cannot see the photos", async () => {
    const fetchImpl = stub(completion(JSON.stringify(FACTS)));
    await extractFacts(transcript, intake, fetchImpl);
    expect(bodyOf(fetchImpl).messages[0].content).toMatch(/cannot see their photos/);
  });

  it("returns the facts, parsed by the same schema as Gemini's", async () => {
    const facts = await extractFacts(transcript, intake, stub(completion(JSON.stringify({ ...FACTS, purchasePrice: 700 }))));
    expect(facts).toMatchObject({ model: "iPhone 13", purchasePrice: 700, variant: null, included: [] });
  });

  it("explains an answer that is not JSON or does not fit", async () => {
    await expect(extractFacts(transcript, intake, stub(completion("sorry, no")))).rejects.toThrow(/not valid JSON/);
    await expect(extractFacts(transcript, intake, stub(completion(JSON.stringify({ model: 3 }))))).rejects.toBeInstanceOf(
      MalformedAppraisalError,
    );
    await expect(extractFacts(transcript, intake, stub(completion(null)))).rejects.toThrow(/empty/);
  });

  it("uses the model named in the environment", async () => {
    process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";
    const fetchImpl = stub(completion(JSON.stringify(FACTS)));
    await extractFacts(transcript, intake, fetchImpl);
    expect(bodyOf(fetchImpl).model).toBe("deepseek-v4-pro");
  });
});

describe("readListings", () => {
  const facts = {
    searchQuery: "iPhone 13 128GB",
    model: "iPhone 13",
    variant: "128GB, paid $849",
    ageMonths: 20,
    condition: "good" as const,
    category: "other" as const, included: [],
    defects: [],
    purchasePrice: 849,
  };
  const sources = [{ url: "https://www.ebay.com/itm/1", title: "t", text: "Sold for US $312.00" }];
  const reading = {
    listings: [{ title: "t", priceText: "US $312.00", kind: "sold", condition: "good", platform: "eBay", sourceIndex: 0 }],
    newPrice: { priceText: "$699.00", sourceIndex: 0 },
    position: "below",
    positionEvidence: "scratches",
  };

  it("gives the model the numbered sources and a schema that only allows real ones", async () => {
    const fetchImpl = stub(completion(JSON.stringify(reading)));
    await readListings(facts, sources, fetchImpl);

    const body = bodyOf(fetchImpl);
    expect(body.messages.at(-1).content).toContain("[0] t\nhttps://www.ebay.com/itm/1\nSold for US $312.00");
    expect(body.messages[0].content).toContain('"enum":[0]');
    expect(body.messages[0].content).toMatch(/untrusted/);
  });

  it("is never shown what they paid", async () => {
    const fetchImpl = stub(completion(JSON.stringify(reading)));
    await readListings(facts, sources, fetchImpl);
    expect(JSON.stringify(bodyOf(fetchImpl))).not.toContain("849");
  });

  it("returns what it read, and makes no call for no sources", async () => {
    const out = await readListings(facts, sources, stub(completion(JSON.stringify(reading))));
    expect(out).toMatchObject({ newPrice: { priceText: "$699.00", sourceIndex: 0 }, position: "below" });
    expect(out.listings).toHaveLength(1);

    const fetchImpl = stub();
    expect((await readListings(facts, [], fetchImpl)).listings).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an answer that does not fit the schema", async () => {
    await expect(
      readListings(facts, sources, stub(completion(JSON.stringify({ listings: "none", position: "typical", positionEvidence: "" })))),
    ).rejects.toBeInstanceOf(MalformedAppraisalError);
  });
});

describe("streamReply", () => {
  const context = { intake, photoCount: 2 };
  const collect = async (fetchImpl: typeof fetch) => {
    let text = "";
    for await (const chunk of streamReply(transcript, "probe", context, fetchImpl)) text += chunk;
    return text;
  };

  it("asks for a stream with thinking off and never sends a photo", async () => {
    const fetchImpl = stub(sse([delta("hi"), "data: [DONE]"]));
    await collect(fetchImpl);
    const body = bodyOf(fetchImpl);
    expect(body).toMatchObject({ stream: true, thinking: { type: "disabled" } });
    expect(body).not.toHaveProperty("response_format");
    expect(JSON.stringify(body)).not.toContain("secret-photo-id");
  });

  it("tells the model plainly that it cannot see the photos, in the system instruction", async () => {
    const fetchImpl = stub(sse([delta("hi"), "data: [DONE]"]));
    await collect(fetchImpl);
    const system = bodyOf(fetchImpl).messages[0].content as string;
    expect(system).toMatch(/text-only model and cannot see them/);
    expect(system).toMatch(/Never describe them/);
    expect(system).toContain("Current phase: probe");
  });

  it("yields the answer text only: not reasoning, not keep-alives, stopping at [DONE]", async () => {
    const text = await collect(
      stub(
        sse([
          ": keep-alive",
          delta("", { reasoning_content: "thinking…" }),
          delta("Hello"),
          "",
          delta(" there", { reasoning_content: "more thinking" }),
          "data: [DONE]",
          delta("never seen"),
        ]),
      ),
    );
    expect(text).toBe("Hello there");
  });

  it("reassembles lines that arrive split across chunks, at every chunk size", async () => {
    for (const size of [1, 2, 5, 13, 1000]) {
      const text = await collect(stub(sse([delta("Hello"), delta(", world"), "data: [DONE]"], size)));
      expect(text).toBe("Hello, world");
    }
  });

  it("keeps stage markers in the text for the caller to strip, as Gemini's do", async () => {
    expect(await collect(stub(sse([delta("Ready.\n[[STAGE:appraise]]"), "data: [DONE]"])))).toBe("Ready.\n[[STAGE:appraise]]");
  });

  it("ignores a line it cannot parse rather than failing the reply", async () => {
    expect(await collect(stub(sse(["data: {not json", delta("ok"), "data: [DONE]"])))).toBe("ok");
  });

  it("reports a stream that breaks", async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(delta("part") + "\n"));
          controller.error(new Error("socket hang up"));
        },
      }),
      { status: 200 },
    );
    await expect(collect(stub(broken))).rejects.toBeInstanceOf(DeepSeekFailedError);
  });
});

describe("failures", () => {
  const ask = (fetchImpl: typeof fetch) => extractFacts(transcript, intake, fetchImpl);

  it.each([
    [401, DeepSeekUnavailableError],
    [402, DeepSeekQuotaError],
    [429, DeepSeekRateLimitError],
    [400, DeepSeekFailedError],
    [422, DeepSeekFailedError],
    [500, DeepSeekFailedError],
    [503, DeepSeekFailedError],
  ])("maps a %i to the right error", async (code, expected) => {
    await expect(ask(stub(status(code)))).rejects.toBeInstanceOf(expected);
  });

  it("makes one request and no more, whatever goes wrong", async () => {
    for (const answer of [status(402), status(429), status(503), new TypeError("fetch failed")]) {
      const fetchImpl = stub(answer, completion(JSON.stringify(FACTS)));
      await expect(ask(fetchImpl)).rejects.toBeInstanceOf(Error);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("gives every call a deadline, and calls a timeout a timeout", async () => {
    const fetchImpl = stub(completion(JSON.stringify(FACTS)));
    await ask(fetchImpl);
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);

    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    await expect(ask(stub(timeout))).rejects.toThrow(/timed out/);
  });

  it("does not call out at all with no key", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const fetchImpl = stub(completion("{}"));
    await expect(ask(fetchImpl)).rejects.toThrow(/DEEPSEEK_API_KEY is not set/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never lets the key into an error message", async () => {
    for (const code of [401, 402, 429, 500]) {
      const error = await ask(stub(status(code))).catch((e: Error) => e);
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it("rejects a response it cannot read", async () => {
    await expect(ask(stub(new Response("nope", { status: 200 })))).rejects.toBeInstanceOf(DeepSeekFailedError);
    await expect(ask(stub(new Response(JSON.stringify({ choices: [] }), { status: 200 })))).rejects.toBeInstanceOf(
      DeepSeekFailedError,
    );
  });
});
