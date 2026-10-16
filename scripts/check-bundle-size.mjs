#!/usr/bin/env node
// === W55 pwa (MOB-8): enforce the SPEC_W48 250KB gzip initial-JS budget ===
// Zero-dependency (node stdlib only; lockfiles frozen). Scans a built dist
// directory for *.js chunks, gzips each, reports the largest, and exits 1 if
// any chunk exceeds the budget. Usage:
//   node scripts/check-bundle-size.mjs [distDir] [budgetKB]
// Defaults: dist/public (the client/ app), 250 KB.
import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const distDir = path.resolve(process.argv[2] ?? "dist/public");
const budgetKB = Number(process.argv[3] ?? 250);
const budgetBytes = budgetKB * 1024;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith(".js")) yield full;
  }
}

let files;
try {
  files = [...walk(distDir)];
} catch {
  console.error(`bundle-size: dist directory not found: ${distDir} — run the build first`);
  process.exit(2);
}

const sizes = files
  .map((f) => ({ file: path.relative(distDir, f), gzip: gzipSync(readFileSync(f)).length }))
  .sort((a, b) => b.gzip - a.gzip);

if (sizes.length === 0) {
  console.error(`bundle-size: no .js chunks found in ${distDir} — run the build first`);
  process.exit(2);
}

for (const { file, gzip } of sizes.slice(0, 10)) {
  console.log(`  ${(gzip / 1024).toFixed(1).padStart(8)} KB  ${file}`);
}
const largest = sizes[0];
console.log(
  `bundle-size: largest chunk ${largest.file} = ${(largest.gzip / 1024).toFixed(1)} KB gzip (budget ${budgetKB} KB)`,
);
if (largest.gzip > budgetBytes) {
  console.error(`bundle-size: FAIL — exceeds the SPEC_W48 ${budgetKB}KB gzip budget`);
  process.exit(1);
}
console.log("bundle-size: OK");
