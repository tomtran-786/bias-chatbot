"use client";

import { useEffect, useRef, useState } from "react";
import { Prose } from "@/components/Prose";
import type { Commitment, Frame } from "@/lib/decision";
import type { ScoredDimension } from "@/lib/rubric";
import { DIMENSION_COUNT } from "@/lib/rubric";
import type { Stage } from "@/lib/stages";
import { assistantTurns, type TranscriptMessage } from "@/lib/transcript";

type ChatError = "rate_limited" | "server_error" | "turn_limit" | "out_of_order" | null;

const ERROR_COPY: Record<NonNullable<ChatError>, string> = {
  rate_limited:
    "The AI service has hit its request limit for now. Wait a minute and send again — nothing you have written is lost.",
  server_error: "Something went wrong generating a reply. Send your message again.",
  turn_limit:
    "This conversation has reached its maximum length. Continue to the next step.",
  out_of_order:
    "That step is not available yet — the assistant still has questions to ask.",
};

/** Sent on the person's behalf to open a phase they did not have to type into. */
const OPENERS: Partial<Record<Stage, string>> = {
  frame: "I'm ready — here's my decision.",
  recommend: "I've seen the grade. What do you recommend?",
};

/**
 * The conversation.
 *
 * Owns the network turn and the NDJSON parsing; the transcript itself lives in
 * the page, because the grade request needs it too and two copies would drift.
 */
export function ChatView({
  phase,
  frame,
  commitment,
  grade,
  transcript,
  setTranscript,
  onStage,
  onReady,
}: {
  phase: Stage;
  frame: Frame;
  commitment?: Commitment;
  grade?: ScoredDimension[];
  transcript: TranscriptMessage[];
  setTranscript: React.Dispatch<React.SetStateAction<TranscriptMessage[]>>;
  onStage: (stage: Stage) => void;
  /** Called when the assistant finishes a turn, so the page can advance. */
  onReady: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<ChatError>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Phases whose opener has already been sent, so effects cannot double-fire. */
  const opened = useRef(new Set<Stage>());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, streaming]);

  // Frame and recommend both begin with the assistant, so their first turn is
  // sent on the person's behalf rather than waiting for them to type.
  useEffect(() => {
    const opener = OPENERS[phase];
    if (!opener || opened.current.has(phase)) return;
    opened.current.add(phase);
    void send(opener, { hidden: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function send(text: string, options?: { hidden?: boolean }) {
    setError(null);
    setStreaming(true);

    const sent: TranscriptMessage = {
      role: "user",
      text,
      at: new Date().toISOString(),
    };
    // The hidden opener still goes into the transcript — the model has to see
    // its own side of the exchange — but is not rendered.
    const history = [...transcript, sent];
    setTranscript([
      ...history,
      { role: "model", text: "", at: new Date().toISOString() },
    ]);

    let generated = "";

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase,
          frame,
          commitment,
          grade,
          transcript,
          message: text,
        }),
      });

      if (!response.ok || !response.body) {
        const code =
          response.status === 429
            ? "turn_limit"
            : response.status === 409
              ? "out_of_order"
              : "server_error";
        failTurn(code, text, options?.hidden);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let carry = "";
      let failed = false;
      const stages: Stage[] = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        carry += decoder.decode(value, { stream: true });

        // NDJSON: everything before the last newline is a complete event.
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as
            | { t: "text"; v: string }
            | { t: "stage"; v: Stage }
            | { t: "error"; code: "rate_limited" | "server_error" };

          if (event.t === "text") {
            generated += event.v;
            setTranscript((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              next[next.length - 1] = { ...last, text: last.text + event.v };
              return next;
            });
          } else if (event.t === "stage") {
            stages.push(event.v);
          } else {
            failed = true;
            setError(event.code);
          }
        }
      }

      if (failed && !generated) {
        failTurn("server_error", text, options?.hidden);
        return;
      }

      // Stage transitions are applied only once the turn has landed, so a phase
      // never changes underneath a reply that is still being written.
      for (const stage of stages) onStage(stage);
      onReady();
    } catch {
      failTurn("server_error", text, options?.hidden);
    } finally {
      setStreaming(false);
    }
  }

  /** Rolls the failed turn out of the transcript so it can simply be resent. */
  function failTurn(code: NonNullable<ChatError>, text: string, hidden?: boolean) {
    setError(code);
    setTranscript((current) => current.slice(0, -2));
    if (!hidden) setDraft(text);
    if (hidden) opened.current.delete(phase);
  }

  function handleSubmit() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    void send(text);
  }

  // The hidden openers are dropped from the render, not from the transcript.
  const visible = transcript.filter(
    (message) => !Object.values(OPENERS).includes(message.text),
  );
  const asked = assistantTurns(transcript);
  const canRetry = error !== null && !streaming;

  return (
    <section className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4">
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 py-4">
          {visible.map((message, index) => (
            <div
              key={index}
              className={
                message.role === "user"
                  ? "max-w-[85%] self-end rounded-2xl rounded-br-sm bg-neutral-900 px-4 py-2.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "max-w-[95%]"
              }
            >
              {message.role === "model" ? (
                message.text ? (
                  <Prose text={message.text} />
                ) : streaming ? (
                  <span className="text-neutral-400">…</span>
                ) : null
              ) : (
                message.text
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {error ? (
        <p
          role="status"
          className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {ERROR_COPY[error]}
        </p>
      ) : null}

      {phase === "probe" || phase === "frame" ? (
        <div className="flex shrink-0 flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSubmit();
                }
              }}
              rows={2}
              disabled={streaming}
              placeholder="Type your reply…"
              aria-label="Your reply"
              className="flex-1 resize-none rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700"
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={streaming || (!draft.trim() && !canRetry)}
              className="rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
            >
              Send
            </button>
          </div>
          <p className="text-xs text-neutral-500">
            {asked < DIMENSION_COUNT
              ? `${asked} of ${DIMENSION_COUNT} questions asked — the grade unlocks once all five are covered.`
              : "Enough asked to grade. The assistant will move you on, or keep going if there is more to say."}
          </p>
        </div>
      ) : null}
    </section>
  );
}
