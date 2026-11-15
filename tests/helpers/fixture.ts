import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TestClient } from "./client.js";

/** Call a tool and throw on error; parse the first text block as JSON. */
export async function ok(c: TestClient, name: string, args: Record<string, unknown>) {
  const r = await c.call(name, args);
  if (r.isError) throw new Error(`${name} ${JSON.stringify(args).slice(0, 200)} failed: ${r.text}`);
  return r;
}

export const run = (c: TestClient, op: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ok(c, "run_op", { op, args, ...extra });

/**
 * The standard fixture every catalog example runs against:
 *   fixture.aseprite 32x32 RGB, PICO-8 palette, 4 frames (tags idle 1-2, walk 3-4), layers
 *   bg, ground (tilemap 8x8, 3 tiles), body (outlined ellipse), fx, parts/arm; slice "hitbox".
 *   second.aseprite 16x16, ref.png (64x64 upscaled render), stamp.png, frames/f_1..2.png,
 *   sheet.png (4 cells of 8x8), palette.gpl, ai-source.png, unity/ (fake project settings).
 */
export async function buildFixture(c: TestClient): Promise<void> {
  const w = c.workdir;
  await run(c, "doc.create", { path: "fixture.aseprite", width: 32, height: 32, palette: "pico-8", layers: ["bg", "body", "fx"], animations: [{ name: "idle", frames: 2, durationMs: 100 }, { name: "walk", frames: 2, durationMs: 100 }] });
  await ok(c, "batch", {
    path: "fixture.aseprite",
    label: "fixture",
    ops: [
      { op: "draw.rect", layer: "bg", x: 0, y: 0, width: 32, height: 32, color: "#1d2b53", filled: true, frames: [1, 2, 3, 4] },
      { op: "draw.ellipse", layer: "body", x: 8, y: 8, width: 16, height: 16, color: "#ff004d", filled: true, frames: [1, 2, 3, 4] },
      { op: "draw.outline", layer: "body", color: "#000000", fromFrame: 1, toFrame: 4 },
      { op: "cel.move", layer: "body", frame: 3, dx: 1 },
      { op: "cel.move", layer: "body", frame: 4, dx: 2, dy: -1 },
      { op: "draw.pixels", layer: "fx", pixels: [{ x: 12, y: 12, color: "#fff1e8" }, { x: 13, y: 12, color: "#fff1e8" }] },
      { op: "layer.add_group", name: "parts", toTop: true },
      { op: "layer.add", name: "arm", parent: "parts" },
      { op: "draw.rect", layer: "arm", x: 22, y: 14, width: 4, height: 8, color: "#ffccaa", filled: true, frames: [1, 2, 3, 4] },
      { op: "tile.create_layer", name: "ground", tileWidth: 8, tileHeight: 8, above: "bg", tilesetName: "ground" },
      { op: "tile.add", layer: "ground", rows: ["gggggggg", "gGgggggg", "gggggGgg", "gggggggg", "ggGggggg", "gggggggg", "ggggggGg", "gggggggg"], legend: { g: "#008751", G: "#00e436" } },
      { op: "tile.add", layer: "ground", rows: ["bbbbbbbb", "bBbbbbbb", "bbbbbbbb", "bbbbBbbb", "bbbbbbbb", "bbbbbbbb", "bbBbbbbb", "bbbbbbbb"], legend: { b: "#ab5236", B: "#5f574f" } },
      { op: "tile.add", layer: "ground", rows: ["gggggggg", "gggggggg", "gggggggg", "gggggggg", "bbbbbbbb", "bbbbbbbb", "bbbbbbbb", "bbbbbbbb"], legend: { g: "#008751", b: "#ab5236" } },
      { op: "tile.paint", layer: "ground", x: 0, y: 3, rows: ["AAAA"], legend: { A: 1 } },
      { op: "slice.add", name: "hitbox", x: 8, y: 8, width: 16, height: 16 },
    ],
  });
  await run(c, "doc.create", { path: "second.aseprite", width: 16, height: 16, palette: "pico-8" });
  await ok(c, "batch", { path: "second.aseprite", ops: [{ op: "draw.rect", x: 2, y: 2, width: 8, height: 8, color: "#29adff", filled: true }] });
  await run(c, "export.png", { output: "ref.png", fromFrame: 1, toFrame: 1, scale: 2, layer: "body" }, { path: "fixture.aseprite" });
  await run(c, "ref.crop", { file: "ref.png", output: "stamp.png", x: 16, y: 16, width: 8, height: 8 });
  await run(c, "ref.crop", { file: "ref.png", output: "sheet.png", x: 16, y: 24, width: 32, height: 8 });
  await run(c, "export.png", { output: "frames/f.png", tag: "idle" }, { path: "fixture.aseprite" });
  cpSync(path.join(w, "ref.png"), path.join(w, "ai-source.png"));
  writeFileSync(path.join(w, "palette.gpl"), "GIMP Palette\nName: test\n#\n  0   0   0\tblack\n255 255 255\twhite\n255   0  77\tred\n 41 173 255\tblue\n");
  mkdirSync(path.join(w, "unity", "ProjectSettings"), { recursive: true });
  mkdirSync(path.join(w, "unity", "Assets"), { recursive: true });
  mkdirSync(path.join(w, "unity", "Packages"), { recursive: true });
  writeFileSync(path.join(w, "unity", "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.6.3f1\n");
  writeFileSync(path.join(w, "unity", "Packages", "manifest.json"), JSON.stringify({ dependencies: { "com.unity.2d.sprite": "1.0.0" } }));
  mkdirSync(path.join(w, "godot"), { recursive: true });
  writeFileSync(path.join(w, "godot", "project.godot"), "config_version=5\n");
}

/** Snapshot the fixture so each example can start from the same state. */
export function snapshotFixture(c: TestClient): void {
  const p = path.join(c.workdir, "..", path.basename(c.workdir) + "-pristine");
  rmSync(p, { recursive: true, force: true });
  cpSync(c.workdir, p, { recursive: true });
}

export function restoreFixture(c: TestClient): void {
  const p = path.join(c.workdir, "..", path.basename(c.workdir) + "-pristine");
  for (const n of readdirSync(c.workdir)) rmSync(path.join(c.workdir, n), { recursive: true, force: true, maxRetries: 3 });
  cpSync(p, c.workdir, { recursive: true });
}
