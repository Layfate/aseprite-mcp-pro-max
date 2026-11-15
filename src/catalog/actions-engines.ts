import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { McpToolError } from "../errors.js";
import {
  artifact, copyAtomic, godotResPath, modelFor, recordExport, tilesFor, unityProjectRoot, upToDate, writeAtomic, type SheetOptions,
} from "../engines/export.js";
import { cocosAnimations, cocosPlist, defoldAtlas, gamemakerNotes, gamemakerStripName, loveModule, phaserAnims, phaserLoader, pixiSpritesheet, pygameData, pygameLoader } from "../engines/formats.js";
import { animationLibrary, decodeTileMapData, existingUid, sampleScene, spriteFrames, tileMapImportScript, tileMapScene, tileSet } from "../engines/godot.js";
import type { AssetModel } from "../engines/model.js";
import { asepriteImporterScript, importerVersionFor, sheetImporterScript, unitySheetMeta, unitySidecar, validationScript, UNITY_IMPORTER_PACKAGE } from "../engines/unity.js";
import { int } from "./common.js";
import { op, type ActionResult, type Artifact, type OpDef, type RunEnv } from "./types.js";

export interface AdapterInfo {
  id: string;
  engine: string;
  adapterVersion: string;
  level: "native" | "import-helper" | "generic-atlas";
  engineVersions: string;
  outputs: string;
  verified: string;
}

/** Versioned compatibility matrix. `verified` states exactly what was tested. */
export const ADAPTERS: AdapterInfo[] = [
  { id: "godot", engine: "Godot", adapterVersion: "2.0.0", level: "native", engineVersions: "4.0+ (TileMapLayer: 4.3+)", outputs: "SpriteFrames .tres, AnimationLibrary .tres, TileSet .tres, TileMapLayer .tscn, sample scene", verified: "structural tests only (format from Godot docs; not loaded in Godot in this run)" },
  { id: "unity", engine: "Unity 2D", adapterVersion: "2.0.0", level: "native", engineVersions: "2021.3+ with com.unity.2d.aseprite (6.0.x for 6000.6)", outputs: ".aseprite into Assets + importer settings postprocessor; sheet + sprite-slicing/clip helper", verified: "C# generated from the Aseprite Importer 8.0 / Sprite Editor data provider API docs; not compiled in Unity in this run" },
  { id: "phaser", engine: "Phaser 3", adapterVersion: "2.0.0", level: "import-helper", engineVersions: "3.50+", outputs: "Aseprite JSON hash ({frame} names) for load.aseprite + anims JSON for anims.fromJSON", verified: "structural tests only" },
  { id: "pixi", engine: "PixiJS", adapterVersion: "2.0.0", level: "import-helper", engineVersions: "7.x, 8.x", outputs: "Spritesheet JSON with frames, anchors and animations", verified: "structural tests only" },
  { id: "gamemaker", engine: "GameMaker", adapterVersion: "2.0.0", level: "import-helper", engineVersions: "2.3+ / 2024+", outputs: "<name>_<anim>_stripN.png per tag + origin/speed notes", verified: "structural tests only" },
  { id: "defold", engine: "Defold", adapterVersion: "2.0.0", level: "import-helper", engineVersions: "1.4+", outputs: "per-frame PNGs + .atlas with animations (playback, fps)", verified: "structural tests only (fields from atlas_ddf.proto)" },
  { id: "cocos", engine: "Cocos Creator", adapterVersion: "2.0.0", level: "import-helper", engineVersions: "2.4, 3.x", outputs: "Cocos2d-x plist (format 3) atlas + animation definitions", verified: "structural tests only" },
  { id: "love", engine: "LÖVE", adapterVersion: "2.0.0", level: "import-helper", engineVersions: "11.x", outputs: "sheet + Lua module with quads, pivot and timed animations", verified: "module compiled by Lua 5.4 (Aseprite) in tests; not run in LÖVE" },
  { id: "pygame", engine: "Pygame", adapterVersion: "2.0.0", level: "import-helper", engineVersions: "2.x", outputs: "sheet + JSON + loader.py", verified: "loader executed with Python against a pygame stub in tests; pygame itself not installed" },
  { id: "generic", engine: "any", adapterVersion: "2.0.0", level: "generic-atlas", engineVersions: "-", outputs: "Aseprite sheet PNG + JSON (array or hash)", verified: "export fidelity tested against real Aseprite" },
];

