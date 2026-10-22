/**
 * DeepSeek, as a backup model. The client is lib/backup.ts; this says where
 * DeepSeek is and how it differs.
 *
 * DeepSeek is **prepaid**: model costs come off a topped-up balance, and at zero the
 * API answers 402. It cannot bill past what was put on the account, but it is not
 * free, which is why it is the last resort after Gemini and OpenRouter.
 *
 * Thinking is off. It is on by default for these models, which spends tokens and
 * seconds on reasoning nobody reads, and the temperature setting is ignored while it
 * is on. Its documentation lists image input for `deepseek-flash` but not the request
 * format, so images are not used.
 */
import "server-only";
import {
  BackendFailedError,
  BackendQuotaError,
  BackendRateLimitError,
  BackendUnavailableError,
  createBackend,
} from "./backup";
import { env } from "./env";

export const deepseek = createBackend({
  name: "DeepSeek",
  keyName: "DEEPSEEK_API_KEY",
  endpoint: "https://api.deepseek.com/chat/completions",
  apiKey: () => env.deepseekApiKey,
  models: () => [env.deepseekModel],
  extraBody: { thinking: { type: "disabled" } },
});

export const isConfigured = deepseek.isConfigured;
export const streamReply = deepseek.streamReply;
export const extractFacts = deepseek.extractFacts;
export const readListings = deepseek.readListings;

// The shared error classes, under the names this module has always exported.
export {
  BackendFailedError as DeepSeekFailedError,
  BackendQuotaError as DeepSeekQuotaError,
  BackendRateLimitError as DeepSeekRateLimitError,
  BackendUnavailableError as DeepSeekUnavailableError,
};
