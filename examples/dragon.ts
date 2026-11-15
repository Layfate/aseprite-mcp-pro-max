// v1-compatibility demo: uses the v1 tool names through the legacy profile.
// Builds a 64x64 dragon through the MCP server, using only server tools.
//   npm run build && npx tsx examples/dragon.ts [outputDir] [previewPng]
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startClient } from "../tests/helpers/client.js";

const outDir = path.resolve(process.argv[2] ?? "examples/output/dragon");
const previewPath = process.argv[3];

// Palette (Endesga 32 subset)
const C = {
  outline: "#181425",
  greenD: "#265c42",
  green: "#3e8948",
  greenL: "#63c74d",
  belly: "#ead4aa",
  bellyD: "#e4a672",
  wing: "#b55088",
  wingD: "#68386c",
  bone: "#c0cbdc",
  boneD: "#8b9bb4",
  eye: "#fee761",
  red: "#e43b44",
  orange: "#f77622",
  yellow: "#feae34",
  shadow: "#3a4466",
};

type Pt = { x: number; y: number };
const P = (x: number, y: number): Pt => ({ x, y });
/** Closed silhouette: outline polygon + flood fill from an interior point. */
const shape = (layer: string, color: string, pts: Pt[], seed: Pt) => [
  { op: "line", layer, color, points: pts, closed: true },
  { op: "fill", layer, color, x: seed.x, y: seed.y },
];

const c = await startClient({ ASEPRITE_MCP_PROFILE: "core,legacy" }); // v1 tool names keep working
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await c.call(name, args);
  if (r.isError) throw new Error(`${name}: ${r.text}`);
  console.log(`✓ ${name}`);
  return r;
};

await call("aseprite_create", {
  path: "dragon.aseprite",
  width: 64,
  height: 64,
  palette: "endesga-32",
  layers: ["shadow", "tail", "wing", "body", "legs", "head", "details"],
});

// --- Shadow ---------------------------------------------------------------
const shadowOps = [{ op: "ellipse", layer: "shadow", x: 8, y: 56, width: 46, height: 6, color: C.shadow, filled: true }];

// --- Tail: tapering curve to the left, ending in a spade --------------------
// The tail sweeps left from the haunch and curls up into a spade (a "J").
const tailOps = [
  ...shape(
    "tail",
    C.green,
    [P(23, 40), P(15, 43), P(10, 44), P(8, 43), P(7, 40), P(6, 37), P(4, 38), P(3, 42), P(4, 47), P(7, 50), P(11, 51), P(17, 51), P(23, 50)],
    P(14, 47),
  ),
  { op: "line", layer: "tail", color: C.greenD, points: [P(23, 49), P(17, 50), P(11, 50), P(7, 49), P(5, 46), P(4, 42)] },
  { op: "line", layer: "tail", color: C.greenL, points: [P(22, 41), P(15, 44), P(10, 45)] },
  // spade tip pointing up
  ...shape("tail", C.wing, [P(5, 37), P(2, 34), P(5, 29), P(8, 34)], P(5, 34)),
  { op: "line", layer: "tail", color: C.wingD, points: [P(5, 30), P(5, 36)] },
];

// --- Wing: bat wing raised behind the body ---------------------------------
const wrist = P(25, 8);
const wingOps = [
  ...shape(
    "wing",
    C.wing,
    [wrist, P(5, 3), P(11, 10), P(3, 15), P(12, 20), P(8, 25), P(16, 26), P(18, 31), P(28, 36), P(33, 33)],
    P(18, 18),
  ),
  // darker membrane near the body
  ...shape("wing", C.wingD, [P(28, 22), P(18, 31), P(28, 36), P(33, 33)], P(27, 31)),
  // finger bones from the wrist
  { op: "line", layer: "wing", color: C.boneD, points: [wrist, P(5, 3)] },
  { op: "line", layer: "wing", color: C.boneD, points: [wrist, P(3, 15)] },
  { op: "line", layer: "wing", color: C.boneD, points: [wrist, P(8, 25)] },
  { op: "line", layer: "wing", color: C.boneD, points: [wrist, P(18, 31)] },
  // arm (2px) from shoulder to wrist, plus a thumb claw
  { op: "line", layer: "wing", color: C.green, points: [P(33, 33), wrist] },
  { op: "line", layer: "wing", color: C.greenL, points: [P(34, 32), P(26, 8)] },
  { op: "set_pixels", layer: "wing", pixels: [{ x: 26, y: 6, color: C.bone }, { x: 27, y: 5, color: C.bone }] },
];

