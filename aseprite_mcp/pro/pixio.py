"""Fast pixel I/O between Aseprite and numpy.

The template reads pixels by printing every pixel from Lua, which is fine
for a pixel or a small rectangle but slow for whole frames. The Pro Max
tools instead let Aseprite save the images they need as PNGs in a temp
directory (one Aseprite launch for any number of layers and frames), do the
image work in numpy, and hand the results back as PNGs in one more launch.

Images are canvas-sized RGBA uint8 arrays of shape (height, width, 4) in
sprite coordinates. Writes are trimmed to their opaque bounds before they go
back in, so cels stay small; an all-transparent result removes the cel.
"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field

import numpy as np
from PIL import Image as PILImage

from ..core.commands import AsepriteCommand, lua_escape
from ..core.lua import FIND_LAYER, ISOLATE_LAYER


class PixError(Exception):
    """A user-facing error from the pixel I/O layer."""


def _lua_str(s: str) -> str:
    return '"' + lua_escape(s) + '"'


def _lua_path(p: str) -> str:
    return _lua_str(os.path.abspath(p).replace("\\", "/"))


@dataclass
class SpriteInfo:
    width: int
    height: int
    color_mode: str
    frames: int
    durations: list[int]
    layers: list[dict] = field(default_factory=list)   # {"path","group","visible","tilemap","opacity"}
    palette: list[str] = field(default_factory=list)
    tags: list[dict] = field(default_factory=list)

    @property
    def image_layers(self) -> list[str]:
        return [l["path"] for l in self.layers if not l["group"] and not l["tilemap"]]

    def has_layer(self, path: str) -> bool:
        return any(l["path"] == path or l["path"].split("/")[-1] == path for l in self.layers)


_INFO_LUA = """
local spr = app.activeSprite
if not spr then print("ERROR:No active sprite") return end
local function esc(s) return (s:gsub('\\\\', '\\\\\\\\'):gsub('"', '\\\\"')) end
local parts = {}
local function walk(layers, prefix)
    for _, layer in ipairs(layers) do
        local path = prefix .. layer.name
        parts[#parts + 1] = string.format('{"path":"%s","group":%s,"visible":%s,"tilemap":%s,"opacity":%d}',
            esc(path), tostring(layer.isGroup), tostring(layer.isVisible),
            tostring(layer.isTilemap == true), layer.opacity or 255)
        if layer.isGroup then walk(layer.layers, path .. "/") end
    end
