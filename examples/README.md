# Examples

## Client configuration

**Claude Code**, project-scoped `.mcp.json` in your game repo:

```json
{
  "mcpServers": {
    "aseprite": {
      "command": "node",
      "args": ["C:/tools/aseprite-mcp-pro-max/dist/index.js"],
      "env": {
        "ASEPRITE_PATH": "C:/Aseprite/Aseprite.exe",
        "ASEPRITE_MCP_ROOTS": "."
      }
    }
  }
}
```

**Codex**, `~/.codex/config.toml`:

```toml
[mcp_servers.aseprite]
command = "node"
args = ["/opt/aseprite-mcp-pro-max/dist/index.js"]
env = { ASEPRITE_PATH = "/usr/bin/aseprite" }
```

**Live editing.** Install the extension once, restart Aseprite, then ask for changes "in the open file":

```bash
node dist/index.js install-extension
```

## Engine sample projects

[`engines/`](engines/) holds minimal host projects for Godot, Unity, Phaser, PixiJS, LÖVE, Pygame, Defold, GameMaker and Cocos, filled with assets exported by the server. Rebuild them with `npx tsx examples/build-samples.ts`; see [engines/README.md](engines/README.md).

## End-to-end workflows

[`workflows.ts`](workflows.ts) has five workflows written against the core tools: reference image → editable sprite, animated character with states and directions, seamless tileset, modify-and-restore with checkpoints, and engine exports. The integration tests run the same code.

## Demo: animated slime → Godot

[`slime-demo.ts`](slime-demo.ts) drives the server over MCP the way an assistant would, using the core tools (`run_op`, `batch`, `preview`). It creates a sprite with a palette and a tagged ping-pong idle, draws it with `draw.pixel_map`, adds an outline and shadow in one atomic batch, squashes frames, previews with onion skin, lints against the palette, and exports a Godot `SpriteFrames` resource plus a GIF.

```bash
npm run build
npx tsx examples/slime-demo.ts examples/output
```

The output is committed in [`output/`](output/): the `.aseprite` source, the sheet, its JSON, the `.tres`, a 6× GIF and the preview image the model sees.

## Demo: 64×64 dragon (v1 tool names)

[`dragon.ts`](dragon.ts) is kept as a v1-compatibility demo: it runs with `ASEPRITE_MCP_PROFILE=core,legacy` and uses the v1 tools unchanged. It builds a layered 64×64 dragon only with server operations. Silhouettes are closed polylines with `fill`, body masses are shaded `ellipse`s, eye, horns and flame are small `pixel_map`s, and each layer gets an `outline`. It validates against Endesga 32 and exports 1× and 8× PNGs to [`output/dragon/`](output/dragon/).

```bash
npx tsx examples/dragon.ts
```

## Prompts that work well

- "Create a 32x32 knight with idle (4 frames) and walk (6 frames) using endesga-32, validate it, and export for Godot into `assets/sprites`."
- "Read pixels of frame 3 around the sword and fix the stray pixels, then show me an onion-skin preview of the walk tag."
- "Import `refs/tree.png` as 48px-wide pixel art snapped to sweetie-16 with the background removed."
- "In the open Aseprite file, add a 1px dark outline to the `body` layer on every frame."

The server's `animated-sprite` prompt (and the `aseprite://guide` resource) give the model a proven step-by-step workflow and pixel-art rules.
