import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outDir = path.join(__dirname, "dist");
fs.mkdirSync(outDir, { recursive: true });

// 1. Bundle zero-dependency MCP server (dist/server.mjs)
await esbuild.build({
  entryPoints: [path.join(__dirname, "src", "server.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: path.join(outDir, "server.mjs"),
  banner: {
    js: `import { createRequire as __agyCreateRequire } from "node:module"; const require = __agyCreateRequire(import.meta.url);`,
  },
});

const serverSize = fs.statSync(path.join(outDir, "server.mjs")).size;
console.log(`Built dist/server.mjs (${(serverSize / 1024).toFixed(1)} KiB)`);

// 2. Bundle self-contained single-file MCP App UI (dist/app.html)
const uiBuild = await esbuild.build({
  entryPoints: [path.join(__dirname, "src", "app.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  write: false,
});

const rawJs = uiBuild.outputFiles[0].text;
const safeJs = rawJs.replace(/<\/script/gi, "<\\/script");

// Verify bundled JS syntax before embedding into HTML
new Function(safeJs);

const template = fs.readFileSync(path.join(__dirname, "src", "template.html"), "utf8");
const marker = "<!--__BUNDLE_SCRIPT__-->";
if (!template.includes(marker)) {
  throw new Error(`Template missing marker: ${marker}`);
}
const bundledHtml = template.replace(marker, () => `<script>${safeJs}</script>`);

const htmlOut = path.join(outDir, "app.html");
fs.writeFileSync(htmlOut, bundledHtml, "utf8");
console.log(`Built & syntax-verified dist/app.html (${(bundledHtml.length / 1024).toFixed(1)} KiB)`);
