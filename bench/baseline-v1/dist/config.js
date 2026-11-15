import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
export function loadConfig(env = process.env) {
    const roots = (env.ASEPRITE_MCP_ROOTS ?? "")
        .split(path.delimiter)
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => path.resolve(r));
    return {
        asepritePath: env.ASEPRITE_PATH?.trim() || undefined,
        roots: roots.length > 0 ? roots : [process.cwd()],
        timeoutMs: positiveInt(env.ASEPRITE_MCP_TIMEOUT_MS, 60_000),
        maxCheckpoints: positiveInt(env.ASEPRITE_MCP_MAX_CHECKPOINTS, 20),
        allowLua: env.ASEPRITE_MCP_ALLOW_LUA === "1" || env.ASEPRITE_MCP_ALLOW_LUA === "true",
    };
}
function positiveInt(value, fallback) {
    const n = value ? Number.parseInt(value, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
/** Well-known install locations, checked when ASEPRITE_PATH is not set. */
export function candidateExecutables(platform = process.platform) {
    const home = homedir();
    if (platform === "win32") {
        const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
        const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
        const local = process.env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
        return [
            path.join(pf, "Aseprite", "Aseprite.exe"),
            path.join(pf86, "Aseprite", "Aseprite.exe"),
            path.join(pf86, "Steam", "steamapps", "common", "Aseprite", "Aseprite.exe"),
            path.join(pf, "Steam", "steamapps", "common", "Aseprite", "Aseprite.exe"),
            path.join(local, "Programs", "Aseprite", "Aseprite.exe"),
            "C:\\Aseprite\\Aseprite.exe",
        ];
    }
    if (platform === "darwin") {
        return [
            "/Applications/Aseprite.app/Contents/MacOS/aseprite",
            path.join(home, "Applications", "Aseprite.app", "Contents", "MacOS", "aseprite"),
            path.join(home, "Library", "Application Support", "Steam", "steamapps", "common", "Aseprite", "Aseprite.app", "Contents", "MacOS", "aseprite"),
        ];
    }
    return [
        "/usr/bin/aseprite",
        "/usr/local/bin/aseprite",
        "/opt/aseprite/aseprite",
        path.join(home, ".local", "bin", "aseprite"),
        path.join(home, ".steam", "steam", "steamapps", "common", "Aseprite", "aseprite"),
        path.join(home, ".local", "share", "Steam", "steamapps", "common", "Aseprite", "aseprite"),
    ];
}
export function firstExisting(paths) {
    return paths.find((p) => existsSync(p));
}
//# sourceMappingURL=config.js.map