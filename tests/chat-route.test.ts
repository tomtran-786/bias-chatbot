/**
 * Exercises both API routes with only the Gemini calls replaced.
 *
 * What is worth proving here is the gating. The whole design rests on the claim
 * that the assistant cannot grade before it has asked and cannot recommend
 * before it has graded, and that claim lives in these two routes: everything
 * else — the scorecard, the headline, the recommendation's reasoning — is
 * downstream of it being true.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const streamReply = vi.hoisted(() => vi.fn());
const gradeDecision = vi.hoisted(() => vi.fn());

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return { ...actual, streamReply, gradeDecision };
});

const { POST: chat } = await import("@/app/api/chat/route");
const { POST: gradeRoute } = await import("@/app/api/grade/route");
const { RateLimitError } = await import("@/lib/gemini");
const { RUBRIC } = await import("@/lib/protocol");
const { DIMENSION_COUNT } = await import("@/lib/rubric");

/** Yields `chunks` as though they arrived from the model. */
function modelSays(...chunks: string[]) {
  streamReply.mockImplementation(async function* () {
    for (const chunk of chunks) yield chunk;
  });
}

const frame = {
  decision: "Whether to keep going with the side project",
  options: ["Keep going for another quarter", "Stop now"],
  deadline: "End of the month",
  stakes: "Six months of evenings; I could pick it up again later",
};

const commitment = { option: "Keep going for another quarter", selfScore: 4 };

/** A transcript in which the assistant has asked `turns` questions. */
function conversation(turns: number) {
  const at = new Date().toISOString();
  return Array.from({ length: turns }, (_, index) => [
    { role: "user" as const, text: `answer ${index}`, at },
    { role: "model" as const, text: `question ${index}`, at },
  ])
    .flat()
    // The assistant speaks first, so drop the leading user turn to keep the
    // model-turn count equal to the number of questions asked.
    .slice(1);
}

/** Every dimension scored, which is what a healthy grade looks like. */
function fullScores(score = 3) {
  return RUBRIC.map((dimension) => ({
    id: dimension.id,
    score,
    why: "because",
    quote: "their words",
  }));
}

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

async function postGrade(body: unknown) {
  const response = await gradeRoute(
    new Request("http://localhost/api/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, json: await response.json() };
}

beforeEach(() => {
  streamReply.mockReset();
  gradeDecision.mockReset();
});

describe("chat route", () => {
  it("streams a reply and keeps markers out of the text", async () => {
    modelSays("What are you weighing", " first?", "[[STAGE:commit]]");

    const { events } = await postChat({
      phase: "probe",
      frame,
      transcript: conversation(1),
      message: "I'm not sure yet",
    });

    const text = events
      .filter((event) => event.t === "text")
      .map((event) => event.v)
      .join("");
    expect(text).toBe("What are you weighing first?");
    expect(text).not.toContain("[[STAGE:");
    expect(events).toContainEqual({ t: "stage", v: "commit" });
  });

  it("passes the frame and the locked-in pick to the model", async () => {
    modelSays("Noted.");

    await postChat({
      phase: "probe",
      frame,
      commitment,
      transcript: conversation(2),
      message: "still thinking",
    });

    const [, , context] = streamReply.mock.calls[0];
    expect(context.frame.options).toEqual(frame.options);
    expect(context.commitment).toEqual(commitment);
  });

  it("refuses to recommend before a grade exists", async () => {
    const { status, json } = await postChat({
      phase: "recommend",
      frame,
      commitment,
      transcript: conversation(DIMENSION_COUNT),
      message: "what do you think?",
    });

    expect(status).toBe(409);
    expect(json.error).toBe("out_of_order");
    expect(streamReply).not.toHaveBeenCalled();
  });

  it("reports a quota failure rather than failing silently", async () => {
    streamReply.mockImplementation(async function* () {
      yield "I was saying";
      throw new RateLimitError();
    });

    const { events } = await postChat({
      phase: "probe",
      frame,
      transcript: conversation(1),
      message: "go on",
    });

    expect(events).toContainEqual({ t: "error", code: "rate_limited" });
    // Whatever was generated before the failure still reaches the person.
    expect(events.some((e) => e.t === "text" && e.v.includes("I was saying"))).toBe(
      true,
    );
  });

  it("rejects a malformed body", async () => {
    const { status } = await postChat({ phase: "probe", message: "hi" });
    expect(status).toBe(400);
  });
});

describe("grade route", () => {
  it("grades once the questions have been asked and a pick is locked in", async () => {
    gradeDecision.mockResolvedValue(fullScores(4));

    const { status, json } = await postGrade({
      frame,
      commitment,
      transcript: conversation(DIMENSION_COUNT),
    });

    expect(status).toBe(200);
    expect(json.dimensions).toHaveLength(DIMENSION_COUNT);
    // The label comes from the rubric, not from the model.
    expect(json.dimensions[0].label).toBe(RUBRIC[0].label);
    // The headline is derived here; the model never states one.
    expect(json.headline.mean).toBe(4);
  });

  it("refuses to grade before every dimension has been asked about", async () => {
    const { status, json } = await postGrade({
      frame,
      commitment,
      transcript: conversation(DIMENSION_COUNT - 1),
    });

    expect(status).toBe(409);
    expect(json.error).toBe("out_of_order");
    expect(gradeDecision).not.toHaveBeenCalled();
  });

  it("refuses to grade with no commitment recorded", async () => {
    const { status } = await postGrade({
      frame,
      transcript: conversation(DIMENSION_COUNT),
    });

    expect(status).toBe(400);
    expect(gradeDecision).not.toHaveBeenCalled();
  });

  it("rejects a scorecard that is missing a dimension", async () => {
    gradeDecision.mockResolvedValue(fullScores().slice(1));

    const { status, json } = await postGrade({
      frame,
      commitment,
      transcript: conversation(DIMENSION_COUNT),
    });

    expect(status).toBe(502);
    expect(json.reason).toContain(RUBRIC[0].id);
  });

  it("rejects a score outside the scale rather than rendering it", async () => {
    gradeDecision.mockResolvedValue(
      fullScores().map((score, index) =>
        index === 0 ? { ...score, score: 7 } : score,
      ),
    );

    const { status, json } = await postGrade({
      frame,
      commitment,
      transcript: conversation(DIMENSION_COUNT),
    });

    expect(status).toBe(502);
    expect(json.reason).toContain("7");
  });
});
