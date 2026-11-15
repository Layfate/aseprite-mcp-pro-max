import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pixelArtPrompt } from "./ai.js";
import { normalizeColors, parseColor } from "./colors.js";
import { PRESETS, findGodotRoot, godotSpriteFrames, robloxModule } from "./engines.js";
import { McpToolError } from "./errors.js";
import { extensionsDir, installExtension } from "./install.js";
import { PALETTES, colorRamp, getPreset } from "./palettes.js";
import { SPRITE_EXTENSIONS } from "./paths.js";
import { OPS_DESCRIPTION, Op, ValidationRules } from "./schemas.js";
import { commitFile } from "./transaction.js";
import { VERSION } from "./version.js";
const json = (v) => JSON.stringify(v, (_k, val) => (val === null ? undefined : val));
const text = (v) => [{ type: "text", text: typeof v === "string" ? v : json(v) }];
const image = (base64) => ({ type: "image", data: base64, mimeType: "image/png" });
function toError(e) {
    if (e instanceof McpToolError) {
        return { isError: true, content: text(`${e.code}: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}`) };
    }
    if (e instanceof z.ZodError) {
        return { isError: true, content: text(`INVALID_INPUT: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`) };
    }
    return { isError: true, content: text(`INTERNAL_ERROR: ${e?.message ?? String(e)}`) };
}
const pathArg = z.string().max(4096).describe("Path to a .aseprite/.ase file (relative to the workspace root)");
const liveArg = z.boolean().optional().describe("Act on the sprite open in the running Aseprite editor (requires the bridge extension). `path` then selects a specific open document.");
const frameSel = {
    frame: z.number().int().min(1).optional().describe("1-based frame"),
    frames: z.array(z.number().int().min(1)).max(256).optional(),
    fromFrame: z.number().int().min(1).optional(),
    toFrame: z.number().int().min(1).optional(),
    tag: z.string().optional(),
};
const paletteArg = z
    .union([z.string(), z.array(z.string().or(z.number()))])
    .optional()
    .describe(`Built-in preset name (${Object.keys(PALETTES).join(", ")}) or a list of colors`);
