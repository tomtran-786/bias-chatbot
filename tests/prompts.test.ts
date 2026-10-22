import { describe, expect, it } from "vitest";
import {
  MalformedAppraisalError,
  extractionSchema,
  parseJson,
  parseReading,
  unwrapJson,
} from "@/lib/prompts";

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

describe("the new price in a reading", () => {
  const reading = (newPrice?: unknown) =>
    JSON.stringify({
      listings: [],
      ...(newPrice === undefined ? {} : { newPrice }),
      position: "typical",
      positionEvidence: "",
    });

  it("is a price as written plus the source it was read from", () => {
    expect(parseReading(reading({ priceText: "$699.99", sourceIndex: 2 })).newPrice).toEqual({
      priceText: "$699.99",
      sourceIndex: 2,
    });
  });

  it("is none when the model gave none", () => {
    expect(parseReading(reading()).newPrice).toBeNull();
    expect(parseReading(reading(null)).newPrice).toBeNull();
  });

  it("is none, rather than a failed reading, when it is not in the shape asked for", () => {
    // A bare number has no source, so it could not be checked and would not be used anyway.
    expect(parseReading(reading(699)).newPrice).toBeNull();
    expect(parseReading(reading({ priceText: "$699" })).newPrice).toBeNull();
  });

  it("still rejects a reading whose listings are wrong", () => {
    expect(() => parseReading('{"listings":"none","position":"typical","positionEvidence":""}')).toThrow(
      MalformedAppraisalError,
    );
  });

  it("can only cite a source that exists, like a listing", () => {
    const { properties } = extractionSchema(3);
    expect(properties.newPrice.properties.sourceIndex.enum).toEqual([0, 1, 2]);
    expect(properties.newPrice.required).toEqual(["priceText", "sourceIndex"]);
  });
});
