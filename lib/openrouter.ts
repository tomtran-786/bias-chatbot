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
 * bought fewer than 10 credits, 1,000 a day above that), share their upstream
 * providers' pools with everyone else on the free tier, and come and go; when one is
 * refused the next in `OPENROUTER_MODELS` is tried.
 *
 * Learned from the first live run, and why the default list is what it is: a model can
 * 404 for one account from its provider ("Function … not found for account"), another
 * 429s whenever its provider's shared free pool is busy, and `openrouter/free` routes
 * to whatever is free that moment, including a safety classifier that answered
 * "User Safety: safe" instead of JSON. So the defaults are named models from different
 * providers, and the router is allowed but not default.
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
  // Reasoning models spend their whole token budget thinking before they write a word,
  // which on a free model means a minute of nothing and then an empty reply (seen live).
  // Nothing here reads the reasoning. A model that cannot disable it answers 400 with
  // the reason; the models in the default list can.
  extraBody: { reasoning: { effort: "none" } },
  privacyHint:
    ". Free models can need your privacy settings at https://openrouter.ai/settings/privacy to allow the provider to see prompts",
});
