import { describe, expect, it } from "vitest";
import { systemInstruction } from "@/lib/prompts";
import {
  FACT_COUNT,
  STAGES,
  STAGE_INSTRUCTIONS,
  STAGE_LABELS,
  askedEnough,
  canEnter,
  opensLikePrompt,
  opensLikeVerdict,
  readyForMarket,
  type PhaseContext,
} from "@/lib/stages";

const ready: PhaseContext = {
  assistantTurns: FACT_COUNT,
  photoCount: 1,
  hasMarket: true,
  hasAskingPrice: true,
};

const reason = (result: ReturnType<typeof canEnter>) =>
  result.ok ? null : result.reason;

describe("canEnter", () => {
  it("always lets the model start asking, and always allows the end state", () => {
    const empty: PhaseContext = {
      assistantTurns: 0,
      photoCount: 0,
      hasMarket: false,
      hasAskingPrice: false,
    };
    expect(canEnter("intake", empty).ok).toBe(true);
    expect(canEnter("probe", empty).ok).toBe(true);
    expect(canEnter("complete", empty).ok).toBe(true);
  });

  describe("appraise", () => {
    const unpriced: PhaseContext = { ...ready, hasMarket: false, hasAskingPrice: false };

    it("needs the assistant to have spoken, and nothing more: it decides when it has the facts", () => {
      expect(canEnter("appraise", { ...unpriced, assistantTurns: 0 }).ok).toBe(false);
      expect(canEnter("appraise", { ...unpriced, assistantTurns: 1 }).ok).toBe(true);
      expect(canEnter("appraise", { ...unpriced, assistantTurns: FACT_COUNT }).ok).toBe(true);
    });

    it("needs at least one photo", () => {
      const result = canEnter("appraise", { ...unpriced, photoCount: 0 });
      expect(result.ok).toBe(false);
      expect(reason(result)).toMatch(/photo/);
    });

    it("does not need a price: the market is looked up first", () => {
      expect(canEnter("appraise", unpriced).ok).toBe(true);
      expect(canEnter("appraise", { ...unpriced, assistantTurns: 0 }).ok).toBe(false);
    });
  });

  describe("commit", () => {
    it("needs the market to have been looked up: the price is set having seen it", () => {
      expect(canEnter("commit", { ...ready, hasAskingPrice: false }).ok).toBe(true);
      const result = canEnter("commit", { ...ready, hasMarket: false, hasAskingPrice: false });
      expect(result.ok).toBe(false);
      expect(reason(result)).toMatch(/market has been looked up/);
    });

    it("does not need a price yet: this is the step that asks for it", () => {
      expect(canEnter("commit", { ...ready, hasAskingPrice: false }).ok).toBe(true);
    });
  });

  describe("verdict", () => {
    it("needs a market and a locked price", () => {
      expect(canEnter("verdict", ready).ok).toBe(true);

      const noMarket = canEnter("verdict", { ...ready, hasMarket: false });
      expect(noMarket.ok).toBe(false);
      expect(reason(noMarket)).toMatch(/market/);

      const noPrice = canEnter("verdict", { ...ready, hasAskingPrice: false });
      expect(noPrice.ok).toBe(false);
      expect(reason(noPrice)).toMatch(/locked in their price/);
    });
  });
});

describe("stage order", () => {
  it("looks up and shows the market before it asks for a price", () => {
    expect(STAGES.indexOf("probe")).toBeLessThan(STAGES.indexOf("appraise"));
    expect(STAGES.indexOf("appraise")).toBeLessThan(STAGES.indexOf("commit"));
    expect(STAGES.indexOf("commit")).toBeLessThan(STAGES.indexOf("verdict"));
    expect(STAGE_LABELS.appraise).toBe("The market");
    expect(STAGE_LABELS.commit).toBe("Your price");
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

describe("the opening reminders", () => {
  it("tells the intake not to repeat what the app already showed", () => {
    expect(STAGE_INSTRUCTIONS.intake).toMatch(/already shown them two reminders/);
    expect(STAGE_INSTRUCTIONS.intake).toMatch(/a few questions, then the market, then their own price/);
    expect(STAGE_INSTRUCTIONS.intake).toMatch(/Do not repeat either reminder/);
  });

  it("ties an overpriced verdict back to the buyer and cash reminders, and only then", () => {
    expect(STAGE_INSTRUCTIONS.verdict).toMatch(/Name the bias only if the appraisal says overpriced is true/);
    expect(STAGE_INSTRUCTIONS.verdict).toMatch(/what a buyer arriving now would pay/);
    expect(STAGE_INSTRUCTIONS.verdict).toMatch(/cash they can use/);
  });
});

describe("readyForMarket", () => {
  it("is what the market lookup is gated on, and it never asks for a price", () => {
    expect(readyForMarket({ ...ready, hasMarket: false, hasAskingPrice: false })).toBeNull();
    expect(readyForMarket({ ...ready, assistantTurns: 0 })).toMatch(/not spoken/);
    expect(readyForMarket({ ...ready, photoCount: 0 })).toMatch(/photo/);
  });
});

describe("askedEnough", () => {
  it("is the person's own say-so, and still needs a full set of questions", () => {
    expect(askedEnough({ ...ready, assistantTurns: FACT_COUNT - 1 })).toBe(false);
    expect(askedEnough({ ...ready, assistantTurns: FACT_COUNT })).toBe(true);
    expect(askedEnough({ ...ready, photoCount: 0 })).toBe(false);
  });
});

describe("the probe instruction", () => {
  it("treats what they paid as the second fact, not as a price to sell at", () => {
    expect(STAGE_INSTRUCTIONS.probe).toMatch(/second fact/);
    expect(STAGE_INSTRUCTIONS.probe).toMatch(/not a price they want to sell at/);
  });

  it("checks the whole conversation before asking, and never asks a fact twice", () => {
    for (const stage of ["intake", "probe"] as const) {
      expect(STAGE_INSTRUCTIONS[stage]).toMatch(/description/);
      expect(STAGE_INSTRUCTIONS[stage]).toMatch(/appraise phase/);
    }
    expect(STAGE_INSTRUCTIONS.probe).toMatch(/Never ask for a fact they have already answered/);
  });

  it("only mentions the price box to someone who raised price, and puts it after the market", () => {
    expect(STAGE_INSTRUCTIONS.probe).toMatch(/Only if they say what they want to sell it for/);
    expect(STAGE_INSTRUCTIONS.probe).toMatch(/after they have seen it/);
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
    expect(STAGE_INSTRUCTIONS.probe).toMatch(/what they want to sell it for/);
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

  it.each(["## Protocol version: v3", "**Protocol version** v3"])(
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
