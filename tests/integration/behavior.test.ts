// Behavioural tests for the 2.0 operation catalog against a real Aseprite.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeTileMapData } from "../../src/engines/godot.js";
import { hasAseprite, startClient, type TestClient } from "../helpers/client.js";

const suite = hasAseprite() ? describe : describe.skip;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

suite("2.0 behaviour (real Aseprite)", () => {
  let c: TestClient;
  const f = (p: string) => path.join(c.workdir, p);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await c.call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return r.json;
  };
  const op = async (id: string, args: Record<string, unknown> = {}, p?: string, extra: Record<string, unknown> = {}) => call("run_op", { op: id, args, path: p, ...extra });
  const batch = (p: string, ops: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => call("batch", { path: p, ops, ...extra });
  const pixels = async (p: string, args: Record<string, unknown> = {}) => (await op("pixels.read", args, p)).result;
  const colors = (g: { rows: string[]; legend: Record<string, string> }) => g.rows.map((r) => [...r].map((ch) => (ch === "." ? "." : g.legend[ch])));

  beforeAll(async () => {
    c = await startClient({ ASEPRITE_MCP_COVERAGE_FILE: path.resolve("tests/.coverage/behavior.txt") });
  });
  afterAll(async () => {
    await c?.close();
  });

  it("starts with a compact core interface", async () => {
    const tools = (await c.client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["batch", "capabilities", "changes", "checkpoint", "describe_ops", "inspect", "jobs", "preview", "restore", "run_op", "search_ops"]);
    const cap = await call("capabilities", {});
    expect(cap.catalog.operations).toBeGreaterThanOrEqual(200);
  });

  it("finds operations and validates args against each op's own schema", async () => {
    const s = await call("search_ops", { query: "flood fill" });
    expect(s.items[0].id).toBe("draw.fill");
    const d = await call("describe_ops", { ops: ["draw.line"] });
    expect(d[0].args.properties.color).toBeDefined();
    expect(d[0].args.properties.x1.type).toBe("integer");
    await op("doc.create", { path: "v.aseprite", width: 4, height: 4 });
    const bad = await c.call("run_op", { op: "draw.rect", path: "v.aseprite", args: { x: 0, y: 0, width: 2, height: 2, colour: "#fff" } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/unknown field\(s\) colour/);
    const unknown = await c.call("run_op", { op: "draw.flod_fill", path: "v.aseprite", args: {} });
    expect(unknown.text).toMatch(/UNKNOWN_OPERATION.*Did you mean/s);
  });

  it("selection: booleans, read-back, fill and inSelection are pixel exact", async () => {
    await op("doc.create", { path: "sel.aseprite", width: 8, height: 8 });
    await batch("sel.aseprite", [
      { op: "sel.rect", x: 1, y: 1, width: 4, height: 3 },
      { op: "sel.rect", x: 3, y: 2, width: 4, height: 3, mode: "add" },
      { op: "sel.rect", x: 2, y: 2, width: 2, height: 2, mode: "subtract" },
    ]);
    const s = (await op("sel.read", {}, "sel.aseprite")).result;
    expect(s.rows).toEqual(["####..", "#..###", "#..###", "..####"]);
    expect(s.selected).toBe(16);
    await batch("sel.aseprite", [{ op: "sel.fill", color: "#ff0000" }, { op: "draw.rect", x: 0, y: 0, width: 8, height: 8, color: "#0000ff", filled: true, inSelection: true }]);
    const g = colors(await pixels("sel.aseprite"));
    expect(g[1]!.slice(1, 7)).toEqual(["#0000ff", "#0000ff", "#0000ff", "#0000ff", ".", "."]);
    expect(g[2]!.slice(1, 7)).toEqual(["#0000ff", ".", ".", "#0000ff", "#0000ff", "#0000ff"]);
    expect(g[0]!.every((x) => x === ".")).toBe(true);
    // wand on the blue region (diagonal off): 16 px; invert -> 48; expand grows by the ring
    await batch("sel.aseprite", [{ op: "sel.wand", x: 1, y: 1 }]);
    expect((await op("sel.info", {}, "sel.aseprite")).result.selected).toBe(16);
    await batch("sel.aseprite", [{ op: "sel.invert" }]);
    expect((await op("sel.info", {}, "sel.aseprite")).result.selected).toBe(48);
    await batch("sel.aseprite", [{ op: "sel.none" }, { op: "sel.rect", x: 3, y: 3, width: 1, height: 1 }, { op: "sel.expand", by: 1 }]);
    expect((await op("sel.read", {}, "sel.aseprite")).result.rows).toEqual([".#.", "###", ".#."]);
    await batch("sel.aseprite", [{ op: "sel.feather", radius: 1 }]);
    expect((await op("sel.read", {}, "sel.aseprite")).result.rows).toEqual(["..+..", ".+#+.", "+###+", ".+#+.", "..+.."]);
  });

  it("transforms preserve pixels and palettes", async () => {
    await op("doc.create", { path: "xf.aseprite", width: 9, height: 9 });
    await batch("xf.aseprite", [{ op: "draw.pixel_map", x: 2, y: 2, rows: ["AAB", "A.B", "CCB"], legend: { A: "#ff0000", B: "#00ff00", C: "#0000ff" } }]);
    await op("doc.duplicate", { to: "xf_orig.aseprite" }, "xf.aseprite");
    await batch("xf.aseprite", [{ op: "xf.flip", direction: "horizontal" }, { op: "xf.flip", direction: "horizontal" }, { op: "xf.rotate", angle: 90 }, { op: "xf.rotate", angle: 270 }]);
    expect((await op("view.compare", { frameA: 1, other: "xf_orig.aseprite" }, "xf.aseprite", { detail: "normal" })).info.identical).toBe(true);
    await batch("xf.aseprite", [{ op: "doc.scale", factor: 3 }, { op: "doc.scale", width: 9, height: 9 }]);
    expect((await op("view.compare", { frameA: 1, other: "xf_orig.aseprite" }, "xf.aseprite")).info.identical).toBe(true);
    await batch("xf.aseprite", [{ op: "xf.rotate_nn", angle: 33 }, { op: "xf.shear", x: 0.4 }]);
    const used = Object.values((await pixels("xf.aseprite")).legend).sort();
    expect(used.every((col) => ["#0000ff", "#00ff00", "#ff0000"].includes(col as string))).toBe(true); // no new colors
  });

  it("stale versions are rejected and failing batches leave files byte-identical", async () => {
    await op("doc.create", { path: "st.aseprite", width: 4, height: 4 });
    const v1 = (await call("inspect", { path: "st.aseprite" })).version;
    const r = await batch("st.aseprite", [{ op: "draw.pixels", pixels: [{ x: 0, y: 0, color: "#fff" }] }], { expectVersion: v1 });
    expect(r.prevVersion).toBe(v1);
    expect(r.version).not.toBe(v1);
    expect(r.changed.regions[0]).toMatchObject({ layer: "Layer 1", frame: 1, x: 0, y: 0, w: 1, h: 1, pixels: 1 });
    const before = sha(f("st.aseprite"));
    const stale = await c.call("batch", { path: "st.aseprite", expectVersion: v1, ops: [{ op: "draw.pixels", pixels: [{ x: 1, y: 1, color: "#fff" }] }] });
    expect(stale.text).toMatch(/STALE_VERSION/);
    const failing = await c.call("batch", { path: "st.aseprite", ops: [{ op: "draw.pixels", pixels: [{ x: 2, y: 2, color: "#fff" }] }, { op: "layer.delete", layer: "nope" }] });
    expect(failing.text).toMatch(/op #2 \(layer.delete\)/);
    expect(sha(f("st.aseprite"))).toBe(before);
  });

  it("recipes are all-or-nothing across files", async () => {
    await op("doc.create", { path: "r1.aseprite", width: 4, height: 4, layers: ["a"] });
    await op("doc.create", { path: "r2.aseprite", width: 4, height: 4, layers: ["b"] });
    const h1 = sha(f("r1.aseprite"));
    const h2 = sha(f("r2.aseprite"));
    const r = await c.call("run_op", { op: "recipe.run", args: { files: ["r1.aseprite", "r2.aseprite"], ops: [{ op: "draw.rect", layer: "a", x: 0, y: 0, width: 2, height: 2, color: "#fff" }] } });
    expect(r.isError).toBe(true); // r2 has no layer 'a'
    expect(sha(f("r1.aseprite"))).toBe(h1);
    expect(sha(f("r2.aseprite"))).toBe(h2);
    const ok = await op("recipe.run", { files: ["r1.aseprite", "r2.aseprite"], ops: [{ op: "layer.add", name: "shade" }] });
    expect(ok.result.files).toHaveLength(2);
  });

  it("recovers from an interrupted transaction (journal)", async () => {
    await op("doc.create", { path: "cr.aseprite", width: 4, height: 4 });
    const v = (await call("inspect", { path: "cr.aseprite" })).version;
    // simulate a crash after staging: a journal entry plus a half-written working copy
    const work = f(".cr.mcp-deadbeef.aseprite");
    writeFileSync(work, "partial");
    mkdirSync(f(".aseprite-mcp/journal"), { recursive: true });
    writeFileSync(f(".aseprite-mcp/journal/cr.aseprite.json"), JSON.stringify({ id: "x", target: f("cr.aseprite"), work, beforeVersion: v, state: "staged", pid: 1, at: new Date().toISOString() }));
    const r = await batch("cr.aseprite", [{ op: "draw.pixels", pixels: [{ x: 0, y: 0, color: "#fff" }] }]);
    expect(r.recovered.action).toBe("rolled-back");
    expect(existsSync(work)).toBe(false);
    // simulate a crash after the original vanished: restored from the journal's checkpoint
    const cp = (await call("checkpoint", { path: "cr.aseprite", action: "create", label: "safe" })).checkpoint;
    const good = sha(f("cr.aseprite"));
    writeFileSync(f(".aseprite-mcp/journal/cr.aseprite.json"), JSON.stringify({ id: "y", target: f("cr.aseprite"), work: f(".cr.mcp-00000000.aseprite"), checkpoint: cp, state: "committing", pid: 1, at: new Date().toISOString() }));
    const { rmSync } = await import("node:fs");
    rmSync(f("cr.aseprite"));
    const rec = await op("doc.recover", {});
    expect(rec.result.journals[0].action).toBe("restored-checkpoint");
    expect(sha(f("cr.aseprite"))).toBe(good);
  });

  it("caches inspections and previews by version and invalidates on change", async () => {
    await op("doc.create", { path: "ca.aseprite", width: 8, height: 8 });
    const a = await call("inspect", { path: "ca.aseprite" });
    const b = await call("inspect", { path: "ca.aseprite" });
    expect(b.cached).toBe(true);
    expect(b.version).toBe(a.version);
    const p1 = await c.call("preview", { path: "ca.aseprite" });
    const p2 = await c.call("preview", { path: "ca.aseprite" });
    expect(p2.text).toMatch(/"cached":true/);
    expect(p1.images[0]).toBe(p2.images[0]);
    await batch("ca.aseprite", [{ op: "draw.pixels", pixels: [{ x: 1, y: 1, color: "#f00" }] }]);
    const d = await call("inspect", { path: "ca.aseprite" });
    expect(d.cached).toBeUndefined();
    expect(d.version).not.toBe(a.version);
  });

  it("bounded undo/redo across several steps, change log and checkpoint diff", async () => {
    await op("doc.create", { path: "ur.aseprite", width: 4, height: 1 });
    const hashes = [sha(f("ur.aseprite"))];
    for (const x of [0, 1, 2]) {
      await batch("ur.aseprite", [{ op: "draw.pixels", pixels: [{ x, y: 0, color: "#fff" }] }]);
      hashes.push(sha(f("ur.aseprite")));
    }
    await call("restore", { path: "ur.aseprite", action: "undo", steps: 2 });
    expect(sha(f("ur.aseprite"))).toBe(hashes[1]);
    await call("restore", { path: "ur.aseprite", action: "redo" });
    expect(sha(f("ur.aseprite"))).toBe(hashes[2]);
    await call("restore", { path: "ur.aseprite", action: "redo" });
    expect(sha(f("ur.aseprite"))).toBe(hashes[3]);
    const log = await call("changes", { path: "ur.aseprite" });
    expect(log.entries.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["create", "edit", "undo", "redo"]));
    const cps = (await call("checkpoint", { path: "ur.aseprite", action: "list" })).checkpoints;
    const diff = await call("changes", { path: "ur.aseprite", against: cps[0].id });
    expect(diff.changedFrames[0].pixels).toBeGreaterThan(0);
  });

  it("animation timing survives editing and export", async () => {
    await op("doc.create", { path: "t.aseprite", width: 8, height: 8, animations: [{ name: "idle", frames: 2, durationMs: 200 }, { name: "attack", frames: 3, durationMs: 100 }] });
    await batch("t.aseprite", [
      { op: "frame.set_duration", tag: "attack", durations: [150, 50, 100] },
      { op: "frame.scale_timing", tag: "idle", factor: 1.5 },
      { op: "draw.rect", x: 1, y: 1, width: 3, height: 3, color: "#fff", filled: true, frames: [1, 2, 3, 4, 5] },
      { op: "cel.move", frame: 4, dx: 2 },
    ]);
    const rep = (await op("anim.timing_report", {}, "t.aseprite")).result;
    expect(rep.tags.map((t: { totalMs: number }) => t.totalMs)).toEqual([600, 300]);
    const ex = await op("sheet.export", { output: "out/t.png" }, "t.aseprite");
    const data = JSON.parse(readFileSync(f("out/t.json"), "utf8"));
    expect(data.frames.map((x: { duration: number }) => x.duration)).toEqual([300, 300, 150, 50, 100]);
    expect(ex.artifacts.map((a: { path: string }) => a.path)).toEqual(["out/t.png", "out/t.json"]);
    expect((await op("check.artifact", { files: ["out/t.json", "out/t.png"] })).result.valid).toBe(true);
    await op("engine.godot_sprite_frames", { output: "g/t.png" }, "t.aseprite");
    const tres = readFileSync(f("g/t.tres"), "utf8");
    expect(tres).toContain('"name": &"attack"');
    expect(tres).toMatch(/"duration": 3\.0,\n"texture"/); // 150 ms at a 50 ms base
    await op("engine.phaser", { output: "w/t.png" }, "t.aseprite");
    const anims = JSON.parse(readFileSync(f("w/t.anims.json"), "utf8")).anims;
    expect(anims[1].frames.map((x: { duration: number }) => x.duration)).toEqual([150, 50, 100]);
    expect(JSON.parse(readFileSync(f("w/t.json"), "utf8")).frames["0"]).toBeDefined(); // {frame} names for load.aseprite
  });

  it("in-betweens are reviewable and reversible", async () => {
    await op("doc.create", { path: "ib.aseprite", width: 16, height: 8, frames: 2 });
    await batch("ib.aseprite", [
      { op: "draw.rect", x: 0, y: 2, width: 3, height: 3, color: "#fff", filled: true, frame: 1 },
      { op: "draw.rect", x: 12, y: 2, width: 3, height: 3, color: "#fff", filled: true, frame: 2 },
    ]);
    await op("doc.duplicate", { to: "ib_orig.aseprite" }, "ib.aseprite");
    const r = await batch("ib.aseprite", [{ op: "anim.inbetween", fromFrame: 1, toFrame: 2, count: 3, id: "slide" }]);
    expect(r.results[0].frames).toEqual([2, 3, 4]);
    const tags = (await op("tag.list", {}, "ib.aseprite")).result.items;
    expect(tags.map((t: { name: string }) => t.name)).toContain("mcp:inbetween:slide");
    const mid = colors(await pixels("ib.aseprite", { frame: 3 }));
    expect(mid[3]!.indexOf("#ffffff")).toBe(6); // halfway between x=0 and x=12
    await batch("ib.aseprite", [{ op: "anim.remove_generated", id: "slide" }]);
    const info = await call("inspect", { path: "ib.aseprite", detail: "full", fields: ["frameCount", "tags"] });
    expect(info.frameCount).toBe(2);
    expect(info.tags).toEqual([]);
    for (const fr of [1, 2]) expect((await op("view.compare", { frameA: fr, other: "ib_orig.aseprite" }, "ib.aseprite")).info.identical).toBe(true);
  });

  it("tilemaps: paint, fill, replace, dedupe, autotile, seams, export", async () => {
    await op("doc.create", { path: "tm.aseprite", width: 32, height: 16 });
    const solid = (ch: string) => Array.from({ length: 4 }, () => ch.repeat(4));
    await batch("tm.aseprite", [
      { op: "tile.create_layer", name: "map", tileWidth: 4, tileHeight: 4 },
      { op: "tile.add", layer: "map", rows: solid("g"), legend: { g: "#00ff00" } },
      { op: "tile.add", layer: "map", rows: solid("r"), legend: { r: "#ff0000" } },
      { op: "tile.add", layer: "map", rows: solid("g"), legend: { g: "#00ff00" } }, // duplicate of 1
      { op: "tile.add", layer: "map", rows: ["gggr", "gggr", "gggr", "gggr"], legend: { g: "#00ff00", r: "#ff0000" } }, // does not wrap
      { op: "tile.paint", layer: "map", x: 0, y: 0, rows: ["ABAB", "CC.."], legend: { A: 1, B: 2, C: 3 } },
      { op: "tile.fill", layer: "map", x: 2, y: 1, tile: 4 },
    ]);
    let m = (await op("tile.read_map", { layer: "map" }, "tm.aseprite")).result;
    const asIdx = (mm: { rows: string[]; legend: Record<string, number> }) => mm.rows.map((r) => [...r].map((ch) => (ch === "." ? 0 : mm.legend[ch])));
    expect(asIdx(m).slice(0, 2)).toEqual([[1, 2, 1, 2, 4, 4, 4, 4], [3, 3, 4, 4, 4, 4, 4, 4]]);
    await batch("tm.aseprite", [{ op: "tile.replace", layer: "map", from: 2, to: 1 }, { op: "tile.dedupe", layer: "map" }]);
    m = (await op("tile.read_map", { layer: "map" }, "tm.aseprite")).result;
    const list = (await op("tile.list", { layer: "map" }, "tm.aseprite")).result;
    expect(list.tileset.count).toBe(3); // 3 merged into 1
    expect(asIdx(m)[1]!.slice(0, 2)).toEqual([1, 1]);
    const seams = (await op("tile.check_seams", { layer: "map", mode: "self" }, "tm.aseprite")).result;
    expect(seams.seams.map((s: { tile: number }) => s.tile)).toEqual([3]); // the half/half tile (re-indexed)
    await batch("tm.aseprite", [
      { op: "tile.terrain_set", layer: "map", terrain: "t", rules: { "0": 2, "2": 1, "8": 1, "10": 3 } },
      { op: "tile.autotile", layer: "map", terrain: "t", rows: ["###", "...", ".#."], x: 0, y: 1 },
    ]);
    m = (await op("tile.read_map", { layer: "map" }, "tm.aseprite")).result;
    expect(asIdx(m)[1]!.slice(0, 3)).toEqual([1, 3, 1]);
    expect(asIdx(m)[3]![1]).toBe(2);
    await batch("tm.aseprite", [{ op: "tile.collision_set", layer: "map", tile: 2, shape: "full" }]);
    mkdirSync(f("gd"), { recursive: true });
    writeFileSync(f("gd/project.godot"), "config_version=5\n");
    await op("engine.godot_tilemap_scene", { output: "gd/level.png" }, "tm.aseprite");
    const scene = readFileSync(f("gd/level.tscn"), "utf8");
    const bytes = /tile_map_data = PackedByteArray\(([^)]*)\)/.exec(scene)![1]!.split(",").map(Number);
    const cells = decodeTileMapData(bytes);
    const total = asIdx(m).flat().filter((x) => x! > 0).length;
    expect(cells).toHaveLength(total);
    expect(cells.find((x) => x.x === 1 && x.y === 1)).toMatchObject({ source: 0, ax: 0, ay: 1 }); // tile 3 -> atlas slot (0,1) in a 2-column atlas
    const ts = readFileSync(f("gd/level.tileset.tres"), "utf8");
    expect(ts).toContain("1:0/0/physics_layer_0/polygon_0/points = PackedVector2Array(-2, -2, 2, -2, 2, 2, -2, 2)");
    const v = (await op("engine.validate", { files: ["gd/level.tscn", "gd/level.tileset.tres"] })).result;
    expect(v.valid, JSON.stringify(v)).toBe(true);
  });

  it("re-exports incrementally and keeps Godot uids", async () => {
    await op("doc.create", { path: "inc.aseprite", width: 8, height: 8, frames: 2 });
    mkdirSync(f("gdi"), { recursive: true });
    writeFileSync(f("gdi/project.godot"), "config_version=5\n");
    const first = await op("engine.godot_sprite_frames", { output: "gdi/inc.png" }, "inc.aseprite");
    expect(first.result.upToDate).toBeUndefined();
    const tres = f("gdi/inc.tres");
    writeFileSync(tres, readFileSync(tres, "utf8").replace('format=3]', 'format=3 uid="uid://abc123"]'));
    // the hand edit changed an output -> not up to date -> regenerated, uid kept
    const again = await op("engine.godot_sprite_frames", { output: "gdi/inc.png" }, "inc.aseprite");
    expect(again.result.upToDate).toBeUndefined();
    expect(readFileSync(tres, "utf8")).toContain('uid="uid://abc123"');
    const third = await op("engine.godot_sprite_frames", { output: "gdi/inc.png" }, "inc.aseprite");
    expect(third.result.upToDate).toBe(true);
  });

  it("Unity re-export overwrites in place and keeps the .meta (GUID)", async () => {
    await op("doc.create", { path: "u.aseprite", width: 16, height: 16, frames: 2 });
    mkdirSync(f("uproj/Assets/Sprites"), { recursive: true });
    mkdirSync(f("uproj/ProjectSettings"), { recursive: true });
    writeFileSync(f("uproj/ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 6000.6.3f1\n");
    await op("engine.unity_aseprite", { output: "uproj/Assets/Sprites/u.aseprite", pixelsPerUnit: 16 }, "u.aseprite");
    const meta = f("uproj/Assets/Sprites/u.aseprite.meta");
    writeFileSync(meta, "fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\n");
    await batch("u.aseprite", [{ op: "draw.rect", x: 0, y: 0, width: 4, height: 4, color: "#fff" }]);
    const r = await op("engine.unity_aseprite", { output: "uproj/Assets/Sprites/u.aseprite", pixelsPerUnit: 16 }, "u.aseprite");
    expect(r.result.metaPreserved).toBe(true);
    expect(readFileSync(meta, "utf8")).toContain("0123456789abcdef0123456789abcdef");
    expect(sha(f("uproj/Assets/Sprites/u.aseprite"))).toBe(sha(f("u.aseprite")));
    expect(existsSync(f("uproj/Assets/Editor/AsepriteMcp/AsepriteMcpImportSettings.cs"))).toBe(true);
    const side = JSON.parse(readFileSync(f("uproj/Assets/Sprites/u.aseprite.aseprite-mcp.json"), "utf8"));
    expect(side).toMatchObject({ pixelsPerUnit: 16, importMode: "AnimatedSprite", pivot: { x: 0.5, y: 0 } });
    const pkg = await op("engine.unity_package", { project: "uproj" });
    expect(pkg.result.version).toBe("6.0.0");
  });

  it("background jobs report progress and can be cancelled", async () => {
    await op("doc.create", { path: "j.aseprite", width: 16, height: 16, frames: 6 });
    const j = await call("run_op", { op: "sheet.export_multipage", args: { output: "pages/p.png", maxWidth: 33, maxHeight: 16 }, path: "j.aseprite", background: true });
    expect(j.job).toMatch(/^job_/);
    let st;
    for (let i = 0; i < 100; i++) {
      st = await call("jobs", { action: "status", id: j.job });
      if (st.state === "done" || st.state === "failed") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(st.state).toBe("done");
    const res = await call("jobs", { action: "result", id: j.job });
    expect(res.result[0].result.pages).toBe(3);
    const many = [];
    for (let i = 0; i < 4; i++) many.push(await call("run_op", { op: "sheet.export", args: { output: `pages/q${i}.png` }, path: "j.aseprite", background: true }));
    const cancelled = await call("jobs", { action: "cancel", id: many[3].job });
    expect(cancelled.state).toBe("cancelled");
  });

  it("exports validate for every engine adapter; LÖVE module compiles; pygame loader runs", async () => {
    await op("doc.create", { path: "e.aseprite", width: 16, height: 16, animations: [{ name: "idle", frames: 2, durationMs: 150 }, { name: "run", frames: 3, durationMs: 80, direction: "pingpong" }] });
    await batch("e.aseprite", [{ op: "draw.rect", x: 4, y: 4, width: 8, height: 12, color: "#38b764", filled: true, frames: [1, 2, 3, 4, 5] }, { op: "xf.set_pivot", anchor: "feet" }]);
    const outs: Record<string, string> = { "engine.pixi": "pixi/e.png", "engine.cocos": "cocos/e.png", "engine.defold": "defold/e.png", "engine.gamemaker": "gm/e.png", "engine.love": "love/e.png", "engine.pygame": "pg/e.png", "engine.unity_sheet": "us/e.png", "engine.godot_sample_scene": "gs/e.png", "engine.godot_animation_library": "gs/e.png" };
    mkdirSync(f("gs"), { recursive: true });
    writeFileSync(f("gs/project.godot"), "config_version=5\n");
    for (const [id, out] of Object.entries(outs)) await op(id, { output: out, force: true }, "e.aseprite");
    const v = (await op("engine.validate", { files: ["pixi/e.json", "cocos/e.plist", "defold/e.atlas", "gs/e.tscn", "gs/e.tres", "gs/e.anims.tres", "us/e.json"] })).result;
    expect(v.valid, JSON.stringify(v.results)).toBe(true);
    const pixi = JSON.parse(readFileSync(f("pixi/e.json"), "utf8"));
    expect(pixi.animations.run).toEqual(["e_2", "e_3", "e_4", "e_3"]); // pingpong expanded
    expect(pixi.frames.e_0.anchor).toEqual({ x: 0.5, y: 1 });
    expect(readdirSync(f("gm")).filter((n) => n.endsWith(".png")).sort()).toEqual(["e_idle_strip2.png", "e_run_strip3.png"]);
    expect(readFileSync(f("defold/e.atlas"), "utf8")).toContain("playback: PLAYBACK_LOOP_PINGPONG");
    const unity = JSON.parse(readFileSync(f("us/e.unity.json"), "utf8"));
    expect(unity.clips[0].lengthMs).toBe(300);
    // LÖVE module: compile + exercise with stubbed love.graphics inside Aseprite's Lua 5.4
    const lua = f("love/e.lua").replaceAll("\\", "/");
    const script = f("check_love.lua");
    writeFileSync(script, `love = { graphics = { newQuad = function(...) return {...} end } }
local m = dofile("${lua}")
local img = { getDimensions = function() return 64, 64 end, setFilter = function() end }
local a = m.new(img)
a:update(0.16)
local out = io.open("${f("love_result.txt").replaceAll("\\", "/")}", "w")
out:write(tostring(a:frameAt("idle")) .. "," .. tostring(#a.quads))
out:close()
`);
    const { spawnSync } = await import("node:child_process");
    const exe = process.env.ASEPRITE_PATH ?? (await import("../../src/config.js")).firstExisting((await import("../../src/config.js")).candidateExecutables())!;
    spawnSync(exe, ["-b", "--script", script], { windowsHide: true });
    expect(readFileSync(f("love_result.txt"), "utf8")).toBe("2,5"); // 160 ms into idle (150 ms frames) -> frame 2
    // pygame loader against a stub pygame module
    mkdirSync(f("pg/stub/pygame"), { recursive: true });
    writeFileSync(f("pg/stub/pygame/__init__.py"), "class Rect:\n    def __init__(self,*a): self.a=a\nclass _Img:\n    def subsurface(self, r): return r.a\nclass image:\n    @staticmethod\n    def load(p):\n        import os\n        assert os.path.exists(p), p\n        return _Img()\n");
    const py = spawnSync("python", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[2]); import aseprite_sheet as s; sh = s.SpriteSheet(sys.argv[3]); a = sh.animation('run'); a.update(170); surf, pos = a.blit_args((100, 100)); print(a.frame_index(), pos)", f("pg/stub"), f("pg"), f("pg/e.pygame.json")], { encoding: "utf8" });
    if (py.error) return; // python not installed: loader not exercised
    expect(py.stderr).toBe("");
    expect(py.stdout.trim()).toBe("4 (92, 84)"); // 170 ms -> third frame (index 4) of run; pivot (8,16), untrimmed
  });
});

void copyFileSync;
