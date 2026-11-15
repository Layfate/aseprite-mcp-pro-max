# PROGRESS — Aseprite MCP Pro Max 2.0 upgrade

Last updated: 2026-11-15. Repo has **no git commits**. The v1 snapshot for benchmarks is in `bench/baseline-v1/` (dist + lua + extension).

## Completed

**Audit.** v1 had 15 tools (13 core + 2 opt-in) and 44 edit ops. The "121 tools" figure in the brief does not match the code. Aseprite 1.3.18 API probes confirmed these work in batch mode: tilemaps, tile flags, persisted `properties`, Selection, and `LinkCels` via `app.range`. `deleteTile` does NOT remap map cells.

**Lua engine** (`lua/core.lua` plus `mod_base`, `mod_select`, `mod_draw`, `mod_color`, `mod_anim`, `mod_tiles`, `mod_clean`, `mod_view`)
- Operations are keyed by catalog id: 150 edit ops, ~36 queries, 8 views, plus CMDs (`create`, `import`, `image`, `from_images`, `sheet_import`, `query`, `render`, `registry`).
- Change tracking reports changed regions per layer/frame.
- Selection is a weighted mask, persisted in `properties("mcp").selection`.
- `H.insertFrames` keeps tag ranges correct when frames are inserted.

**TS catalog** (`src/catalog/*`)
- 252 ops, each with an id, area, kind, strict zod schema, requirements, status and example.
- Example prerequisites: `before` hooks (in `registry.ts` `BEFORE`) and `setup` ops.
- `registry.ts` provides: search, `describe` (compact JSON schema), strict validation, `validateBatch`, `LEGACY_OPS`, `RAW_LEGEND`, and prepare hooks (`pal.set` preset, `pattern.stamp`, `xf.paste_image`, `tile.import`, `ref.compare`, `view.compare`).

**Runtime**
- `src/runtime/documents.ts`: sha256 versions, version-keyed LRU cache, change log (jsonl), write-ahead journal, recovery, orphan scan.
- `src/runtime/jobs.ts`: bounded queue with cancel, timeout and progress.
- `src/runtime/executor.ts`: detail levels, field selection, render to image or file, background jobs, coverage recording via `ASEPRITE_MCP_COVERAGE_FILE`.
- `transaction.ts`: hash-based stale/conflict checks, journal, bounded multi-step redo stack.
- `aseprite.ts`: AbortSignal support and a spawn counter.

**Tools**
- `src/tools/core.ts`: 11 tools (capabilities, search_ops, describe_ops, run_op, batch, inspect, preview, changes, checkpoint, restore, jobs).
- `typed.ts`: profiles `typed` and `full`.
- `legacy.ts`: v1-compatible tools.
- `ASEPRITE_MCP_PROFILE` selects the profile; `ASEPRITE_MCP_TYPED` sets the typed areas.

**Engines** (`src/engines/model.ts`, `godot.ts`, `unity.ts`, `formats.ts`, `export.ts`; catalog in `src/catalog/actions-engines.ts`)
- Godot: SpriteFrames, AnimationLibrary, TileSet, TileMapLayer scene with a binary `tile_map_data` encoder, sample scene, EditorScript helper; existing uids are preserved.
- Unity: copies the `.aseprite` in place (keeps `.meta`), writes a sidecar JSON plus an AsepriteImporter postprocessor, a sheet-slicing helper that keeps spriteIDs, `engine.unity_package` (6.0.0 for Unity 6000.6), and a validation script.
- Others: Phaser, PixiJS, GameMaker strips, Defold atlas, Cocos plist (format 3), LÖVE module, Pygame loader, `engine.matrix`, `engine.validate`.
- Incremental re-export manifest: `.aseprite-mcp-exports.json`. Reference layers are excluded from exports.
- Formats were checked against official docs: Unity Aseprite Importer 8.0 API (FileImportModes), package registry versions, Defold `atlas_ddf.proto`, GameMaker `_stripN`, PixiJS spritesheet, Cocos (TexturePacker 4 plist), and Phaser `load.aseprite` (needs `{frame}` names).

**Roblox removed** from code, presets and tests; docs still to clean.

**Bugs fixed**
- Lua `plain()` truncated fractional numbers. Aseprite's `math.tointeger(1.5)` returns 1, so every fractional argument was silently truncated in v1 too.
- Tags absorbed appended frames.
- A test path broke on spaces in the folder name.

