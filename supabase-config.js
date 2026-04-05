/* Commit this file as-is. Netlify overwrites it during build when env vars are set.
   For local testing: run \`SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/inject-supabase-config.mjs\`
   or set the two properties below temporarily (do not commit real keys). */
window.SUPABASE_URL = window.SUPABASE_URL || "";
window.SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "";
