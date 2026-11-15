# Aseprite MCP Pro Max

An **unofficial**, open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants (Claude Code, Codex, any MCP client) **create, edit, inspect, animate, validate and export pixel art** with your own copy of [Aseprite](https://www.aseprite.org).

> Not affiliated with or endorsed by Igara Studio. Aseprite is not included. You need your own licensed copy (v1.3 or newer).

- **252 operations, 11 tools.** The operations live in a searchable catalog: drawing, selections, layers, palettes, animation, tilemaps, cleanup, validation, sprite sheets and engine exports. The model finds them with `search_ops`, reads their schemas with `describe_ops` and runs them with `run_op` or `batch`. Startup context is **1,684 tokens**, 84% less than v1 ([benchmarks](docs/benchmarks.md)).
- **Real `.aseprite` files.** Aseprite itself reads and writes every file, so layers, tags, durations, palettes, slices and tilemaps survive.
- **Atomic, versioned edits.** One `batch` applies a whole list of operations. Either all of them succeed or the file stays byte-identical. Every document has a version (a sha256 prefix of its bytes). Pass it back as `expectVersion` and stale edits are rejected. Every commit is checkpointed, and `restore` does undo, redo and restore.
- **Draw the way models think.** `draw.pixel_map` takes a character grid plus a color legend. `pixels.read` returns the same format, so a model can read, modify and write back exactly.
- **See the work.** Previews come back as images: frames, onion skin, contact sheets, silhouettes, value checks, tile repeats and side-by-side diffs. Reads are cached per version, so asking again after no change is free.
- **Objective checks.** Lint, palette, clipping, timing, baseline jitter, pivot drift, identity across frames, outlines and tile seams. They measure facts; they don't grade art.
- **Game-engine exports.** Godot (SpriteFrames, AnimationLibrary, TileSet, TileMapLayer scene), Unity (Aseprite Importer setup or sliced sheet), Phaser, PixiJS, GameMaker, Defold, Cocos, LÖVE and Pygame, plus `engine.validate`. Re-exports skip unchanged sources. Sample projects are in [examples/engines/](examples/engines/).
- **Live editor mode (optional).** A small Aseprite extension lets the assistant edit the sprite open in your editor. Each batch becomes one Ctrl+Z step.
- **Safe by default.** Paths are sandboxed to workspace roots, with symlinks resolved. No shell is involved, input schemas are strict, and arbitrary Lua is opt-in.

## Requirements

- Aseprite **1.3+** (tested with 1.3.18 on Windows 11)
- Node.js **20+**

## Install

```bash
git clone <this repo> aseprite-mcp-pro-max
cd aseprite-mcp-pro-max
npm install
npm run build
node dist/index.js doctor     # finds Aseprite, checks the Lua core
```

`doctor` looks for Aseprite in the usual install locations, including Steam. If it can't find it, set `ASEPRITE_PATH`.

### Claude Code

```bash
claude mcp add aseprite -e ASEPRITE_PATH="C:/Aseprite/Aseprite.exe" -- node /absolute/path/to/aseprite-mcp-pro-max/dist/index.js
```

Or commit a `.mcp.json` to your game project:

```json
{
  "mcpServers": {
    "aseprite": {
      "command": "node",
      "args": ["/absolute/path/to/aseprite-mcp-pro-max/dist/index.js"],
      "env": { "ASEPRITE_PATH": "C:/Aseprite/Aseprite.exe" }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.aseprite]
command = "node"
args = ["/absolute/path/to/aseprite-mcp-pro-max/dist/index.js"]
env = { ASEPRITE_PATH = "/Applications/Aseprite.app/Contents/MacOS/aseprite" }
```

Any other MCP client works the same way: run `node dist/index.js` over stdio. More examples are in [examples/](examples/).

## Quality workflow (2.1)

Pixel art made by a model usually looks generated for predictable reasons: guessed decisions, detail before form, shading by brightness slider, and "done" claimed from a tool result nobody looked at. 2.1 adds four things against that:

- **`check.craft`** measures the tells of generated art: pillow shading, flat ramps, light that contradicts the brief, banding, confetti, jaggies, doubled outlines, mirror symmetry, murky values and colour bloat. Findings carry ids from `rules://92-generated-art-tells`, coordinates and a fix.
- **A rulebook**: 62 craft rules with 400 drawable templates (`rules://index`, `kb.rules`, `kb.template`), vendored from [aseprite-ai-artist](https://github.com/with-pebbly/aseprite-ai-artist) under MIT.
- **Workflow skills** (`skill://studio` is the front door): brief → concept → draw → shade → review, with a look after every stage.
- **An independent critic** (`agents/pixel-critic.md`): a cold read before the brief, a scored critique, and blind A/B comparisons that decide whether a fix is kept.

As a Claude Code plugin: `/plugin marketplace add <path or git url of this repo>`, then `/plugin install aseprite-pro-max`. The first start runs `npm install`, which also builds the server. Skills appear as `/aseprite-pro-max:studio` and so on. In other MCP clients, the skills are available as prompts and `skill://` resources.

## Tools

The default **core** profile registers 11 tools. Every operation is reached through them.

| Tool | What it does |
|---|---|
| `capabilities` | Server, Aseprite, live editor, providers, limits, catalog areas, engine adapters, cache and process stats |
| `search_ops` | Find operations by words (`"flood fill"`, `"godot tileset"`), optionally by area or kind |
| `describe_ops` | Compact JSON schemas plus an example for up to 10 operation ids |
| `run_op` | Run one operation. Edits are atomic and checkpointed; queries and renders are cached by version. `background: true` returns a job id |
| `batch` | Many edit operations on one document in one atomic, checkpointed transaction. Supports `dryRun`, `expectVersion` and `preview` |
| `inspect` | Document summary with its version; `detail: "full"` adds layers, frames, tags, slices and palette (paged) |
| `preview` | Render a view as an image: frames (tag, onion, grid), contact sheet, tile repeat, compare, palette, silhouette, values |
| `changes` | What changed since a version, or a per-frame pixel diff against a checkpoint |
| `checkpoint` | List checkpoints or create a named one before risky work |
| `restore` | Undo, redo or restore a checkpoint (editor undo in live mode) |
| `jobs` | Background jobs: list, progress, result, cancel |

`run_lua` is added only when `ASEPRITE_MCP_ALLOW_LUA=1`.

- [docs/operations.md](docs/operations.md) lists all 252 operations by area, with their arguments and test level. [docs/catalog.json](docs/catalog.json) is the machine-readable version.
- [docs/tools.md](docs/tools.md) is the generated tool reference.
- The `aseprite://workflow` and `aseprite://guide` resources and the `animated-sprite` prompt give the model a step-by-step workflow and pixel-art rules.

Conventions: pixel coordinates start at the top-left `(0,0)`. Frames are **1-based**. Colors are `"#rrggbb"`, `"#rrggbbaa"`, `"transparent"` or a palette index. Layers are named or given as a `"Group/Child"` path.

### Profiles

| `ASEPRITE_MCP_PROFILE` | Tools | Startup tokens* | Use it when |
|---|---|---|---|
| `core` (default) | 11 | 1,684 | Normal use. Operations are discovered on demand |
| `legacy` | 13 | 2,309 | Existing v1 prompts and scripts (`aseprite_create`, `aseprite_edit`, ... with the v1 arguments) |
| `core,legacy` | 24 | 3,878 | Migrating from v1 |
| `typed` | 94 | 21,890 | Clients that work better with one tool per operation. `ASEPRITE_MCP_TYPED` picks the areas (default `drawing,layers,animation,preview`) |
| `full` | 263 | 55,455 | Every operation as its own tool. Large; mainly for comparison |

\* o200k_base tokens for the tool definitions plus server instructions, from [docs/benchmarks.md](docs/benchmarks.md). Over the five benchmark workflows, `core` uses 60% fewer tokens in total than `full`, discovery included.

### Example: one call, one atomic edit

```json
{
  "tool": "batch",
  "arguments": {
    "path": "sprites/slime.aseprite",
    "expectVersion": "3f9a1c0b7d2e",
    "preview": true,
    "ops": [
      { "op": "draw.pixel_map", "layer": "body", "x": 4, "y": 6, "rows": [
          "..oooo..",
          ".oowwoo.",
          "oooooooo",
          "oKooooKo",
          ".oooooo."
        ], "legend": { "o": "#38b764", "w": "#a7f070", "K": "#1a1c2c" } },
      { "op": "draw.outline", "layer": "body", "color": "#257179" },
      { "op": "cel.copy", "layer": "body", "fromFrame": 1, "toFrame": 2, "toFrameEnd": 4 },
      { "op": "anim.tween", "layer": "body", "fromFrame": 1, "toFrame": 4, "dy": 1, "additive": true, "easing": "ease_in_out" }
    ]
  }
}
```

If any operation fails (say a misspelled layer), the error names the operation and the valid choices, and the file is untouched. Unknown argument names are rejected before Aseprite runs.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ASEPRITE_PATH` | auto-detect | Aseprite executable |
| `ASEPRITE_MCP_ROOTS` | current directory | Directories the server may read and write (`;` on Windows, `:` elsewhere) |
| `ASEPRITE_MCP_PROFILE` | `core` | Tool profiles, comma-separated (see [Profiles](#profiles)) |
| `ASEPRITE_MCP_TYPED` | `drawing,layers,animation,preview` | Areas exposed as typed tools by the `typed` profile |
| `ASEPRITE_MCP_TIMEOUT_MS` | `60000` | Timeout per Aseprite run |
| `ASEPRITE_MCP_MAX_CHECKPOINTS` | `20` | Checkpoints kept per file |
| `ASEPRITE_MCP_JOB_CONCURRENCY` | `2` | Background jobs that run at once |
| `ASEPRITE_MCP_MAX_JOBS` | `32` | Background jobs that may be queued |
| `ASEPRITE_MCP_JOB_TIMEOUT_MS` | `600000` | Timeout per background job |
| `ASEPRITE_MCP_LIVE_PORT` | `41830` | Live bridge port on `127.0.0.1` (`0` disables live mode) |
| `ASEPRITE_MCP_ALLOW_LUA` | off | `1` registers `run_lua` (arbitrary code, so trusted setups only) |
| `ASEPRITE_MCP_IMAGE_PROVIDER` | off | `openai` or `command`, see [AI generation](#ai-generation-optional) |
| `ASEPRITE_MCP_BG_COMMAND` | off | Optional external background remover: JSON argv with `{input}` and `{output}` |

## Live editor mode

```bash
node dist/index.js install-extension
```

Restart Aseprite. While the MCP server runs, the extension connects to `ws://127.0.0.1:41830` using a per-session token from `~/.aseprite-mcp/bridge.json`. Then pass `live: true` to `run_op`, `batch`, `inspect`, `preview` and `restore`, or use `doc.list_live`, `doc.open_live` and `doc.save_live`. Each batch runs inside `app.transaction`, so it is a single undo step, and a failing batch is rolled back inside the editor. *File > Scripts > MCP Bridge Status* shows the connection. If something goes wrong, the extension writes a diagnostic log to `~/.aseprite-mcp/extension.log`.

Live mode and file mode run the same Lua core, so operations behave the same in both. The live-only operations have not been covered by the automated tests yet (see [Limitations](#limitations)).

## AI generation (optional)

The core never needs AI. Reference images (concept art, screenshots, AI output) can be cleaned into pixel art with `ref.import`, `ref.downscale`, `ref.remove_background` and `ref.extract_palette`. To add prompt-to-sprite (`ref.generate`), configure one provider:

```bash
# Any OpenAI-compatible images endpoint
ASEPRITE_MCP_IMAGE_PROVIDER=openai
ASEPRITE_MCP_IMAGE_API_KEY=...            # kept in the server process only, never logged or returned
ASEPRITE_MCP_IMAGE_MODEL=gpt-image-1      # optional
ASEPRITE_MCP_IMAGE_BASE_URL=https://...   # optional

# Or any local program (ComfyUI script, diffusers, ...). Arguments are a JSON array, run without a shell.
ASEPRITE_MCP_IMAGE_PROVIDER=command
ASEPRITE_MCP_IMAGE_COMMAND='["python","gen.py","--prompt","{prompt}","--out","{output}","--w","{width}","--h","{height}"]'
```

Generated art is a starting point. Plan on a cleanup pass with `batch` and the `check.*` operations.

## Safety model

- Every path is resolved inside `ASEPRITE_MCP_ROOTS`. `..`, absolute paths elsewhere and symlinks or junctions that point out are rejected. Engine exports are sandboxed the same way.
- Aseprite is spawned with an argument array, never through a shell. Requests reach Lua as a JSON file, never as code.
- File edits write a sibling working copy, checkpoint the original and swap atomically. A write-ahead journal lets the server roll back an interrupted commit on the next start.
- Version checks: if the file changed on disk, or `expectVersion` doesn't match, the commit is refused.
- Writes to the same file are serialized. Calls have timeouts and output caps. Background jobs are bounded and can be cancelled, which stops the Aseprite process.
- The live bridge listens on `127.0.0.1` only and requires a random per-session token. Batch Aseprite processes never connect.
- `run_lua` doesn't exist unless you enable it.

## Development

```bash
npm run build          # TypeScript → dist/
npm test               # build + unit + integration (integration auto-skips without Aseprite)
npm run docs           # regenerate docs/catalog.json, operations.md, tools.md (run the tests first for test levels)
npm run bench          # regenerate docs/benchmarks.md and bench/results.json
npx tsx examples/build-samples.ts                                          # rebuild examples/engines/
ASEPRITE_MCP_TEST_LIVE=1 npx vitest run tests/integration/live.test.ts     # launches the Aseprite GUI
```

Read [docs/architecture.md](docs/architecture.md) for how it fits together, [docs/compatibility.md](docs/compatibility.md) for what has been verified per engine, and [CHANGELOG.md](CHANGELOG.md) for what changed in 2.0.

## Limitations

- Engine outputs are checked by structure, against each format's documentation. None were loaded inside the engines by the automated tests. The Unity C# helpers have not been compiled. See [docs/compatibility.md](docs/compatibility.md).
- The live-editor operations (`doc.list_live`, `doc.open_live`, `doc.save_live`) and live document versions are not covered by the automated tests.
- Text uses a built-in 3×5 pixel font (A–Z, 0–9, punctuation).
- Only Windows + Aseprite 1.3.18 has been verified with a real Aseprite. macOS and Linux paths are implemented but not tested against Aseprite.
- Token counts in the benchmarks use OpenAI encodings as a proxy for Claude's tokenizer.

## License

MIT. See [LICENSE](LICENSE).

Aseprite is © Igara Studio S.A. It is commercial software with its own EULA and is not covered by this license. This project does not include, download or build Aseprite. It only runs the copy you installed.
