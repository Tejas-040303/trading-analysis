// P8.1 — the one Supabase client instance for the whole app.
//
// The URL and publishable key are NOT secrets: they ship in the built JS
// bundle on every deploy by design, and Postgres row-level security is what
// actually guards the data. Committing them as fallbacks keeps Vercel preview
// builds working with zero env setup; the env vars let anyone (or a future
// staging setup) point the app at a different Supabase project.
import { createClient } from "@supabase/supabase-js";

const url =
  import.meta.env.VITE_SUPABASE_URL || "https://qmgslxaladefllaazdex.supabase.co";
const key =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_dFsF0HgsU8SCuNaDejI9Bw_tTVf6P75";

export const supabase = createClient(url, key);
