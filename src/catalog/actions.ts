import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pixelArtPrompt } from "../ai.js";
import { normalizeColors, parseColor } from "../colors.js";
import type { Context, SpriteSummary } from "../context.js";
import { exportSheet, writeAtomic } from "../engines/export.js";
import { McpToolError } from "../errors.js";
import { PALETTES, colorRamp, getPreset } from "../palettes.js";
import { formatPaletteFile, parsePaletteFile } from "../palettes-io.js";
import { SPRITE_EXTENSIONS } from "../paths.js";
import { commitFile } from "../transaction.js";
import { Color, coord, direction, int, legend, paletteArg, pos, rows, size } from "./common.js";
import { op, type ActionResult, type Artifact, type OpDef, type RunEnv } from "./types.js";

const A = "action" as const;
const str = (max = 4096) => z.string().min(1).max(max);

export function resolvePalette(p: unknown): string[] | undefined {
  if (p === undefined) return undefined;
  if (typeof p === "string") return getPreset(p).colors;
  return (p as Array<string | number>).map(String);
}

async function art(ctx: Context, file: string, kind: string): Promise<Artifact> {
  return { path: ctx.display(file)!, kind, bytes: (await stat(file)).size };
}

/** Create a new sprite file transactionally (refuses to overwrite unless asked). */
async function createSprite(ctx: Context, file: string, req: Record<string, unknown>, overwrite: boolean, label = "before overwrite"): Promise<{ sprite: SpriteSummary; version?: string }> {
  if (existsSync(file) && !overwrite) throw new McpToolError("FILE_EXISTS", `'${ctx.display(file)}' already exists`, "Pass overwrite: true (the old file is checkpointed).");
  await mkdir(path.dirname(file), { recursive: true });
  const res = await ctx.locks.run(file, () =>
    commitFile(file, ctx.checkpoints, (work) => ctx.aseprite.engine<{ sprite: SpriteSummary }>({ ...req, output: work }), { label, docs: ctx.docs, inFlight: ctx.inFlight }),
  );
  await ctx.docs.logChange(file, { at: new Date().toISOString(), from: res.before, to: res.after!, kind: "create" });
  return { sprite: res.result.sprite, version: res.after };
}

// ------------------------------------------------------------------ library storage (patterns, presets)

async function readLib<T>(ctx: Context, name: string): Promise<Record<string, T>> {
  try {
    return JSON.parse(await readFile(path.join(ctx.config.roots[0]!, ".aseprite-mcp", `${name}.json`), "utf8")) as Record<string, T>;
  } catch {
    return {};
  }
}

async function writeLib<T>(ctx: Context, name: string, data: Record<string, T>): Promise<void> {
  await writeAtomic(path.join(ctx.config.roots[0]!, ".aseprite-mcp", `${name}.json`), JSON.stringify(data, null, 1));
}

export interface Pattern {
  rows: string[];
  legend: Record<string, string | number>;
  description?: string;
}

export interface Preset {
  description?: string;
  params: Record<string, unknown>;
  ops: Array<Record<string, unknown>>;
}

/** Replace "${name}" placeholders (whole-string values keep their type). */
export function substitute(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = /^\$\{(\w+)\}$/.exec(value);
    if (whole) {
      if (!(whole[1]! in params)) throw new McpToolError("INVALID_INPUT", `preset parameter '${whole[1]}' has no value`);
      return params[whole[1]!];
    }
    return value.replace(/\$\{(\w+)\}/g, (_, k: string) => {
      if (!(k in params)) throw new McpToolError("INVALID_INPUT", `preset parameter '${k}' has no value`);
      return String(params[k]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, params));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, params)]));
  return value;
}

// ------------------------------------------------------------------ reference image helper

async function imageCmd(env: RunEnv, action: string, args: Record<string, unknown>, output?: string): Promise<ActionResult> {
  const file = env.ctx.imagePath(String(args.file));
  if (!existsSync(file)) throw new McpToolError("FILE_NOT_FOUND", `'${args.file}' does not exist`);
  let out: string | undefined;
  if (output) {
    out = env.ctx.outputPath(output, [".png"]);
    await mkdir(path.dirname(out), { recursive: true });
  }
  const data = await env.ctx.aseprite.engine<Record<string, unknown>>(normalizeColors({ cmd: "image", action, ...args, file, output: out }), env.signal);
  return { data, artifacts: out ? [await art(env.ctx, out, "png")] : undefined };
}

const importShape = {
  width: int().min(1).max(4096).optional(),
  height: int().min(1).max(4096).optional(),
  pixelSize: int().min(1).max(256).optional(),
  method: z.enum(["mode", "nearest"]).optional(),
  palette: paletteArg.optional(),
  removeBackground: z.string().max(32).optional(),
  backgroundTolerance: int().min(0).max(255).optional(),
  alphaThreshold: int().min(1).max(255).optional(),
};

function importReq(env: RunEnv, a: Record<string, unknown>, file: string): Record<string, unknown> {
  return {
    cmd: "import",
    file,
    width: a.width, height: a.height, pixelSize: a.pixelSize, method: a.method,
    palette: resolvePalette(a.palette)?.map((c) => parseColor(c)),
    removeBackground: a.removeBackground === undefined || a.removeBackground === "corners" ? a.removeBackground : parseColor(String(a.removeBackground)),
    backgroundTolerance: a.backgroundTolerance, alphaThreshold: a.alphaThreshold,
  };
}

// ------------------------------------------------------------------ PNG header (artifact validation)

