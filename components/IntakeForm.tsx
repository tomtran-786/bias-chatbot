"use client";

import { useState } from "react";
import { LossAversionIntro } from "@/components/LossAversionIntro";
import { PhotoPicker } from "@/components/PhotoPicker";
import {
  INTAKE_FIELD,
  INTAKE_MAX_PHOTOS,
  PHOTO_FIELD,
  type Intake,
  type Photo,
} from "@/lib/item";

const field =
  "w-full rounded-xl border border-rule bg-surface px-3.5 py-2.5 text-[15px] outline-none transition-colors placeholder:text-ink-muted focus:border-rule-strong";

/**
 * The intake, as the first card in the thread rather than a screen before it.
 *
 * A form rather than a conversation, because it is the one place the app can
 * guarantee the assistant starts with the same two things every time: what the
 * item is called, and what it looks like. A Gem can only ask for these in prose
 * and hope the person attaches a photo.
 */
export function IntakeForm({
  onSubmit,
}: {
  onSubmit: (intake: Intake, photos: Photo[]) => void;
}) {
  const [item, setItem] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);

  const complete = item.trim().length > 0 && photos.length > 0;

  return (
    <section className="rise flex flex-col gap-7 rounded-2xl border border-rule bg-surface px-5 py-6 sm:px-6">
      <LossAversionIntro />

      <hr className="border-rule" />

      <header className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold tracking-tight">
          Price something you are about to sell
        </h2>
        <p className="text-sm leading-relaxed text-ink-secondary">
          Start with the item and a photo, then a few short questions. After you
          name your price you get used listings of the same model, a suggested
          price, and where to sell.
        </p>
      </header>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{INTAKE_FIELD.label}</span>
        <span className="text-xs leading-relaxed text-ink-muted">{INTAKE_FIELD.hint}</span>
        <input
          type="text"
          value={item}
          onChange={(event) => setItem(event.target.value)}
          placeholder={INTAKE_FIELD.placeholder}
          maxLength={300}
          className={`${field} mt-1`}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{PHOTO_FIELD.label}</span>
        <span className="text-xs leading-relaxed text-ink-muted">{PHOTO_FIELD.hint}</span>
        <div className="mt-1">
          <PhotoPicker photos={photos} onChange={setPhotos} max={INTAKE_MAX_PHOTOS} />
        </div>
        <p className="text-xs leading-relaxed text-ink-muted">
          Photos are resized and re-saved in your browser first, which also removes
          their location data. Your messages and photos are processed by
          third-party AI services, which may use them to improve their products.
          Leave out faces, addresses and documents. This app stores nothing after
          you close the page.
        </p>
      </div>

      <button
        type="button"
        disabled={!complete}
        onClick={() => complete && onSubmit({ item: item.trim() }, photos)}
        className="self-start rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-plane transition-opacity hover:opacity-90 disabled:opacity-30"
      >
        Start
      </button>
    </section>
  );
}
