import type { AssetModel, TileMapModel, TilesetModel } from "./model.js";

/**
 * Godot 4 text resources (format=3). TileMapLayer needs Godot 4.3+.
 * References: Godot docs "TSCN file format", TileSetAtlasSource, TileMapLayer, AnimationLibrary.
 * Existing resource uids (uid="uid://...") are preserved on re-export so references stay valid.
 */

export const GODOT_FLIP_H = 1 << 12; // TileSetAtlasSource.TRANSFORM_FLIP_H
export const GODOT_FLIP_V = 1 << 13; // TRANSFORM_FLIP_V
export const GODOT_TRANSPOSE = 1 << 14; // TRANSFORM_TRANSPOSE

const num = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(Math.round(n * 10000) / 10000));
const str = (s: string): string => s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\r\n]/g, " ");
const res = (p: string): string => p.replace(/["\\\r\n]/g, "");

function header(type: string, uid: string | undefined, scene = false): string {
  const u = uid ? ` uid="${uid}"` : "";
  return scene ? `[gd_scene format=3${u}]` : `[gd_resource type="${type}" format=3${u}]`;
}

/** Read the uid of an existing Godot text resource, to keep it across re-exports. */
export function existingUid(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return /^\[gd_(?:resource|scene)[^\]]*\suid="(uid:\/\/[a-z0-9]+)"/.exec(text)?.[1];
}

/** SpriteFrames for AnimatedSprite2D: one AtlasTexture per used frame; per-frame duration relative to fps. */
export function spriteFrames(m: AssetModel, texturePath: string, uid?: string): string {
  const used = [...new Set(m.animations.flatMap((a) => a.sequence))].sort((a, b) => a - b);
  const out: string[] = [header("SpriteFrames", uid), "", `[ext_resource type="Texture2D" path="${res(texturePath)}" id="1_sheet"]`, ""];
  for (const i of used) {
    const f = m.frames[i]!;
    out.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${i}"]`, `atlas = ExtResource("1_sheet")`, `region = Rect2(${f.rect.x}, ${f.rect.y}, ${f.rect.w}, ${f.rect.h})`);
    if (f.trimmed) out.push(`margin = Rect2(${f.source.x}, ${f.source.y}, ${m.canvas.w - f.source.w}, ${m.canvas.h - f.source.h})`);
    out.push("");
  }
  const anims = m.animations.map((a) => {
    const base = Math.min(...a.durationsMs);
    const frames = a.sequence.map((idx, k) => `{\n"duration": ${num(a.durationsMs[k]! / base)},\n"texture": SubResource("AtlasTexture_${idx}")\n}`).join(", ");
    return `{\n"frames": [${frames}],\n"loop": ${a.loop},\n"name": &"${str(a.name)}",\n"speed": ${num(1000 / base)}\n}`;
  });
  out.push("[resource]", `animations = [${anims.join(", ")}]`, "");
  return out.join("\n");
}

/**
 * AnimationLibrary for an AnimationPlayer driving a Sprite2D (region_enabled) child.
 * Tracks: `<node>:region_rect` and `<node>:offset` (keeps the pivot fixed for trimmed frames).
 */
export function animationLibrary(m: AssetModel, opts: { nodePath?: string; uid?: string } = {}): string {
  const node = opts.nodePath ?? "Sprite";
  const out: string[] = [header("AnimationLibrary", opts.uid), ""];
  const ids: string[] = [];
  m.animations.forEach((a, ai) => {
    const id = `Animation_${ai}`;
    ids.push(`&"${str(a.name)}": SubResource("${id}")`);
    const times: number[] = [];
    let t = 0;
    for (const d of a.durationsMs) {
      times.push(Math.round(t) / 1000);
      t += d;
    }
    const length = Math.round(t) / 1000;
    const rects = a.sequence.map((i) => {
      const f = m.frames[i]!;
      return `Rect2(${f.rect.x}, ${f.rect.y}, ${f.rect.w}, ${f.rect.h})`;
    });
    const offsets = a.sequence.map((i) => {
      const f = m.frames[i]!;
      // Sprite2D centered=false: offset = trimmed position minus pivot
      return `Vector2(${f.source.x - m.pivot.x}, ${f.source.y - m.pivot.y})`;
    });
    const ones = a.sequence.map(() => "1").join(", ");
    out.push(
      `[sub_resource type="Animation" id="${id}"]`,
      `resource_name = "${str(a.name)}"`,
      `length = ${num(length)}`,
      `loop_mode = ${a.loop ? 1 : 0}`,
      `step = ${num(Math.min(...a.durationsMs) / 1000)}`,
    );
    const track = (n: number, prop: string, values: string[]) => {
      out.push(
        `tracks/${n}/type = "value"`,
        `tracks/${n}/imported = false`,
        `tracks/${n}/enabled = true`,
        `tracks/${n}/path = NodePath("${res(node)}:${prop}")`,
        `tracks/${n}/interp = 0`,
        `tracks/${n}/loop_wrap = true`,
        `tracks/${n}/keys = {`,
        `"times": PackedFloat32Array(${times.join(", ")}),`,
        `"transitions": PackedFloat32Array(${ones}),`,
        `"update": 1,`,
        `"values": [${values.join(", ")}]`,
        `}`,
      );
    };
    track(0, "region_rect", rects);
    track(1, "offset", offsets);
    out.push("");
  });
  out.push("[resource]", `_data = {\n${ids.join(",\n")}\n}`, "");
  return out.join("\n");
}

/** Sample scene: Node2D with an AnimatedSprite2D (SpriteFrames) and a Sprite2D + AnimationPlayer. */
export function sampleScene(m: AssetModel, spriteFramesPath: string, libraryPath: string, texturePath: string, uid?: string): string {
  const first = m.animations[0]?.name ?? "default";
  const f0 = m.frames[m.animations[0]?.sequence[0] ?? 0];
  return [
    header("", uid, true),
    "",
    `[ext_resource type="SpriteFrames" path="${res(spriteFramesPath)}" id="1_frames"]`,
    `[ext_resource type="AnimationLibrary" path="${res(libraryPath)}" id="2_lib"]`,
    `[ext_resource type="Texture2D" path="${res(texturePath)}" id="3_tex"]`,
    "",
    `[node name="${str(m.name)}" type="Node2D"]`,
    "",
    `[node name="Animated" type="AnimatedSprite2D" parent="."]`,
    `texture_filter = 1`,
    `sprite_frames = ExtResource("1_frames")`,
    `animation = &"${str(first)}"`,
    `autoplay = "${str(first)}"`,
    `centered = false`,
    `offset = Vector2(${-m.pivot.x}, ${-m.pivot.y})`,
    "",
    `[node name="Sprite" type="Sprite2D" parent="."]`,
    `position = Vector2(${m.canvas.w + 8}, 0)`,
    `texture_filter = 1`,
    `texture = ExtResource("3_tex")`,
    `centered = false`,
    `region_enabled = true`,
    f0 ? `region_rect = Rect2(${f0.rect.x}, ${f0.rect.y}, ${f0.rect.w}, ${f0.rect.h})` : "",
    "",
    `[node name="AnimationPlayer" type="AnimationPlayer" parent="."]`,
    `libraries = {\n&"": ExtResource("2_lib")\n}`,
    `autoplay = &"${str(first)}"`,
    "",
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

const POLY: Record<string, (w: number, h: number) => Array<[number, number]>> = {
  full: (w, h) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]],
  "top-half": (w, h) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, 0], [-w / 2, 0]],
  "bottom-half": (w, h) => [[-w / 2, 0], [w / 2, 0], [w / 2, h / 2], [-w / 2, h / 2]],
  "slope-up": (w, h) => [[-w / 2, h / 2], [w / 2, -h / 2], [w / 2, h / 2]],
  "slope-down": (w, h) => [[-w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]],
};

