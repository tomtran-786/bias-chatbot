/**
 * The conversation, as it travels between the browser and the API.
 *
 * Nothing stores it. There is no database and no session, so the browser holds
 * the whole conversation and posts it with every turn — which means a refresh
 * loses an in-progress appraisal, and means this type and its schema have to be
 * shared by both sides rather than living with the server code.
 *
 * Photos are not in here. They are large and a message may only need to point at
 * one, so a message carries `photoIds` and the photos travel once, alongside.
 */
import { z } from "zod";
import { MAX_PHOTOS } from "./item";

export type TranscriptMessage = {
  role: "user" | "model";
  text: string;
  at: string;
  /** Photos that first appear in this message. Only user messages carry them. */
  photoIds?: string[];
};

export const transcriptSchema = z.array(
  z.object({
    role: z.enum(["user", "model"]),
    text: z.string().max(8000),
    at: z.iso.datetime(),
    photoIds: z.array(z.string().min(1).max(64)).max(MAX_PHOTOS).optional(),
  }),
);

export function assistantTurns(transcript: readonly TranscriptMessage[]): number {
  return transcript.filter((message) => message.role === "model").length;
}

export function userTurns(transcript: readonly TranscriptMessage[]): number {
  return transcript.filter((message) => message.role === "user").length;
}

/** Distinct photos the conversation refers to. */
export function referencedPhotoIds(
  transcript: readonly TranscriptMessage[],
): string[] {
  return [...new Set(transcript.flatMap((message) => message.photoIds ?? []))];
}

/** How many photos the conversation has shown the assistant. */
export function photoCount(transcript: readonly TranscriptMessage[]): number {
  return referencedPhotoIds(transcript).length;
}
