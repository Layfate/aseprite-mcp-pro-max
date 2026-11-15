import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { McpToolError } from "./errors.js";
/** Serializes async work per key (one writer per file). */
export class KeyedMutex {
    tails = new Map();
    async run(key, fn) {
        const k = process.platform === "win32" || process.platform === "darwin" ? key.toLowerCase() : key;
        const prev = this.tails.get(k) ?? Promise.resolve();
        let release;
        const gate = new Promise((r) => (release = r));
        const tail = prev.then(() => gate);
        this.tails.set(k, tail);
        await prev.catch(() => undefined);
        try {
            return await fn();
        }
        finally {
            release();
            if (this.tails.get(k) === tail)
                this.tails.delete(k);
        }
    }
}
/** A sibling path with the same extension, so Aseprite picks the same format. */
export function workingPath(target) {
    const dir = path.dirname(target);
    const ext = path.extname(target);
    const base = path.basename(target, ext);
    return path.join(dir, `.${base}.mcp-${randomBytes(4).toString("hex")}${ext}`);
}
async function mtime(p) {
    try {
        return (await stat(p)).mtimeMs;
    }
    catch {
        return undefined;
    }
}
/**
 * Checkpoints live next to the sprite in `.aseprite-mcp/checkpoints/<file>/`.
 * Names are `<timestamp>-<seq>[--label].aseprite` so they sort chronologically.
 */
export class Checkpoints {
    max;
    constructor(max) {
        this.max = max;
    }
    dir(target) {
        return path.join(path.dirname(target), ".aseprite-mcp", "checkpoints", path.basename(target));
    }
    async list(target) {
        const dir = this.dir(target);
        let names;
        try {
            names = await readdir(dir);
        }
        catch {
            return [];
        }
        const out = [];
        for (const name of names.sort()) {
            const m = /^(\d{13})-(\d{4})(?:--(.*))?\.[^.]+$/.exec(name);
            if (!m)
                continue;
            const s = await stat(path.join(dir, name));
            out.push({ id: name, createdAt: new Date(Number(m[1])).toISOString(), bytes: s.size, label: m[3]?.replace(/_/g, " ") });
        }
        return out;
    }
    async create(target, label) {
        if ((await mtime(target)) === undefined)
            return undefined;
        const dir = this.dir(target);
        await mkdir(dir, { recursive: true });
        const existing = await this.list(target);
        const seq = String(existing.length % 10000).padStart(4, "0");
        const safeLabel = label ? "--" + label.replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "_").slice(0, 40) : "";
        const id = `${Date.now()}-${seq}${safeLabel}${path.extname(target)}`;
        await copyFile(target, path.join(dir, id));
        const all = await this.list(target);
        for (const old of all.slice(0, Math.max(0, all.length - this.max))) {
            await rm(path.join(dir, old.id), { force: true });
        }
        const s = await stat(path.join(dir, id));
        return { id, createdAt: new Date().toISOString(), bytes: s.size, label };
    }
    redoPath(target) {
        return path.join(path.dirname(target), ".aseprite-mcp", "redo", path.basename(target));
    }
    async replaceWith(target, src) {
        const tmp = workingPath(target);
        await copyFile(src, tmp);
        await rename(tmp, target);
    }
    /** Step back `steps` checkpoints. The current state is kept as a single redo slot. */
    async undo(target, steps = 1) {
        const all = await this.list(target);
        if (all.length === 0)
            throw new McpToolError("NO_CHECKPOINT", "no checkpoints exist for this file");
        if (steps > all.length)
            throw new McpToolError("NO_CHECKPOINT", `only ${all.length} checkpoint(s) available`);
        const cp = all[all.length - steps];
        const redo = this.redoPath(target);
        await mkdir(path.dirname(redo), { recursive: true });
        await copyFile(target, redo);
        await this.replaceWith(target, path.join(this.dir(target), cp.id));
        for (const c of all.slice(all.length - steps))
            await rm(path.join(this.dir(target), c.id), { force: true });
        return cp;
    }
    /** Re-apply the state that the last undo replaced. */
    async redo(target) {
        const redo = this.redoPath(target);
        if ((await mtime(redo)) === undefined)
            throw new McpToolError("NO_CHECKPOINT", "nothing to redo");
        await this.create(target, "before redo");
        await this.replaceWith(target, redo);
        await rm(redo, { force: true });
    }
    /** Restore a specific checkpoint; the current state is checkpointed first. */
    async restore(target, id) {
        const all = await this.list(target);
        const cp = all.find((c) => c.id === id);
        if (!cp)
            throw new McpToolError("NO_CHECKPOINT", `checkpoint '${id}' not found`);
        await this.create(target, "before restore");
        await this.replaceWith(target, path.join(this.dir(target), cp.id));
        return cp;
    }
    /** A new edit invalidates the redo slot. */
    async clearRedo(target) {
        await rm(this.redoPath(target), { force: true });
    }
}
/**
 * Apply a change to `target` safely:
 *   1. `produce(work)` writes the new version to a sibling working file
 *   2. the original is checkpointed
 *   3. the working file atomically replaces the original
 * If the original changed on disk while we worked, the commit is refused.
 */
export async function commitFile(target, checkpoints, produce, opts = {}) {
    const before = await mtime(target);
    if (opts.mustExist && before === undefined) {
        throw new McpToolError("FILE_NOT_FOUND", `'${target}' does not exist`);
    }
    const work = workingPath(target);
    try {
        const result = await produce(work);
        if ((await mtime(work)) === undefined) {
            throw new McpToolError("ASEPRITE_FAILED", "Aseprite did not write the working file");
        }
        if (opts.dryRun)
            return { result, workPath: work };
        if ((await mtime(target)) !== before) {
            throw new McpToolError("CONFLICT", `'${path.basename(target)}' was modified by another program while editing; nothing was changed`, "Re-run the edit.");
        }
        const checkpoint = before !== undefined ? await checkpoints.create(target, opts.label) : undefined;
        await rename(work, target);
        await checkpoints.clearRedo(target);
        return { result, checkpoint };
    }
    finally {
        if (!opts.dryRun)
            await rm(work, { force: true });
    }
}
//# sourceMappingURL=transaction.js.map