import fs from "node:fs";
import path from "node:path";
import type { SeedResult } from "../seed";

export const ROOT = path.resolve(__dirname, "../../..");
/** Written by the global setup, read by every capture file. */
export const SEED_FILE = path.join(ROOT, "test-results", "help-screenshots-seed.json");

let cached: SeedResult | null = null;
export function seed(): SeedResult {
  cached ??= JSON.parse(fs.readFileSync(SEED_FILE, "utf8")) as SeedResult;
  return cached;
}
