# Compatibility

## Aseprite and OS

| Aseprite | OS | Batch mode | Live bridge | How it was verified |
|---|---|---|---|---|
| 1.3.18 | Windows 11 | ✅ | ✅ (v1 ops) | 2.0 integration suite: every catalog example, behavior, workflow and v1-compat suites. The live GUI test passed for the v1 ops; the 2.0 live-only ops have not been run yet |
| 1.3.x (other) | any | expected | expected | Uses Lua API features from 1.3 (`json`, `WebSocket`, `Image:shrinkBounds`, `app.isUIAvailable`, tilemaps, `properties`) |
| 1.2.x and older | any | ❌ | ❌ | No `json`/`WebSocket` in Lua |
| Any | macOS, Linux | implemented | implemented | Executable and extension-folder discovery implemented; unit tests only; not yet run against a real Aseprite |

Node.js: 20 or newer (developed on 24).

## Engine adapters

From `ADAPTERS` in `src/catalog/actions-engines.ts` (adapter version 2.0.0 for all). `capabilities` reports the same list at run time.

Levels:

- **native**: writes the engine's own resource files (scenes, resources, importer settings), ready to open.
- **import-helper**: writes a format the engine or a common loader reads, plus a small loader or notes.
- **generic-atlas**: a plain sheet PNG + JSON for anything else.

| Engine | Level | Engine versions | Outputs | Verified |
|---|---|---|---|---|
| Godot | native | 4.0+ (TileMapLayer: 4.3+) | SpriteFrames `.tres`, AnimationLibrary `.tres`, TileSet `.tres`, TileMapLayer `.tscn` (binary `tile_map_data`), sample scene, EditorScript helper | Structural tests; format from the Godot docs. Not loaded in Godot yet |
| Unity 2D | native | 2021.3+ with `com.unity.2d.aseprite` (6.0.x for Unity 6000.6) | `.aseprite` copied into `Assets/` (keeps `.meta`) + importer-settings postprocessor; or sheet + sprite-slicing / clip helper; `Packages/manifest.json` update | C# written against the Aseprite Importer 8.0 and Sprite Editor data-provider API docs. Not compiled in Unity yet |
| Phaser 3 | import-helper | 3.50+ | Aseprite JSON hash (`{frame}` names) for `load.aseprite`, anims JSON for `anims.fromJSON`, usage snippet | Structural tests |
| PixiJS | import-helper | 7.x, 8.x | Spritesheet JSON with frames, anchors and animations | Structural tests |
| GameMaker | import-helper | 2.3+ / 2024+ | `<name>_<anim>_stripN.png` per tag + origin and speed notes | Structural tests |
| Defold | import-helper | 1.4+ | Per-frame PNGs + `.atlas` with animations (playback, fps) | Structural tests; fields from `atlas_ddf.proto` |
| Cocos Creator | import-helper | 2.4, 3.x | Cocos2d-x plist (format 3) atlas + animation definitions | Structural tests |
| LÖVE | import-helper | 11.x | Sheet + Lua module with quads, pivot and timed animations | Module compiled and run by Lua 5.4 (inside Aseprite) with a `love` stub. Not run in LÖVE |
| Pygame | import-helper | 2.x | Sheet + JSON + `aseprite_sheet.py` loader | Loader executed with Python against a pygame stub. Not run with pygame |
| any | generic-atlas | — | Aseprite sheet PNG + JSON (array or hash) | Export fidelity tested against real Aseprite |

Format references checked while writing the adapters: Unity Aseprite Importer 8.0 API (`FileImportModes`) and the package registry versions, Defold `atlas_ddf.proto`, GameMaker's `_stripN` import convention, the PixiJS spritesheet format, TexturePacker's Cocos2d-x plist (format 3), and Phaser's `load.aseprite` (which needs `{frame}` names).

Sample host projects for every engine are in [examples/engines/](../examples/engines/). `examples/build-samples.ts` regenerates their assets and checks them with `engine.validate`.

### Known approximations

- **Defold** atlases store a single fps per animation. Tags with uneven frame durations are approximated, and the export warns about it.
- **PixiJS** spritesheets have no per-frame durations. Set `animationSpeed` from the tag timing (the sample does this).
- **GameMaker** speed is one value per strip (frames per second), taken from the first frame of each tag. Uneven durations inside a tag are not preserved.
- **Godot** `res://` paths are computed from the nearest `project.godot` above the output. Without one, the export warns and assumes the project root; pass `resPath` to override.

## Aseprite behaviours the server depends on

- `aseprite -b --script-param k=v --script file.lua` with `app.params`.
- Lua 5.4 inside Aseprite (`//` integer division). `math.tointeger(1.5)` returns 1 in Aseprite, so the core only converts values that are already integral.
- `json.decode` returns userdata with float numbers. The core converts it into plain tables.
- `--sheet`, `--data`, `--format json-array|json-hash`, `--sheet-type`, `--list-tags`, `--list-slices`, `--list-layers`, `--tag`, `--frame-range` (0-based), `--layer`, `--split-layers`, `--split-tags`, `--trim`, `--scale`, `--save-as name_{frame1}.png`.
- Tilemaps, tile flags, persisted `properties`, `Selection` and `LinkCels` via `app.range` all work in batch mode (probed on 1.3.18). `Tileset:deleteTile` does **not** remap map cells, so the server remaps them itself.
- Portable installs (an `aseprite.ini` next to the executable) keep their extensions beside the executable. The extension installer detects this.

If you verify another version, OS or engine, please add a row.
