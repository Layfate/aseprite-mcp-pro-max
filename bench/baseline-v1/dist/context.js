import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Aseprite } from "./aseprite.js";
import { normalizeColors } from "./colors.js";
import { McpToolError } from "./errors.js";
import { getPreset } from "./palettes.js";
import { SPRITE_EXTENSIONS, Workspace } from "./paths.js";
import { Checkpoints, KeyedMutex, commitFile } from "./transaction.js";
export class Context {
    config;
    bridge;
    imageProvider;
    imageProviderError;
    workspace;
    aseprite;
    checkpoints;
    locks = new KeyedMutex();
    constructor(config, bridge, imageProvider, imageProviderError) {
        this.config = config;
        this.bridge = bridge;
        this.imageProvider = imageProvider;
        this.imageProviderError = imageProviderError;
        this.workspace = new Workspace(config.roots);
        this.aseprite = new Aseprite(config);
        this.checkpoints = new Checkpoints(config.maxCheckpoints);
    }
    spritePath(p) {
        return this.workspace.resolve(p, { extensions: SPRITE_EXTENSIONS });
    }
    /** Resolve the sprite a tool should act on. */
    target(args) {
        if (args.live)
            return { live: true, file: args.path ? this.spritePath(args.path) : undefined };
        if (!args.path)
            throw new McpToolError("INVALID_INPUT", "`path` is required (or pass live: true to use the sprite open in Aseprite)");
        return { live: false, file: this.spritePath(args.path) };
    }
    /** Execute a read-only command against a file or the live editor. */
    async query(t, cmd, extra = {}) {
        const req = normalizeColors({ cmd, input: t.file, ...extra });
        if (t.live)
            return this.bridge.request(req);
        return this.aseprite.engine(req);
    }
    /** Resolve palette presets and workspace paths inside ops, then normalize colors. */
    prepareOps(ops) {
        const prepared = ops.map((op) => {
            const o = { ...op };
            if (o.op === "set_palette") {
                if (typeof o.preset === "string")
                    o.colors = getPreset(o.preset).colors;
                if (!o.colors)
                    throw new McpToolError("INVALID_INPUT", "set_palette needs `colors` or `preset`");
                delete o.preset;
            }
            if (o.op === "import_image" && typeof o.file === "string") {
                o.file = this.workspace.resolve(o.file, { extensions: [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tga"] });
            }
            if (o.op === "line" && !o.points && (o.x1 === undefined || o.y1 === undefined || o.x2 === undefined || o.y2 === undefined)) {
                throw new McpToolError("INVALID_INPUT", "line needs x1,y1,x2,y2 or points");
            }
            if (o.op === "scale" && o.factor === undefined && o.width === undefined && o.height === undefined) {
                throw new McpToolError("INVALID_INPUT", "scale needs factor or width/height");
            }
            return o;
        });
        return normalizeColors(prepared);
    }
    /**
     * Apply ops. File mode: transactional (working copy → validate → checkpoint → atomic swap).
     * Live mode: one undoable transaction in the editor.
     */
    async edit(t, ops, opts = {}) {
        const prepared = this.prepareOps(ops);
        if (t.live) {
            if (opts.dryRun)
                throw new McpToolError("INVALID_INPUT", "dryRun is not supported in live mode; use undo instead");
            const res = await this.bridge.request({
                cmd: "edit",
                input: t.file,
                ops: prepared,
                label: opts.label ?? "MCP edit",
                save: opts.save,
            });
            return res;
        }
        const file = t.file;
        return this.locks.run(file, async () => {
            const { result, checkpoint, workPath } = await commitFile(file, this.checkpoints, (work) => this.aseprite.engine({ cmd: "edit", input: file, output: work, ops: prepared }), { dryRun: opts.dryRun, label: opts.label, mustExist: true });
            return { ...result, checkpoint: checkpoint?.id, workPath };
        });
    }
    /** Render a preview PNG and return it as base64. */
    async renderPreview(t, opts) {
        const out = await this.aseprite.tempPath(".png");
        try {
            const info = await this.query(t, "preview", { ...opts, output: out });
            const bytes = await readFile(out);
            return { base64: bytes.toString("base64"), info };
        }
        finally {
            await rm(out, { force: true });
        }
    }
    display(p) {
        return p ? this.workspace.display(p) : undefined;
    }
    /** Compact sprite summary for tool responses. */
    summarize(s) {
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
//# sourceMappingURL=context.js.map