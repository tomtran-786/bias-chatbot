import { describe, expect, it } from "vitest";
import {
  FACT_COUNT,
  STAGES,
  STAGE_INSTRUCTIONS,
  STAGE_LABELS,
  canEnter,
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
