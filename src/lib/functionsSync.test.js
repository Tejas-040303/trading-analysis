import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The ingest edge function bundles verbatim copies of the pure strategy
// modules (Deno can't import from src/ at deploy time). This test pins the
// copies to the sources — if it fails, run `npm run sync:functions`.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("edge-function copies stay in sync with src/lib", () => {
  for (const f of ["sweeps.js", "sweepSignal.js"]) {
    it(`${f} is identical in supabase/functions/ingest/`, () => {
      const src = readFileSync(join(root, "src/lib", f), "utf8");
      const copy = readFileSync(join(root, "supabase/functions/ingest", f), "utf8");
      expect(copy).toBe(src);
    });
  }
});