// --- Body: shaded ellipse with a scaled belly -------------------------------
const bodyOps = [
  { op: "ellipse", layer: "body", x: 18, y: 32, width: 28, height: 20, color: C.greenD, filled: true },
  { op: "ellipse", layer: "body", x: 19, y: 32, width: 26, height: 17, color: C.green, filled: true },
  { op: "ellipse", layer: "body", x: 26, y: 34, width: 9, height: 3, color: C.greenL, filled: true },
  // neck rising to the head
  ...shape("body", C.green, [P(36, 36), P(41, 27), P(45, 20), P(51, 21), P(50, 28), P(46, 40), P(40, 42)], P(45, 30)),
  { op: "line", layer: "body", color: C.greenL, points: [P(42, 27), P(45, 22)] },
  // belly + neck front plates
  { op: "ellipse", layer: "body", x: 25, y: 41, width: 20, height: 10, color: C.belly, filled: true },
  ...shape("body", C.belly, [P(50, 24), P(47, 36), P(44, 42), P(46, 42), P(49, 35), P(51, 26)], P(48, 33)),
  ...[43, 45, 47, 49].map((y) => ({ op: "line", layer: "body", color: C.bellyD, x1: y === 49 ? 29 : 27, y1: y, x2: y === 49 ? 40 : 42, y2: y })),
  ...[29, 32, 35, 38].map((y) => ({ op: "line", layer: "body", color: C.bellyD, x1: 47, y1: y + 1, x2: 50, y2: y })),
];

// --- Legs: haunch + hind leg, front leg, claws -------------------------------
const legOps = [
  { op: "ellipse", layer: "legs", x: 18, y: 39, width: 13, height: 12, color: C.green, filled: true },
  { op: "ellipse", layer: "legs", x: 21, y: 41, width: 5, height: 2, color: C.greenL, filled: true },
  { op: "line", layer: "legs", color: C.greenD, points: [P(19, 47), P(22, 50), P(28, 50)] },
  ...shape("legs", C.green, [P(22, 48), P(28, 48), P(28, 54), P(23, 54)], P(25, 51)),
  { op: "line", layer: "legs", color: C.greenD, points: [P(23, 51), P(23, 54)] },
  ...shape("legs", C.green, [P(38, 44), P(43, 44), P(44, 54), P(39, 54)], P(41, 49)),
  { op: "line", layer: "legs", color: C.greenL, points: [P(42, 45), P(43, 52)] },
  // feet: toes with a dark sole and pale claws pointing forward
  { op: "pixel_map", layer: "legs", x: 20, y: 54, rows: [
    "..GGGGGGGG...",
    ".GGGGGGGGGGW.",
    "GDGGDGGDGGDDW",
  ], legend: { G: C.green, D: C.greenD, W: C.bone } },
  { op: "pixel_map", layer: "legs", x: 36, y: 54, rows: [
    "..GGGGGGG....",
    ".GGGGGGGGGW..",
    "GDGGDGGDGDDW.",
  ], legend: { G: C.green, D: C.greenD, W: C.bone } },
];