const pngOut = z.string().min(1).max(4096).describe("Output .png path for the sheet; other files go beside it");
const sheetArgs = {
  scale: int().min(1).max(16).optional(),
  padding: int().min(0).max(16).optional(),
  trim: z.boolean().optional(),
  tag: z.string().max(256).optional(),
  force: z.boolean().optional(),
};

interface EngineCall {
  args: Record<string, unknown>;
  env: RunEnv;
  out: string;
  dir: string;
  files: string[];
  warnings: string[];
  data: Record<string, unknown>;
}

/** Shared wrapper: sandbox the output, skip when up to date (incremental re-export), record the manifest. */
function engineAction(
  id: string,
  summary: string,
  shape: Record<string, z.ZodType>,
  example: Record<string, unknown>,
  write: (c: EngineCall) => Promise<void>,
  o: { outExt?: string[]; keywords?: string[]; notes?: string } = {},
): OpDef {
  return op(id, "engines", "action", summary, { output: pngOut, ...sheetArgs, ...shape }, { args: example }, {
    doc: "required",
    requires: ["aseprite", "node"],
    keywords: o.keywords,
    notes: o.notes,
    slow: true,
    run: async (args, env) => {
      const out = env.ctx.outputPath(String(args.output), o.outExt ?? [".png"]);
      const dir = path.dirname(out);
      await mkdir(dir, { recursive: true });
      const version = (await env.ctx.docs.version(env.file!))!;
      const key = `${id}:${path.basename(out)}`;
      const optsKey = { ...args, force: undefined };
      if (!args.force) {
        const hit = await upToDate(dir, key, version, optsKey);
        if (hit) {
          return { data: { upToDate: true, sourceVersion: version, files: Object.keys(hit.outputs) }, artifacts: [] };
        }
      }
      const c: EngineCall = { args, env, out, dir, files: [], warnings: [], data: {} };
      await write(c);
      await recordExport(dir, key, env.ctx.display(env.file)!, version, optsKey, c.files);
      const artifacts: Artifact[] = [];
      for (const f of [...new Set(c.files)]) artifacts.push(await artifact(env.ctx, f, path.extname(f).slice(1)));
      return { data: { sourceVersion: version, ...c.data }, artifacts, warnings: c.warnings.length ? c.warnings : undefined };
    },
  });
}

const sheetOpts = (a: Record<string, unknown>, extra: SheetOptions = {}): SheetOptions => ({
  sheetType: "packed",
  padding: (a.padding as number | undefined) ?? 1,
  trim: a.trim as boolean | undefined,
  scale: a.scale as number | undefined,
  tag: a.tag as string | undefined,
  ...extra,
});

async function model(c: EngineCall, extra: SheetOptions = {}): Promise<AssetModel> {
  const { model: m, json } = await modelFor(c.env.ctx, c.env.file!, c.out, sheetOpts(c.args, extra), c.env.signal);
  c.files.push(c.out, json);
  if (m.pivotSource === "default") c.warnings.push("no pivot set on the document; using bottom-center (set one with xf.set_pivot)");
  return m;
}