/** Collision polygon in Godot tile-local coordinates (origin = tile center). */
export function collisionPolygon(c: NonNullable<TilesetModel["tiles"][number]["collision"]>, w: number, h: number): Array<[number, number]> | undefined {
  if (c.shape === "polygon" && c.polygon) return c.polygon.map((p) => [p.x - w / 2, p.y - h / 2]);
  return POLY[c.shape]?.(w, h);
}

/** TileSet with one TileSetAtlasSource (source id 0) and physics layer 0 for collision metadata. */
export function tileSet(t: TilesetModel, texturePath: string, uid?: string): string {
  const out: string[] = [header("TileSet", uid), "", `[ext_resource type="Texture2D" path="${res(texturePath)}" id="1_tiles"]`, ""];
  out.push(`[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_0"]`, `texture = ExtResource("1_tiles")`);
  if (t.spacing) out.push(`separation = Vector2i(${t.spacing}, ${t.spacing})`);
  out.push(`texture_region_size = Vector2i(${t.tileWidth}, ${t.tileHeight})`);
  const hasCollision = t.tiles.some((x) => x.collision && x.collision.shape !== "none");
  for (const tile of t.tiles) {
    const k = `${tile.col}:${tile.row}/0`;
    out.push(`${k} = 0`);
    if (tile.collision && tile.collision.shape !== "none") {
      const poly = collisionPolygon(tile.collision, t.tileWidth, t.tileHeight);
      if (poly) {
        out.push(`${k}/physics_layer_0/polygon_0/points = PackedVector2Array(${poly.map(([x, y]) => `${x}, ${y}`).join(", ")})`);
        if (tile.collision.oneWay) out.push(`${k}/physics_layer_0/polygon_0/one_way = true`);
      }
    }
  }
  out.push("", "[resource]", `tile_size = Vector2i(${t.tileWidth}, ${t.tileHeight})`);
  if (hasCollision) out.push(`physics_layer_0/collision_layer = 1`);
  out.push(`sources/0 = SubResource("TileSetAtlasSource_0")`, "");
  return out.join("\n");
}

