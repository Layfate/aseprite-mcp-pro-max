import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { substitute } from "../../src/catalog/actions.js";
import { ADAPTERS } from "../../src/catalog/actions-engines.js";
import { CATALOG, argSchema, compactSchema, describe as describeOp, getOp, search, validateArgs, validateBatch } from "../../src/catalog/registry.js";
import { normalizeColors } from "../../src/colors.js";
import { cocosPlist, defoldAtlas, pixiSpritesheet } from "../../src/engines/formats.js";
import { animationLibrary, decodeTileMapData, existingUid, spriteFrames, tileMapData, tileSet } from "../../src/engines/godot.js";
import { buildModel, playback, validateModel, type SheetData } from "../../src/engines/model.js";
import { importerVersionFor, unitySheetMeta, unitySidecar } from "../../src/engines/unity.js";
import { formatPaletteFile, parsePaletteFile } from "../../src/palettes-io.js";
import { DocumentStore } from "../../src/runtime/documents.js";
import { JobQueue } from "../../src/runtime/jobs.js";
import { Checkpoints, commitFile } from "../../src/transaction.js";

describe("operation catalog", () => {
  it("has 200+ distinct, ordered, documented operations", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(200);
    const ids = CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
    for (const d of CATALOG) {
      expect(d.id).toMatch(/^[a-z]+\.[a-z_0-9]+$/);
      expect(d.summary.length).toBeLessThanOrEqual(110);
      if (d.kind === "action") expect(typeof d.run).toBe("function");
    }
  });

  it("every example is valid under its own schema", () => {
    for (const d of CATALOG) {
      expect(() => validateArgs(d, d.example.args), d.id).not.toThrow();
      if (d.example.setup) expect(() => validateBatch(d.example.setup!), d.id).not.toThrow();
    }
  });

  it("rejects unknown fields and wrong types, and suggests near ids", () => {
    expect(() => validateArgs(getOp("draw.rect"), { x: 0, y: 0, width: 1, height: 1, color: "#fff", colour: 1 })).toThrow(/unknown field/);
    expect(() => validateArgs(getOp("draw.rect"), { x: 0.5, y: 0, width: 1, height: 1, color: "#fff" })).toThrow(/x:/);
    expect(() => validateArgs(getOp("draw.line"), { color: "#fff", x1: 0 })).toThrow(/x1,y1,x2,y2/);
    try {
      getOp("draw.flod");
      expect.unreachable();
    } catch (e) {
      expect((e as { hint?: string }).hint).toMatch(/Did you mean: draw\./);
    }
    expect(() => validateBatch([{ op: "pixels.read" }])).toThrow(/query operation/);
  });

  it("searches deterministically", () => {
    expect(search("flood fill").items[0]!.id).toBe("draw.fill");
    expect(search("godot tileset").items[0]!.id).toBe("engine.godot_tileset");
    expect(search("lasso").items[0]!.id).toBe("sel.polygon");
    expect(search(undefined, { area: "tiles", limit: 100 }).items.every((x) => x.id.startsWith("tile."))).toBe(true);
    expect(JSON.stringify(search("palette"))).toBe(JSON.stringify(search("palette")));
    const page = search(undefined, { limit: 10, offset: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.nextOffset).toBe(20);
  });

  it("produces compact JSON schemas", () => {
    const d = describeOp(getOp("draw.rect")) as { args: { properties: Record<string, { type?: string }> } };
    expect(d.args.properties.x!.type).toBe("integer");
    expect(JSON.stringify(d)).not.toContain("$schema");
    expect(compactSchema({ type: "number", multipleOf: 1 })).toEqual({ type: "integer" });
    expect(argSchema(getOp("draw.rect"))).toBe(argSchema(getOp("draw.rect")));
  });

  it("substitutes preset parameters, keeping types", () => {
    expect(substitute({ a: "${n}", b: "x${n}", c: ["${c}"] }, { n: 3, c: "#fff" })).toEqual({ a: 3, b: "x3", c: ["#fff"] });
    expect(() => substitute("${missing}", {})).toThrow(/no value/);
  });

  it("normalizes colors only where colors are expected", () => {
    const out = normalizeColors({ op: "pal.remap", map: [{ from: "#000", to: 1 }], from: 2, to: 3, ramps: [["#fff"]], background: "checker" });
    expect(out).toEqual({ op: "pal.remap", map: [{ from: { r: 0, g: 0, b: 0, a: 255 }, to: { index: 1 } }], from: 2, to: 3, ramps: [[{ r: 255, g: 255, b: 255, a: 255 }]], background: "checker" });
    expect(normalizeColors({ legend: { A: 3 } }, { rawLegend: true })).toEqual({ legend: { A: 3 } });
  });
});