async function readIfExists(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

const stem = (out: string) => out.replace(/\.png$/i, "");

export const ENGINE_OPS: OpDef[] = [
  engineAction("engine.godot_sprite_frames", "Godot 4 SpriteFrames .tres (AnimatedSprite2D) + sheet; exact per-frame timing",
    { resPath: z.string().max(1024).optional() }, { output: "godot/hero.png" },
    async (c) => {
      const m = await model(c);
      const tres = `${stem(c.out)}.tres`;
      const r = godotResPath(c.out, c.args.resPath as string | undefined);
      if (r.warning) c.warnings.push(r.warning);
      await writeAtomic(tres, spriteFrames(m, r.res, existingUid(await readIfExists(tres))));
      c.files.push(tres);
      c.data.texture = r.res;
    }, { keywords: ["animatedsprite2d", "spriteframes"] }),
  engineAction("engine.godot_animation_library", "Godot 4 AnimationLibrary .tres (AnimationPlayer + Sprite2D region/offset tracks)",
    { nodePath: z.string().max(256).optional() }, { output: "godot/hero.png" },
    async (c) => {
      const m = await model(c);
      const lib = `${stem(c.out)}.anims.tres`;
      await writeAtomic(lib, animationLibrary(m, { nodePath: c.args.nodePath as string | undefined, uid: existingUid(await readIfExists(lib)) }));
      c.files.push(lib);
    }, { keywords: ["animationplayer"] }),
  engineAction("engine.godot_tileset", "Godot 4 TileSet .tres (atlas source, collision polygons from tile metadata)",
    { layer: z.string().max(512).optional(), resPath: z.string().max(1024).optional(), spacing: int().min(0).max(8).optional() }, { output: "godot/tiles.png" },
    async (c) => {
      const { tileset } = await tilesFor(c.env.ctx, c.env.file!, c.out, c.args.layer as string | undefined, (c.args.spacing as number) ?? 0, c.env.signal);
      const r = godotResPath(c.out, c.args.resPath as string | undefined);
      if (r.warning) c.warnings.push(r.warning);
      const tres = `${stem(c.out)}.tres`;
      await writeAtomic(tres, tileSet(tileset, r.res, existingUid(await readIfExists(tres))));
      c.files.push(c.out, tres);
      c.data.tiles = tileset.tiles.length;
    }),
  engineAction("engine.godot_tilemap_scene", "Godot 4.3+ scene with TileMapLayer nodes (+ TileSet, JSON and an EditorScript importer)",
    { layer: z.string().max(512).optional(), spacing: int().min(0).max(8).optional() }, { output: "godot/level.png" },
    async (c) => {
      const { tileset, maps } = await tilesFor(c.env.ctx, c.env.file!, c.out, c.args.layer as string | undefined, (c.args.spacing as number) ?? 0, c.env.signal);
      const texRes = godotResPath(c.out);
      const tsPath = `${stem(c.out)}.tileset.tres`;
      const tsRes = godotResPath(tsPath);
      if (texRes.warning) c.warnings.push(texRes.warning);
      await writeAtomic(tsPath, tileSet(tileset, texRes.res, existingUid(await readIfExists(tsPath))));
      const scene = `${stem(c.out)}.tscn`;
      await writeAtomic(scene, tileMapScene(maps, tileset, tsRes.res, path.basename(stem(c.out)), existingUid(await readIfExists(scene))));
      const json = `${stem(c.out)}.tilemap.json`;
      await writeAtomic(json, JSON.stringify({ tileset: { slots: Object.fromEntries(tileset.tiles.map((t) => [String(t.tile), [t.col, t.row]])) }, maps }));
      const gd = path.join(c.dir, "aseprite_mcp_import_tilemap.gd");
      await writeAtomic(gd, tileMapImportScript());
      c.files.push(c.out, tsPath, scene, json, gd);
      c.data.layers = maps.map((m) => ({ layer: m.layer, cells: m.cells.length }));
    }, { keywords: ["tilemaplayer", "level"] }),
  engineAction("engine.godot_sample_scene", "Godot sample scene: AnimatedSprite2D + Sprite2D/AnimationPlayer using the exports", {}, { output: "godot/hero.png" },
    async (c) => {
      const m = await model(c);
      const tex = godotResPath(c.out);
      const sf = `${stem(c.out)}.tres`;
      const lib = `${stem(c.out)}.anims.tres`;
      await writeAtomic(sf, spriteFrames(m, tex.res, existingUid(await readIfExists(sf))));
      await writeAtomic(lib, animationLibrary(m, { uid: existingUid(await readIfExists(lib)) }));
      const scene = `${stem(c.out)}.tscn`;
      await writeAtomic(scene, sampleScene(m, godotResPath(sf).res, godotResPath(lib).res, tex.res, existingUid(await readIfExists(scene))));
      c.files.push(sf, lib, scene);
      if (tex.warning) c.warnings.push(tex.warning);
    }),
  engineAction("engine.unity_aseprite", "Unity: copy the .aseprite into Assets (GUID-safe) + Aseprite Importer settings script",
    { pixelsPerUnit: z.number().positive().max(10000).optional(), importMode: z.enum(["AnimatedSprite", "SpriteSheet", "TileSet"]).optional() },
    { output: "unity/Assets/Sprites/hero.aseprite" },
    async (c) => {
      const m = await modelForMeta(c);
      await copyAtomic(c.env.file!, c.out); // in-place overwrite keeps the existing .meta (and GUID)
      const side = `${c.out}.aseprite-mcp.json`;
      await writeAtomic(side, JSON.stringify(unitySidecar(m, { pixelsPerUnit: c.args.pixelsPerUnit as number | undefined, importMode: c.args.importMode as never }), null, 2));
      const root = unityProjectRoot(c.dir);
      const editorDir = root ? path.join(root, "Assets", "Editor", "AsepriteMcp") : path.join(c.dir, "Editor", "AsepriteMcp");
      const s1 = path.join(editorDir, "AsepriteMcpImportSettings.cs");
      const s2 = path.join(editorDir, "AsepriteMcpValidate.cs");
      await writeAtomic(s1, asepriteImporterScript());
      await writeAtomic(s2, validationScript());
      c.files.push(c.out, side, s1, s2);
      c.data.metaPreserved = existsSync(`${c.out}.meta`);
      if (!root) c.warnings.push("no Unity project (Assets + ProjectSettings) found above the output; scripts were written next to it");
      c.data.package = `${UNITY_IMPORTER_PACKAGE} (run engine.unity_package to add it to Packages/manifest.json)`;
    }, { outExt: [".aseprite", ".ase"], keywords: ["unity", "aseprite importer"] }),
  engineAction("engine.unity_sheet", "Unity: sheet PNG + slicing/clip/controller editor script (keeps sprite IDs)",
    { pixelsPerUnit: z.number().positive().max(10000).optional() }, { output: "unity/Assets/Sprites/hero_sheet.png" },
    async (c) => {
      const m = await model(c);
      const meta = `${stem(c.out)}.unity.json`;
      await writeAtomic(meta, JSON.stringify(unitySheetMeta(m, c.args.pixelsPerUnit as number | undefined), null, 1));
      const root = unityProjectRoot(c.dir);
      const s = path.join(root ? path.join(root, "Assets") : c.dir, "Editor", "AsepriteMcp", "AsepriteMcpSheetImporter.cs");
      await writeAtomic(s, sheetImporterScript());
      c.files.push(meta, s);
    }, { keywords: ["sprite slicing", "animation clips", "animator", "pixels per unit"] }),
  op("engine.unity_package", "engines", "action", "Unity: add the matching com.unity.2d.aseprite version to Packages/manifest.json",
    { project: z.string().min(1).max(4096), version: z.string().max(32).optional() }, { args: { project: "unity" } }, {
      run: async (args, env) => {
        const root = env.ctx.outputPath(String(args.project));
        const pv = await readIfExists(path.join(root, "ProjectSettings", "ProjectVersion.txt"));
        const unity = /m_EditorVersion:\s*(\S+)/.exec(pv ?? "")?.[1];
        const version = (args.version as string | undefined) ?? importerVersionFor(unity ?? "");
        const manifestPath = path.join(root, "Packages", "manifest.json");
        const manifest = JSON.parse((await readIfExists(manifestPath)) ?? '{"dependencies":{}}') as { dependencies: Record<string, string> };
        const before = manifest.dependencies[UNITY_IMPORTER_PACKAGE];
        manifest.dependencies[UNITY_IMPORTER_PACKAGE] = version;
        await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        return {
          data: { unityVersion: unity ?? "unknown (no ProjectSettings/ProjectVersion.txt)", package: UNITY_IMPORTER_PACKAGE, version, previous: before },
          artifacts: [await artifact(env.ctx, manifestPath, "json")],
          warnings: unity ? undefined : ["Unity version unknown; defaulted the importer version. Pass version to override."],
        };
      },
    }),
  engineAction("engine.phaser", "Phaser 3: Aseprite JSON hash for load.aseprite + anims JSON + loader snippet", {}, { output: "web/hero.png" },
    async (c) => {
      const m = await model(c, { dataFormat: "json-hash", filenameFormat: "{frame}" });
      const anims = `${stem(c.out)}.anims.json`;
      await writeAtomic(anims, JSON.stringify(phaserAnims(m, m.name)));
      const js = `${stem(c.out)}.phaser.js`;
      await writeAtomic(js, phaserLoader(m, m.name, path.basename(c.out), path.basename(`${stem(c.out)}.json`), path.basename(anims)));
      c.files.push(anims, js);
    }),
  engineAction("engine.pixi", "PixiJS spritesheet JSON (frames, anchors from the pivot, animations)", {}, { output: "web/hero_pixi.png" },
    async (c) => {
      const m = await model(c);
      const json = `${stem(c.out)}.json`;
      await writeAtomic(json, JSON.stringify(pixiSpritesheet(m)));
      c.files.push(json);
    }),
  engineAction("engine.gamemaker", "GameMaker: one <name>_<tag>_stripN.png per tag + origin/speed notes", {}, { output: "gm/hero.png" },
    async (c) => {
      const info = await c.env.ctx.aseprite.engine<{ sprite: { tags: Array<{ name: string; from: number; to: number }>; frameCount: number } }>({ cmd: "inspect", input: c.env.file, paletteColors: false });
      const tags = info.sprite.tags.filter((t) => !t.name.startsWith("mcp:"));
      const list = tags.length ? tags : [{ name: "default", from: 1, to: info.sprite.frameCount }];
      const strips: Array<{ file: string; anim: string; frames: number; fps: number }> = [];
      let m: AssetModel | undefined;
      for (const t of list) {
        const n = t.to - t.from + 1;
        const file = path.join(c.dir, gamemakerStripName(path.basename(stem(c.out)), t.name, n));
        const r = await modelFor(c.env.ctx, c.env.file!, file, { sheetType: "horizontal", ...(tags.length ? { tag: t.name } : {}), scale: c.args.scale as number | undefined }, c.env.signal);
        m = r.model;
        const ms = r.model.frames[0]?.durationMs ?? 100;
        strips.push({ file: path.basename(file), anim: t.name, frames: n, fps: Math.round(100000 / ms) / 100 });
        c.files.push(file);
        await import("node:fs/promises").then((f) => f.rm(r.json, { force: true }));
      }
      const notes = `${stem(c.out)}.gamemaker.json`;
      await writeAtomic(notes, JSON.stringify(gamemakerNotes(m!, strips), null, 1));
      c.files.push(notes);
      c.data.strips = strips.map((s) => s.file);
    }, { keywords: ["strip", "yoyo"] }),
  engineAction("engine.defold", "Defold: per-frame PNGs + .atlas with animations (playback, fps)",
    { projectDir: z.string().max(1024).optional() }, { output: "defold/hero.png" },
    async (c) => {
      const m = await model(c);
      const base = path.basename(stem(c.out));
      const frameDir = path.join(c.dir, `${base}_frames`);
      await mkdir(frameDir, { recursive: true });
      const args = ["-b", c.env.file!];
      if (c.args.scale && c.args.scale !== 1) args.push("--scale", String(c.args.scale));
      args.push("--save-as", path.join(frameDir, `${base}_{frame}.png`));
      const run = await c.env.ctx.aseprite.run(args, undefined, c.env.signal);
      if (run.code !== 0) throw new McpToolError("ASEPRITE_FAILED", "frame export failed", run.stderr.slice(0, 1000));
      const projDir = (c.args.projectDir as string | undefined) ?? `/${path.basename(c.dir)}/${base}_frames`;
      const pad = String(m.frames.length - 1).length;
      const frameFile = (i: number) => `${base}_${m.frames.length > 1 ? String(i).padStart(pad, "0") : "0"}.png`;
      const names = await readdir(frameDir);
      // Aseprite pads {frame} to the frame count width; detect the real naming
      const real = (i: number) => names.find((n) => n === frameFile(i)) ?? names.find((n) => n === `${base}_${i}.png`) ?? frameFile(i);
      const atlas = defoldAtlas(m, projDir, real);
      const atlasPath = `${stem(c.out)}.atlas`;
      await writeAtomic(atlasPath, atlas.text);
      c.warnings.push(...atlas.warnings);
      c.files.push(atlasPath, ...names.map((n) => path.join(frameDir, n)));
    }),
  engineAction("engine.cocos", "Cocos Creator: Cocos2d-x plist atlas (format 3) + animation definitions", {}, { output: "cocos/hero.png" },
    async (c) => {
      const m = await model(c);
      const plist = `${stem(c.out)}.plist`;
      await writeAtomic(plist, cocosPlist(m));
      const anims = `${stem(c.out)}.anims.json`;
      await writeAtomic(anims, JSON.stringify(cocosAnimations(m), null, 1));
      c.files.push(plist, anims);
    }),
  engineAction("engine.love", "LÖVE: sheet + Lua module (quads, pivot, timed animations)", {}, { output: "love/hero.png" },
    async (c) => {
      const m = await model(c);
      const lua = path.join(c.dir, `${m.name}.lua`);
      await writeAtomic(lua, loveModule(m));
      c.files.push(lua);
    }),
  engineAction("engine.pygame", "Pygame: sheet + JSON + loader.py (SpriteSheet/Animation classes)", {}, { output: "pygame/hero.png" },
    async (c) => {
      const m = await model(c);
      const json = `${stem(c.out)}.pygame.json`;
      await writeAtomic(json, JSON.stringify(pygameData(m)));
      const py = path.join(c.dir, "aseprite_sheet.py");
      await writeAtomic(py, pygameLoader());
      c.files.push(json, py);
    }),
  op("engine.matrix", "engines", "action", "Versioned compatibility matrix of engine adapters", {}, {}, {
    run: async () => ({ data: { adapters: ADAPTERS, levels: { native: "engine-native resources or the engine's official importer", "import-helper": "engine-specific files/scripts built from documented formats", "generic-atlas": "engine-agnostic sheet + JSON" } } }),
  }),
  op("engine.validate", "engines", "action", "Structurally validate exported engine files (references, rects, tile data, JSON shape)",
    { files: z.array(z.string().max(4096)).min(1).max(256) }, { args: { files: ["godot/hero.tres"] }, setup: [] }, {
      run: async (args, env) => {
        const results = [];
        for (const f of args.files as string[]) {
          const abs = env.ctx.outputPath(f);
          results.push({ file: f, ...(await validateEngineFile(abs)) });
        }
        return { data: { valid: results.every((r) => r.errors.length === 0), results } };
      },
    }),
];

/** Unity native path only needs the pivot/canvas; avoid writing a sheet. */
async function modelForMeta(c: EngineCall): Promise<AssetModel> {
  const tmp = await c.env.ctx.aseprite.tempPath(".png");
  try {
    const { model: m } = await modelFor(c.env.ctx, c.env.file!, tmp, { sheetType: "packed" }, c.env.signal);
    return m;
  } finally {
    const fs = await import("node:fs/promises");
    await fs.rm(tmp, { force: true });
    await fs.rm(tmp.replace(/\.png$/, ".json"), { force: true });
  }
}

function findProjectRoot(file: string, marker: string): string | undefined {
  let cur = path.dirname(file);
  for (;;) {
    if (existsSync(path.join(cur, marker))) return cur;
    const p = path.dirname(cur);
    if (p === cur) return undefined;
    cur = p;
  }
}

/** Structural checks per format. Returns errors (blocking) and notes. */
export async function validateEngineFile(file: string): Promise<{ format: string; errors: string[]; notes: string[] }> {
  const errors: string[] = [];
  const notes: string[] = [];
  if (!existsSync(file)) return { format: "missing", errors: ["file does not exist"], notes };
  const text = await readFile(file, "utf8");
  const ext = path.extname(file).toLowerCase();
  if (ext === ".tres" || ext === ".tscn") {
    if (!/^\[gd_(resource|scene)\b[^\]]*format=3/.test(text)) errors.push("missing Godot format=3 header");
    const root = findProjectRoot(file, "project.godot") ?? path.dirname(file);
    for (const m of text.matchAll(/\[ext_resource[^\]]*path="res:\/\/([^"]+)"/g)) {
      if (!existsSync(path.join(root, m[1]!))) errors.push(`ext_resource res://${m[1]} not found`);
    }
    const ids = new Set([...text.matchAll(/\[sub_resource [^\]]*id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of text.matchAll(/SubResource\("([^"]+)"\)/g)) if (!ids.has(m[1])) errors.push(`SubResource ${m[1]} is not defined`);
    for (const m of text.matchAll(/tile_map_data = PackedByteArray\(([^)]*)\)/g)) {
      const bytes = m[1]!.split(",").map((s) => Number(s.trim()));
      if ((bytes.length - 2) % 12 !== 0) errors.push("tile_map_data length is not 2 + 12*n");
      else notes.push(`tile_map_data: ${decodeTileMapData(bytes).length} cells`);
    }
    if (/\[node [^\]]*type="TileMapLayer"/.test(text)) notes.push("TileMapLayer requires Godot 4.3+");
    return { format: "godot", errors, notes };
  }
  if (ext === ".json") {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      return { format: "json", errors: [`invalid JSON: ${(e as Error).message}`], notes };
    }
    const meta = j.meta as { size?: { w: number; h: number }; image?: string } | undefined;
    if (j.frames && meta?.size) {
      const frames = Array.isArray(j.frames) ? (j.frames as Array<{ frame: { x: number; y: number; w: number; h: number } }>) : Object.values(j.frames as Record<string, { frame: { x: number; y: number; w: number; h: number } }>);
      for (const f of frames) {
        if (f.frame.x + f.frame.w > meta.size.w || f.frame.y + f.frame.h > meta.size.h) errors.push("a frame rect lies outside the atlas");
      }
      if (meta.image && !existsSync(path.join(path.dirname(file), meta.image))) errors.push(`atlas image ${meta.image} not found`);
      const anims = j.animations as Record<string, string[]> | undefined;
      if (anims && !Array.isArray(j.frames)) {
        for (const [name, list] of Object.entries(anims)) for (const n of list) if (!(n in (j.frames as object))) errors.push(`animation '${name}' references unknown frame '${n}'`);
      }
      notes.push(`${frames.length} frames`);
      return { format: "atlas-json", errors, notes };
    }
    if (Array.isArray(j.anims)) return { format: "phaser-anims", errors, notes: [`${(j.anims as unknown[]).length} animations`] };
    return { format: "json", errors, notes };
  }
  if (ext === ".atlas") {
    const root = findProjectRoot(file, "game.project") ?? path.dirname(path.dirname(file));
    for (const m of text.matchAll(/image: "([^"]+)"/g)) {
      const p = path.join(root, m[1]!);
      if (!existsSync(p)) notes.push(`image ${m[1]} not found relative to ${root} (expected inside a Defold project)`);
    }
    if (!/animations \{/.test(text)) errors.push("no animations");
    return { format: "defold-atlas", errors, notes };
  }
  if (ext === ".plist") {
    if (!/<key>frames<\/key>/.test(text) || !/<key>format<\/key><integer>3<\/integer>/.test(text)) errors.push("not a Cocos2d-x format 3 plist");
    return { format: "cocos-plist", errors, notes };
  }
  const s = await stat(file);
  return { format: ext.slice(1) || "file", errors, notes: [`${s.size} bytes`] };
}
