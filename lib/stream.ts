/**
 * Turns the model's raw token stream into participant-visible text plus stage
 * transitions.
 *
 * Kept separate from the route so it can be tested directly: a stage marker
 * leaking into what the participant reads would both break the illusion and
 * corrupt the stored transcript, and the failure only shows up at particular
 * chunk boundaries.
 */
import { extractMarkers, safeEmitLength, type Stage } from "./stages";

export type StreamSink = {
  onText: (text: string) => void;
  onStage: (stage: Stage) => void;
};

export class MarkerFilter {
  /** Text received but not yet safe to emit — it may be a partial marker. */
  private buffer = "";
  /** Everything the participant has been shown, markers removed. */
  private visible = "";

  constructor(private readonly sink: StreamSink) {}

  push(chunk: string): void {
    this.buffer += chunk;
    this.drain(false);
  }

  /** Call once the stream ends: emits whatever is left, partial marker or not. */
  end(): string {
    this.drain(true);
    return this.visible.trim();
  }

  /** Participant-visible text so far, for saving a partially failed turn. */
  get text(): string {
    return this.visible.trim();
  }

  private drain(flush: boolean): void {
    const upTo = flush ? this.buffer.length : safeEmitLength(this.buffer);
    if (upTo === 0) return;

    const ready = this.buffer.slice(0, upTo);
    this.buffer = this.buffer.slice(upTo);

    const { cleaned, stages } = extractMarkers(ready);
    if (cleaned) {
      this.visible += cleaned;
      this.sink.onText(cleaned);
    }
    for (const stage of stages) this.sink.onStage(stage);
  }
}
