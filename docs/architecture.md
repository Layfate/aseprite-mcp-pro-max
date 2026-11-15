# Architecture

```text
MCP client ──stdio──► src/index.ts ─► src/server.ts (McpServer, instructions, prompts, resources)
                                         │  profiles: core | typed | full | legacy
                                         ▼
                 src/tools/core.ts · typed.ts · legacy.ts   (11 core tools; typed = one tool per op)
                                         │
                                         ▼
                 src/catalog/registry.ts ── 252 OpDefs (id, area, kind, strict zod schema, example)
                                         │   search · describe · validate · prepare hooks
                                         ▼
                 src/runtime/executor.ts ── edit → transaction · query/render → version cache
                                         │   action → TypeScript run() · background → jobs
           ┌─────────────────────────────┼───────────────────────────────┐
           ▼                             ▼                               ▼
   src/runtime/documents.ts      src/transaction.ts               src/bridge.ts
   versions, LRU cache,          locks, working copy,             WebSocket server
   change log, journal,          checkpoints, undo/redo,          (127.0.0.1 + token)
   recovery                      conflict checks                          │
           │                             │                               │
           ▼                             ▼                               ▼
   src/aseprite.ts ─ spawn `aseprite -b --script lua/batch.lua`   extension/main.lua (in the GUI)
                     │                                                    │
                     └────────────► lua/core.lua + mod_*.lua ◄────────────┘
                                    (one engine, both hosts)

   src/engines/*  ── engine actions (Godot, Unity, Phaser, ...) built from Aseprite's sheet JSON
```

## Operation catalog

Every operation is an `OpDef` in `src/catalog/`:

| Field | Meaning |
|---|---|
| `id` | `area-prefix.name`, e.g. `draw.pixel_map`, `engine.godot_tileset` |
| `area` | One of 15 areas (documents, layers, selection, drawing, transform, palette, animation, tiles, reference, cleanup, validation, sheets, engines, production, preview) |
| `kind` | `edit` (changes the document, runs in a transaction), `query` (read-only, cached), `render` (image or file, cached), `action` (TypeScript, e.g. exports) |
| `shape` | Strict zod object. Unknown keys are rejected. `describe_ops` emits a compact JSON Schema from it |
| `requires`, `live`, `status`, `slow` | Capabilities needed, live-editor support, stable/experimental, may run as a background job |
| `example` | A runnable example. The integration suite executes every one (`tests/integration/catalog.test.ts`) |
| `prepare` | Optional server-side step before Lua sees the args: path sandboxing, palette presets, pattern and image loading |

The catalog files: `ops-structure.ts` (documents, layers, frames, tags, slices), `ops-draw.ts` (selection, drawing, transform), `ops-color.ts` (palette, animation), `ops-tiles.ts` (tiles, cleanup, validation, preview), `actions.ts` (TypeScript actions), `actions-engines.ts` (engine exports and the `ADAPTERS` table). `registry.ts` combines them and provides search, describe, validation, `LEGACY_OPS` (v1 op name → catalog id) and the prepare hooks.

`scripts/gen-catalog.ts` turns the catalog into `docs/catalog.json`, `docs/operations.md` and `docs/tools.md`, with each op's test level taken from the coverage files the test suites write.

## Modules

