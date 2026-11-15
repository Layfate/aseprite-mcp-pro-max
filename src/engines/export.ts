import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "../context.js";
import { McpToolError } from "../errors.js";
import type { Artifact } from "../catalog/types.js";
import { buildModel, validateModel, type AssetModel, type SheetData, type TileMapModel, type TilesetModel } from "./model.js";

export interface SheetOptions {
  sheetType?: "horizontal" | "vertical" | "rows" | "columns" | "packed";
  columns?: number;
  padding?: number;
  borderPadding?: number;
  extrude?: boolean;
  trim?: boolean;
  mergeDuplicates?: boolean;
  scale?: number;
  tag?: string;
  layer?: string;
  ignoreLayers?: string[];
  fromFrame?: number;
  toFrame?: number;
  dataFormat?: "json-array" | "json-hash";
  filenameFormat?: string;
  splitLayers?: boolean;
  splitTags?: boolean;
}

/** Reference layers (ref.add_layer) never go into exports. */
async function referenceLayers(ctx: Context, file: string): Promise<string[]> {
  const res = await ctx.aseprite.engine<{ items: Array<{ path: string; type: string }> }>({ cmd: "query", q: "layer.list", input: file, args: { limit: 1000 } });
  return res.items.filter((l) => /(^|\/)reference$/i.test(l.path)).map((l) => l.path.split("/").pop()!);
}

/** Aseprite CLI sheet export (Aseprite's own packer). Returns the sheet JSON. */
export async function exportSheet(ctx: Context, input: string, outPng: string, o: SheetOptions, signal?: AbortSignal): Promise<{ data: SheetData; json: string }> {
  await mkdir(path.dirname(outPng), { recursive: true });
  const json = outPng.replace(/\.png$/i, ".json");
  const args: string[] = ["-b"];
  if (o.layer) args.push("--layer", o.layer);
  for (const l of [...(o.ignoreLayers ?? []), ...(await referenceLayers(ctx, input))]) args.push("--ignore-layer", l);
  if (o.tag) args.push("--tag", o.tag);
  if (o.fromFrame || o.toFrame) args.push("--frame-range", `${(o.fromFrame ?? 1) - 1},${(o.toFrame ?? o.fromFrame ?? 1) - 1}`);
  if (o.splitLayers) args.push("--split-layers");
  if (o.splitTags) args.push("--split-tags");
  if (o.trim) args.push("--trim");
  if (o.filenameFormat) args.push("--filename-format", o.filenameFormat);
  args.push(input);
  if (o.scale && o.scale !== 1) args.push("--scale", String(o.scale));
  args.push("--sheet", outPng, "--data", json, "--format", o.dataFormat ?? "json-array", "--sheet-type", o.sheetType ?? "packed", "--list-tags", "--list-slices", "--list-layers");
  if (o.columns) args.push("--sheet-columns", String(o.columns));
  if (o.padding) args.push("--shape-padding", String(o.padding));
  if (o.borderPadding) args.push("--border-padding", String(o.borderPadding));
  if (o.extrude) args.push("--extrude");
  if (o.mergeDuplicates) args.push("--merge-duplicates");
  const run = await ctx.aseprite.run(args, undefined, signal);
  if (run.code !== 0 || !existsSync(json)) {
    throw new McpToolError("ASEPRITE_FAILED", `sheet export failed (exit ${run.code})`, (run.stderr || run.stdout).trim().slice(0, 1500) || undefined);
  }
  const raw = JSON.parse(await readFile(json, "utf8")) as SheetData & { frames: SheetData["frames"] | Record<string, SheetData["frames"][number]> };
  // json-hash: turn into an ordered array for the model
  const frames = Array.isArray(raw.frames) ? raw.frames : Object.entries(raw.frames as Record<string, SheetData["frames"][number]>).map(([filename, f]) => ({ ...f, filename }));
  const data: SheetData = { ...raw, frames };
  // With --tag, Aseprite exports only that tag's frames but keeps the original tag ranges.
  if (o.tag || o.fromFrame || o.toFrame) {
    const n = frames.length;
    const t = (data.meta.frameTags ?? []).find((x) => x.name === o.tag);
    data.meta.frameTags = t ? [{ ...t, from: 0, to: n - 1 }] : (data.meta.frameTags ?? []).filter((x) => x.to < n);
  }
  return { data, json };
}

export async function docPivot(ctx: Context, file: string): Promise<{ x: number; y: number } | null> {
  const meta = await ctx.aseprite.engine<{ pivot?: { x: number; y: number } }>({ cmd: "query", q: "doc.get_metadata", input: file, args: {} });
  return meta.pivot ?? null;
}

/** Export a document's sheet and build the engine-neutral model (pivot scaled with the sheet). */
export async function modelFor(ctx: Context, file: string, outPng: string, o: SheetOptions, signal?: AbortSignal): Promise<{ model: AssetModel; json: string }> {
  const { data, json } = await exportSheet(ctx, file, outPng, o, signal);
  const pivot = await docPivot(ctx, file);
  const s = o.scale ?? 1;
  const model = buildModel(data, { name: path.basename(outPng, ".png"), pivot: pivot ? { x: pivot.x * s, y: pivot.y * s } : null });
  const errors = validateModel(model);
  if (errors.length) throw new McpToolError("ASEPRITE_FAILED", `exported sheet failed validation: ${errors.slice(0, 5).join("; ")}`);
  return { model, json };
}

