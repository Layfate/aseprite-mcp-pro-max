#!/usr/bin/env node
// After the first pixel-changing batch of a session, remind the model to look.
// Not looking is the most common failure: the tool says "412 pixels changed" and
// the model reports a finished sprite it has never seen. Fires once per session,
// so it stays a reminder instead of noise the model learns to skip.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const dir = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "aseprite-pro-max"), "look-nudge");
const marker = path.join(dir, `${String(payload.session_id || "unknown").replace(/[^\w-]/g, "_")}.seen`);
if (existsSync(marker)) process.exit(0);
try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, String(Date.now()));
} catch {
  // still nudge once
}
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext:
      "Pixels changed. Look at the result before the next stage: preview (scale 1 and a zoomed view; view 'silhouette' after block-in, 'values' after shading). " +
      "Nothing is done without a preview you looked at, check.craft with no blocking finding, and a review by a reader who did not draw it (pixel-critic agent / skill://review).",
  },
}));
