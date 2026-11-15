import { z } from "zod";

// Integers via multipleOf(1): .int() would emit +/-2^53 bounds into every JSON schema.
export const int = () => z.number().multipleOf(1);
export const coord = () => int().min(-65535).max(65535);
export const size = () => int().min(1).max(65535);
export const pos = () => int().min(1).max(65535);
export const byte = () => int().min(0).max(255);

/** "#rrggbb", "#rrggbbaa", "#rgb", "transparent" or a palette index. */
export const Color = z.union([z.string().max(32), byte()]);
export const Colors = (max = 256) => z.array(Color).min(1).max(max);

export const point = z.object({ x: coord(), y: coord() }).strict();
export const points = (min = 2, max = 4096) => z.array(point).min(min).max(max);
export const rect = { x: coord(), y: coord(), width: size(), height: size() };
export const optRect = { x: coord().optional(), y: coord().optional(), width: size().optional(), height: size().optional() };

export const layer = z.string().max(512).optional();
export const layerReq = z.string().min(1).max(512);
export const frame = pos().optional();

/** frame | frames | fromFrame..toFrame | tag */
export const frameSel = {
  frame: pos().optional(),
  frames: z.array(pos()).max(4096).optional(),
  fromFrame: pos().optional(),
  toFrame: pos().optional(),
  tag: z.string().max(256).optional(),
};

/** Drawing modifiers handled by the Lua cel helper. */
export const drawMods = {
  inSelection: z.boolean().optional(),
  mirror: z.enum(["x", "y", "xy"]).optional(),
};

export const blendMode = z.enum([
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color_dodge", "color_burn", "hard_light",
  "soft_light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "addition", "subtract", "divide",
]);
export const direction = z.enum(["forward", "reverse", "pingpong", "pingpong_reverse"]);
export const selMode = z.enum(["replace", "add", "subtract", "intersect", "xor"]).optional();

export const placement = {
  parent: z.string().max(512).optional(),
  above: z.string().max(512).optional(),
  below: z.string().max(512).optional(),
  toTop: z.boolean().optional(),
  toBottom: z.boolean().optional(),
};

export const rows = (maxLen = 4096) => z.array(z.string().max(maxLen)).min(1).max(4096);
export const legend = z.record(z.string().length(1), Color);
export const paging = { offset: int().min(0).optional(), limit: int().min(1).max(1000).optional() };

export const pathStr = z.string().min(1).max(4096);
export const outPng = z.string().min(1).max(4096);
export const paletteArg = z.union([z.string().max(64), z.array(Color).max(256)]);
