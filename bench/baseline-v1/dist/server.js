import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadImageProvider } from "./ai.js";
import { LiveBridge } from "./bridge.js";
import { Context } from "./context.js";
import { INSTRUCTIONS, PIXEL_ART_GUIDE } from "./guide.js";
import { PALETTES } from "./palettes.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";
export async function createServer(opts) {
    const log = opts.log ?? (() => undefined);
    const bridge = new LiveBridge(opts.livePort ?? 41830, log);
    if (opts.enableLive !== false)
        await bridge.start();
    let provider;
    let providerError;
    try {
        provider = loadImageProvider();
    }
    catch (e) {
        providerError = e.message;
        log(`image provider disabled: ${providerError}`);
    }
    const ctx = new Context(opts.config, bridge, provider, providerError);
    const server = new McpServer({ name: "aseprite-mcp-pro-max", version: VERSION }, { instructions: INSTRUCTIONS });
    registerTools(server, ctx);
    server.registerResource("pixel-art-guide", "aseprite://guide", { title: "Pixel art guide", description: "Proportions, palettes, shading and animation timing", mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: PIXEL_ART_GUIDE }] }));
    server.registerResource("palettes", "aseprite://palettes", { title: "Built-in palettes", description: "Palette presets usable by name", mimeType: "application/json" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(PALETTES, null, 1) }] }));
    server.registerPrompt("pixel-art-guide", { title: "Pixel art guide", description: "Load pixel-art best practices before drawing" }, () => ({ messages: [{ role: "user", content: { type: "text", text: PIXEL_ART_GUIDE } }] }));
    server.registerPrompt("animated-sprite", {
        title: "Create an animated sprite",
        description: "Step-by-step workflow to design, animate, validate and export a game sprite",
        argsSchema: {
            subject: z.string().describe("What to draw, e.g. 'an orange cat'"),
            size: z.string().optional().describe("Canvas size, e.g. 32x32"),
            animations: z.string().optional().describe("e.g. 'idle 4 frames, walk 6 frames'"),
            palette: z.string().optional().describe("Palette preset, e.g. sweetie-16"),
            engine: z.string().optional().describe("godot, roblox, unity, phaser"),
        },
    }, (a) => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: [
                        `Create ${a.subject} as a ${a.size ?? "32x32"} pixel-art sprite with these animations: ${a.animations ?? "idle 4 frames, walk 6 frames"}.`,
                        `Palette: ${a.palette ?? "sweetie-16"}.`,
                        "Steps:",
                        "1. Read the aseprite://guide resource (or the pixel-art-guide prompt).",
                        "2. aseprite_create the file with the palette, layers (e.g. 'body', 'details', 'outline') and tagged animations.",
                        "3. Draw frame 1 of the first animation with pixel_map ops; preview and refine until the silhouette reads well.",
                        "4. Copy the key frame to the other frames (copy_cel), then adjust each pose; check with aseprite_preview tag + onion.",
                        "5. aseprite_validate with the palette and fix every error and stray pixel.",
                        `6. aseprite_export the sheet${a.engine ? ` with preset: ${a.engine}` : ""} and a GIF preview, then summarize the files.`,
                    ].join("\n"),
                },
            },
        ],
    }));
    const close = async () => {
        await bridge.stop();
        await ctx.aseprite.cleanup();
        await server.close();
    };
    return { server, ctx, close };
}
//# sourceMappingURL=server.js.map