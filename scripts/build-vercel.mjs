import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(root, "src/xdfdet/static");
const output = resolve(root, "dist");
const apiBaseUrl = process.env.XDFDET_API_URL?.trim().replace(/\/+$/, "");
const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();

if (!apiBaseUrl || !supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Set XDFDET_API_URL, SUPABASE_URL, and SUPABASE_ANON_KEY in the Vercel project settings before building.",
  );
}

if (new URL(apiBaseUrl).protocol !== "https:" || new URL(supabaseUrl).protocol !== "https:") {
  throw new Error("Vercel deployments require HTTPS API and Supabase URLs.");
}

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "static"), { recursive: true });
await cp(resolve(source, "index.html"), resolve(output, "index.html"));
await cp(resolve(source, "styles.css"), resolve(output, "static/styles.css"));
await cp(resolve(source, "app.js"), resolve(output, "static/app.js"));
await writeFile(
  resolve(output, "static/config.js"),
  `window.XDFDET_CONFIG = Object.freeze(${JSON.stringify({
    apiBaseUrl,
    supabaseUrl,
    supabaseAnonKey,
  })});\n`,
  { encoding: "utf8", flag: "w" },
);
