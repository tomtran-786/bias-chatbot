import { describe, expect, it } from "vitest";
import { MalformedAppraisalError, parseJson, unwrapJson } from "@/lib/prompts";

describe("unwrapJson", () => {
  const object = '{"a":1,"b":{"c":[2,3]}}';

  it("leaves plain JSON exactly as it is, so a model that obeys is unaffected", () => {
    expect(unwrapJson(object)).toBe(object);
    expect(unwrapJson(`  \n${object}\n `)).toBe(object);
  });

  it("takes the object out of a code fence, with or without the language tag", () => {
    expect(unwrapJson("```json\n" + object + "\n```")).toBe(object);
    expect(unwrapJson("```\n" + object + "\n```")).toBe(object);
    expect(unwrapJson("```JSON\n" + object + "```")).toBe(object);
  });

  it("takes the object out of a sentence on either side", () => {
    expect(unwrapJson(`Here is the result: ${object} Let me know.`)).toBe(object);
  });

  it("returns something unparseable as it is, for the parser to reject", () => {
    expect(unwrapJson("no json at all")).toBe("no json at all");
  });
});

describe("parseJson", () => {
  it("parses a wrapped answer", () => {
    expect(parseJson('```json\n{"x":1}\n```', "thing")).toEqual({ x: 1 });
  });

  it("still names what was wrong with an answer that cannot be rescued", () => {
    expect(() => parseJson("sorry, no", "item facts")).toThrow(/item facts was not valid JSON/);
    expect(() => parseJson("{broken", "item facts")).toThrow(MalformedAppraisalError);
    expect(() => parseJson("   ", "item facts")).toThrow(/empty/);
    expect(() => parseJson(undefined, "item facts")).toThrow(/empty/);
  });
});
