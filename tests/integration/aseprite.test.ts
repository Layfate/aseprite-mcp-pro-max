import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasAseprite, startClient, type TestClient } from "../helpers/client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const run = hasAseprite() ? describe : describe.skip;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

run("with a real Aseprite", () => {
  let c: TestClient;
  const file = (p: string) => path.join(c.workdir, p);
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await c.call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return r;
  };
  const grid = async (p: string, args: Record<string, unknown> = {}) => (await ok("aseprite_read_pixels", { path: p, ...args })).json;

  beforeAll(async () => {
    const provider = JSON.stringify(["node", path.join(here, "..", "fixtures", "fake-image-provider.mjs").replaceAll("\\", "/"), "{workdir}/ai-source.png", "{output}", "{prompt}"]);
    c = await startClient({ ASEPRITE_MCP_IMAGE_PROVIDER: "command", ASEPRITE_MCP_IMAGE_COMMAND: provider, ASEPRITE_MCP_PROFILE: "core,legacy", ASEPRITE_MCP_COVERAGE_FILE: path.resolve("tests/.coverage/legacy.txt") });
  });
  afterAll(async () => {
    await c?.close();
  });

  it("lists tools and reports status", async () => {
    const tools = (await c.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("aseprite_edit");
    expect(tools).toContain("run_op");
    expect(tools).not.toContain("run_lua");
    const s = await ok("aseprite_status", {});
    expect(s.json.aseprite.version).toMatch(/^1\.3/);
  });

  it("creates sprites with palette, layers and tagged animations", async () => {
    const r = await ok("aseprite_create", {
      path: "hero.aseprite", width: 16, height: 16, palette: "pico-8", layers: ["body", "fx"],
      animations: [{ name: "idle", frames: 2, durationMs: 200 }, { name: "walk", frames: 4, durationMs: 100, direction: "pingpong" }],
    });
    expect(r.json.sprite.frames).toBe(6);
    const info = (await ok("aseprite_inspect", { path: "hero.aseprite" })).json;
    expect(info.tags).toEqual([
      { name: "idle", from: 1, to: 2, direction: "forward" },
      { name: "walk", from: 3, to: 6, direction: "pingpong" },
    ]);
    expect(info.frames.map((f: { durationMs: number }) => f.durationMs)).toEqual([200, 200, 100, 100, 100, 100]);
    expect(info.layers.map((l: { path: string }) => l.path)).toEqual(["fx", "body"]);
    expect(info.palette.colors).toHaveLength(16);
    const again = await c.call("aseprite_create", { path: "hero.aseprite", width: 8, height: 8 });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("FILE_EXISTS");
  });

  it("round-trips pixel maps exactly", async () => {
    const rows = ["..KK..", ".KooK.", "KowwoK", ".KooK.", "..KK.."];
    await ok("aseprite_edit", { path: "hero.aseprite", ops: [{ op: "pixel_map", layer: "body", x: 5, y: 5, rows, legend: { K: "#000000", o: "#ffa300", w: "#fff1e8" } }] });
    const g = await grid("hero.aseprite", { layer: "body", x: 5, y: 5, width: 6, height: 5 });
    const back = g.rows.map((r: string) => r.replace(/[A-Z]/g, (ch: string) => ({ "#000000": "K", "#ffa300": "o", "#fff1e8": "w" } as Record<string, string>)[g.legend[ch]]!));
    expect(back).toEqual(rows);
  });

  it("draws deterministic primitives (golden grids)", async () => {
    await ok("aseprite_create", { path: "prim.aseprite", width: 9, height: 9 });
    await ok("aseprite_edit", { path: "prim.aseprite", ops: [{ op: "ellipse", x: 0, y: 0, width: 9, height: 9, color: "#ff0000" }] });
    expect((await grid("prim.aseprite")).rows).toEqual([
      "...AAA...",
      "..A...A..",
      ".A.....A.",
      "A.......A",
      "A.......A",
      "A.......A",
      ".A.....A.",
      "..A...A..",
      "...AAA...",
    ]);
    await ok("aseprite_edit", { path: "prim.aseprite", ops: [
      { op: "fill", x: 4, y: 4, color: "#00ff00" },
      { op: "line", x1: 0, y1: 0, x2: 8, y2: 8, color: "#0000ff" },
    ] });
    const g = await grid("prim.aseprite");
    const inv = Object.fromEntries(Object.entries(g.legend).map(([k, v]) => [v, k]));
    expect(g.rows[4]).toBe(`${inv["#ff0000"]}${inv["#00ff00"]!.repeat(3)}${inv["#0000ff"]}${inv["#00ff00"]!.repeat(3)}${inv["#ff0000"]}`);
    expect(g.rows[0]![0]).toBe(inv["#0000ff"]);
  });

  it("outlines, flips, rotates and shifts", async () => {
    await ok("aseprite_create", { path: "t.aseprite", width: 5, height: 5 });
    await ok("aseprite_edit", { path: "t.aseprite", ops: [
      { op: "set_pixels", pixels: [{ x: 2, y: 2, color: "#ffffff" }] },
      { op: "outline", color: "#000000" },
    ] });
    expect((await grid("t.aseprite")).rows).toEqual([".....", "..A..", ".ABA.", "..A..", "....."]);
    await ok("aseprite_create", { path: "f.aseprite", width: 4, height: 2 });
    await ok("aseprite_edit", { path: "f.aseprite", ops: [{ op: "pixel_map", rows: ["AB..", "...."], legend: { A: "#ff0000", B: "#00ff00" } }, { op: "flip", direction: "horizontal" }] });
    // Legend letters are assigned in reading order, so compare colors, not letters.
    const colorsOf = async (p: string) => {
      const g = await grid(p);
      return [...g.rows[0]].map((ch: string) => (ch === "." ? "." : g.legend[ch]));
    };
    expect(await colorsOf("f.aseprite")).toEqual([".", ".", "#00ff00", "#ff0000"]);
    await ok("aseprite_edit", { path: "f.aseprite", ops: [{ op: "shift", dx: 1, wrap: true }] });
    expect(await colorsOf("f.aseprite")).toEqual(["#ff0000", ".", ".", "#00ff00"]);
    await ok("aseprite_create", { path: "r.aseprite", width: 3, height: 3 });
    await ok("aseprite_edit", { path: "r.aseprite", ops: [{ op: "set_pixels", pixels: [{ x: 0, y: 0, color: "#ff0000" }] }, { op: "rotate", angle: 90 }] });
    expect((await grid("r.aseprite")).rows).toEqual(["..A", "...", "..."]);
  });

  it("is atomic: a failing op leaves the file byte-identical and adds no checkpoint", async () => {
    const before = sha(file("hero.aseprite"));
    const cps = (await ok("aseprite_history", { path: "hero.aseprite", action: "list" })).json.checkpoints.length;
    const r = await c.call("aseprite_edit", { path: "hero.aseprite", ops: [
      { op: "rect", layer: "body", x: 0, y: 0, width: 16, height: 16, color: "#ff004d", filled: true },
      { op: "fill", layer: "does-not-exist", x: 0, y: 0, color: "#000" },
    ] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("op #2 (draw.fill)");
    expect(r.text).toContain("'body'");
    expect(sha(file("hero.aseprite"))).toBe(before);
    expect((await ok("aseprite_history", { path: "hero.aseprite", action: "list" })).json.checkpoints.length).toBe(cps);
    expect(readdirSync(c.workdir).filter((n) => n.includes(".mcp-"))).toEqual([]);
  });

  it("dry runs preview without writing", async () => {
    const before = sha(file("hero.aseprite"));
    const r = await ok("aseprite_edit", { path: "hero.aseprite", dryRun: true, ops: [{ op: "flip", layer: "body", direction: "vertical" }] });
    expect(r.images).toHaveLength(1);
    expect(sha(file("hero.aseprite"))).toBe(before);
  });

  it("serializes concurrent edits to the same file", async () => {
    await ok("aseprite_create", { path: "conc.aseprite", width: 8, height: 8 });
    await Promise.all([1, 2, 3, 4, 5].map((i) => ok("aseprite_edit", { path: "conc.aseprite", ops: [{ op: "add_layer", name: `L${i}` }] })));
    const layers = (await ok("aseprite_inspect", { path: "conc.aseprite" })).json.layers.map((l: { path: string }) => l.path);
    for (let i = 1; i <= 5; i++) expect(layers).toContain(`L${i}`);
  });

  it("supports layers, groups, frames, cels and tweens", async () => {
    await ok("aseprite_create", { path: "anim.aseprite", width: 8, height: 8, layers: ["bg", "ball"] });
    await ok("aseprite_edit", { path: "anim.aseprite", ops: [
      { op: "add_layer", name: "group", group: true },
      { op: "move_layer", layer: "ball", parent: "group" },
      { op: "set_pixels", layer: "group/ball", pixels: [{ x: 0, y: 0, color: "#ffffff" }] },
      { op: "add_frames", count: 3, durationMs: 50 },
      { op: "tween", layer: "ball", fromFrame: 1, toFrame: 4, dx: 3, dy: 6, easing: "linear" },
      { op: "add_tag", name: "bounce", from: 1, to: 4 },
      { op: "duplicate_layer", layer: "group/ball", name: "ghost" },
      { op: "set_layer", layer: "ghost", opacity: 128, visible: false },
    ] });
    const info = (await ok("aseprite_inspect", { path: "anim.aseprite" })).json;
    expect(info.layers.map((l: { path: string }) => l.path)).toEqual(["group", "group/ghost", "group/ball", "bg"]);
    expect(info.frameCount).toBe(4);
    const f4 = await grid("anim.aseprite", { frame: 4, layer: "group/ball" });
    expect(f4.rows[6]![3]).toBe("A");
    const f2 = await grid("anim.aseprite", { frame: 2, layer: "group/ball" });
    expect(f2.rows[2]![1]).toBe("A");
    await ok("aseprite_edit", { path: "anim.aseprite", ops: [{ op: "reverse_frames", from: 1, to: 4 }] });
    expect((await grid("anim.aseprite", { frame: 1, layer: "group/ball" })).rows[6]![3]).toBe("A");
  });

  it("exports sheets whose metadata matches the sprite, plus engine files", async () => {
    const r = await ok("aseprite_export", { path: "hero.aseprite", output: "out/hero.png", preset: "godot" });
    const data = JSON.parse(readFileSync(file("out/hero.json"), "utf8"));
    expect(data.frames).toHaveLength(6);
    expect(data.frames.map((f: { duration: number }) => f.duration)).toEqual([200, 200, 100, 100, 100, 100]);
    expect(data.meta.frameTags.map((t: { name: string; from: number; to: number }) => [t.name, t.from, t.to])).toEqual([["idle", 0, 1], ["walk", 2, 5]]);
    expect(r.json.files).toEqual(expect.arrayContaining(["out/hero.png", "out/hero.json", "out/hero.tres"]));
    const tres = readFileSync(file("out/hero.tres"), "utf8");
    expect(tres.match(/\[sub_resource type="AtlasTexture"/g)).toHaveLength(6);
    await ok("aseprite_export", { path: "hero.aseprite", output: "out/hero_ph.png", preset: "phaser" });
    expect(JSON.parse(readFileSync(file("out/hero_ph.anims.json"), "utf8")).anims.map((a: { key: string }) => a.key)).toEqual(["idle", "walk"]);
    const gif = await ok("aseprite_export", { path: "hero.aseprite", output: "out/hero.gif", tag: "walk", scale: 2 });
    expect(gif.json.files).toEqual(["out/hero.gif"]);
    const pngs = await ok("aseprite_export", { path: "hero.aseprite", output: "out/frames/hero.png", tag: "idle" });
    expect(pngs.json.files).toEqual(["out/frames/hero_1.png", "out/frames/hero_2.png"]);
  });

  it("validates palettes, transparency, stray pixels and animation", async () => {
    await ok("aseprite_create", { path: "lint.aseprite", width: 8, height: 8, frames: 2 });
    await ok("aseprite_edit", { path: "lint.aseprite", ops: [
      { op: "set_pixels", pixels: [{ x: 0, y: 0, color: "#12345680" }, { x: 5, y: 5, color: "#ff004d" }] },
    ] });
    const v = (await ok("aseprite_validate", { path: "lint.aseprite", rules: { palette: "pico-8", maxColors: 1 } })).json;
    const codes = v.issues.map((i: { code: string }) => i.code);
    expect(v.valid).toBe(false);
    expect(codes).toEqual(expect.arrayContaining(["too_many_colors", "semi_transparent", "off_palette", "stray_pixels", "empty_frame"]));
    const many = (await ok("aseprite_validate", { paths: ["lint.aseprite", "hero.aseprite"] })).json;
    expect(Object.keys(many)).toEqual(["lint.aseprite", "hero.aseprite"]);
  });

  it("previews and compares with images", async () => {
    const p = await ok("aseprite_preview", { path: "anim.aseprite", tag: "bounce", onion: true, saveTo: "prev/anim.png" });
    expect(p.images).toHaveLength(1);
    expect(existsSync(file("prev/anim.png"))).toBe(true);
    const cmp = await ok("aseprite_compare", { path: "anim.aseprite", frameA: 1, frameB: 4 });
    expect(cmp.json.identical).toBe(false);
    expect(cmp.json.differentPixels).toBe(2);
    expect(cmp.images).toHaveLength(1);
  });

  it("imports upscaled art: downscale, background removal and palette snap", async () => {
    // Build a fake "AI" image: 8x8 art on a flat background, upscaled 16x.
    await ok("aseprite_create", { path: "src.aseprite", width: 8, height: 8, background: "#d0d0d0" });
    await ok("aseprite_edit", { path: "src.aseprite", ops: [{ op: "pixel_map", rows: ["........", "..AAAA..", ".ABBBBA.", ".ABBBBA.", ".ABBBBA.", "..AAAA..", "........", "........"], legend: { A: "#1d2b53", B: "#fe0050" } }] });
    await ok("aseprite_export", { path: "src.aseprite", output: "ai-source.png", scale: 16 });
    const r = await ok("aseprite_import_image", { image: "ai-source.png", path: "imported.aseprite", pixelSize: 16, removeBackground: "corners", palette: "pico-8" });
    expect(r.json.source).toBe("128x128");
    expect(r.images).toHaveLength(1);
    const g = await grid("imported.aseprite");
    expect(g.rows).toEqual(["........", "..AAAA..", ".ABBBBA.", ".ABBBBA.", ".ABBBBA.", "..AAAA..", "........", "........"]);
    expect(Object.values(g.legend).sort()).toEqual(["#1d2b53", "#ff004d"]); // snapped to PICO-8
    await ok("aseprite_import_image", { image: "ai-source.png", into: "hero.aseprite", width: 8, layerName: "ref" });
    expect((await ok("aseprite_inspect", { path: "hero.aseprite" })).json.layers[0].path).toBe("ref");
  });

  it("generates sprites through a configured image provider", async () => {
    await ok("run_op", { op: "ref.generate", args: { prompt: "a tiny red gem", path: "gen.aseprite", width: 8, height: 8, palette: "pico-8" } });
    expect((await grid("gen.aseprite")).rows[3]).toBe(".ABBBBA.");
  });

  it("undoes, redoes and restores checkpoints", async () => {
    await ok("aseprite_create", { path: "h.aseprite", width: 4, height: 1 });
    await ok("aseprite_edit", { path: "h.aseprite", label: "red", ops: [{ op: "set_pixels", pixels: [{ x: 0, y: 0, color: "#ff0000" }] }] });
    await ok("aseprite_edit", { path: "h.aseprite", label: "green", ops: [{ op: "set_pixels", pixels: [{ x: 1, y: 0, color: "#00ff00" }] }] });
    expect((await grid("h.aseprite")).rows[0]).toBe("AB..");
    await ok("aseprite_history", { path: "h.aseprite", action: "undo" });
    expect((await grid("h.aseprite")).rows[0]).toBe("A...");
    await ok("aseprite_history", { path: "h.aseprite", action: "redo" });
    expect((await grid("h.aseprite")).rows[0]).toBe("AB..");
    const list = (await ok("aseprite_history", { path: "h.aseprite", action: "list" })).json.checkpoints;
    const first = list.find((cp: { label?: string }) => cp.label === "red");
    await ok("aseprite_history", { path: "h.aseprite", action: "restore", id: first.id });
    expect((await grid("h.aseprite")).rows[0]).toBe("....");
  });

  it("handles indexed sprites", async () => {
    await ok("aseprite_create", { path: "idx.aseprite", width: 4, height: 1, colorMode: "indexed", palette: ["#000000", "#ff0000", "#00ff00", "#0000ff"] });
    await ok("aseprite_edit", { path: "idx.aseprite", ops: [{ op: "set_pixels", pixels: [{ x: 0, y: 0, color: 2 }, { x: 1, y: 0, color: "#0000fe" }] }] });
    const g = await grid("idx.aseprite");
    expect(g.legend).toEqual({ A: "#00ff00", B: "#0000ff" });
  });

  it("resizes, scales and crops", async () => {
    await ok("aseprite_create", { path: "sz.aseprite", width: 4, height: 4 });
    await ok("aseprite_edit", { path: "sz.aseprite", ops: [
      { op: "set_pixels", pixels: [{ x: 0, y: 0, color: "#ffffff" }] },
      { op: "resize_canvas", width: 6, height: 6, anchor: "bottom-right" },
      { op: "scale", factor: 2 },
    ] });
    const g = await grid("sz.aseprite");
    expect(g.width).toBe(12);
    expect(g.rows[4]!.slice(4, 6)).toBe("AA");
    expect(g.rows[5]!.slice(4, 6)).toBe("AA");
  });

  it("runs every edit operation against real Aseprite", async () => {
    await ok("aseprite_create", { path: "all.aseprite", width: 16, height: 16, layers: ["a", "b"], frames: 3 });
    await ok("aseprite_create", { path: "stamp.aseprite", width: 3, height: 3, background: "#336699" });
    await ok("aseprite_export", { path: "stamp.aseprite", output: "stamp.png" });
    const batches: Array<Array<Record<string, unknown>>> = [
      [
        { op: "pixel_map", layer: "a", rows: ["AB", "BA"], legend: { A: "#ff0000", B: "#00ff00" } },
        { op: "set_pixels", layer: "a", pixels: [{ x: 5, y: 5, color: "#0000ff" }] },
        { op: "line", layer: "a", points: [{ x: 0, y: 15 }, { x: 8, y: 10 }, { x: 15, y: 15 }], closed: true, color: "#ffffff" },
        { op: "rect", layer: "b", x: 1, y: 1, width: 4, height: 4, color: "#123456" },
        { op: "ellipse", layer: "b", x: 6, y: 6, width: 5, height: 3, color: "#654321", filled: true },
        { op: "fill", layer: "b", x: 2, y: 2, color: "#abcdef", contiguous: false },
        { op: "gradient", layer: "b", frame: 2, colors: ["#000000", "#ffffff"], direction: "horizontal" },
        { op: "text", layer: "a", frame: 3, x: 0, y: 0, text: "OK 1!", color: "#ffff00", scale: 2 },
      ],
      [
        { op: "replace_color", fromColor: "#ff0000", toColor: "#ff00ff" },
        { op: "adjust_color", layer: "b", frame: 2, hue: 30, saturation: 10, lightness: -5 },
        { op: "quantize", layer: "b", frame: 2, colors: ["#000000", "#808080", "#ffffff"] },
        { op: "outline", layer: "a", fromFrame: 1, toFrame: 1, color: "#000000", matrix: "square" },
        { op: "outline", layer: "a", frame: 1, place: "inside", color: "#222222" },
        { op: "flip", layer: "b", frame: 1, direction: "vertical" },
        { op: "rotate", layer: "b", frame: 1, angle: 180 },
        { op: "shift", layer: "b", frame: 1, dx: -2, dy: 3 },
        { op: "move", layer: "b", frame: 1, dx: 1 },
        { op: "copy_region", layer: "a", frame: 1, x: 0, y: 0, width: 4, height: 4, toX: 10, toY: 10, toLayer: "b", toFrame: 3, cut: true },
        { op: "import_image", layer: "a", frame: 2, file: "stamp.png", x: 3, y: 3 },
      ],
      [
        { op: "copy_cel", layer: "a", fromFrame: 1, toLayer: "b", toFrame: 2 },
        { op: "set_cel", layer: "b", frame: 2, opacity: 200 },
        { op: "tween", layer: "a", fromFrame: 1, toFrame: 3, dx: 2, fromOpacity: 255, toOpacity: 100, easing: "ease_out" },
        { op: "add_layer", name: "fx", above: "b", blendMode: "screen", opacity: 128 },
        { op: "set_layer", layer: "fx", name: "glow", locked: false, visible: true },
        { op: "duplicate_layer", layer: "a" },
        { op: "move_layer", layer: "a copy", toTop: true },
        { op: "merge_down", layer: "a copy" },
        { op: "delete_layer", layer: "glow" },
      ],
      [
        { op: "add_frames", count: 2, copyFrom: 1, after: 1, durationMs: 80 },
        { op: "delete_frames", from: 5 },
        { op: "set_frame_duration", durationMs: 120, fromFrame: 1, toFrame: 2 },
        { op: "reverse_frames", from: 1, to: 4 },
        { op: "add_tag", name: "loop", from: 1, to: 4, direction: "pingpong_reverse", repeats: 2 },
        { op: "set_tag", tag: "loop", name: "cycle", to: 3, direction: "reverse" },
        { op: "add_tag", name: "tmp", from: 4, to: 4 },
        { op: "delete_tag", tag: "tmp" },
        { op: "add_slice", name: "hitbox", x: 2, y: 2, width: 8, height: 8, pivot: { x: 4, y: 8 }, center: { x: 1, y: 1, width: 6, height: 6 } },
        { op: "add_slice", name: "tmp", x: 0, y: 0, width: 1, height: 1 },
        { op: "delete_slice", name: "tmp" },
      ],
      [
        { op: "set_palette", preset: "db16" },
        { op: "set_palette_color", index: 16, color: "#ff8800" },
        { op: "resize_canvas", width: 20, height: 18, anchor: "top" },
        { op: "crop", x: 1, y: 1, width: 18, height: 16 },
        { op: "scale", width: 36, height: 32 },
        { op: "set_color_mode", mode: "indexed", dithering: "ordered" },
        { op: "set_palette", preset: "pico-8", remap: true },
        { op: "set_color_mode", mode: "rgb" },
        { op: "clear", layer: "b", frame: 3, x: 0, y: 0, width: 4, height: 4 },
        { op: "clear", layer: "b", tag: "cycle" },
        { op: "flatten" },
      ],
    ];
    for (const ops of batches) await ok("aseprite_edit", { path: "all.aseprite", ops });
    const info = (await ok("aseprite_inspect", { path: "all.aseprite" })).json;
    expect(info.width).toBe(36);
    expect(info.height).toBe(32);
    expect(info.layers).toHaveLength(1);
    expect(info.frameCount).toBe(4);
    expect(info.tags).toEqual([{ name: "cycle", from: 1, to: 3, direction: "reverse", repeats: 2 }]);
    expect(info.slices[0]).toMatchObject({ name: "hitbox", pivot: { x: 8, y: 16 } }); // scaled 2x with the sprite
    expect(info.palette.colors).toHaveLength(16);
    const covered = new Set(batches.flat().map((o) => o.op));
    const { LEGACY_OPS } = await import("../../src/catalog/registry.js");
    expect(Object.keys(LEGACY_OPS).filter((n) => !covered.has(n))).toEqual([]);
  });

  it("enforces the workspace sandbox and input validation", async () => {
    expect((await c.call("aseprite_inspect", { path: "../outside.aseprite" })).text).toContain("PATH_OUTSIDE_WORKSPACE");
    expect((await c.call("aseprite_export", { path: "hero.aseprite", output: "../../evil.png" })).text).toContain("PATH_OUTSIDE_WORKSPACE");
    const bad = await c.call("aseprite_edit", { path: "hero.aseprite", ops: [{ op: "rect", x: 0, y: 0, width: 0, height: 1, color: "#fff" }] });
    expect(bad.isError).toBe(true);
    const live = await c.call("aseprite_inspect", { live: true });
    expect(live.text).toContain("not connected");
  });
});

run("opt-in Lua escape hatch", () => {
  it("is available only with ASEPRITE_MCP_ALLOW_LUA", async () => {
    const c = await startClient({ ASEPRITE_MCP_ALLOW_LUA: "1" });
    try {
      const r = await c.call("run_lua", { code: "print('hi'); return 1 + 2" });
      expect(r.json).toEqual({ output: ["hi"], result: 3 });
    } finally {
      await c.close();
    }
  });
});
