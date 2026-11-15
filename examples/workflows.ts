/**
 * End-to-end workflows, written the way a model drives the server (core tools only).
 * Used by tests/integration/workflows.test.ts and by examples/build-samples.ts, which
 * writes the outputs into the engine sample projects under examples/engines/.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Call = (tool: string, args: Record<string, unknown>) => Promise<any>;

const op = (call: Call, id: string, args: Record<string, unknown>, path?: string, extra: Record<string, unknown> = {}) => call("run_op", { op: id, args, path, ...extra });

// ---------------------------------------------------------------- 1. reference -> editable sprite

/** A reference render (upscaled 8x, flat background) becomes a clean, editable 16x16 sprite. */
export async function referenceToSprite(call: Call, dir = "ref"): Promise<Record<string, unknown>> {
  // make a stand-in "reference" (in real use: concept art, a screenshot or an AI image)
  await op(call, "doc.create", { path: `${dir}/source.aseprite`, width: 16, height: 16, background: "#c2c3c7", overwrite: true });
  await call("batch", { path: `${dir}/source.aseprite`, ops: [{ op: "draw.pixel_map", x: 3, y: 2, rows: SLIME, legend: SLIME_LEGEND }] });
  await op(call, "export.png", { output: `${dir}/reference.png`, scale: 8 }, `${dir}/source.aseprite`);
  const facts = (await op(call, "ref.analyze", { file: `${dir}/reference.png` })).result;
  const imported = await op(call, "ref.import", {
    image: `${dir}/reference.png`, path: `${dir}/slime.aseprite`, pixelSize: facts.pixelScale, removeBackground: "corners", palette: "pico-8", overwrite: true,
  });
  await call("batch", { path: `${dir}/slime.aseprite`, label: "cleanup", ops: [{ op: "clean.alpha" }, { op: "clean.stray_pixels" }, { op: "layer.set", layer: "Imported", name: "body" }] });
  const lint = (await op(call, "check.lint", { palette: "pico-8" }, `${dir}/slime.aseprite`)).result;
  const grid = (await op(call, "pixels.read", {}, `${dir}/slime.aseprite`)).result;
  return { facts, imported: imported.result, lint, grid };
}

const SLIME = [
  "....KKKKKK....",
  "...KGGGGGGK...",
  "..KGWWGGGGGK..",
  ".KGWGGGGGGGGK.",
  ".KGGKGGGKGGGK.",
  "KGGGKGGGKGGGGK",
  "KGGGGGGGGGGGGK",
  "KDGGGGGGGGGGDK",
  ".KDDGGGGGGDDK.",
  "..KKKKKKKKKK..",
];
const SLIME_LEGEND = { K: "#1d2b53", G: "#00e436", W: "#fff1e8", D: "#008751" };

// ---------------------------------------------------------------- 2. animated character, states x directions

const HERO = [
  ".....KKKKKK.....",
  "....KHHHHHhK....",
  "...KHHHHHHHhK...",
  "...KKKKKKKKKK...",
  "....KSSSSSSK....",
  "....KSKSSKSK....",
  "....KSSSSSSK....",
  ".....KSSSSK.....",
  "....KKBBBBKK....",
  "...KSKBBBBKSK...",
  "...KSKBWBBKSK...",
  "...KKKbBBbKKK...",
  ".....KbbbbK.....",
  ".....KLKKLK.....",
  ".....KLK.KLK....",
  ".....KKK.KKK....",
];
const HERO_LEGEND = { K: "#1a1c2c", H: "#b13e53", h: "#ef7d57", S: "#ffcd75", B: "#3b5dc9", b: "#29366f", W: "#f4f4f4", L: "#566c86" };
const LEGS_A = { runs: [{ x: 13, y: 21, s: "KLKKLK" }, { x: 13, y: 22, s: "KLK.KLK" }, { x: 13, y: 23, s: "KKK.KKK" }] };
const LEGS_B = { runs: [{ x: 13, y: 21, s: "KLKKLK." }, { x: 12, y: 22, s: "KLK..KLK" }, { x: 12, y: 23, s: "KKK..KKK" }] };

