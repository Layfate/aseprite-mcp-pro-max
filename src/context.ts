import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Aseprite } from "./aseprite.js";
import { LiveBridge } from "./bridge.js";
import { normalizeColors } from "./colors.js";
import type { Config } from "./config.js";
import { McpToolError } from "./errors.js";
import { SPRITE_EXTENSIONS, Workspace } from "./paths.js";
import { DocumentStore, type RecoveryReport } from "./runtime/documents.js";
import { JobQueue } from "./runtime/jobs.js";
import { Checkpoints, KeyedMutex, commitFile } from "./transaction.js";
import type { BackgroundRemover, ImageProvider } from "./ai.js";

export interface SpriteSummary {
  file?: string;
  width: number;
  height: number;
  colorMode: string;
  frameCount: number;
  frames: Array<{ frame: number; durationMs: number }>;
  layers: Array<{ path: string; type: string; visible: boolean; celFrames?: string }>;
  tags: Array<{ name: string; from: number; to: number; direction: string }>;
  palette: { size: number; colors?: string[] };
  [k: string]: unknown;
}

export interface Target {
  /** Absolute sprite path (file mode, or a specific document in live mode). */
  file?: string;
  live: boolean;
}

export interface ChangeSummary {
  regions?: Array<Record<string, unknown>>;
  cels?: number;
  pixels?: number;
  truncated?: number;
  [k: string]: unknown;
}

export interface EditResult {
  sprite: SpriteSummary;
  results: unknown[];
  changes?: ChangeSummary;
  checkpoint?: string;
  workPath?: string;
  version?: string;
  prevVersion?: string;
  recovered?: RecoveryReport;
}

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tga"];

export class Context {
  readonly workspace: Workspace;
  readonly aseprite: Aseprite;
  readonly checkpoints: Checkpoints;
  readonly locks = new KeyedMutex();
  readonly docs = new DocumentStore();
  readonly jobs: JobQueue;
  readonly inFlight = new Set<string>();
  /** Op ids executed (coverage recording for tests: ASEPRITE_MCP_COVERAGE_FILE). */
  readonly executed = new Set<string>();
  liveVersions = new Map<string, number>();

  constructor(
    readonly config: Config,
    readonly bridge: LiveBridge,
    readonly imageProvider?: ImageProvider,
    readonly imageProviderError?: string,
    readonly bgRemover?: BackgroundRemover,
  ) {
    this.workspace = new Workspace(config.roots);
    this.aseprite = new Aseprite(config);
    this.checkpoints = new Checkpoints(config.maxCheckpoints);
    this.jobs = new JobQueue(config.jobConcurrency, config.maxQueuedJobs, config.jobTimeoutMs);
  }

  spritePath(p: string): string {
    return this.workspace.resolve(p, { extensions: SPRITE_EXTENSIONS });
  }

  imagePath(p: string): string {
    return this.workspace.resolve(p, { extensions: IMAGE_EXTENSIONS });
  }

  outputPath(p: string, extensions?: string[]): string {
    return this.workspace.resolve(p, extensions ? { extensions } : {});
  }

  /** Resolve the sprite a tool should act on. */
  target(args: { path?: string; live?: boolean }): Target {
    if (args.live) return { live: true, file: args.path ? this.spritePath(args.path) : undefined };
    if (!args.path) throw new McpToolError("INVALID_INPUT", "`path` is required (or pass live: true to use the sprite open in Aseprite)");
    return { live: false, file: this.spritePath(args.path) };
  }

  /** Version string of a target: content hash (files) or the editor's change counter (live). */
  async version(t: Target): Promise<string | undefined> {
    if (t.live) {
      const n = this.liveVersions.get(t.file ?? "(active)");
      return n === undefined ? undefined : `live-${n}`;
    }
    return this.docs.version(t.file!);
  }

  noteLiveVersion(t: Target, v: unknown): string | undefined {
    if (typeof v !== "number") return undefined;
    this.liveVersions.set(t.file ?? "(active)", v);
    return `live-${v}`;
  }

  /** Execute a request against a file or the live editor. */
  async query<T>(t: Target, cmd: string, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const req = normalizeColors({ cmd, input: t.file, ...extra }, { rawLegend: extra.rawLegend === true });
    if (t.live) return this.bridge.request<T>(req);
    if (t.file) await this.recover(t.file);
    return this.aseprite.engine<T>(req, signal);
  }

  /** Cached read-only Lua request (cache key includes the document version). */
  async cachedQuery<T>(t: Target, key: string, run: () => Promise<T>): Promise<{ value: T; version?: string; cached: boolean }> {
    if (t.live || !t.file) {
      const value = await run();
      return { value, version: await this.version(t), cached: false };
    }
    await this.recover(t.file);
    return this.docs.cached(t.file, key, run);
  }

  /** Repair an interrupted transaction on this file (journal-driven). */
  async recover(file: string): Promise<RecoveryReport> {
    return this.docs.recover(file, (cp) => this.checkpoints.restoreRaw(file, cp), this.inFlight);
  }

