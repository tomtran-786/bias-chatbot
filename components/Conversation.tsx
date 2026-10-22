"use client";

import { useEffect, useRef, useState } from "react";
import { IntakeForm } from "@/components/IntakeForm";
import { MarketCard } from "@/components/MarketCard";
import { PhotoPicker, Thumb } from "@/components/PhotoPicker";
import { PriceGate } from "@/components/PriceGate";
import { Prose } from "@/components/Prose";
import {
  MAX_PHOTOS,
  type AskingPrice,
  type Intake,
  type Photo,
} from "@/lib/item";
import { formatUsd, type AppraiseResponse } from "@/lib/pricing";
import {
  FACT_COUNT,
  STAGES,
  STAGE_LABELS,
  canEnter,
  type Stage,
} from "@/lib/stages";
import {
  assistantTurns,
  photoCount,
  type TranscriptMessage,
} from "@/lib/transcript";

/**
 * A turn the model must see but the reader should not — the openers sent on the
 * person's behalf to start a phase they did not have to type into.
 */
type StreamMessage = TranscriptMessage & { hidden?: boolean };

const VERDICT_OPENER = "I've seen the market. What do you suggest?";

const openerFor = (phase: Stage, intake: Intake): string | null =>
  phase === "intake"
    ? `I'm selling: ${intake.item}.`
    : phase === "verdict"
      ? VERDICT_OPENER
      : null;

type ChatError =
  | "rate_limited"
  | "server_error"
  | "turn_limit"
  | "out_of_order"
  | "payload_too_large"
  | "budget_exhausted";

const ERROR_COPY: Record<ChatError, string> = {
  rate_limited:
    "The AI service has hit its request limit. Wait a minute and send again — nothing you wrote is lost.",
  server_error: "Something went wrong generating a reply. Send it again.",
  turn_limit: "This conversation has reached its maximum length.",
  out_of_order: "That step is not available yet.",
  payload_too_large:
    "A photo is too large to send. Remove it and attach a smaller one.",
  budget_exhausted:
    "This app’s daily limit on AI calls is used up. It resets at midnight UTC, or when the server restarts.",
};

/** What the market lookup can refuse with, in words a person can act on. */
const APPRAISE_ERROR_COPY: Record<string, string> = {
  rate_limited:
    "A free-tier rate limit was hit. Wait a minute and try again; if it keeps happening, the day’s quota may be used up.",
  search_quota:
    "The search service’s free credits for this month are used up, so the market cannot be looked up until they renew. Nothing is charged.",
  search_unavailable:
    "The market search is not set up correctly.",
  search_failed: "The market search failed.",
  budget_exhausted:
    "This app’s daily limit on market lookups is used up. It resets at midnight UTC, or when the server restarts.",
  payload_too_large:
    "A photo is too large to send. Remove it and attach a smaller one.",
};

const asChatError = (code: string | undefined): ChatError =>
  code && code in ERROR_COPY ? (code as ChatError) : "server_error";

/** "complete" is an end state rather than a step, so it is not on the rail. */
const RAIL = STAGES.filter((stage) => stage !== "complete");

const toTranscript = (messages: StreamMessage[]): TranscriptMessage[] =>
  messages.map(({ role, text, at, photoIds }) => ({ role, text, at, photoIds }));

type SendOptions = {
  hidden?: boolean;
  /** Photos this message introduces that are not yet held. */
  newPhotos?: Photo[];
  /** Photos this message introduces that are already held (the intake set). */
  photoIds?: string[];
};

/**
 * The whole conversation, as one stream.
 *
 * The intake form, the price lock and the market card are cards *inside* the
 * conversation rather than screens it hands off to, so the thread reads as one
 * continuous exchange and nothing the person already answered scrolls out of
 * existence.
 *
 * `appraisedAt` is the transcript index the market card belongs at — the lookup
 * is a separate call and leaves no turn of its own, so without it the card could
 * only be pinned to the end and would sit below the verdict it produced.
 */