export async function animatedCharacter(call: Call, file = "hero/hero.aseprite"): Promise<Record<string, unknown>> {
  await op(call, "doc.create", { path: file, width: 32, height: 32, palette: "sweetie-16", layers: ["body"], overwrite: true });
  const v0 = (await call("inspect", { path: file })).version;
  await call("batch", {
    path: file, expectVersion: v0, label: "brief + key pose",
    ops: [
      {
        op: "brief.set",
        brief: {
          width: 32, height: 32, maxColors: 16, perspective: "side", outline: { color: "#1a1c2c", style: "black" }, light: "top-left",
          transparency: "binary", states: [{ name: "idle", frames: 2 }, { name: "walk", frames: 4 }], directions: ["e", "w"], pivot: "feet", engine: "godot",
        },
      },
      { op: "draw.pixel_map", layer: "body", x: 8, y: 8, rows: HERO, legend: HERO_LEGEND },
      { op: "xf.set_pivot", anchor: "feet", slice: true },
    ],
  });
  // states x directions laid out from the key pose (frame 1) so identity and palette carry over
  await call("batch", {
    path: file, label: "scaffold",
    ops: [
      { op: "anim.scaffold", states: [{ name: "idle", frames: 2, durationMs: 220 }, { name: "walk", frames: 4, durationMs: 110 }], directions: ["e"], baseFrame: 1 },
      { op: "anim.offset_sequence", layer: "body", tag: "idle_e", offsets: [{ dy: 0 }, { dy: 1 }] },
      { op: "draw.erase", layer: "body", frames: [4, 6], x: 12, y: 21, width: 9, height: 3 },
      { op: "draw.patch", layer: "body", frames: [4, 6], legend: HERO_LEGEND, ...LEGS_B },
      { op: "draw.patch", layer: "body", frames: [3, 5], legend: HERO_LEGEND, ...LEGS_A },
      { op: "anim.offset_sequence", layer: "body", tag: "walk_e", offsets: [{ dy: 0 }, { dy: 1 }] },
      { op: "anim.mirror_direction", tag: "idle_e", name: "idle_w" },
      { op: "anim.mirror_direction", tag: "walk_e", name: "walk_w" },
    ],
  });
  const brief = (await op(call, "check.brief", {}, file)).result;
  const identity = (await op(call, "check.identity", { tag: "walk_e" }, file)).result;
  const jitter = (await op(call, "check.jitter", {}, file)).result;
  const timing = (await op(call, "anim.timing_report", {}, file)).result;
  const sheet = await op(call, "view.contact_sheet", {}, file, { output: "file", saveTo: file.replace(/\.aseprite$/, "_contact.png") });
  return { brief, identity, jitter, timing, contactSheet: sheet.artifacts?.[0]?.path };
}

// ---------------------------------------------------------------- 3. seamless tileset + editable tilemap

const GRASS = ["gggggggg", "gGgggggg", "gggggGgg", "gggggggg", "ggGggggg", "gggggggg", "ggggggGg", "gggggggg"];
const DIRT = ["dddddddd", "dDdddddd", "dddddddd", "ddddDddd", "dddddddd", "ddDddddd", "dddddddd", "dddddddd"];
const EDGE = ["gggggggg", "gGgggggg", "gggggGgg", "gggggggg", "gggggggg", "KKKKKKKK", "dddddddd", "ddDddddd"];
const TL = { g: "#00e436", G: "#008751", d: "#ab5236", D: "#5f574f", K: "#1d2b53" };

export async function seamlessTileset(call: Call, file = "level/level.aseprite"): Promise<Record<string, unknown>> {
  await op(call, "doc.create", { path: file, width: 64, height: 32, palette: "pico-8", overwrite: true });
  await call("batch", {
    path: file, label: "tiles",
    ops: [
      { op: "tile.create_layer", name: "ground", tileWidth: 8, tileHeight: 8, tilesetName: "ground" },
      { op: "tile.add", layer: "ground", rows: GRASS, legend: TL },
      { op: "tile.add", layer: "ground", rows: DIRT, legend: TL },
      { op: "tile.add", layer: "ground", rows: EDGE, legend: TL },
      { op: "tile.variants", layer: "ground", tile: 1, noise: { colors: ["#008751"], density: 0.06, seed: 11, count: 1 } },
      { op: "tile.terrain_set", layer: "ground", terrain: "ground", rules: { "14": 3, "6": 3, "12": 3, "4": 3 }, default: 2 },
      { op: "tile.rect", layer: "ground", x: 0, y: 0, width: 8, height: 2, tile: 1 },
      { op: "tile.paint", layer: "ground", x: 2, y: 0, rows: ["D.D"], legend: { D: 4 } },
      { op: "tile.autotile", layer: "ground", terrain: "ground", rows: ["########", "########"], x: 0, y: 2 },
      { op: "tile.collision_set", layer: "ground", tiles: [2, 3], shape: "full" },
    ],
  });
  const seamsSelf = (await op(call, "tile.check_seams", { layer: "ground", mode: "self" }, file)).result;
  const seamsMap = (await op(call, "tile.check_seams", { layer: "ground", mode: "map" }, file)).result;
  const map = (await op(call, "tile.read_map", { layer: "ground" }, file)).result;
  const repeat = await op(call, "view.tile_repeat", { layer: "ground", tile: 1, columns: 4, rows: 2 }, file, { output: "file", saveTo: file.replace(/\.aseprite$/, "_grass_repeat.png") });
  return { seamsSelf, seamsMap, map, repeat: repeat.artifacts?.[0]?.path };
}

