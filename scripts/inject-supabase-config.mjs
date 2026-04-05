import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const out = path.join(root, "supabase-config.js");

const url = process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_ANON_KEY ?? "";

const body = `/* Generated at build time — use the anon (public) key only, never the service role. */
window.SUPABASE_URL = ${JSON.stringify(url)};
window.SUPABASE_ANON_KEY = ${JSON.stringify(key)};
`;

fs.writeFileSync(out, body, "utf8");
console.log("Wrote supabase-config.js", url ? "(URL set)" : "(empty — sync off)");
