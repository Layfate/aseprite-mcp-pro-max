# Aseprite MCP Pro Max: implementation plan (revised)

> **Status: v2.0.0 implemented.** This is a revision of the original proposal. Section 1 lists what changed for 1.0 and why. Section 4 records what 1.0 built and how it was verified. Section 6 covers the 2.0 upgrade.

## 1. What changed from the original plan, and why

The original plan had the right priorities: native files first, non-destructive edits, validation, no arbitrary shell, AI as an optional layer. Research into the two closest existing projects and probes of a real Aseprite 1.3.18 install changed several of its assumptions.

| Original plan | Revised | Why |
|---|---|---|
| 30 fine-grained tools (`draw_pixels`, `create_layer`, `set_frame_duration`, …) | **13 core tools.** The centerpiece is `aseprite_edit`, which takes a *batch* of 44 typed operations | Each Aseprite launch costs ~120 ms plus a file load and save. One process per tiny tool call is slow and non-atomic. A batch runs in one launch and one transaction. Comparable projects expose 120+ tools, which costs the model tokens and makes tool choice harder. |
| `draw_pixels` with coordinate lists | **`pixel_map`**: character grid plus color legend, and the symmetric **`read_pixels`** | Models write and read grids far more reliably and compactly than JSON coordinate arrays. Reading back in the same format enables exact read, modify and write. |
| Rollback "where possible" | **Always-on transactions**: working copy, checkpoint, atomic rename, conflict check, redo slot | A failing operation must leave the file byte-identical. This is tested. |
| Live GUI control as an uncertain v1.0 item | **Live bridge shipped**: a WebSocket extension that runs *the same Lua core* inside `app.transaction` | Aseprite 1.3 has a Lua `WebSocket` API, verified on a real install. Sharing the core means file and live mode behave identically, and each batch becomes one Ctrl+Z step. |
| Sharp for raster work | **No native dependencies.** Aseprite does all raster work (render, scale, export) | Sharp is a native module that complicates installs and could silently alter indexed palettes. |
| Previews as files | Previews returned **as MCP image content** (scaled, checkerboard, frame strips, onion skin, diffs) | The model has to *see* its work to correct it. |
| Validation of "bounds, frames, palette" | **Pixel-art lint**: palette conformance, semi-transparency, stray pixels, empty or duplicate frames, out-of-canvas content, baseline jitter (sliding feet), untagged frames | These are the mistakes AI-drawn sprites actually make. |
| AI layer = prompt → sprite | AI layer = **import pipeline first** (block-majority downscale, corner-flood background removal, palette snap, binary alpha), *then* pluggable generation | Raw output from image models isn't pixel art. Cleanup is the hard part, and it's useful even without AI (reference images, screenshots). |
| Godot and Unity presets in Phase 6 | Implemented: Godot `SpriteFrames .tres`, Unity (official importer note plus sheet), Phaser JSON hash. 2.0 replaced these with engine adapters (section 6) | Engine hand-off is the reason to export at all. |
| CI with real Aseprite on 3 OSes | CI runs unit tests, typecheck and build on 3 OSes. **Integration tests run where Aseprite is installed** and auto-skip elsewhere | Aseprite isn't freely redistributable, so CI can't install it legitimately. |
| "Never run arbitrary Lua" | Arbitrary Lua is an **opt-in** escape hatch (`ASEPRITE_MCP_ALLOW_LUA=1`), off by default | Power users need it. Keeping it off by default preserves the safety story. |

Gotchas found while building (all handled and covered by tests):

1. Aseprite's `json.decode` returns userdata whose numbers are all floats, and `image:drawPixel(x, y, 2.0)` writes index **1**. The core converts every request into plain Lua tables with integer numbers. On decoded arrays `pairs()` yields nothing, while `#` on objects counts keys.
2. Batch-mode `aseprite -b` processes load extensions too. Without an `app.isUIAvailable` guard, they would hijack the live bridge connection.
3. Aseprite doesn't trim cels when saving, so naive full-canvas cels inflate files and break "content outside canvas" checks. The core trims every committed cel with `shrinkBounds`.
4. `--save-as name_{frame}.png` numbers from 0. The server uses `{frame1}` to stay 1-based like the rest of the API.

## 2. Architecture

```text
MCP client (Claude Code, Codex, …)
        │ stdio (JSON-RPC)
        ▼
TypeScript server ── zod schemas · workspace sandbox · per-file locks
        │             transactions + checkpoints · engine exporters · AI providers
        ├──────────── batch mode: spawn aseprite -b --script batch.lua (request/response JSON files)
        │                                  │
        │                                  ▼
        │                           lua/core.lua  ◄── one engine, two hosts
        │                                  ▲
        └──────────── live mode: ws://127.0.0.1 (token) ─► extension/main.lua inside the running editor
```

See [architecture.md](architecture.md) for the module breakdown.

## 3. Tool surface