export function Conversation() {
  const [phase, setPhase] = useState<Stage>("intake");
  const [intake, setIntake] = useState<Intake | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [intakePhotos, setIntakePhotos] = useState<Photo[]>([]);
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [askingPrice, setAskingPrice] = useState<AskingPrice | null>(null);
  const [appraisal, setAppraisal] = useState<AppraiseResponse | null>(null);
  const [appraisedAt, setAppraisedAt] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Photo[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [appraising, setAppraising] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const opened = useRef(new Set<Stage>());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, phase, appraisal, streaming, appraising]);

  // Intake and verdict both begin with the assistant, so their opening turn is
  // sent on the person's behalf instead of waiting for them to type.
  useEffect(() => {
    if (!intake || opened.current.has(phase)) return;
    const opener = openerFor(phase, intake);
    if (!opener) return;
    opened.current.add(phase);
    void send(opener, {
      hidden: true,
      photoIds: phase === "intake" ? intakePhotos.map((photo) => photo.id) : [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, intake]);

  async function send(text: string, options: SendOptions = {}) {
    if (!intake) return;
    const { hidden = false, newPhotos = [] } = options;
    const photoIds = [
      ...(options.photoIds ?? []),
      ...newPhotos.map((photo) => photo.id),
    ];
    const allPhotos = [...photos, ...newPhotos];

    setError(null);
    setFailure(null);
    setStreaming(true);

    const history: StreamMessage[] = [
      ...messages,
      {
        role: "user",
        text,
        at: new Date().toISOString(),
        hidden,
        photoIds: photoIds.length ? photoIds : undefined,
      },
    ];
    setMessages([
      ...history,
      { role: "model", text: "", at: new Date().toISOString() },
    ]);
    if (newPhotos.length) setPhotos(allPhotos);

    const rollBack = () => {
      setMessages((current) => current.slice(0, -2));
      setPhotos(photos);
      opened.current.delete(phase);
      if (!hidden) {
        setDraft(text);
        setAttachments(newPhotos);
      }
    };

    // The verdict is the only turn that may see the price and the market; the
    // server ignores them elsewhere, and leaving them out keeps the body small.
    const forVerdict = phase === "verdict";

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase,
          intake,
          photos: allPhotos,
          // `?? undefined` so the key is dropped rather than serialised as
          // null: the API treats absent as absent, and zod's .optional()
          // rejects an explicit null.
          askingPrice: forVerdict ? (askingPrice ?? undefined) : undefined,
          appraisal: forVerdict ? appraisal?.raw : undefined,
          transcript: toTranscript(messages),
          message: text,
          messagePhotoIds: photoIds.length ? photoIds : undefined,
        }),
      });

      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(asChatError(body?.error));
        rollBack();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let carry = "";
      let generated = "";
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
            setMessages((current) => {
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

      // A verdict cut off half way has no composer to continue from, so it is
      // withdrawn and offered again rather than left standing as the answer.
      if (!generated || (failed && phase !== "probe")) {
        rollBack();
        return;
      }

      // Applied only once the turn has landed, so the phase never changes
      // underneath a reply that is still being written.
      if (failed) return;
      if (phase === "intake") setPhase("probe");
      if (phase === "verdict") setPhase("complete");
      for (const stage of stages) {
        // The server drops a commit marker that arrives too early; checking
        // again here means a stale or tampered stream cannot skip the questions
        // either. With a price already locked, the lookup button takes over.
        if (stage === "commit" && phase !== "verdict" && !askingPrice) {
          const gate = canEnter("commit", {
            assistantTurns: assistantTurns(toTranscript(history)) + 1,
            photoCount: photoCount(toTranscript(history)),
            hasAskingPrice: false,
            hasAppraisal: false,
          });
          if (gate.ok) setPhase("commit");
        }
      }
    } catch {
      setError("server_error");
      rollBack();
    } finally {
      setStreaming(false);
    }
  }

  async function requestAppraisal(asking: AskingPrice) {
    if (!intake) return;
    setAppraising(true);
    setFailure(null);
    try {
      const response = await fetch("/api/appraise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intake,
          photos,
          askingPrice: asking,
          transcript: toTranscript(messages),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | (AppraiseResponse & { error?: undefined })
        | { error?: string; reason?: string }
        | null;

      if (!response.ok || !body || body.error || !("market" in body)) {
        const code = body && "error" in body ? body.error : undefined;
        if (code === "needs_identity") {
          // The price stays locked: nothing about the market has been seen, so
          // the baseline is intact. The questions pick up where they left off.
          setAskingPrice(asking);
          setPhase("probe");
          setFailure(
            "The assistant could not tell exactly which model this is, so there is nothing to search for. Tell it more about the item — the model name, a label, a screenshot of the settings — then look up the market again. Your price stays locked in.",
          );
        } else {
          const reason = body && "reason" in body ? body.reason : undefined;
          const known = code ? APPRAISE_ERROR_COPY[code] : undefined;
          setFailure(
            known
              ? reason
                ? `${known} ${reason}`
                : known
              : reason
                ? `The market could not be looked up: ${reason}`
                : "The market could not be looked up. Try again.",
          );
        }
        return;
      }

      setAskingPrice(asking);
      setAppraisal(body as AppraiseResponse);
      setAppraisedAt(messages.length);
      setPhase("appraise");
    } catch {
      setFailure("The market could not be looked up. Try again.");
    } finally {
      setAppraising(false);
    }
  }

  function submitDraft() {
    const text = draft.trim();
    if (!text || streaming) return;
    const newPhotos = attachments;
    setDraft("");
    setAttachments([]);
    void send(text, { newPhotos });
  }

  const asked = assistantTurns(toTranscript(messages));
  const composing = phase === "intake" || phase === "probe";
  const canPrice =
    phase === "probe" &&
    !askingPrice &&
    canEnter("commit", {
      assistantTurns: asked,
      photoCount: photoCount(toTranscript(messages)),
      hasAskingPrice: false,
      hasAppraisal: false,
    }).ok;
  const before = appraisedAt === null ? messages : messages.slice(0, appraisedAt);
  const after = appraisedAt === null ? [] : messages.slice(appraisedAt);
  const photoById = new Map(photos.map((photo) => [photo.id, photo]));

  // The assistant opens intake and the verdict by itself; if that failed there
  // is nothing on screen to reply to, so offer the opener again.
  const needsRetry =
    !streaming &&
    intake !== null &&
    ((phase === "intake" && messages.length === 0) ||
      (phase === "verdict" && after.length === 0));

  return (
    <div className="flex h-dvh flex-col">
      <header className="shrink-0 border-b border-rule bg-surface/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-5 py-3">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-sm font-semibold tracking-tight">
              Resale price assistant
            </h1>
            <p className="text-xs text-ink-muted">
              {STAGE_LABELS[phase]}
              {composing && intake ? (
                <span className="nums">
                  {" "}
                  · {Math.min(asked, FACT_COUNT)}/{FACT_COUNT} asked
                </span>
              ) : null}
            </p>
          </div>
          {intake ? (
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
          {!intake ? (
            <IntakeForm
              onSubmit={(next, chosen) => {
                setPhotos(chosen);
                setIntakePhotos(chosen);
                setIntake(next);
              }}
            />
          ) : (
            <ItemCard intake={intake} photos={intakePhotos} />
          )}

          {before.map((message, index) => (
            <Turn
              key={index}
              message={message}
              streaming={streaming}
              photoById={photoById}
            />
          ))}

          {phase === "commit" ? (
            <PriceGate pending={appraising} onSubmit={requestAppraisal} />
          ) : null}

          {appraisal && askingPrice ? (
            <>
              <Turn
                message={{
                  role: "user",
                  text: `I'd list it at ${formatUsd(askingPrice.usd)}.`,
                  at: "",
                }}
                streaming={false}
                photoById={photoById}
              />
              <MarketCard
                appraisal={appraisal}
                canContinue={phase === "appraise"}
                pending={streaming}
                onContinue={() => setPhase("verdict")}
              />
            </>
          ) : null}

          {after.map((message, index) => (
            <Turn
              key={`after-${index}`}
              message={message}
              streaming={streaming}
              photoById={photoById}
            />
          ))}

          {error ? <Notice>{ERROR_COPY[error]}</Notice> : null}
          {failure ? <Notice>{failure}</Notice> : null}
          {needsRetry ? (
            <button
              type="button"
              onClick={() => {
                if (!intake) return;
                const opener = openerFor(phase, intake);
                if (!opener) return;
                opened.current.add(phase);
                void send(opener, {
                  hidden: true,
                  photoIds:
                    phase === "intake" ? intakePhotos.map((p) => p.id) : [],
                });
              }}
              className="self-start rounded-full border border-rule-strong px-4 py-2 text-sm font-medium transition-colors hover:border-ink"
            >
              Try again
            </button>
          ) : null}

          <div ref={bottomRef} className="h-px" />
        </div>
      </div>

      {composing && intake && !needsRetry ? (
        <footer className="shrink-0 border-t border-rule bg-surface/80 backdrop-blur">
          <div className="mx-auto w-full max-w-2xl px-5 py-4">
            {attachments.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((photo, index) => (
                  <Thumb
                    key={photo.id}
                    photo={photo}
                    index={index}
                    size="size-14"
                    disabled={streaming}
                    onRemove={() =>
                      setAttachments((current) =>
                        current.filter((p) => p.id !== photo.id),
                      )
                    }
                  />
                ))}
              </div>
            ) : null}
            <div className="flex items-end gap-2 rounded-2xl border border-rule bg-surface px-3 py-2 focus-within:border-rule-strong">
              <PhotoPicker
                compact
                photos={attachments}
                onChange={setAttachments}
                max={MAX_PHOTOS - photos.length}
                disabled={streaming || phase === "intake"}
              />
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
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <p className="text-xs text-ink-muted">
                {askingPrice
                  ? "Your price is still locked in. Answer, then look up the market again."
                  : asked < FACT_COUNT
                    ? `Four questions, then you set your price — it unlocks after ${FACT_COUNT}.`
                    : "Enough asked to price. Keep going if there is more to say."}
              </p>
              {askingPrice && phase === "probe" ? (
                <button
                  type="button"
                  disabled={streaming || appraising}
                  onClick={() => void requestAppraisal(askingPrice)}
                  className="rounded-full border border-rule-strong px-3.5 py-1.5 text-xs font-medium transition-colors hover:border-ink disabled:opacity-40"
                >
                  {appraising ? "Looking up…" : "Look up the market"}
                </button>
              ) : canPrice ? (
                <button
                  type="button"
                  disabled={streaming}
                  onClick={() => setPhase("commit")}
                  className="rounded-full border border-rule-strong px-3.5 py-1.5 text-xs font-medium transition-colors hover:border-ink disabled:opacity-40"
                >
                  I’m ready to set my price
                </button>
              ) : null}
            </div>
          </div>
        </footer>
      ) : null}
    </div>
  );
}

