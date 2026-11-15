import { appendFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getOp, RAW_LEGEND, validateArgs, validateBatch } from "../catalog/registry.js";
import type { ActionResult, OpDef, RunEnv } from "../catalog/types.js";
import { normalizeColors } from "../colors.js";
import { compactChanges, type Context, type EditResult, type Target } from "../context.js";
import { McpToolError } from "../errors.js";
import { sidecar } from "./documents.js";

export type Detail = "min" | "normal" | "full";

export interface ExecOptions {
  path?: string;
  live?: boolean;
  expectVersion?: string;
  dryRun?: boolean;
  detail?: Detail;
  fields?: string[];
  output?: "image" | "file";
  saveTo?: string;
  label?: string;
  preview?: boolean;
  signal?: AbortSignal;
  progress?: (done: number, total: number, message?: string) => void;
}

type Content = CallToolResult["content"];

const json = (v: unknown) => JSON.stringify(v, (_k, val) => (val === null ? undefined : val));
export const text = (v: unknown): Content => [{ type: "text", text: typeof v === "string" ? v : json(v) }];
export const image = (base64: string): Content[number] => ({ type: "image", data: base64, mimeType: "image/png" });

function recordCoverage(id: string): void {
  const f = process.env.ASEPRITE_MCP_COVERAGE_FILE;
  if (f) {
    try {
      appendFileSync(f, id + "\n");
    } catch {
      // coverage is best-effort
    }
  }
}

function pick(data: unknown, fields?: string[]): unknown {
  if (!fields?.length || !data || typeof data !== "object" || Array.isArray(data)) return data;
  const o = data as Record<string, unknown>;
  return Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]]));
}

function editPayload(ctx: Context, id: string | undefined, r: EditResult, detail: Detail): Record<string, unknown> {
  const changes = detail === "full" ? r.changes : compactChanges(r.changes, detail === "min" ? 0 : 8);
  if (detail === "min" && changes) delete changes.regions;
  const results = (r.results as Array<Record<string, unknown>>).map((x) => {
    const { op: _op, ...rest } = x;
    return Object.keys(rest).length ? rest : undefined;
  });
  return {
    ok: true,
    op: id,
    version: r.version,
    prevVersion: r.prevVersion,
    checkpoint: r.checkpoint,
    changed: changes,
    results: detail === "min" ? undefined : id ? results[0] : results.some(Boolean) ? results : undefined,
    sprite: detail === "full" ? ctx.summarize(r.sprite) : undefined,
    recovered: r.recovered,
  };
}

/** Run an edit batch (already validated) and produce tool content. */
export async function runBatch(ctx: Context, t: Target, ops: Array<Record<string, unknown>>, o: ExecOptions, id?: string): Promise<Content> {
  for (const x of ops) recordCoverage(String(x.op));
  const env: RunEnv = { ctx, signal: o.signal, file: t.file, live: t.live };
  const prepared: Array<Record<string, unknown>> = [];
  for (const x of ops) {
    const d = getOp(String(x.op));
    prepared.push(d.prepare ? { op: x.op, ...(await d.prepare(stripOp(x), env)) } : x);
  }
  const r = await ctx.edit(t, prepared, { dryRun: o.dryRun, label: o.label ?? (id ? id : `batch(${ops.length})`), expectVersion: o.expectVersion, signal: o.signal, rawLegendOps: RAW_LEGEND });
  try {
    const content = text({ ...editPayload(ctx, id, r, o.detail ?? "normal"), dryRun: o.dryRun || undefined });
    if (o.preview || o.dryRun) {
      const frames = touchedFrames(r, ops);
      const src: Target = r.workPath ? { file: r.workPath, live: false } : t;
      const p = await ctx.render(src, "view.frames", { frames: frames.length ? frames : [1] });
      content.push(image(p.base64));
    }
    return content;
  } finally {
    if (r.workPath) await rm(r.workPath, { force: true });
  }
}

function stripOp(x: Record<string, unknown>): Record<string, unknown> {
  const { op: _op, ...rest } = x;
  return rest;
}

function touchedFrames(r: EditResult, ops: Array<Record<string, unknown>>): number[] {
  const set = new Set<number>();
  for (const reg of r.changes?.regions ?? []) if (typeof reg.frame === "number") set.add(reg.frame);
  if (set.size === 0) {
    for (const o of ops) {
      for (const k of ["frame", "toFrame", "fromFrame"]) if (typeof o[k] === "number") set.add(o[k] as number);
      if (Array.isArray(o.frames)) for (const f of o.frames) if (typeof f === "number") set.add(f);
    }
  }
  return [...set].sort((a, b) => a - b).slice(0, 8);
}