**2.0 (default `core` profile):** `capabilities`, `search_ops`, `describe_ops`, `run_op`, `batch`, `inspect`, `preview`, `changes`, `checkpoint`, `restore`, `jobs`, plus the conditional `run_lua`. The 252 operations are listed in [operations.md](operations.md).

**1.0 (kept as the `legacy` profile):** `status`, `create`, `inspect`, `edit` (44 ops), `read_pixels`, `preview`, `compare`, `validate`, `export`, `import_image`, `palette`, `history`, `live`, plus the conditional `generate_sprite` and `run_lua`. The generated reference for both is [tools.md](tools.md).

## 4. Roadmap and status

| Phase | Scope | Status | Verified by |
|---|---|---|---|
| 1. Foundation | Strict TS + MCP stdio server, executable discovery, safe spawn with timeouts, create, inspect, PNG export, `doctor` | ✅ | Integration tests on Aseprite 1.3.18 (Windows) |
| 2. Native editing | Lua core: pixels, shapes, fill, layers and groups, frames, palettes; addressing by layer path and 1-based frame; transactions, checkpoints, conflict detection, undo/redo | ✅ | Golden-grid tests; atomicity test (byte-identical after failure); concurrency test |
| 3. Animation and export | Frames, durations, tags (direction and repeats), cel copy, tween, reverse; PNG, GIF and sheet + JSON; numbered frames; split layers and tags | ✅ | Sheet JSON checked against source frames, durations and tag ranges |
| 4. Pixel-art tooling | Outline, ordered-dither gradients, quantize, replace and adjust color, flip, rotate, shift, copy region, text, lint, compare, ramps, 11 palettes, multi-file validation | ✅ | Golden-grid and lint tests |
| 5. AI and import layer | Import pipeline; OpenAI-compatible and command providers; prompt steering; keys never logged | ✅ | Import golden test (upscaled art with background → exact 8×8 grid snapped to PICO-8); provider tested with a command double |
| 6. Production | Live editor bridge; Godot, Unity and Phaser presets; docs; CI; security review items | ✅ | Live test against the real GUI (connect, transactional edit, rollback, undo/redo, export, save) |

### Next (post-2.0)

- Load the engine sample projects in the engines: headless Godot import, Unity batchmode compile of the C# helpers.
- Live document versions from `sprite.events` in the extension, and an automated run of the live-only ops.
- Bitmap and TTF font text beyond the built-in 3×5 font.
- Optional Streamable HTTP transport for remote clients.
- macOS and Linux runs with a real Aseprite (paths are implemented; integration tests just need a machine with Aseprite).

## 5. Release checklist

- [x] Server connects and lists tools (tested through the MCP SDK client over stdio)
- [x] Aseprite discovery, version reporting and `doctor`
- [x] Create, read, save and PNG export
- [x] Pixel, layer, frame and palette edits validated and atomic
- [x] Checkpoints, undo/redo/restore and failure recovery tested
- [x] Animations export with correct durations and tags
- [x] Sheet metadata matches the atlas
- [x] Unit, integration, golden and security tests pass
- [ ] macOS and Linux verified with a real Aseprite *(implemented; not yet run)*
- [x] README with examples and honest limitations
- [x] AI strictly opt-in
- [x] Documented as **unofficial**; no Aseprite binaries or branding assets shipped

## 6. The 2.0 upgrade

| Area | 1.0 | 2.0 | Verified by |
|---|---|---|---|
| Tool surface | 13 tools, 44 edit ops in one big schema | 11 core tools over a catalog of 252 ops with lazy discovery (`search_ops`, `describe_ops`); `typed`, `full` and `legacy` profiles | Startup context 10,213 → 1,684 tokens (o200k); session total 60% below eager loading ([benchmarks.md](benchmarks.md)) |
| Editing | Drawing, layers, frames, palette | Plus weighted selections, tilemaps and tilesets, cleanup, patterns, references, briefs, presets, recipes, variants and reviews | Every catalog example runs against real Aseprite; 123 ops behavior-tested |
| Transactions | Checkpoints, single redo slot, mtime conflict check | Content versions (sha256 prefix) with `expectVersion`, bounded multi-step undo/redo, write-ahead journal and crash recovery, change log and change reports | Behavior suite (stale versions, journal recovery, multi-step undo/redo, checkpoint diff) |
| Performance | One Aseprite launch per call | Version-keyed result cache, background jobs with cancel, incremental re-export | Warm reads 1–2 ms vs ~120 ms cold |
| Engines | Godot SpriteFrames, Unity note, Phaser, a Roblox module | Adapters for Godot, Unity, Phaser, PixiJS, GameMaker, Defold, Cocos, LÖVE, Pygame and a generic atlas; `engine.validate`; Roblox removed | Structural tests and sample projects ([compatibility.md](compatibility.md)) |
| Docs | Hand-written tool reference | Generated `catalog.json`, `operations.md` and `tools.md` with per-op test levels | `scripts/gen-catalog.ts` |
