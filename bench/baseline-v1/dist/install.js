import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { LUA_DIR } from "./aseprite.js";
export const EXTENSION_SRC = path.resolve(LUA_DIR, "..", "extension");
export const EXTENSION_NAME = "aseprite-mcp-pro-max";
/**
 * Aseprite's user extensions directory. A portable install (aseprite.ini next
 * to the executable) keeps its configuration beside the executable.
 */
export function extensionsDir(asepriteExe, platform = process.platform) {
    if (asepriteExe) {
        const exeDir = path.dirname(asepriteExe);
        if (existsSync(path.join(exeDir, "aseprite.ini")))
            return path.join(exeDir, "extensions");
    }
    const home = homedir();
    if (platform === "win32") {
        return path.join(process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming"), "Aseprite", "extensions");
    }
    if (platform === "darwin")
        return path.join(home, "Library", "Application Support", "Aseprite", "extensions");
    return path.join(process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"), "aseprite", "extensions");
}
/** Copy the bridge extension (plus the shared Lua core) into Aseprite's extensions directory. */
export async function installExtension(targetDir) {
    const dest = path.join(targetDir, EXTENSION_NAME);
    await mkdir(dest, { recursive: true });
    const files = [];
    for (const name of await readdir(EXTENSION_SRC)) {
        await copyFile(path.join(EXTENSION_SRC, name), path.join(dest, name));
        files.push(name);
    }
    await copyFile(path.join(LUA_DIR, "core.lua"), path.join(dest, "core.lua"));
    files.push("core.lua");
    return { dir: dest, files };
}
//# sourceMappingURL=install.js.map