function targetFor(ctx: Context, d: OpDef, o: ExecOptions): Target | undefined {
  if (d.doc === "none") return undefined;
  if (d.doc === "optional" && !o.path && !o.live) return undefined;
  if (o.live && !d.live) throw new McpToolError("INVALID_INPUT", `${d.id} does not support live mode (it runs on files)`);
  return ctx.target({ path: o.path, live: o.live });
}

/** Execute one catalog operation with already-unvalidated args. */
export async function executeOp(ctx: Context, id: string, rawArgs: unknown, o: ExecOptions = {}): Promise<Content> {
  const d = getOp(id);
  const args = validateArgs(d, rawArgs);
  ctx.executed.add(id);
  if (d.requires.includes("live-editor") && !ctx.bridge.connected) {
    throw new McpToolError("DISABLED", `${id} needs the live Aseprite editor, which is not connected`, "Install the bridge extension and keep Aseprite open; file-mode operations work without it.");
  }
  const t = targetFor(ctx, d, o);
  if (t?.file && !t.live) {
    const { existsSync } = await import("node:fs");
    if (!existsSync(t.file)) throw new McpToolError("FILE_NOT_FOUND", `'${o.path}' does not exist`, "Create it with doc.create.");
  }
  const env: RunEnv = { ctx, signal: o.signal, progress: o.progress, file: t?.file, live: t?.live };
  const detail = o.detail ?? "normal";

  if (d.kind === "edit") return runBatch(ctx, t!, validateBatch([{ op: id, ...args }]), o, id);
  recordCoverage(id);

  if (o.expectVersion && t) {
    const v = await ctx.version(t);
    if (v !== o.expectVersion) throw new McpToolError("STALE_VERSION", `document is at ${v ?? "(missing)"}, not ${o.expectVersion}`, "Re-inspect and retry.");
  }

  const prepared = d.prepare ? await d.prepare(args, env) : args;

  if (d.kind === "query") {
    const key = `q:${id}:${json(prepared)}`;
    const r = await ctx.cachedQuery(t!, key, () => ctx.query(t!, "query", { q: id, args: normalizeColors(prepared, { rawLegend: RAW_LEGEND.has(id) }) }, o.signal));
    return text({ ok: true, op: id, version: r.version, cached: r.cached || undefined, result: pick(r.value, o.fields) });
  }

  if (d.kind === "render") {
    const mode = o.output ?? d.defaultOutput ?? "image";
    const key = `r:${id}:${json(prepared)}`;
    const r = await ctx.cachedQuery(t!, key, () => ctx.render(t!, id, normalizeColors(prepared) as Record<string, unknown>, o.signal));
    const info = { ok: true, op: id, version: r.version, cached: r.cached || undefined, info: detail === "min" ? undefined : pick(r.value.info, o.fields) };
    if (mode === "file" || o.saveTo) {
      const file = o.saveTo ? ctx.outputPath(o.saveTo, [".png"]) : t!.file ? sidecar(t!.file, "previews", `${path.basename(t!.file)}.${id}.${r.version ?? "live"}.png`) : await ctx.aseprite.tempPath(".png");
      await mkdir(path.dirname(file), { recursive: true });
      const bytes = Buffer.from(r.value.base64, "base64");
      await writeFile(file, bytes);
      const content = text({ ...info, artifacts: [{ path: ctx.display(file), kind: "png", bytes: bytes.length }] });
      if (mode === "image") content.push(image(r.value.base64));
      return content;
    }
    return [image(r.value.base64), ...text(info)];
  }

  // action
  const res: ActionResult = await d.run!(prepared, env);
  for (const f of res.touched ?? []) ctx.docs.touch(f);
  const content = text({
    ok: true,
    op: id,
    version: t?.file && d.doc !== "none" ? await ctx.docs.version(t.file) : undefined,
    result: detail === "min" && res.artifacts ? undefined : pick(res.data, o.fields),
    artifacts: res.artifacts?.length ? res.artifacts : undefined,
    warnings: res.warnings,
  });
  if (res.image) content.push(image(res.image));
  return content;
}

/** Background execution through the job queue. */
export function submitJob(ctx: Context, id: string, run: (signal: AbortSignal, progress: (d: number, t: number, m?: string) => void) => Promise<Content>): Content {
  const info = ctx.jobs.submit(id, async (signal, progress) => {
    const content = await run(signal, progress);
    // keep text parts only (images are not useful as stored job results)
    return content.filter((c) => c.type === "text").map((c) => {
      try {
        return JSON.parse((c as { text: string }).text) as unknown;
      } catch {
        return (c as { text: string }).text;
      }
    });
  });
  return text({ ok: true, job: info.id, state: info.state, next: `jobs {"action":"status","id":"${info.id}"}` });
}
