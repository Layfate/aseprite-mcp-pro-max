import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { candidateExecutables, firstExisting } from "./config.js";
import { McpToolError } from "./errors.js";
const here = path.dirname(fileURLToPath(import.meta.url));
/** Directory holding core.lua / batch.lua (works from src/ and dist/). */
export const LUA_DIR = path.resolve(here, "..", "lua");
const OUTPUT_LIMIT = 1024 * 1024;
export class Aseprite {
    config;
    resolved;
    versionCache;
    tempRoot = path.join(tmpdir(), `aseprite-mcp-${process.pid}`);
    constructor(config) {
        this.config = config;
    }
    /** Locate the Aseprite executable or throw an actionable error. */
    executable() {
        if (this.resolved)
            return this.resolved;
        const explicit = this.config.asepritePath;
        if (explicit) {
            if (!existsSync(explicit)) {
                throw new McpToolError("ASEPRITE_NOT_FOUND", `ASEPRITE_PATH points to '${explicit}', which does not exist`);
            }
            this.resolved = explicit;
            return explicit;
        }
        const found = firstExisting(candidateExecutables());
        if (!found) {
            throw new McpToolError("ASEPRITE_NOT_FOUND", "could not find the Aseprite executable", "Install Aseprite (https://www.aseprite.org) and set ASEPRITE_PATH to its executable.");
        }
        this.resolved = found;
        return found;
    }
    /** Spawn Aseprite with an argument array (never a shell). */
    run(args, timeoutMs = this.config.timeoutMs) {
        const exe = this.executable();
        return new Promise((resolve, reject) => {
            const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (d) => {
                if (stdout.length < OUTPUT_LIMIT)
                    stdout += d.toString("utf8");
            });
            child.stderr.on("data", (d) => {
                if (stderr.length < OUTPUT_LIMIT)
                    stderr += d.toString("utf8");
            });
            const timer = setTimeout(() => {
                child.kill();
                reject(new McpToolError("TIMEOUT", `Aseprite did not finish within ${timeoutMs} ms`, "Raise ASEPRITE_MCP_TIMEOUT_MS for very large sprites."));
            }, timeoutMs);
            child.on("error", (err) => {
                clearTimeout(timer);
                reject(new McpToolError("ASEPRITE_FAILED", `failed to start Aseprite: ${err.message}`));
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                resolve({ code, stdout, stderr });
            });
        });
    }
    async version() {
        if (this.versionCache)
            return this.versionCache;
        const { stdout } = await this.run(["--version"], 15_000);
        this.versionCache = stdout.trim().replace(/^Aseprite\s+/i, "");
        return this.versionCache;
    }
    async tempPath(ext) {
        await mkdir(this.tempRoot, { recursive: true });
        return path.join(this.tempRoot, `${randomUUID()}${ext}`);
    }
    /** Run a request through the bundled Lua core in batch mode. */
    async engine(request) {
        const reqPath = await this.tempPath(".req.json");
        const resPath = await this.tempPath(".res.json");
        try {
            await writeFile(reqPath, JSON.stringify(request), "utf8");
            const result = await this.run([
                "-b",
                "--script-param",
                `request=${reqPath}`,
                "--script-param",
                `response=${resPath}`,
                "--script",
                path.join(LUA_DIR, "batch.lua"),
            ]);
            let raw;
            try {
                raw = await readFile(resPath, "utf8");
            }
            catch {
                throw new McpToolError("ASEPRITE_FAILED", `Aseprite exited (code ${result.code}) without a response`, (result.stderr || result.stdout).trim().slice(0, 2000) || undefined);
            }
            const envelope = JSON.parse(raw);
            if (!envelope.ok)
                throw new McpToolError("SCRIPT_ERROR", envelope.error ?? "unknown script error");
            return envelope.data;
        }
        finally {
            await Promise.all([rm(reqPath, { force: true }), rm(resPath, { force: true })]);
        }
    }
    async cleanup() {
        await rm(this.tempRoot, { recursive: true, force: true });
    }
}
//# sourceMappingURL=aseprite.js.map