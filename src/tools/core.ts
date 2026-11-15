import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ADAPTERS } from "../catalog/actions-engines.js";
import { CATALOG, areaCounts, describe, getOp, search, validateBatch } from "../catalog/registry.js";
import { AREAS } from "../catalog/types.js";
import type { Context, SpriteSummary } from "../context.js";
import { McpToolError } from "../errors.js";
import { executeOp, runBatch, submitJob, text, type Detail } from "../runtime/executor.js";
import { VERSION } from "../version.js";

type Handler<S extends z.ZodRawShape> = (a: z.infer<z.ZodObject<S>>) => Promise<CallToolResult["content"]>;

export function toError(e: unknown): CallToolResult {
  if (e instanceof McpToolError) return { isError: true, content: text(`${e.code}: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}`) };
  if (e instanceof z.ZodError) return { isError: true, content: text(`INVALID_INPUT: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`) };
  return { isError: true, content: text(`INTERNAL_ERROR: ${(e as Error)?.message ?? String(e)}`) };
}

export function registerTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  handler: Handler<S>,
  annotations: Record<string, boolean> = {},
): void {
  server.registerTool(
    name,
    { description, inputSchema, annotations },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (a: any) => {
      try {
        return { content: await handler(a) };
      } catch (e) {
        return toError(e);
      }
    }) as never,
  );
}

const path = z.string().max(4096).optional();
const live = z.boolean().optional();
const detail = z.enum(["min", "normal", "full"]).optional();
const expectVersion = z.string().max(32).optional();
const RO = { readOnlyHint: true };

