/**
 * Loads the protocol document that grounds every model turn.
 *
 * Read once at module load: the document is fixed for the lifetime of a
 * deployment, so a malformed one should fail the process at startup rather than
 * surface as a broken conversation half way through someone's sale.
 */
import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env";

const protocolFile = env.protocolFile;

/** e.g. "protocol_v2.md" -> "v2" */
function versionFromFilename(filename: string): string {
  const match = filename.match(/_(v[\d.]+)\.md$/);
  if (!match) {
    throw new Error(
      `Protocol file "${filename}" must be named like "protocol_v2.md" so its version is visible.`,
    );
  }
  return match[1];
}

export const PROTOCOL_VERSION = versionFromFilename(protocolFile);

export const PROTOCOL_TEXT = readFileSync(
  join(process.cwd(), "protocols", protocolFile),
  "utf8",
);

const CORE_START = "<!-- GEM CORE START -->";
const CORE_END = "<!-- GEM CORE END -->";

/**
 * The span of the protocol that is pasted verbatim into the Gemini Gem.
 *
 * This, and not the whole file, is what the app sends as its system
 * instruction — everything outside the markers is repo scaffolding. Sending the
 * same span the Gem gets is the entire basis for claiming the two are the same
 * instrument, so it is extracted rather than approximated.
 */
export const GEM_CORE = (() => {
  const start = PROTOCOL_TEXT.indexOf(CORE_START);
  const end = PROTOCOL_TEXT.indexOf(CORE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Protocol "${protocolFile}" must delimit its Gem-portable core with ${CORE_START} and ${CORE_END}.`,
    );
  }
  return PROTOCOL_TEXT.slice(start + CORE_START.length, end).trim();
})();
