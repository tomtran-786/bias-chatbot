// The protocol file and the study parameters are read from the same place the dev
// server reads them, so tests exercise the protocol that is actually configured.
import { existsSync } from "node:fs";
import { beforeEach } from "vitest";
import { resetModelHealth } from "../lib/model-health";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// ...but never the real API keys. Every test that touches a model or the search
// service replaces that call, and if one forgets to, the call should fail with a
// rejected key rather than quietly spend someone's free quota.
process.env.GEMINI_API_KEY = "test-key-not-real";
process.env.TAVILY_API_KEY = "tvly-test-key-not-real";

// The backup model is off unless a test turns it on with a fake key, so a real key
// in .env.local can never make a test call out.
delete process.env.DEEPSEEK_API_KEY;
delete process.env.DEEPSEEK_MODEL;

// Every test starts with every Gemini model healthy and the default chain in place,
// whatever a previous test refused or whatever is in .env.local.
delete process.env.GEMINI_FALLBACK_MODELS;
beforeEach(() => resetModelHealth());
