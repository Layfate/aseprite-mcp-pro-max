import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadBackgroundRemover, loadImageProvider } from "./ai.js";
import { LiveBridge } from "./bridge.js";
import { CATALOG, describe } from "./catalog/registry.js";
import { ADAPTERS } from "./catalog/actions-engines.js";
import type { Config } from "./config.js";
import { Context } from "./context.js";
import { INSTRUCTIONS, PIXEL_ART_GUIDE, WORKFLOW_GUIDE } from "./guide.js";
import { PALETTES } from "./palettes.js";
import { registerCoreTools, registerTool } from "./tools/core.js";
import { registerLegacyTools } from "./tools/legacy.js";
import { registerTypedTools, selectOps } from "./tools/typed.js";
import { text } from "./runtime/executor.js";
import { commitFile } from "./transaction.js";
import { VERSION } from "./version.js";

export interface ServerOptions {
  config: Config;
  livePort?: number;
  enableLive?: boolean;
  log?: (msg: string) => void;
}

export async function createServer(opts: ServerOptions): Promise<{ server: McpServer; ctx: Context; close: () => Promise<void> }> {
  const log = opts.log ?? (() => undefined);
  const bridge = new LiveBridge(opts.livePort ?? 41830, log);
  if (opts.enableLive !== false) await bridge.start();

  let provider;
  let providerError: string | undefined;
  try {
    provider = loadImageProvider();
  } catch (e) {
    providerError = (e as Error).message;
    log(`image provider disabled: ${providerError}`);
  }
  let bg;
  try {
    bg = loadBackgroundRemover();
  } catch (e) {
    log(`background remover disabled: ${(e as Error).message}`);
  }

  const ctx = new Context(opts.config, bridge, provider, providerError, bg);
  const server = new McpServer({ name: "aseprite-mcp-pro-max", version: VERSION }, { instructions: INSTRUCTIONS });

  const profiles = new Set(opts.config.profiles);
  if (profiles.has("core") || profiles.has("typed") || profiles.has("full") || !profiles.has("legacy")) registerCoreTools(server, ctx);
  if (profiles.has("full")) registerTypedTools(server, ctx, CATALOG);
  else if (profiles.has("typed")) registerTypedTools(server, ctx, selectOps(opts.config.typedAreas));
  if (profiles.has("legacy")) registerLegacyTools(server, ctx);

  if (opts.config.allowLua) {
    registerTool(server, "run_lua", "UNSAFE escape hatch (ASEPRITE_MCP_ALLOW_LUA=1): run Aseprite Lua; `sprite` is the opened document. save:true commits transactionally.", {
      code: z.string().min(1).max(100_000), path: z.string().max(4096).optional(), live: z.boolean().optional(), save: z.boolean().optional(),
    }, async (a) => {
      if (a.live) return text(await ctx.bridge.request({ cmd: "lua", code: a.code, input: a.path ? ctx.spritePath(a.path) : undefined }));
      if (!a.path) return text(await ctx.aseprite.engine({ cmd: "lua", code: a.code }));
      const file = ctx.spritePath(a.path);
      if (!a.save) return text(await ctx.aseprite.engine({ cmd: "lua", code: a.code, input: file }));
      const res = await ctx.locks.run(file, () =>
        commitFile(file, ctx.checkpoints, (work) => ctx.aseprite.engine({ cmd: "lua", code: a.code, input: file, output: work }), { label: "run lua", mustExist: true, docs: ctx.docs, inFlight: ctx.inFlight }),
      );
      return text({ ...(res.result as object), checkpoint: res.checkpoint?.id, version: res.after });
    }, { destructiveHint: true });
  }

  server.registerResource("pixel-art-guide", "aseprite://guide", { title: "Pixel art guide", description: "Proportions, palettes, shading and animation timing", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: PIXEL_ART_GUIDE }] }));
  server.registerResource("workflow", "aseprite://workflow", { title: "Production workflow", description: "brief -> construct -> inspect -> validate -> refine", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: WORKFLOW_GUIDE }] }));
  server.registerResource("palettes", "aseprite://palettes", { title: "Built-in palettes", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(PALETTES) }] }));
  server.registerResource("catalog", "aseprite://catalog", { title: "Operation catalog", description: "Full machine-readable catalog (large; use search_ops/describe_ops in conversations)", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ version: VERSION, operations: CATALOG.map((d) => describe(d)), engines: ADAPTERS }) }] }));

  server.registerPrompt("pixel-art-guide", { title: "Pixel art guide", description: "Load pixel-art best practices before drawing" },
    () => ({ messages: [{ role: "user", content: { type: "text", text: PIXEL_ART_GUIDE } }] }));
  server.registerPrompt("animated-sprite", {
    title: "Create an animated sprite",
    description: "Brief -> construct -> inspect -> validate -> refine workflow for a game sprite",
    argsSchema: {
      subject: z.string().describe("What to draw, e.g. 'an orange cat'"),
      size: z.string().optional().describe("Canvas size, e.g. 32x32"),
      animations: z.string().optional().describe("e.g. 'idle 4 frames, walk 6 frames'"),
      palette: z.string().optional().describe("Palette preset, e.g. sweetie-16"),
      engine: z.string().optional().describe("godot, unity, phaser, pixi, gamemaker, defold, cocos, love, pygame"),
    },
  }, (a) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `Create ${a.subject} as a ${a.size ?? "32x32"} pixel-art sprite with: ${a.animations ?? "idle 4 frames, walk 6 frames"}. Palette: ${a.palette ?? "sweetie-16"}.`,
          "Follow aseprite://workflow:",
          "1. Brief: doc.create, then brief.set (size, palette, outline, light, states, directions, engine).",
          "2. Construct: draw frame 1 with draw.pixel_map in one batch; anim.scaffold/frame.duplicate for poses; adjust each pose.",
          "3. Inspect: preview (tag + onion), view.contact_sheet, pixels.read for exact fixes.",
          "4. Validate: check.brief, check.lint, check.jitter, check.identity; fix every error.",
          "5. Refine: review.rubric, record judgements with review.note, iterate.",
          `6. Export${a.engine ? ` for ${a.engine} (search_ops "${a.engine}")` : ""} and engine.validate the result.`,
        ].join("\n"),
      },
    }],
  }));

  const close = async () => {
    ctx.jobs.cancelAll();
    await bridge.stop();
    await ctx.aseprite.cleanup();
    await server.close();
  };
  return { server, ctx, close };
}
