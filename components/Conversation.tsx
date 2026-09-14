"use client";

import { useEffect, useRef, useState } from "react";
import { CommitmentGate } from "@/components/CommitmentGate";
import { FrameForm } from "@/components/FrameForm";
import { Prose } from "@/components/Prose";
import { Scorecard, type Grade } from "@/components/Scorecard";
import type { Commitment, Frame } from "@/lib/decision";
import { DIMENSION_COUNT } from "@/lib/rubric";
import { STAGES, STAGE_LABELS, type Stage } from "@/lib/stages";
import { assistantTurns, type TranscriptMessage } from "@/lib/transcript";

/**
 * A turn the model must see but the reader should not — the openers sent on the
 * person's behalf to start a phase they did not have to type into.
 */
type StreamMessage = TranscriptMessage & { hidden?: boolean };

const OPENERS: Partial<Record<Stage, string>> = {
  frame: "I'm ready — here's my decision.",
  recommend: "I've seen the grade. What do you recommend?",
};

type ChatError = "rate_limited" | "server_error" | "turn_limit" | "out_of_order";

const ERROR_COPY: Record<ChatError, string> = {
  rate_limited:
    "The AI service has hit its request limit. Wait a minute and send again — nothing you wrote is lost.",
  server_error: "Something went wrong generating a reply. Send it again.",
  turn_limit: "This conversation has reached its maximum length.",
  out_of_order: "That step is not available yet.",
};

/** "complete" is an end state rather than a step, so it is not on the rail. */
const RAIL = STAGES.filter((stage) => stage !== "complete");

const toTranscript = (messages: StreamMessage[]): TranscriptMessage[] =>
  messages.map(({ role, text, at }) => ({ role, text, at }));

/**
 * The whole conversation, as one stream.
 *
 * The intake form, the commitment and the scorecard are cards *inside* the
 * conversation rather than screens it hands off to, so the thread reads as one
 * continuous exchange and nothing the person already answered scrolls out of
 * existence.
 *
 * `gradedAt` is the transcript index the scorecard belongs at — the grade is a
 * separate call and leaves no turn of its own, so without it the card could only
 * be pinned to the end and would sit below the recommendation it produced.
 */