**Example workflows:** `examples/workflows.ts` (5 workflows, reused by the tests).

**Cleanup (task 1, done):** junk exports removed, Lua globals `Selection`/`FlipType`/`Size` added to `.luarc.json` and `aseprite.yml`, `tests/.coverage/` gitignored, `live.test.ts` runs with `ASEPRITE_MCP_PROFILE=core,legacy`.

**Catalog generator (task 2, done):** `scripts/gen-catalog.ts` (`npm run docs`, after build + tests) writes `docs/catalog.json`, `docs/operations.md` and `docs/tools.md` (core + legacy profiles). `scripts/gen-tool-docs.ts` deleted. Last run: 252 ops = 123 behavior, 126 smoke-only, 3 untested (the live ops).

**Engine samples (task 3, done):** `examples/engines/` has host projects (godot `project.godot`+`main.tscn`, unity `Packages/manifest.json`+`ProjectSettings/ProjectVersion.txt` 6000.6.3f1, phaser/pixi `index.html` via jsdelivr phaser@3.90.0 / pixi.js@8.6.6, love `main.lua`, pygame `main.py`, defold `game.project`+`main/main.collection`, README stubs for gamemaker/cocos, overview README). `examples/build-samples.ts` regenerates them (sources in `examples/engines/source/`); last run: all 11 exports, `engine.validate` all valid. `slime-demo.ts` ported to core tools (output refreshed); `dragon.ts` kept as v1-compat demo under `core,legacy`. Generator enum escaping fixed.

**Benchmarks (task 4, done):** `scripts/bench.ts` (`npm run bench`) writes `bench/results.json` + `docs/benchmarks.md`. devDep `js-tiktoken`. `capabilities` now reports `spawns`. Results (o200k): startup v1 10,213 → core 1,684 (84% less; target <4,000 met); full 55,455. Session total core 25,682 vs full 64,553 = 60% less (target ≥50% met; includes worst-case discovery 14,900). 43 workflow calls, 0 errors, 85 spawns; cold reads ~120-135 ms vs warm 1-2 ms; RSS ~80 MB.

**Docs (task 5, done):** README rewritten for 2.0 (core tools, profiles table, config incl. job vars, live mode, safety, Aseprite EULA note). `docs/architecture.md` and `docs/compatibility.md` (engine matrix from `ADAPTERS`, known approximations) rewritten; `docs/PLAN.md` set to 2.0 with section 6; `CHANGELOG.md` 2.0.0. Roblox is now only mentioned as removed (CHANGELOG, PLAN 2.0 table, a legacy.ts comment, a unit-test assertion).

## Test results (last run 2026-11-15, all green)
- `npm run build && npx vitest run`: **325 passed, 4 skipped** (7 files; the 4 skipped are the opt-in live GUI tests). ~96 s.
  - unit 34/34; catalog smoke 250/250; v1 legacy suite 20/20; behavior 16/16; workflows 5/5.
- Coverage files `tests/.coverage/*.txt` are append-only: delete them before a full run, then `npm run docs`.

## Current issues / limitations
- Godot 4.7.2 was downloaded to the scratchpad, but **running it was blocked by the permission classifier**. Godot outputs are structural-only; ask the user before running Godot or Unity (Unity 6000.6.3f1 is installed).
- Live-editor ops (`doc.list_live`, `doc.open_live`, `doc.save_live`) and live versions (`liveVersion` hook) are untested. The extension does not yet set `M.liveVersion` (planned via `sprite.events` 'change').
- The Unity C# has not been compiled. The LÖVE module is tested only in Aseprite's Lua 5.4 with a stub. Pygame is tested with a stub module.

## Remaining tasks (exact next steps)
1. ~~Cleanup~~ done.
2. ~~Catalog generator~~ done.
3. ~~Engine sample projects~~ done.
4. ~~Benchmarks~~ done.
5. ~~Docs~~ done.
6. **Optional, ask the user first:** run headless Godot import (scratchpad `godot/`) and Unity batchmode on the sample projects. Implement the live `sprite.events` version counter in `extension/main.lua` and run the live test.
7. ~~Final build + full suite~~ done (see Test results). Final report given to the user; task 6 awaits their decision.
