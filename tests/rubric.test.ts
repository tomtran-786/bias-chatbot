/**
 * The rubric is the instrument's spine: it defines what gets graded, and it is
 * swapped wholesale when the team's registry row is drawn. These tests cover the
 * two ways that swap can go wrong silently — a template that was never filled
 * in, and a scorecard that looks complete but is not.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DIMENSION_COUNT,
  headline,
  parseRubric,
  scoreCard,
  type Dimension,
} from "@/lib/rubric";

function rubricBlock(entries: unknown[]): string {
  return ["Prose before.", "", "```rubric", JSON.stringify(entries), "```", ""].join(
    "\n",
  );
}

function dimension(id: string): Dimension {
  return { id, label: id, low: "a low", high: "a high" };
}

const five = ["a", "b", "c", "d", "e"].map(dimension);

describe("parseRubric", () => {
  it("reads the dimensions out of a protocol document", () => {
    expect(parseRubric(rubricBlock(five))).toHaveLength(DIMENSION_COUNT);
  });

  it("rejects a rubric that still carries template placeholders", () => {
    const unfilled = [...five.slice(1), { ...dimension("x"), label: "TODO(team)" }];
    expect(() => parseRubric(rubricBlock(unfilled))).toThrow(/TODO/);
  });

  it("rejects the wrong number of dimensions", () => {
    expect(() => parseRubric(rubricBlock(five.slice(1)))).toThrow(/exactly 5/);
  });

  it("rejects duplicate ids, which would hide a dimension", () => {
    const duplicated = [...five.slice(1), dimension("b")];
    expect(() => parseRubric(rubricBlock(duplicated))).toThrow(/unique/);
  });

  it("rejects a protocol with no rubric at all", () => {
    expect(() => parseRubric("# Just prose")).toThrow(/rubric block/);
  });

  // The one that matters in practice: the file the app will actually load.
  it("accepts the shipped protocol", () => {
    const text = readFileSync("protocols/protocol_v1.md", "utf8");
    expect(parseRubric(text)).toHaveLength(DIMENSION_COUNT);
  });

  it("rejects the template, which is deliberately unfilled", () => {
    const text = readFileSync("protocols/_template.md", "utf8");
    expect(() => parseRubric(text)).toThrow(/TODO/);
  });
});

describe("headline", () => {
  const scores = (...values: number[]) =>
    values.map((score, index) => ({
      id: String(index),
      score,
      why: "",
      quote: "",
    }));

  it("averages the dimensions and rounds to one place", () => {
    expect(headline(scores(1, 2, 3, 4, 5)).mean).toBe(3);
    expect(headline(scores(3, 3, 3, 3, 4)).mean).toBe(3.2);
  });

  it("bands the result", () => {
    expect(headline(scores(5, 5, 5, 4, 4)).band).toBe("Ready to decide");
    expect(headline(scores(3, 3, 4, 4, 3)).band).toBe("Mostly sound");
    expect(headline(scores(3, 3, 3, 2, 3)).band).toBe("Worth another look");
    expect(headline(scores(1, 1, 1, 1, 1)).band).toBe("Not ready");
  });

  it("reads the band at the boundary rather than just below it", () => {
    // 4.2 exactly: the top band starts here, so an off-by-one in the comparison
    // would quietly demote a decision that cleared the bar.
    expect(headline(scores(5, 4, 4, 4, 4)).mean).toBe(4.2);
    expect(headline(scores(5, 4, 4, 4, 4)).band).toBe("Ready to decide");
  });
});

describe("scoreCard", () => {
  const scored = (id: string, score: number) => ({
    id,
    score,
    why: "because",
    quote: "their words",
  });
  const complete = five.map((d) => scored(d.id, 3));

  it("joins scores to their labels in rubric order", () => {
    const result = scoreCard(five, [...complete].reverse());
    expect(result.map((r) => r.id)).toEqual(five.map((d) => d.id));
    expect(result[0].label).toBe(five[0].label);
  });

  it("rejects a missing dimension", () => {
    expect(() => scoreCard(five, complete.slice(1))).toThrow(/missing/);
  });

  it("rejects a duplicated dimension", () => {
    expect(() =>
      scoreCard(five, [...complete.slice(1), scored("b", 2)]),
    ).toThrow(/more than once/);
  });

  it("rejects a score outside the scale", () => {
    const bad = [scored("a", 7), ...complete.slice(1)];
    expect(() => scoreCard(five, bad)).toThrow(/outside/);
  });

  it("rejects a fractional score", () => {
    const bad = [scored("a", 3.5), ...complete.slice(1)];
    expect(() => scoreCard(five, bad)).toThrow(/outside/);
  });
});
