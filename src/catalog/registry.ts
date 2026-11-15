import { z } from "zod";
import { McpToolError } from "../errors.js";
import { getPreset } from "../palettes.js";
import { ACTION_OPS, type Pattern } from "./actions.js";
import { ENGINE_OPS } from "./actions-engines.js";
import { coord, frameSel, int, layer, pos } from "./common.js";
import { COLOR_ANIM_OPS } from "./ops-color.js";
import { DRAW_OPS } from "./ops-draw.js";
import { STRUCTURE_OPS } from "./ops-structure.js";
import { TILE_CHECK_OPS } from "./ops-tiles.js";
import { AREAS, op, type Area, type OpDef, type RunEnv } from "./types.js";

// ------------------------------------------------------------------ ops that need server-side preparation

async function patternLib(env: RunEnv): Promise<Record<string, Pattern>> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  try {
    return JSON.parse(await readFile(path.join(env.ctx.config.roots[0]!, ".aseprite-mcp", "patterns.json"), "utf8")) as Record<string, Pattern>;
  } catch {
    return {};
  }
}

const PREPARED_OPS: OpDef[] = [
  op("xf.paste_image", "transform", "edit", "Paste a PNG from the workspace onto a cel at x/y",
    { layer, frame: pos().optional(), file: z.string().min(1).max(4096), x: coord().optional(), y: coord().optional() },
    { layer: "fx", file: "stamp.png", x: 2, y: 2 }, {
      prepare: (a, env) => ({ ...a, file: env.ctx.imagePath(String(a.file)) }),
      keywords: ["import png", "stamp image"],
    }),
  op("pattern.stamp", "drawing", "edit", "Stamp a saved pattern (optionally flipped, repeated count times along dx/dy)",
    { name: z.string().min(1).max(64), layer, ...frameSel, x: coord().optional(), y: coord().optional(), count: int().min(1).max(256).optional(), dx: coord().optional(), dy: coord().optional(), flipX: z.boolean().optional(), flipY: z.boolean().optional() },
    { args: { name: "dot", layer: "fx", x: 4, y: 4, count: 3, dx: 4 } }, {
      prepare: async (a, env) => {
        const lib = await patternLib(env);
        const p = lib[String(a.name)];
        if (!p) throw new McpToolError("NOT_FOUND", `no pattern '${a.name}'`, `Saved patterns: ${Object.keys(lib).join(", ") || "none"} (pattern.save)`);
        const { name: _n, ...rest } = a;
        return { ...rest, rows: p.rows, legend: p.legend };
      },
      keywords: ["reusable drawing pattern", "stamp"],
    }),
];

const PREPARE: Record<string, OpDef["prepare"]> = {
  "pal.set": (a) => {
    if (typeof a.preset === "string") {
      const { preset: _p, ...rest } = a;
      return { ...rest, colors: getPreset(a.preset).colors };
    }
    if (!a.colors) throw new McpToolError("INVALID_INPUT", "pal.set needs `colors` or `preset`");
    return a;
  },
  "check.lint": (a) => (typeof a.palette === "string" ? { ...a, palette: getPreset(a.palette).colors } : a),
  "tile.import": (a, env) => (a.file ? { ...a, file: env.ctx.imagePath(String(a.file)) } : a),
  "ref.compare": (a, env) => ({ ...a, file: env.ctx.imagePath(String(a.file)) }),
  "view.compare": (a, env) => (a.other ? { ...a, other: env.ctx.spritePath(String(a.other)) } : a),
};

const REF_COMPARE = op("ref.compare", "reference", "query", "Compare a frame with a reference image: silhouette IoU, color distance (no style claim)",
  { file: z.string().min(1).max(4096), frame: pos().optional(), layer, method: z.enum(["mode", "nearest"]).optional(), tolerance: int().min(0).max(442).optional() },
  { file: "ref.png" });

// ------------------------------------------------------------------ catalog

/** Example prerequisites produced by other operations (keeps examples reproducible). */
const BEFORE: Record<string, NonNullable<OpDef["example"]["before"]>> = {
  "engine.validate": [{ op: "engine.godot_sprite_frames", args: { output: "godot/hero.png" }, path: "fixture.aseprite" }],
  "sheet.inspect": [{ op: "sheet.export", args: { output: "out/sheet.png" }, path: "fixture.aseprite" }],
  "check.artifact": [{ op: "sheet.export", args: { output: "out/sheet.png" }, path: "fixture.aseprite" }],
  "pattern.delete": [{ op: "pattern.save", args: { name: "brick", rows: ["ab"], legend: { a: "#ab5236", b: "#5f574f" } } }],
  "pattern.stamp": [{ op: "pattern.save", args: { name: "dot", rows: [".K.", "KKK", ".K."], legend: { K: "#000000" } } }],
  "preset.delete": [{ op: "preset.save", args: { name: "outline_and_shadow", ops: [{ op: "draw.outline", layer: "arm", color: "#000000" }] } }],
  "preset.apply": [{ op: "preset.save", args: { name: "outline_and_shadow", params: { outline: "#000000", layer: "body" }, ops: [{ op: "draw.outline", layer: "\${layer}", color: "\${outline}" }] } }],
};

