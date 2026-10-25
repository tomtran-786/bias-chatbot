import { describe, expect, it } from "vitest";
import {
  EXTRACT_INSTRUCTION,
  FACTS_SCHEMA,
  MARKER_RULE,
  MalformedAppraisalError,
  extractionSchema,
  parseFacts,
  parseJson,
  parseReading,
  systemInstruction,
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

describe("the marker rule", () => {
  it("lets the commit marker come at the first reply, when they have already said everything", () => {
    expect(MARKER_RULE).toMatch(/commit marker may end your very first reply/);
    expect(MARKER_RULE).not.toMatch(/never in the same turn that a phase began/);
  });

  it("still never has the assistant emit more than the two markers", () => {
    expect(MARKER_RULE).toMatch(/only markers you ever emit/);
    expect(MARKER_RULE).toMatch(/at most one per turn/);
  });
});

describe("a locked price in the system instruction", () => {
  const context = { intake: { item: "iPhone 13" }, photoCount: 1 };

  it("is stated when it is locked, without a number, and points at the lookup button", () => {
    const text = systemInstruction("probe", { ...context, priceLocked: true });
    expect(text).toMatch(/already locked in/);
    expect(text).toMatch(/You are not told what it is/);
    expect(text).toMatch(/Do not ask for a price/);
    expect(text).toMatch(/Look up the market/);
    expect(text).not.toMatch(/\$\d/);
  });

  it("is absent otherwise, so the questions are exactly what they were", () => {
    expect(systemInstruction("probe", context)).not.toMatch(/already locked in/);
    expect(systemInstruction("probe", { ...context, priceLocked: false })).not.toMatch(/locked in/);
  });
});

describe("the facts", () => {
  it("asks for the price in the currency it was said in, as a full number", () => {
    expect(FACTS_SCHEMA.properties.purchaseCurrency.enum).toEqual(["USD", "VND"]);
    expect(FACTS_SCHEMA.properties.purchasePrice.description).toMatch(/never converted/);
    expect(FACTS_SCHEMA.properties.purchasePrice.description).toMatch(/15000000/);
  });

  it("are converted by the app, at the rate it is given", () => {
    const facts = parseFacts(
      JSON.stringify({
        searchQuery: "iPhone 13",
        model: "iPhone 13",
        condition: "good",
        purchasePrice: 13_000_000,
        purchaseCurrency: "VND",
      }),
      26_000,
    );
    expect(facts.purchasePrice).toBe(500);
    expect(facts).not.toHaveProperty("purchaseCurrency");
  });

  it("do not fail over a detail field, but do over the model's absence", () => {
    expect(parseFacts('{"searchQuery":"x","model":"x","condition":"good","ageMonths":"long"}').ageMonths).toBeNull();
    expect(() => parseFacts('{"searchQuery":"x","condition":"good"}')).toThrow(MalformedAppraisalError);
  });
});

describe("reading listings in đồng", () => {
  it("is told to copy the price as written, to leave Shopee's 'sold' count alone and to keep to used items", () => {
    expect(EXTRACT_INSTRUCTION).toMatch(/Chợ Tốt, Shopee and Lazada/);
    expect(EXTRACT_INSTRUCTION).toMatch(/5\.500\.000 ₫/);
    expect(EXTRACT_INSTRUCTION).toMatch(/Đã bán 1,2k/);
    expect(EXTRACT_INSTRUCTION).toMatch(/mark those listings active/);
    expect(EXTRACT_INSTRUCTION).toMatch(/only if it is a used or second-hand item/);
  });
});