function resolvePalette(p) {
    if (p === undefined)
        return undefined;
    if (typeof p === "string")
        return getPreset(p).colors;
    return p.map(String);
}
/** Frames referenced by a list of ops (for automatic previews). */
function touchedFrames(ops) {
    const set = new Set();
    for (const o of ops) {
        for (const k of ["frame", "toFrame", "fromFrame"])
            if (typeof o[k] === "number")
                set.add(o[k]);
        if (Array.isArray(o.frames))
            for (const f of o.frames)
                if (typeof f === "number")
                    set.add(f);
    }
    return [...set].sort((a, b) => a - b).slice(0, 8);
}
/** mtimes of files in `dir` starting with `stem`, to detect what an export wrote. */
async function snapshot(dir, stem) {
    const m = new Map();
    for (const name of await readdir(dir)) {
        if (!name.startsWith(stem))
            continue;
        const s = await stat(path.join(dir, name));
        if (s.isFile())
            m.set(name, s.mtimeMs);
    }
    return m;
}
async function writtenSince(dir, stem, before) {
    const after = await snapshot(dir, stem);
    return [...after].filter(([name, t]) => before.get(name) !== t).map(([name]) => path.join(dir, name)).sort();
}
export function registerTools(server, ctx) {
    const tool = (name, config, handler) => {
        server.registerTool(name, { title: config.title, description: config.description, inputSchema: config.inputSchema, annotations: { title: config.title, ...config.annotations } }, 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (async (args) => {
            try {
                return await handler(args);
            }
            catch (e) {
                return toError(e);
            }
        }));
    };
    // -------------------------------------------------------------------------
    tool("aseprite_status", {
        title: "Status",
        description: "Report the Aseprite executable/version, workspace roots, live-editor bridge state and optional features. Call first if anything fails.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, async () => {
        let aseprite;
        try {
            aseprite = { path: ctx.aseprite.executable(), version: await ctx.aseprite.version() };
        }
        catch (e) {
            aseprite = { error: e.message, hint: e.hint };
        }
        return {
            content: text({
                server: VERSION,
                aseprite,
                workspaceRoots: ctx.config.roots,
                live: ctx.bridge.status(),
                imageProvider: ctx.imageProvider?.name ?? (ctx.imageProviderError ? `error: ${ctx.imageProviderError}` : "not configured"),
                runLua: ctx.config.allowLua ? "enabled" : "disabled (set ASEPRITE_MCP_ALLOW_LUA=1)",
                conventions: "Coordinates are pixels from the top-left (0,0). Frames are 1-based. Colors are #rrggbb[aa], 'transparent' or palette indices.",
            }),
        };
    });
    // -------------------------------------------------------------------------
    tool("aseprite_create", {
        title: "Create sprite",
        description: "Create a new .aseprite file with an optional palette preset, layers and tagged animations (frames are laid out back to back).",
        inputSchema: {
            path: pathArg,
            width: z.number().int().min(1).max(8192),
            height: z.number().int().min(1).max(8192),
            colorMode: z.enum(["rgb", "indexed", "gray"]).optional().describe("default rgb"),
            palette: paletteArg,
            background: z.string().optional().describe("Fill the bottom layer with this color (default transparent)"),
            layers: z.array(z.string().min(1)).max(64).optional().describe("Layer names, bottom to top (default ['Layer 1'])"),
            frames: z.number().int().min(1).max(1024).optional(),
            frameDurationMs: z.number().int().min(1).max(65535).optional(),
            animations: z
                .array(z.object({ name: z.string().min(1), frames: z.number().int().min(1).max(256), durationMs: z.number().int().min(1).optional(), direction: z.enum(["forward", "reverse", "pingpong", "pingpong_reverse"]).optional() }))
                .max(64)
                .optional()
                .describe("e.g. [{name:'idle',frames:4,durationMs:150},{name:'walk',frames:6,durationMs:100}]"),
            overwrite: z.boolean().optional(),
            preview: z.boolean().optional().describe("Return a preview image"),
        },
    }, async (a) => {
        const file = ctx.spritePath(a.path);
        if (existsSync(file) && !a.overwrite) {
            throw new McpToolError("FILE_EXISTS", `'${a.path}' already exists`, "Pass overwrite: true to replace it (the old file is checkpointed).");
        }
        await mkdir(path.dirname(file), { recursive: true });
        const palette = resolvePalette(a.palette);
        const req = {
            cmd: "create",
            width: a.width,
            height: a.height,
            colorMode: a.colorMode,
            palette: palette?.map((c) => parseColor(c)),
            background: a.background ? parseColor(a.background) : undefined,
            layers: a.layers,
            frames: a.frames,
            frameDurationMs: a.frameDurationMs,
            animations: a.animations,
        };
        const res = await ctx.locks.run(file, () => commitFile(file, ctx.checkpoints, (work) => ctx.aseprite.engine({ ...req, output: work }), { label: "before overwrite" }));
        const content = text({ created: ctx.display(file), sprite: ctx.summarize({ ...res.result.sprite, file }), next: "Draw with aseprite_edit (pixel_map ops)." });
        if (a.preview) {
            const p = await ctx.renderPreview({ file, live: false }, { frames: [1] });
            content.push(image(p.base64));
        }
        return { content };
    });
    // -------------------------------------------------------------------------
    tool("aseprite_inspect", {
        title: "Inspect sprite",
        description: "Read sprite metadata: size, color mode, layers (top to bottom, with which frames have cels), frames and durations, tags, slices and palette.",
        inputSchema: { path: pathArg.optional(), live: liveArg, includePalette: z.boolean().optional().describe("Include palette colors (default true)") },
        annotations: { readOnlyHint: true },
    }, async (a) => {
        const t = ctx.target(a);
        const res = await ctx.query(t, "inspect", { paletteColors: a.includePalette });
        const s = res.sprite;
        return { content: text({ ...s, file: s.file ? ctx.display(path.resolve(s.file)) : undefined }) };
    });
    // -------------------------------------------------------------------------
    tool("aseprite_edit", {
        title: "Edit sprite",
        description: [
            "Apply a batch of edit operations in ONE atomic transaction (all succeed or nothing changes).",
            "File mode writes a working copy, checkpoints the original (see aseprite_history) and swaps atomically.",
            "Live mode applies them in the open editor as a single undoable step.",
            "Prefer few calls with many ops. Use pixel_map to draw sprites as character grids.",
            "Set preview: true to get an image of the touched frames back.",
        ].join(" "),
        inputSchema: {
            path: pathArg.optional(),
            live: liveArg,
            ops: z.array(Op).min(1).max(500).describe(OPS_DESCRIPTION),
            dryRun: z.boolean().optional().describe("Validate and preview without saving"),
            preview: z.boolean().optional(),
            label: z.string().max(60).optional().describe("Checkpoint label / undo name"),
            save: z.boolean().optional().describe("Live mode only: also save the document to disk"),
        },
    }, async (a) => {
        const t = ctx.target(a);
        const ops = a.ops;
        const res = await ctx.edit(t, ops, { dryRun: a.dryRun, label: a.label, save: a.save });
        try {
            const content = text({
                ok: true,
                dryRun: a.dryRun || undefined,
                checkpoint: res.checkpoint,
                sprite: ctx.summarize(res.sprite),
                results: res.results,
            });
            if (a.preview || a.dryRun) {
                const frames = touchedFrames(ops);
                const source = res.workPath ? { file: res.workPath, live: false } : t;
                const p = await ctx.renderPreview(source, { frames: frames.length ? frames : [1] });
                content.push(image(p.base64));
            }
            return { content };
        }
        finally {
            if (res.workPath)
                await rm(res.workPath, { force: true });
        }
    });
    // -------------------------------------------------------------------------
    tool("aseprite_read_pixels", {
        title: "Read pixels",
        description: "Read pixels as a character grid with a color legend ('.' = transparent) — the same format pixel_map accepts, so you can read, modify and write back. Reads the flattened frame unless `layer` is given.",
        inputSchema: {
            path: pathArg.optional(),
            live: liveArg,
            frame: z.number().int().min(1).optional(),
            layer: z.string().optional(),
            x: z.number().int().min(0).optional(),
            y: z.number().int().min(0).optional(),
            width: z.number().int().min(1).optional(),
            height: z.number().int().min(1).optional(),
        },
        annotations: { readOnlyHint: true },
    }, async (a) => {
        const t = ctx.target(a);
        const res = await ctx.query(t, "read_pixels", { frame: a.frame, layer: a.layer, x: a.x, y: a.y, width: a.width, height: a.height, maxPixels: 4096 });
        return { content: text(res) };
    });
    // -------------------------------------------------------------------------
    tool("aseprite_preview", {
        title: "Preview",
        description: "Render frames as a scaled-up PNG image you can look at (nearest-neighbour, checkerboard behind transparency). Multiple frames are laid out in a grid separated by magenta lines; onion shows the previous frame faintly.",
        inputSchema: {
            path: pathArg.optional(),
            live: liveArg,
            ...frameSel,
            layer: z.string().optional().describe("Render just this layer"),
            scale: z.number().int().min(1).max(64).optional().describe("Integer zoom (default: fit ~384px)"),
            targetSize: z.number().int().min(64).max(1024).optional(),
            columns: z.number().int().min(1).max(64).optional(),
            background: z.string().optional().describe("'checker' (default), 'transparent' or a color"),
            onion: z.boolean().optional(),
            grid: z.boolean().optional().describe("Draw a faint pixel grid (scale >= 4)"),
            saveTo: z.string().optional().describe("Also write the preview PNG to this path"),
        },
        annotations: { readOnlyHint: true },
    }, async (a) => {
        const t = ctx.target(a);
        let bg = a.background;
        if (bg && bg !== "checker" && bg !== "transparent")
            bg = parseColor(bg);
        const p = await ctx.renderPreview(t, {
            frame: a.frame, frames: a.frames, fromFrame: a.fromFrame, toFrame: a.toFrame, tag: a.tag,
            layer: a.layer, scale: a.scale, targetSize: a.targetSize, columns: a.columns, background: bg, onion: a.onion, grid: a.grid,
        });
        if (a.saveTo) {
            const out = ctx.workspace.resolve(a.saveTo, { extensions: [".png"] });
            await mkdir(path.dirname(out), { recursive: true });
            await writeFile(out, Buffer.from(p.base64, "base64"));
        }
        return { content: [image(p.base64), ...text({ frames: p.info.frames, scale: p.info.scale, size: `${p.info.width}x${p.info.height}`, saved: a.saveTo })] };
    });
    // -------------------------------------------------------------------------
    tool("aseprite_compare", {
        title: "Compare frames",
        description: "Diff two frames (same sprite, or the same frame in another sprite). Returns pixel-difference count, bounding box, and an image: A | B | diff (red = changed).",
        inputSchema: {
            path: pathArg.optional(),
            live: liveArg,
            frameA: z.number().int().min(1),
            frameB: z.number().int().min(1).optional(),
            otherPath: z.string().optional().describe("Compare against this sprite instead"),
            layer: z.string().optional(),
            image: z.boolean().optional().describe("Return the comparison image (default true)"),
        },
        annotations: { readOnlyHint: true },
    }, async (a) => {
        const t = ctx.target(a);
        if (!a.otherPath && a.frameB === undefined)
            throw new McpToolError("INVALID_INPUT", "pass frameB or otherPath");
        const wantImage = a.image !== false;
        const out = wantImage ? await ctx.aseprite.tempPath(".png") : undefined;
        try {
            const res = await ctx.query(t, "compare", {
                frameA: a.frameA, frameB: a.frameB, layer: a.layer,
                other: a.otherPath ? ctx.spritePath(a.otherPath) : undefined,
                output: out,
            });
            const content = text(res);
            if (out)
                content.push(image((await readFile(out)).toString("base64")));
            return { content };
        }
        finally {
            if (out)
                await rm(out, { force: true });
        }
    });
    // -------------------------------------------------------------------------
    tool("aseprite_validate", {
        title: "Validate sprite",
        description: "Lint pixel art and animation: color count, palette conformance, semi-transparent pixels, stray pixels, empty frames, cels outside the canvas, untagged/duplicate frames and baseline jitter in tags. Also returns per-frame content bounds and top colors.",
        inputSchema: {
            path: pathArg.optional(),
            paths: z.array(z.string()).max(200).optional().describe("Validate several files"),
            live: liveArg,
            rules: ValidationRules.optional(),
        },
        annotations: { readOnlyHint: true },
    }, async (a) => {
        const rules = a.rules ? { ...a.rules } : {};
        if (typeof rules.palette === "string")
            rules.palette = getPreset(rules.palette).colors;
        const extra = { rules: normalizeColors(rules) };
        if (a.paths?.length) {
            const results = {};
            for (const p of a.paths) {
                try {
                    const r = await ctx.query(ctx.target({ path: p }), "validate", extra);
                    results[p] = { valid: r.valid, issues: r.issues };
                }
                catch (e) {
                    results[p] = { error: e.message };
                }
            }
            return { content: text(results) };
        }
        return { content: text(await ctx.query(ctx.target(a), "validate", extra)) };
    });
    // -------------------------------------------------------------------------
    tool("aseprite_export", {
        title: "Export",
        description: [
            "Export with Aseprite's own exporter.",
            "format: png (single frame, or numbered files for several frames), gif (animated), sheet (sprite sheet PNG + JSON data).",
            "preset: godot (also writes a SpriteFrames .tres), roblox (Luau ModuleScript of frame rects), unity, phaser, generic — picks sheet type, data format and padding.",
            "Supports scale, tag/frame range, a single layer, split by layer or tag, trimming.",
        ].join(" "),
        inputSchema: {
            path: pathArg.optional(),
            live: liveArg,
            output: z.string().describe("Output file: .png or .gif. For sheets, the PNG path (the JSON is written beside it)."),
            format: z.enum(["png", "gif", "sheet"]).optional().describe("Default: from output extension (png/gif)"),
            preset: z.enum(["godot", "roblox", "unity", "phaser", "generic"]).optional(),
            scale: z.number().int().min(1).max(64).optional(),
            tag: z.string().optional(),
            fromFrame: z.number().int().min(1).optional(),
            toFrame: z.number().int().min(1).optional(),
            layer: z.string().optional().describe("Export only this layer"),
            ignoreLayers: z.array(z.string()).optional(),
            splitLayers: z.boolean().optional().describe("One file/sheet region per layer (use {layer} in output for png)"),
            splitTags: z.boolean().optional(),
            trim: z.boolean().optional(),
            sheetType: z.enum(["horizontal", "vertical", "rows", "columns", "packed"]).optional(),
            columns: z.number().int().min(1).optional(),
            padding: z.number().int().min(0).max(64).optional().describe("Pixels between frames in the sheet"),
            extrude: z.boolean().optional(),
            mergeDuplicates: z.boolean().optional(),
            dataFormat: z.enum(["json-array", "json-hash"]).optional(),
            godotResPath: z.string().optional().describe("res:// path of the sheet PNG (auto-detected when inside a Godot project)"),
        },
    }, async (a) => {
        const t = ctx.target(a);
        const output = ctx.workspace.resolve(a.output, { extensions: [".png", ".gif"] });
        await mkdir(path.dirname(output), { recursive: true });
        const ext = path.extname(output).toLowerCase();
        const format = a.format ?? (a.preset ? "sheet" : ext === ".gif" ? "gif" : "png");
        if (format === "gif" && ext !== ".gif")
            throw new McpToolError("INVALID_INPUT", "gif output must end in .gif");
        if (format !== "gif" && ext !== ".png")
            throw new McpToolError("INVALID_INPUT", `${format} output must end in .png`);
        // Live mode: export a saved copy of the open document.
        let input = t.file;
        let tempCopy;
        if (t.live) {
            tempCopy = await ctx.aseprite.tempPath(".aseprite");
            await ctx.bridge.request({ cmd: "save", input: t.file, output: tempCopy, copy: true });
            input = tempCopy;
        }
        else if (!input || !existsSync(input)) {
            throw new McpToolError("FILE_NOT_FOUND", `'${a.path}' does not exist`);
        }
        try {
            const preset = PRESETS[(a.preset ?? "generic")];
            const args = ["-b"];
            if (a.layer)
                args.push("--layer", a.layer);
            for (const l of a.ignoreLayers ?? [])
                args.push("--ignore-layer", l);
            if (a.tag)
                args.push("--tag", a.tag);
            if (a.fromFrame || a.toFrame) {
                const from = (a.fromFrame ?? 1) - 1;
                const to = (a.toFrame ?? a.fromFrame ?? 1) - 1;
                args.push("--frame-range", `${from},${to}`);
            }
            if (a.splitLayers)
                args.push("--split-layers");
            if (a.splitTags)
                args.push("--split-tags");
            if (a.trim)
                args.push(format === "sheet" ? "--trim" : "--trim");
            args.push(input);
            if (a.scale && a.scale !== 1)
                args.push("--scale", String(a.scale));
            const stem = path.basename(output, ext).split("{")[0];
            const before = await snapshot(path.dirname(output), stem);
            let dataPath;
            if (format === "sheet") {
                dataPath = output.slice(0, -ext.length) + ".json";
                args.push("--sheet", output, "--data", dataPath, "--format", a.dataFormat ?? preset.dataFormat);
                args.push("--sheet-type", a.sheetType ?? preset.sheetType, "--list-tags", "--list-slices", "--list-layers");
                if (a.columns)
                    args.push("--sheet-columns", String(a.columns));
                const pad = a.padding ?? preset.shapePadding;
                if (pad)
                    args.push("--shape-padding", String(pad));
                if (a.extrude)
                    args.push("--extrude");
                if (a.mergeDuplicates)
                    args.push("--merge-duplicates");
            }
            else {
                let out = output;
                // Several frames to PNG need a {frame} placeholder; add one if missing.
                if (format === "png" && !out.includes("{") && !(a.fromFrame && (a.toFrame ?? a.fromFrame) === a.fromFrame)) {
                    const info = await ctx.aseprite.engine({ cmd: "inspect", input, paletteColors: false });
                    const tagInfo = a.tag ? info.sprite.tags.find((x) => x.name === a.tag) : undefined;
                    const count = tagInfo ? tagInfo.to - tagInfo.from + 1 : a.fromFrame || a.toFrame ? (a.toFrame ?? 1) - (a.fromFrame ?? 1) + 1 : info.sprite.frameCount;
                    if (count > 1)
                        out = output.slice(0, -ext.length) + "_{frame1}" + ext;
                }
                if (a.splitLayers && !out.includes("{layer}"))
                    out = out.slice(0, -ext.length) + "_{layer}" + ext;
                args.push("--save-as", out);
            }
            const run = await ctx.aseprite.run(args);
            if (run.code !== 0) {
                throw new McpToolError("ASEPRITE_FAILED", `export failed (exit ${run.code})`, (run.stderr || run.stdout).trim().slice(0, 1500) || undefined);
            }
            const files = await writtenSince(path.dirname(output), stem, before);
            const result = { format, preset: a.preset, files: files.map((f) => ctx.display(f)) };
            if (format === "sheet" && dataPath && (a.preset === "godot" || a.preset === "roblox")) {
                const data = JSON.parse(await readFile(dataPath, "utf8"));
                if (!Array.isArray(data.frames))
                    throw new McpToolError("INVALID_INPUT", `${a.preset} preset requires dataFormat json-array`);
                if (a.preset === "godot") {
                    let res = a.godotResPath;
                    if (!res) {
                        const root = findGodotRoot(path.dirname(output));
                        if (root)
                            res = "res://" + path.relative(root, output).split(path.sep).join("/");
                        else {
                            res = "res://" + path.basename(output);
                            result.warning = "No project.godot found above the output folder; the .tres assumes the PNG is at the project root. Pass godotResPath to fix.";
                        }
                    }
                    const tres = output.slice(0, -ext.length) + ".tres";
                    await writeFile(tres, godotSpriteFrames(data, res), "utf8");
                    result.godot = { spriteFrames: ctx.display(tres), texture: res };
                }
                else {
                    const lua = output.slice(0, -ext.length) + ".lua";
                    await writeFile(lua, robloxModule(data, path.basename(output, ext)), "utf8");
                    result.roblox = { module: ctx.display(lua) };
                    if (data.meta.size.w > 1024 || data.meta.size.h > 1024) {
                        result.warning = `Sheet is ${data.meta.size.w}x${data.meta.size.h}; Roblox downscales images over 1024x1024. Export per tag (tag:) or use fewer frames.`;
                    }
                }
                if (!files.some((f) => f.endsWith(".tres") || f.endsWith(".lua"))) {
                    result.files = (await writtenSince(path.dirname(output), stem, before)).map((f) => ctx.display(f));
                }
            }
            if (preset.notes && a.preset)
                result.notes = preset.notes;
            return { content: text(result) };
        }
        finally {
            if (tempCopy)
                await rm(tempCopy, { force: true });
        }
    });
    // -------------------------------------------------------------------------
    tool("aseprite_import_image", {
        title: "Import image",
        description: [
            "Turn a PNG/JPG (reference art, a screenshot, or AI-generated 'pixel art') into clean pixel art:",
            "downscale by block majority ('mode', crisp for upscaled pixel art) or nearest, binarize alpha, remove a flat background",
            "(flood from the corners or a key color), and snap to a palette.",
            "Creates a new sprite at `path`, or with `into` adds a new layer to an existing sprite.",
        ].join(" "),
        inputSchema: {
            image: z.string().describe("Source image path inside the workspace"),
            path: z.string().optional().describe("New .aseprite file to create"),
            into: z.string().optional().describe("Existing .aseprite file to add a layer to"),
            live: liveArg,
            width: z.number().int().min(1).max(4096).optional(),
            height: z.number().int().min(1).max(4096).optional(),
            pixelSize: z.number().int().min(1).max(256).optional().describe("Source pixels per art pixel (alternative to width/height)"),
            method: z.enum(["mode", "nearest"]).optional(),
            palette: paletteArg,
            removeBackground: z.union([z.literal("corners"), z.string()]).optional().describe("'corners' or a key color"),
            backgroundTolerance: z.number().int().min(0).max(255).optional(),
            alphaThreshold: z.number().int().min(1).max(255).optional(),
            colorMode: z.enum(["rgb", "indexed"]).optional(),
            layerName: z.string().optional(),
            frame: z.number().int().min(1).optional(),
            x: z.number().int().optional(),
            y: z.number().int().optional(),
            overwrite: z.boolean().optional(),
        },
    }, async (a) => {
        const src = ctx.workspace.resolve(a.image, { extensions: [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tga"] });
        if (!existsSync(src))
            throw new McpToolError("FILE_NOT_FOUND", `'${a.image}' does not exist`);
        const req = {
            cmd: "import",
            file: src,
            width: a.width, height: a.height, pixelSize: a.pixelSize, method: a.method,
            palette: resolvePalette(a.palette)?.map((c) => parseColor(c)),
            removeBackground: a.removeBackground === undefined || a.removeBackground === "corners" ? a.removeBackground : parseColor(a.removeBackground),
            backgroundTolerance: a.backgroundTolerance, alphaThreshold: a.alphaThreshold, colorMode: a.colorMode,
            layerName: a.layerName, frame: a.frame, x: a.x, y: a.y,
        };
        return { content: await importImage(ctx, req, a) };
    });
    // -------------------------------------------------------------------------
    tool("aseprite_palette", {
        title: "Palettes",
        description: "Palette helpers. action=list: built-in presets. get: a preset's colors. ramp: hue-shifted shading ramp from a base color (shadows cool, highlights warm). extract: palette and most-used colors of a sprite.",
        inputSchema: {
            action: z.enum(["list", "get", "ramp", "extract"]),
            preset: z.string().optional(),
            base: z.string().optional().describe("ramp: base color"),
            steps: z.number().int().min(2).max(16).optional(),
            hueShift: z.number().min(0).max(90).optional().describe("ramp: max hue shift in degrees (default 20)"),
            path: z.string().optional().describe("extract: sprite path"),
            live: liveArg,
        },
        annotations: { readOnlyHint: true },
    }, async (a) => {
        switch (a.action) {
            case "list":
                return { content: text(Object.entries(PALETTES).map(([id, p]) => ({ id, name: p.name, colors: p.colors.length, description: p.description }))) };
            case "get": {
                if (!a.preset)
                    throw new McpToolError("INVALID_INPUT", "preset is required");
                const p = getPreset(a.preset);
                return { content: text({ name: p.name, colors: p.colors }) };
            }
            case "ramp": {
                if (!a.base)
                    throw new McpToolError("INVALID_INPUT", "base is required");
                parseColor(a.base);
                return { content: text({ ramp: colorRamp(a.base, a.steps ?? 5, a.hueShift ?? 20), order: "darkest to lightest" }) };
            }
            case "extract": {
                const t = ctx.target(a);
                const info = await ctx.query(t, "inspect", {});
                const v = await ctx.query(t, "validate", { rules: { strayPixels: false }, topColors: 64 });
                return { content: text({ palette: info.sprite.palette.colors, colorsUsed: v.colorsUsed, mostUsed: v.topColors }) };
            }
        }
    });
    // -------------------------------------------------------------------------
    tool("aseprite_history", {
        title: "History / undo",
        description: "File mode: every edit checkpoints the previous version. action=list shows checkpoints, undo restores the previous version (steps), redo re-applies the last undo, restore jumps to a checkpoint id. Live mode: undo/redo in the editor.",
        inputSchema: {
            path: pathArg.optional(),
            live: liveArg,
            action: z.enum(["list", "undo", "redo", "restore"]),
            steps: z.number().int().min(1).max(100).optional(),
            id: z.string().optional().describe("restore: checkpoint id from list"),
        },
    }, async (a) => {
        const t = ctx.target(a);
        if (t.live) {
            if (a.action !== "undo" && a.action !== "redo")
                throw new McpToolError("INVALID_INPUT", "live mode supports undo and redo");
            const res = await ctx.bridge.request({ cmd: a.action, input: t.file, steps: a.steps });
            return { content: text({ ok: true, sprite: ctx.summarize(res.sprite) }) };
        }
        const file = t.file;
        return ctx.locks.run(file, async () => {
            switch (a.action) {
                case "list":
                    return { content: text({ file: ctx.display(file), checkpoints: await ctx.checkpoints.list(file) }) };
                case "undo": {
                    const cp = await ctx.checkpoints.undo(file, a.steps ?? 1);
                    return { content: text({ ok: true, restored: cp.id, createdAt: cp.createdAt }) };
                }
                case "redo":
                    await ctx.checkpoints.redo(file);
                    return { content: text({ ok: true }) };
                case "restore": {
                    if (!a.id)
                        throw new McpToolError("INVALID_INPUT", "id is required");
                    const cp = await ctx.checkpoints.restore(file, a.id);
                    return { content: text({ ok: true, restored: cp.id }) };
                }
            }
        });
    });
    // -------------------------------------------------------------------------
    tool("aseprite_live", {
        title: "Live editor",
        description: "Manage the live connection to a running Aseprite editor. status: bridge state. install_extension: copy the bridge extension into Aseprite (restart Aseprite afterwards). list_open: documents open in the editor. open: open a file in the editor. save: save the active/selected document.",
        inputSchema: {
            action: z.enum(["status", "install_extension", "list_open", "open", "save"]),
            path: z.string().optional(),
            saveAs: z.string().optional(),
        },
    }, async (a) => {
        switch (a.action) {
            case "status":
                return { content: text(ctx.bridge.status()) };
            case "install_extension": {
                let exe;
                try {
                    exe = ctx.aseprite.executable();
                }
                catch {
                    exe = undefined;
                }
                const dir = extensionsDir(exe);
                const res = await installExtension(dir);
                return { content: text({ installed: res.dir, files: res.files, next: "Restart Aseprite. The extension connects automatically while this MCP server runs." }) };
            }
            case "list_open":
                return { content: text(await ctx.bridge.request({ cmd: "list_open" })) };
            case "open": {
                if (!a.path)
                    throw new McpToolError("INVALID_INPUT", "path is required");
                const res = await ctx.bridge.request({ cmd: "inspect", input: ctx.spritePath(a.path) });
                return { content: text({ opened: a.path, sprite: ctx.summarize(res.sprite) }) };
            }
            case "save": {
                const res = await ctx.bridge.request({
                    cmd: "save",
                    input: a.path ? ctx.spritePath(a.path) : undefined,
                    output: a.saveAs ? ctx.workspace.resolve(a.saveAs, { extensions: SPRITE_EXTENSIONS }) : undefined,
                });
                return { content: text(res) };
            }
        }
    });
    // -------------------------------------------------------------------------
    if (ctx.imageProvider) {
        const provider = ctx.imageProvider;
        tool("aseprite_generate_sprite", {
            title: "Generate sprite (AI)",
            description: `Generate a sprite with the configured image provider (${provider.name}), then import it as clean pixel art (downscale, background removal, palette snap) into a new .aseprite file and return a preview. Review and fix the result with aseprite_edit.`,
            inputSchema: {
                prompt: z.string().min(3).max(2000),
                path: z.string().describe("New .aseprite file"),
                width: z.number().int().min(8).max(512),
                height: z.number().int().min(8).max(512),
                palette: paletteArg,
                removeBackground: z.boolean().optional().describe("default true"),
                rawPrompt: z.boolean().optional().describe("Send the prompt unchanged (no pixel-art steering)"),
                keepSource: z.string().optional().describe("Save the raw generated PNG here"),
                overwrite: z.boolean().optional(),
            },
        }, async (a) => {
            const palette = resolvePalette(a.palette);
            const prompt = a.rawPrompt ? a.prompt : pixelArtPrompt(a.prompt, a.width, a.height, typeof a.palette === "string" ? `${getPreset(a.palette).name} (${palette?.length} colors)` : undefined);
            const raw = a.keepSource ? ctx.workspace.resolve(a.keepSource, { extensions: [".png"] }) : await ctx.aseprite.tempPath(".png");
            await mkdir(path.dirname(raw), { recursive: true });
            try {
                await provider.generate({ prompt, width: a.width, height: a.height, output: raw });
                const req = {
                    cmd: "import",
                    file: raw,
                    width: a.width,
                    height: a.height,
                    method: "mode",
                    palette: palette?.map((c) => parseColor(c)),
                    removeBackground: a.removeBackground === false ? undefined : "corners",
                };
                return { content: await importImage(ctx, req, { path: a.path, overwrite: a.overwrite }) };
            }
            finally {
                if (!a.keepSource)
                    await rm(raw, { force: true });
            }
        });
    }
    // -------------------------------------------------------------------------
    if (ctx.config.allowLua) {
        tool("aseprite_run_lua", {
            title: "Run Lua (unsafe)",
            description: "Escape hatch: run arbitrary Aseprite Lua. `sprite` is the opened sprite (when path is given); print() output and the return value are returned. In file mode, changes are saved transactionally only when save: true. Enabled by ASEPRITE_MCP_ALLOW_LUA.",
            inputSchema: { code: z.string().min(1).max(100_000), path: pathArg.optional(), live: liveArg, save: z.boolean().optional() },
            annotations: { destructiveHint: true },
        }, async (a) => {
            if (a.live) {
                return { content: text(await ctx.bridge.request({ cmd: "lua", code: a.code, input: a.path ? ctx.spritePath(a.path) : undefined })) };
            }
            if (!a.path)
                return { content: text(await ctx.aseprite.engine({ cmd: "lua", code: a.code })) };
            const file = ctx.spritePath(a.path);
            if (!a.save)
                return { content: text(await ctx.aseprite.engine({ cmd: "lua", code: a.code, input: file })) };
            const res = await ctx.locks.run(file, () => commitFile(file, ctx.checkpoints, (work) => ctx.aseprite.engine({ cmd: "lua", code: a.code, input: file, output: work }), { label: "run lua", mustExist: true }));
            return { content: text({ ...res.result, checkpoint: res.checkpoint?.id }) };
        });
    }
}
/** Shared by aseprite_import_image and aseprite_generate_sprite. */
async function importImage(ctx, req, a) {
    let target;
    let res;
    if (a.live) {
        res = await ctx.bridge.request({ ...req, input: a.into ? ctx.spritePath(a.into) : undefined });
        if (!a.into) {
            // the bridge creates the sprite in the editor when no input is given
        }
        target = { file: "", live: true };
    }
    else if (a.into) {
        const file = ctx.spritePath(a.into);
        const r = await ctx.locks.run(file, () => commitFile(file, ctx.checkpoints, (work) => ctx.aseprite.engine({ ...req, input: file, output: work }), { label: "import image", mustExist: true }));
        res = r.result;
        target = { file, live: false };
    }
    else {
        if (!a.path)
            throw new McpToolError("INVALID_INPUT", "pass `path` (new sprite) or `into` (existing sprite)");
        const file = ctx.spritePath(a.path);
        if (existsSync(file) && !a.overwrite)
            throw new McpToolError("FILE_EXISTS", `'${a.path}' already exists`, "Pass overwrite: true or use `into`.");
        await mkdir(path.dirname(file), { recursive: true });
        const r = await ctx.locks.run(file, () => commitFile(file, ctx.checkpoints, (work) => ctx.aseprite.engine({ ...req, output: work }), { label: "before import" }));
        res = r.result;
        target = { file, live: false };
    }
    const content = text({
        ok: true,
        file: target.live ? undefined : ctx.display(target.file),
        source: `${res.sourceWidth}x${res.sourceHeight}`,
        removedBackgroundPixels: res.removedBackgroundPixels,
        sprite: ctx.summarize(res.sprite),
        next: "Check the preview, then clean up stray pixels/outlines with aseprite_edit and aseprite_validate.",
    });
    const p = await ctx.renderPreview(target.live ? { live: true } : { file: target.file, live: false }, { frames: [req.frame ?? 1] });
    content.push(image(p.base64));
    return content;
}
//# sourceMappingURL=tools.js.map