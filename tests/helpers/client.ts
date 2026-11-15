import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { candidateExecutables, firstExisting } from "../../src/config.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface TestClient {
  client: Client;
  workdir: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; text: string; json: any; images: string[] }>;
  close: () => Promise<void>;
}

/** True when a real Aseprite installation can be found (integration tests skip otherwise). */
export function hasAseprite(): boolean {
  if (process.env.ASEPRITE_PATH) return existsSync(process.env.ASEPRITE_PATH);
  return firstExisting(candidateExecutables()) !== undefined;
}

/** Start the built server over stdio. `{workdir}` in env values is replaced with the test workspace. */
export async function startClient(env: Record<string, string> = {}): Promise<TestClient> {
  const workdir = mkdtempSync(path.join(tmpdir(), "ase-mcp-test-"));
  const slashed = workdir.replaceAll("\\", "/"); // safe inside JSON env values
  env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replaceAll("{workdir}", slashed)]));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    env: { ...(process.env as Record<string, string>), ASEPRITE_MCP_ROOTS: workdir, ASEPRITE_MCP_LIVE_PORT: "0", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }> };
    const texts = res.content.filter((c) => c.type === "text").map((c) => c.text ?? "");
    const t = texts.join("\n");
    let json: any;
    try {
      json = JSON.parse(texts[0] ?? "");
    } catch {
      json = undefined;
    }
    return { isError: res.isError, text: t, json, images: res.content.filter((c) => c.type === "image").map((c) => c.data ?? "") };
  };
  const close = async () => {
    await client.close();
    if (!process.env.ASEPRITE_MCP_KEEP_TEST_DIRS) rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { client, workdir, call, close };
}