export function Conversation() {
  const [phase, setPhase] = useState<Stage>("frame");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [commitment, setCommitment] = useState<Commitment | null>(null);
  const [grade, setGrade] = useState<Grade | null>(null);
  const [gradedAt, setGradedAt] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const opened = useRef(new Set<Stage>());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, phase, grade, streaming]);

  // Frame and recommend both begin with the assistant, so their opening turn is
  // sent on the person's behalf instead of waiting for them to type.
  useEffect(() => {
    const opener = OPENERS[phase];
    if (!frame || !opener || opened.current.has(phase)) return;
    opened.current.add(phase);
    void send(opener, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, frame]);

  async function send(text: string, hidden = false) {
    if (!frame) return;
    setError(null);
    setStreaming(true);

    const history = [
      ...messages,
      { role: "user" as const, text, at: new Date().toISOString(), hidden },
    ];
    setMessages([
      ...history,
      { role: "model", text: "", at: new Date().toISOString() },
    ]);

    const rollBack = () => {
      setMessages((current) => current.slice(0, -2));
      if (hidden) opened.current.delete(phase);
      else setDraft(text);
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase,
          frame,
          // `?? undefined` so the key is dropped rather than serialised as
          // null: the API treats absent as absent, and zod's .optional()
          // rejects an explicit null.
          commitment: commitment ?? undefined,
          grade: grade?.dimensions,
          transcript: toTranscript(messages),
          message: text,
        }),
      });

      if (!response.ok || !response.body) {
        setError(
          response.status === 429
            ? "turn_limit"
            : response.status === 409
              ? "out_of_order"
              : "server_error",
        );
        rollBack();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let carry = "";
      let generated = "";
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
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              next[next.length - 1] = { ...last, text: last.text + event.v };
              return next;
            });
          } else if (event.t === "stage") {
            stages.push(event.v);
          } else {
            setError(event.code);
          }
        }
      }

      if (!generated) {
        rollBack();
        return;
      }

      // Applied only once the turn has landed, so the phase never changes
      // underneath a reply that is still being written.
      if (phase === "frame") setPhase("probe");
      for (const stage of stages) {
        if (stage === "commit" && phase === "probe") setPhase("commit");
        if (stage === "complete" && phase === "recommend") setPhase("complete");
      }
    } catch {
      setError("server_error");
      rollBack();
    } finally {
      setStreaming(false);
    }
  }

  async function requestGrade(recorded: Commitment) {
    if (!frame) return;
    setGrading(true);
    setFailure(null);
    try {
      const response = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frame,
          commitment: recorded,
          transcript: toTranscript(messages),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setFailure(
          response.status === 429
            ? "The AI service has hit its request limit. Wait a minute and try again."
            : ((body as { reason?: string } | null)?.reason ??
              "The grade could not be produced. Try again."),
        );
        return;
      }
      setCommitment(recorded);
      setGrade(body as Grade);
      setGradedAt(messages.length);
      setPhase("grade");
    } catch {
      setFailure("The grade could not be produced. Try again.");
    } finally {
      setGrading(false);
    }
  }

  function submitDraft() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    void send(text);
  }

  const asked = assistantTurns(toTranscript(messages));
  const composing = phase === "frame" || phase === "probe";
  const beforeGrade = gradedAt === null ? messages : messages.slice(0, gradedAt);
  const afterGrade = gradedAt === null ? [] : messages.slice(gradedAt);

  return (
    <div className="flex h-dvh flex-col">
      <header className="shrink-0 border-b border-rule bg-surface/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-5 py-3">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-sm font-semibold tracking-tight">
              Decision grader
            </h1>
            <p className="text-xs text-ink-muted">
              {STAGE_LABELS[phase]}
              {composing && frame ? (
                <span className="nums"> · {asked}/{DIMENSION_COUNT} asked</span>
              ) : null}
            </p>
          </div>
          {frame ? (
            <ol className="flex gap-1.5" aria-label="Progress">
              {RAIL.map((step) => {
                const reached = STAGES.indexOf(phase) >= STAGES.indexOf(step);
                return (
                  <li
                    key={step}
                    aria-current={phase === step ? "step" : undefined}
                    className={`h-0.5 flex-1 rounded-full transition-colors ${
                      reached ? "bg-accent" : "bg-track"
                    }`}
                  >
                    <span className="sr-only">
                      {STAGE_LABELS[step]}
                      {reached ? " — reached" : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 py-6">
          {!frame ? (
            <FrameForm onSubmit={setFrame} />
          ) : (
            <DecisionCard frame={frame} />
          )}

          {beforeGrade.map((message, index) => (
            <Turn key={index} message={message} streaming={streaming} />
          ))}

          {phase === "commit" && frame ? (
            <CommitmentGate
              frame={frame}
              pending={grading}
              onSubmit={requestGrade}
            />
          ) : null}

          {grade && commitment ? (
            <>
              <Turn
                message={{
                  role: "user",
                  text: `I'd pick: ${commitment.option}. I'd rate my own thinking ${commitment.selfScore}/5.`,
                  at: "",
                }}
                streaming={false}
              />
              <Scorecard
                grade={grade}
                commitment={commitment}
                pending={streaming}
                onContinue={() => setPhase("recommend")}
              />
            </>
          ) : null}

          {afterGrade.map((message, index) => (
            <Turn key={`after-${index}`} message={message} streaming={streaming} />
          ))}

          {error ? <Notice>{ERROR_COPY[error]}</Notice> : null}
          {failure ? <Notice>{failure}</Notice> : null}

          <div ref={bottomRef} className="h-px" />
        </div>
      </div>

      {composing && frame ? (
        <footer className="shrink-0 border-t border-rule bg-surface/80 backdrop-blur">
          <div className="mx-auto w-full max-w-2xl px-5 py-4">
            <div className="flex items-end gap-2 rounded-2xl border border-rule bg-surface px-3 py-2 focus-within:border-rule-strong">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submitDraft();
                  }
                }}
                rows={1}
                disabled={streaming}
                placeholder="Type your answer…"
                aria-label="Your answer"
                className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[15px] outline-none placeholder:text-ink-muted disabled:opacity-50"
              />
              <button
                type="button"
                onClick={submitDraft}
                disabled={streaming || !draft.trim()}
                className="mb-0.5 shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-medium text-plane transition-opacity hover:opacity-90 disabled:opacity-30"
              >
                Send
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              {asked < DIMENSION_COUNT
                ? `One question per scored dimension — the grade unlocks after ${DIMENSION_COUNT}.`
                : "Enough asked to grade. Keep going if there is more to say."}
            </p>
          </div>
        </footer>
      ) : null}
    </div>
  );
}

function Turn({
  message,
  streaming,
}: {
  message: StreamMessage;
  streaming: boolean;
}) {
  if (message.hidden) return null;

  if (message.role === "user") {
    return (
      <p className="rise max-w-[85%] self-end rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[15px] leading-relaxed text-bubble-ink">
        {message.text}
      </p>
    );
  }

  if (!message.text) {
    return streaming ? (
      <p className="flex gap-1 py-1" aria-label="Thinking">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-1.5 animate-pulse rounded-full bg-ink-muted"
            style={{ animationDelay: `${dot * 160}ms` }}
          />
        ))}
      </p>
    ) : null;
  }

  return (
    <div className="rise max-w-[92%]">
      <Prose text={message.text} />
    </div>
  );
}

/** The frame, echoed back so the decision stays visible as the thread grows. */
function DecisionCard({ frame }: { frame: Frame }) {
  return (
    <section className="rise rounded-2xl border border-rule bg-sunken px-5 py-4">
      <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
        The decision
      </p>
      <p className="mt-2 text-[15px] leading-relaxed">{frame.decision}</p>
      <dl className="mt-3 flex flex-col gap-1.5 text-sm text-ink-secondary">
        <div className="flex gap-2">
          <dt className="shrink-0 text-ink-muted">Options</dt>
          <dd>{frame.options.join(" · ")}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-ink-muted">By</dt>
          <dd>{frame.deadline}</dd>
        </div>
      </dl>
    </section>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-xl border border-rule-strong bg-sunken px-4 py-3 text-sm text-ink-secondary"
    >
      {children}
    </p>
  );
}