/**
 * TileMapLayer `tile_map_data`: uint16 format version (0), then per cell 12 bytes
 * little-endian: int16 x, int16 y, uint16 source id, uint16 atlas x, uint16 atlas y, uint16 alternative.
 * Flip flags become TileSetAtlasSource transform bits in the alternative id.
 */
export function tileMapData(map: TileMapModel, tileset: TilesetModel): number[] {
  const slot = new Map(tileset.tiles.map((t) => [t.tile, t]));
  const buf = Buffer.alloc(2 + map.cells.length * 12);
  buf.writeUInt16LE(0, 0);
  let o = 2;
  for (const [x, y, tile, fx, fy, fd] of map.cells) {
    const s = slot.get(tile);
    if (!s) continue;
    buf.writeInt16LE(x, o);
    buf.writeInt16LE(y, o + 2);
    buf.writeUInt16LE(0, o + 4);
    buf.writeUInt16LE(s.col, o + 6);
    buf.writeUInt16LE(s.row, o + 8);
    buf.writeUInt16LE((fx ? GODOT_FLIP_H : 0) | (fy ? GODOT_FLIP_V : 0) | (fd ? GODOT_TRANSPOSE : 0), o + 10);
    o += 12;
  }
  return [...buf.subarray(0, o)];
}

export function tileMapScene(maps: TileMapModel[], tileset: TilesetModel, tilesetPath: string, rootName: string, uid?: string): string {
  const out: string[] = [header("", uid, true), "", `[ext_resource type="TileSet" path="${res(tilesetPath)}" id="1_tileset"]`, "", `[node name="${str(rootName)}" type="Node2D"]`, ""];
  for (const m of maps) {
    out.push(
      `[node name="${str(m.layer.replace(/[/:@.%"]/g, "_"))}" type="TileMapLayer" parent="."]`,
      `texture_filter = 1`,
      `tile_map_data = PackedByteArray(${tileMapData(m, tileset).join(", ")})`,
      `tile_set = ExtResource("1_tileset")`,
      "",
    );
  }
  return out.join("\n");
}

/** Decode tile_map_data back to cells (used by tests and engine.validate). */
export function decodeTileMapData(bytes: number[]): Array<{ x: number; y: number; source: number; ax: number; ay: number; alt: number }> {
  const b = Buffer.from(bytes);
  const out = [];
  for (let o = 2; o + 12 <= b.length; o += 12) {
    out.push({ x: b.readInt16LE(o), y: b.readInt16LE(o + 2), source: b.readUInt16LE(o + 4), ax: b.readUInt16LE(o + 6), ay: b.readUInt16LE(o + 8), alt: b.readUInt16LE(o + 10) });
  }
  return out;
}

/** Editor-side import helper using Godot's public API (set_cell), for projects that prefer scripts over generated scenes. */
export function tileMapImportScript(): string {
  return `@tool
extends EditorScript
## Builds TileMapLayer nodes from an aseprite-mcp-pro-max tilemap JSON export.
## Run from the Script Editor: File > Run. Adjust the paths below.
const MAP_JSON := "res://tilemap.json"
const TILESET := "res://tileset.tres"

func _run() -> void:
	var data = JSON.parse_string(FileAccess.get_file_as_string(MAP_JSON))
	var root := get_scene()
	for m in data.maps:
		var layer := TileMapLayer.new()
		layer.name = String(m.layer).validate_node_name()
		layer.tile_set = load(TILESET)
		for c in m.cells:
			var slot = data.tileset.slots[str(int(c[2]))]
			var alt := 0
			if c[3]: alt |= TileSetAtlasSource.TRANSFORM_FLIP_H
			if c[4]: alt |= TileSetAtlasSource.TRANSFORM_FLIP_V
			if c[5]: alt |= TileSetAtlasSource.TRANSFORM_TRANSPOSE
			layer.set_cell(Vector2i(int(c[0]), int(c[1])), 0, Vector2i(int(slot[0]), int(slot[1])), alt)
		root.add_child(layer)
		layer.owner = root
`;
}
