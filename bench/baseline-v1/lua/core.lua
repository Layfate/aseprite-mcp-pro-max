-- Aseprite MCP Pro Max — shared Lua core.
--
-- This module is used in two contexts:
--   * batch mode:  lua/batch.lua loads it and runs one request per Aseprite process
--   * live mode:   the editor extension loads it and runs requests received over WebSocket
--
-- Requests are JSON objects produced and validated by the TypeScript server.
-- No code from a request is evaluated, except by the explicitly opt-in "lua" command.

local M = {}
local pc = app.pixelColor

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

-- User-facing error (no Lua source position attached).
local function fail(msg)
  error(msg, 0)
end
M.fail = fail

local function clamp(v, lo, hi)
  if v < lo then return lo elseif v > hi then return hi end
  return v
end

local function round(v)
  return math.floor(v + 0.5)
end

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

---------------------------------------------------------------------------
-- Enum maps
---------------------------------------------------------------------------

local COLOR_MODE_NAME = {
  [ColorMode.RGB] = "rgb",
  [ColorMode.GRAY] = "gray",
  [ColorMode.INDEXED] = "indexed",
}
if ColorMode.TILEMAP then COLOR_MODE_NAME[ColorMode.TILEMAP] = "tilemap" end
local COLOR_MODE = { rgb = ColorMode.RGB, gray = ColorMode.GRAY, indexed = ColorMode.INDEXED }

local ANIDIR = { forward = AniDir.FORWARD, reverse = AniDir.REVERSE, pingpong = AniDir.PING_PONG }
if AniDir.PING_PONG_REVERSE then ANIDIR.pingpong_reverse = AniDir.PING_PONG_REVERSE end
local ANIDIR_NAME = {}
for k, v in pairs(ANIDIR) do ANIDIR_NAME[v] = k end

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

---------------------------------------------------------------------------
-- Colors
-- Colors arrive already normalized as { r=, g=, b=, a= } (0..255) or { index = n }.
---------------------------------------------------------------------------