/** Startup interface: 11 compact tools; the 200+ operations are discovered on demand. */
export function registerCoreTools(server: McpServer, ctx: Context): void {
  registerTool(server, "capabilities", "Server, Aseprite, live editor, providers, limits, catalog areas and engine adapters. Call first if something fails.", {}, async () => {
    let aseprite: Record<string, unknown>;
    try {
      aseprite = { path: ctx.aseprite.executable(), version: await ctx.aseprite.version() };
    } catch (e) {
      aseprite = { error: (e as Error).message, hint: (e as McpToolError).hint };
    }
    const client = server.server.getClientVersion();
    return text({
      server: VERSION,
      mcp: { latest: LATEST_PROTOCOL_VERSION, supported: SUPPORTED_PROTOCOL_VERSIONS, client: client ? `${client.name} ${client.version}` : undefined, clientCapabilities: Object.keys(server.server.getClientCapabilities() ?? {}) },
      aseprite,
      live: ctx.bridge.status(),
      providers: {
        image: ctx.imageProvider?.name ?? (ctx.imageProviderError ? `error: ${ctx.imageProviderError}` : "not configured"),
        backgroundRemoval: ctx.bgRemover?.name ? `builtin + ${ctx.bgRemover.name}` : "builtin (flat backgrounds)",
      },
      workspaceRoots: ctx.config.roots,
      profiles: ctx.config.profiles,
      catalog: { operations: CATALOG.length, areas: areaCounts() },
      engines: ADAPTERS.map((a) => `${a.id}:${a.level}`),
      limits: { batchOps: 500, readPixels: 4096, jobs: ctx.jobs.stats(), timeoutMs: ctx.config.timeoutMs, maxCheckpoints: ctx.config.maxCheckpoints },
      cache: ctx.docs.stats,
      spawns: ctx.aseprite.spawned,
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      conventions: "Pixels from top-left (0,0); frames 1-based; colors #rrggbb[aa], 'transparent' or palette index; layers by name or 'Group/Child'.",
    });
  }, RO);

  registerTool(server, "search_ops", `Find operations by words (e.g. "flood fill", "godot tileset"). area: ${AREAS.join("|")}. Returns ids + one-line summaries.`, {
    query: z.string().max(200).optional(),
    area: z.enum(AREAS as [string, ...string[]]).optional(),
    kind: z.enum(["edit", "query", "render", "action"]).optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }, async (a) => text(search(a.query, a)), RO);

  registerTool(server, "describe_ops", "JSON schemas (+ example) for up to 10 operation ids. Unknown fields are rejected at run time.", {
    ops: z.array(z.string().max(64)).min(1).max(10),
    examples: z.boolean().optional(),
  }, async (a) => text(a.ops.map((id) => describe(getOp(id), a.examples !== false))), RO);

  registerTool(server, "run_op", "Run one operation: {op, args}. Edits are atomic + checkpointed; queries/previews are cached by document version. background:true returns a job id.", {
    op: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()).optional(),
    path,
    live,
    expectVersion,
    dryRun: z.boolean().optional(),
    detail,
    fields: z.array(z.string().max(64)).max(32).optional(),
    output: z.enum(["image", "file"]).optional(),
    saveTo: z.string().max(4096).optional(),
    preview: z.boolean().optional(),
    background: z.boolean().optional(),
  }, async (a) => {
    const opts = { path: a.path, live: a.live, expectVersion: a.expectVersion, dryRun: a.dryRun, detail: a.detail as Detail, fields: a.fields, output: a.output, saveTo: a.saveTo, preview: a.preview };
    if (a.background) {
      getOp(a.op); // fail fast on unknown ids
      return submitJob(ctx, a.op, (signal, progress) => executeOp(ctx, a.op, a.args ?? {}, { ...opts, signal, progress }));
    }
    return executeOp(ctx, a.op, a.args ?? {}, opts);
  });

  registerTool(server, "batch", "Apply many edit ops ([{op, ...args}]) to one document in one atomic, checkpointed transaction (all or nothing).", {
    path,
    live,
    ops: z.array(z.object({ op: z.string().max(64) }).passthrough()).min(1).max(500),
    expectVersion,
    dryRun: z.boolean().optional(),
    preview: z.boolean().optional(),
    label: z.string().max(60).optional(),
    detail,
    background: z.boolean().optional(),
  }, async (a) => {
    const t = ctx.target(a);
    const ops = validateBatch(a.ops as Array<Record<string, unknown>>);
    const opts = { expectVersion: a.expectVersion, dryRun: a.dryRun, preview: a.preview, label: a.label, detail: a.detail as Detail };
    if (a.background) return submitJob(ctx, "batch", (signal) => runBatch(ctx, t, ops, { ...opts, signal }));
    return runBatch(ctx, t, ops, opts);
  });

  registerTool(server, "inspect", "Document summary with version. detail=full adds layers/frames/tags/slices/palette (paged by offset/limit); fields selects keys.", {
    path,
    live,
    detail: z.enum(["summary", "full"]).optional(),
    fields: z.array(z.string().max(64)).max(32).optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }, async (a) => {
    const t = ctx.target(a);
    const full = a.detail === "full";
    const r = await ctx.cachedQuery(t, `inspect:${full}`, () => ctx.query<{ sprite: SpriteSummary; liveVersion?: number }>(t, "inspect", { paletteColors: full, brief: full }));
    const version = t.live ? ctx.noteLiveVersion(t, r.value.liveVersion) : r.version;
    const s = r.value.sprite;
    let out: Record<string, unknown>;
    if (!full) {
      out = { version, ...ctx.summarize(s), slices: s.slices && (s.slices as unknown[]).length ? (s.slices as Array<{ name: string }>).map((x) => x.name) : undefined, pivot: s.pivot, selection: s.selection, hasBrief: s.hasBrief };
    } else {
      const off = a.offset ?? 0;
      const lim = a.limit ?? 100;
      const page = <T>(list: T[]) => list.slice(off, off + lim);
      out = { version, ...s, file: ctx.display(s.file), layers: page(s.layers), frames: page(s.frames), total: { layers: s.layers.length, frames: s.frames.length } };
    }
    if (a.fields?.length) out = Object.fromEntries(Object.entries(out).filter(([k]) => k === "version" || a.fields!.includes(k)));
    return text({ ...out, cached: r.cached || undefined });
  }, RO);

  registerTool(server, "preview", "Render a view as an image: frames (default; tag/onion/grid), contact_sheet, tile_repeat, compare, palette, silhouette, values. Cached per version.", {
    path,
    live,
    view: z.enum(["frames", "contact_sheet", "tile_repeat", "compare", "palette", "silhouette", "values"]).optional(),
    frame: z.number().int().min(1).optional(),
    frames: z.array(z.number().int().min(1)).max(64).optional(),
    tag: z.string().max(256).optional(),
    layer: z.string().max(512).optional(),
    onion: z.boolean().optional(),
    scale: z.number().int().min(1).max(64).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    output: z.enum(["image", "file"]).optional(),
    saveTo: z.string().max(4096).optional(),
  }, async (a) => {
    const view = `view.${a.view ?? "frames"}`;
    const shortcut: Record<string, unknown> = { frame: a.frame, frames: a.frames, tag: a.tag, layer: a.layer, onion: a.onion, scale: a.scale };
    const allowed = Object.keys(getOp(view).shape);
    const args = { ...Object.fromEntries(Object.entries(shortcut).filter(([k, v]) => v !== undefined && allowed.includes(k))), ...(a.args ?? {}) };
    return executeOp(ctx, view, args, { path: a.path, live: a.live, output: a.output ?? "image", saveTo: a.saveTo });
  }, RO);

  registerTool(server, "changes", "Change report: edits since a version (from the change log), or a pixel diff per frame against a checkpoint.", {
    path: z.string().max(4096),
    since: z.string().max(32).optional(),
    against: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }, async (a) => {
    const file = ctx.spritePath(a.path);
    const version = await ctx.docs.version(file);
    if (a.against) {
      const cps = await ctx.checkpoints.list(file);
      const cp = cps.find((c) => c.id === a.against);
      if (!cp) throw new McpToolError("NO_CHECKPOINT", `checkpoint '${a.against}' not found`);
      const other = `${ctx.checkpoints.dir(file)}/${cp.id}`;
      const [cur, old] = await Promise.all([
        ctx.query<{ sprite: SpriteSummary }>({ file, live: false }, "inspect", { paletteColors: false }),
        ctx.query<{ sprite: SpriteSummary }>({ file: other, live: false }, "inspect", { paletteColors: false }),
      ]);
      const structural = {
        size: cur.sprite.width !== old.sprite.width || cur.sprite.height !== old.sprite.height ? `${old.sprite.width}x${old.sprite.height} -> ${cur.sprite.width}x${cur.sprite.height}` : undefined,
        frames: cur.sprite.frameCount !== old.sprite.frameCount ? `${old.sprite.frameCount} -> ${cur.sprite.frameCount}` : undefined,
        layers: JSON.stringify(cur.sprite.layers.map((l) => l.path)) !== JSON.stringify(old.sprite.layers.map((l) => l.path)) ? { before: old.sprite.layers.map((l) => l.path), after: cur.sprite.layers.map((l) => l.path) } : undefined,
      };
      const frames = [];
      if (!structural.size) {
        const n = Math.min(cur.sprite.frameCount, old.sprite.frameCount, 32);
        for (let f = 1; f <= n; f++) {
          const d = await ctx.query<{ differentPixels: number; bounds?: unknown }>({ file, live: false }, "render", { view: "view.compare", args: { frameA: f, frameB: f, other } });
          if (d.differentPixels > 0) frames.push({ frame: f, pixels: d.differentPixels, bounds: d.bounds });
        }
      }
      return text({ version, against: cp.id, structural, changedFrames: frames });
    }
    return text({ version, entries: await ctx.docs.changes(file, { since: a.since, limit: a.limit }) });
  }, RO);

  registerTool(server, "checkpoint", "List checkpoints (bounded undo history) or create a named one before risky work.", {
    path: z.string().max(4096),
    action: z.enum(["list", "create"]),
    label: z.string().max(60).optional(),
  }, async (a) => {
    const file = ctx.spritePath(a.path);
    return ctx.locks.run(file, async () => {
      if (a.action === "create") {
        const cp = await ctx.checkpoints.create(file, a.label ?? "manual");
        if (!cp) throw new McpToolError("FILE_NOT_FOUND", `'${a.path}' does not exist`);
        return text({ ok: true, checkpoint: cp.id, version: await ctx.docs.version(file) });
      }
      return text({ version: await ctx.docs.version(file), checkpoints: await ctx.checkpoints.list(file), redo: (await ctx.checkpoints.redoList(file)).length });
    });
  }, RO);

  registerTool(server, "restore", "Undo/redo (bounded stacks) or restore a checkpoint id. Live mode: editor undo/redo.", {
    path,
    live,
    action: z.enum(["undo", "redo", "restore"]),
    steps: z.number().int().min(1).max(100).optional(),
    id: z.string().max(200).optional(),
    expectVersion,
  }, async (a) => {
    const t = ctx.target(a);
    if (t.live) {
      if (a.action === "restore") throw new McpToolError("INVALID_INPUT", "live mode supports undo and redo");
      const res = await ctx.bridge.request<{ sprite: SpriteSummary; liveVersion?: number }>({ cmd: a.action, input: t.file, steps: a.steps });
      return text({ ok: true, version: ctx.noteLiveVersion(t, res.liveVersion), sprite: ctx.summarize(res.sprite) });
    }
    const file = t.file!;
    return ctx.locks.run(file, async () => {
      const before = await ctx.docs.version(file);
      if (a.expectVersion && a.expectVersion !== before) throw new McpToolError("STALE_VERSION", `document is at ${before}, not ${a.expectVersion}`);
      let detailOut: Record<string, unknown>;
      if (a.action === "undo") detailOut = { restored: (await ctx.checkpoints.undo(file, a.steps ?? 1)).id };
      else if (a.action === "redo") detailOut = { redone: await ctx.checkpoints.redo(file, a.steps ?? 1) };
      else {
        if (!a.id) throw new McpToolError("INVALID_INPUT", "id is required for restore");
        detailOut = { restored: (await ctx.checkpoints.restore(file, a.id)).id };
      }
      ctx.docs.touch(file);
      const after = await ctx.docs.version(file);
      await ctx.docs.logChange(file, { at: new Date().toISOString(), from: before, to: after!, kind: a.action });
      return text({ ok: true, ...detailOut, version: after, prevVersion: before });
    });
  });

  registerTool(server, "jobs", "Background jobs: list, status (progress), result, cancel (stops the Aseprite process).", {
    action: z.enum(["list", "status", "result", "cancel"]),
    id: z.string().max(64).optional(),
  }, async (a) => {
    if (a.action === "list") return text({ jobs: ctx.jobs.list(), ...ctx.jobs.stats() });
    if (!a.id) throw new McpToolError("INVALID_INPUT", "id is required");
    if (a.action === "status") return text(ctx.jobs.status(a.id));
    if (a.action === "cancel") return text(ctx.jobs.cancel(a.id));
    const r = ctx.jobs.result(a.id);
    return text({ ...r.info, result: r.result });
  });
}