  /**
   * Apply Lua edit ops. File mode: transactional (stale check, journal, working copy,
   * checkpoint, atomic swap, change log). Live mode: one undoable editor transaction.
   */
  async edit(
    t: Target,
    ops: Array<Record<string, unknown>>,
    opts: { dryRun?: boolean; label?: string; save?: boolean; expectVersion?: string; signal?: AbortSignal; rawLegendOps?: Set<string> } = {},
  ): Promise<EditResult> {
    const prepared = ops.map((o) => normalizeColors(o, { rawLegend: opts.rawLegendOps?.has(String(o.op)) }));
    for (const o of ops) this.executed.add(String(o.op));
    if (t.live) {
      if (opts.dryRun) throw new McpToolError("INVALID_INPUT", "dryRun is not supported in live mode; use undo instead");
      const before = await this.version(t);
      if (opts.expectVersion && before && opts.expectVersion !== before) {
        throw new McpToolError("STALE_VERSION", `the open document is at ${before}, not ${opts.expectVersion}`, "Inspect again and retry.");
      }
      const res = await this.bridge.request<EditResult & { liveVersion?: number }>({ cmd: "edit", input: t.file, ops: prepared, label: opts.label ?? "MCP edit", save: opts.save });
      return { ...res, version: this.noteLiveVersion(t, res.liveVersion), prevVersion: before };
    }
    const file = t.file!;
    return this.locks.run(file, async () => {
      const recovered = await this.recover(file);
      const { result, checkpoint, workPath, before, after } = await commitFile(
        file,
        this.checkpoints,
        (work) => this.aseprite.engine<EditResult>({ cmd: "edit", input: file, output: work, ops: prepared }, opts.signal),
        { dryRun: opts.dryRun, label: opts.label, mustExist: true, expectVersion: opts.expectVersion, docs: this.docs, inFlight: this.inFlight },
      );
      if (!opts.dryRun) {
        await this.docs.logChange(file, {
          at: new Date().toISOString(), from: before, to: after!, label: opts.label, kind: "edit",
          ops: ops.map((o) => String(o.op)), summary: compactChanges(result.changes),
        });
      }
      return {
        ...result,
        checkpoint: checkpoint?.id,
        workPath,
        version: opts.dryRun ? before : after,
        prevVersion: before,
        recovered: recovered.action !== "none" ? recovered : undefined,
      };
    });
  }

  /** Render a Lua view to a temporary PNG and return it as base64 plus the view's info. */
  async render(t: Target, view: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ base64: string; info: Record<string, unknown> }> {
    const out = await this.aseprite.tempPath(".png");
    try {
      const info = await this.query<Record<string, unknown>>(t, "render", { view, args, output: out }, signal);
      const bytes = await readFile(out);
      return { base64: bytes.toString("base64"), info };
    } finally {
      await rm(out, { force: true });
    }
  }

  /** v1 preview helper (legacy profile). */
  async renderPreview(t: Target, opts: Record<string, unknown>): Promise<{ base64: string; info: { frames: number[]; scale: number; width: number; height: number } }> {
    const r = await this.render(t, "view.frames", opts);
    return { base64: r.base64, info: r.info as { frames: number[]; scale: number; width: number; height: number } };
  }

  display(p: string | undefined): string | undefined {
    return p ? this.workspace.display(p) : undefined;
  }

  /** Compact sprite summary for tool responses. */
  summarize(s: SpriteSummary): Record<string, unknown> {
    const durations = new Set(s.frames.map((f) => f.durationMs));
    return {
      file: s.file ? this.display(path.resolve(s.file)) : undefined,
      size: `${s.width}x${s.height}`,
      colorMode: s.colorMode,
      frames: s.frameCount,
      frameDurationMs: durations.size === 1 ? [...durations][0] : s.frames.map((f) => f.durationMs),
      layers: s.layers.map((l) => (l.type === "image" ? `${l.path}${l.visible ? "" : " (hidden)"} [cels: ${l.celFrames || "none"}]` : `${l.path}/ (${l.type})`)),
      tags: s.tags.map((t) => `${t.name} ${t.from}-${t.to}${t.direction !== "forward" ? " " + t.direction : ""}`),
      paletteSize: s.palette.size,
    };
  }
}

/** Changes reduced for logs and min-detail results. */
export function compactChanges(c: ChangeSummary | undefined, maxRegions = 8): ChangeSummary | undefined {
  if (!c) return undefined;
  const out: ChangeSummary = { ...c };
  if (Array.isArray(c.regions) && c.regions.length > maxRegions) {
    out.regions = c.regions.slice(0, maxRegions);
    out.truncated = (c.truncated ?? 0) + c.regions.length - maxRegions;
  }
  if (Array.isArray(out.regions) && out.regions.length === 0) delete out.regions;
  return out;
}
