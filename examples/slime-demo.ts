// End-to-end demo: drives the MCP server (core profile) exactly like an assistant
// would and produces a tagged, validated, Godot-ready slime sprite.
//
//   npm run build && npx tsx examples/slime-demo.ts [outputDir]
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startClient } from "../tests/helpers/client.js";

const outDir = path.resolve(process.argv[2] ?? "examples/output");
const c = await startClient();
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await c.call(name, args);
  if (r.isError) throw new Error(`${name} ${String(args.op ?? "")}: ${r.text}`);
  console.log(`✓ ${name}${args.op ? ` ${String(args.op)}` : ""}`);
  return r;
};
const file = "slime.aseprite";
const run = (op: string, args: Record<string, unknown>) => call("run_op", { op, path: file, args });

await call("run_op", {
  op: "doc.create",
  args: {
    path: file,
    width: 16,
    height: 16,
    palette: "sweetie-16",
    layers: ["shadow", "body"],
    animations: [{ name: "idle", frames: 4, durationMs: 150, direction: "pingpong" }],
    overwrite: true,
  },
});

// Frame 1: draw the body, highlight and eyes as one character grid.
const body = [
  "....oooooo....",
  "..oowwoooooo..",
  ".oowwooooooooo",
  ".owoooooooooo.",
  "ooooKoooooKooo",
  "ooooKoooooKooo",
  "oooooooooooooo",
  ".oooooooooooo.",
  "..dddddddddd..",
];
// One atomic, checkpointed transaction: all ops apply or none do.
await call("batch", {
  path: file,
  label: "draw slime",
  ops: [
    { op: "draw.pixel_map", layer: "body", x: 1, y: 6, rows: body, legend: { o: "#38b764", w: "#a7f070", K: "#1a1c2c", d: "#257179" } },
    { op: "draw.outline", layer: "body", color: "#1a1c2c" },
    { op: "draw.ellipse", layer: "shadow", x: 2, y: 14, width: 12, height: 2, color: "#333c57", filled: true },
    // Squash-and-stretch idle: copy frame 1, then squash frames 2-4 down by 0-2 px.
    { op: "cel.copy", layer: "body", fromFrame: 1, toFrame: 2, toFrameEnd: 4 },
    { op: "cel.copy", layer: "shadow", fromFrame: 1, toFrame: 2, toFrameEnd: 4 },
    { op: "xf.shift", layer: "body", frames: [2, 4], dy: 1 },
    { op: "xf.shift", layer: "body", frame: 3, dy: 2 },
  ],
});

const preview = await call("preview", { path: file, tag: "idle", onion: true });
const lint = await run("check.lint", { palette: "sweetie-16", maxColors: 8 });
const result = lint.json.result ?? lint.json;
console.log("  valid:", result.valid, "issues:", (result.issues ?? []).map((i: { code: string }) => i.code).join(", ") || "none");

await run("engine.godot_sprite_frames", { output: "export/slime.png", force: true });
await run("view.gif", { output: "export/slime.gif", tag: "idle", scale: 6 });

mkdirSync(outDir, { recursive: true });
cpSync(c.workdir, outDir, { recursive: true, filter: (p) => !p.includes(".aseprite-mcp") });
writeFileSync(path.join(outDir, "preview.png"), Buffer.from(preview.images[0]!, "base64"));
console.log(`\nWrote ${outDir}`);
await c.close();
