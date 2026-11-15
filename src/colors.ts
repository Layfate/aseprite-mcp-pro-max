import { McpToolError } from "./errors.js";

export type RGBA = { r: number; g: number; b: number; a: number };
export type NormalizedColor = RGBA | { index: number };
/** A color as accepted from the client: "#rgb", "#rgba", "#rrggbb", "#rrggbbaa", "transparent", or a palette index. */
export type ColorInput = string | number;

function isNormalized(v: unknown): v is NormalizedColor {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.index === "number" || (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number" && typeof o.a === "number");
}

export function parseColor(input: ColorInput | NormalizedColor): NormalizedColor {
  if (isNormalized(input)) return input;
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 0 || input > 255) {
      throw new McpToolError("INVALID_INPUT", `palette index must be an integer 0-255, got ${input}`);
    }
    return { index: input };
  }
  const s = input.trim().toLowerCase();
  if (s === "transparent" || s === "none") return { r: 0, g: 0, b: 0, a: 0 };
  const m = /^#?([0-9a-f]+)$/.exec(s);
  const h = m?.[1];
  if (h && (h.length === 3 || h.length === 4)) {
    const [r, g, b, a = "f"] = h.split("") as [string, string, string, string?];
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16), a: parseInt(a + a, 16) };
  }
  if (h && (h.length === 6 || h.length === 8)) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
    };
  }
  const idx = /^(?:idx|index):?(\d{1,3})$/.exec(s);
  if (idx) return parseColor(Number(idx[1]));
  throw new McpToolError(
    "INVALID_INPUT",
    `invalid color '${input}'`,
    `Use "#rrggbb", "#rrggbbaa", "transparent", or a palette index number.`,
  );
}

const COLOR_KEYS = new Set(["color", "fromColor", "toColor", "color2", "outlineColor", "shadowColor", "background"]);
const COLOR_ARRAYS = new Set(["colors", "palette", "onlyColors"]);
/** Objects under these keys carry colors in `from` / `to`. */
const MAPPING_PARENTS = new Set(["map", "recolors"]);

export interface NormalizeOptions {
  /** `legend` maps characters to palette/tile indices, not colors (draw.index_map, tile.paint). */
  rawLegend?: boolean;
}

/** Deep-copy an op/request, converting every color-bearing field to NormalizedColor. */
export function normalizeColors<T>(value: T, opts: NormalizeOptions = {}): T {
  return walk(value, undefined, undefined, opts) as T;
}

function isColorLike(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number";
}

function walk(value: unknown, key: string | undefined, parent: string | undefined, opts: NormalizeOptions): unknown {
  if (key !== undefined && COLOR_KEYS.has(key) && isColorLike(value)) {
    // preview backgrounds also accept "checker" / "transparent"
    if (key === "background" && (value === "checker" || value === "transparent" || value === "corners" || value === "alpha")) return value;
    return parseColor(value as ColorInput);
  }
  if (key !== undefined && (key === "from" || key === "to") && parent !== undefined && MAPPING_PARENTS.has(parent) && isColorLike(value)) {
    return parseColor(value as ColorInput);
  }
  if (Array.isArray(value)) {
    if (key !== undefined && COLOR_ARRAYS.has(key) && value.every(isColorLike)) return value.map((c) => parseColor(c as ColorInput));
    if (key === "ramps") return value.map((r) => (Array.isArray(r) ? r.map((c) => parseColor(c as ColorInput)) : r));
    if (key === "pairs") return value.map((p) => (Array.isArray(p) ? p.map((c) => parseColor(c as ColorInput)) : p));
    // arrays inherit the mapping context of their key (map: [{from,to}], recolors: [[{from,to}]])
    const ctx = key !== undefined && MAPPING_PARENTS.has(key) ? key : parent !== undefined && MAPPING_PARENTS.has(parent) ? parent : undefined;
    return value.map((v) => walk(v, undefined, ctx, opts));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "legend" && v && typeof v === "object" && !opts.rawLegend) {
        out[k] = Object.fromEntries(Object.entries(v as Record<string, ColorInput>).map(([ch, c]) => [ch, parseColor(c)]));
      } else {
        out[k] = walk(v, k, parent, opts);
      }
    }
    return out;
  }
  return value;
}