export const CATALOG: OpDef[] = [...STRUCTURE_OPS, ...DRAW_OPS, ...PREPARED_OPS, ...COLOR_ANIM_OPS, ...TILE_CHECK_OPS, REF_COMPARE, ...ACTION_OPS, ...ENGINE_OPS]
  .map((d) => (PREPARE[d.id] && !d.prepare ? { ...d, prepare: PREPARE[d.id] } : d))
  .map((d) => (BEFORE[d.id] ? { ...d, example: { ...d.example, before: BEFORE[d.id] } } : d))
  .sort((a, b) => a.id.localeCompare(b.id));

const BY_ID = new Map(CATALOG.map((d) => [d.id, d]));
if (BY_ID.size !== CATALOG.length) throw new Error("duplicate operation id in the catalog");

/** Ops whose `legend` maps to indices, not colors. */
export const RAW_LEGEND = new Set(["draw.index_map", "tile.paint"]);

/** v1 edit op names -> catalog ids (legacy profile). */
export const LEGACY_OPS: Record<string, string> = {
  pixel_map: "draw.pixel_map", set_pixels: "draw.pixels", line: "draw.line", rect: "draw.rect", ellipse: "draw.ellipse", fill: "draw.fill",
  gradient: "draw.gradient", text: "draw.text", replace_color: "pal.replace_color", adjust_color: "pal.adjust", quantize: "pal.quantize",
  outline: "draw.outline", flip: "xf.flip", rotate: "xf.rotate", shift: "xf.shift", move: "cel.move", copy_region: "xf.copy_region",
  import_image: "xf.paste_image", copy_cel: "cel.copy", set_cel: "cel.set", tween: "anim.tween", add_layer: "layer.add", set_layer: "layer.set",
  delete_layer: "layer.delete", move_layer: "layer.move", duplicate_layer: "layer.duplicate", merge_down: "layer.merge_down", flatten: "layer.flatten",
  add_frames: "frame.add", delete_frames: "frame.delete", set_frame_duration: "frame.set_duration", reverse_frames: "frame.reverse",
  add_tag: "tag.add", set_tag: "tag.set", delete_tag: "tag.delete", add_slice: "slice.add", delete_slice: "slice.delete",
  set_palette: "pal.set", set_palette_color: "pal.set_color", resize_canvas: "doc.resize_canvas", crop: "doc.crop", scale: "doc.scale",
  set_color_mode: "doc.set_color_mode", clear: "draw.erase",
};

export function getOp(id: string): OpDef {
  const d = BY_ID.get(id);
  if (!d) {
    const near = search(id.replace(/[._]/g, " "), { limit: 5 }).items.map((x) => x.id);
    throw new McpToolError("UNKNOWN_OPERATION", `unknown operation '${id}'`, near.length ? `Did you mean: ${near.join(", ")}? (search_ops finds more)` : "Use search_ops to find operations.");
  }
  return d;
}

const schemaCache = new Map<string, z.ZodObject>();
export function argSchema(d: OpDef): z.ZodObject {
  let s = schemaCache.get(d.id);
  if (!s) {
    s = z.object(d.shape).strict();
    schemaCache.set(d.id, s);
  }
  return s;
}

function formatIssues(e: z.ZodError): string {
  return e.issues
    .slice(0, 8)
    .map((i) => {
      const where = i.path.length ? i.path.join(".") : "(args)";
      if (i.code === "unrecognized_keys") return `${where}: unknown field(s) ${(i as { keys?: string[] }).keys?.join(", ")}`;
      return `${where}: ${i.message}`;
    })
    .join("; ");
}

/** Cross-field rules zod shapes do not express. */
const EXTRA: Record<string, (a: Record<string, unknown>) => string | undefined> = {
  "draw.line": (a) => (!a.points && [a.x1, a.y1, a.x2, a.y2].some((v) => v === undefined) ? "needs x1,y1,x2,y2 or points" : undefined),
  "doc.scale": (a) => (a.factor === undefined && a.width === undefined && a.height === undefined ? "needs factor or width/height" : undefined),
  "tile.paint": (a) => (!a.rows && !a.cells ? "needs rows (+legend) or cells" : a.rows && !a.legend ? "rows need a legend (char -> tile index)" : undefined),
  "pattern.save": (a) => (Boolean(a.rows) !== Boolean(a.legend) ? "pass rows and legend together" : undefined),
  "tile.collision_set": (a) => (!a.tile && !a.tiles ? "needs tile or tiles" : a.shape === "polygon" && !a.polygon ? "shape polygon needs polygon points" : undefined),
  "xf.scale_layer": (a) => (a.factor === undefined && (a.scaleX === undefined || a.scaleY === undefined) ? "needs factor or scaleX+scaleY" : undefined),
};