function pngSize(b: Buffer): { w: number; h: number } | undefined {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

export const ACTION_OPS: OpDef[] = [
  // ---------------------------------------------------------------- documents
  op("doc.create", "documents", A, "Create a new .aseprite file (size, mode, palette, layers, tagged animations)",
    {
      path: str(), width: int().min(1).max(8192), height: int().min(1).max(8192), colorMode: z.enum(["rgb", "indexed", "gray"]).optional(),
      palette: paletteArg.optional(), background: Color.optional(), layers: z.array(z.string().min(1).max(256)).max(64).optional(),
      frames: int().min(1).max(1024).optional(), frameDurationMs: int().min(1).max(65535).optional(),
      animations: z.array(z.object({ name: z.string().min(1).max(256), frames: int().min(1).max(256), durationMs: int().min(1).max(65535).optional(), direction: direction.optional() }).strict()).max(64).optional(),
      overwrite: z.boolean().optional(),
    },
    { path: "new/hero.aseprite", width: 32, height: 32, palette: "pico-8", layers: ["body", "outline"], animations: [{ name: "idle", frames: 2, durationMs: 200 }] },
    {
      run: async (a, env) => {
        const file = env.ctx.spritePath(String(a.path));
        const palette = resolvePalette(a.palette);
        const res = await createSprite(env.ctx, file, {
          cmd: "create", width: a.width, height: a.height, colorMode: a.colorMode, palette: palette?.map((c) => parseColor(c)),
          background: a.background !== undefined ? parseColor(a.background as string) : undefined,
          layers: a.layers, frames: a.frames, frameDurationMs: a.frameDurationMs, animations: a.animations,
        }, a.overwrite === true);
        return { data: { created: env.ctx.display(file), version: res.version, sprite: env.ctx.summarize({ ...res.sprite, file }) }, touched: [file] };
      },
    }),
  op("doc.list", "documents", A, "List .aseprite/.ase files under a workspace folder with versions",
    { dir: z.string().max(4096).optional(), depth: int().min(0).max(8).optional(), offset: int().min(0).optional(), limit: int().min(1).max(500).optional() }, {}, {
      run: async (a, env) => {
        const root = a.dir ? env.ctx.outputPath(String(a.dir)) : env.ctx.config.roots[0]!;
        const found: string[] = [];
        const walk = async (d: string, level: number) => {
          let names: string[] = [];
          try {
            names = await readdir(d);
          } catch {
            return;
          }
          for (const n of names.sort()) {
            if (n.startsWith(".") || n === "node_modules") continue;
            const full = path.join(d, n);
            if (SPRITE_EXTENSIONS.includes(path.extname(n).toLowerCase())) found.push(full);
            else if (level < ((a.depth as number) ?? 3)) {
              try {
                if ((await stat(full)).isDirectory()) await walk(full, level + 1);
              } catch {
                // ignore
              }
            }
          }
        };
        await walk(root, 0);
        const offset = (a.offset as number) ?? 0;
        const limit = (a.limit as number) ?? 50;
        const page = found.slice(offset, offset + limit);
        const items = [];
        for (const f of page) items.push({ path: env.ctx.display(f), version: await env.ctx.docs.version(f), bytes: (await stat(f)).size });
        return { data: { items, total: found.length, nextOffset: offset + limit < found.length ? offset + limit : undefined } };
      },
    }),
  op("doc.duplicate", "documents", A, "Byte-copy a document to a new path (no checkpoints copied)", { to: str(), overwrite: z.boolean().optional() },
    { to: "copies/fixture_copy.aseprite" }, {
      doc: "required",
      run: async (a, env) => {
        const to = env.ctx.spritePath(String(a.to));
        if (existsSync(to) && !a.overwrite) throw new McpToolError("FILE_EXISTS", `'${a.to}' already exists`);
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(env.file!, to);
        env.ctx.docs.touch(to);
        return { data: { to: env.ctx.display(to), version: await env.ctx.docs.version(to) }, touched: [to] };
      },
    }),
  op("doc.save_as", "documents", A, "Save a derived copy through Aseprite: flattened, one tag, or a frame range",
    { to: str(), flatten: z.boolean().optional(), tag: z.string().max(256).optional(), fromFrame: pos().optional(), toFrame: pos().optional(), overwrite: z.boolean().optional() },
    { to: "derived/idle_flat.aseprite", flatten: true, tag: "idle" }, {
      doc: "required",
      run: async (a, env) => {
        const to = env.ctx.spritePath(String(a.to));
        if (existsSync(to) && !a.overwrite) throw new McpToolError("FILE_EXISTS", `'${a.to}' already exists`);
        const info = await env.ctx.aseprite.engine<{ sprite: SpriteSummary }>({ cmd: "inspect", input: env.file, paletteColors: false });
        let from = (a.fromFrame as number) ?? 1;
        let last = (a.toFrame as number) ?? info.sprite.frameCount;
        if (a.tag) {
          const t = info.sprite.tags.find((x) => x.name === a.tag);
          if (!t) throw new McpToolError("INVALID_INPUT", `tag '${a.tag}' not found`);
          from = t.from;
          last = t.to;
        }
        const ops: Array<Record<string, unknown>> = [];
        if (last < info.sprite.frameCount) ops.push({ op: "frame.delete", from: last + 1, to: info.sprite.frameCount });
        if (from > 1) ops.push({ op: "frame.delete", from: 1, to: from - 1 });
        if (a.flatten) ops.push({ op: "layer.flatten" });
        await mkdir(path.dirname(to), { recursive: true });
        await env.ctx.aseprite.engine({ cmd: "edit", input: env.file, output: to, ops, track: false }, env.signal);
        env.ctx.docs.touch(to);
        return { data: { to: env.ctx.display(to), frames: last - from + 1, version: await env.ctx.docs.version(to) }, touched: [to] };
      },
    }),
  op("doc.recover", "documents", A, "Repair interrupted edits (journals) and remove stale working copies under a folder",
    { dir: z.string().max(4096).optional(), olderThanSec: int().min(0).max(86400 * 30).optional() }, {}, {
      run: async (a, env) => {
        const root = a.dir ? env.ctx.outputPath(String(a.dir)) : env.ctx.config.roots[0]!;
        const scan = await env.ctx.docs.scan(root);
        const reports = [];
        for (const j of scan.journals) {
          const target = path.join(path.dirname(path.dirname(path.dirname(j))), path.basename(j, ".json"));
          reports.push(await env.ctx.recover(target));
        }
        const removed: string[] = [];
        const minAge = ((a.olderThanSec as number) ?? 600) * 1000;
        for (const o of scan.orphans) {
          try {
            if (Date.now() - (await stat(o)).mtimeMs >= minAge) {
              await rm(o, { force: true });
              removed.push(env.ctx.display(o)!);
            }
          } catch {
            // gone
          }
        }
        return { data: { journals: reports.map((r) => ({ ...r, file: env.ctx.display(r.file) })), orphansRemoved: removed, orphansKept: scan.orphans.length - removed.length } };
      },
    }),
  op("doc.from_images", "documents", A, "Build an animation from same-size PNG frames",
    { path: str(), files: z.array(str()).min(1).max(1024), durationMs: int().min(1).max(65535).optional(), tag: z.string().max(256).optional(), layerName: z.string().max(256).optional(), overwrite: z.boolean().optional() },
    { path: "anim/from_pngs.aseprite", files: ["frames/f_1.png", "frames/f_2.png"], durationMs: 120, tag: "loop" }, {
      run: async (a, env) => {
        const file = env.ctx.spritePath(String(a.path));
        const files = (a.files as string[]).map((f) => {
          const p = env.ctx.imagePath(f);
          if (!existsSync(p)) throw new McpToolError("FILE_NOT_FOUND", `'${f}' does not exist`);
          return p;
        });
        const res = await createSprite(env.ctx, file, { cmd: "from_images", files, durationMs: a.durationMs, tag: a.tag, layerName: a.layerName }, a.overwrite === true);
        return { data: { created: env.ctx.display(file), version: res.version, sprite: env.ctx.summarize({ ...res.sprite, file }) }, touched: [file] };
      },
    }),
  op("doc.list_live", "documents", A, "Documents open in the running Aseprite editor", {}, { args: {}, noDoc: true }, {
    requires: ["live-editor"], live: true,
    run: async (_a, env) => ({ data: await env.ctx.bridge.request({ cmd: "list_open" }) }),
  }),
  op("doc.open_live", "documents", A, "Open a file in the running Aseprite editor", { path: str() }, { args: { path: "fixture.aseprite" }, noDoc: true }, {
    requires: ["live-editor"], live: true,
    run: async (a, env) => {
      const res = await env.ctx.bridge.request<{ sprite: SpriteSummary }>({ cmd: "inspect", input: env.ctx.spritePath(String(a.path)) });
      return { data: { opened: a.path, sprite: env.ctx.summarize(res.sprite) } };
    },
  }),
  op("doc.save_live", "documents", A, "Save the active (or given) document in the editor, optionally to a new path",
    { path: z.string().max(4096).optional(), saveAs: z.string().max(4096).optional() }, { args: {}, noDoc: true }, {
      requires: ["live-editor"], live: true,
      run: async (a, env) => ({
        data: await env.ctx.bridge.request({
          cmd: "save", input: a.path ? env.ctx.spritePath(String(a.path)) : undefined,
          output: a.saveAs ? env.ctx.spritePath(String(a.saveAs)) : undefined,
        }),
      }),
    }),

  // ---------------------------------------------------------------- palettes (server side)
  op("pal.presets", "palette", A, "List built-in palette presets", {}, {}, {
    run: async () => ({ data: Object.entries(PALETTES).map(([id, p]) => ({ id, name: p.name, colors: p.colors.length })) }),
  }),
  op("pal.preset_get", "palette", A, "Colors of a built-in palette preset", { preset: str(64) }, { preset: "endesga-32" }, {
    run: async (a) => {
      const p = getPreset(String(a.preset));
      return { data: { name: p.name, colors: p.colors } };
    },
  }),
  op("pal.ramp", "palette", A, "Hue-shifted shading ramp from a base color (cool shadows, warm lights)",
    { base: Color, steps: int().min(2).max(16).optional(), hueShift: z.number().min(0).max(90).optional() }, { base: "#38b764", steps: 5 }, {
      run: async (a) => {
        parseColor(a.base as string);
        return { data: { ramp: colorRamp(String(a.base), (a.steps as number) ?? 5, (a.hueShift as number) ?? 20), order: "darkest to lightest" } };
      },
    }),
  op("pal.build", "palette", A, "Build a palette from base colors (one ramp each), optionally applying it to a document",
    { bases: z.array(Color).min(1).max(32), steps: int().min(2).max(9).optional(), hueShift: z.number().min(0).max(90).optional(), extras: z.array(Color).max(16).optional(), apply: z.boolean().optional() },
    { bases: ["#b13e53", "#38b764", "#3b5dc9"], steps: 4, extras: ["#000000", "#ffffff"] }, {
      doc: "optional",
      run: async (a, env) => {
        const colors: string[] = [];
        for (const b of a.bases as string[]) colors.push(...colorRamp(String(b), (a.steps as number) ?? 4, (a.hueShift as number) ?? 20));
        for (const e of (a.extras as string[]) ?? []) colors.push(String(e));
        const unique = [...new Set(colors)].slice(0, 256);
        if (a.apply) {
          if (!env.file) throw new McpToolError("INVALID_INPUT", "apply needs a document path");
          const r = await env.ctx.edit({ file: env.file, live: false }, [{ op: "pal.set", colors: unique }], { label: "pal.build" });
          return { data: { colors: unique, version: r.version }, touched: [env.file] };
        }
        return { data: { colors: unique } };
      },
    }),
  op("pal.load_file", "palette", A, "Load a .gpl/.pal/.hex/.txt palette file (replace or add; remap pixels)",
    { file: str(), mode: z.enum(["replace", "add", "read"]).optional(), remap: z.boolean().optional() },
    { args: { file: "palette.gpl", mode: "replace", remap: true } }, {
      doc: "optional",
      run: async (a, env) => {
        const file = env.ctx.outputPath(String(a.file), [".gpl", ".pal", ".hex", ".txt"]);
        const parsed = parsePaletteFile(await readFile(file, "utf8"), path.extname(file).toLowerCase());
        const mode = (a.mode as string) ?? (env.file ? "replace" : "read");
        if (mode === "read" || !env.file) return { data: parsed };
        const ops = mode === "add" ? [{ op: "pal.add_colors", colors: parsed.colors }] : [{ op: "pal.set", colors: parsed.colors, remap: a.remap }];
        const r = await env.ctx.edit({ file: env.file, live: false }, ops, { label: "pal.load_file" });
        return { data: { name: parsed.name, colors: parsed.colors.length, version: r.version }, touched: [env.file] };
      },
    }),
  op("pal.save_file", "palette", A, "Write the document palette as .gpl/.pal/.hex/.txt", { file: str(), name: z.string().max(64).optional() }, { file: "out/palette.gpl" }, {
    doc: "required",
    run: async (a, env) => {
      const out = env.ctx.outputPath(String(a.file), [".gpl", ".pal", ".hex", ".txt"]);
      const info = await env.ctx.aseprite.engine<{ sprite: SpriteSummary }>({ cmd: "inspect", input: env.file });
      await writeAtomic(out, formatPaletteFile(info.sprite.palette.colors ?? [], path.extname(out).toLowerCase(), (a.name as string) ?? path.basename(env.file!)));
      return { data: { colors: info.sprite.palette.size }, artifacts: [await art(env.ctx, out, "palette")] };
    },
  }),

  // ---------------------------------------------------------------- reusable drawing patterns
  op("pattern.save", "drawing", A, "Save a reusable pattern (rows + legend, or a region of a document)",
    { name: str(64), rows: rows(256).optional(), legend: legend.optional(), description: z.string().max(200).optional(), layer: z.string().max(512).optional(), frame: pos().optional(), x: coord().optional(), y: coord().optional(), width: size().optional(), height: size().optional() },
    { name: "brick", rows: ["aab", "bbb", "abb"], legend: { a: "#ab5236", b: "#5f574f" } }, {
      doc: "optional",
      run: async (a, env) => {
        let pattern: Pattern;
        if (a.rows && a.legend) {
          pattern = { rows: a.rows as string[], legend: a.legend as Record<string, string>, description: a.description as string | undefined };
        } else {
          if (!env.file) throw new McpToolError("INVALID_INPUT", "pass rows + legend, or a document path with a region");
          const g = await env.ctx.aseprite.engine<{ rows: string[]; legend: Record<string, string> }>({ cmd: "query", q: "pixels.read", input: env.file, args: { layer: a.layer, frame: a.frame, x: a.x, y: a.y, width: a.width, height: a.height } });
          pattern = { rows: g.rows, legend: g.legend, description: a.description as string | undefined };
        }
        const lib = await readLib<Pattern>(env.ctx, "patterns");
        lib[String(a.name)] = pattern;
        await writeLib(env.ctx, "patterns", lib);
        return { data: { name: a.name, width: Math.max(...pattern.rows.map((r) => r.length)), height: pattern.rows.length, colors: Object.keys(pattern.legend).length } };
      },
    }),
  op("pattern.list", "drawing", A, "List saved patterns", {}, {}, {
    run: async (_a, env) => {
      const lib = await readLib<Pattern>(env.ctx, "patterns");
      return { data: Object.entries(lib).map(([name, p]) => ({ name, size: `${Math.max(...p.rows.map((r) => r.length))}x${p.rows.length}`, description: p.description })) };
    },
  }),
  op("pattern.delete", "drawing", A, "Delete a saved pattern", { name: str(64) }, { args: { name: "brick" } }, {
    run: async (a, env) => {
      const lib = await readLib<Pattern>(env.ctx, "patterns");
      if (!lib[String(a.name)]) throw new McpToolError("NOT_FOUND", `no pattern '${a.name}'`);
      delete lib[String(a.name)];
      await writeLib(env.ctx, "patterns", lib);
      return { data: { deleted: a.name } };
    },
  }),

  // ---------------------------------------------------------------- reference images (deterministic, no network)
  op("ref.analyze", "reference", A, "Reference image facts: size, colors, alpha, likely pixel scale, corner colors", { file: str() }, { file: "ref.png" }, {
    requires: ["aseprite"], run: (a, env) => imageCmd(env, "analyze", a),
  }),
  op("ref.crop", "reference", A, "Crop a reference image to a rectangle (PNG out)", { file: str(), output: str(), x: int().min(0), y: int().min(0), width: size(), height: size() },
    { file: "ref.png", output: "work/ref_crop.png", x: 0, y: 0, width: 32, height: 32 }, { requires: ["aseprite"], run: (a, env) => imageCmd(env, "crop", { ...a, output: undefined }, String(a.output)) }),
  op("ref.isolate", "reference", A, "Isolate the subject: remove a flat background and crop to it (+margin)",
    { file: str(), output: str(), background: z.string().max(32).optional(), tolerance: int().min(0).max(255).optional(), margin: int().min(0).max(256).optional(), keepBackground: z.boolean().optional() },
    { file: "ref.png", output: "work/ref_subject.png", margin: 2 }, { requires: ["aseprite"], run: (a, env) => imageCmd(env, "isolate", { ...a, output: undefined }, String(a.output)) }),
  op("ref.remove_background", "reference", A, "Remove the background: built-in (corner flood / key color) or the configured external remover",
    { file: str(), output: str(), background: z.string().max(32).optional(), tolerance: int().min(0).max(255).optional(), provider: z.enum(["builtin", "external"]).optional() },
    { file: "ref.png", output: "work/ref_nobg.png" }, {
      requires: ["aseprite"],
      notes: "provider=external needs ASEPRITE_MCP_BG_COMMAND; the built-in remover handles flat backgrounds only.",
      run: async (a, env) => {
        if (a.provider === "external") {
          const remover = env.ctx.bgRemover;
          if (!remover) throw new McpToolError("DISABLED", "no external background remover is configured", "Set ASEPRITE_MCP_BG_COMMAND (JSON argv with {input} and {output}), or use provider: builtin.");
          const input = env.ctx.imagePath(String(a.file));
          const out = env.ctx.outputPath(String(a.output), [".png"]);
          await mkdir(path.dirname(out), { recursive: true });
          await remover.remove({ input, output: out });
          return { data: { provider: remover.name }, artifacts: [await art(env.ctx, out, "png")] };
        }
        return imageCmd(env, "remove_background", { ...a, output: undefined, provider: undefined }, String(a.output));
      },
    }),
  op("ref.downscale", "reference", A, "Downscale to native pixel size (block majority or nearest), optional palette snap (PNG out)",
    { file: str(), output: str(), ...importShape },
    { file: "ref.png", output: "work/ref_small.png", pixelSize: 4, palette: "pico-8" }, {
      requires: ["aseprite"],
      run: (a, env) => imageCmd(env, "downscale", { ...a, output: undefined, palette: resolvePalette(a.palette) }, String(a.output)),
    }),
  op("ref.extract_palette", "reference", A, "Median-cut palette (N colors) from a reference image", { file: str(), colors: int().min(1).max(256).optional() }, { file: "ref.png", colors: 8 }, {
    requires: ["aseprite"], run: (a, env) => imageCmd(env, "extract_palette", a),
  }),
  op("ref.import", "reference", A, "Reference image -> new editable sprite (downscale, background removal, palette snap)",
    { image: str(), path: str(), ...importShape, colorMode: z.enum(["rgb", "indexed"]).optional(), layerName: z.string().max(256).optional(), overwrite: z.boolean().optional() },
    { image: "ref.png", path: "imported/ref_sprite.aseprite", pixelSize: 4, removeBackground: "corners", palette: "pico-8" }, {
      requires: ["aseprite"], keywords: ["convert reference", "pixel art conversion"],
      run: async (a, env) => {
        const src = env.ctx.imagePath(String(a.image));
        if (!existsSync(src)) throw new McpToolError("FILE_NOT_FOUND", `'${a.image}' does not exist`);
        const file = env.ctx.spritePath(String(a.path));
        const req = { ...importReq(env, a, src), colorMode: a.colorMode, layerName: a.layerName };
        if (existsSync(file) && !a.overwrite) throw new McpToolError("FILE_EXISTS", `'${a.path}' already exists`);
        await mkdir(path.dirname(file), { recursive: true });
        const r = await env.ctx.locks.run(file, () =>
          commitFile(file, env.ctx.checkpoints, (work) => env.ctx.aseprite.engine<{ sprite: SpriteSummary; removedBackgroundPixels: number; sourceWidth: number; sourceHeight: number }>({ ...req, output: work }, env.signal), { label: "before import", docs: env.ctx.docs, inFlight: env.ctx.inFlight }),
        );
        await env.ctx.docs.logChange(file, { at: new Date().toISOString(), from: r.before, to: r.after!, kind: "import" });
        return {
          data: { created: env.ctx.display(file), version: r.after, source: `${r.result.sourceWidth}x${r.result.sourceHeight}`, removedBackgroundPixels: r.result.removedBackgroundPixels, sprite: env.ctx.summarize({ ...r.result.sprite, file }) },
          touched: [file],
        };
      },
    }),
  op("ref.add_layer", "reference", A, "Import a reference image as a locked, faded 'reference' layer (excluded from exports)",
    { image: str(), ...importShape, opacity: int().min(0).max(255).optional(), frame: pos().optional(), x: coord().optional(), y: coord().optional(), expectVersion: z.string().max(32).optional() },
    { image: "ref.png", width: 32, opacity: 80 }, {
      doc: "required", requires: ["aseprite"],
      run: async (a, env) => {
        const src = env.ctx.imagePath(String(a.image));
        if (!existsSync(src)) throw new McpToolError("FILE_NOT_FOUND", `'${a.image}' does not exist`);
        const file = env.file!;
        const req = { ...importReq(env, a, src), asReference: true, opacity: a.opacity, frame: a.frame, x: a.x, y: a.y, layerName: "reference" };
        const r = await env.ctx.locks.run(file, () =>
          commitFile(file, env.ctx.checkpoints, (work) => env.ctx.aseprite.engine<{ sprite: SpriteSummary }>({ ...req, input: file, output: work }, env.signal), { label: "reference layer", mustExist: true, expectVersion: a.expectVersion as string | undefined, docs: env.ctx.docs, inFlight: env.ctx.inFlight }),
        );
        await env.ctx.docs.logChange(file, { at: new Date().toISOString(), from: r.before, to: r.after!, kind: "import", label: "reference layer" });
        return { data: { version: r.after, layer: "reference" }, touched: [file] };
      },
    }),
  op("ref.generate", "reference", A, "Generate a sprite with the configured image provider, then import it as clean pixel art",
    { prompt: z.string().min(3).max(2000), path: str(), width: int().min(8).max(512), height: int().min(8).max(512), palette: paletteArg.optional(), removeBackground: z.boolean().optional(), rawPrompt: z.boolean().optional(), keepSource: z.string().max(4096).optional(), overwrite: z.boolean().optional() },
    { args: { prompt: "a tiny red gem", path: "gen/gem.aseprite", width: 8, height: 8, palette: "pico-8" } }, {
      requires: ["image-provider", "aseprite"], status: "experimental", slow: true,
      notes: "Needs ASEPRITE_MCP_IMAGE_PROVIDER. Output is a starting point; a reference or prompt does not guarantee an exact style.",
      run: async (a, env) => {
        const provider = env.ctx.imageProvider;
        if (!provider) throw new McpToolError("DISABLED", `no image provider is configured${env.ctx.imageProviderError ? ` (${env.ctx.imageProviderError})` : ""}`, "Set ASEPRITE_MCP_IMAGE_PROVIDER=openai|command. Deterministic editing works without it.");
        const palette = resolvePalette(a.palette);
        const prompt = a.rawPrompt ? String(a.prompt) : pixelArtPrompt(String(a.prompt), a.width as number, a.height as number, typeof a.palette === "string" ? `${getPreset(a.palette).name} (${palette?.length} colors)` : undefined);
        const raw = a.keepSource ? env.ctx.outputPath(String(a.keepSource), [".png"]) : await env.ctx.aseprite.tempPath(".png");
        await mkdir(path.dirname(raw), { recursive: true });
        try {
          await provider.generate({ prompt, width: a.width as number, height: a.height as number, output: raw });
          const file = env.ctx.spritePath(String(a.path));
          if (existsSync(file) && !a.overwrite) throw new McpToolError("FILE_EXISTS", `'${a.path}' already exists`);
          const res = await createSprite(env.ctx, file, {
            cmd: "import", file: raw, width: a.width, height: a.height, method: "mode",
            palette: palette?.map((c) => parseColor(c)), removeBackground: a.removeBackground === false ? undefined : "corners",
          }, a.overwrite === true, "before generate");
          return { data: { created: env.ctx.display(file), provider: provider.name, version: res.version, sprite: env.ctx.summarize({ ...res.sprite, file }) }, touched: [file] };
        } finally {
          if (!a.keepSource) await rm(raw, { force: true });
        }
      },
    }),

  // ---------------------------------------------------------------- sheets & exports
  op("sheet.export", "sheets", A, "Sprite sheet PNG + JSON via Aseprite (packed/grid, padding, extrusion, trim, merge duplicates)",
    {
      output: str(), sheetType: z.enum(["horizontal", "vertical", "rows", "columns", "packed"]).optional(), columns: int().min(1).max(1024).optional(),
      padding: int().min(0).max(64).optional(), borderPadding: int().min(0).max(64).optional(), extrude: z.boolean().optional(), trim: z.boolean().optional(),
      mergeDuplicates: z.boolean().optional(), scale: int().min(1).max(64).optional(), tag: z.string().max(256).optional(), layer: z.string().max(512).optional(),
      ignoreLayers: z.array(z.string().max(512)).max(64).optional(), splitLayers: z.boolean().optional(), splitTags: z.boolean().optional(),
      dataFormat: z.enum(["json-array", "json-hash"]).optional(), filenameFormat: z.string().max(256).optional(),
    },
    { output: "out/sheet.png", sheetType: "rows", columns: 2, padding: 1, extrude: true }, {
      doc: "required", requires: ["aseprite"], slow: true,
      run: async (a, env) => {
        const out = env.ctx.outputPath(String(a.output), [".png"]);
        const { data, json } = await exportSheet(env.ctx, env.file!, out, a as never, env.signal);
        return {
          data: { frames: data.frames.length, size: `${data.meta.size.w}x${data.meta.size.h}`, tags: (data.meta.frameTags ?? []).map((t) => t.name) },
          artifacts: [await art(env.ctx, out, "png"), await art(env.ctx, json, "json")],
        };
      },
    }),
  op("sheet.export_multipage", "sheets", A, "Split a sheet across atlas pages no larger than maxWidth x maxHeight",
    { output: str(), maxWidth: int().min(16).max(16384), maxHeight: int().min(16).max(16384), padding: int().min(0).max(64).optional(), scale: int().min(1).max(64).optional() },
    { output: "out/pages.png", maxWidth: 64, maxHeight: 64 }, {
      doc: "required", requires: ["aseprite"], slow: true,
      run: async (a, env) => {
        const info = await env.ctx.aseprite.engine<{ sprite: SpriteSummary }>({ cmd: "inspect", input: env.file, paletteColors: false });
        const s = (a.scale as number) ?? 1;
        const pad = (a.padding as number) ?? 1;
        const fw = info.sprite.width * s + pad;
        const fh = info.sprite.height * s + pad;
        const cols = Math.floor(((a.maxWidth as number) + pad) / fw);
        const rowsN = Math.floor(((a.maxHeight as number) + pad) / fh);
        if (cols < 1 || rowsN < 1) throw new McpToolError("INVALID_INPUT", `one ${fw - pad}x${fh - pad} frame does not fit a ${a.maxWidth}x${a.maxHeight} page`);
        const perPage = cols * rowsN;
        const total = info.sprite.frameCount;
        const pages = Math.ceil(total / perPage);
        const base = env.ctx.outputPath(String(a.output), [".png"]).replace(/\.png$/i, "");
        const artifacts: Artifact[] = [];
        const index: Array<{ page: number; image: string; data: string; fromFrame: number; toFrame: number }> = [];
        for (let p = 0; p < pages; p++) {
          env.progress?.(p, pages, `page ${p + 1}/${pages}`);
          const from = p * perPage + 1;
          const to = Math.min(total, from + perPage - 1);
          const out = `${base}_${p}.png`;
          const { json } = await exportSheet(env.ctx, env.file!, out, { sheetType: "rows", columns: cols, padding: pad, scale: s, fromFrame: from, toFrame: to }, env.signal);
          artifacts.push(await art(env.ctx, out, "png"), await art(env.ctx, json, "json"));
          index.push({ page: p, image: path.basename(out), data: path.basename(json), fromFrame: from, toFrame: to });
        }
        const idx = `${base}.pages.json`;
        await writeAtomic(idx, JSON.stringify({ pages: index, framesPerPage: perPage }, null, 1));
        artifacts.push(await art(env.ctx, idx, "json"));
        return { data: { pages, framesPerPage: perPage }, artifacts };
      },
    }),
  op("sheet.import", "sheets", A, "Slice a grid sprite sheet PNG into frames of a new sprite",
    { image: str(), path: str(), frameWidth: int().min(1).max(4096), frameHeight: int().min(1).max(4096), count: int().min(1).max(4096).optional(), columns: int().min(1).max(1024).optional(), padding: int().min(0).max(64).optional(), margin: int().min(0).max(64).optional(), durationMs: int().min(1).max(65535).optional(), tags: z.array(z.object({ name: z.string().min(1).max(256), from: pos(), to: pos() }).strict()).max(64).optional(), overwrite: z.boolean().optional() },
    { image: "sheet.png", path: "imported/from_sheet.aseprite", frameWidth: 8, frameHeight: 8, count: 4, tags: [{ name: "spin", from: 1, to: 4 }] }, {
      requires: ["aseprite"],
      run: async (a, env) => {
        const src = env.ctx.imagePath(String(a.image));
        if (!existsSync(src)) throw new McpToolError("FILE_NOT_FOUND", `'${a.image}' does not exist`);
        const file = env.ctx.spritePath(String(a.path));
        const res = await createSprite(env.ctx, file, { ...a, cmd: "sheet_import", file: src, image: undefined, path: undefined }, a.overwrite === true);
        return { data: { created: env.ctx.display(file), version: res.version, sprite: env.ctx.summarize({ ...res.sprite, file }) }, touched: [file] };
      },
    }),
  op("sheet.pack", "sheets", A, "Pack several documents into one atlas (PNG + JSON)",
    { files: z.array(str()).min(1).max(256), output: str(), sheetType: z.enum(["packed", "rows", "columns"]).optional(), padding: int().min(0).max(64).optional(), trim: z.boolean().optional() },
    { files: ["fixture.aseprite", "second.aseprite"], output: "out/packed.png" }, {
      requires: ["aseprite"], slow: true,
      run: async (a, env) => {
        const inputs = (a.files as string[]).map((f) => env.ctx.spritePath(f));
        const out = env.ctx.outputPath(String(a.output), [".png"]);
        await mkdir(path.dirname(out), { recursive: true });
        const json = out.replace(/\.png$/i, ".json");
        const args = ["-b", ...(a.trim ? ["--trim"] : []), ...inputs, "--sheet", out, "--data", json, "--format", "json-array", "--sheet-type", (a.sheetType as string) ?? "packed", "--list-tags", "--filename-format", "{title}_{frame}"];
        if (a.padding !== 0) args.push("--shape-padding", String((a.padding as number) ?? 1));
        const run = await env.ctx.aseprite.run(args, undefined, env.signal);
        if (run.code !== 0 || !existsSync(json)) throw new McpToolError("ASEPRITE_FAILED", "pack failed", run.stderr.slice(0, 1000));
        const data = JSON.parse(await readFile(json, "utf8")) as { frames: unknown[]; meta: { size: { w: number; h: number } } };
        return { data: { frames: data.frames.length, size: `${data.meta.size.w}x${data.meta.size.h}` }, artifacts: [await art(env.ctx, out, "png"), await art(env.ctx, json, "json")] };
      },
    }),
  op("sheet.inspect", "sheets", A, "Summarize an exported sheet JSON (frames, size, tags, slices, duration totals)", { file: str() }, { args: { file: "out/sheet.json" } }, {
    run: async (a, env) => {
      const f = env.ctx.outputPath(String(a.file), [".json"]);
      const j = JSON.parse(await readFile(f, "utf8")) as { frames: unknown; meta: { image?: string; size?: { w: number; h: number }; frameTags?: Array<{ name: string; from: number; to: number; direction: string }>; slices?: Array<{ name: string }> } };
      const frames = (Array.isArray(j.frames) ? j.frames : Object.values(j.frames as object)) as Array<{ duration: number }>;
      return { data: { image: j.meta.image, size: j.meta.size, frames: frames.length, totalMs: frames.reduce((s, x) => s + (x.duration ?? 0), 0), tags: j.meta.frameTags, slices: j.meta.slices?.map((s) => s.name) } };
    },
  }),
  op("export.png", "sheets", A, "Export frames as PNG files (one, or numbered name_1.png...), optional scale/tag/layer",
    { output: str(), scale: int().min(1).max(64).optional(), tag: z.string().max(256).optional(), fromFrame: pos().optional(), toFrame: pos().optional(), layer: z.string().max(512).optional(), trim: z.boolean().optional() },
    { output: "out/frames/hero.png", tag: "idle", scale: 2 }, {
      doc: "required", requires: ["aseprite"],
      run: async (a, env) => {
        const out = env.ctx.outputPath(String(a.output), [".png"]);
        await mkdir(path.dirname(out), { recursive: true });
        const info = await env.ctx.aseprite.engine<{ sprite: SpriteSummary }>({ cmd: "inspect", input: env.file, paletteColors: false });
        const t = a.tag ? info.sprite.tags.find((x) => x.name === a.tag) : undefined;
        if (a.tag && !t) throw new McpToolError("INVALID_INPUT", `tag '${a.tag}' not found`);
        const count = t ? t.to - t.from + 1 : a.fromFrame || a.toFrame ? ((a.toFrame as number) ?? info.sprite.frameCount) - ((a.fromFrame as number) ?? 1) + 1 : info.sprite.frameCount;
        const target = count > 1 ? out.replace(/\.png$/i, "_{frame1}.png") : out;
        const args = ["-b"];
        if (a.layer) args.push("--layer", String(a.layer));
        if (a.tag) args.push("--tag", String(a.tag));
        if (a.fromFrame || a.toFrame) args.push("--frame-range", `${((a.fromFrame as number) ?? 1) - 1},${((a.toFrame as number) ?? info.sprite.frameCount) - 1}`);
        if (a.trim) args.push("--trim");
        args.push(env.file!);
        if (a.scale && a.scale !== 1) args.push("--scale", String(a.scale));
        args.push("--save-as", target);
        const run = await env.ctx.aseprite.run(args, undefined, env.signal);
        if (run.code !== 0) throw new McpToolError("ASEPRITE_FAILED", "png export failed", run.stderr.slice(0, 1000));
        const files = count > 1 ? Array.from({ length: count }, (_, i) => out.replace(/\.png$/i, `_${i + 1}.png`)) : [out];
        return { artifacts: await Promise.all(files.filter((f) => existsSync(f)).map((f) => art(env.ctx, f, "png"))) };
      },
    }),
  op("view.gif", "preview", A, "Animated GIF of a tag or the whole sprite (artifact file) for playback review",
    { output: str(), tag: z.string().max(256).optional(), scale: int().min(1).max(32).optional(), layer: z.string().max(512).optional() }, { output: "out/walk.gif", tag: "walk", scale: 4 }, {
      doc: "required", requires: ["aseprite"], keywords: ["animation playback", "gif"],
      run: async (a, env) => {
        const out = env.ctx.outputPath(String(a.output), [".gif"]);
        await mkdir(path.dirname(out), { recursive: true });
        const args = ["-b"];
        if (a.layer) args.push("--layer", String(a.layer));
        if (a.tag) args.push("--tag", String(a.tag));
        args.push(env.file!);
        if (a.scale && a.scale !== 1) args.push("--scale", String(a.scale));
        args.push("--save-as", out);
        const run = await env.ctx.aseprite.run(args, undefined, env.signal);
        if (run.code !== 0 || !existsSync(out)) throw new McpToolError("ASEPRITE_FAILED", "gif export failed", run.stderr.slice(0, 1000));
        return { artifacts: [await art(env.ctx, out, "gif")] };
      },
    }),

  // ---------------------------------------------------------------- production
  op("preset.save", "production", A, "Save a reusable, validated op batch with ${param} placeholders",
    { name: str(64), description: z.string().max(300).optional(), params: z.record(z.string().max(64), z.unknown()).optional(), ops: z.array(z.record(z.string(), z.unknown())).min(1).max(500) },
    { name: "outline_and_shadow", params: { outline: "#000000", layer: "body" }, ops: [{ op: "draw.outline", layer: "${layer}", color: "${outline}" }, { op: "draw.rim_light", layer: "${layer}", light: "top-left", color: "#fff1e8" }] }, {
      run: async (a, env) => {
        const { validateBatch } = await import("./registry.js");
        const params = (a.params as Record<string, unknown>) ?? {};
        validateBatch(substitute(a.ops, params) as Array<Record<string, unknown>>); // defaults must produce valid ops
        const lib = await readLib<Preset>(env.ctx, "presets");
        lib[String(a.name)] = { description: a.description as string | undefined, params, ops: a.ops as Array<Record<string, unknown>> };
        await writeLib(env.ctx, "presets", lib);
        return { data: { saved: a.name, ops: (a.ops as unknown[]).length, params: Object.keys(params) } };
      },
    }),
  op("preset.list", "production", A, "List saved presets with their parameters", {}, {}, {
    run: async (_a, env) => {
      const lib = await readLib<Preset>(env.ctx, "presets");
      return { data: Object.entries(lib).map(([name, p]) => ({ name, description: p.description, params: p.params, ops: p.ops.length })) };
    },
  }),
  op("preset.delete", "production", A, "Delete a saved preset", { name: str(64) }, { args: { name: "outline_and_shadow" } }, {
    run: async (a, env) => {
      const lib = await readLib<Preset>(env.ctx, "presets");
      if (!lib[String(a.name)]) throw new McpToolError("NOT_FOUND", `no preset '${a.name}'`);
      delete lib[String(a.name)];
      await writeLib(env.ctx, "presets", lib);
      return { data: { deleted: a.name } };
    },
  }),
  op("preset.apply", "production", A, "Apply a saved preset to a document as one atomic batch",
    { name: str(64), params: z.record(z.string().max(64), z.unknown()).optional(), expectVersion: z.string().max(32).optional(), dryRun: z.boolean().optional() },
    { args: { name: "outline_and_shadow", params: { outline: "#1d2b53" } } }, {
      doc: "required",
      run: async (a, env) => {
        const { validateBatch, RAW_LEGEND } = await import("./registry.js");
        const lib = await readLib<Preset>(env.ctx, "presets");
        const p = lib[String(a.name)];
        if (!p) throw new McpToolError("NOT_FOUND", `no preset '${a.name}'`, `Saved: ${Object.keys(lib).join(", ") || "none"}`);
        const ops = validateBatch(substitute(p.ops, { ...p.params, ...((a.params as object) ?? {}) }) as Array<Record<string, unknown>>);
        const r = await env.ctx.edit({ file: env.file, live: false }, ops, { label: `preset ${a.name}`, expectVersion: a.expectVersion as string | undefined, dryRun: a.dryRun as boolean | undefined, signal: env.signal, rawLegendOps: RAW_LEGEND });
        if (r.workPath) await rm(r.workPath, { force: true });
        return { data: { version: r.version, prevVersion: r.prevVersion, ops: ops.length, changes: r.changes, dryRun: a.dryRun || undefined }, touched: [env.file!] };
      },
    }),
  op("recipe.run", "production", A, "Apply one op batch (or preset) to many files: all succeed or none change",
    { files: z.array(str()).min(1).max(200), ops: z.array(z.record(z.string(), z.unknown())).max(500).optional(), preset: z.string().max(64).optional(), params: z.record(z.string().max(64), z.unknown()).optional() },
    { args: { files: ["fixture.aseprite", "second.aseprite"], ops: [{ op: "pal.adjust", lightness: -5 }] } }, {
      slow: true, keywords: ["batch", "bulk"],
      run: async (a, env) => {
        const { validateBatch, RAW_LEGEND } = await import("./registry.js");
        let ops = a.ops as Array<Record<string, unknown>> | undefined;
        if (a.preset) {
          const p = (await readLib<Preset>(env.ctx, "presets"))[String(a.preset)];
          if (!p) throw new McpToolError("NOT_FOUND", `no preset '${a.preset}'`);
          ops = substitute(p.ops, { ...p.params, ...((a.params as object) ?? {}) }) as Array<Record<string, unknown>>;
        }
        if (!ops?.length) throw new McpToolError("INVALID_INPUT", "pass ops or preset");
        const valid = validateBatch(ops);
        const files = (a.files as string[]).map((f) => env.ctx.spritePath(f));
        // Stage every file first (dry runs produce working copies); commit only when all succeeded.
        const staged: Array<{ file: string; work: string; before?: string }> = [];
        try {
          for (const [i, file] of files.entries()) {
            env.progress?.(i, files.length * 2, `staging ${path.basename(file)}`);
            const r = await env.ctx.edit({ file, live: false }, valid, { dryRun: true, signal: env.signal, rawLegendOps: RAW_LEGEND });
            staged.push({ file, work: r.workPath!, before: r.prevVersion });
          }
        } catch (e) {
          for (const s of staged) await rm(s.work, { force: true });
          throw new McpToolError("SCRIPT_ERROR", `recipe failed while staging '${env.ctx.display(files[staged.length])}': ${(e as Error).message}; no file was changed`);
        }
        const committed: Array<{ file: string; checkpoint?: string; version?: string }> = [];
        try {
          for (const [i, s] of staged.entries()) {
            env.progress?.(files.length + i, files.length * 2, `committing ${path.basename(s.file)}`);
            const r = await env.ctx.locks.run(s.file, () =>
              commitFile(s.file, env.ctx.checkpoints, async (work) => {
                await copyFile(s.work, work);
              }, { label: "recipe", mustExist: true, expectVersion: s.before, docs: env.ctx.docs, inFlight: env.ctx.inFlight }),
            );
            committed.push({ file: s.file, checkpoint: r.checkpoint?.id, version: r.after });
            await env.ctx.docs.logChange(s.file, { at: new Date().toISOString(), from: r.before, to: r.after!, kind: "recipe", ops: valid.map((o) => String(o.op)) });
          }
        } catch (e) {
          // roll back the files already committed from their checkpoints
          for (const c of committed) if (c.checkpoint) await env.ctx.checkpoints.restoreRaw(c.file, c.checkpoint);
          for (const c of committed) env.ctx.docs.touch(c.file);
          throw new McpToolError("CONFLICT", `recipe commit failed (${(e as Error).message}); ${committed.length} committed file(s) were restored from checkpoints`);
        } finally {
          for (const s of staged) await rm(s.work, { force: true });
        }
        return { data: { files: committed.map((c) => ({ file: env.ctx.display(c.file), version: c.version, checkpoint: c.checkpoint })) }, touched: files };
      },
    }),
  op("variant.create", "production", A, "Create a variant file: recolor map, equipment layers shown/hidden, optional flatten",
    { to: str(), recolor: z.array(z.object({ from: Color, to: Color }).strict()).max(256).optional(), show: z.array(z.string().max(512)).max(64).optional(), hide: z.array(z.string().max(512)).max(64).optional(), flatten: z.boolean().optional(), overwrite: z.boolean().optional() },
    { to: "variants/hero_blue.aseprite", recolor: [{ from: "#ff004d", to: "#29adff" }], hide: ["fx"] }, {
      doc: "required", keywords: ["recolor", "skin", "equipment", "palette swap"],
      run: async (a, env) => {
        const to = env.ctx.spritePath(String(a.to));
        if (existsSync(to) && !a.overwrite) throw new McpToolError("FILE_EXISTS", `'${a.to}' already exists`);
        const ops: Array<Record<string, unknown>> = [];
        if ((a.recolor as unknown[] | undefined)?.length) ops.push({ op: "pal.remap", map: a.recolor });
        for (const l of (a.show as string[]) ?? []) ops.push({ op: "layer.set", layer: l, visible: true });
        for (const l of (a.hide as string[]) ?? []) ops.push({ op: "layer.set", layer: l, visible: false });
        if (a.flatten) ops.push({ op: "layer.flatten" });
        await mkdir(path.dirname(to), { recursive: true });
        await env.ctx.aseprite.engine({ cmd: "edit", input: env.file, output: to, ops: normalizeColors(ops), track: false }, env.signal);
        env.ctx.docs.touch(to);
        return { data: { to: env.ctx.display(to), version: await env.ctx.docs.version(to), ops: ops.length }, touched: [to] };
      },
    }),
  op("review.rubric", "production", A, "Subjective review checklist (not auto-scored; record findings with review.note)", {}, {}, {
    run: async () => ({
      data: {
        note: "Judge these by eye after a cold read of the preview (skill://review). Run check.craft first: it measures the tells of generated art (pillow shading, flat ramps, light, banding, confetti, jaggies).",
        items: [
          { aspect: "silhouette", ask: "Does the shape read at 1x? (view.silhouette)" },
          { aspect: "readability", ask: "Are important parts separated by value, not only hue? (view.values)" },
          { aspect: "anatomy", ask: "Are proportions consistent with the brief across frames?" },
          { aspect: "motion", ask: "Do key poses read; is there anticipation, follow-through, weight? (view.gif, onion)" },
          { aspect: "color", ask: "Is the palette harmonious; are ramps hue-shifted rather than only darker?" },
          { aspect: "shading", ask: "Is light consistent with the brief's direction; no pillow shading or banding?" },
          { aspect: "style", ask: "Does it match the reference's line weight, outline style and detail density?" },
        ],
      },
    }),
  }),
  op("check.artifact", "validation", A, "Validate exported files: PNG size vs JSON meta, frame rects in bounds, durations, GIF/PNG headers",
    { files: z.array(str()).min(1).max(256) }, { args: { files: ["out/sheet.json"] } }, {
      run: async (a, env) => {
        const results = [];
        for (const f of a.files as string[]) {
          const abs = env.ctx.outputPath(f);
          const errors: string[] = [];
          const notes: string[] = [];
          if (!existsSync(abs)) {
            results.push({ file: f, errors: ["missing"] });
            continue;
          }
          const buf = await readFile(abs);
          const ext = path.extname(abs).toLowerCase();
          if (ext === ".png") {
            const s = pngSize(buf);
            if (!s) errors.push("not a PNG");
            else notes.push(`${s.w}x${s.h}`);
          } else if (ext === ".gif") {
            if (buf.subarray(0, 3).toString() !== "GIF") errors.push("not a GIF");
          } else if (ext === ".json") {
            const j = JSON.parse(buf.toString("utf8")) as { frames?: unknown; meta?: { image?: string; size?: { w: number; h: number } } };
            const frames = (Array.isArray(j.frames) ? j.frames : Object.values((j.frames as object) ?? {})) as Array<{ frame: { x: number; y: number; w: number; h: number }; duration?: number }>;
            const img = j.meta?.image ? path.join(path.dirname(abs), path.basename(j.meta.image)) : undefined;
            if (img && existsSync(img)) {
              const s = pngSize(await readFile(img));
              if (s && j.meta?.size && (s.w !== j.meta.size.w || s.h !== j.meta.size.h)) errors.push(`image is ${s.w}x${s.h} but JSON says ${j.meta.size.w}x${j.meta.size.h}`);
            } else if (img) errors.push(`atlas image ${path.basename(img)} missing`);
            for (const fr of frames) {
              if (j.meta?.size && (fr.frame.x + fr.frame.w > j.meta.size.w || fr.frame.y + fr.frame.h > j.meta.size.h)) errors.push("frame rect outside the atlas");
              if (fr.duration !== undefined && fr.duration <= 0) errors.push("non-positive frame duration");
            }
            notes.push(`${frames.length} frames`);
          }
          results.push({ file: f, errors, notes });
        }
        return { data: { valid: results.every((r) => r.errors.length === 0), results } };
      },
    }),
];

