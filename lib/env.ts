/**
 * Server-only environment access.
 *
 * Every value here is a secret or a study parameter that must never reach the
 * client bundle. Importing this file from a client component is a build error
 * by way of `server-only`.
 */
import "server-only";
import { DEFAULT_VND_PER_USD } from "./currency";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/** A malformed number falls back to the default rather than becoming NaN, which would disable the limit. */
function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** A malformed or non-positive number falls back to the default. */
function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Free-tier Gemini models that answered on a free key when this was written. Names
 * move: gemini-2.5-* already 404s for new keys. Override with GEMINI_FALLBACK_MODELS.
 */
const DEFAULT_FALLBACK_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];

/**
 * Free OpenRouter models, from four different upstream providers so that one provider's
 * busy pool does not take the whole list down, in the order they proved reliable on the
 * first live run. Free models are flaky: at any moment roughly half the calls were
 * refused upstream (429 from a shared pool, 502 "failed to generate completions"). All
 * four returned valid JSON with reasoning off; the first read listings and streamed
 * best. A refused attempt is not counted against the 50-a-day cap (only answers are),
 * so a longer list costs a little latency and no quota.
 *
 * Not in the list on purpose:
 *   - openrouter/free: a router over every free model, which once picked a safety
 *     classifier that answered "User Safety: safe". Allowed if you add it.
 *   - nvidia/nemotron-3-super-120b-a12b: its provider answered 404 for the account.
 * The free list changes; override with OPENROUTER_MODELS.
 */
const DEFAULT_OPENROUTER_MODELS = [
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "xingchen-agi/xing4.0-29b-a4b:free",
  "google/gemma-4-31b-it:free",
];

export const env = {
  get geminiApiKey() {
    return required("GEMINI_API_KEY");
  },
  /**
   * Pinned deliberately, and a single knob rather than a code change: free-tier
   * quotas differ enormously between models, and Google has closed models to
   * new keys mid-year before (gemini-2.5-flash now 404s for new users).
   */
  get model() {
    return process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
  },
  /**
   * Other Gemini models to try, in order, when the one above is out of quota (429),
   * overloaded (503) or not available to this key (404). Free-tier quota is counted
   * per model, so the next model on the same key usually still has some.
   *
   * Unset means the default list. Set but empty (`GEMINI_FALLBACK_MODELS=`) means no
   * chain at all. Names that do not exist for the key are skipped with a warning, so
   * a stale entry costs one failed call, not an outage.
   */
  get geminiFallbackModels(): string[] {
    const raw = process.env.GEMINI_FALLBACK_MODELS;
    const list = raw === undefined ? DEFAULT_FALLBACK_MODELS : raw.split(",");
    const seen = new Set<string>([this.model]);
    return list
      .map((name) => name.trim())
      .filter((name) => name !== "" && !seen.has(name) && seen.add(name));
  },
  /** The whole chain, in the order it is tried: the pinned model, then the others. */
  get geminiModels(): string[] {
    return [this.model, ...this.geminiFallbackModels];
  },
  /** Which protocol document to load. Bump this, don't edit a live protocol. */
  get protocolFile() {
    return process.env.PROTOCOL_FILE ?? "protocol_v2.md";
  },
  /**
   * Hard cap on turns per appraisal. Guards the quota against one runaway
   * conversation draining the day's budget. Four questions and a verdict is the
   * intended length, so this leaves plenty of room for follow-ups.
   */
  get maxTurns() {
    return Number(process.env.MAX_TURNS ?? 20);
  },
  /**
   * Read lazily and only when an appraisal runs, so the conversation still works
   * with no search key at all and the failure names the one thing that is
   * missing instead of taking the whole app down at startup.
   */
  get tavilyApiKey() {
    return required("TAVILY_API_KEY");
  },
  /**
   * The backup model, used only when Gemini's quota is out. Optional: with no key
   * the app simply has no backup and a Gemini quota error is reported as is.
   * DeepSeek is prepaid, so unlike a metered plan it cannot bill past the balance
   * that was put on the account.
   */
  get deepseekApiKey(): string | undefined {
    const key = process.env.DEEPSEEK_API_KEY?.trim();
    return key ? key : undefined;
  },
  get deepseekModel() {
    return process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
  },
  /**
   * OpenRouter, the free backup tried before DeepSeek. Optional: no key means it is
   * skipped. Only models that are free are ever called (lib/openrouter.ts enforces
   * it), whatever this list says.
   */
  get openrouterApiKey(): string | undefined {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    return key ? key : undefined;
  },
  /** Free models, tried in order. Unset is the default list; set-but-empty is none. */
  get openrouterModels(): string[] {
    const raw = process.env.OPENROUTER_MODELS;
    const list = raw === undefined ? DEFAULT_OPENROUTER_MODELS : raw.split(",");
    const seen = new Set<string>();
    return list.map((name) => name.trim()).filter((name) => name !== "" && !seen.has(name) && seen.add(name));
  },
  /**
   * In-memory daily ceilings on outbound calls (see lib/budget.ts). A tripwire
   * against a loop or a runaway client, not the real spending guard: the counter
   * resets when the process restarts. The real guard is the account tier — a
   * Gemini project with no billing and a Tavily plan with pay-as-you-go off — so
   * that running out of quota ends in an error rather than a charge.
   */
  get dailySearchBudget() {
    return positiveInt("DAILY_SEARCH_BUDGET", 80);
  },
  get dailyModelBudget() {
    return positiveInt("DAILY_MODEL_BUDGET", 300);
  },
  /**
   * Đồng per US dollar, for listings priced in đồng. A fixed number on purpose: a
   * live rate is one more service that can fail or start charging, and listings
   * are a rough guide whose own spread is far wider than a few percent of drift.
   */
  get vndPerUsd() {
    return positiveNumber("VND_PER_USD", DEFAULT_VND_PER_USD);
  },
} as const;