/** Validate args against the op's own schema (unknown fields are rejected). */
export function validateArgs(d: OpDef, args: unknown): Record<string, unknown> {
  const r = argSchema(d).safeParse(args ?? {});
  if (!r.success) throw new McpToolError("INVALID_INPUT", `${d.id}: ${formatIssues(r.error)}`, `describe_ops {"ops":["${d.id}"]} shows the schema.`);
  const extra = EXTRA[d.id]?.(r.data as Record<string, unknown>);
  if (extra) throw new McpToolError("INVALID_INPUT", `${d.id}: ${extra}`);
  return r.data as Record<string, unknown>;
}

/** Validate a batch of edit ops ({op, ...args}); returns them with parsed args. */
export function validateBatch(ops: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return ops.map((o, i) => {
    const id = String(o.op ?? "");
    let d: OpDef;
    try {
      d = getOp(id);
    } catch (e) {
      throw new McpToolError("UNKNOWN_OPERATION", `op #${i + 1}: ${(e as Error).message}`, (e as McpToolError).hint);
    }
    if (d.kind !== "edit") throw new McpToolError("INVALID_INPUT", `op #${i + 1}: '${id}' is a ${d.kind} operation; batches take edit operations (use run_op for it)`);
    const { op: _op, ...args } = o;
    try {
      return { op: id, ...validateArgs(d, args) };
    } catch (e) {
      throw new McpToolError("INVALID_INPUT", `op #${i + 1} ${(e as Error).message}`, (e as McpToolError).hint);
    }
  });
}

// ------------------------------------------------------------------ search & describe

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function search(query: string | undefined, o: { area?: string; kind?: string; offset?: number; limit?: number } = {}): { items: Array<{ id: string; kind: string; summary: string }>; total: number; nextOffset?: number } {
  const q = tokens(query ?? "");
  const scored: Array<{ d: OpDef; score: number }> = [];
  for (const d of CATALOG) {
    if (o.area && d.area !== o.area) continue;
    if (o.kind && d.kind !== o.kind) continue;
    if (q.length === 0) {
      scored.push({ d, score: 0 });
      continue;
    }
    const idT = tokens(d.id);
    const sumT = tokens(d.summary);
    const kwT = tokens((d.keywords ?? []).join(" "));
    let score = 0;
    for (const t of q) {
      if (d.id === query) score += 100;
      if (idT.includes(t)) score += 10;
      else if (idT.some((x) => x.startsWith(t) || (t.length > 3 && t.startsWith(x)))) score += 6;
      if (kwT.includes(t)) score += 5;
      if (d.area === t || d.area.startsWith(t)) score += 4;
      if (sumT.includes(t)) score += 3;
      else if (t.length > 3 && sumT.some((x) => x.startsWith(t.slice(0, -1)))) score += 1;
    }
    if (score > 0) scored.push({ d, score });
  }
  scored.sort((a, b) => b.score - a.score || a.d.id.localeCompare(b.d.id));
  const offset = o.offset ?? 0;
  const limit = o.limit ?? 12;
  const items = scored.slice(offset, offset + limit).map(({ d }) => ({ id: d.id, kind: d.kind, summary: d.summary }));
  return { items, total: scored.length, nextOffset: offset + limit < scored.length ? offset + limit : undefined };
}

/** Compact JSON Schema: integers instead of multipleOf:1, no $schema/additionalProperties noise. */
export function compactSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(compactSchema);
  if (!schema || typeof schema !== "object") return schema;
  const s = { ...(schema as Record<string, unknown>) };
  delete s.$schema;
  delete s.additionalProperties;
  if (s.type === "number" && s.multipleOf === 1) {
    s.type = "integer";
    delete s.multipleOf;
  }
  for (const k of Object.keys(s)) s[k] = compactSchema(s[k]);
  return s;
}

export function describe(d: OpDef, withExample = true): Record<string, unknown> {
  return {
    id: d.id,
    kind: d.kind,
    summary: d.summary,
    doc: d.doc,
    args: compactSchema(z.toJSONSchema(argSchema(d), { io: "input", unrepresentable: "any" })),
    example: withExample ? d.example.args : undefined,
    requires: d.requires.join(","),
    live: d.live || undefined,
    status: d.status !== "stable" ? d.status : undefined,
    notes: d.notes,
  };
}

export function areaCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of AREAS) out[a] = 0;
  for (const d of CATALOG) out[d.area] = (out[d.area] ?? 0) + 1;
  return out;
}

export type { Area };
