import { realpathSync } from "node:fs";
import path from "node:path";
import { McpToolError } from "./errors.js";
const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
function norm(p) {
    const r = path.resolve(p);
    return caseInsensitive ? r.toLowerCase() : r;
}
/** Resolve the deepest existing ancestor through symlinks, then re-append the rest. */
function realpathLoose(p) {
    const parts = [];
    let cur = path.resolve(p);
    for (;;) {
        try {
            const real = realpathSync.native(cur);
            return parts.length ? path.join(real, ...parts.reverse()) : real;
        }
        catch {
            const parent = path.dirname(cur);
            if (parent === cur)
                return path.resolve(p);
            parts.push(path.basename(cur));
            cur = parent;
        }
    }
}
function isInside(child, parent) {
    const c = norm(child);
    const p = norm(parent);
    if (c === p)
        return true;
    const rel = path.relative(p, c);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
export class Workspace {
    roots;
    realRoots;
    constructor(roots) {
        this.roots = roots;
        this.realRoots = roots.map(realpathLoose);
    }
    /**
     * Resolve a user-supplied path (relative paths are relative to the first root)
     * and ensure it stays inside a workspace root, including after symlinks.
     */
    resolve(userPath, opts = {}) {
        if (!userPath || userPath.includes("\0")) {
            throw new McpToolError("INVALID_INPUT", "path must be a non-empty string");
        }
        const base = this.roots[0];
        const abs = path.resolve(base, userPath);
        const real = realpathLoose(abs);
        if (!this.realRoots.some((root) => isInside(real, root))) {
            throw new McpToolError("PATH_OUTSIDE_WORKSPACE", `'${userPath}' resolves outside the allowed workspace`, `Allowed roots: ${this.roots.join(", ")}. Set ASEPRITE_MCP_ROOTS to change them.`);
        }
        if (opts.extensions) {
            const ext = path.extname(abs).toLowerCase();
            if (!opts.extensions.includes(ext)) {
                throw new McpToolError("INVALID_INPUT", `'${userPath}' must have one of these extensions: ${opts.extensions.join(", ")}`);
            }
        }
        return abs;
    }
    /** Path relative to the first root, for compact display. */
    display(abs) {
        const rel = path.relative(this.roots[0], abs);
        return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs;
    }
}
export const SPRITE_EXTENSIONS = [".aseprite", ".ase"];
//# sourceMappingURL=paths.js.map