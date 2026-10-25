/**
 * Which Gemini models answer on this key right now?
 *
 * Free-tier quota is per model, and the set of models a key can use changes (2.5
 * already 404s for new keys; some models answer 429 because they have no free
 * quota, or hang under load). This asks every text model the key can see for one
 * word, in parallel, and prints how each did, so GEMINI_MODEL and
 * GEMINI_FALLBACK_MODELS can be chosen from what works instead of from memory.
 *
 * Each model is asked with the same thinking setting the app uses (a low thinking
 * level, lib/gemini.ts), and asked again without it if that is what it refused, so
 * the output says which models take it and which the app will drop it for.
 *
 * Run: npm run models        (reads .env.local; about a dozen tiny free calls)
 */
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY is not set. Fill it in .env.local, then run `npm run models`.");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: key });
const WAIT_MS = 25_000;

const names: string[] = [];
for await (const model of await ai.models.list({ config: { pageSize: 100 } })) {
  const name = (model.name ?? "").replace("models/", "");
  const canGenerate = (model.supportedActions ?? []).includes("generateContent");
  // Text models only: the image, speech, live and embedding variants are different products.
  if (canGenerate && /^gemini-/.test(name) && !/image|tts|live|audio|embedding|robotics|computer|transcribe|customtools/.test(name)) {
    names.push(name);
  }
}

async function ask(model: string, thinking: boolean) {
  await Promise.race([
    ai.models.generateContent({
      model,
      contents: "Reply with: ok",
      ...(thinking ? { config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } } : {}),
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${WAIT_MS / 1000}s`)), WAIT_MS)),
  ]);
}

async function tryModel(model: string): Promise<{ ok: boolean; note: string }> {
  const started = Date.now();
  const took = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  try {
    await ask(model, true);
    return { ok: true, note: `answers in ${took()}, takes thinkingLevel LOW` };
  } catch (error) {
    let note = error instanceof Error ? error.message : String(error);
    try {
      const detail = JSON.parse(note).error;
      note = `${detail.code} ${detail.status}${/thinking/i.test(detail.message ?? "") ? " (thinking)" : ""}`;
    } catch {
      // not a JSON error body: keep the message
    }
    if (/^400.*\(thinking\)/.test(note)) {
      // The one refusal the app works around: it asks again without the setting.
      try {
        await ask(model, false);
        return { ok: true, note: `answers in ${took()}, REJECTS thinkingLevel (the app drops it for this model)` };
      } catch {
        // falls through to the failure below
      }
    }
    return { ok: false, note: note.slice(0, 60) };
  }
}

const results = await Promise.all(names.map(async (name) => ({ name, ...(await tryModel(name)) })));

console.log(`Gemini models visible to this key: ${names.length}\n`);
for (const { name, ok, note } of results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.name.localeCompare(b.name))) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(34)} ${note}`);
}

const working = results.filter((r) => r.ok).map((r) => r.name);
console.log(
  working.length
    ? `\nAnswering now: ${working.join(", ")}\nA 429 here means no free quota left (or none at all) for that model; a 404 means the key cannot use it; no answer usually means it is overloaded.\nThis is one moment in time: quotas reset and load changes.`
    : "\nNothing answered. Check the key, or that its free quota is not spent for every model.",
);
