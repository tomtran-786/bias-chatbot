import { describe, expect, it } from "vitest";
import { systemInstruction } from "@/lib/prompts";
import {
  FACT_COUNT,
  STAGES,
  STAGE_INSTRUCTIONS,
  STAGE_LABELS,
  canEnter,
  opensLikePrompt,
  opensLikeVerdict,
  type PhaseContext,
} from "@/lib/stages";

const ready: PhaseContext = {
  assistantTurns: FACT_COUNT,
  photoCount: 1,
  hasAskingPrice: true,
  hasAppraisal: true,
};

const reason = (result: ReturnType<typeof canEnter>) =>
  result.ok ? null : result.reason;

describe("canEnter", () => {
  it("always lets the model start asking, and always allows the end state", () => {
    const empty: PhaseContext = {
      assistantTurns: 0,
      photoCount: 0,
      hasAskingPrice: false,
      hasAppraisal: false,
    };
    expect(canEnter("intake", empty).ok).toBe(true);
    expect(canEnter("probe", empty).ok).toBe(true);
    expect(canEnter("complete", empty).ok).toBe(true);
  });

  describe("commit", () => {
    it("needs every fact asked about", () => {
      expect(canEnter("commit", { ...ready, assistantTurns: FACT_COUNT - 1 }).ok).toBe(false);
      expect(canEnter("commit", { ...ready, assistantTurns: FACT_COUNT }).ok).toBe(true);
    });

    it("needs at least one photo", () => {
      const result = canEnter("commit", { ...ready, photoCount: 0 });
      expect(result.ok).toBe(false);
      expect(reason(result)).toMatch(/photo/);
    });

    it("does not need a price yet: this is the step that asks for it", () => {
      expect(canEnter("commit", { ...ready, hasAskingPrice: false, hasAppraisal: false }).ok).toBe(true);
    });
  });

  describe("appraise", () => {
    it("re-checks the questions, the photo and the locked price", () => {
      expect(canEnter("appraise", ready).ok).toBe(true);
      expect(canEnter("appraise", { ...ready, assistantTurns: FACT_COUNT - 1 }).ok).toBe(false);
      expect(canEnter("appraise", { ...ready, photoCount: 0 }).ok).toBe(false);

      const unlocked = canEnter("appraise", { ...ready, hasAskingPrice: false });
      expect(unlocked.ok).toBe(false);
      expect(reason(unlocked)).toMatch(/locked in their own price/);
    });
  });

  describe("verdict", () => {
    it("needs an appraisal", () => {
      expect(canEnter("verdict", ready).ok).toBe(true);
      const result = canEnter("verdict", { ...ready, hasAppraisal: false });
      expect(result.ok).toBe(false);
      expect(reason(result)).toMatch(/market/);
    });
  });
});

describe("stage tables", () => {
  it("label and instruct every stage, so a new stage cannot be forgotten", () => {
    for (const stage of STAGES) {
      expect(STAGE_LABELS[stage]).toBeTruthy();
      expect(STAGE_INSTRUCTIONS[stage]).toBeTruthy();
    }
  });

  it("keeps price talk out of every phase before the verdict", () => {
    // The instruments depend on the assistant saying no number before the
    // price is locked. The instructions are where that is enforced in words.
    expect(STAGE_INSTRUCTIONS.intake).toMatch(/Do not mention any price/);
    expect(STAGE_INSTRUCTIONS.probe).toMatch(/Do not state any price/);
    expect(STAGE_INSTRUCTIONS.commit).toMatch(/do not mention any other price/);
  });
});

describe("opensLikeVerdict", () => {
  it.each([
    "## Suggested price\n$10.",
    "Suggested price: $10",
    "**Suggested price**\n$10",
    "  \n### suggested price\n$10",
    "# SUGGESTED PRICE",
  ])("recognises the verdict's opening heading: %j", (text) => {
    expect(opensLikeVerdict(text)).toBe(true);
  });

  it.each([
    "What did you pay for it?",
    "Before I can give you a suggested price I need the condition.",
    "Thanks. What is the battery health?",
    "",
  ])("lets an ordinary reply through: %j", (text) => {
    expect(opensLikeVerdict(text)).toBe(false);
  });

  it("is told to the model in words too: a typed price is not weighed up", () => {
    expect(STAGE_INSTRUCTIONS.probe).toMatch(/type a price/);
    expect(STAGE_INSTRUCTIONS.probe).toMatch(/Suggested price, Why this price/);
    expect(STAGE_INSTRUCTIONS.probe).toMatch(/price box/);
  });
});

describe("opensLikePrompt", () => {
  it("recognises the real first line of the system instruction", () => {
    // Tied to the real thing, so renaming that line cannot silently disarm the check.
    const instruction = systemInstruction("probe", { intake: { item: "iPad" }, photoCount: 1 });
    expect(opensLikePrompt(instruction)).toBe(true);
    expect(opensLikePrompt(instruction.slice(0, 80))).toBe(true);
  });

  it.each(["## Protocol version: v2", "**Protocol version** v2"])(
    "recognises it dressed up as markdown: %j",
    (text) => expect(opensLikePrompt(text)).toBe(true),
  );

  it.each([
    "What did you pay for it?",
    "Thanks. The protocol version of your iPad's firmware matters little here.",
    "",
  ])("lets an ordinary reply through: %j", (text) => {
    expect(opensLikePrompt(text)).toBe(false);
  });
});
