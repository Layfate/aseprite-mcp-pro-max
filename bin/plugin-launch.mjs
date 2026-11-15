#!/usr/bin/env node
// Claude Code plugin entry: make sure the server is built, then run it over stdio.
// A git-installed plugin has no dist/ (it is gitignored): the first start runs
// `npm install` (whose `prepare` script compiles TypeScript). Everything npm prints
// goes to stderr; stdout belongs to the MCP protocol.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "index.js");

if (!existsSync(entry) || !existsSync(path.join(root, "node_modules"))) {
  process.stderr.write("aseprite-pro-max: first start, installing and building (one time)...\n");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: ["ignore", process.stderr, process.stderr], shell: process.platform === "win32" });
  if (r.status !== 0 || !existsSync(entry)) {
    process.stderr.write(`aseprite-pro-max: build failed (exit ${r.status}). Run "npm install" in ${root} and check the output.\n`);
    process.exit(1);
  }
}

await import(pathToFileURL(entry).href);