function Turn({
  message,
  streaming,
  photoById,
}: {
  message: StreamMessage;
  streaming: boolean;
  photoById: Map<string, Photo>;
}) {
  if (message.hidden) return null;

  if (message.role === "user") {
    const shown = (message.photoIds ?? [])
      .map((id) => photoById.get(id))
      .filter((photo): photo is Photo => photo !== undefined);
    return (
      <div className="rise flex max-w-[85%] flex-col items-end gap-1.5 self-end">
        {shown.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {shown.map((photo, index) => (
              <Thumb key={photo.id} photo={photo} index={index} size="size-16" />
            ))}
          </div>
        ) : null}
        <p className="rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[15px] leading-relaxed text-bubble-ink">
          {message.text}
        </p>
      </div>
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

/** The item, echoed back so it stays visible as the thread grows. */
function ItemCard({ intake, photos }: { intake: Intake; photos: Photo[] }) {
  return (
    <section className="rise rounded-2xl border border-rule bg-sunken px-5 py-4">
      <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
        Selling
      </p>
      <p className="mt-2 text-[15px] leading-relaxed">{intake.item}</p>
      {photos.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {photos.map((photo, index) => (
            <Thumb key={photo.id} photo={photo} index={index} size="size-14" />
          ))}
        </div>
      ) : null}
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
