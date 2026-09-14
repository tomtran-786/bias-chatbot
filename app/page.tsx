"use client";

import { useState } from "react";
import { ChatView } from "@/components/ChatView";
import { CommitmentGate } from "@/components/CommitmentGate";
import { FrameForm } from "@/components/FrameForm";
import { Scorecard, type Grade } from "@/components/Scorecard";
import type { Commitment, Frame } from "@/lib/decision";
import { DIMENSION_COUNT } from "@/lib/rubric";
import { STAGES, STAGE_LABELS, type Stage } from "@/lib/stages";
import { assistantTurns, type TranscriptMessage } from "@/lib/transcript";

/** "complete" is an end state rather than a step, so it is not on the rail. */
const RAIL = STAGES.filter((stage) => stage !== "complete");

export default function Home() {
  const [phase, setPhase] = useState<Stage>("frame");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [commitment, setCommitment] = useState<Commitment | null>(null);
  const [grade, setGrade] = useState<Grade | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * The assistant signals two transitions itself: that it has probed enough,
   * and that the recommendation is delivered. Everything else is driven here.
   */
  function handleStage(next: Stage) {
    if (next === "commit" && phase === "probe") setPhase("commit");
    if (next === "complete" && phase === "recommend") setPhase("complete");
  }

  /** The opening turn is the frame phase; after it lands, questions begin. */
  function handleTurnComplete() {
    if (phase === "frame") setPhase("probe");
  }

  async function requestGrade(recorded: Commitment) {
    if (!frame) return;
    setPending(true);
    setFailure(null);
    setCommitment(recorded);
    try {
      const response = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame, commitment: recorded, transcript }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setCommitment(null);
        setFailure(
          response.status === 429
            ? "The AI service has hit its request limit. Wait a minute and try again."
            : ((body as { reason?: string } | null)?.reason ??
              "The grade could not be produced. Try again."),
        );
        return;
      }
      setGrade(body as Grade);
      setPhase("grade");
    } catch {
      setCommitment(null);
      setFailure("The grade could not be produced. Try again.");
    } finally {
      setPending(false);
    }
  }

  const conversational =
    frame !== null && (phase === "frame" || phase === "probe" || phase === "recommend" || phase === "complete");

  // The assistant usually signals that it has asked enough. This is the manual
  // way through when it keeps going: the gate is the question count, not the
  // marker, so letting the person move on cannot skip past the real guard.
  const canForceCommit =
    phase === "probe" && assistantTurns(transcript) >= DIMENSION_COUNT;

  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col px-5 py-8">
      {frame ? (
        <ol className="mb-4 flex shrink-0 gap-2 text-xs" aria-label="Progress">
          {RAIL.map((step) => {
            const reached = STAGES.indexOf(phase) >= STAGES.indexOf(step);
            return (
              <li
                key={step}
                aria-current={phase === step ? "step" : undefined}
                className={`flex-1 border-t-2 pt-2 ${
                  reached
                    ? "border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
                    : "border-neutral-200 text-neutral-400 dark:border-neutral-800"
                }`}
              >
                {STAGE_LABELS[step]}
              </li>
            );
          })}
        </ol>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col justify-center">
        {!frame ? <FrameForm onSubmit={setFrame} /> : null}

        {conversational && frame ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <ChatView
              phase={phase}
              frame={frame}
              commitment={commitment ?? undefined}
              grade={grade?.dimensions}
              transcript={transcript}
              setTranscript={setTranscript}
              onStage={handleStage}
              onReady={handleTurnComplete}
            />
            {canForceCommit ? (
              <button
                type="button"
                onClick={() => setPhase("commit")}
                className="mt-3 shrink-0 self-start text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-900 dark:hover:text-neutral-100"
              >
                I&apos;ve said enough — take me to the grade
              </button>
            ) : null}
          </div>
        ) : null}

        {phase === "commit" && frame ? (
          <div className="overflow-y-auto py-4">
            <CommitmentGate
              frame={frame}
              pending={pending}
              onSubmit={requestGrade}
            />
          </div>
        ) : null}

        {phase === "grade" && grade && commitment ? (
          <div className="overflow-y-auto py-4">
            <Scorecard
              grade={grade}
              commitment={commitment}
              pending={pending}
              onContinue={() => setPhase("recommend")}
            />
          </div>
        ) : null}

        {failure ? (
          <p
            role="alert"
            className="mx-auto mt-4 w-full max-w-xl text-sm text-red-700 dark:text-red-400"
          >
            {failure}
          </p>
        ) : null}
      </div>
    </main>
  );
}
