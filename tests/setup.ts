// The Gemini key and the protocol file are read from the same place the dev
// server reads them, so tests exercise the protocol that is actually configured.
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
