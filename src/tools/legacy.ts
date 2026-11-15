import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LEGACY_OPS, validateBatch } from "../catalog/registry.js";
import { parseColor } from "../colors.js";
import type { Context, SpriteSummary } from "../context.js";
import { McpToolError } from "../errors.js";
import { extensionsDir, installExtension } from "../install.js";
import { PALETTES } from "../palettes.js";
import { executeOp, image, runBatch, text } from "../runtime/executor.js";
import { VERSION } from "../version.js";
import { registerTool } from "./core.js";

/**
 * v1-compatible tools (ASEPRITE_MCP_PROFILE=legacy): same names and arguments as
 * aseprite-mcp-pro-max 1.0, implemented on top of the operation catalog.
 * The v1 Roblox preset was removed in 2.0.
 */

const pathArg = z.string().max(4096);
const liveArg = z.boolean().optional();
const frameSel = {
  frame: z.number().int().min(1).optional(),
  frames: z.array(z.number().int().min(1)).max(256).optional(),
  fromFrame: z.number().int().min(1).optional(),
  toFrame: z.number().int().min(1).optional(),
  tag: z.string().optional(),
};
const paletteArg = z.union([z.string(), z.array(z.string().or(z.number()))]).optional();

const parsed = (content: Awaited<ReturnType<typeof executeOp>>): Record<string, unknown> => JSON.parse((content.find((c) => c.type === "text") as { text: string }).text) as Record<string, unknown>;

/** Map a v1 op to a catalog op. */
export function mapLegacyOp(o: Record<string, unknown>): Record<string, unknown> {
  const name = String(o.op);
  if (name === "add_layer" && o.group) {
    const { group: _g, ...rest } = o;
    return { ...rest, op: "layer.add_group" };
  }
  if (name === "clear" && o.x === undefined && o.width === undefined) return { ...o, op: "cel.delete" };
  if (name === "delete_slice") return { op: "slice.delete", slice: o.name };
  const id = LEGACY_OPS[name] ?? name;
  return { ...o, op: id };
}

