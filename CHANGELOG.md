# Changelog

## 2.1.0 — 2026-11-15

Output quality: make generated pixel art stop reading as generated.

- `check.craft`: an objective audit for the tells plain lint misses. It flags pillow shading (C7), brightness-only ramps (C3), light against the brief or conflicting light (C6), banding (X3), confetti (C5), silhouette jaggies (G6), doubled outlines (E4), mirror symmetry (S4), murky or low-contrast values (V1), colour bloat (C1), near-duplicate colours (C2), partial alpha (E1) and strays. Each finding has a severity, evidence, a location and a fix. The verdict and 0-100 score are deterministic, so two versions of one sprite can be compared. Reference and background layers are excluded. Calibrated so the bundled examples get no blocking findings.
- `draw.shade`: moves pixels one ramp step darker or lighter with a hue shift (cool shadows, warm lights), using palette colours only.
- Pixel-art rulebook: 62 rule files with 400 drawable templates, vendored from [with-pebbly/aseprite-ai-artist](https://github.com/with-pebbly/aseprite-ai-artist) (MIT, `rules/LICENSE`). Served as `rules://index` / `rules://<name>` resources and through `kb.rules`, `kb.rule` and `kb.template` (templates as ready `draw.pixel_map` args).
- Workflow skills (`skills/`): studio, brief, concept, draw, shade, animate, fix and review. Each has hard gates: concept before drawing, a look after every stage, and no "done" without a preview, a clean `check.craft` and an independent review. Fixes are kept only if they win a side-by-side comparison. Served as `skill://<name>` resources and MCP prompts.
- `agents/pixel-critic.md`: a read-only critic that does a cold read, gives a scored and located critique, and has a blind A/B comparison mode.
- Claude Code plugin packaging (`.claude-plugin/`, `bin/plugin-launch.mjs` builds on first start, a once-per-session "look at it" hook).
- Server instructions point models at the studio workflow.

## 2.0.0 — 2026-11-15

A rebuild around an operation catalog with lazy discovery. v1 tools keep working through the `legacy` profile.

### Tool surface

- New default `core` profile: 11 tools (`capabilities`, `search_ops`, `describe_ops`, `run_op`, `batch`, `inspect`, `preview`, `changes`, `checkpoint`, `restore`, `jobs`). Startup context drops from 10,213 to 1,684 tokens (o200k proxy), 84% less than 1.0. See [docs/benchmarks.md](docs/benchmarks.md).
- 252 operations in a catalog of 15 areas, each with a strict schema (unknown fields are rejected), requirements, status and a runnable example.
- Profiles via `ASEPRITE_MCP_PROFILE`: `core`, `typed` (one tool per op for chosen areas, `ASEPRITE_MCP_TYPED`), `full` (every op as a tool) and `legacy` (the 13 v1 tools with v1 arguments). They can be combined, e.g. `core,legacy`.
- Results support detail levels (`min`, `normal`, `full`) and field selection. Renders can return an image or write a file.
- New resources `aseprite://workflow` and `aseprite://catalog`.

### Editing

- Weighted selections (rect, ellipse, polygon, by color, magic wand, alpha, boolean combine, expand, contract, border, feather) that persist in the file, and `inSelection` on drawing ops.
- Tilemap layers and tilesets: paint, fill, replace, dedupe, autotile, seam checks, import.
- Cleanup (stray pixels, isolated colors, holes, pixel-perfect lines, semi-transparency, outline repair, stabilizing jitter), patterns, reference-image tools, briefs, presets, recipes, variants and review notes.
- Animation scaffolding (states × directions), mirrored directions, reviewable in-betweens, loop and timing checks.
- Objective checks: brief, lint, palette, clipping, timing, jitter, pivot drift, identity, outline, tile seams.
- Change tracking reports the changed region per layer and frame.

### Runtime

- Document versions (sha256 prefix). Pass `expectVersion` to reject stale edits (`STALE_VERSION`).
- Bounded multi-step undo and redo; a change log; `changes` reports edits since a version or a pixel diff against a checkpoint.
- Write-ahead journal: an interrupted commit is rolled back on the next start, and orphaned working files are reported.
- Version-keyed result cache: repeating a read on an unchanged file costs 1–2 ms instead of an Aseprite launch (~120 ms).
- Background jobs with progress, timeout and cancel (`ASEPRITE_MCP_JOB_CONCURRENCY`, `ASEPRITE_MCP_MAX_JOBS`, `ASEPRITE_MCP_JOB_TIMEOUT_MS`).
- `capabilities` reports cache statistics, Aseprite spawn count and memory use.

### Engines

- Adapters for Godot 4 (SpriteFrames, AnimationLibrary, TileSet, TileMapLayer scene with binary `tile_map_data`, sample scene; existing uids kept), Unity (Aseprite Importer setup with a postprocessor, or a sliced sheet that keeps sprite IDs; `Packages/manifest.json` update), Phaser, PixiJS, GameMaker, Defold, Cocos, LÖVE and Pygame, plus a generic atlas.
- `engine.validate` checks outputs structurally; `engine.matrix` lists adapters, levels and what was verified.
- Incremental re-export: unchanged sources are skipped (`.aseprite-mcp-exports.json`). Reference layers are never exported.
- Sample host projects for every engine in `examples/engines/`, rebuilt by `examples/build-samples.ts`.

### Removed

- The Roblox export preset.

### Fixed

- Fractional numeric arguments were truncated on their way into Lua (also in 1.0), because Aseprite's `math.tointeger(1.5)` returns 1.
- Tags no longer absorb frames appended after them.

### Docs and tooling

- Generated `docs/catalog.json`, `docs/operations.md` and `docs/tools.md` (`npm run docs`), with each op's test level: 123 behavior-tested, 126 smoke-tested, 3 untested (live-editor ops).
- `npm run bench` measures tokens, latency, spawns and memory against the 1.0 baseline.
- Rewritten README, architecture and compatibility docs.

## 1.0.0 — 2026-11-15

First release.

- MCP stdio server with 13 core tools plus 2 opt-in tools (`aseprite_generate_sprite`, `aseprite_run_lua`).
- `aseprite_edit`: 44 atomic, checkpointed operations covering drawing (including `pixel_map` character grids), recoloring, transforms, layers and groups, frames, tags, cels and tweens, slices, palettes and the canvas.
- `aseprite_read_pixels`, `aseprite_preview` (image content, onion skin, grid), `aseprite_compare`, `aseprite_validate` (pixel-art and animation lint).
- `aseprite_export`: PNG, GIF, sheet + JSON; presets for Godot (`SpriteFrames .tres`), Unity and Phaser, and a Roblox preset (removed in 2.0).
- `aseprite_import_image`: block-majority downscale, background removal, palette snap.
- Checkpoints with undo, redo and restore; conflict detection; per-file write locks; workspace sandbox.
- Live editor bridge extension (WebSocket, token-authenticated, one undo step per batch).
- 11 built-in palettes and hue-shifted ramp generation; pixel-art guide resource and prompts.
- Optional image generation through an OpenAI-compatible endpoint or a local command.
