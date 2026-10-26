"use client";

import { useEffect, useRef, useState } from "react";
import { IntakeForm } from "@/components/IntakeForm";
import { MarketCard } from "@/components/MarketCard";
import { PhotoPicker, Thumb } from "@/components/PhotoPicker";
import { PriceGate } from "@/components/PriceGate";
import { Prose } from "@/components/Prose";
import { SellingLenses } from "@/components/SellingLenses";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  FRAMING,
  MAX_PHOTOS,
  SITUATION,
  type AskingPrice,
  type Intake,
  type Photo,
} from "@/lib/item";
import { citeListings, conversionNote, originalPrice, safeHref } from "@/lib/citations";
import {
  MarketError,
  isAbort,
  runMarket,
  type MarketCache,
  type MarketResult,
  type MarketStep,
} from "@/lib/market-client";
import { computeAppraisal, formatUsd, type AppraiseResponse } from "@/lib/pricing";
import {
  STAGES,
  STAGE_LABELS,
  askedEnough,
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
  | "budget_exhausted"
  | "model_overloaded";

// Plain words and something to do. Which service is behind a failure, and how
// much of its allowance is left, is not the person's business: the server logs
// the cause and the reply carries only a code.
const REPLY_FAILED =
  "Couldn’t get a reply just now. Send it again in a minute — nothing you wrote is lost.";
const LIMIT_REACHED = "The assistant has reached today’s limit. Try again tomorrow.";
const TOO_LARGE = "A photo is too large to send. Remove it and attach a smaller one.";

const ERROR_COPY: Record<ChatError, string> = {
  rate_limited: REPLY_FAILED,
  model_overloaded: REPLY_FAILED,
  server_error: REPLY_FAILED,
  turn_limit: "This conversation has reached its maximum length.",
  out_of_order: "That step is not available yet.",
  payload_too_large: TOO_LARGE,
  budget_exhausted: LIMIT_REACHED,
};

const LOOKUP_FAILED = "Couldn’t look up the market right now. Try again in a minute.";

/** What a market step can refuse with, in words a person can act on. */
const APPRAISE_ERROR_COPY: Record<string, string> = {
  rate_limited: LOOKUP_FAILED,
  network: LOOKUP_FAILED,
  appraisal_failed: LOOKUP_FAILED,
  search_quota: LOOKUP_FAILED,
  search_unavailable: LOOKUP_FAILED,
  search_failed: LOOKUP_FAILED,
  budget_exhausted: LIMIT_REACHED,
  payload_too_large: TOO_LARGE,
};

const asChatError = (code: string | undefined): ChatError =>
  code && code in ERROR_COPY ? (code as ChatError) : "server_error";

/** "complete" is an end state rather than a step, so it is not on the rail. */
const RAIL = STAGES.filter((stage) => stage !== "complete");

const toTranscript = (messages: StreamMessage[]): TranscriptMessage[] =>
  messages.map(({ role, text, at, photoIds }) => ({ role, text, at, photoIds }));

/** A lookup that started while the person was still deciding on a price. */
type Prefetch = {
  /** How many messages the conversation had when it started, which is what it read. */
  turns: number;
  controller: AbortController;
  promise: Promise<MarketResult>;
};

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
  const [marketStep, setMarketStep] = useState<MarketStep | "done" | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const opened = useRef(new Set<Stage>());
  // The market lookup runs ahead of the price (see `startMarket`). Nothing it finds
  // is put in state that a screen reads until the price is locked.
  const market = useRef<MarketCache>({});
  const prefetch = useRef<Prefetch | null>(null);
  const prefetchedFor = useRef<number | null>(null);

  // Follows the thread as it grows. Not on the intake form, which is read from the
  // top: the explainer is the first thing on it, and scrolling to the bottom on load
  // would start the person at the form with the explanation above the fold.
  useEffect(() => {
    if (!intake) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [intake, messages, phase, appraisal, streaming, appraising]);

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
          // Tells the questions not to ask for a price that is already locked in,
          // without telling them what it is.
          priceLocked: !forVerdict && askingPrice !== null ? true : undefined,
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
            | { t: "notice"; v: "backup_model"; provider: string }
            | { t: "error"; code: "rate_limited" | "model_overloaded" | "server_error" };

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
          } else if (event.t === "notice") {
            // Which model answered is a system detail, not part of the story.
            continue;
          } else {
            failed = true;
            setError(event.code);
          }
        }
      }

      // A reply cut off half way is withdrawn together with the message it answered,
      // and the message goes back into the box. Keeping either would leave the
      // transcript with a question the assistant answers twice, or with a reply that
      // answers nothing, and the assistant would ask again what it was already told.
      if (!generated || failed) {
        rollBack();
        return;
      }

      // Applied only once the turn has landed, so the phase never changes
      // underneath a reply that is still being written.
      if (phase === "intake") setPhase("probe");
      if (phase === "verdict") setPhase("complete");
      for (const stage of stages) {
        // The server drops a commit marker that arrives with nothing to follow;
        // checking again here means a stale or tampered stream cannot skip the
        // questions either. The assistant decides when it has the facts, so this can
        // come at the first reply. With a price already locked, the lookup button
        // takes over.
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

  /**
   * Starts reading the conversation, searching and reading listings, so the market is
   * ready when the price is. Starts over when the conversation has moved on; what
   * the new reading shares with the old one (the search, if the item is the same) is
   * kept in `market`, so a second start costs a model call and not the whole lookup.
   */
  function startMarket() {
    if (!intake) return;
    const transcript = toTranscript(messages);
    prefetch.current?.controller.abort();

    const controller = new AbortController();
    const promise = runMarket({ intake, photos, transcript }, market.current, {
      signal: controller.signal,
      onStep: setMarketStep,
    });
    const started: Prefetch = { turns: transcript.length, controller, promise };
    prefetch.current = started;

    promise.catch((thrown) => {
      if (isAbort(thrown) || prefetch.current !== started) return;
      if (thrown instanceof MarketError && thrown.code === "needs_identity") {
        backToQuestions(null);
        return;
      }
      // Not shown: the person has not asked for the market yet. Locking the price
      // runs whatever is missing, and that is the attempt that reports an error.
      console.warn("market lookup ahead of the price failed:", thrown);
    });
  }

  /** The conversation never pinned the item down: back to the questions, price (if any) kept. */
  function backToQuestions(locked: AskingPrice | null) {
    if (locked) setAskingPrice(locked);
    setPhase("probe");
    setMarketStep(null);
    setFailure(
      locked
        ? "The assistant couldn’t tell which model this is. Add the model name, a label or a screenshot of the settings, then look up the market again. Your price stays locked in."
        : "The assistant couldn’t tell which model this is. Add the model name, a label or a screenshot of the settings, and answer its next question.",
    );
  }

  async function requestAppraisal(asking: AskingPrice) {
    if (!intake) return;
    setAppraising(true);
    setFailure(null);
    const transcript = toTranscript(messages);
    try {
      // Joins the lookup that is already running when it read this conversation;
      // otherwise runs what is missing. Either way the figures are worked out here,
      // from the listings, now that there is a price to set them against.
      const ahead = prefetch.current;
      const joined =
        ahead && ahead.turns === transcript.length
          ? await ahead.promise.catch(() => null)
          : null;
      if (!joined) ahead?.controller.abort();
      const result =
        joined ??
        (await runMarket({ intake, photos, transcript }, market.current, {
          onStep: setMarketStep,
        }));

      const response: AppraiseResponse = {
        ...computeAppraisal(result.raw, asking.usd),
        item: result.item,
        raw: result.raw,
        queries: result.queries,
        backup: result.backup,
      };
      setAskingPrice(asking);
      setAppraisal(response);
      setAppraisedAt(messages.length);
      setPhase("appraise");
    } catch (thrown) {
      const code = thrown instanceof MarketError ? thrown.code : undefined;
      if (code === "needs_identity") {
        // The price stays locked: nothing about the market has been seen, so
        // the baseline is intact. The questions pick up where they left off.
        backToQuestions(asking);
      } else {
        // The server's reason is for whoever is running this, not for the
        // person using it: it goes to the console and the screen gets plain copy.
        if (thrown instanceof MarketError && thrown.reason) {
          console.warn(`market lookup failed (${thrown.code}):`, thrown.reason);
        }
        setFailure((code && APPRAISE_ERROR_COPY[code]) || LOOKUP_FAILED);
      }
    } finally {
      setAppraising(false);
      setMarketStep(null);
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
  // The button for the person to say they are done, in case the assistant has not.
  // The assistant saying it is done (the commit marker) needs no count at all.
  const canPrice =
    phase === "probe" &&
    !askingPrice &&
    askedEnough({
      assistantTurns: asked,
      photoCount: photoCount(toTranscript(messages)),
      hasAskingPrice: false,
      hasAppraisal: false,
    });
  const wantsMarket =
    intake !== null &&
    !askingPrice &&
    !streaming &&
    (phase === "commit" || canPrice);

  // Looks up the market as soon as the questions are done, and again when the
  // person adds something to them after.
  useEffect(() => {
    if (!wantsMarket || prefetchedFor.current === messages.length) return;
    prefetchedFor.current = messages.length;
    startMarket();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsMarket, messages.length]);
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
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-sm font-semibold tracking-tight">
              VIBE <span className="font-normal text-ink-muted">· Resale price assistant</span>
            </h1>
            <div className="flex items-center gap-3">
              <p className="text-xs text-ink-muted">{STAGE_LABELS[phase]}</p>
              <ThemeToggle />
            </div>
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
            <>
              <SituationCard intake={intake} photos={intakePhotos} />
              <Framing />
            </>
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
            <PriceGate
              pending={appraising}
              step={marketStep}
              onSubmit={requestAppraisal}
            />
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

          {phase === "complete" && appraisal ? <VerdictSources appraisal={appraisal} /> : null}

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
                  : canPrice
                    ? "Enough asked to price. Keep going if there is more to say."
                    : "A few questions, then you set your price."}
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

/** The situation, stated from the item, and kept visible as the thread grows. */
function SituationCard({ intake, photos }: { intake: Intake; photos: Photo[] }) {
  return (
    <section className="rise rounded-2xl border border-rule bg-sunken px-5 py-4">
      <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
        {SITUATION.eyebrow}
      </p>
      <p className="mt-2 text-[15px] leading-relaxed">{SITUATION.line(intake.item)}</p>
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

/**
 * The app's opening turn: two ways to see the price before any question. It is not
 * a message in the thread, so the transcript the server counts is unchanged; the
 * model is told in its phase instruction that the person has already read this.
 */
function Framing() {
  return (
    <div className="rise flex max-w-[92%] flex-col gap-3 text-[15px] leading-relaxed">
      <p>{FRAMING.intro}</p>
      <SellingLenses />
      <p>{FRAMING.outro}</p>
    </div>
  );
}

/**
 * Where the verdict's prices came from, under the verdict. Drawn by the app from
 * the same numbered listings the market card shows, so `[3]` here is `[3]` there;
 * the model never writes it, and the protocol is untouched.
 */
function VerdictSources({ appraisal }: { appraisal: AppraiseResponse }) {
  const { counted } = citeListings(appraisal);
  const newHref = appraisal.newPrice === null ? null : safeHref(appraisal.newPriceUrl);
  if (counted.length === 0 && !newHref) return null;

  const chip =
    "inline-flex items-baseline gap-1.5 rounded-full border border-rule px-2.5 py-1 text-xs text-ink-secondary";
  const link = `${chip} transition-colors hover:border-ink hover:text-ink focus-visible:border-ink focus-visible:text-ink focus-visible:outline-none`;

  return (
    <section className="rise flex flex-col gap-2" aria-label="Sources">
      <h3 className="text-xs font-medium text-ink-muted">Sources</h3>
      <ul className="flex flex-wrap gap-1.5">
        {counted.map(({ n, listing, href }) => {
          const body = (
            <>
              <span className="nums text-ink-muted">[{n}]</span>
              {listing.platform}
              <span className="nums font-medium text-ink">
                {originalPrice(listing) ? "≈ " : ""}
                {formatUsd(listing.price)}
              </span>
              {href ? <span aria-hidden>↗</span> : null}
            </>
          );
          return (
            <li key={n}>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" className={link}>
                  {body}
                </a>
              ) : (
                <span className={chip}>{body}</span>
              )}
            </li>
          );
        })}
        {newHref ? (
          <li>
            <a href={newHref} target="_blank" rel="noopener noreferrer" className={link}>
              New price
              <span className="nums font-medium text-ink">
                {formatUsd(appraisal.newPrice!)}
              </span>
              <span aria-hidden>↗</span>
            </a>
          </li>
        ) : null}
      </ul>
      {conversionNote(appraisal) ? (
        <p className="text-xs text-ink-muted">{conversionNote(appraisal)}</p>
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
