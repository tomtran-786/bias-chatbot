import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetExhaustedError, remaining, resetBudget, spend } from "@/lib/budget";

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

beforeEach(() => {
  resetBudget();
  process.env.DAILY_SEARCH_BUDGET = "5";
  process.env.DAILY_MODEL_BUDGET = "10";
});
afterEach(() => {
  delete process.env.DAILY_SEARCH_BUDGET;
  delete process.env.DAILY_MODEL_BUDGET;
  resetBudget();
});

describe("spend", () => {
  it("counts what is spent against each kind separately", () => {
    spend([["search", 2]]);
    spend([["model", 3]]);
    expect(remaining("search")).toBe(3);
    expect(remaining("model")).toBe(7);
  });

  it("allows spending exactly up to the limit, and refuses the next call", () => {
    spend([["search", 5]]);
    expect(remaining("search")).toBe(0);
    expect(() => spend([["search", 1]])).toThrow(BudgetExhaustedError);
  });

  it("says which kind ran out", () => {
    spend([["model", 10]]);
    try {
      spend([["model", 1]]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExhaustedError);
      expect((error as BudgetExhaustedError).kind).toBe("model");
    }
  });

  it("refuses a request that would cross the limit without spending any of it", () => {
    spend([["search", 4]]);
    expect(() => spend([["search", 2]])).toThrow(BudgetExhaustedError);
    expect(remaining("search")).toBe(1);
  });

  it("is all or nothing across kinds: a refused model call does not cost the search", () => {
    spend([["model", 10]]);
    expect(() =>
      spend([
        ["search", 2],
        ["model", 2],
      ]),
    ).toThrow(BudgetExhaustedError);
    expect(remaining("search")).toBe(5);
  });

  it("adds up the same kind listed twice in one request", () => {
    expect(() =>
      spend([
        ["search", 3],
        ["search", 3],
      ]),
    ).toThrow(BudgetExhaustedError);
  });
});

describe("a new day", () => {
  it("starts again from zero", () => {
    spend([["search", 5]], day("2026-10-22"));
    expect(() => spend([["search", 1]], day("2026-10-22"))).toThrow(BudgetExhaustedError);

    expect(remaining("search", day("2026-10-23"))).toBe(5);
    expect(() => spend([["search", 1]], day("2026-10-23"))).not.toThrow();
  });

  it("turns over at midnight UTC", () => {
    spend([["model", 10]], new Date("2026-10-22T23:59:59Z"));
    expect(remaining("model", new Date("2026-10-23T00:00:00Z"))).toBe(10);
  });
});

describe("the limits", () => {
  it("come from the environment", () => {
    process.env.DAILY_SEARCH_BUDGET = "1";
    spend([["search", 1]]);
    expect(() => spend([["search", 1]])).toThrow(BudgetExhaustedError);
  });

  it("default to 80 searches and 300 model calls", () => {
    delete process.env.DAILY_SEARCH_BUDGET;
    delete process.env.DAILY_MODEL_BUDGET;
    expect(remaining("search")).toBe(80);
    expect(remaining("model")).toBe(300);
  });

  it("fall back to the default for a value that is not a positive integer, instead of switching the limit off", () => {
    for (const bad of ["abc", "0", "-3", "1.5", ""]) {
      process.env.DAILY_SEARCH_BUDGET = bad;
      expect(remaining("search")).toBe(80);
    }
  });
});
