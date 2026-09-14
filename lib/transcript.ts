/**
 * The conversation, as it travels between the browser and the API.
 *
 * Nothing stores it. There is no database and no session, so the browser holds
 * the whole conversation and posts it with every turn — which means a refresh
 * loses an in-progress decision, and means this type and its schema have to be
 * shared by both sides rather than living with the server code.
 */
import { z } from "zod";

export type TranscriptMessage = {
  role: "user" | "model";
  text: string;
  at: string;
};

export const transcriptSchema = z.array(
  z.object({
    role: z.enum(["user", "model"]),
    text: z.string().max(8000),
    at: z.iso.datetime(),
  }),
);

export function assistantTurns(transcript: readonly TranscriptMessage[]): number {
  return transcript.filter((message) => message.role === "model").length;
}

export function userTurns(transcript: readonly TranscriptMessage[]): number {
  return transcript.filter((message) => message.role === "user").length;
}