const sheet: SheetData = {
  frames: [0, 1, 2].map((i) => ({
    filename: `f${i}`,
    frame: { x: i * 17, y: 0, w: 16, h: i === 1 ? 12 : 16 },
    spriteSourceSize: { x: 0, y: i === 1 ? 4 : 0, w: 16, h: i === 1 ? 12 : 16 },
    sourceSize: { w: 16, h: 16 },
    duration: i === 2 ? 200 : 100,
  })),
  meta: {
    image: "cat.png",
    size: { w: 50, h: 16 },
    frameTags: [
      { name: "walk", from: 0, to: 2, direction: "pingpong" },
      { name: "hit", from: 2, to: 2, direction: "forward", repeat: "1" },
      { name: "mcp:inbetween:g1", from: 1, to: 1, direction: "forward" },
    ],
  },
};

describe("engine adapters", () => {
  const m = buildModel(sheet, { name: "cat", pivot: { x: 8, y: 16 } });

  it("builds the engine-neutral model (internal tags dropped, directions expanded)", () => {
    expect(m.animations.map((a) => a.name)).toEqual(["walk", "hit"]);
    expect(m.animations[0]!.sequence).toEqual([0, 1, 2, 1]);
    expect(m.animations[1]!.loop).toBe(false);
    expect(m.frames[1]!.trimmed).toBe(true);
    expect(validateModel(m)).toEqual([]);
    expect(playback(0, 3, "pingpong_reverse")).toEqual([3, 2, 1, 0, 1, 2]);
  });

  it("writes Godot SpriteFrames and AnimationLibrary", () => {
    const tres = spriteFrames(m, "res://sprites/cat.png", "uid://x1");
    expect(tres).toContain('[gd_resource type="SpriteFrames" format=3 uid="uid://x1"]');
    expect(existingUid(tres)).toBe("uid://x1");
    expect(tres).toContain("region = Rect2(17, 0, 16, 12)");
    expect(tres).toContain("margin = Rect2(0, 4, 0, 4)");
    expect(tres).toContain('"duration": 2.0');
    const lib = animationLibrary(m);
    expect(lib).toContain('tracks/0/path = NodePath("Sprite:region_rect")');
    expect(lib).toContain('"times": PackedFloat32Array(0, 0.1, 0.2, 0.4)');
    expect(lib).toContain("Vector2(-8, -12)"); // trimmed frame offset relative to the pivot
    expect(lib).toMatch(/_data = \{\n&"walk": SubResource\("Animation_0"\)/);
  });

  it("encodes TileMapLayer data and TileSet collision", () => {
    const ts = { name: "t", image: "t.png", atlas: { w: 16, h: 8 }, tileWidth: 8, tileHeight: 8, columns: 2, rows: 1, spacing: 0, tiles: [{ tile: 1, col: 0, row: 0, collision: { shape: "full" } }, { tile: 2, col: 1, row: 0 }] };
    const bytes = tileMapData({ layer: "g", cols: 4, rows: 4, tileWidth: 8, tileHeight: 8, cells: [[0, 0, 1, 0, 0, 0], [3, 2, 2, 1, 0, 0]] }, ts);
    expect(bytes.length).toBe(2 + 24);
    expect(decodeTileMapData(bytes)).toEqual([{ x: 0, y: 0, source: 0, ax: 0, ay: 0, alt: 0 }, { x: 3, y: 2, source: 0, ax: 1, ay: 0, alt: 4096 }]);
    const tres = tileSet(ts, "res://t.png");
    expect(tres).toContain("0:0/0/physics_layer_0/polygon_0/points = PackedVector2Array(-4, -4, 4, -4, 4, 4, -4, 4)");
    expect(tres).toContain("physics_layer_0/collision_layer = 1");
  });

  it("writes PixiJS, Defold and Cocos formats", () => {
    const pixi = pixiSpritesheet(m) as { frames: Record<string, { anchor: { x: number; y: number } }>; animations: Record<string, string[]> };
    expect(pixi.animations.walk).toEqual(["cat_0", "cat_1", "cat_2", "cat_1"]);
    expect(pixi.frames.cat_1!.anchor).toEqual({ x: 0.5, y: 1 });
    const atlas = defoldAtlas(m, "/assets/cat", (i) => `cat_${i}.png`);
    expect(atlas.text).toContain("playback: PLAYBACK_LOOP_PINGPONG");
    expect(atlas.text).toContain("fps: 10");
    expect((atlas.text.match(/image: "\/assets\/cat\/cat_2.png"/g) ?? []).length).toBe(1 + 2 + 1); // atlas entry + 2 steps in walk (100 ms base) + 1 in hit (its own 200 ms step)
    const plist = cocosPlist(m);
    expect(plist).toContain("<key>textureRect</key><string>{{17,0},{16,12}}</string>");
    expect(plist).toContain("<key>spriteOffset</key><string>{0,-2}</string>");
  });

  it("targets Unity's Aseprite Importer and the sprite data provider", () => {
    expect(importerVersionFor("6000.6.3f1")).toBe("6.0.0");
    expect(importerVersionFor("2022.3.10f1")).toBe("1.1.5");
    expect(unitySidecar(m)).toMatchObject({ pivot: { x: 0.5, y: 0 }, importMode: "AnimatedSprite", filterPoint: true });
    const meta = unitySheetMeta(m);
    expect(meta.sprites[1]).toMatchObject({ y: 16 - 0 - 12, pivotX: 0.5, pivotY: 0 });
    expect(meta.clips[0]!.lengthMs).toBe(500);
    expect(ADAPTERS.find((a) => a.id === "roblox")).toBeUndefined();
  });
});

describe("runtime", () => {
  it("versions documents and caches by version", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docs-"));
    const f = path.join(dir, "a.aseprite");
    writeFileSync(f, "one");
    const docs = new DocumentStore();
    const v1 = await docs.version(f);
    let computed = 0;
    const compute = async () => ++computed;
    expect((await docs.cached(f, "k", compute)).cached).toBe(false);
    expect((await docs.cached(f, "k", compute)).cached).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(f, "two!");
    expect(await docs.version(f)).not.toBe(v1);
    expect((await docs.cached(f, "k", compute)).value).toBe(2);
  });

  it("rejects stale versions and journals commits", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tx-"));
    const f = path.join(dir, "s.aseprite");
    writeFileSync(f, "v1");
    const docs = new DocumentStore();
    const cps = new Checkpoints(5);
    await expect(commitFile(f, cps, async (w) => writeFileSync(w, "x"), { expectVersion: "nope", docs })).rejects.toThrow(/STALE|is at version/);
    const r = await commitFile(f, cps, async (w) => writeFileSync(w, "v2"), { docs });
    expect(r.before).not.toBe(r.after);
    expect(existsSync(path.join(dir, ".aseprite-mcp", "journal", "s.aseprite.json"))).toBe(false);
    await docs.logChange(f, { at: "t", from: r.before, to: r.after!, kind: "edit" });
    expect((await docs.changes(f))[0]!.to).toBe(r.after);
  });

  it("keeps a bounded multi-step redo stack", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ur-"));
    const f = path.join(dir, "s.aseprite");
    writeFileSync(f, "v0");
    const cps = new Checkpoints(10);
    for (const v of ["v1", "v2", "v3"]) await commitFile(f, cps, async (w) => writeFileSync(w, v));
    await cps.undo(f, 3);
    expect(readFileSync(f, "utf8")).toBe("v0");
    await cps.redo(f, 2);
    expect(readFileSync(f, "utf8")).toBe("v2");
    await cps.redo(f);
    expect(readFileSync(f, "utf8")).toBe("v3");
    await expect(cps.redo(f)).rejects.toThrow(/nothing to redo/);
  });

  it("runs a bounded job queue with cancellation", async () => {
    const q = new JobQueue(1, 2, 5000);
    const order: string[] = [];
    const slow = (tag: string) => async (signal: AbortSignal) => {
      order.push(tag);
      await new Promise((res, rej) => {
        const t = setTimeout(res, 50);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("aborted"));
        });
      });
      return tag;
    };
    const a = q.submit("a", slow("a"));
    const b = q.submit("b", slow("b"));
    q.submit("c", slow("c"));
    expect(() => q.submit("d", slow("d"))).toThrow(/queue is full/);
    expect(q.cancel(b.id).state).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 200));
    expect(q.status(a.id).state).toBe("done");
    expect(order).toEqual(["a", "c"]);
  });
});

describe("palette files", () => {
  it("round-trips gpl, pal, hex and paint.net txt", () => {
    const colors = ["#000000", "#ff004d", "#29adff"];
    for (const ext of [".gpl", ".pal", ".hex", ".txt"]) expect(parsePaletteFile(formatPaletteFile(colors, ext, "t"), ext).colors).toEqual(colors);
    expect(() => parsePaletteFile("nope", ".gpl")).toThrow(/GIMP/);
  });
});