// ---------------------------------------------------------------- 4. modify an existing asset, then restore safely

export async function modifyAndRestore(call: Call, file = "hero/hero.aseprite"): Promise<Record<string, unknown>> {
  const original = (await call("inspect", { path: file })).version;
  const cp = (await call("checkpoint", { path: file, action: "create", label: "before experiment" })).checkpoint;
  const v1 = await call("batch", { path: file, expectVersion: original, label: "experiment", ops: [{ op: "pal.remap", map: [{ from: "#3b5dc9", to: "#38b764" }, { from: "#29366f", to: "#257179" }] }, { op: "draw.rim_light", layer: "body", light: "top-left", color: "#f4f4f4", onlyColors: ["#38b764"] }] });
  const diff = await call("changes", { path: file, against: cp });
  const variant = await op(call, "variant.create", { to: file.replace(/\.aseprite$/, "_green.aseprite"), overwrite: true }, file);
  const restored = await call("restore", { path: file, action: "restore", id: cp });
  const after = (await call("inspect", { path: file })).version;
  return { original, edited: v1.version, changedFrames: diff.changedFrames.length, variant: variant.result.to, restoredVersion: after, identical: after === original, restoredFrom: restored.restored };
}

// ---------------------------------------------------------------- 5. engine sample projects

export const ENGINE_TARGETS: Array<{ op: string; output: string; tiles?: boolean }> = [
  { op: "engine.godot_sample_scene", output: "godot/sprites/hero.png" },
  { op: "engine.godot_tilemap_scene", output: "godot/levels/level.png", tiles: true },
  { op: "engine.unity_aseprite", output: "unity/Assets/Sprites/hero.aseprite" },
  { op: "engine.unity_sheet", output: "unity/Assets/Sprites/hero_sheet.png" },
  { op: "engine.phaser", output: "phaser/assets/hero.png" },
  { op: "engine.pixi", output: "pixi/assets/hero.png" },
  { op: "engine.gamemaker", output: "gamemaker/sprites/hero.png" },
  { op: "engine.defold", output: "defold/assets/hero.png" },
  { op: "engine.cocos", output: "cocos/assets/hero.png" },
  { op: "engine.love", output: "love/hero.png" },
  { op: "engine.pygame", output: "pygame/assets/hero.png" },
];

export async function engineSamples(call: Call, root: string, hero = "hero/hero.aseprite", level = "level/level.aseprite"): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const t of ENGINE_TARGETS) {
    const r = await op(call, t.op, { output: `${root}/${t.output}`, force: true, ...(t.op === "engine.defold" ? { projectDir: "/assets/hero_frames" } : {}) }, t.tiles ? level : hero);
    out[t.op + (t.tiles ? ":tiles" : "")] = { files: (r.artifacts ?? []).length, warnings: r.warnings };
  }
  await op(call, "engine.unity_package", { project: `${root}/unity` });
  const validate = await op(call, "engine.validate", {
    files: [
      `${root}/godot/sprites/hero.tscn`, `${root}/godot/sprites/hero.tres`, `${root}/godot/sprites/hero.anims.tres`, `${root}/godot/levels/level.tscn`, `${root}/godot/levels/level.tileset.tres`,
      `${root}/pixi/assets/hero.json`, `${root}/phaser/assets/hero.json`, `${root}/phaser/assets/hero.anims.json`, `${root}/cocos/assets/hero.plist`, `${root}/defold/assets/hero.atlas`, `${root}/unity/Assets/Sprites/hero_sheet.unity.json`,
    ],
  });
  return { exports: out, validate: validate.result };
}
