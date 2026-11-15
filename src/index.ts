#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Aseprite } from "./aseprite.js";
import { loadConfig } from "./config.js";
import { extensionsDir, installExtension } from "./install.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const log = (msg: string) => process.stderr.write(`[aseprite-mcp] ${msg}\n`);

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const config = loadConfig();

  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(`aseprite-mcp-pro-max ${VERSION}

Usage:
  aseprite-mcp-pro-max                 Start the MCP server on stdio
  aseprite-mcp-pro-max doctor          Check the Aseprite installation and configuration
  aseprite-mcp-pro-max install-extension [dir]
                                       Install the live-editor bridge extension into Aseprite

Environment:
  ASEPRITE_PATH                 Aseprite executable (auto-detected otherwise)
  ASEPRITE_MCP_ROOTS            Allowed directories, separated by '${process.platform === "win32" ? ";" : ":"}' (default: cwd)
  ASEPRITE_MCP_TIMEOUT_MS       Per-call timeout (default 60000)
  ASEPRITE_MCP_MAX_CHECKPOINTS  Checkpoints kept per file (default 20)
  ASEPRITE_MCP_LIVE_PORT        Live bridge port on 127.0.0.1 (default 41830, 0 disables)
  ASEPRITE_MCP_ALLOW_LUA        1 enables the arbitrary-Lua tool
  ASEPRITE_MCP_IMAGE_PROVIDER   openai | command (optional AI image generation)`);
    return;
  }
  if (cmd === "doctor") {
    const a = new Aseprite(config);
    try {
      const exe = a.executable();
      console.log(`Aseprite:   ${exe}`);
      console.log(`Version:    ${await a.version()}`);
      const probe = await a.engine<{ sprite: { width: number } }>({ cmd: "create", width: 4, height: 4 });
      console.log(`Lua core:   ${probe.sprite.width === 4 ? "ok" : "unexpected result"}`);
      console.log(`Extensions: ${extensionsDir(exe)}`);
    } catch (e) {
      console.log(`Problem:    ${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      await a.cleanup();
    }
    console.log(`Roots:      ${config.roots.join(", ")}`);
    return;
  }
  if (cmd === "install-extension") {
    let exe: string | undefined;
    try {
      exe = new Aseprite(config).executable();
    } catch {
      exe = undefined;
    }
    const dir = rest[0] ?? extensionsDir(exe);
    const res = await installExtension(dir);
    console.log(`Installed ${res.files.join(", ")} into ${res.dir}\nRestart Aseprite to load it.`);
    return;
  }
  if (cmd) {
    console.error(`unknown command '${cmd}' (try --help)`);
    process.exitCode = 2;
    return;
  }

  const port = Number.parseInt(process.env.ASEPRITE_MCP_LIVE_PORT ?? "41830", 10);
  const { server, close } = await createServer({ config, livePort: port || 41830, enableLive: port !== 0, log });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`v${VERSION} ready (roots: ${config.roots.join(", ")})`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main(process.argv.slice(2)).catch((e) => {
  log(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