| File | Responsibility |
|---|---|
| `src/index.ts` | CLI entry: stdio server, `doctor`, `install-extension`, `--help` |
| `src/server.ts` | Builds the `McpServer`: instructions, the tools for the selected profiles, resources (`aseprite://guide`, `workflow`, `palettes`, `catalog`), prompts |
| `src/config.ts` | Environment variables → `Config` (roots, profiles, timeouts, job limits) |
| `src/tools/core.ts` | The 11 core tools: `capabilities`, `search_ops`, `describe_ops`, `run_op`, `batch`, `inspect`, `preview`, `changes`, `checkpoint`, `restore`, `jobs` |
| `src/tools/typed.ts` | `typed` / `full` profiles: one MCP tool per catalog op |
| `src/tools/legacy.ts` | `legacy` profile: the 13 v1 tools with their v1 arguments, mapped onto the catalog |
| `src/catalog/*` | Operation definitions (see above) |
| `src/runtime/executor.ts` | Runs ops and batches: validation, detail levels (`min`/`normal`/`full`), field selection, image or file output, background jobs, coverage recording |
| `src/runtime/documents.ts` | Document versions (sha256 prefix, memoized by mtime + size), version-keyed LRU result cache, change log (`.aseprite-mcp/changes/*.jsonl`), write-ahead journal and recovery, orphaned working-file scan |
| `src/runtime/jobs.ts` | Bounded background job queue: concurrency, cancel (aborts the Aseprite process), timeout, progress |
| `src/transaction.ts` | `KeyedMutex` (one writer per file), `commitFile` (working copy → checkpoint → atomic rename, stale/conflict checks against the expected version), `Checkpoints` (list, bounded undo/redo stacks, restore) |
| `src/context.ts` | Shared state. Routes requests to batch or live mode and resolves sandboxed paths |
| `src/aseprite.ts` | Finds the executable, spawns with an argument array, timeouts, output caps, `AbortSignal`, spawn counter |
| `src/paths.ts` | Resolves paths against the roots, follows symlinks and junctions, enforces extensions |
| `src/engines/model.ts` | Engine-neutral asset model (frames, animations, pivot, tilesets) built from Aseprite's sheet JSON |
| `src/engines/godot.ts`, `unity.ts`, `formats.ts` | Writers: Godot resources and scenes (incl. the binary `tile_map_data` encoder), Unity importer files and C# helpers, Phaser / PixiJS / GameMaker / Defold / Cocos / LÖVE / Pygame formats |
| `src/engines/export.ts` | Sheet export, atomic writes, Godot `res://` and Unity project-root detection, incremental re-export manifest (`.aseprite-mcp-exports.json`) |
| `src/bridge.ts` | Live bridge: listens on `127.0.0.1`, writes `~/.aseprite-mcp/bridge.json` (port + random token), correlates requests |
| `src/install.ts` | Finds Aseprite's extensions directory (portable installs included) and copies the extension plus the Lua engine |
| `src/colors.ts`, `palettes.ts`, `palettes-io.ts` | Color parsing, built-in palettes and ramps, `.gpl` / `.pal` / `.hex` palette files |
| `src/ai.ts` | Optional image providers (OpenAI-compatible HTTP, local command) and background-removal command |
| `lua/core.lua` | Engine core: request dispatch, op registry, change tracking, selection masks, shared helpers |
| `lua/mod_*.lua` | Op implementations by category: `base` (documents, layers, frames, tags, slices), `select`, `draw`, `color`, `anim`, `tiles`, `clean`, `view` |
| `lua/batch.lua` | Batch entry: reads the request file, calls `core.handle`, writes the response file |
| `extension/main.lua` | GUI entry: only when `app.isUIAvailable`; connects to the bridge, runs `core.handle(req, {live=true})` |

## Request lifecycle (file mode)

1. The client calls `batch { path, ops, expectVersion? }`. Each op is validated against its strict schema (`validateBatch`). Unknown ops or fields fail here, before Aseprite starts.
2. `prepare` hooks run: palette presets are expanded, paths are sandboxed, images and patterns are loaded.
3. `KeyedMutex` serializes writers per file. `commitFile` checks the current version against `expectVersion` (`STALE_VERSION` if they differ) and writes a journal entry.
4. Aseprite runs `batch.lua`. The core opens the file and applies the ops in order, recording the changed region per layer and frame. The first failure aborts with `op #N (id) failed: …`. On success it writes `saveCopyAs(<sibling working file>)`.
5. If the file changed on disk meanwhile, the commit is refused (`CONFLICT`). Otherwise the original is checkpointed into `.aseprite-mcp/checkpoints/<file>/`, the working file is renamed over the original, the change log gets an entry, the journal entry is cleared and the redo stack is reset.
6. The result carries the new version, the checkpoint id and the change report. With `preview: true` or `dryRun`, the touched frames are rendered and returned as an image.

Queries and renders skip steps 3–5. Their results are cached under `(file version, op, args)`, so repeating a read on an unchanged file returns without starting Aseprite.

If the server dies between steps 3 and 5, the journal entry remains. On the next start, recovery discards the interrupted working copy (or restores the checkpoint if the original file is missing) and reports what it did.

## Live mode

The bridge is a WebSocket **server** in the MCP process, and the Aseprite extension is the **client**, because Aseprite's Lua API has a WebSocket client but no server. The extension polls `bridge.json` every 3 s until it connects, then sends a `hello`. Requests have the same shape as in batch mode. The core wraps ops in `app.transaction(...)`: an error raised inside rolls the whole batch back, and success gives the user one Ctrl+Z step. Renders and exports in live mode save a temporary copy of the open document (`saveCopyAs`) and run the normal pipeline on it.

## Engine exports

Engine actions export a sheet with Aseprite's own exporter, build the `AssetModel` from its JSON (frames, durations, tags, slices, pivot) and pass it to a format writer. Reference layers are excluded. Every written file goes through the workspace sandbox and an atomic write. The export manifest stores the source version per output, so exporting again from an unchanged source is skipped unless `force: true`. `engine.validate` re-reads the outputs and checks them structurally.

## Data conventions

- Coordinates in pixels, origin top-left. Frames are 1-based everywhere.
- Layers are addressed by `Group/Child` path or by unique name. The error message lists valid layers.
- Cels are stored trimmed to their content. An emptied cel is deleted.
- Colors cross the TS→Lua boundary as `{r,g,b,a}` or `{index}`. In indexed sprites, RGB colors map to the nearest palette entry.
- The selection is a weighted mask persisted in the sprite's `properties("mcp").selection`, so it survives between batch runs.
- Numbers cross the JSON boundary unchanged. Lua's `math.tointeger` truncates fractions, so the core only converts values that are already integral.
