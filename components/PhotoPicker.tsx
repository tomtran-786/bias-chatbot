"use client";

import { useRef, useState } from "react";
import type { Photo } from "@/lib/item";
import { PhotoError, encodePhoto, photoSrc } from "@/lib/photo-client";

/**
 * The photo control the intake form and the composer share: choose, encode,
 * preview, remove.
 *
 * Controlled. `max` is how many may be held in total, so the same component
 * serves the four of the intake form and whatever is left of the six for
 * follow-ups.
 */
export function PhotoPicker({
  photos,
  onChange,
  max,
  disabled,
  compact,
}: {
  photos: Photo[];
  onChange: (photos: Photo[]) => void;
  max: number;
  disabled?: boolean;
  /** An icon button instead of a drop area, for the composer. */
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);

    const room = max - photos.length;
    const chosen = Array.from(files).slice(0, Math.max(room, 0));
    const added: Photo[] = [];
    const problems: string[] = [];

    for (const file of chosen) {
      try {
        added.push(await encodePhoto(file));
      } catch (caught) {
        problems.push(
          caught instanceof PhotoError ? caught.message : `"${file.name}" could not be added.`,
        );
      }
    }
    if (files.length > chosen.length) {
      problems.push(`Only ${max} photo${max === 1 ? "" : "s"} fit here.`);
    }

    if (added.length) onChange([...photos, ...added]);
    setError(problems.length ? problems.join(" ") : null);
    setBusy(false);
    if (input.current) input.current.value = "";
  }

  const full = photos.length >= max;

  const trigger = (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="photo-input"
        onChange={(event) => void add(event.target.files)}
      />
      {compact ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={disabled || busy || full}
          aria-label={full ? "Photo limit reached" : "Attach a photo"}
          title={full ? "Photo limit reached" : "Attach a photo"}
          className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-sunken text-ink-secondary transition-colors hover:text-ink disabled:opacity-30"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="5" width="18" height="14" rx="2.5" />
            <circle cx="9" cy="11" r="1.8" />
            <path d="m21 16-5-5-8 8" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={disabled || busy || full}
          className="flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-rule-strong bg-sunken text-xs text-ink-muted transition-colors hover:border-action hover:text-action disabled:opacity-40"
        >
          <span aria-hidden className="text-lg leading-none">+</span>
          {busy ? "Adding…" : full ? "Full" : "Add photo"}
        </button>
      )}
    </>
  );

  return (
    <div className={compact ? "contents" : "flex flex-col gap-2"}>
      {compact ? null : (
        <div className="flex flex-wrap gap-2">
          {photos.map((photo, index) => (
            <Thumb key={photo.id} photo={photo} index={index} onRemove={() => onChange(photos.filter((p) => p.id !== photo.id))} disabled={disabled} />
          ))}
          {trigger}
        </div>
      )}
      {compact ? trigger : null}
      {error ? (
        <p role="alert" className="text-xs leading-relaxed text-ink-secondary">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Thumb({
  photo,
  index,
  onRemove,
  disabled,
  size = "size-24",
}: {
  photo: Photo;
  index: number;
  onRemove?: () => void;
  disabled?: boolean;
  size?: string;
}) {
  return (
    <div className={`relative ${size} shrink-0 overflow-hidden rounded-2xl bg-sunken shadow-soft`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a local data: URL; next/image cannot optimise it */}
      <img src={photoSrc(photo)} alt={`Photo ${index + 1}`} className="size-full object-cover" />
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove photo ${index + 1}`}
          className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-ink/80 text-plane text-xs leading-none transition-opacity hover:bg-ink disabled:opacity-40"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
