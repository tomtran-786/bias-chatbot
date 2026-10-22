/**
 * Server-only environment access.
 *
 * Every value here is a secret or a study parameter that must never reach the
 * client bundle. Importing this file from a client component is a build error
 * by way of `server-only`.
 */
import "server-only";

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
   * In-memory daily ceilings on outbound calls (see lib/budget.ts). A tripwire
   * against a loop or a runaway client, not the real spending guard: the counter
   * resets when the process restarts. The real guard is the account tier — a
   * Gemini project with no billing and a Tavily plan with pay-as-you-go off — so
   * that running out of quota ends in an error rather than a charge.
   */
  get dailySearchBudget() {
    return positiveInt("DAILY_SEARCH_BUDGET", 40);
  },
  get dailyModelBudget() {
    return positiveInt("DAILY_MODEL_BUDGET", 300);
  },
} as const;