// --- Head: skull, snout, jaw, horns ------------------------------------------
const headOps = [
  { op: "ellipse", layer: "head", x: 43, y: 11, width: 13, height: 12, color: C.green, filled: true },
  ...shape("head", C.green, [P(52, 13), P(60, 15), P(62, 18), P(61, 21), P(52, 22)], P(56, 18)),
  { op: "line", layer: "head", color: C.greenL, points: [P(46, 12), P(52, 12), P(60, 15)] },
  // open jaw with teeth and a red mouth
  ...shape("head", C.green, [P(52, 22), P(60, 23), P(58, 26), P(50, 25)], P(54, 24)),
  { op: "line", layer: "head", color: C.red, points: [P(52, 21), P(61, 21)] },
  { op: "line", layer: "head", color: C.red, points: [P(52, 22), P(59, 22)] },
  { op: "set_pixels", layer: "head", pixels: [
    { x: 55, y: 21, color: C.bone }, { x: 58, y: 21, color: C.bone }, { x: 57, y: 22, color: C.bone },
    { x: 60, y: 17, color: C.outline }, // nostril
  ] },
  { op: "line", layer: "head", color: C.greenD, points: [P(44, 20), P(48, 22), P(52, 23)] },
  // horns sweeping back: far horn (shaded) and near horn, tapering to a point
  { op: "pixel_map", layer: "head", x: 41, y: 2, rows: [
    "D.........",
    ".DD.......",
    "..DDB.....",
    "...DDBB...",
    "....DDBB..",
    ".....DDBB.",
    "......DDBB",
  ], legend: { D: C.boneD, B: C.bone } },
  { op: "pixel_map", layer: "head", x: 36, y: 4, rows: [
    "B.........",
    ".BB.......",
    "..BBH.....",
    "...BBHH...",
    "....BBHH..",
    ".....BBHHH",
    "......BBHH",
    ".......BBH",
  ], legend: { B: C.boneD, H: C.bone } },
  // eye with brow ridge
  { op: "pixel_map", layer: "head", x: 50, y: 14, rows: ["DDD.", ".EEK", ".EKK"], legend: { D: C.greenD, E: C.eye, K: C.outline } },
];

// --- Spines along the back -----------------------------------------------------
const spineOps = [
  { op: "pixel_map", layer: "details", x: 21, y: 28, rows: [
    "....................W.....",
    "..............W....WW.....",
    "........W....WW....WW.....",
    "..W....WW....WW...........",
    ".WW....WW.................",
    ".WW.......................",
  ], legend: { W: C.wing } },
  { op: "pixel_map", layer: "details", x: 40, y: 18, rows: [".W..", "WW..", "WW.W", "...W", "..WW"], legend: { W: C.wing } },
];

// --- Flame from the mouth ---------------------------------------------------------
const fireOps = [
  { op: "pixel_map", layer: "details", x: 58, y: 22, rows: [
    "...O..",
    "..OYO.",
    ".OYyYO",
    "OYyyYO",
    ".OYYO.",
    "..OO..",
  ], legend: { O: C.red, Y: C.orange, y: C.yellow } },
];

await call("aseprite_edit", { path: "dragon.aseprite", label: "silhouettes", ops: [...shadowOps, ...tailOps, ...wingOps, ...bodyOps, ...legOps, ...headOps] });
await call("aseprite_edit", {
  path: "dragon.aseprite",
  label: "outlines + details",
  ops: [
    ...["tail", "wing", "body", "legs", "head"].map((layer) => ({ op: "outline", layer, color: C.outline })),
    ...spineOps,
    { op: "outline", layer: "details", color: C.outline },
    ...fireOps,
  ],
});

const preview = await call("aseprite_preview", { path: "dragon.aseprite", scale: 8, background: "#8b9bb4" });
const lint = await call("aseprite_validate", { path: "dragon.aseprite", rules: { palette: "endesga-32" } });
console.log("  valid:", lint.json.valid, "colors:", lint.json.colorsUsed, "issues:", lint.json.issues.map((i: { code: string; message: string }) => i.message).join(" | ") || "none");

mkdirSync(outDir, { recursive: true });
await call("aseprite_export", { path: "dragon.aseprite", output: "dragon.png" });
await call("aseprite_export", { path: "dragon.aseprite", output: "dragon_x8.png", scale: 8 });
for (const f of ["dragon.aseprite", "dragon.png", "dragon_x8.png"]) cpSync(path.join(c.workdir, f), path.join(outDir, f));
if (previewPath) writeFileSync(previewPath, Buffer.from(preview.images[0]!, "base64"));
console.log(`Wrote ${outDir}`);
await c.close();
