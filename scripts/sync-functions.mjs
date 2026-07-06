// P8.4 — copy the pure strategy modules from src/lib into the ingest edge
// function's folder so Deno bundles them. Run via `npm run sync:functions`
// after editing either module; functionsSync.test.js fails the suite if the
// copies drift from the sources.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = ["sweeps.js", "sweepSignal.js"];

mkdirSync(join(root, "supabase/functions/ingest"), { recursive: true });
for (const f of SHARED) {
  copyFileSync(join(root, "src/lib", f), join(root, "supabase/functions/ingest", f));
  console.log(`synced ${f} -> supabase/functions/ingest/`);
}