local function paletteRGBA(spr, index)
  local pal = spr.palettes[1]
  if index < 0 or index >= #pal then
    fail(string.format("palette index %d out of range (palette has %d colors)", index, #pal))
  end
  local c = pal:getColor(index)
  return c.red, c.green, c.blue, c.alpha
end

local function nearestInList(list, r, g, b)
  local best, bestD = 1, math.huge
  for i, c in ipairs(list) do
    local d = (c[1] - r) ^ 2 + (c[2] - g) ^ 2 + (c[3] - b) ^ 2
    if d < bestD then best, bestD = i, d end
  end
  return best
end

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

local function rgbaOf(spr, c)
  if c.index ~= nil then return paletteRGBA(spr, c.index) end
  return c.r, c.g, c.b, c.a
end

-- Convert raw r,g,b,a into a pixel value for the sprite's color mode.
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

-- Convert a normalized color into a raw pixel value for this sprite's color mode.
local function pixelValue(spr, c)
  if spr.colorMode == ColorMode.INDEXED and c.index ~= nil then
    paletteRGBA(spr, c.index) -- range check
    return c.index
  end
  return encode(spr, rgbaOf(spr, c))
end

local function toColorObject(spr, c)
  local r, g, b, a = rgbaOf(spr, c)
  return Color { r = r, g = g, b = b, a = a }
end

-- Raw pixel value (of an image in the given color mode) -> r, g, b, a
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

local function hex(r, g, b, a)
  if a == 0 then return "transparent" end
  if a == 255 then return string.format("#%02x%02x%02x", r, g, b) end
  return string.format("#%02x%02x%02x%02x", r, g, b, a)
end

local function colorHex(c)
  return hex(c.red, c.green, c.blue, c.alpha)
end

local function transparentValue(spr)
  if spr.colorMode == ColorMode.INDEXED then return spr.transparentColor end
  return 0
end

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

local function allLayers(spr)
  return collectLayers(spr.layers, nil, 0, {})
end

local function imageLayers(spr)
  local out = {}
  for _, e in ipairs(allLayers(spr)) do
    if not e.layer.isGroup and not e.layer.isTilemap then out[#out + 1] = e.layer end
  end
  return out
end

local function layerPaths(spr)
  local names = {}
  for _, e in ipairs(allLayers(spr)) do names[#names + 1] = "'" .. e.path .. "'" end
  return table.concat(names, ", ")
end

local function pathOf(spr, layer)
  for _, e in ipairs(allLayers(spr)) do
    if e.layer == layer then return e.path end
  end
  return layer.name
end

-- Resolve a layer reference (path "Group/Child" or unique name).
-- When ref is nil the sprite must have exactly one image layer.
local function findLayer(spr, ref, allowGroup)
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
  return found
end

local function findFrame(spr, n)
  n = n or 1
  if n < 1 or n > #spr.frames then
    fail(string.format("frame %d out of range (sprite has %d frames, numbered from 1)", n, #spr.frames))
  end
  return spr.frames[n]
end

local function findTag(spr, name)
  for _, t in ipairs(spr.tags) do
    if t.name == name then return t end
  end
  local names = {}
  for _, t in ipairs(spr.tags) do names[#names + 1] = "'" .. t.name .. "'" end
  fail(string.format("tag '%s' not found (tags: %s)", name, #names > 0 and table.concat(names, ", ") or "none"))
end

local function findSlice(spr, name)
  for _, s in ipairs(spr.slices) do
    if s.name == name then return s end
  end
  fail(string.format("slice '%s' not found", name))
end

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

local function assertEditable(layer)
  if layer.isGroup then fail("layer '" .. layer.name .. "' is a group; target an image layer") end
  if layer.isTilemap then fail("tilemap layers are not supported by this operation") end
  if not layer.isEditable then fail("layer '" .. layer.name .. "' is locked; unlock it with set_layer first") end
end

-- Return a full-canvas copy of a layer/frame cel plus the existing cel (or nil).
local function editableImage(spr, layer, frame)
  assertEditable(layer)
  local img = Image(spr.spec)
  img:clear(transparentValue(spr))
  local cel = layer:cel(frame.frameNumber)
  if cel then img:drawImage(cel.image, cel.position, 255, BlendMode.SRC) end
  return img, cel
end

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

-- Run fn(img, put) against a layer/frame cel and commit. put(x, y [, value]) clips to the canvas.
local function withCel(spr, op, fn)
  local layer = findLayer(spr, op.layer)
  local frame = findFrame(spr, op.frame)
  local img, cel = editableImage(spr, layer, frame)
  local w, h = img.width, img.height
  local count = 0
  local v = op.color and pixelValue(spr, op.color) or nil
  local function put(x, y, value)
    if x >= 0 and y >= 0 and x < w and y < h then
      img:drawPixel(x, y, value or v)
      count = count + 1
    end
  end
  local extra = fn(img, put) or {}
  commitImage(spr, layer, frame, img, cel)
  extra.pixels = count
  return extra
end

-- Render a frame (optionally a single layer) into a canvas-sized RGBA image.
local function renderFrame(spr, frameNo, layerRef)
  local frame = findFrame(spr, frameNo)
  local out = Image(spr.width, spr.height, ColorMode.RGB)
  out:clear(0)
  if layerRef then
    local layer = findLayer(spr, layerRef)
    local cel = layer:cel(frame.frameNumber)
    if cel then
      local src = cel.image
      for it in src:pixels() do
        local x, y = it.x + cel.position.x, it.y + cel.position.y
        if x >= 0 and y >= 0 and x < spr.width and y < spr.height then
          local r, g, b, a = pixelRGBA(spr, it(), src.colorMode)
          if a > 0 then out:drawPixel(x, y, pc.rgba(r, g, b, a)) end
        end
      end
    end
  else
    out:drawSprite(spr, frame.frameNumber, Point(0, 0))
  end
  return out
end

-- Opaque bounding box of an RGBA image, or nil.
local function contentBounds(img)
  local x0, y0, x1, y1
  for it in img:pixels() do
    if pc.rgbaA(it()) > 0 then
      local x, y = it.x, it.y
      if not x0 or x < x0 then x0 = x end
      if not x1 or x > x1 then x1 = x end
      if not y0 or y < y0 then y0 = y end
      if not y1 or y > y1 then y1 = y end
    end
  end
  if not x0 then return nil end
  return { x = x0, y = y0, width = x1 - x0 + 1, height = y1 - y0 + 1 }
end

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

-- Pixel ellipse inscribed in the inclusive box (x0,y0)-(x1,y1) (Alois Zingl's algorithm).
-- span(xa, xb, y) is called with the left/right extents of each row.
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

local function colorsClose(spr, v1, v2, tol, mode)
  if tol == 0 then return v1 == v2 end
  local r1, g1, b1, a1 = pixelRGBA(spr, v1, mode)
  local r2, g2, b2, a2 = pixelRGBA(spr, v2, mode)
  return math.abs(r1 - r2) <= tol and math.abs(g1 - g2) <= tol and math.abs(b1 - b2) <= tol and math.abs(a1 - a2) <= tol
end

-- Flood fill on any image. Returns number of pixels changed via put().
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
        if matchFn(img:getPixel(x, y)) then
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

local BAYER4 = {
  { 0, 8, 2, 10 },
  { 12, 4, 14, 6 },
  { 3, 11, 1, 9 },
  { 15, 7, 13, 5 },
}

local EASE = {
  linear = function(t) return t end,
  ease_in = function(t) return t * t end,
  ease_out = function(t) return 1 - (1 - t) * (1 - t) end,
  ease_in_out = function(t) return t < 0.5 and 2 * t * t or 1 - ((-2 * t + 2) ^ 2) / 2 end,
}

-- 3x5 bitmap font (rows top to bottom, 3 bits each). Lowercase renders as uppercase.
local FONT3x5 = {
  A = "010101111101101", B = "110101110101110", C = "011100100100011", D = "110101101101110",
  E = "111100110100111", F = "111100110100100", G = "011100101101011", H = "101101111101101",
  I = "111010010010111", J = "001001001101010", K = "101101110101101", L = "100100100100111",
  M = "101111111101101", N = "110101101101101", O = "010101101101010", P = "110101110100100",
  Q = "010101101110011", R = "110101110101101", S = "011100010001110", T = "111010010010010",
  U = "101101101101111", V = "101101101101010", W = "101101111111101", X = "101101010101101",
  Y = "101101010010010", Z = "111001010100111",
  ["0"] = "111101101101111", ["1"] = "010110010010111", ["2"] = "110001010100111",
  ["3"] = "110001010001110", ["4"] = "101101111001001", ["5"] = "111100110001110",
  ["6"] = "011100111101111", ["7"] = "111001010010010", ["8"] = "111101111101111",
  ["9"] = "111101111001110",
  [" "] = "000000000000000", ["."] = "000000000000010", [","] = "000000000010100",
  ["!"] = "010010010000010", ["?"] = "110001010000010", ["-"] = "000000111000000",
  ["+"] = "000010111010000", [":"] = "000010000010000", ["/"] = "001001010100100",
  ["'"] = "010010000000000", ["("] = "001010010010001", [")"] = "100010010010100",
  ["="] = "000111000111000", ["_"] = "000000000000111", ["%"] = "101001010100101",
  ["#"] = "101111101111101", ["<"] = "001010100010001", [">"] = "100010001010100",
  ["*"] = "000101010101000", ['"'] = "101101000000000",
}

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
    layers[#layers + 1] = {
      path = e.path,
      depth = e.depth,
      type = l.isGroup and "group" or (l.isTilemap and "tilemap" or "image"),
      visible = l.isVisible,
      locked = not l.isEditable,
      opacity = l.opacity,
      blendMode = l.blendMode and BLEND_NAME[l.blendMode] or nil,
      background = l.isBackground or nil,
      celFrames = (not l.isGroup) and ranges(celFrames) or nil,
    }
  end
  local frames = {}
  for i, f in ipairs(spr.frames) do
    frames[#frames + 1] = { frame = i, durationMs = round(f.duration * 1000) }
  end
  local tags = {}
  for _, t in ipairs(spr.tags) do
    tags[#tags + 1] = {
      name = t.name,
      from = t.fromFrame.frameNumber,
      to = t.toFrame.frameNumber,
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
  }
end
M.spriteInfo = spriteInfo

---------------------------------------------------------------------------
-- Edit operations
---------------------------------------------------------------------------

local OPS = {}
M.OPS = OPS

-- Drawing ------------------------------------------------------------------

OPS.set_pixels = function(spr, op)
  local layer = findLayer(spr, op.layer)
  local frame = findFrame(spr, op.frame)
  local img, cel = editableImage(spr, layer, frame)
  for _, p in ipairs(op.pixels) do
    if p.x < 0 or p.y < 0 or p.x >= img.width or p.y >= img.height then
      fail(string.format("pixel (%d,%d) is outside the %dx%d canvas", p.x, p.y, img.width, img.height))
    end
    img:drawPixel(p.x, p.y, pixelValue(spr, p.color))
  end
  commitImage(spr, layer, frame, img, cel)
  return { pixels = #op.pixels }
end

OPS.pixel_map = function(spr, op)
  local layer = findLayer(spr, op.layer)
  local frame = findFrame(spr, op.frame)
  local img, cel = editableImage(spr, layer, frame)
  local values = {}
  for ch, c in pairs(op.legend) do values[ch] = pixelValue(spr, c) end
  local ox, oy = op.x or 0, op.y or 0
  local n, clipped = 0, 0
  for row, s in ipairs(op.rows) do
    for col = 1, #s do
      local ch = s:sub(col, col)
      if ch ~= "." and ch ~= " " then
        local v = values[ch]
        if v == nil then fail(string.format("row %d col %d: character '%s' is not in the legend", row, col, ch)) end
        local x, y = ox + col - 1, oy + row - 1
        if x >= 0 and y >= 0 and x < img.width and y < img.height then
          img:drawPixel(x, y, v)
          n = n + 1
        else
          clipped = clipped + 1
        end
      end
    end
  end
  commitImage(spr, layer, frame, img, cel)
  return { pixels = n, clipped = clipped }
end

OPS.line = function(spr, op)
  return withCel(spr, op, function(_, put)
    local pts = op.points or { { x = op.x1, y = op.y1 }, { x = op.x2, y = op.y2 } }
    local seen = {}
    local function plot(x, y)
      local k = y * 65536 + x
      if not seen[k] then seen[k] = true; put(x, y) end
    end
    for i = 1, #pts - 1 do line(plot, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) end
    if op.closed and #pts > 2 then line(plot, pts[#pts].x, pts[#pts].y, pts[1].x, pts[1].y) end
  end)
end

OPS.rect = function(spr, op)
  return withCel(spr, op, function(_, put)
    local x0, y0, x1, y1 = op.x, op.y, op.x + op.width - 1, op.y + op.height - 1
    for y = y0, y1 do
      for x = x0, x1 do
        if op.filled or x == x0 or x == x1 or y == y0 or y == y1 then put(x, y) end
      end
    end
  end)
end

OPS.ellipse = function(spr, op)
  return withCel(spr, op, function(_, put)
    local seen = {}
    local function plot(x, y)
      local k = y * 65536 + x
      if not seen[k] then seen[k] = true; put(x, y) end
    end
    ellipse(function(xa, xb, y)
      if op.filled then
        for x = math.min(xa, xb), math.max(xa, xb) do plot(x, y) end
      else
        plot(xa, y); plot(xb, y)
      end
    end, op.x, op.y, op.x + op.width - 1, op.y + op.height - 1)
  end)
end

OPS.fill = function(spr, op)
  local tol = op.tolerance or 0
  return withCel(spr, op, function(img, put)
    local w, h = img.width, img.height
    if op.x < 0 or op.y < 0 or op.x >= w or op.y >= h then
      fail(string.format("fill seed (%d,%d) is outside the %dx%d canvas", op.x, op.y, w, h))
    end
    local target = img:getPixel(op.x, op.y)
    local v = pixelValue(spr, op.color)
    local function match(p) return colorsClose(spr, p, target, tol) end
    if op.contiguous == false then
      for y = 0, h - 1 do
        for x = 0, w - 1 do
          if match(img:getPixel(x, y)) then put(x, y) end
        end
      end
      return
    end
    if target == v and tol == 0 then return end
    flood(img, op.x, op.y, match, put, op.diagonal)
  end)
end

OPS.gradient = function(spr, op)
  return withCel(spr, op, function(_, put)
    local stops = {}
    for i, c in ipairs(op.colors) do stops[i] = pixelValue(spr, c) end
    local n = #stops
    local x0, y0 = op.x or 0, op.y or 0
    local w, h = op.width or spr.width, op.height or spr.height
    local vertical = op.direction ~= "horizontal"
    local dither = op.dither ~= false
    for y = y0, y0 + h - 1 do
      for x = x0, x0 + w - 1 do
        local t
        if vertical then t = h > 1 and (y - y0) / (h - 1) or 0 else t = w > 1 and (x - x0) / (w - 1) or 0 end
        local pos = t * (n - 1)
        local i = math.min(math.floor(pos), n - 2)
        local frac = pos - i
        local pick
        if dither then
          local threshold = (BAYER4[(y % 4) + 1][(x % 4) + 1] + 0.5) / 16
          pick = frac > threshold and stops[i + 2] or stops[i + 1]
        else
          pick = frac >= 0.5 and stops[i + 2] or stops[i + 1]
        end
        put(x, y, pick)
      end
    end
  end)
end

OPS.text = function(spr, op)
  return withCel(spr, op, function(_, put)
    local s = op.scale or 1
    local spacing = op.spacing or 1
    local cx, cy = op.x, op.y
    local missing = {}
    for i = 1, #op.text do
      local ch = op.text:sub(i, i)
      if ch == "\n" then
        cx = op.x
        cy = cy + (5 + (op.lineSpacing or 1)) * s
      else
        local glyph = FONT3x5[ch:upper()]
        if not glyph then missing[ch] = true; glyph = FONT3x5["?"] end
        for gy = 0, 4 do
          for gx = 0, 2 do
            local bit = gy * 3 + gx + 1
            if glyph:sub(bit, bit) == "1" then
              for sy = 0, s - 1 do
                for sx = 0, s - 1 do put(cx + gx * s + sx, cy + gy * s + sy) end
              end
            end
          end
        end
        cx = cx + (3 + spacing) * s
      end
    end
    local m = {}
    for ch in pairs(missing) do m[#m + 1] = ch end
    return { width = cx - op.x - spacing * s, missingGlyphs = #m > 0 and table.concat(m) or nil }
  end)
end

OPS.clear = function(spr, op)
  local layer = findLayer(spr, op.layer)
  local frames = frameList(spr, op)
  local total = 0
  for _, fn in ipairs(frames) do
    local frame = spr.frames[fn]
    if op.x == nil and op.width == nil then
      local cel = layer:cel(fn)
      if cel then assertEditable(layer); spr:deleteCel(cel) end
    else
      local img, cel = editableImage(spr, layer, frame)
      local tv = transparentValue(spr)
      local x0, y0 = op.x or 0, op.y or 0
      local x1 = op.width and (x0 + op.width - 1) or (img.width - 1)
      local y1 = op.height and (y0 + op.height - 1) or (img.height - 1)
      for y = math.max(0, y0), math.min(img.height - 1, y1) do
        for x = math.max(0, x0), math.min(img.width - 1, x1) do
          img:drawPixel(x, y, tv)
          total = total + 1
        end
      end
      commitImage(spr, layer, frame, img, cel)
    end
  end
  return { frames = #frames, pixels = total }
end

-- Recolor ------------------------------------------------------------------

local function targetCels(spr, op)
  local layers = op.layer and { findLayer(spr, op.layer) } or imageLayers(spr)
  local frames = (op.frame or op.frames or op.fromFrame or op.toFrame or op.tag) and frameList(spr, op) or nil
  local frameSet
  if frames then
    frameSet = {}
    for _, n in ipairs(frames) do frameSet[n] = true end
  end
  local cels = {}
  for _, layer in ipairs(layers) do
    if not layer.isGroup and not layer.isTilemap then
      for _, cel in ipairs(layer.cels) do
        if not frameSet or frameSet[cel.frameNumber] then cels[#cels + 1] = cel end
      end
    end
  end
  return cels
end

-- Apply fn(r,g,b,a) -> r,g,b,a to every opaque pixel of the targeted cels.
local function mapPixels(spr, op, fn)
  local n = 0
  for _, cel in ipairs(targetCels(spr, op)) do
    local img = cel.image:clone()
    local changed = false
    for it in img:pixels() do
      local v = it()
      local r, g, b, a = pixelRGBA(spr, v, img.colorMode)
      if a > 0 then
        local nr, ng, nb, na = fn(r, g, b, a)
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

OPS.replace_color = function(spr, op)
  local from = pixelValue(spr, op.fromColor)
  local to = pixelValue(spr, op.toColor)
  local tol = op.tolerance or 0
  local n = 0
  for _, cel in ipairs(targetCels(spr, op)) do
    local img = cel.image:clone()
    local changed = false
    for it in img:pixels() do
      if colorsClose(spr, it(), from, tol, img.colorMode) then
        it(to)
        n = n + 1
        changed = true
      end
    end
    if changed then cel.image = img end
  end
  return { pixels = n }
end

OPS.adjust_color = function(spr, op)
  local dh, ds, dl = op.hue or 0, (op.saturation or 0) / 100, (op.lightness or 0) / 100
  local function adjust(r, g, b, a)
    local h, s, l = rgbToHsl(r, g, b)
    local nr, ng, nb = hslToRgb(h + dh, clamp(s + ds, 0, 1), clamp(l + dl, 0, 1))
    return nr, ng, nb, a
  end
  if spr.colorMode == ColorMode.INDEXED then
    -- Adjusting an indexed sprite means adjusting its palette.
    local pal = spr.palettes[1]
    for i = 0, #pal - 1 do
      if i ~= spr.transparentColor then
        local c = pal:getColor(i)
        local r, g, b = adjust(c.red, c.green, c.blue, c.alpha)
        pal:setColor(i, Color { r = r, g = g, b = b, a = c.alpha })
      end
    end
    return { palette = true }
  end
  return { pixels = mapPixels(spr, op, adjust) }
end

OPS.quantize = function(spr, op)
  local list = {}
  if op.colors then
    for _, c in ipairs(op.colors) do
      local r, g, b, a = rgbaOf(spr, c)
      if a > 0 then list[#list + 1] = { r, g, b } end
    end
  else
    local pal = spr.palettes[1]
    for i = 0, #pal - 1 do
      local c = pal:getColor(i)
      if c.alpha > 0 then list[#list + 1] = { c.red, c.green, c.blue } end
    end
  end
  if #list == 0 then fail("quantize needs at least one opaque color") end
  local thr = op.alphaThreshold
  return {
    pixels = mapPixels(spr, op, function(r, g, b, a)
      local c = list[nearestInList(list, r, g, b)]
      local na = a
      if thr then na = a >= thr and 255 or 0 end
      return c[1], c[2], c[3], na
    end),
  }
end

OPS.outline = function(spr, op)
  local layer = findLayer(spr, op.layer)
  assertEditable(layer)
  local frames = frameList(spr, op)
  local color = op.color and pixelValue(spr, op.color) or nil
  local diagonal = op.matrix == "square"
  local total = 0
  for _, fn in ipairs(frames) do
    local frame = spr.frames[fn]
    if layer:cel(fn) then
      local img, cel = editableImage(spr, layer, frame)
      local w, h = img.width, img.height
      local tv = transparentValue(spr)
      local src = img:clone()
      local function opaque(x, y)
        if x < 0 or y < 0 or x >= w or y >= h then return false end
        local v = src:getPixel(x, y)
        local _, _, _, a = pixelRGBA(spr, v)
        return a > 0
      end
      for y = 0, h - 1 do
        for x = 0, w - 1 do
          local me = opaque(x, y)
          local n = opaque(x - 1, y) or opaque(x + 1, y) or opaque(x, y - 1) or opaque(x, y + 1)
          if diagonal and not n then
            n = opaque(x - 1, y - 1) or opaque(x + 1, y - 1) or opaque(x - 1, y + 1) or opaque(x + 1, y + 1)
          end
          if op.place == "inside" then
            local edge = not (opaque(x - 1, y) and opaque(x + 1, y) and opaque(x, y - 1) and opaque(x, y + 1))
            if me and edge then img:drawPixel(x, y, color or tv); total = total + 1 end
          elseif not me and n then
            img:drawPixel(x, y, color); total = total + 1
          end
        end
      end
      commitImage(spr, layer, frame, img, cel)
    end
  end
  return { pixels = total, frames = #frames }
end

-- Transform ------------------------------------------------------------------

local function transformCel(spr, op, mapFn)
  local layer = findLayer(spr, op.layer)
  local frames = frameList(spr, op)
  for _, fn in ipairs(frames) do
    local frame = spr.frames[fn]
    if layer:cel(fn) then
      local src, cel = editableImage(spr, layer, frame)
      local img = Image(spr.spec)
      local tv = transparentValue(spr)
      img:clear(tv)
      local w, h = src.width, src.height
      for it in src:pixels() do
        local v = it()
        if v ~= tv then
          local nx, ny = mapFn(it.x, it.y, w, h)
          if nx >= 0 and ny >= 0 and nx < w and ny < h then img:drawPixel(nx, ny, v) end
        end
      end
      commitImage(spr, layer, frame, img, cel)
    end
  end
  return { frames = #frames }
end

OPS.flip = function(spr, op)
  return transformCel(spr, op, function(x, y, w, h)
    if op.direction == "horizontal" then return w - 1 - x, y end
    return x, h - 1 - y
  end)
end

OPS.rotate = function(spr, op)
  local angle = op.angle % 360
  return transformCel(spr, op, function(x, y, w, h)
    -- rotate around the canvas center
    local cx, cy = (w - 1) / 2, (h - 1) / 2
    local dx, dy = x - cx, y - cy
    if angle == 90 then return round(cx - dy), round(cy + dx)
    elseif angle == 180 then return w - 1 - x, h - 1 - y
    elseif angle == 270 then return round(cx + dy), round(cy - dx) end
    return x, y
  end)
end

OPS.shift = function(spr, op)
  return transformCel(spr, op, function(x, y, w, h)
    local nx, ny = x + (op.dx or 0), y + (op.dy or 0)
    if op.wrap then nx, ny = nx % w, ny % h end
    return nx, ny
  end)
end

OPS.move = function(spr, op)
  local layer = findLayer(spr, op.layer)
  local moved = 0
  for _, fn in ipairs(frameList(spr, op)) do
    local cel = layer:cel(fn)
    if cel then
      cel.position = Point(cel.position.x + (op.dx or 0), cel.position.y + (op.dy or 0))
      moved = moved + 1
    end
  end
  return { cels = moved }
end

OPS.copy_region = function(spr, op)
  local srcLayer = findLayer(spr, op.layer)
  local srcFrame = findFrame(spr, op.frame)
  local dstLayer = op.toLayer and findLayer(spr, op.toLayer) or srcLayer
  local dstFrame = findFrame(spr, op.toFrame or op.frame)
  local src = editableImage(spr, srcLayer, srcFrame)
  local region = Image(op.width, op.height, spr.colorMode)
  region:clear(transparentValue(spr))
  region:drawImage(src, Point(-op.x, -op.y), 255, BlendMode.SRC)
  if op.cut then
    local img, cel = editableImage(spr, srcLayer, srcFrame)
    local tv = transparentValue(spr)
    for y = op.y, op.y + op.height - 1 do
      for x = op.x, op.x + op.width - 1 do
        if x >= 0 and y >= 0 and x < img.width and y < img.height then img:drawPixel(x, y, tv) end
      end
    end
    commitImage(spr, srcLayer, srcFrame, img, cel)
  end
  local dst, dcel = editableImage(spr, dstLayer, dstFrame)
  local tv = transparentValue(spr)
  for it in region:pixels() do
    local v = it()
    local x, y = op.toX + it.x, op.toY + it.y
    if (v ~= tv or op.opaque) and x >= 0 and y >= 0 and x < dst.width and y < dst.height then dst:drawPixel(x, y, v) end
  end
  commitImage(spr, dstLayer, dstFrame, dst, dcel)
  return {}
end

OPS.import_image = function(spr, op)
  local layer = findLayer(spr, op.layer)
  local frame = findFrame(spr, op.frame)
  local src = Image { fromFile = op.file }
  if not src then fail("could not load image '" .. op.file .. "'") end
  local img, cel = editableImage(spr, layer, frame)
  for it in src:pixels() do
    local r, g, b, a = pixelRGBA(spr, it(), src.colorMode)
    local x, y = (op.x or 0) + it.x, (op.y or 0) + it.y
    if a > 0 and x >= 0 and y >= 0 and x < img.width and y < img.height then
      img:drawPixel(x, y, encode(spr, r, g, b, a))
    end
  end
  commitImage(spr, layer, frame, img, cel)
  return { width = src.width, height = src.height }
end

-- Cels & animation ---------------------------------------------------------

OPS.copy_cel = function(spr, op)
  local fromLayer = findLayer(spr, op.fromLayer or op.layer)
  local toLayer = op.toLayer and findLayer(spr, op.toLayer) or fromLayer
  assertEditable(toLayer)
  local fromFrame = findFrame(spr, op.fromFrame)
  local last = op.toFrameEnd or op.toFrame
  findFrame(spr, op.toFrame); findFrame(spr, last)
  local cel = fromLayer:cel(fromFrame.frameNumber)
  local image = cel and cel.image:clone()
  local pos = cel and cel.position
  local opacity = cel and cel.opacity
  local n = 0
  for fn = op.toFrame, last do
    if not (toLayer == fromLayer and fn == fromFrame.frameNumber) then
      if image then
        local c = spr:newCel(toLayer, fn, image:clone(), pos)
        c.opacity = opacity
      else
        local existing = toLayer:cel(fn)
        if existing then spr:deleteCel(existing) end
      end
      n = n + 1
    end
  end
  return { cels = n, empty = image == nil or nil }
end

OPS.set_cel = function(spr, op)
  local layer = findLayer(spr, op.layer)
  local n = 0
  for _, fn in ipairs(frameList(spr, op)) do
    local cel = layer:cel(fn)
    if cel then
      if op.opacity then cel.opacity = op.opacity end
      if op.x or op.y then cel.position = Point(op.x or cel.position.x, op.y or cel.position.y) end
      if op.zIndex and cel.zIndex ~= nil then cel.zIndex = op.zIndex end
      n = n + 1
    end
  end
  return { cels = n }
end

OPS.tween = function(spr, op)
  local layer = findLayer(spr, op.layer)
  assertEditable(layer)
  findFrame(spr, op.fromFrame); findFrame(spr, op.toFrame)
  if op.toFrame <= op.fromFrame then fail("toFrame must be greater than fromFrame") end
  local ease = EASE[op.easing or "linear"]
  local base = layer:cel(op.fromFrame)
  if not base and not op.additive then fail("frame " .. op.fromFrame .. " has no cel on layer '" .. layer.name .. "' to tween") end
  local span = op.toFrame - op.fromFrame
  local bx, by = base and base.position.x or 0, base and base.position.y or 0
  for fn = op.fromFrame, op.toFrame do
    local t = ease((fn - op.fromFrame) / span)
    local ox, oy = round((op.dx or 0) * t), round((op.dy or 0) * t)
    local cel = layer:cel(fn)
    if op.additive then
      if cel then cel.position = Point(cel.position.x + ox, cel.position.y + oy) end
    else
      if fn ~= op.fromFrame then
        cel = spr:newCel(layer, fn, base.image:clone(), Point(bx + ox, by + oy))
      end
      if op.fromOpacity or op.toOpacity then
        local a0, a1 = op.fromOpacity or 255, op.toOpacity or 255
        cel.opacity = round(a0 + (a1 - a0) * t)
      end
    end
  end
  return { frames = span + 1 }
end

-- Layers -----------------------------------------------------------------

local function placeLayer(spr, layer, op)
  if op.parent then
    local parent = findLayer(spr, op.parent, true)
    if not parent.isGroup then fail("parent '" .. op.parent .. "' is not a group") end
    layer.parent = parent
  end
  if op.below then
    local ref = findLayer(spr, op.below, true)
    layer.parent = ref.parent
    layer.stackIndex = ref.stackIndex
  elseif op.above then
    local ref = findLayer(spr, op.above, true)
    layer.parent = ref.parent
    layer.stackIndex = ref.stackIndex + 1
  elseif op.toTop then
    layer.stackIndex = #layer.parent.layers
  elseif op.toBottom then
    layer.stackIndex = 1
  end
end

OPS.add_layer = function(spr, op)
  for _, e in ipairs(allLayers(spr)) do
    if e.layer.name == op.name and not op.allowDuplicate then fail("a layer named '" .. op.name .. "' already exists") end
  end
  local layer = op.group and spr:newGroup() or spr:newLayer()
  layer.name = op.name
  placeLayer(spr, layer, op)
  if op.opacity then layer.opacity = op.opacity end
  if op.blendMode then layer.blendMode = BLEND[op.blendMode] end
  if op.visible == false then layer.isVisible = false end
  return { path = pathOf(spr, layer) }
end

OPS.set_layer = function(spr, op)
  local layer = findLayer(spr, op.layer, true)
  if op.name then layer.name = op.name end
  if op.visible ~= nil then layer.isVisible = op.visible end
  if op.locked ~= nil then layer.isEditable = not op.locked end
  if op.opacity then layer.opacity = op.opacity end
  if op.blendMode then layer.blendMode = BLEND[op.blendMode] end
  return { path = pathOf(spr, layer) }
end

OPS.delete_layer = function(spr, op)
  local layer = findLayer(spr, op.layer, true)
  if layer.parent == spr and #spr.layers <= 1 then fail("cannot delete the only top-level layer") end
  spr:deleteLayer(layer)
  return {}
end

OPS.move_layer = function(spr, op)
  local layer = findLayer(spr, op.layer, true)
  placeLayer(spr, layer, op)
  return { path = pathOf(spr, layer) }
end

OPS.duplicate_layer = function(spr, op)
  local src = findLayer(spr, op.layer)
  local layer = spr:newLayer()
  layer.name = op.name or (src.name .. " copy")
  layer.parent = src.parent
  layer.stackIndex = src.stackIndex + 1
  layer.opacity = src.opacity
  layer.blendMode = src.blendMode
  layer.isVisible = src.isVisible
  for _, cel in ipairs(src.cels) do
    local c = spr:newCel(layer, cel.frameNumber, cel.image:clone(), cel.position)
    c.opacity = cel.opacity
  end
  return { path = pathOf(spr, layer) }
end

OPS.merge_down = function(spr, op)
  local layer = findLayer(spr, op.layer)
  if layer.stackIndex <= 1 then fail("layer '" .. layer.name .. "' has no layer below it to merge into") end
  app.activeSprite = spr
  app.activeLayer = layer
  app.command.MergeDownLayer()
  return {}
end

OPS.flatten = function(spr, op)
  spr:flatten()
  return {}
end

-- Frames -----------------------------------------------------------------

OPS.add_frames = function(spr, op)
  local count = op.count or 1
  local after = op.after or #spr.frames
  if after < 0 or after > #spr.frames then fail(string.format("`after` must be between 0 and %d", #spr.frames)) end
  local src = op.copyFrom
  if src then findFrame(spr, src) end
  local created = {}
  for i = 1, count do
    local at = after + i
    local f = spr:newEmptyFrame(at)
    if src then
      if src >= at then src = src + 1 end -- the source shifted right
      local srcF = spr.frames[src]
      f.duration = srcF.duration
      for _, l in ipairs(imageLayers(spr)) do
        local cel = l:cel(src)
        if cel then
          local c = spr:newCel(l, f, cel.image:clone(), cel.position)
          c.opacity = cel.opacity
        end
      end
    end
    if op.durationMs then f.duration = op.durationMs / 1000 end
    created[#created + 1] = at
  end
  return { frames = created }
end

OPS.delete_frames = function(spr, op)
  local from, to = op.from, op.to or op.from
  findFrame(spr, from); findFrame(spr, to)
  if to - from + 1 >= #spr.frames then fail("cannot delete every frame") end
  for n = to, from, -1 do spr:deleteFrame(n) end
  return {}
end

OPS.set_frame_duration = function(spr, op)
  local frames = frameList(spr, op, "all")
  for _, n in ipairs(frames) do spr.frames[n].duration = op.durationMs / 1000 end
  return { frames = #frames }
end

OPS.reverse_frames = function(spr, op)
  local a, b = op.from, op.to
  findFrame(spr, a); findFrame(spr, b)
  local layers = imageLayers(spr)
  local snapshot = {}
  for n = a, b do
    snapshot[n] = { duration = spr.frames[n].duration, cels = {} }
    for i, l in ipairs(layers) do
      local cel = l:cel(n)
      if cel then snapshot[n].cels[i] = { image = cel.image:clone(), position = cel.position, opacity = cel.opacity } end
    end
  end
  for n = a, b do
    local s = snapshot[a + b - n]
    spr.frames[n].duration = s.duration
    for i, l in ipairs(layers) do
      local existing = l:cel(n)
      if existing then spr:deleteCel(existing) end
      local c = s.cels[i]
      if c then
        local nc = spr:newCel(l, n, c.image, c.position)
        nc.opacity = c.opacity
      end
    end
  end
  return {}
end

OPS.add_tag = function(spr, op)
  findFrame(spr, op.from); findFrame(spr, op.to)
  if op.to < op.from then fail("tag `to` must be >= `from`") end
  for _, t in ipairs(spr.tags) do
    if t.name == op.name then fail("a tag named '" .. op.name .. "' already exists") end
  end
  local t = spr:newTag(op.from, op.to)
  t.name = op.name
  if op.direction then t.aniDir = ANIDIR[op.direction] end
  if op.repeats then t.repeats = op.repeats end
  return {}
end

OPS.set_tag = function(spr, op)
  local t = findTag(spr, op.tag)
  if op.name then t.name = op.name end
  if op.from then t.fromFrame = findFrame(spr, op.from) end
  if op.to then t.toFrame = findFrame(spr, op.to) end
  if op.direction then t.aniDir = ANIDIR[op.direction] end
  if op.repeats then t.repeats = op.repeats end
  return {}
end

OPS.delete_tag = function(spr, op)
  spr:deleteTag(findTag(spr, op.tag))
  return {}
end

-- Slices -----------------------------------------------------------------

OPS.add_slice = function(spr, op)
  local s = spr:newSlice(Rectangle(op.x, op.y, op.width, op.height))
  s.name = op.name
  if op.pivot then s.pivot = Point(op.pivot.x, op.pivot.y) end
  if op.center then s.center = Rectangle(op.center.x, op.center.y, op.center.width, op.center.height) end
  return {}
end

OPS.delete_slice = function(spr, op)
  spr:deleteSlice(findSlice(spr, op.name))
  return {}
end

-- Palette / sprite ---------------------------------------------------------

OPS.set_palette = function(spr, op)
  -- Capture visible colors first so we can remap RGB pixels if requested.
  local pal = Palette(#op.colors)
  for i, c in ipairs(op.colors) do
    local r, g, b, a = c.r or 0, c.g or 0, c.b or 0, c.a or 255
    if c.index ~= nil then r, g, b, a = paletteRGBA(spr, c.index) end
    pal:setColor(i - 1, Color { r = r, g = g, b = b, a = a })
  end
  if spr.colorMode == ColorMode.INDEXED and op.remap then
    -- Remap every indexed pixel to the nearest color of the new palette.
    local old = spr.palettes[1]
    local list = {}
    for i = 0, #pal - 1 do local c = pal:getColor(i); list[#list + 1] = { c.red, c.green, c.blue } end
    for _, cel in ipairs(targetCels(spr, {})) do
      local img = cel.image:clone()
      for it in img:pixels() do
        local v = it()
        if v ~= spr.transparentColor and v < #old then
          local c = old:getColor(v)
          it(nearestInList(list, c.red, c.green, c.blue) - 1)
        end
      end
      cel.image = img
    end
  end
  spr:setPalette(pal)
  local res = { size = #op.colors }
  if op.remap and spr.colorMode ~= ColorMode.INDEXED then
    res.remapped = OPS.quantize(spr, { colors = op.colors }).pixels
  end
  return res
end

OPS.set_palette_color = function(spr, op)
  local pal = spr.palettes[1]
  if op.index >= #pal then pal:resize(op.index + 1) end
  pal:setColor(op.index, toColorObject(spr, op.color))
  return {}
end

OPS.resize_canvas = function(spr, op)
  -- anchor: top-left | top | top-right | left | center | right | bottom-left | bottom | bottom-right
  local anchor = op.anchor or "center"
  local dw, dh = spr.width - op.width, spr.height - op.height
  local x, y = math.floor(dw / 2), math.floor(dh / 2)
  if anchor:find("left") then x = 0 elseif anchor:find("right") then x = dw end
  if anchor:find("^top") then y = 0 elseif anchor:find("^bottom") then y = dh end
  spr:crop(x, y, op.width, op.height)
  return { width = spr.width, height = spr.height }
end

OPS.crop = function(spr, op)
  spr:crop(op.x, op.y, op.width, op.height)
  return { width = spr.width, height = spr.height }
end

OPS.scale = function(spr, op)
  local w = op.width or round(spr.width * op.factor)
  local h = op.height or round(spr.height * op.factor)
  app.activeSprite = spr
  app.command.SpriteSize { ui = false, width = w, height = h, lockRatio = false, method = "nearest" }
  return { width = spr.width, height = spr.height }
end

OPS.set_color_mode = function(spr, op)
  app.activeSprite = spr
  app.command.ChangePixelFormat { ui = false, format = op.mode, dithering = op.dithering or "none" }
  return { colorMode = COLOR_MODE_NAME[spr.colorMode] }
end

---------------------------------------------------------------------------
-- Commands
---------------------------------------------------------------------------

local CMD = {}
M.CMD = CMD

-- In live mode `ctx.live` is true: sprites come from the editor, edits are
-- wrapped in an undoable transaction and nothing is written unless asked.
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
  return results
end

local function runOps(spr, ops, ctx, label)
  if ctx.live then
    local results
    app.transaction(label or "MCP edit", function() results = applyOps(spr, ops) end)
    app.refresh()
    return results
  end
  return applyOps(spr, ops)
end

CMD.create = function(req, ctx)
  local spr = Sprite(req.width, req.height, COLOR_MODE[req.colorMode or "rgb"])
  app.activeSprite = spr
  if req.palette then OPS.set_palette(spr, { colors = req.palette }) end
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
  return { sprite = spriteInfo(spr, { paletteColors = req.paletteColors }) }
end

CMD.edit = function(req, ctx)
  local spr = getSprite(req, ctx)
  local results = runOps(spr, req.ops, ctx, req.label)
  if req.output then
    spr:saveCopyAs(req.output)
  elseif ctx.live and req.save then
    spr:saveAs(spr.filename)
  end
  return { sprite = spriteInfo(spr, { paletteColors = false }), results = results }
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
  return { sprite = spriteInfo(spr, { paletteColors = false }) }
end

CMD.redo = function(req, ctx)
  local spr = getSprite(req, ctx)
  for _ = 1, req.steps or 1 do app.command.Redo() end
  app.refresh()
  return { sprite = spriteInfo(spr, { paletteColors = false }) }
end

CMD.list_open = function(req, ctx)
  local out = {}
  for _, s in ipairs(app.sprites) do
    out[#out + 1] = { file = s.filename, width = s.width, height = s.height, active = s == app.activeSprite }
  end
  return { sprites = out, version = tostring(app.version) }
end

local MAP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&*+=?@"

CMD.read_pixels = function(req, ctx)
  local spr = getSprite(req, ctx)
  local img = renderFrame(spr, req.frame, req.layer)
  local x0, y0 = req.x or 0, req.y or 0
  local w = math.min(req.width or spr.width, spr.width - x0)
  local h = math.min(req.height or spr.height, spr.height - y0)
  if x0 < 0 or y0 < 0 or w <= 0 or h <= 0 then fail("region is outside the canvas") end
  local max = req.maxPixels or 4096
  if w * h > max then
    fail(string.format("region %dx%d is too large to read as text (max %d pixels); pass a smaller x/y/width/height region or use aseprite_preview", w, h, max))
  end
  local legend, charOf, nextChar = {}, {}, 1
  local rows = {}
  for y = y0, y0 + h - 1 do
    local row = {}
    for x = x0, x0 + w - 1 do
      local v = img:getPixel(x, y)
      local a = pc.rgbaA(v)
      if a == 0 then
        row[#row + 1] = "."
      else
        local key = hex(pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), a)
        local ch = charOf[key]
        if not ch then
          if nextChar > #MAP_CHARS then fail("region uses more than " .. #MAP_CHARS .. " colors; read a smaller region or use aseprite_preview") end
          ch = MAP_CHARS:sub(nextChar, nextChar)
          nextChar = nextChar + 1
          charOf[key] = ch
          legend[ch] = key
        end
        row[#row + 1] = ch
      end
    end
    rows[#rows + 1] = table.concat(row)
  end
  return { x = x0, y = y0, width = w, height = h, rows = rows, legend = legend, colorCount = nextChar - 1 }
end

local function fillBackground(out, bg, scale)
  if bg == "transparent" then return end
  if bg == nil or bg == "checker" then
    local cs = math.max(4, scale * 2)
    for y = 0, out.height - 1 do
      for x = 0, out.width - 1 do
        local dark = ((x // cs) + (y // cs)) % 2 == 0
        out:drawPixel(x, y, dark and pc.rgba(204, 204, 204, 255) or pc.rgba(255, 255, 255, 255))
      end
    end
  else
    out:clear(pc.rgba(bg.r, bg.g, bg.b, 255))
  end
end

CMD.preview = function(req, ctx)
  local spr = getSprite(req, ctx)
  local frames = frameList(spr, req)
  local n = #frames
  local cols = req.columns or n
  if cols > n then cols = n end
  local rows = math.ceil(n / cols)
  local gap = n > 1 and 1 or 0
  local W = spr.width * cols + gap * (cols - 1)
  local H = spr.height * rows + gap * (rows - 1)
  local scale = req.scale or math.max(1, math.floor((req.targetSize or 384) / math.max(W, H)))
  if W * scale > 4096 or H * scale > 4096 then scale = math.max(1, math.floor(4096 / math.max(W, H))) end

  local sheet = Image(W, H, ColorMode.RGB)
  sheet:clear(0)
  for i, fn in ipairs(frames) do
    local col, row = (i - 1) % cols, (i - 1) // cols
    local frameImg = renderFrame(spr, fn, req.layer)
    if req.onion and fn > 1 then
      local prev = renderFrame(spr, fn - 1, req.layer)
      local ghost = Image(spr.width, spr.height, ColorMode.RGB)
      ghost:clear(0)
      ghost:drawImage(prev, Point(0, 0), 70)
      ghost:drawImage(frameImg, Point(0, 0))
      frameImg = ghost
    end
    sheet:drawImage(frameImg, Point(col * (spr.width + gap), row * (spr.height + gap)))
  end
  local big = sheet:clone()
  big:resize(W * scale, H * scale)
  local out = Image(big.width, big.height, ColorMode.RGB)
  out:clear(0)
  fillBackground(out, req.background, scale)
  if req.grid and scale >= 4 then
    local gc = pc.rgba(0, 0, 0, 40)
    for y = 0, out.height - 1 do
      for x = 0, out.width - 1 do
        if x % scale == 0 or y % scale == 0 then out:drawPixel(x, y, gc) end
      end
    end
  end
  out:drawImage(big, Point(0, 0))
  if gap > 0 and req.background ~= "transparent" then
    local sep = pc.rgba(255, 0, 255, 255)
    for c = 1, cols - 1 do
      local gx = (c * (spr.width + gap) - 1) * scale
      for x = gx, gx + scale - 1 do for y = 0, out.height - 1 do out:drawPixel(x, y, sep) end end
    end
    for r = 1, rows - 1 do
      local gy = (r * (spr.height + gap) - 1) * scale
      for y = gy, gy + scale - 1 do for x = 0, out.width - 1 do out:drawPixel(x, y, sep) end end
    end
  end
  out:saveAs(req.output)
  return { frames = frames, scale = scale, width = out.width, height = out.height, columns = cols }
end

CMD.compare = function(req, ctx)
  local spr = getSprite(req, ctx)
  local a = renderFrame(spr, req.frameA, req.layer)
  local b
  if req.other then
    local other = app.open(req.other)
    if not other then fail("could not open '" .. req.other .. "'") end
    if other.width ~= spr.width or other.height ~= spr.height then
      fail(string.format("sprites differ in size (%dx%d vs %dx%d)", spr.width, spr.height, other.width, other.height))
    end
    b = renderFrame(other, req.frameB or req.frameA, req.layer)
    other:close()
    app.activeSprite = spr
  else
    b = renderFrame(spr, req.frameB, req.layer)
  end
  local diff = Image(spr.width, spr.height, ColorMode.RGB)
  diff:clear(0)
  local count, x0, y0, x1, y1 = 0
  for y = 0, spr.height - 1 do
    for x = 0, spr.width - 1 do
      local va, vb = a:getPixel(x, y), b:getPixel(x, y)
      if va ~= vb and not (pc.rgbaA(va) == 0 and pc.rgbaA(vb) == 0) then
        count = count + 1
        diff:drawPixel(x, y, pc.rgba(255, 0, 64, 255))
        if not x0 or x < x0 then x0 = x end
        if not x1 or x > x1 then x1 = x end
        if not y0 or y < y0 then y0 = y end
        if not y1 or y > y1 then y1 = y end
      elseif pc.rgbaA(va) > 0 then
        local g = round((pc.rgbaR(va) + pc.rgbaG(va) + pc.rgbaB(va)) / 3 * 0.5 + 64)
        diff:drawPixel(x, y, pc.rgba(g, g, g, 255))
      end
    end
  end
  local res = {
    differentPixels = count,
    totalPixels = spr.width * spr.height,
    identical = count == 0,
    bounds = x0 and { x = x0, y = y0, width = x1 - x0 + 1, height = y1 - y0 + 1 } or nil,
  }
  if req.output then
    local scale = math.max(1, math.floor((req.targetSize or 256) / math.max(spr.width, spr.height)))
    local big = Image(spr.width * 3 + 2, spr.height, ColorMode.RGB)
    big:clear(pc.rgba(255, 255, 255, 255))
    big:drawImage(a, Point(0, 0))
    big:drawImage(b, Point(spr.width + 1, 0))
    big:drawImage(diff, Point(2 * spr.width + 2, 0))
    big:resize(big.width * scale, big.height * scale)
    big:saveAs(req.output)
    res.scale = scale
  end
  return res
end

CMD.validate = function(req, ctx)
  local spr = getSprite(req, ctx)
  local rules = req.rules or {}
  local issues = {}
  local function issue(severity, code, message, data)
    issues[#issues + 1] = { severity = severity, code = code, message = message, data = data }
  end

  local pal = spr.palettes[1]
  local palSet = {}
  for i = 0, #pal - 1 do palSet[colorHex(pal:getColor(i))] = true end
  if rules.palette then
    palSet = {}
    for _, c in ipairs(rules.palette) do palSet[hex(c.r, c.g, c.b, c.a)] = true end
  end

  local used, usedCount = {}, 0
  local semi, offPalette, offPaletteSamples = 0, 0, {}
  local strays, strayCount = {}, 0
  local frameBounds = {}
  for i = 1, #spr.frames do
    local img = renderFrame(spr, i)
    frameBounds[i] = contentBounds(img)
    if not frameBounds[i] then issue("warning", "empty_frame", string.format("frame %d is completely transparent", i), { frame = i }) end
    for it in img:pixels() do
      local v = it()
      local a = pc.rgbaA(v)
      if a > 0 then
        local key = hex(pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), a)
        if not used[key] then used[key] = 0; usedCount = usedCount + 1 end
        used[key] = used[key] + 1
        if a < 255 then semi = semi + 1 end
        if (rules.paletteOnly or rules.palette) and not palSet[key] then
          offPalette = offPalette + 1
          if #offPaletteSamples < 8 then offPaletteSamples[#offPaletteSamples + 1] = { frame = i, x = it.x, y = it.y, color = key } end
        end
        if rules.strayPixels ~= false then
          local x, y = it.x, it.y
          local lonely = true
          for dy = -1, 1 do
            for dx = -1, 1 do
              if lonely and not (dx == 0 and dy == 0) then
                local nx, ny = x + dx, y + dy
                if nx >= 0 and ny >= 0 and nx < img.width and ny < img.height and pc.rgbaA(img:getPixel(nx, ny)) > 0 then lonely = false end
              end
            end
          end
          if lonely then
            strayCount = strayCount + 1
            if #strays < 12 then strays[#strays + 1] = { frame = i, x = x, y = y } end
          end
        end
      end
    end
  end

  if rules.maxColors and usedCount > rules.maxColors then
    issue("error", "too_many_colors", string.format("sprite uses %d distinct colors (max %d)", usedCount, rules.maxColors), { used = usedCount })
  end
  if semi > 0 and not rules.allowSemiTransparency then
    issue("warning", "semi_transparent", string.format("%d pixels are semi-transparent (alpha 1-254); pixel art usually wants hard alpha", semi), { count = semi })
  end
  if offPalette > 0 then
    issue("error", "off_palette", string.format("%d pixels use colors outside the palette; use the quantize op to fix", offPalette), { samples = offPaletteSamples })
  end
  if strayCount > 0 then
    issue("info", "stray_pixels", string.format("%d isolated single pixels (no opaque neighbours)", strayCount), { samples = strays })
  end
  if rules.width and spr.width ~= rules.width or rules.height and spr.height ~= rules.height then
    issue("error", "wrong_size", string.format("sprite is %dx%d, expected %sx%s", spr.width, spr.height, tostring(rules.width or spr.width), tostring(rules.height or spr.height)))
  end
  if rules.maxFrames and #spr.frames > rules.maxFrames then
    issue("error", "too_many_frames", string.format("%d frames (max %d)", #spr.frames, rules.maxFrames))
  end
  if rules.colorMode and COLOR_MODE_NAME[spr.colorMode] ~= rules.colorMode then
    issue("error", "wrong_color_mode", string.format("color mode is %s, expected %s", COLOR_MODE_NAME[spr.colorMode], rules.colorMode))
  end

  for _, e in ipairs(allLayers(spr)) do
    if not e.layer.isGroup then
      for _, cel in ipairs(e.layer.cels) do
        local b = cel.bounds
        local okS, content = pcall(function() return cel.image:shrinkBounds(transparentValue(spr)) end)
        if okS and not content.isEmpty then
          b = Rectangle(cel.position.x + content.x, cel.position.y + content.y, content.width, content.height)
        end
        if b.x < 0 or b.y < 0 or b.x + b.width > spr.width or b.y + b.height > spr.height then
          issue("warning", "cel_out_of_bounds", string.format("layer '%s' frame %d has content outside the canvas", e.path, cel.frameNumber), { layer = e.path, frame = cel.frameNumber })
        end
      end
    end
  end

  -- Animation audit
  if #spr.tags > 0 then
    local covered = {}
    for _, t in ipairs(spr.tags) do
      for n = t.fromFrame.frameNumber, t.toFrame.frameNumber do covered[n] = true end
      -- baseline jitter: the lowest opaque row should usually stay put within a cycle
      local bottoms, minB, maxB = {}, math.huge, -math.huge
      for n = t.fromFrame.frameNumber, t.toFrame.frameNumber do
        local fb = frameBounds[n]
        if fb then
          local bottom = fb.y + fb.height - 1
          bottoms[#bottoms + 1] = bottom
          minB, maxB = math.min(minB, bottom), math.max(maxB, bottom)
        end
      end
      if #bottoms > 1 and maxB - minB > (rules.baselineTolerance or 1) then
        issue("info", "baseline_jitter", string.format("tag '%s': lowest opaque row moves by %d px across frames (feet may slide)", t.name, maxB - minB), { tag = t.name, bottoms = bottoms })
      end
      -- identical consecutive frames
      for n = t.fromFrame.frameNumber, t.toFrame.frameNumber - 1 do
        local x, y = renderFrame(spr, n), renderFrame(spr, n + 1)
        if x:isEqual(y) then
          issue("info", "duplicate_frames", string.format("tag '%s': frames %d and %d are identical", t.name, n, n + 1), { tag = t.name, frames = { n, n + 1 } })
        end
      end
    end
    local missing = {}
    for n = 1, #spr.frames do if not covered[n] then missing[#missing + 1] = n end end
    if #missing > 0 then issue("info", "untagged_frames", "frames " .. ranges(missing) .. " are not part of any tag", { frames = missing }) end
  elseif rules.requireTags then
    issue("error", "no_tags", "sprite has no animation tags")
  end

  local top = {}
  for k, v in pairs(used) do top[#top + 1] = { color = k, pixels = v } end
  table.sort(top, function(x, y) return x.pixels > y.pixels end)
  while #top > (req.topColors or 16) do table.remove(top) end

  local errors = 0
  for _, i in ipairs(issues) do if i.severity == "error" then errors = errors + 1 end end
  return { valid = errors == 0, colorsUsed = usedCount, topColors = top, frameBounds = frameBounds, issues = issues }
end

-- Import a PNG/JPG (e.g. AI-generated or a reference) as clean pixel art.
CMD.import = function(req, ctx)
  local src = Image { fromFile = req.file }
  if not src then fail("could not load image '" .. req.file .. "'") end
  local spr0 = { colorMode = src.colorMode, transparentColor = 0, palettes = { Palette(1) } }
  -- Convert to RGBA working image.
  local rgba = Image(src.width, src.height, ColorMode.RGB)
  if src.colorMode == ColorMode.RGB then
    rgba:drawImage(src, Point(0, 0), 255, BlendMode.SRC)
  else
    for it in src:pixels() do
      local r, g, b, a = pixelRGBA(spr0, it(), src.colorMode)
      rgba:drawPixel(it.x, it.y, pc.rgba(r, g, b, a))
    end
  end
  src = rgba

  -- Target size
  local tw, th = req.width, req.height
  if req.pixelSize then
    tw, th = math.floor(src.width / req.pixelSize), math.floor(src.height / req.pixelSize)
  elseif tw and not th then
    th = round(src.height * tw / src.width)
  elseif th and not tw then
    tw = round(src.width * th / src.height)
  end
  tw, th = tw or src.width, th or src.height
  if tw < 1 or th < 1 then fail("target size is too small") end

  local thr = req.alphaThreshold or 128
  local out = Image(tw, th, ColorMode.RGB)
  out:clear(0)
  local bx, by = src.width / tw, src.height / th
  for ty = 0, th - 1 do
    for tx = 0, tw - 1 do
      local sx0, sy0 = math.floor(tx * bx), math.floor(ty * by)
      local sx1, sy1 = math.max(sx0, math.floor((tx + 1) * bx) - 1), math.max(sy0, math.floor((ty + 1) * by) - 1)
      local v
      if req.method == "nearest" or (sx0 == sx1 and sy0 == sy1) then
        v = src:getPixel(math.min(src.width - 1, math.floor((tx + 0.5) * bx)), math.min(src.height - 1, math.floor((ty + 0.5) * by)))
        if pc.rgbaA(v) < thr then v = 0 end
      else
        -- "mode": the most common opaque color of the block (crisp for upscaled pixel art)
        local counts, best, bestN, opaque, total = {}, 0, 0, 0, 0
        for sy = sy0, sy1 do
          for sx = sx0, sx1 do
            local p = src:getPixel(sx, sy)
            total = total + 1
            if pc.rgbaA(p) >= thr then
              opaque = opaque + 1
              -- bucket by 4 bits per channel to merge JPEG/AI noise
              local key = (pc.rgbaR(p) // 16) * 256 + (pc.rgbaG(p) // 16) * 16 + (pc.rgbaB(p) // 16)
              local e = counts[key]
              if not e then e = { n = 0, r = 0, g = 0, b = 0 }; counts[key] = e end
              e.n = e.n + 1
              e.r, e.g, e.b = e.r + pc.rgbaR(p), e.g + pc.rgbaG(p), e.b + pc.rgbaB(p)
              if e.n > bestN then bestN, best = e.n, key end
            end
          end
        end
        if opaque * 2 >= total and bestN > 0 then
          local e = counts[best]
          v = pc.rgba(round(e.r / e.n), round(e.g / e.n), round(e.b / e.n), 255)
        else
          v = 0
        end
      end
      if v ~= 0 then v = pc.rgba(pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), 255) end
      out:drawPixel(tx, ty, v)
    end
  end

  -- Background removal
  local removed = 0
  if req.removeBackground then
    local tol = req.backgroundTolerance or 24
    local function close(p, ref)
      return pc.rgbaA(p) > 0 and math.abs(pc.rgbaR(p) - pc.rgbaR(ref)) <= tol and math.abs(pc.rgbaG(p) - pc.rgbaG(ref)) <= tol and math.abs(pc.rgbaB(p) - pc.rgbaB(ref)) <= tol
    end
    local refs = {}
    if req.removeBackground == "corners" then
      for _, c in ipairs({ { 0, 0 }, { tw - 1, 0 }, { 0, th - 1 }, { tw - 1, th - 1 } }) do
        refs[#refs + 1] = { c[1], c[2], out:getPixel(c[1], c[2]) }
      end
    else
      local c = req.removeBackground
      local ref = pc.rgba(c.r, c.g, c.b, 255)
      for y = 0, th - 1 do
        for x = 0, tw - 1 do
          if close(out:getPixel(x, y), ref) then out:drawPixel(x, y, 0); removed = removed + 1 end
        end
      end
    end
    for _, r in ipairs(refs) do
      if pc.rgbaA(r[3]) > 0 then
        flood(out, r[1], r[2], function(p) return close(p, r[3]) end, function(x, y) out:drawPixel(x, y, 0); removed = removed + 1 end, false)
      end
    end
  end

  -- Palette quantization
  if req.palette then
    local list = {}
    for _, c in ipairs(req.palette) do if (c.a or 255) > 0 then list[#list + 1] = { c.r, c.g, c.b } end end
    for it in out:pixels() do
      local p = it()
      if pc.rgbaA(p) > 0 then
        local c = list[nearestInList(list, pc.rgbaR(p), pc.rgbaG(p), pc.rgbaB(p))]
        it(pc.rgba(c[1], c[2], c[3], 255))
      end
    end
  end

  local spr
  if req.input then
    spr = getSprite(req, ctx)
    local apply = function()
      local layer = spr:newLayer()
      layer.name = req.layerName or "Imported"
      local frame = findFrame(spr, req.frame or 1)
      local img = Image(spr.spec)
      img:clear(transparentValue(spr))
      for it in out:pixels() do
        local p = it()
        local x, y = (req.x or 0) + it.x, (req.y or 0) + it.y
        if pc.rgbaA(p) > 0 and x >= 0 and y >= 0 and x < spr.width and y < spr.height then
          img:drawPixel(x, y, encode(spr, pc.rgbaR(p), pc.rgbaG(p), pc.rgbaB(p), 255))
        end
      end
      spr:newCel(layer, frame, img, Point(0, 0))
    end
    if ctx.live then app.transaction("MCP import", apply) else apply() end
  else
    spr = Sprite(tw, th, ColorMode.RGB)
    app.activeSprite = spr
    spr.layers[1].name = req.layerName or "Imported"
    spr.cels[1].image = out
    if req.palette then OPS.set_palette(spr, { colors = req.palette }) end
    if req.colorMode == "indexed" then
      app.command.ChangePixelFormat { ui = false, format = "indexed", dithering = "none" }
    end
  end
  if req.output then spr:saveCopyAs(req.output) end
  return { sprite = spriteInfo(spr, { paletteColors = false }), removedBackgroundPixels = removed, sourceWidth = rgba.width, sourceHeight = rgba.height }
end

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
-- Dispatcher
---------------------------------------------------------------------------

function M.run(req, ctx)
  ctx = ctx or {}
  local fn = CMD[req.cmd]
  if not fn then fail("unknown command '" .. tostring(req.cmd) .. "'") end
  return fn(req, ctx)
end

-- Aseprite's json.decode returns userdata objects whose numbers are all
-- floats (2 -> 2.0). Several API calls misbehave with floats (e.g.
-- image:drawPixel(x, y, 2.0) stores index 1), so convert the request into
-- plain tables with integer numbers wherever the value is integral.
-- Note: pairs() yields nothing for decoded arrays, so arrays use # / indexing.
local function plain(v)
  local t = type(v)
  if t == "number" then return math.tointeger(v) or v end
  if t == "userdata" or t == "table" then
    -- Objects iterate with pairs(); decoded arrays yield nothing there (and
    -- # on an object counts its keys), so fall back to # only when pairs()
    -- produced no entries.
    local out, any = {}, false
    for k, x in pairs(v) do
      out[k] = plain(x)
      any = true
    end
    if not any then
      for i = 1, #v do out[i] = plain(v[i]) end
    end
    return out
  end
  return v
end
M.plain = plain

-- Run a request and always return a JSON-encodable envelope.
function M.handle(req, ctx)
  local okPlain, converted = pcall(plain, req)
  if okPlain then req = converted end
  local ok, res = pcall(M.run, req, ctx)
  if ok then return { ok = true, data = res } end
  return { ok = false, error = tostring(res) }
end

M.version = "1.0.0"

return M
