/**
 * OpenRouter, as a backup model. The client is lib/backup.ts; this says where
 * OpenRouter is and, above all, how it is kept free.
 *
 * **Only free models are ever called.** OpenRouter bills per token for every model
 * except the ones whose id ends in `:free` (and its `openrouter/free` router, which
 * only picks among those). A key with credits on it would be charged for a paid model
 * named by mistake, so the allowlist is enforced here, in code, before any request is
 * built: a configured model that is not free is dropped with a warning and never
 * sent. If that leaves nothing, OpenRouter reports itself as not configured.
 *
 * Free models are capped (20 requests a minute, 50 a day on an account that has
 * bought fewer than 10 credits, 1,000 a day above that) and the list changes; when one
 * is refused the next in `OPENROUTER_MODELS` is tried.
 *
 * Text only, like every backup: no photo is ever sent.
 */
import "server-only";
import { createBackend } from "./backup";
import { env } from "./env";

/** `:free` models, and the router that chooses among them. Nothing else costs nothing. */
export function isFreeModel(model: string): boolean {
  return model.endsWith(":free") || model === "openrouter/free";
}

const warned = new Set<string>();

/** The configured models that are free, in order. The rest are dropped, loudly, once. */
export function allowedModels(configured: readonly string[]): string[] {
  return configured.filter((model) => {
    if (isFreeModel(model)) return true;
    if (!warned.has(model)) {
      warned.add(model);
      console.warn(
        `OpenRouter model "${model}" is not a free model (no ":free" suffix), so it will never be called.`,
      );
    }
    return false;
  });
}

export const openrouter = createBackend({
  name: "OpenRouter",
  keyName: "OPENROUTER_API_KEY",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  apiKey: () => env.openrouterApiKey,
  models: () => allowedModels(env.openrouterModels),
  notFoundHint:
    ". Free models can be removed, and may need your privacy settings at https://openrouter.ai/settings/privacy to allow the provider to see prompts",
});
