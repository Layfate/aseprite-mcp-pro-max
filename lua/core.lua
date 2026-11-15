-- Aseprite MCP Pro Max — shared Lua engine.
--
-- Used in two hosts:
--   * batch mode:  lua/batch.lua loads it and runs one request per Aseprite process
--   * live mode:   the editor extension loads it and runs requests received over WebSocket
--
-- Requests are JSON objects produced and validated by the TypeScript server
-- (every operation is checked against its own schema before it gets here).
-- No code from a request is evaluated, except by the explicitly opt-in "lua" command.
--
-- Operation ids match the server catalog ("draw.line", "sel.rect", ...).
-- Category modules (mod_*.lua, next to this file) register more operations.

local M = {}
local H = {} -- helpers shared with the category modules
M.H = H
local pc = app.pixelColor
H.pc = pc

---------------------------------------------------------------------------
-- Basic helpers
---------------------------------------------------------------------------

local function fail(msg) error(msg, 0) end
M.fail = fail
H.fail = fail

local function clamp(v, lo, hi)
  if v < lo then return lo elseif v > hi then return hi end
  return v
end
H.clamp = clamp

local function round(v) return math.floor(v + 0.5) end
H.round = round

-- "1-4,6,9-10" from a sorted list of integers
local function ranges(list)
  local out, i = {}, 1
  while i <= #list do
    local j = i
    while j < #list and list[j + 1] == list[j] + 1 do j = j + 1 end
    out[#out + 1] = (i == j) and tostring(list[i]) or (list[i] .. "-" .. list[j])
    i = j + 1
  end
  return table.concat(out, ",")
end
H.ranges = ranges

-- Aseprite's json.decode returns userdata whose numbers are floats; convert to
-- plain tables with integers. pairs() yields nothing for decoded arrays.
local function plain(v)
  local t = type(v)
  -- (Aseprite's math.tointeger truncates 1.5 to 1, so only convert integral values)
  if t == "number" then
    if v == math.floor(v) and v >= -2 ^ 53 and v <= 2 ^ 53 then return math.tointeger(v) or v end
    return v
  end
  if t == "userdata" or t == "table" then
    local out, any = {}, false
    for k, x in pairs(v) do out[k] = plain(x); any = true end
    if not any then for i = 1, #v do out[i] = plain(v[i]) end end
    return out
  end
  return v
end
M.plain = plain
H.plain = plain

---------------------------------------------------------------------------
-- Enum maps
---------------------------------------------------------------------------

local COLOR_MODE_NAME = { [ColorMode.RGB] = "rgb", [ColorMode.GRAY] = "gray", [ColorMode.INDEXED] = "indexed" }
if ColorMode.TILEMAP then COLOR_MODE_NAME[ColorMode.TILEMAP] = "tilemap" end
local COLOR_MODE = { rgb = ColorMode.RGB, gray = ColorMode.GRAY, indexed = ColorMode.INDEXED }
H.COLOR_MODE_NAME, H.COLOR_MODE = COLOR_MODE_NAME, COLOR_MODE

local ANIDIR = { forward = AniDir.FORWARD, reverse = AniDir.REVERSE, pingpong = AniDir.PING_PONG }
if AniDir.PING_PONG_REVERSE then ANIDIR.pingpong_reverse = AniDir.PING_PONG_REVERSE end
local ANIDIR_NAME = {}
for k, v in pairs(ANIDIR) do ANIDIR_NAME[v] = k end
H.ANIDIR, H.ANIDIR_NAME = ANIDIR, ANIDIR_NAME

local BLEND = {
  normal = BlendMode.NORMAL, multiply = BlendMode.MULTIPLY, screen = BlendMode.SCREEN,
  overlay = BlendMode.OVERLAY, darken = BlendMode.DARKEN, lighten = BlendMode.LIGHTEN,
  color_dodge = BlendMode.COLOR_DODGE, color_burn = BlendMode.COLOR_BURN,
  hard_light = BlendMode.HARD_LIGHT, soft_light = BlendMode.SOFT_LIGHT,
  difference = BlendMode.DIFFERENCE, exclusion = BlendMode.EXCLUSION,
  hue = BlendMode.HSL_HUE, saturation = BlendMode.HSL_SATURATION,
  color = BlendMode.HSL_COLOR, luminosity = BlendMode.HSL_LUMINOSITY,
  addition = BlendMode.ADDITION, subtract = BlendMode.SUBTRACT, divide = BlendMode.DIVIDE,
}
local BLEND_NAME = {}
for k, v in pairs(BLEND) do BLEND_NAME[v] = k end
H.BLEND, H.BLEND_NAME = BLEND, BLEND_NAME

---------------------------------------------------------------------------
-- Colors: arrive normalized as { r, g, b, a } (0..255) or { index = n }.
---------------------------------------------------------------------------

local function paletteRGBA(spr, index)
  local pal = spr.palettes[1]
  if index < 0 or index >= #pal then
    fail(string.format("palette index %d out of range (palette has %d colors)", index, #pal))
  end
  local c = pal:getColor(index)
  return c.red, c.green, c.blue, c.alpha
end
H.paletteRGBA = paletteRGBA

local function nearestInList(list, r, g, b)
  local best, bestD = 1, math.huge
  for i, c in ipairs(list) do
    local d = (c[1] - r) ^ 2 + (c[2] - g) ^ 2 + (c[3] - b) ^ 2
    if d < bestD then best, bestD = i, d end
  end
  return best, bestD
end
H.nearestInList = nearestInList

local function nearestIndex(spr, r, g, b, a)
  local pal = spr.palettes[1]
  local best, bestD = 0, math.huge
  for i = 0, #pal - 1 do
    if not (i == spr.transparentColor and a > 0) then
      local c = pal:getColor(i)
      local d = (c.red - r) ^ 2 + (c.green - g) ^ 2 + (c.blue - b) ^ 2 + (c.alpha - a) ^ 2
      if d < bestD then best, bestD = i, d end
    end
  end
  return best
end
H.nearestIndex = nearestIndex

local function rgbaOf(spr, c)
  if c.index ~= nil then return paletteRGBA(spr, c.index) end
  return c.r, c.g, c.b, c.a
end
H.rgbaOf = rgbaOf

-- raw r,g,b,a -> pixel value for the sprite's color mode
local function encode(spr, r, g, b, a)
  local mode = spr.colorMode
  if mode == ColorMode.INDEXED then
    if a == 0 then return spr.transparentColor end
    return nearestIndex(spr, r, g, b, a)
  elseif mode == ColorMode.GRAY then
    return pc.graya(round(0.299 * r + 0.587 * g + 0.114 * b), a)
  end
  return pc.rgba(r, g, b, a)
end
H.encode = encode

local function pixelValue(spr, c)
  if spr.colorMode == ColorMode.INDEXED and c.index ~= nil then
    paletteRGBA(spr, c.index)
    return c.index
  end
  return encode(spr, rgbaOf(spr, c))
end
H.pixelValue = pixelValue

local function toColorObject(spr, c)
  local r, g, b, a = rgbaOf(spr, c)
  return Color { r = r, g = g, b = b, a = a }
end
H.toColorObject = toColorObject

-- raw pixel value (of an image in the given color mode) -> r, g, b, a
local function pixelRGBA(spr, v, mode)
  mode = mode or spr.colorMode
  if mode == ColorMode.RGB then
    return pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), pc.rgbaA(v)
  elseif mode == ColorMode.GRAY then
    local g = pc.grayaV(v)
    return g, g, g, pc.grayaA(v)
  elseif mode == ColorMode.INDEXED then
    if v == spr.transparentColor then return 0, 0, 0, 0 end
    local pal = spr.palettes[1]
    if v >= #pal then return 0, 0, 0, 0 end
    local c = pal:getColor(v)
    return c.red, c.green, c.blue, c.alpha
  end
  return 0, 0, 0, 0
end
H.pixelRGBA = pixelRGBA

local function hex(r, g, b, a)
  if a == 0 then return "transparent" end
  if a == 255 then return string.format("#%02x%02x%02x", r, g, b) end
  return string.format("#%02x%02x%02x%02x", r, g, b, a)
end
H.hex = hex

local function colorHex(c) return hex(c.red, c.green, c.blue, c.alpha) end
H.colorHex = colorHex

local function transparentValue(spr)
  if spr.colorMode == ColorMode.INDEXED then return spr.transparentColor end
  return 0
end
H.transparentValue = transparentValue

local function rgbToHsl(r, g, b)
  r, g, b = r / 255, g / 255, b / 255
  local max, min = math.max(r, g, b), math.min(r, g, b)
  local l = (max + min) / 2
  if max == min then return 0, 0, l end
  local d = max - min
  local s = l > 0.5 and d / (2 - max - min) or d / (max + min)
  local h
  if max == r then h = (g - b) / d + (g < b and 6 or 0)
  elseif max == g then h = (b - r) / d + 2
  else h = (r - g) / d + 4 end
  return h * 60, s, l
end
H.rgbToHsl = rgbToHsl

local function hslToRgb(h, s, l)
  h = (h % 360) / 360
  if s == 0 then local v = round(l * 255); return v, v, v end
  local function hue(p, q, t)
    if t < 0 then t = t + 1 end
    if t > 1 then t = t - 1 end
    if t < 1 / 6 then return p + (q - p) * 6 * t end
    if t < 1 / 2 then return q end
    if t < 2 / 3 then return p + (q - p) * (2 / 3 - t) * 6 end
    return p
  end
  local q = l < 0.5 and l * (1 + s) or l + s - l * s
  local p = 2 * l - q
  return round(hue(p, q, h + 1 / 3) * 255), round(hue(p, q, h) * 255), round(hue(p, q, h - 1 / 3) * 255)
end
H.hslToRgb = hslToRgb

-- relative luminance (sRGB), 0..1
local function luminance(r, g, b)
  local function ch(c)
    c = c / 255
    return c <= 0.03928 and c / 12.92 or ((c + 0.055) / 1.055) ^ 2.4
  end
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
end
H.luminance = luminance

---------------------------------------------------------------------------
-- Document properties (persisted in the .aseprite file under key "mcp")
---------------------------------------------------------------------------

local function getProp(obj, key)
  local ok, v = pcall(function() return obj.properties("mcp")[key] end)
  if not ok or v == nil then return nil end
  if type(v) == "string" and (v:sub(1, 1) == "{" or v:sub(1, 1) == "[") then
    local okJ, d = pcall(json.decode, v)
    if okJ then return plain(d) end
  end
  return plain(v)
end
H.getProp = getProp

local function setProp(obj, key, value)
  local p = obj.properties("mcp")
  if value == nil then p[key] = nil; return end
  if type(value) == "table" then p[key] = json.encode(value) else p[key] = value end
end
H.setProp = setProp

---------------------------------------------------------------------------
-- Layers, frames, tags, cels
---------------------------------------------------------------------------

local function collectLayers(layers, prefix, depth, out)
  for i = #layers, 1, -1 do -- top of stack first, like the Aseprite UI
    local l = layers[i]
    local path = prefix and (prefix .. "/" .. l.name) or l.name
    out[#out + 1] = { layer = l, path = path, depth = depth }
    if l.isGroup then collectLayers(l.layers, path, depth + 1, out) end
  end
  return out
end

local function allLayers(spr) return collectLayers(spr.layers, nil, 0, {}) end
H.allLayers = allLayers

local function imageLayers(spr)
  local out = {}
  for _, e in ipairs(allLayers(spr)) do
    if not e.layer.isGroup and not e.layer.isTilemap then out[#out + 1] = e.layer end
  end
  return out
end
H.imageLayers = imageLayers

local function layerPaths(spr)
  local names = {}
  for _, e in ipairs(allLayers(spr)) do names[#names + 1] = "'" .. e.path .. "'" end
  return table.concat(names, ", ")
end
H.layerPaths = layerPaths

local function pathOf(spr, layer)
  for _, e in ipairs(allLayers(spr)) do
    if e.layer == layer then return e.path end
  end
  return layer.name
end
H.pathOf = pathOf

-- Resolve a layer reference ("Group/Child" path or unique name).
-- When ref is nil the sprite must have exactly one image layer.
local function findLayer(spr, ref, allowGroup, allowTilemap)
  local entries = allLayers(spr)
  if ref == nil then
    local images = imageLayers(spr)
    if #images == 1 then return images[1] end
    fail(string.format("sprite has %d image layers; specify `layer` (one of: %s)", #images, layerPaths(spr)))
  end
  local found
  for _, e in ipairs(entries) do
    if e.path == ref then found = e.layer; break end
  end
  if not found then
    for _, e in ipairs(entries) do
      if e.layer.name == ref then
        if found then fail(string.format("layer name '%s' is ambiguous; use its full path (layers: %s)", ref, layerPaths(spr))) end
        found = e.layer
      end
    end
  end
  if not found then fail(string.format("layer '%s' not found (layers: %s)", ref, layerPaths(spr))) end
  if found.isGroup and not allowGroup then fail(string.format("layer '%s' is a group; target an image layer", ref)) end
  if found.isTilemap and not allowTilemap and not allowGroup then
    fail(string.format("layer '%s' is a tilemap layer; use tile.* operations", ref))
  end
  return found
end
H.findLayer = findLayer

local function findFrame(spr, n)
  n = n or 1
  if n < 1 or n > #spr.frames then
    fail(string.format("frame %d out of range (sprite has %d frames, numbered from 1)", n, #spr.frames))
  end
  return spr.frames[n]
end
H.findFrame = findFrame

local function findTag(spr, name)
  for _, t in ipairs(spr.tags) do
    if t.name == name then return t end
  end
  local names = {}
  for _, t in ipairs(spr.tags) do names[#names + 1] = "'" .. t.name .. "'" end
  fail(string.format("tag '%s' not found (tags: %s)", name, #names > 0 and table.concat(names, ", ") or "none"))
end
H.findTag = findTag

local function findSlice(spr, name)
  for _, s in ipairs(spr.slices) do
    if s.name == name then return s end
  end
  fail(string.format("slice '%s' not found", name))
end
H.findSlice = findSlice

-- Frame list from {frame=}, {fromFrame=,toFrame=}, {frames={...}} or {tag=}
local function frameList(spr, op, default)
  if op.tag then
    local t = findTag(spr, op.tag)
    local out = {}
    for n = t.fromFrame.frameNumber, t.toFrame.frameNumber do out[#out + 1] = n end
    return out
  end
  if op.frames then
    for _, n in ipairs(op.frames) do findFrame(spr, n) end
    return op.frames
  end
  if op.fromFrame or op.toFrame then
    local a, b = op.fromFrame or 1, op.toFrame or #spr.frames
    findFrame(spr, a); findFrame(spr, b)
    local out = {}
    for n = a, b do out[#out + 1] = n end
    return out
  end
  if op.frame then findFrame(spr, op.frame); return { op.frame } end
  if default == "all" then
    local out = {}
    for n = 1, #spr.frames do out[#out + 1] = n end
    return out
  end
  return { 1 }
end
H.frameList = frameList

-- Insert `count` empty frames at position `at` with predictable tag ranges:
-- tags after the insertion shift, tags spanning it grow, and a tag that ends
-- right before `at` does NOT absorb the new frames (Aseprite would extend it).
local function insertFrames(spr, at, count)
  local ranges_ = {}
  for i, t in ipairs(spr.tags) do ranges_[i] = { t.fromFrame.frameNumber, t.toFrame.frameNumber } end
  local created = {}
  for i = 0, count - 1 do
    spr:newEmptyFrame(at + i)
    created[#created + 1] = at + i
  end
  for i, t in ipairs(spr.tags) do
    local from, to = ranges_[i][1], ranges_[i][2]
    if from >= at then from, to = from + count, to + count
    elseif to >= at then to = to + count end
    if t.fromFrame.frameNumber ~= from or t.toFrame.frameNumber ~= to then
      t.toFrame = spr.frames[math.max(to, t.fromFrame.frameNumber)]
      t.fromFrame = spr.frames[from]
      t.toFrame = spr.frames[to]
    end
  end
  return created
end
H.insertFrames = insertFrames

local function hasFrameSel(op)
  return op.frame or op.frames or op.fromFrame or op.toFrame or op.tag
end
H.hasFrameSel = hasFrameSel

local function assertEditable(layer)
  if layer.isGroup then fail("layer '" .. layer.name .. "' is a group; target an image layer") end
  if layer.isTilemap then fail("layer '" .. layer.name .. "' is a tilemap layer; use tile.* operations") end
  if not layer.isEditable then fail("layer '" .. layer.name .. "' is locked; unlock it with layer.set first") end
end
H.assertEditable = assertEditable

-- Full-canvas copy of a layer/frame cel plus the existing cel (or nil).
local function editableImage(spr, layer, frame)
  assertEditable(layer)
  local img = Image(spr.spec)
  img:clear(transparentValue(spr))
  local cel = layer:cel(frame.frameNumber)
  if cel then img:drawImage(cel.image, cel.position, 255, BlendMode.SRC) end
  return img, cel
end
H.editableImage = editableImage

-- Store a full-canvas image as a cel trimmed to its content (empty -> no cel).
local function commitImage(spr, layer, frame, img, cel)
  local r = img:shrinkBounds(transparentValue(spr))
  if r.isEmpty and not layer.isBackground then
    if cel then spr:deleteCel(cel) end
    return
  end
  local trimmed, at = img, Point(0, 0)
  if not layer.isBackground and (r.width < img.width or r.height < img.height) then
    trimmed, at = Image(img, r), Point(r.x, r.y)
  end
  if cel then
    cel.image = trimmed
    cel.position = at
  else
    spr:newCel(layer, frame, trimmed, at)
  end
end
H.commitImage = commitImage

---------------------------------------------------------------------------
-- Selection masks (weights 1..255; persisted in sprite properties)
---------------------------------------------------------------------------

local Mask = {}
H.Mask = Mask

function Mask.new() return { d = {}, n = 0 } end

local function mkey(x, y) return y * 65536 + x end
Mask.key = mkey

function Mask.get(m, x, y)
  if not m then return 0 end
  return m.d[mkey(x, y)] or 0
end

function Mask.set(m, x, y, v)
  local k = mkey(x, y)
  local old = m.d[k]
  if v and v > 0 then
    if not old then m.n = m.n + 1 end
    m.d[k] = math.min(255, v)
  elseif old then
    m.d[k] = nil
    m.n = m.n - 1
  end
end

function Mask.each(m, fn)
  for k, v in pairs(m.d) do fn(k % 65536, k // 65536, v) end
end

function Mask.bounds(m)
  local x0, y0, x1, y1
  for k in pairs(m.d) do
    local x, y = k % 65536, k // 65536
    if not x0 or x < x0 then x0 = x end
    if not x1 or x > x1 then x1 = x end
    if not y0 or y < y0 then y0 = y end
    if not y1 or y > y1 then y1 = y end
  end
  if not x0 then return nil end
  return { x = x0, y = y0, width = x1 - x0 + 1, height = y1 - y0 + 1 }
end

function Mask.clone(m)
  local c = Mask.new()
  for k, v in pairs(m.d) do c.d[k] = v end
  c.n = m.n
  return c
end

-- Clip to the canvas
function Mask.clip(m, w, h)
  for k in pairs(m.d) do
    local x, y = k % 65536, k // 65536
    if x >= w or y >= h then m.d[k] = nil; m.n = m.n - 1 end
  end
  return m
end

-- RLE: "x,y,w,h|v*count,v*count,..." over the bounding box rows
function Mask.encode(m)
  local b = Mask.bounds(m)
  if not b then return "" end
  local parts, cur, run = {}, nil, 0
  for y = b.y, b.y + b.height - 1 do
    for x = b.x, b.x + b.width - 1 do
      local v = m.d[mkey(x, y)] or 0
      if v == cur then run = run + 1 else
        if cur then parts[#parts + 1] = cur .. "*" .. run end
        cur, run = v, 1
      end
    end
  end
  parts[#parts + 1] = cur .. "*" .. run
  return string.format("%d,%d,%d,%d|%s", b.x, b.y, b.width, b.height, table.concat(parts, ","))
end

function Mask.decode(s)
  local m = Mask.new()
  if not s or s == "" then return m end
  local x0, y0, w, h, body = s:match("^(%d+),(%d+),(%d+),(%d+)|(.*)$")
  if not x0 then return m end
  x0, y0, w = tonumber(x0), tonumber(y0), tonumber(w)
  local i = 0
  for v, n in body:gmatch("(%d+)%*(%d+)") do
    v, n = tonumber(v), tonumber(n)
    for _ = 1, n do
      if v > 0 then Mask.set(m, x0 + i % w, y0 + i // w, v) end
      i = i + 1
    end
  end
  return m
end

-- Current selection of a sprite (live mode: the editor selection).
local function loadSelection(spr, ctx)
  local stored = getProp(spr, "selection")
  local m = Mask.decode(stored)
  if ctx and ctx.live then
    local sel = spr.selection
    if sel and not sel.isEmpty then
      local b = sel.bounds
      local gui = Mask.new()
      for y = b.y, b.y + b.height - 1 do
        for x = b.x, b.x + b.width - 1 do
          if sel:contains(x, y) then Mask.set(gui, x, y, math.max(1, Mask.get(m, x, y) > 0 and Mask.get(m, x, y) or 255)) end
        end
      end
      return gui
    end
  end
  return m
end
H.loadSelection = loadSelection

local function storeSelection(spr, m, ctx)
  Mask.clip(m, spr.width, spr.height)
  setProp(spr, "selection", m.n > 0 and Mask.encode(m) or nil)
  if ctx and ctx.live then
    local sel = Selection()
    Mask.each(m, function(x, y) sel:add(Rectangle(x, y, 1, 1)) end)
    spr.selection = sel
  end
end
H.storeSelection = storeSelection

-- Selection of the running batch (lazy).
local RUN = { sel = nil, selDirty = false, ctx = nil }
H.RUN = RUN

function H.selection(spr)
  if not RUN.sel then RUN.sel = loadSelection(spr, RUN.ctx) end
  return RUN.sel
end

function H.setSelection(spr, m)
  RUN.sel = m
  RUN.selDirty = true
end

---------------------------------------------------------------------------
-- Drawing on a cel
---------------------------------------------------------------------------

-- Run fn(img, put) against one cel and commit. put(x, y [, value]) clips to the
-- canvas and, with op.inSelection, to the current selection.
local function withCelFrame(spr, op, layer, frame, fn)
  local img, cel = editableImage(spr, layer, frame)
  local w, h = img.width, img.height
  local count = 0
  local v = op.color and pixelValue(spr, op.color) or nil
  local mask = op.inSelection and H.selection(spr) or nil
  if op.inSelection and mask.n == 0 then fail("inSelection is set but nothing is selected (use a sel.* operation first)") end
  local mirror = op.mirror -- "x" | "y" | "xy": symmetric drawing around the canvas center
  local function raw(x, y, value)
    if x >= 0 and y >= 0 and x < w and y < h and (not mask or Mask.get(mask, x, y) > 0) then
      img:drawPixel(x, y, value)
      count = count + 1
    end
  end
  local function put(x, y, value)
    value = value or v
    raw(x, y, value)
    if mirror == "x" or mirror == "xy" then raw(w - 1 - x, y, value) end
    if mirror == "y" or mirror == "xy" then raw(x, h - 1 - y, value) end
    if mirror == "xy" then raw(w - 1 - x, h - 1 - y, value) end
  end
  local extra = fn(img, put) or {}
  commitImage(spr, layer, frame, img, cel)
  extra.pixels = (extra.pixels or 0) + count
  return extra
end
H.withCelFrame = withCelFrame

-- Same, for every selected frame (frame/frames/tag; default frame 1).
local function withCel(spr, op, fn)
  local layer = findLayer(spr, op.layer)
  local total, last = 0, {}
  for _, fn_ in ipairs(frameList(spr, op)) do
    last = withCelFrame(spr, op, layer, findFrame(spr, fn_), fn)
    total = total + (last.pixels or 0)
  end
  last.pixels = total
  return last
end
H.withCel = withCel

-- Render a frame (optionally one layer) into a canvas-sized RGBA image.
local function renderFrame(spr, frameNo, layerRef)
  local frame = findFrame(spr, frameNo)
  local out = Image(spr.width, spr.height, ColorMode.RGB)
  out:clear(0)
  if layerRef then
    local layer = findLayer(spr, layerRef, false, true)
    local cel = layer:cel(frame.frameNumber)
    if cel and not layer.isTilemap then
      local src = cel.image
      for it in src:pixels() do
        local x, y = it.x + cel.position.x, it.y + cel.position.y
        if x >= 0 and y >= 0 and x < spr.width and y < spr.height then
          local r, g, b, a = pixelRGBA(spr, it(), src.colorMode)
          if a > 0 then out:drawPixel(x, y, pc.rgba(r, g, b, a)) end
        end
      end
    elseif cel then
      -- tilemap layer: draw the tiles
      local ts = layer.tileset
      local tw, th = ts.grid.tileSize.width, ts.grid.tileSize.height
      for it in cel.image:pixels() do
        local ti = pc.tileI(it())
        if ti > 0 and ti < #ts then
          local timg = ts:tile(ti).image
          for p in timg:pixels() do
            local x, y = cel.position.x + it.x * tw + p.x, cel.position.y + it.y * th + p.y
            local r, g, b, a = pixelRGBA(spr, p(), timg.colorMode)
            if a > 0 and x >= 0 and y >= 0 and x < spr.width and y < spr.height then out:drawPixel(x, y, pc.rgba(r, g, b, a)) end
          end
        end
      end
    end
  else
    out:drawSprite(spr, frame.frameNumber, Point(0, 0))
  end
  return out
end
H.renderFrame = renderFrame

-- Opaque bounding box of an RGBA image, or nil.
local function contentBounds(img)
  local r = img:shrinkBounds(0)
  if r.isEmpty then return nil end
  return { x = r.x, y = r.y, width = r.width, height = r.height }
end
H.contentBounds = contentBounds

---------------------------------------------------------------------------
-- Raster primitives
---------------------------------------------------------------------------

local function line(put, x0, y0, x1, y1)
  local dx, sx = math.abs(x1 - x0), x0 < x1 and 1 or -1
  local dy, sy = -math.abs(y1 - y0), y0 < y1 and 1 or -1
  local err = dx + dy
  while true do
    put(x0, y0)
    if x0 == x1 and y0 == y1 then break end
    local e2 = 2 * err
    if e2 >= dy then err = err + dy; x0 = x0 + sx end
    if e2 <= dx then err = err + dx; y0 = y0 + sy end
  end
end
H.line = line

-- Pixel ellipse inscribed in the inclusive box (Alois Zingl's algorithm).
-- span(xa, xb, y) receives the left/right extents of each row.
local function ellipse(span, x0, y0, x1, y1)
  local a, b = math.abs(x1 - x0), math.abs(y1 - y0)
  local b1 = b % 2
  local dx, dy = 4 * (1 - a) * b * b, 4 * (b1 + 1) * a * a
  local err = dx + dy + b1 * a * a
  if x0 > x1 then x0 = x1; x1 = x1 + a end
  if y0 > y1 then y0 = y1 end
  y0 = y0 + math.floor((b + 1) / 2)
  y1 = y0 - b1
  a = 8 * a * a
  b1 = 8 * b * b
  repeat
    span(x0, x1, y0)
    span(x0, x1, y1)
    local e2 = 2 * err
    if e2 <= dy then y0 = y0 + 1; y1 = y1 - 1; dy = dy + a; err = err + dy end
    if e2 >= dx or 2 * err > dy then x0 = x0 + 1; x1 = x1 - 1; dx = dx + b1; err = err + dx end
  until x0 > x1
  while y0 - y1 <= b do
    span(x0 - 1, x1 + 1, y0)
    span(x0 - 1, x1 + 1, y1)
    y0 = y0 + 1
    y1 = y1 - 1
  end
end
H.ellipse = ellipse

-- Even-odd scanline fill of a polygon; span(xa, xb, y) per covered run.
local function polygonSpans(points, span)
  local miny, maxy = math.huge, -math.huge
  for _, p in ipairs(points) do miny = math.min(miny, p.y); maxy = math.max(maxy, p.y) end
  local n = #points
  for y = miny, maxy do
    local xs = {}
    local sy = y + 0.5
    for i = 1, n do
      local a, b = points[i], points[i % n + 1]
      if (a.y <= sy and b.y > sy) or (b.y <= sy and a.y > sy) then
        xs[#xs + 1] = a.x + (sy - a.y) * (b.x - a.x) / (b.y - a.y)
      end
    end
    table.sort(xs)
    for i = 1, #xs - 1, 2 do
      local xa, xb = math.ceil(xs[i] - 0.5), math.floor(xs[i + 1] - 0.5)
      if xb >= xa then span(xa, xb, y) end
    end
  end
end
H.polygonSpans = polygonSpans

local function colorsClose(spr, v1, v2, tol, mode)
  if tol == 0 then return v1 == v2 end
  local r1, g1, b1, a1 = pixelRGBA(spr, v1, mode)
  local r2, g2, b2, a2 = pixelRGBA(spr, v2, mode)
  return math.abs(r1 - r2) <= tol and math.abs(g1 - g2) <= tol and math.abs(b1 - b2) <= tol and math.abs(a1 - a2) <= tol
end
H.colorsClose = colorsClose

-- Flood fill on any image; put(x, y) for each matching connected pixel.
local function flood(img, sx, sy, matchFn, put, diagonal)
  local w, h = img.width, img.height
  local visited = {}
  local stack = { sx, sy }
  while #stack > 0 do
    local y = table.remove(stack)
    local x = table.remove(stack)
    if x >= 0 and y >= 0 and x < w and y < h then
      local k = y * w + x
      if not visited[k] then
        visited[k] = true
        if matchFn(img:getPixel(x, y), x, y) then
          put(x, y)
          stack[#stack + 1] = x + 1; stack[#stack + 1] = y
          stack[#stack + 1] = x - 1; stack[#stack + 1] = y
          stack[#stack + 1] = x; stack[#stack + 1] = y + 1
          stack[#stack + 1] = x; stack[#stack + 1] = y - 1
          if diagonal then
            stack[#stack + 1] = x + 1; stack[#stack + 1] = y + 1
            stack[#stack + 1] = x - 1; stack[#stack + 1] = y - 1
            stack[#stack + 1] = x + 1; stack[#stack + 1] = y - 1
            stack[#stack + 1] = x - 1; stack[#stack + 1] = y + 1
          end
        end
      end
    end
  end
end
H.flood = flood

H.BAYER4 = {
  { 0, 8, 2, 10 },
  { 12, 4, 14, 6 },
  { 3, 11, 1, 9 },
  { 15, 7, 13, 5 },
}

H.EASE = {
  linear = function(t) return t end,
  ease_in = function(t) return t * t end,
  ease_out = function(t) return 1 - (1 - t) * (1 - t) end,
  ease_in_out = function(t) return t < 0.5 and 2 * t * t or 1 - ((-2 * t + 2) ^ 2) / 2 end,
}

-- Deterministic PRNG (xorshift32) so generated content is reproducible.
function H.rng(seed)
  local s = (seed or 1) & 0xffffffff
  if s == 0 then s = 0x9e3779b9 end
  return function()
    s = s ~ ((s << 13) & 0xffffffff)
    s = s ~ (s >> 17)
    s = s ~ ((s << 5) & 0xffffffff)
    return (s & 0xffffffff) / 4294967296
  end
end

-- Opaque test on a raw pixel value of the sprite's mode.
function H.isOpaque(spr, v, mode)
  local _, _, _, a = pixelRGBA(spr, v, mode)
  return a > 0
end

-- Cels targeted by op.layer (default: all image layers) and an optional frame selection.
local function targetCels(spr, op)
  local layers = op.layer and { findLayer(spr, op.layer) } or imageLayers(spr)
  local frameSet
  if hasFrameSel(op) then
    frameSet = {}
    for _, n in ipairs(frameList(spr, op)) do frameSet[n] = true end
  end
  local cels, seen = {}, {}
  for _, layer in ipairs(layers) do
    if not layer.isGroup and not layer.isTilemap then
      for _, cel in ipairs(layer.cels) do
        if (not frameSet or frameSet[cel.frameNumber]) and not seen[cel.image.id] then
          seen[cel.image.id] = true -- linked cels share one image
          cels[#cels + 1] = cel
        end
      end
    end
  end
  return cels
end
H.targetCels = targetCels

-- Apply fn(r,g,b,a,x,y) -> r,g,b,a to every opaque pixel of the targeted cels
-- (x,y in canvas coordinates; with op.inSelection only inside the selection).
local function mapPixels(spr, op, fn)
  local n = 0
  local mask = op.inSelection and H.selection(spr) or nil
  for _, cel in ipairs(targetCels(spr, op)) do
    local img = cel.image:clone()
    local changed = false
    local px, py = cel.position.x, cel.position.y
    for it in img:pixels() do
      local v = it()
      local r, g, b, a = pixelRGBA(spr, v, img.colorMode)
      if a > 0 and (not mask or Mask.get(mask, it.x + px, it.y + py) > 0) then
        local nr, ng, nb, na = fn(r, g, b, a, it.x + px, it.y + py)
        if nr then
          local nv = encode(spr, nr, ng, nb, na)
          if nv ~= v then it(nv); n = n + 1; changed = true end
        end
      end
    end
    if changed then cel.image = img end
  end
  return n
end
H.mapPixels = mapPixels

---------------------------------------------------------------------------
-- Inspection
---------------------------------------------------------------------------

local function spriteInfo(spr, opts)
  opts = opts or {}
  local layers = {}
  for _, e in ipairs(allLayers(spr)) do
    local l = e.layer
    local celFrames = {}
    if not l.isGroup then
      for _, cel in ipairs(l.cels) do celFrames[#celFrames + 1] = cel.frameNumber end
      table.sort(celFrames)
    end
    local info = {
      path = e.path,
      depth = e.depth,
      type = l.isGroup and "group" or (l.isTilemap and "tilemap" or "image"),
      visible = l.isVisible,
      locked = not l.isEditable or nil,
      opacity = l.opacity ~= 255 and l.opacity or nil,
      blendMode = (l.blendMode and l.blendMode ~= BlendMode.NORMAL) and BLEND_NAME[l.blendMode] or nil,
      background = l.isBackground or nil,
      celFrames = (not l.isGroup) and ranges(celFrames) or nil,
    }
    if l.isTilemap and l.tileset then
      info.tileset = { name = l.tileset.name, tiles = #l.tileset, tileWidth = l.tileset.grid.tileSize.width, tileHeight = l.tileset.grid.tileSize.height }
    end
    layers[#layers + 1] = info
  end
  local frames = {}
  for i, f in ipairs(spr.frames) do frames[#frames + 1] = { frame = i, durationMs = round(f.duration * 1000) } end
  local tags = {}
  for _, t in ipairs(spr.tags) do
    tags[#tags + 1] = {
      name = t.name, from = t.fromFrame.frameNumber, to = t.toFrame.frameNumber,
      direction = ANIDIR_NAME[t.aniDir] or "forward",
      repeats = (t.repeats and t.repeats > 0) and t.repeats or nil,
    }
  end
  local slices = {}
  for _, s in ipairs(spr.slices) do
    local info = { name = s.name, x = s.bounds.x, y = s.bounds.y, width = s.bounds.width, height = s.bounds.height }
    if s.pivot then info.pivot = { x = s.pivot.x, y = s.pivot.y } end
    if s.center then info.center = { x = s.center.x, y = s.center.y, width = s.center.width, height = s.center.height } end
    slices[#slices + 1] = info
  end
  local pal = spr.palettes[1]
  local palette = { size = #pal }
  if opts.paletteColors ~= false and #pal <= 256 then
    local colors = {}
    for i = 0, #pal - 1 do colors[#colors + 1] = colorHex(pal:getColor(i)) end
    palette.colors = colors
  end
  local sel = getProp(spr, "selection")
  return {
    file = spr.filename,
    width = spr.width,
    height = spr.height,
    colorMode = COLOR_MODE_NAME[spr.colorMode] or tostring(spr.colorMode),
    transparentIndex = spr.colorMode == ColorMode.INDEXED and spr.transparentColor or nil,
    frameCount = #spr.frames,
    frames = frames,
    layers = layers,
    tags = tags,
    slices = slices,
    palette = palette,
    pivot = getProp(spr, "pivot"),
    brief = opts.brief and getProp(spr, "brief") or nil,
    hasBrief = getProp(spr, "brief") ~= nil or nil,
    selection = (sel and sel ~= "") and Mask.bounds(Mask.decode(sel)) or nil,
  }
end
M.spriteInfo = spriteInfo
H.spriteInfo = spriteInfo

---------------------------------------------------------------------------
-- Change tracking: what an edit batch changed, by layer/frame region.
---------------------------------------------------------------------------

local function paletteSig(spr)
  local pal = spr.palettes[1]
  local parts = {}
  for i = 0, #pal - 1 do local c = pal:getColor(i); parts[#parts + 1] = string.format("%02x%02x%02x%02x", c.red, c.green, c.blue, c.alpha) end
  return table.concat(parts)
end

local function snapshot(spr)
  local s = { w = spr.width, h = spr.height, frames = #spr.frames, cels = {}, layers = {}, tags = {}, pal = paletteSig(spr), px = 0 }
  for _, e in ipairs(allLayers(spr)) do
    s.layers[#s.layers + 1] = e.path
    if not e.layer.isGroup then
      for _, cel in ipairs(e.layer.cels) do
        local img = cel.image
        s.px = s.px + img.width * img.height
        s.cels[e.path .. "\0" .. cel.frameNumber] = {
          bytes = img.bytes, img = s.px <= 4000000 and img:clone() or nil,
          x = cel.position.x, y = cel.position.y, opacity = cel.opacity, tilemap = e.layer.isTilemap or nil,
        }
      end
    end
  end
  for _, t in ipairs(spr.tags) do s.tags[#s.tags + 1] = string.format("%s:%d-%d:%s", t.name, t.fromFrame.frameNumber, t.toFrame.frameNumber, tostring(t.aniDir)) end
  local sl = {}
  for _, x in ipairs(spr.slices) do sl[#sl + 1] = x.name .. tostring(x.bounds) end
  s.slices = table.concat(sl, ";")
  s.durations = {}
  for i, f in ipairs(spr.frames) do s.durations[i] = f.duration end
  return s
end

local function diffBounds(spr, a, b)
  -- bounding box (canvas coords) of pixels that differ between two cel states
  if not a.img or not b.img or a.tilemap or b.tilemap then return nil end
  local ax, ay, bx, by = a.x, a.y, b.x, b.y
  local x0 = math.min(ax, bx)
  local y0 = math.min(ay, by)
  local x1 = math.max(ax + a.img.width, bx + b.img.width) - 1
  local y1 = math.max(ay + a.img.height, by + b.img.height) - 1
  local tv = transparentValue(spr)
  local minx, miny, maxx, maxy, n
  n = 0
  for y = y0, y1 do
    for x = x0, x1 do
      local va, vb = tv, tv
      local ix, iy = x - ax, y - ay
      if ix >= 0 and iy >= 0 and ix < a.img.width and iy < a.img.height then va = a.img:getPixel(ix, iy) end
      ix, iy = x - bx, y - by
      if ix >= 0 and iy >= 0 and ix < b.img.width and iy < b.img.height then vb = b.img:getPixel(ix, iy) end
      if va ~= vb then
        n = n + 1
        if not minx or x < minx then minx = x end
        if not maxx or x > maxx then maxx = x end
        if not miny or y < miny then miny = y end
        if not maxy or y > maxy then maxy = y end
      end
    end
  end
  if n == 0 then return { pixels = 0 } end
  return { x = minx, y = miny, width = maxx - minx + 1, height = maxy - miny + 1, pixels = n }
end

local function changes(spr, before, after)
  local out = { regions = {}, cels = 0, pixels = 0 }
  if before.w ~= after.w or before.h ~= after.h then out.canvas = { from = before.w .. "x" .. before.h, to = after.w .. "x" .. after.h } end
  if before.frames ~= after.frames then out.frames = { from = before.frames, to = after.frames } end
  if before.pal ~= after.pal then out.palette = true end
  if table.concat(before.tags, ",") ~= table.concat(after.tags, ",") then out.tags = true end
  if before.slices ~= after.slices then out.slices = true end
  local timing = {}
  for i = 1, math.min(before.frames, after.frames) do
    if before.durations[i] ~= after.durations[i] then timing[#timing + 1] = i end
  end
  if #timing > 0 then out.timing = ranges(timing) end
  local lb, la = {}, {}
  for _, p in ipairs(before.layers) do lb[p] = true end
  for _, p in ipairs(after.layers) do la[p] = true end
  local added, removed = {}, {}
  for _, p in ipairs(after.layers) do if not lb[p] then added[#added + 1] = p end end
  for _, p in ipairs(before.layers) do if not la[p] then removed[#removed + 1] = p end end
  if #added > 0 then out.layersAdded = added end
  if #removed > 0 then out.layersRemoved = removed end
  local keys, seen = {}, {}
  for k in pairs(before.cels) do keys[#keys + 1] = k; seen[k] = true end
  for k in pairs(after.cels) do if not seen[k] then keys[#keys + 1] = k end end
  table.sort(keys)
  local empty = { bytes = "", x = 0, y = 0 }
  for _, k in ipairs(keys) do
    local a, b = before.cels[k] or empty, after.cels[k] or empty
    if a.bytes ~= b.bytes or a.x ~= b.x or a.y ~= b.y or a.opacity ~= b.opacity then
      local layer, frame = k:match("^(.*)%z(%d+)$")
      out.cels = out.cels + 1
      local region
      if before.w == after.w and before.h == after.h then
        local ea = a.img and a or { img = Image(1, 1, spr.colorMode), x = -99999, y = -99999 }
        local eb = b.img and b or { img = Image(1, 1, spr.colorMode), x = -99999, y = -99999 }
        if a == empty then ea = { img = Image(b.img.width, b.img.height, b.img.colorMode), x = b.x, y = b.y }; ea.img:clear(transparentValue(spr)) end
        if b == empty then eb = { img = Image(a.img.width, a.img.height, a.img.colorMode), x = a.x, y = a.y }; eb.img:clear(transparentValue(spr)) end
        if a.tilemap or b.tilemap then ea.tilemap = true end
        region = diffBounds(spr, ea, eb)
      end
      local entry = { layer = layer, frame = tonumber(frame) }
      if region then
        entry.x, entry.y, entry.w, entry.h, entry.pixels = region.x, region.y, region.width, region.height, region.pixels
        out.pixels = out.pixels + (region.pixels or 0)
      end
      if a == empty then entry.created = true elseif b == empty then entry.deleted = true end
      if a.opacity ~= b.opacity and a ~= empty and b ~= empty then entry.opacity = b.opacity end
      if #out.regions < 24 then out.regions[#out.regions + 1] = entry end
    end
  end
  if out.cels > #out.regions then out.truncated = out.cels - #out.regions end
  return out
end

---------------------------------------------------------------------------
-- Operations registry. Category modules add to M.OPS / M.QUERIES / M.VIEWS.
---------------------------------------------------------------------------

local OPS, QUERIES, VIEWS = {}, {}, {}
M.OPS, M.QUERIES, M.VIEWS = OPS, QUERIES, VIEWS
H.OPS, H.QUERIES, H.VIEWS = OPS, QUERIES, VIEWS

---------------------------------------------------------------------------
-- Commands
---------------------------------------------------------------------------

local CMD = {}
M.CMD = CMD
H.CMD = CMD

local function getSprite(req, ctx)
  if ctx.live then
    if req.input then
      for _, s in ipairs(app.sprites) do
        if s.filename == req.input then app.activeSprite = s; return s end
      end
      local s = app.open(req.input)
      if not s then fail("could not open '" .. req.input .. "' in the editor") end
      return s
    end
    local s = app.activeSprite
    if not s then fail("no sprite is open in the Aseprite editor") end
    return s
  end
  local spr = app.open(req.input)
  if not spr then fail("could not open '" .. tostring(req.input) .. "'") end
  app.activeSprite = spr
  return spr
end
H.getSprite = getSprite

local function applyOps(spr, ops)
  local results = {}
  for i, op in ipairs(ops) do
    local fn = OPS[op.op]
    if not fn then fail(string.format("op #%d: unknown op '%s'", i, tostring(op.op))) end
    local ok, res = pcall(fn, spr, op)
    if not ok then fail(string.format("op #%d (%s) failed: %s", i, op.op, tostring(res))) end
    res = res or {}
    res.op = op.op
    results[#results + 1] = res
  end
  if RUN.selDirty then
    storeSelection(spr, RUN.sel, RUN.ctx)
    RUN.selDirty = false
  end
  return results
end
H.applyOps = applyOps

local function runOps(spr, ops, ctx, label)
  RUN.sel, RUN.selDirty, RUN.ctx = nil, false, ctx
  if ctx.live then
    local results
    app.transaction(label or "MCP edit", function() results = applyOps(spr, ops) end)
    app.refresh()
    return results
  end
  return applyOps(spr, ops)
end
H.runOps = runOps

CMD.create = function(req, ctx)
  local spr = Sprite(req.width, req.height, COLOR_MODE[req.colorMode or "rgb"])
  app.activeSprite = spr
  RUN.sel, RUN.selDirty, RUN.ctx = nil, false, ctx
  if req.palette then OPS["pal.set"](spr, { colors = req.palette }) end
  if req.layers and #req.layers > 0 then
    spr.layers[1].name = req.layers[1]
    for i = 2, #req.layers do spr:newLayer().name = req.layers[i] end
  end
  if req.frames and req.frames > 1 then
    for i = 2, req.frames do spr:newEmptyFrame(i) end
  end
  if req.frameDurationMs then
    for _, f in ipairs(spr.frames) do f.duration = req.frameDurationMs / 1000 end
  end
  if req.animations then
    -- Lay out tagged animations back to back, e.g. idle (4f) then walk (6f).
    local total = 0
    for _, a in ipairs(req.animations) do total = total + a.frames end
    while #spr.frames < total do spr:newEmptyFrame(#spr.frames + 1) end
    local at = 1
    for _, a in ipairs(req.animations) do
      local t = spr:newTag(at, at + a.frames - 1)
      t.name = a.name
      if a.direction then t.aniDir = ANIDIR[a.direction] end
      if a.durationMs then
        for n = at, at + a.frames - 1 do spr.frames[n].duration = a.durationMs / 1000 end
      end
      at = at + a.frames
    end
  end
  if req.background then
    local bottom = spr.layers[1]
    local img = Image(spr.spec)
    img:clear(pixelValue(spr, req.background))
    for _, f in ipairs(spr.frames) do spr:newCel(bottom, f, img:clone(), Point(0, 0)) end
  end
  local results = req.ops and applyOps(spr, req.ops) or {}
  if req.output then spr:saveCopyAs(req.output) end
  return { sprite = spriteInfo(spr), results = results }
end

CMD.inspect = function(req, ctx)
  local spr = getSprite(req, ctx)
  return { sprite = spriteInfo(spr, { paletteColors = req.paletteColors, brief = req.brief }), liveVersion = ctx.live and M.liveVersion and M.liveVersion(spr) or nil }
end

CMD.edit = function(req, ctx)
  local spr = getSprite(req, ctx)
  local before = req.track ~= false and snapshot(spr) or nil
  local results = runOps(spr, req.ops, ctx, req.label)
  local changed = before and changes(spr, before, snapshot(spr)) or nil
  if req.output then
    spr:saveCopyAs(req.output)
  elseif ctx.live and req.save then
    spr:saveAs(spr.filename)
  end
  return {
    sprite = spriteInfo(spr, { paletteColors = false }),
    results = results,
    changes = changed,
    liveVersion = ctx.live and M.liveVersion and M.liveVersion(spr) or nil,
  }
end

-- Read-only queries ({q = "layer.list", args = {...}})
CMD.query = function(req, ctx)
  local fn = QUERIES[req.q]
  if not fn then fail("unknown query '" .. tostring(req.q) .. "'") end
  local spr = req.input and getSprite(req, ctx) or nil
  if not spr and ctx.live then spr = getSprite(req, ctx) end
  RUN.sel, RUN.selDirty, RUN.ctx = nil, false, ctx
  return fn(spr, req.args or {}, req)
end

-- Rendered views ({view = "view.frames", args = {...}, output = "x.png"})
CMD.render = function(req, ctx)
  local fn = VIEWS[req.view]
  if not fn then fail("unknown view '" .. tostring(req.view) .. "'") end
  local spr = req.input and getSprite(req, ctx) or nil
  if not spr and ctx.live then spr = getSprite(req, ctx) end
  RUN.sel, RUN.selDirty, RUN.ctx = nil, false, ctx
  return fn(spr, req.args or {}, req)
end

CMD.save = function(req, ctx)
  local spr = getSprite(req, ctx)
  if req.output and req.copy then
    spr:saveCopyAs(req.output)
    return { file = req.output }
  end
  if req.output then spr:saveAs(req.output) else spr:saveAs(spr.filename) end
  return { file = spr.filename }
end

CMD.undo = function(req, ctx)
  local spr = getSprite(req, ctx)
  for _ = 1, req.steps or 1 do app.command.Undo() end
  app.refresh()
  return { sprite = spriteInfo(spr, { paletteColors = false }), liveVersion = M.liveVersion and M.liveVersion(spr) or nil }
end

CMD.redo = function(req, ctx)
  local spr = getSprite(req, ctx)
  for _ = 1, req.steps or 1 do app.command.Redo() end
  app.refresh()
  return { sprite = spriteInfo(spr, { paletteColors = false }), liveVersion = M.liveVersion and M.liveVersion(spr) or nil }
end

CMD.list_open = function(req, ctx)
  local out = {}
  for _, s in ipairs(app.sprites) do
    out[#out + 1] = { file = s.filename, width = s.width, height = s.height, active = s == app.activeSprite }
  end
  return { sprites = out, version = tostring(app.version) }
end

CMD.ping = function() return { version = tostring(app.version), api = app.apiVersion, core = M.version } end

CMD.lua = function(req, ctx)
  local spr = req.input and getSprite(req, ctx) or app.activeSprite
  local printed = {}
  local env = setmetatable({
    sprite = spr,
    print = function(...)
      local parts = {}
      for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
      printed[#printed + 1] = table.concat(parts, "\t")
    end,
  }, { __index = _G })
  local chunk, err = load(req.code, "=user", "t", env)
  if not chunk then fail("syntax error: " .. tostring(err)) end
  local ok, ret
  if ctx.live and spr then
    app.transaction("MCP Lua", function() ok, ret = pcall(chunk) end)
  else
    ok, ret = pcall(chunk)
  end
  if not ok then fail("runtime error: " .. tostring(ret)) end
  if spr and req.output then spr:saveCopyAs(req.output) end
  local encOk = pcall(json.encode, { r = ret })
  return { output = printed, result = encOk and ret or tostring(ret) }
end

---------------------------------------------------------------------------
-- Load category modules
---------------------------------------------------------------------------

local here = (debug.getinfo(1, "S").source or ""):gsub("^@", ""):match("^(.*)[/\\]") or "."
M.MODULES = { "mod_base", "mod_select", "mod_draw", "mod_color", "mod_anim", "mod_tiles", "mod_clean", "mod_view" }
for _, name in ipairs(M.MODULES) do
  local path = here .. "/" .. name .. ".lua"
  local f = io.open(path, "r")
  if f then
    f:close()
    local register = dofile(path)
    register(M, H)
  else
    error("missing Lua module " .. path)
  end
end

---------------------------------------------------------------------------
-- Dispatcher
---------------------------------------------------------------------------

function M.run(req, ctx)
  ctx = ctx or {}
  local fn = CMD[req.cmd]
  if not fn then fail("unknown command '" .. tostring(req.cmd) .. "'") end
  return fn(req, ctx)
end

-- Run a request and always return a JSON-encodable envelope.
function M.handle(req, ctx)
  local okPlain, converted = pcall(plain, req)
  if okPlain then req = converted end
  local ok, res = pcall(M.run, req, ctx)
  if ok then return { ok = true, data = res } end
  return { ok = false, error = tostring(res) }
end

-- Lists registered ids (used by tests to check catalog <-> engine parity).
CMD.registry = function()
  local o, q, v = {}, {}, {}
  for k in pairs(OPS) do o[#o + 1] = k end
  for k in pairs(QUERIES) do q[#q + 1] = k end
  for k in pairs(VIEWS) do v[#v + 1] = k end
  table.sort(o); table.sort(q); table.sort(v)
  return { ops = o, queries = q, views = v }
end

M.version = "2.0.0"

return M
