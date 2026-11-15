@tool
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