/** Tileset atlas + maps of a document (first tilemap layer's tileset). */
export async function tilesFor(ctx: Context, file: string, outPng: string, layer: string | undefined, spacing = 0, signal?: AbortSignal): Promise<{ tileset: TilesetModel; maps: TileMapModel[] }> {
  const maps = (await ctx.aseprite.engine<{ maps: TileMapModel[] & Array<{ tileset: string }> }>({ cmd: "query", q: "tile.export_maps", input: file, args: { layer } }, signal)).maps;
  if (maps.length === 0) throw new McpToolError("INVALID_INPUT", "the document has no tilemap layers (create one with tile.create_layer)");
  const atlasLayer = layer ?? (maps[0] as unknown as { layer: string }).layer;
  await mkdir(path.dirname(outPng), { recursive: true });
  const info = await ctx.aseprite.engine<TilesetModel & { width: number; height: number; name: string }>(
    { cmd: "render", view: "tile.export_atlas", input: file, output: outPng, args: { layer: atlasLayer, spacing } },
    signal,
  );
  const tileset: TilesetModel = {
    name: info.name || path.basename(outPng, ".png"),
    image: path.basename(outPng),
    atlas: { w: info.width, h: info.height },
    tileWidth: info.tileWidth,
    tileHeight: info.tileHeight,
    columns: info.columns,
    rows: info.rows,
    spacing: info.spacing,
    tiles: info.tiles,
  };
  return { tileset, maps: maps.filter((m) => (m as unknown as { tileset: string }).tileset === (maps.find((x) => x.layer === atlasLayer) as unknown as { tileset: string }).tileset) };
}

/** Atomic write: temp file + rename, so engines never see half-written files; existing .meta/.import files are untouched. */
export async function writeAtomic(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.mcp-tmp-${process.pid}`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}

export async function copyAtomic(src: string, dst: string): Promise<void> {
  await mkdir(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.mcp-tmp-${process.pid}`;
  await copyFile(src, tmp);
  await rename(tmp, dst);
}

export async function artifact(ctx: Context, file: string, kind: string): Promise<Artifact> {
  const s = await stat(file);
  return { path: ctx.display(file)!, kind, bytes: s.size };
}

/** Godot res:// path for a file inside a project (project.godot above it). */
export function godotResPath(file: string, override?: string): { res: string; warning?: string } {
  if (override) return { res: override };
  let cur = path.dirname(path.resolve(file));
  for (;;) {
    if (existsSync(path.join(cur, "project.godot"))) return { res: "res://" + path.relative(cur, file).split(path.sep).join("/") };
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { res: "res://" + path.basename(file), warning: "No project.godot found above the output; resources assume files at the project root (pass resPath to fix)." };
}

/** Unity project root (has Assets/ and ProjectSettings/) above a path. */
export function unityProjectRoot(p: string): string | undefined {
  let cur = path.resolve(p);
  for (;;) {
    if (existsSync(path.join(cur, "Assets")) && existsSync(path.join(cur, "ProjectSettings"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

// ---------------------------------------------------------------- incremental re-export

interface ManifestEntry {
  source: string;
  sourceVersion: string;
  options: string;
  outputs: Record<string, string>;
  at: string;
}

const MANIFEST = ".aseprite-mcp-exports.json";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex").slice(0, 16);

export async function readManifest(dir: string): Promise<Record<string, ManifestEntry>> {
  try {
    return JSON.parse(await readFile(path.join(dir, MANIFEST), "utf8")) as Record<string, ManifestEntry>;
  } catch {
    return {};
  }
}

/** True when the outputs recorded for (source version, options) still exist unchanged. */
export async function upToDate(dir: string, key: string, sourceVersion: string, options: unknown): Promise<ManifestEntry | undefined> {
  const m = await readManifest(dir);
  const e = m[key];
  if (!e || e.sourceVersion !== sourceVersion || e.options !== sha(JSON.stringify(options))) return undefined;
  for (const [f, h] of Object.entries(e.outputs)) {
    try {
      if (sha(await readFile(path.join(dir, f))) !== h) return undefined;
    } catch {
      return undefined;
    }
  }
  return e;
}

export async function recordExport(dir: string, key: string, source: string, sourceVersion: string, options: unknown, files: string[]): Promise<void> {
  const m = await readManifest(dir);
  const outputs: Record<string, string> = {};
  for (const f of files) {
    const rel = path.relative(dir, f).split(path.sep).join("/");
    if (!rel.startsWith("..")) outputs[rel] = sha(await readFile(f));
  }
  m[key] = { source, sourceVersion, options: sha(JSON.stringify(options)), outputs, at: new Date().toISOString() };
  await writeAtomic(path.join(dir, MANIFEST), JSON.stringify(m, null, 1));
}

export async function listFiles(dir: string, stem: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.startsWith(stem)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

export async function removeIfExists(p: string): Promise<void> {
  await rm(p, { force: true });
}
