/**
 * Browser-side photo preparation. Import from client components only.
 *
 * Every photo is re-encoded through a canvas, whatever it was to begin with.
 * That one step does three jobs: it shrinks a 6 MB phone photo to something that
 * can travel with every turn of a stateless conversation, it normalises the
 * format to JPEG, and — because a canvas carries pixels and nothing else — it
 * strips the EXIF block, which on a phone photo includes where it was taken.
 */
import {
  MAX_PHOTO_BYTES,
  type Photo,
} from "./item";

/** Long edge in pixels. Enough to read a model number and see a scratch. */
const MAX_EDGE = 1024;
const QUALITIES = [0.75, 0.6, 0.45];

export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoError";
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new PhotoError("The photo could not be encoded."))),
      "image/jpeg",
      quality,
    );
  });
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new PhotoError("The photo could not be read."));
    reader.readAsDataURL(blob);
  });
}

function randomId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Turns a picked file into a `Photo` the API will accept.
 *
 * Throws `PhotoError` with a message fit to show the person. The usual cause is
 * a format the browser cannot decode — HEIC from an iPhone set to "High
 * Efficiency" — which `createImageBitmap` rejects; saying so is kinder than a
 * silent failure.
 */
export async function encodePhoto(file: File): Promise<Photo> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PhotoError(
      `"${file.name}" could not be read. If it is a HEIC photo, export it as JPEG first.`,
    );
  }

  try {
    let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));

    // Shrink further only if the lowest quality at this size is still too big.
    for (let attempt = 0; attempt < 4; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new PhotoError("This browser cannot process photos.");

      // JPEG has no alpha; without this a transparent PNG turns black.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      for (const quality of QUALITIES) {
        const blob = await toBlob(canvas, quality);
        if (blob.size <= MAX_PHOTO_BYTES) {
          return { id: randomId(), mime: "image/jpeg", data: await toBase64(blob) };
        }
      }
      scale *= 0.75;
    }
    throw new PhotoError(`"${file.name}" is too large to send even after shrinking it.`);
  } finally {
    bitmap.close();
  }
}

/** A `src` for showing a photo we hold as base64. */
export function photoSrc(photo: Photo): string {
  return `data:${photo.mime};base64,${photo.data}`;
}
