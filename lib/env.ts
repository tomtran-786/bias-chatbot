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
} as const;
