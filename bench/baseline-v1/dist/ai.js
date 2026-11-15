import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { McpToolError } from "./errors.js";
export function loadImageProvider(env = process.env, timeoutMs = 180_000) {
    const kind = env.ASEPRITE_MCP_IMAGE_PROVIDER?.trim().toLowerCase();
    if (!kind)
        return undefined;
    if (kind === "openai") {
        const key = env.ASEPRITE_MCP_IMAGE_API_KEY;
        if (!key)
            throw new Error("ASEPRITE_MCP_IMAGE_PROVIDER=openai requires ASEPRITE_MCP_IMAGE_API_KEY");
        return new OpenAICompatibleProvider(key, env.ASEPRITE_MCP_IMAGE_MODEL || "gpt-image-1", (env.ASEPRITE_MCP_IMAGE_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""), timeoutMs);
    }
    if (kind === "command") {
        const raw = env.ASEPRITE_MCP_IMAGE_COMMAND;
        let argv;
        try {
            argv = raw ? JSON.parse(raw) : undefined;
        }
        catch {
            argv = undefined;
        }
        if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) {
            throw new Error("ASEPRITE_MCP_IMAGE_COMMAND must be a JSON array of strings");
        }
        return new CommandProvider(argv, timeoutMs);
    }
    throw new Error(`unknown ASEPRITE_MCP_IMAGE_PROVIDER '${kind}' (use 'openai' or 'command')`);
}
/** Request sizes accepted by common image APIs; we downscale afterwards anyway. */
function apiSize(width, height) {
    const r = width / height;
    if (r > 1.2)
        return "1536x1024";
    if (r < 0.83)
        return "1024x1536";
    return "1024x1024";
}
class OpenAICompatibleProvider {
    apiKey;
    model;
    baseUrl;
    timeoutMs;
    name;
    constructor(apiKey, model, baseUrl, timeoutMs) {
        this.apiKey = apiKey;
        this.model = model;
        this.baseUrl = baseUrl;
        this.timeoutMs = timeoutMs;
        this.name = `openai-compatible (${model})`;
    }
    async generate(req) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
            const res = await fetch(`${this.baseUrl}/images/generations`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
                body: JSON.stringify({ model: this.model, prompt: req.prompt, size: apiSize(req.width, req.height), n: 1 }),
                signal: ctrl.signal,
            });
            const body = (await res.json().catch(() => ({})));
            if (!res.ok) {
                throw new McpToolError("ASEPRITE_FAILED", `image provider returned HTTP ${res.status}: ${body.error?.message ?? "unknown error"}`);
            }
            const item = body.data?.[0];
            let bytes;
            if (item?.b64_json)
                bytes = Buffer.from(item.b64_json, "base64");
            else if (item?.url) {
                const img = await fetch(item.url, { signal: ctrl.signal });
                bytes = Buffer.from(await img.arrayBuffer());
            }
            else
                throw new McpToolError("ASEPRITE_FAILED", "image provider returned no image");
            await writeFile(req.output, bytes);
        }
        catch (e) {
            if (e.name === "AbortError")
                throw new McpToolError("TIMEOUT", "image generation timed out");
            throw e;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
class CommandProvider {
    argv;
    timeoutMs;
    name;
    constructor(argv, timeoutMs) {
        this.argv = argv;
        this.timeoutMs = timeoutMs;
        this.name = `command (${argv[0]})`;
    }
    generate(req) {
        const sub = (s) => s.replaceAll("{prompt}", req.prompt).replaceAll("{output}", req.output).replaceAll("{width}", String(req.width)).replaceAll("{height}", String(req.height));
        const [cmd, ...args] = this.argv.map(sub);
        return new Promise((resolve, reject) => {
            const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            child.stderr.on("data", (d) => {
                if (stderr.length < 4000)
                    stderr += d.toString();
            });
            const timer = setTimeout(() => {
                child.kill();
                reject(new McpToolError("TIMEOUT", "image generation command timed out"));
            }, this.timeoutMs);
            child.on("error", (e) => {
                clearTimeout(timer);
                reject(new McpToolError("ASEPRITE_FAILED", `could not run image command: ${e.message}`));
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                if (code === 0 && existsSync(req.output))
                    resolve();
                else
                    reject(new McpToolError("ASEPRITE_FAILED", `image command exited with code ${code}`, stderr.trim().slice(0, 1000) || undefined));
            });
        });
    }
}
/** Steer general-purpose image models toward clean, importable pixel art. */
export function pixelArtPrompt(prompt, width, height, paletteHint) {
    return [
        prompt.trim(),
        `Pixel art sprite designed for a ${width}x${height} pixel canvas, drawn with large, perfectly square pixels.`,
        "Flat colors, crisp hard edges, no anti-aliasing, no gradients, no blur, no text, no border.",
        "A single subject, centered, fully visible, on a plain solid uniform background color.",
        paletteHint ? `Use a limited palette: ${paletteHint}.` : "Use a small limited palette.",
    ].join(" ");
}
//# sourceMappingURL=ai.js.map