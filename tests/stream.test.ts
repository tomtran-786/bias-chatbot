import { describe, expect, it } from "vitest";
import { MarkerFilter } from "@/lib/stream";
import type { Stage } from "@/lib/stages";

/** Feeds `text` through the real filter in fixed-size chunks. */
function run(text: string, chunkSize: number) {
  const emitted: string[] = [];
  const stages: Stage[] = [];
  const filter = new MarkerFilter({
    onText: (value) => emitted.push(value),
    onStage: (value) => stages.push(value),
  });

  for (let i = 0; i < text.length; i += chunkSize) {
    filter.push(text.slice(i, i + chunkSize));
  }
  const stored = filter.end();

  return { visible: emitted.join(""), stored, stages };
}

describe("MarkerFilter", () => {
  const reply = "Thanks for sharing that.\n[[STAGE:commit]]";

  // Chunk size 1 is the worst case: every character of the marker arrives
  // separately, so any off-by-one in the hold-back leaks it to the participant.
  for (const size of [1, 2, 3, 7, 8, 20, 1000]) {
    it(`never leaks a marker at chunk size ${size}`, () => {
      const { visible, stored, stages } = run(reply, size);
      expect(visible).toBe("Thanks for sharing that.\n");
      expect(stored).toBe("Thanks for sharing that.");
      expect(stages).toEqual(["commit"]);
    });
  }

  it("passes through square brackets that are not markers", () => {
    const { visible, stages } = run("See [1] and [[not a marker]].", 3);
    expect(visible).toBe("See [1] and [[not a marker]].");
    expect(stages).toEqual([]);
  });

  it("handles a marker mid-text followed by more prose", () => {
    const { visible, stages } = run("Done.[[STAGE:complete]]Now this.", 4);
    expect(visible).toBe("Done.Now this.");
    expect(stages).toEqual(["complete"]);
  });

  it("ignores markers naming a stage that does not exist", () => {
    const { visible, stages } = run("Hi.[[STAGE:nonsense]]", 5);
    expect(visible).toBe("Hi.");
    expect(stages).toEqual([]);
  });

  it("records multiple markers in order", () => {
    const { stages } = run("a[[STAGE:probe]]b[[STAGE:complete]]", 2);
    expect(stages).toEqual(["probe", "complete"]);
  });

  it("flushes a truncated marker rather than swallowing it", () => {
    // If the model is cut off mid-marker, the text must still be accounted for
    // rather than silently disappearing from the transcript.
    const { stored, stages } = run("All done.[[STAGE:comm", 3);
    expect(stored).toBe("All done.[[STAGE:comm");
    expect(stages).toEqual([]);
  });

  it("exposes partial text after a mid-stream failure", () => {
    const filter = new MarkerFilter({ onText: () => {}, onStage: () => {} });
    filter.push("I was saying something");
    expect(filter.text).toBe("I was saying something");
  });
});