export function registerLegacyTools(server: McpServer, ctx: Context): void {
  registerTool(server, "aseprite_status", "Report the Aseprite executable/version, workspace roots, live-editor bridge state and optional features.", {}, async () => {
    let aseprite: Record<string, unknown>;
    try {
      aseprite = { path: ctx.aseprite.executable(), version: await ctx.aseprite.version() };
    } catch (e) {
      aseprite = { error: (e as Error).message };
    }
    return text({ server: VERSION, aseprite, workspaceRoots: ctx.config.roots, live: ctx.bridge.status(), imageProvider: ctx.imageProvider?.name ?? "not configured", runLua: ctx.config.allowLua ? "enabled" : "disabled" });
  }, { readOnlyHint: true });

  registerTool(server, "aseprite_create", "Create a new .aseprite file with an optional palette preset, layers and tagged animations.", {
    path: pathArg, width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192),
    colorMode: z.enum(["rgb", "indexed", "gray"]).optional(), palette: paletteArg, background: z.string().optional(),
    layers: z.array(z.string().min(1)).max(64).optional(), frames: z.number().int().min(1).max(1024).optional(),
    frameDurationMs: z.number().int().min(1).max(65535).optional(),
    animations: z.array(z.object({ name: z.string().min(1), frames: z.number().int().min(1).max(256), durationMs: z.number().int().min(1).optional(), direction: z.enum(["forward", "reverse", "pingpong", "pingpong_reverse"]).optional() })).max(64).optional(),
    overwrite: z.boolean().optional(), preview: z.boolean().optional(),
  }, async (a) => {
    const { preview, ...args } = a;
    const r = parsed(await executeOp(ctx, "doc.create", args));
    const content = text({ created: (r.result as { created: string }).created, sprite: (r.result as { sprite: unknown }).sprite });
    if (preview) content.push(image((await ctx.render({ file: ctx.spritePath(a.path), live: false }, "view.frames", { frames: [1] })).base64));
    return content;
  });

  registerTool(server, "aseprite_inspect", "Read sprite metadata: size, color mode, layers, frames, tags, slices and palette.", {
    path: pathArg.optional(), live: liveArg, includePalette: z.boolean().optional(),
  }, async (a) => {
    const t = ctx.target(a);
    const res = await ctx.query<{ sprite: SpriteSummary }>(t, "inspect", { paletteColors: a.includePalette });
    return text({ ...res.sprite, file: res.sprite.file ? ctx.display(res.sprite.file) : undefined });
  }, { readOnlyHint: true });

  registerTool(server, "aseprite_edit", "Apply a batch of v1 edit operations in one atomic transaction (v1 op names, e.g. pixel_map, rect, add_layer).", {
    path: pathArg.optional(), live: liveArg, ops: z.array(z.object({ op: z.string() }).passthrough()).min(1).max(500),
    dryRun: z.boolean().optional(), preview: z.boolean().optional(), label: z.string().max(60).optional(), save: z.boolean().optional(),
  }, async (a) => {
    const t = ctx.target(a);
    const ops = validateBatch((a.ops as Array<Record<string, unknown>>).map(mapLegacyOp));
    return runBatch(ctx, t, ops, { dryRun: a.dryRun, preview: a.preview, label: a.label, detail: "full" });
  });

  registerTool(server, "aseprite_read_pixels", "Read pixels as a character grid with a color legend (pixel_map format).", {
    path: pathArg.optional(), live: liveArg, frame: z.number().int().min(1).optional(), layer: z.string().optional(),
    x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(), width: z.number().int().min(1).optional(), height: z.number().int().min(1).optional(),
  }, async (a) => {
    const { path, live, ...args } = a;
    return text((parsed(await executeOp(ctx, "pixels.read", args, { path, live })).result));
  }, { readOnlyHint: true });

  registerTool(server, "aseprite_preview", "Render frames as a scaled-up PNG image (nearest-neighbour, checkerboard).", {
    path: pathArg.optional(), live: liveArg, ...frameSel, layer: z.string().optional(), scale: z.number().int().min(1).max(64).optional(),
    targetSize: z.number().int().min(64).max(1024).optional(), columns: z.number().int().min(1).max(64).optional(), background: z.string().optional(),
    onion: z.boolean().optional(), grid: z.boolean().optional(), saveTo: z.string().optional(),
  }, async (a) => {
    const { path, live, saveTo, ...args } = a;
    return executeOp(ctx, "view.frames", args, { path, live, saveTo, output: "image" });
  }, { readOnlyHint: true });

  registerTool(server, "aseprite_compare", "Diff two frames (or the same frame in another sprite) with an A | B | diff image.", {
    path: pathArg.optional(), live: liveArg, frameA: z.number().int().min(1), frameB: z.number().int().min(1).optional(),
    otherPath: z.string().optional(), layer: z.string().optional(), image: z.boolean().optional(),
  }, async (a) => {
    if (!a.otherPath && a.frameB === undefined) throw new McpToolError("INVALID_INPUT", "pass frameB or otherPath");
    const content = await executeOp(ctx, "view.compare", { frameA: a.frameA, frameB: a.frameB, other: a.otherPath, layer: a.layer }, { path: a.path, live: a.live, output: "image" });
    const info = parsed(content.filter((c) => c.type === "text"));
    const out = text(info.info);
    if (a.image !== false) out.push(...content.filter((c) => c.type === "image"));
    return out;
  }, { readOnlyHint: true });

  registerTool(server, "aseprite_validate", "Lint pixel art and animation (check.lint); paths validates several files.", {
    path: pathArg.optional(), paths: z.array(z.string()).max(200).optional(), live: liveArg,
    rules: z.record(z.string(), z.unknown()).optional(),
  }, async (a) => {
    const rules = a.rules ?? {};
    if (a.paths?.length) {
      const results: Record<string, unknown> = {};
      for (const p of a.paths) {
        try {
          const r = parsed(await executeOp(ctx, "check.lint", rules, { path: p })).result as { valid: boolean; issues: unknown[] };
          results[p] = { valid: r.valid, issues: r.issues };
        } catch (e) {
          results[p] = { error: (e as Error).message };
        }
      }
      return text(results);
    }
    return text(parsed(await executeOp(ctx, "check.lint", rules, { path: a.path, live: a.live })).result);
  }, { readOnlyHint: true });

  registerTool(server, "aseprite_export", "Export PNG, GIF or sheet + JSON; presets: godot (SpriteFrames .tres), unity, phaser, generic.", {
    path: pathArg.optional(), live: liveArg, output: z.string(), format: z.enum(["png", "gif", "sheet"]).optional(),
    preset: z.enum(["godot", "unity", "phaser", "generic"]).optional(), scale: z.number().int().min(1).max(64).optional(),
    tag: z.string().optional(), fromFrame: z.number().int().min(1).optional(), toFrame: z.number().int().min(1).optional(), layer: z.string().optional(),
    trim: z.boolean().optional(), sheetType: z.enum(["horizontal", "vertical", "rows", "columns", "packed"]).optional(),
    columns: z.number().int().min(1).optional(), padding: z.number().int().min(0).max(64).optional(), extrude: z.boolean().optional(),
    mergeDuplicates: z.boolean().optional(), dataFormat: z.enum(["json-array", "json-hash"]).optional(), godotResPath: z.string().optional(),
  }, async (a) => {
    if (a.live) throw new McpToolError("INVALID_INPUT", "legacy export works on files; save the live document first");
    const format = a.format ?? (a.preset ? "sheet" : a.output.toLowerCase().endsWith(".gif") ? "gif" : "png");
    const o = { path: a.path };
    let content;
    if (format === "gif") content = await executeOp(ctx, "view.gif", { output: a.output, tag: a.tag, scale: a.scale, layer: a.layer }, o);
    else if (format === "png") content = await executeOp(ctx, "export.png", { output: a.output, tag: a.tag, scale: a.scale, layer: a.layer, fromFrame: a.fromFrame, toFrame: a.toFrame, trim: a.trim }, o);
    else if (a.preset === "godot") content = await executeOp(ctx, "engine.godot_sprite_frames", { output: a.output, scale: a.scale, padding: a.padding, trim: a.trim, tag: a.tag, resPath: a.godotResPath, force: true }, o);
    else if (a.preset === "phaser") content = await executeOp(ctx, "engine.phaser", { output: a.output, scale: a.scale, padding: a.padding, trim: a.trim, tag: a.tag, force: true }, o);
    else {
      content = await executeOp(ctx, "sheet.export", {
        output: a.output, sheetType: a.sheetType, columns: a.columns, padding: a.padding ?? (a.preset === "unity" ? 2 : undefined), extrude: a.extrude,
        trim: a.trim, mergeDuplicates: a.mergeDuplicates, scale: a.scale, tag: a.tag, layer: a.layer, dataFormat: a.dataFormat,
      }, o);
    }
    const r = parsed(content);
    const files = ((r.artifacts as Array<{ path: string }>) ?? []).map((x) => x.path).sort();
    return text({ format, preset: a.preset, files, warnings: r.warnings, ...(r.result as object) });
  });

  registerTool(server, "aseprite_import_image", "Turn a PNG/JPG into clean pixel art: new sprite (path) or new layer (into).", {
    image: z.string(), path: z.string().optional(), into: z.string().optional(), width: z.number().int().min(1).max(4096).optional(),
    height: z.number().int().min(1).max(4096).optional(), pixelSize: z.number().int().min(1).max(256).optional(), method: z.enum(["mode", "nearest"]).optional(),
    palette: paletteArg, removeBackground: z.string().optional(), backgroundTolerance: z.number().int().min(0).max(255).optional(),
    alphaThreshold: z.number().int().min(1).max(255).optional(), colorMode: z.enum(["rgb", "indexed"]).optional(), layerName: z.string().optional(),
    frame: z.number().int().min(1).optional(), x: z.number().int().optional(), y: z.number().int().optional(), overwrite: z.boolean().optional(),
  }, async (a) => {
    const common = { width: a.width, height: a.height, pixelSize: a.pixelSize, method: a.method, palette: a.palette as never, removeBackground: a.removeBackground, backgroundTolerance: a.backgroundTolerance, alphaThreshold: a.alphaThreshold };
    let file: string;
    let extra: Record<string, unknown> = {};
    if (a.into) {
      file = ctx.spritePath(a.into);
      const src = ctx.imagePath(a.image);
      await ctx.locks.run(file, async () => {
        const { commitFile } = await import("../transaction.js");
        const { resolvePalette } = await import("../catalog/actions.js");
        await commitFile(file, ctx.checkpoints, (work) => ctx.aseprite.engine({
          cmd: "import", file: src, input: file, output: work, ...common, palette: resolvePalette(a.palette)?.map((c) => parseColor(c)),
          removeBackground: a.removeBackground === undefined || a.removeBackground === "corners" ? a.removeBackground : parseColor(a.removeBackground),
          layerName: a.layerName, frame: a.frame, x: a.x, y: a.y,
        }), { label: "import image", mustExist: true, docs: ctx.docs, inFlight: ctx.inFlight });
      });
    } else {
      if (!a.path) throw new McpToolError("INVALID_INPUT", "pass `path` (new sprite) or `into` (existing sprite)");
      const r = parsed(await executeOp(ctx, "ref.import", { image: a.image, path: a.path, ...common, colorMode: a.colorMode, layerName: a.layerName, overwrite: a.overwrite })).result as Record<string, unknown>;
      extra = { source: r.source, removedBackgroundPixels: r.removedBackgroundPixels };
      file = ctx.spritePath(a.path);
    }
    const info = await ctx.query<{ sprite: SpriteSummary }>({ file, live: false }, "inspect", { paletteColors: false });
    const content = text({ ok: true, file: ctx.display(file), ...extra, sprite: ctx.summarize(info.sprite) });
    content.push(image((await ctx.render({ file, live: false }, "view.frames", { frames: [a.frame ?? 1] })).base64));
    return content;
  });

  registerTool(server, "aseprite_palette", "Palette helpers: list, get, ramp, extract.", {
    action: z.enum(["list", "get", "ramp", "extract"]), preset: z.string().optional(), base: z.string().optional(),
    steps: z.number().int().min(2).max(16).optional(), hueShift: z.number().min(0).max(90).optional(), path: z.string().optional(), live: liveArg,
  }, async (a) => {
    switch (a.action) {
      case "list":
        return text(Object.entries(PALETTES).map(([id, p]) => ({ id, name: p.name, colors: p.colors.length, description: p.description })));
      case "get":
        return text(parsed(await executeOp(ctx, "pal.preset_get", { preset: a.preset })).result);
      case "ramp":
        return text(parsed(await executeOp(ctx, "pal.ramp", { base: a.base, steps: a.steps, hueShift: a.hueShift })).result);
      default:
        return text(parsed(await executeOp(ctx, "pal.extract", { limit: 64 }, { path: a.path, live: a.live })).result);
    }
  }, { readOnlyHint: true });

  registerTool(server, "aseprite_history", "Checkpoints: list, undo (steps), redo, restore (id). Live mode: editor undo/redo.", {
    path: pathArg.optional(), live: liveArg, action: z.enum(["list", "undo", "redo", "restore"]), steps: z.number().int().min(1).max(100).optional(), id: z.string().optional(),
  }, async (a) => {
    const t = ctx.target(a);
    if (t.live) {
      if (a.action !== "undo" && a.action !== "redo") throw new McpToolError("INVALID_INPUT", "live mode supports undo and redo");
      const res = await ctx.bridge.request<{ sprite: SpriteSummary }>({ cmd: a.action, input: t.file, steps: a.steps });
      return text({ ok: true, sprite: ctx.summarize(res.sprite) });
    }
    const file = t.file!;
    return ctx.locks.run(file, async () => {
      try {
        switch (a.action) {
          case "list":
            return text({ file: ctx.display(file), checkpoints: await ctx.checkpoints.list(file) });
          case "undo": {
            const cp = await ctx.checkpoints.undo(file, a.steps ?? 1);
            return text({ ok: true, restored: cp.id, createdAt: cp.createdAt });
          }
          case "redo":
            await ctx.checkpoints.redo(file, a.steps ?? 1);
            return text({ ok: true });
          default: {
            if (!a.id) throw new McpToolError("INVALID_INPUT", "id is required");
            const cp = await ctx.checkpoints.restore(file, a.id);
            return text({ ok: true, restored: cp.id });
          }
        }
      } finally {
        ctx.docs.touch(file);
      }
    });
  });

  registerTool(server, "aseprite_live", "Live editor: status, install_extension, list_open, open, save.", {
    action: z.enum(["status", "install_extension", "list_open", "open", "save"]), path: z.string().optional(), saveAs: z.string().optional(),
  }, async (a) => {
    switch (a.action) {
      case "status":
        return text(ctx.bridge.status());
      case "install_extension": {
        let exe: string | undefined;
        try {
          exe = ctx.aseprite.executable();
        } catch {
          exe = undefined;
        }
        const res = await installExtension(extensionsDir(exe));
        return text({ installed: res.dir, files: res.files, next: "Restart Aseprite." });
      }
      case "list_open":
        return text(await ctx.bridge.request({ cmd: "list_open" }));
      case "open":
        return text(parsed(await executeOp(ctx, "doc.open_live", { path: a.path })).result);
      default:
        return text(parsed(await executeOp(ctx, "doc.save_live", { path: a.path, saveAs: a.saveAs })).result);
    }
  });
}