end
walk(spr.layers, "")
local mode = "rgb"
if spr.colorMode == ColorMode.GRAY then mode = "gray"
elseif spr.colorMode == ColorMode.INDEXED then mode = "indexed"
elseif spr.colorMode == ColorMode.TILEMAP then mode = "tilemap" end
local durs = {}
for i, f in ipairs(spr.frames) do durs[#durs + 1] = tostring(math.floor(f.duration * 1000 + 0.5)) end
local pal = {}
local p = spr.palettes[1]
for i = 0, #p - 1 do
    local c = p:getColor(i)
    pal[#pal + 1] = string.format('"#%02X%02X%02X%02X"', c.red, c.green, c.blue, c.alpha)
end
local tags = {}
for _, t in ipairs(spr.tags) do
    tags[#tags + 1] = string.format('{"name":"%s","from":%d,"to":%d}', esc(t.name), t.fromFrame.frameNumber, t.toFrame.frameNumber)
end
print('INFO:{"width":' .. spr.width .. ',"height":' .. spr.height .. ',"mode":"' .. mode ..
      '","durations":[' .. table.concat(durs, ",") .. '],"layers":[' .. table.concat(parts, ",") ..
      '],"palette":[' .. table.concat(pal, ",") .. '],"tags":[' .. table.concat(tags, ",") .. ']}')
"""


def sprite_info(filename: str) -> SpriteInfo:
    if not os.path.exists(filename):
        raise PixError(f"File {filename} not found")
    ok, out = AsepriteCommand.execute_lua_script_checked(_INFO_LUA, filename)
    if not ok:
        raise PixError(f"Failed to read sprite: {out}")
    for line in out.splitlines():
        if line.startswith("INFO:"):
            d = json.loads(line[5:])
            return SpriteInfo(d["width"], d["height"], d["mode"], len(d["durations"]), d["durations"],
                              d["layers"], d["palette"], d["tags"])
    raise PixError("Failed to read sprite: no data returned")


# --- reading ---------------------------------------------------------------------

def read_images(filename: str, requests: list[tuple[str, str, int]]) -> list[np.ndarray]:
    """Read many images in one Aseprite launch.

    Each request is (kind, layer, frame):
      ("layer", path, n)      - the pixels of one image layer's cel (no opacity
                                or blend applied), canvas-sized
      ("composite", "", n)    - what is visible in frame n
      ("composite", path, n)  - layer or group `path` alone, as it would show
    """
    if not requests:
        return []
    with tempfile.TemporaryDirectory() as tmp:
        entries = []
        for i, (kind, layer, frame) in enumerate(requests):
            path = os.path.join(tmp, f"r{i}.png")
            entries.append(f'{{kind={_lua_str(kind)}, layer={_lua_str(layer)}, frame={int(frame)}, '
                           f'out={_lua_path(path)}}}')
        script = f"""
        {FIND_LAYER}
        {ISOLATE_LAYER}
        local spr = app.activeSprite
        if not spr then print("ERROR:No active sprite") return end
        local src = spr
        if spr.colorMode ~= ColorMode.RGB then
            src = Sprite(spr)
            app.activeSprite = src
            app.command.ChangePixelFormat{{ ui=false, format="rgb" }}
        end
        local reqs = {{ {", ".join(entries)} }}
        local isolated = {{}}
        for _, r in ipairs(reqs) do
            if r.frame < 1 or r.frame > #src.frames then
                print("ERROR:Frame " .. r.frame .. " out of range (sprite has " .. #src.frames .. " frames)") return
            end
            local img = Image(src.width, src.height, ColorMode.RGB)
            local layer = nil
            if r.layer ~= "" then
                layer = find_layer(src, r.layer)
                if not layer then print("ERROR:Layer '" .. r.layer .. "' not found") return end
            end
            if r.kind == "layer" and layer and not layer.isGroup and not layer.isTilemap then
                local cel = layer:cel(r.frame)
                if cel then img:drawImage(cel.image, cel.position, 255, BlendMode.SRC) end
            elseif r.layer == "" then
                img:drawSprite(src, r.frame)
            else
                local iso = isolated[r.layer]
                if not iso then
                    iso = Sprite(src)
                    isolate_layer(iso.layers, find_layer(iso, r.layer))
                    isolated[r.layer] = iso
                end
                img:drawSprite(iso, r.frame)
            end
            img:saveAs(r.out)
        end
        print("OK")
        """
        ok, out = AsepriteCommand.execute_lua_script_checked(script, filename)
        if not ok:
            raise PixError(out.strip())
        result = []
        for i in range(len(requests)):
            path = os.path.join(tmp, f"r{i}.png")
            if not os.path.exists(path):
                raise PixError("Aseprite did not write the requested image")
            with PILImage.open(path) as im:
                result.append(np.array(im.convert("RGBA"), dtype=np.uint8))
        return result


def read_layer(filename: str, layer: str, frame: int = 1) -> np.ndarray:
    return read_images(filename, [("layer", layer, frame)])[0]


def read_composite(filename: str, frame: int = 1, layer: str = "") -> np.ndarray:
    return read_images(filename, [("composite", layer, frame)])[0]


# --- writing ---------------------------------------------------------------------

@dataclass
class Write:
    layer: str
    frame: int
    image: np.ndarray            # canvas-sized RGBA
    create: bool = True          # create the layer when missing
    above: str = ""              # place a newly created layer above this one
    below: str = ""              # ...or below this one
    opacity: int | None = None   # set the layer opacity when given
    blend: str = ""              # set the layer blend mode when given (e.g. "multiply")


_BLENDS = {
    "normal": "NORMAL", "multiply": "MULTIPLY", "screen": "SCREEN", "overlay": "OVERLAY",
    "darken": "DARKEN", "lighten": "LIGHTEN", "color_dodge": "COLOR_DODGE", "color_burn": "COLOR_BURN",
    "hard_light": "HARD_LIGHT", "soft_light": "SOFT_LIGHT", "difference": "DIFFERENCE",
    "exclusion": "EXCLUSION", "addition": "ADDITION", "subtract": "SUBTRACT",
    "hue": "HSL_HUE", "saturation": "HSL_SATURATION", "color": "HSL_COLOR", "luminosity": "HSL_LUMINOSITY",
}


def write_images(filename: str, writes: list[Write], frame_duration_ms: int | None = None) -> None:
    """Write canvas-sized RGBA images into layer cels in one Aseprite launch.

    Missing frames up to the highest target are appended (with
    frame_duration_ms, or the last frame's duration). The sprite must be in
    RGB mode.
    """
    if not writes:
        return
    with tempfile.TemporaryDirectory() as tmp:
        entries = []
        for i, w in enumerate(writes):
            img = np.ascontiguousarray(w.image, dtype=np.uint8)
            alpha = img[..., 3] > 0
            if alpha.any():
                ys, xs = np.nonzero(alpha)
                x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
                path = os.path.join(tmp, f"w{i}.png")
                crop = img[y0:y1, x0:x1].copy()
                crop[crop[..., 3] == 0] = 0
                PILImage.fromarray(crop, "RGBA").save(path)
                src = f"file={_lua_path(path)}, x={int(x0)}, y={int(y0)}"
            else:
                src = 'file="", x=0, y=0'
            blend = _BLENDS.get(w.blend.lower(), "") if w.blend else ""
            entries.append(
                f'{{layer={_lua_str(w.layer)}, frame={int(w.frame)}, {src}, create={str(w.create).lower()}, '
                f'above={_lua_str(w.above)}, below={_lua_str(w.below)}, opacity={w.opacity if w.opacity is not None else -1}, '
                f'blend={_lua_str(blend)}}}')
        dur = "nil" if frame_duration_ms is None else f"{frame_duration_ms / 1000.0}"
        script = f"""
        {FIND_LAYER}
        local spr = app.activeSprite
        if not spr then print("ERROR:No active sprite") return end
        if spr.colorMode ~= ColorMode.RGB then
            print("ERROR:This tool needs an RGB sprite; convert it with set_color_mode(mode=\\"rgb\\") first") return
        end
        local writes = {{ {", ".join(entries)} }}
        local dur = {dur}
        app.transaction(function()
            for _, w in ipairs(writes) do
                if w.frame < 1 then print("ERROR:Frame index must be >= 1") return end
                while #spr.frames < w.frame do
                    local last = spr.frames[#spr.frames]
                    local f = spr:newEmptyFrame()
                    f.duration = dur or last.duration
                end
                local layer = find_layer(spr, w.layer)
                if not layer then
                    if not w.create then print("ERROR:Layer '" .. w.layer .. "' not found") return end
                    local leaf = w.layer
                    local parent = nil
                    local cut = string.find(w.layer, "/[^/]*$")
                    if cut then
                        parent = find_layer(spr, string.sub(w.layer, 1, cut - 1))
                        if parent and parent.isGroup then leaf = string.sub(w.layer, cut + 1) else parent = nil end
                    end
                    layer = spr:newLayer()
                    layer.name = leaf
                    if parent then layer.parent = parent end
                    if w.above ~= "" then
                        local ref = find_layer(spr, w.above)
                        if ref and ref.parent == layer.parent then layer.stackIndex = ref.stackIndex + 1 end
                    elseif w.below ~= "" then
                        local ref = find_layer(spr, w.below)
                        if ref and ref.parent == layer.parent then layer.stackIndex = ref.stackIndex end
                    end
                end
                if layer.isGroup or layer.isTilemap then
                    print("ERROR:'" .. w.layer .. "' is a group or tilemap layer; pick an image layer") return
                end
                if w.opacity >= 0 then layer.opacity = w.opacity end
                if w.blend ~= "" then layer.blendMode = BlendMode[w.blend] end
                local cel = layer:cel(w.frame)
                if w.file == "" then
                    if cel then spr:deleteCel(cel) end
                else
                    local img = Image{{ fromFile = w.file }}
                    if not img then print("ERROR:Could not load the processed image") return end
                    if cel then
                        cel.image = img
                        cel.position = Point(w.x, w.y)
                    else
                        spr:newCel(layer, spr.frames[w.frame], img, Point(w.x, w.y))
                    end
                end
            end
        end)
        spr:saveAs(spr.filename)
        print("OK")
        """
        ok, out = AsepriteCommand.execute_lua_script_checked(script, filename)
        if not ok:
            raise PixError(out.strip())


def ensure_frames(filename: str, count: int, copy_from: int = 0, duration_ms: int | None = None) -> int:
    """Make sure the sprite has at least `count` frames.

    New frames copy every cel of frame `copy_from` (0 = add empty frames).
    Returns the number of frames added.
    """
    dur = "nil" if duration_ms is None else f"{duration_ms / 1000.0}"
    script = f"""
    local spr = app.activeSprite
    if not spr then print("ERROR:No active sprite") return end
    local src = {int(copy_from)}
    if src > #spr.frames then print("ERROR:Frame " .. src .. " out of range") return end
    local added = 0
    app.transaction(function()
        while #spr.frames < {int(count)} do
            local f = spr:newEmptyFrame(#spr.frames + 1)
            if src > 0 then
                f.duration = spr.frames[src].duration
                local function copy(layers)
                    for _, layer in ipairs(layers) do
                        if layer.isGroup then copy(layer.layers)
                        else
                            local c = layer:cel(src)
                            if c then
                                local nc = spr:newCel(layer, f, c.image, c.position)
                                nc.opacity = c.opacity
                            end
                        end
                    end
                end
                copy(spr.layers)
            end
            if {dur} then f.duration = {dur} end
            added = added + 1
        end
    end)
    spr:saveAs(spr.filename)
    print("ADDED:" .. added)
    """
    ok, out = AsepriteCommand.execute_lua_script_checked(script, filename)
    if not ok:
        raise PixError(out.strip())
    for line in out.splitlines():
        if line.startswith("ADDED:"):
            return int(line[6:])
    return 0


def write_layer(filename: str, layer: str, frame: int, image: np.ndarray, **kw) -> None:
    write_images(filename, [Write(layer, frame, image, **kw)])


# --- helpers ---------------------------------------------------------------------

def parse_frames(spec: str, total: int, default_all: bool = True) -> list[int]:
    """"" (all or [1]), "3", "1-4", "1,3,6-8", "all" -> frame numbers."""
    spec = (spec or "").strip().lower()
    if not spec or spec == "all":
        return list(range(1, total + 1)) if default_all or spec == "all" else [1]
    picked = []
    for part in spec.split(","):
        part = part.strip()
        try:
            a, b = (int(v) for v in part.split("-", 1)) if "-" in part else (int(part), int(part))
        except ValueError:
            raise PixError(f"Invalid frames '{spec}': use e.g. \"3\", \"1-4\" or \"1,3,6-8\"")
        if a < 1 or b < a or b > total:
            raise PixError(f"Invalid frame range '{part}' (sprite has {total} frames)")
        picked.extend(range(a, b + 1))
    return list(dict.fromkeys(picked))


def resolve_layer(info: SpriteInfo, layer: str) -> str:
    """Return the layer name to use, defaulting to the topmost image layer."""
    if layer:
        if not info.has_layer(layer):
            raise PixError(f"Layer '{layer}' not found. Layers: {', '.join(l['path'] for l in info.layers)}")
        return layer
    imgs = info.image_layers
    if not imgs:
        raise PixError("The sprite has no image layers")
    return imgs[-1]


def to_pil(img: np.ndarray) -> PILImage.Image:
    return PILImage.fromarray(np.ascontiguousarray(img, dtype=np.uint8), "RGBA")


def load_png(path: str) -> np.ndarray:
    with PILImage.open(path) as im:
        return np.array(im.convert("RGBA"), dtype=np.uint8)
