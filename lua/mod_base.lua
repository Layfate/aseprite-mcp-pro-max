-- Documents, layers, cels, frames, tags, slices and the original drawing ops.
return function(M, H)
  local OPS, QUERIES = M.OPS, M.QUERIES
  local fail, round, pc = H.fail, H.round, H.pc
  local findLayer, findFrame, findTag, findSlice, frameList = H.findLayer, H.findFrame, H.findTag, H.findSlice, H.frameList
  local editableImage, commitImage, withCel, pixelValue = H.editableImage, H.commitImage, H.withCel, H.pixelValue
  local transparentValue, pathOf, allLayers, imageLayers = H.transparentValue, H.pathOf, H.allLayers, H.imageLayers
  local pixelRGBA, encode, assertEditable = H.pixelRGBA, H.encode, H.assertEditable
  local BLEND, ANIDIR = H.BLEND, H.ANIDIR

  -------------------------------------------------------------------------
  -- Drawing (original set)
  -------------------------------------------------------------------------

  OPS["draw.pixels"] = function(spr, op)
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

  -- Shared by pixel_map / index_map / pattern stamping.
  local function drawGrid(spr, layer, frame, rows, valueOf, ox, oy, opts)
    local img, cel = editableImage(spr, layer, frame)
    local n, clipped = 0, 0
    local mask = opts and opts.mask
    for row, s in ipairs(rows) do
      for col = 1, #s do
        local ch = s:sub(col, col)
        if ch ~= "." and ch ~= " " then
          local v = valueOf(ch, row, col)
          local x, y = ox + col - 1, oy + row - 1
          if x >= 0 and y >= 0 and x < img.width and y < img.height and (not mask or H.Mask.get(mask, x, y) > 0) then
            img:drawPixel(x, y, v)
            n = n + 1
          else
            clipped = clipped + 1
          end
        end
      end
    end
    commitImage(spr, layer, frame, img, cel)
    return n, clipped
  end
  H.drawGrid = drawGrid

  OPS["draw.pixel_map"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    local values = {}
    for ch, c in pairs(op.legend) do values[ch] = pixelValue(spr, c) end
    local mask = op.inSelection and H.selection(spr) or nil
    local total, clippedTotal = 0, 0
    for _, fnum in ipairs(frameList(spr, op)) do
      local n, clipped = drawGrid(spr, layer, findFrame(spr, fnum), op.rows, function(ch, row, col)
        local v = values[ch]
        if v == nil then fail(string.format("row %d col %d: character '%s' is not in the legend", row, col, ch)) end
        return v
      end, op.x or 0, op.y or 0, { mask = mask })
      total, clippedTotal = total + n, clippedTotal + clipped
    end
    return { pixels = total, clipped = clippedTotal > 0 and clippedTotal or nil }
  end

  OPS["draw.line"] = function(spr, op)
    return withCel(spr, op, function(_, put)
      local pts = op.points or { { x = op.x1, y = op.y1 }, { x = op.x2, y = op.y2 } }
      local seen = {}
      local function plot(x, y)
        local k = y * 65536 + x
        if not seen[k] then seen[k] = true; put(x, y) end
      end
      for i = 1, #pts - 1 do H.line(plot, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) end
      if op.closed and #pts > 2 then H.line(plot, pts[#pts].x, pts[#pts].y, pts[1].x, pts[1].y) end
    end)
  end

  OPS["draw.rect"] = function(spr, op)
    return withCel(spr, op, function(_, put)
      local x0, y0, x1, y1 = op.x, op.y, op.x + op.width - 1, op.y + op.height - 1
      for y = y0, y1 do
        for x = x0, x1 do
          if op.filled or x == x0 or x == x1 or y == y0 or y == y1 then put(x, y) end
        end
      end
    end)
  end

  OPS["draw.ellipse"] = function(spr, op)
    return withCel(spr, op, function(_, put)
      local seen = {}
      local function plot(x, y)
        local k = y * 65536 + x
        if not seen[k] then seen[k] = true; put(x, y) end
      end
      H.ellipse(function(xa, xb, y)
        if op.filled then
          for x = math.min(xa, xb), math.max(xa, xb) do plot(x, y) end
        else
          plot(xa, y); plot(xb, y)
        end
      end, op.x, op.y, op.x + op.width - 1, op.y + op.height - 1)
    end)
  end

  OPS["draw.fill"] = function(spr, op)
    local tol = op.tolerance or 0
    return withCel(spr, op, function(img, put)
      local w, h = img.width, img.height
      if op.x < 0 or op.y < 0 or op.x >= w or op.y >= h then
        fail(string.format("fill seed (%d,%d) is outside the %dx%d canvas", op.x, op.y, w, h))
      end
      local target = img:getPixel(op.x, op.y)
      local v = pixelValue(spr, op.color)
      local function match(p) return H.colorsClose(spr, p, target, tol) end
      if op.contiguous == false then
        for y = 0, h - 1 do
          for x = 0, w - 1 do
            if match(img:getPixel(x, y)) then put(x, y) end
          end
        end
        return
      end
      if target == v and tol == 0 then return end
      H.flood(img, op.x, op.y, match, put, op.diagonal)
    end)
  end

  OPS["draw.gradient"] = function(spr, op)
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
            local threshold = (H.BAYER4[(y % 4) + 1][(x % 4) + 1] + 0.5) / 16
            pick = frac > threshold and stops[i + 2] or stops[i + 1]
          else
            pick = frac >= 0.5 and stops[i + 2] or stops[i + 1]
          end
          put(x, y, pick)
        end
      end
    end)
  end

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
  H.FONT3x5 = FONT3x5

  OPS["draw.text"] = function(spr, op)
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

  OPS["draw.erase"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    local frames = frameList(spr, op)
    local total = 0
    for _, fn in ipairs(frames) do
      local frame = spr.frames[fn]
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
    return { frames = #frames, pixels = total }
  end

  OPS["draw.outline"] = function(spr, op)
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
          local _, _, _, a = pixelRGBA(spr, src:getPixel(x, y))
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

  -------------------------------------------------------------------------
  -- Recolor (original set)
  -------------------------------------------------------------------------

  OPS["pal.replace_color"] = function(spr, op)
    local from = pixelValue(spr, op.fromColor)
    local to = pixelValue(spr, op.toColor)
    local tol = op.tolerance or 0
    local n = 0
    local mask = op.inSelection and H.selection(spr) or nil
    for _, cel in ipairs(H.targetCels(spr, op)) do
      local img = cel.image:clone()
      local changed = false
      for it in img:pixels() do
        if H.colorsClose(spr, it(), from, tol, img.colorMode) and (not mask or H.Mask.get(mask, it.x + cel.position.x, it.y + cel.position.y) > 0) then
          it(to)
          n = n + 1
          changed = true
        end
      end
      if changed then cel.image = img end
    end
    return { pixels = n }
  end

  OPS["pal.adjust"] = function(spr, op)
    local dh, ds, dl = op.hue or 0, (op.saturation or 0) / 100, (op.lightness or 0) / 100
    local function adjust(r, g, b, a)
      local h, s, l = H.rgbToHsl(r, g, b)
      local nr, ng, nb = H.hslToRgb(h + dh, H.clamp(s + ds, 0, 1), H.clamp(l + dl, 0, 1))
      return nr, ng, nb, a
    end
    if spr.colorMode == ColorMode.INDEXED then
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
    return { pixels = H.mapPixels(spr, op, adjust) }
  end

  local function colorList(spr, colors)
    local list = {}
    if colors then
      for _, c in ipairs(colors) do
        local r, g, b, a = H.rgbaOf(spr, c)
        if a > 0 then list[#list + 1] = { r, g, b } end
      end
    else
      local pal = spr.palettes[1]
      for i = 0, #pal - 1 do
        local c = pal:getColor(i)
        if c.alpha > 0 and not (spr.colorMode == ColorMode.INDEXED and i == spr.transparentColor) then list[#list + 1] = { c.red, c.green, c.blue } end
      end
    end
    if #list == 0 then fail("need at least one opaque color") end
    return list
  end
  H.colorList = colorList

  OPS["pal.quantize"] = function(spr, op)
    local list = colorList(spr, op.colors)
    local thr = op.alphaThreshold
    return {
      pixels = H.mapPixels(spr, op, function(r, g, b, a)
        local c = list[H.nearestInList(list, r, g, b)]
        local na = a
        if thr then na = a >= thr and 255 or 0 end
        return c[1], c[2], c[3], na
      end),
    }
  end

  -------------------------------------------------------------------------
  -- Transforms (original set)
  -------------------------------------------------------------------------

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
            if nx and nx >= 0 and ny >= 0 and nx < w and ny < h then img:drawPixel(nx, ny, v) end
          end
        end
        commitImage(spr, layer, frame, img, cel)
      end
    end
    return { frames = #frames }
  end
  H.transformCel = transformCel

  OPS["xf.flip"] = function(spr, op)
    return transformCel(spr, op, function(x, y, w, h)
      if op.direction == "horizontal" then return w - 1 - x, y end
      return x, h - 1 - y
    end)
  end

  OPS["xf.rotate"] = function(spr, op)
    local angle = op.angle % 360
    return transformCel(spr, op, function(x, y, w, h)
      local cx, cy = (w - 1) / 2, (h - 1) / 2
      local dx, dy = x - cx, y - cy
      if angle == 90 then return round(cx - dy), round(cy + dx)
      elseif angle == 180 then return w - 1 - x, h - 1 - y
      elseif angle == 270 then return round(cx + dy), round(cy - dx) end
      return x, y
    end)
  end

  OPS["xf.shift"] = function(spr, op)
    return transformCel(spr, op, function(x, y, w, h)
      local nx, ny = x + (op.dx or 0), y + (op.dy or 0)
      if op.wrap then nx, ny = nx % w, ny % h end
      return nx, ny
    end)
  end

  OPS["xf.copy_region"] = function(spr, op)
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
    local n = 0
    for it in region:pixels() do
      local v = it()
      local x, y = op.toX + it.x, op.toY + it.y
      if (v ~= tv or op.opaque) and x >= 0 and y >= 0 and x < dst.width and y < dst.height then dst:drawPixel(x, y, v); n = n + 1 end
    end
    commitImage(spr, dstLayer, dstFrame, dst, dcel)
    return { pixels = n }
  end

  OPS["xf.paste_image"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    local frame = findFrame(spr, op.frame)
    local src = Image { fromFile = op.file }
    if not src then fail("could not load image '" .. op.file .. "'") end
    local img, cel = editableImage(spr, layer, frame)
    local n = 0
    for it in src:pixels() do
      local r, g, b, a = pixelRGBA(spr, it(), src.colorMode)
      local x, y = (op.x or 0) + it.x, (op.y or 0) + it.y
      if a > 0 and x >= 0 and y >= 0 and x < img.width and y < img.height then
        img:drawPixel(x, y, encode(spr, r, g, b, a)); n = n + 1
      end
    end
    commitImage(spr, layer, frame, img, cel)
    return { width = src.width, height = src.height, pixels = n }
  end

  -------------------------------------------------------------------------
  -- Cels
  -------------------------------------------------------------------------

  OPS["cel.copy"] = function(spr, op)
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

  OPS["cel.move"] = function(spr, op)
    local layer = findLayer(spr, op.layer, false, true)
    local moved = 0
    for _, fn in ipairs(frameList(spr, op, "all")) do
      local cel = layer:cel(fn)
      if cel then
        cel.position = Point(cel.position.x + (op.dx or 0), cel.position.y + (op.dy or 0))
        moved = moved + 1
      end
    end
    return { cels = moved }
  end

  OPS["cel.set"] = function(spr, op)
    local layer = findLayer(spr, op.layer, false, true)
    local n = 0
    for _, fn in ipairs(frameList(spr, op)) do
      local cel = layer:cel(fn)
      if cel then
        if op.opacity then cel.opacity = op.opacity end
        if op.x or op.y then cel.position = Point(op.x or cel.position.x, op.y or cel.position.y) end
        if op.zIndex and cel.zIndex ~= nil then cel.zIndex = op.zIndex end
        if op.data then cel.data = op.data end
        if op.color then cel.color = H.toColorObject(spr, op.color) end
        n = n + 1
      end
    end
    return { cels = n }
  end

  OPS["cel.delete"] = function(spr, op)
    local layer = findLayer(spr, op.layer, false, true)
    if not layer.isEditable then fail("layer '" .. layer.name .. "' is locked") end
    local n = 0
    for _, fn in ipairs(frameList(spr, op)) do
      local cel = layer:cel(fn)
      if cel then spr:deleteCel(cel); n = n + 1 end
    end
    return { cels = n }
  end

  local function setRange(spr, layer, from, to)
    app.activeSprite = spr
    app.activeLayer = layer
    local frames = {}
    for n = from, to do frames[#frames + 1] = spr.frames[n] end
    app.range.layers = { layer }
    app.range.frames = frames
  end

  OPS["cel.link"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    assertEditable(layer)
    findFrame(spr, op.fromFrame); findFrame(spr, op.toFrame)
    if op.toFrame <= op.fromFrame then fail("toFrame must be greater than fromFrame") end
    if not layer:cel(op.fromFrame) then fail("frame " .. op.fromFrame .. " has no cel to link") end
    -- LinkCels links the range to its first cel; clear the rest first so they mirror the source.
    for n = op.fromFrame + 1, op.toFrame do
      local c = layer:cel(n)
      if c then spr:deleteCel(c) end
    end
    setRange(spr, layer, op.fromFrame, op.toFrame)
    app.command.LinkCels()
    app.range:clear()
    local id = layer:cel(op.fromFrame).image.id
    local linked = 0
    for n = op.fromFrame, op.toFrame do
      local c = layer:cel(n)
      if c and c.image.id == id then linked = linked + 1 end
    end
    if linked < op.toFrame - op.fromFrame + 1 then fail("Aseprite did not link every cel (linked " .. linked .. ")") end
    return { linked = linked }
  end

  OPS["cel.unlink"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    assertEditable(layer)
    local n = 0
    for _, fn in ipairs(frameList(spr, op, "all")) do
      local cel = layer:cel(fn)
      if cel then
        -- re-create the cel with its own copy of the image
        local img, pos, opacity = cel.image:clone(), cel.position, cel.opacity
        spr:deleteCel(cel)
        local c = spr:newCel(layer, fn, img, pos)
        c.opacity = opacity
        n = n + 1
      end
    end
    return { cels = n }
  end

  OPS["cel.swap"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    assertEditable(layer)
    findFrame(spr, op.frameA); findFrame(spr, op.frameB)
    local a, b = layer:cel(op.frameA), layer:cel(op.frameB)
    local sa = a and { img = a.image:clone(), pos = a.position, op = a.opacity }
    local sb = b and { img = b.image:clone(), pos = b.position, op = b.opacity }
    if a then spr:deleteCel(a) end
    if b then spr:deleteCel(b) end
    if sb then spr:newCel(layer, op.frameA, sb.img, sb.pos).opacity = sb.op end
    if sa then spr:newCel(layer, op.frameB, sa.img, sa.pos).opacity = sa.op end
    return {}
  end

  QUERIES["cel.list"] = function(spr, args)
    local out = {}
    local layers = args.layer and { findLayer(spr, args.layer, false, true) } or nil
    local frameSet
    if H.hasFrameSel(args) then
      frameSet = {}
      for _, n in ipairs(frameList(spr, args)) do frameSet[n] = true end
    end
    for _, e in ipairs(allLayers(spr)) do
      if not e.layer.isGroup and (not layers or layers[1] == e.layer) then
        local first = {}
        for _, cel in ipairs(e.layer.cels) do
          if not frameSet or frameSet[cel.frameNumber] then
            local id = cel.image.id
            local linkedTo = first[id]
            if not linkedTo then first[id] = cel.frameNumber end
            out[#out + 1] = {
              layer = e.path, frame = cel.frameNumber,
              x = cel.position.x, y = cel.position.y, w = cel.image.width, h = cel.image.height,
              opacity = cel.opacity ~= 255 and cel.opacity or nil,
              zIndex = (cel.zIndex and cel.zIndex ~= 0) and cel.zIndex or nil,
              linkedTo = linkedTo,
              data = (cel.data and cel.data ~= "") and cel.data or nil,
            }
          end
        end
      end
    end
    return H.page(out, args)
  end

  -------------------------------------------------------------------------
  -- Layers
  -------------------------------------------------------------------------

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
  H.placeLayer = placeLayer

  local function checkName(spr, name, allowDuplicate)
    if allowDuplicate then return end
    for _, e in ipairs(allLayers(spr)) do
      if e.layer.name == name then fail("a layer named '" .. name .. "' already exists") end
    end
  end
  H.checkLayerName = checkName

  local function applyLayerProps(layer, op)
    if op.opacity then layer.opacity = op.opacity end
    if op.blendMode then layer.blendMode = BLEND[op.blendMode] end
    if op.visible ~= nil then layer.isVisible = op.visible end
  end

  OPS["layer.add"] = function(spr, op)
    checkName(spr, op.name, op.allowDuplicate)
    local layer = spr:newLayer()
    layer.name = op.name
    placeLayer(spr, layer, op)
    applyLayerProps(layer, op)
    return { path = pathOf(spr, layer) }
  end

  OPS["layer.add_group"] = function(spr, op)
    checkName(spr, op.name, op.allowDuplicate)
    local layer = spr:newGroup()
    layer.name = op.name
    placeLayer(spr, layer, op)
    applyLayerProps(layer, op)
    for _, child in ipairs(op.children or {}) do
      local l = findLayer(spr, child, true)
      l.parent = layer
    end
    return { path = pathOf(spr, layer) }
  end

  OPS["layer.set"] = function(spr, op)
    local layer = findLayer(spr, op.layer, true)
    if op.name then layer.name = op.name end
    if op.locked ~= nil then layer.isEditable = not op.locked end
    applyLayerProps(layer, op)
    if op.data then layer.data = op.data end
    if op.color then layer.color = H.toColorObject(spr, op.color) end
    return { path = pathOf(spr, layer) }
  end

  OPS["layer.delete"] = function(spr, op)
    local layer = findLayer(spr, op.layer, true)
    if layer.parent == spr and #spr.layers <= 1 then fail("cannot delete the only top-level layer") end
    spr:deleteLayer(layer)
    return {}
  end

  OPS["layer.move"] = function(spr, op)
    local layer = findLayer(spr, op.layer, true)
    placeLayer(spr, layer, op)
    return { path = pathOf(spr, layer) }
  end

  OPS["layer.duplicate"] = function(spr, op)
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

  OPS["layer.merge_down"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    if layer.stackIndex <= 1 then fail("layer '" .. layer.name .. "' has no layer below it to merge into") end
    app.activeSprite = spr
    app.activeLayer = layer
    app.command.MergeDownLayer()
    return {}
  end

  OPS["layer.flatten"] = function(spr, _)
    spr:flatten()
    return {}
  end

  -- Merge a group's visible children into one image layer that replaces the group.
  OPS["layer.merge_group"] = function(spr, op)
    local group = findLayer(spr, op.layer, true)
    if not group.isGroup then fail("'" .. op.layer .. "' is not a group") end
    local merged = spr:newLayer()
    merged.name = op.name or group.name
    merged.parent = group.parent
    merged.stackIndex = group.stackIndex
    local children = {}
    local function collect(g)
      for _, l in ipairs(g.layers) do
        if l.isGroup then collect(l) elseif l.isVisible and not l.isTilemap then children[#children + 1] = l end
      end
    end
    collect(group)
    for fi = 1, #spr.frames do
      local img = Image(spr.spec)
      img:clear(transparentValue(spr))
      local any = false
      for _, l in ipairs(children) do -- bottom to top
        local cel = l:cel(fi)
        if cel then
          img:drawImage(cel.image, cel.position, math.floor(cel.opacity * l.opacity / 255), l.blendMode)
          any = true
        end
      end
      if any then commitImage(spr, merged, spr.frames[fi], img, nil) end
    end
    spr:deleteLayer(group)
    return { path = pathOf(spr, merged), merged = #children }
  end

  OPS["layer.solo"] = function(spr, op)
    local keep = {}
    local function keepTree(l)
      keep[l] = true
      if l.isGroup then for _, c in ipairs(l.layers) do keepTree(c) end end
    end
    for _, ref in ipairs(op.layers) do
      local l = findLayer(spr, ref, true)
      keepTree(l)
      local p = l.parent
      while p and p ~= spr do keep[p] = true; p = p.parent end
    end
    local hidden = 0
    for _, e in ipairs(allLayers(spr)) do
      local show = keep[e.layer] == true
      if e.layer.isVisible ~= show then e.layer.isVisible = show end
      if not show then hidden = hidden + 1 end
    end
    return { hidden = hidden }
  end

  OPS["layer.set_background"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    app.activeSprite = spr
    app.activeLayer = layer
    if op.background then
      if layer.isBackground then return { changed = false } end
      app.command.BackgroundFromLayer()
    else
      if not layer.isBackground then return { changed = false } end
      app.command.LayerFromBackground()
    end
    return { changed = true, path = pathOf(spr, app.activeLayer) }
  end

  -- Move pixels of the given colors from a layer into a new layer (e.g. split the outline).
  OPS["layer.extract_colors"] = function(spr, op)
    local src = findLayer(spr, op.layer)
    assertEditable(src)
    checkName(spr, op.name, false)
    local values = {}
    for _, c in ipairs(op.colors) do values[pixelValue(spr, c)] = true end
    local dst = spr:newLayer()
    dst.name = op.name
    dst.parent = src.parent
    dst.stackIndex = src.stackIndex + 1
    local moved = 0
    for _, cel in ipairs(src.cels) do
      local frame = spr.frames[cel.frameNumber]
      local img, scel = editableImage(spr, src, frame)
      local out = Image(spr.spec)
      local tv = transparentValue(spr)
      out:clear(tv)
      for it in img:pixels() do
        local v = it()
        if values[v] then
          out:drawPixel(it.x, it.y, v)
          if not op.keep then it(tv) end
          moved = moved + 1
        end
      end
      commitImage(spr, src, frame, img, scel)
      commitImage(spr, dst, frame, out, nil)
    end
    return { path = pathOf(spr, dst), pixels = moved }
  end

  QUERIES["layer.list"] = function(spr, args)
    local info = H.spriteInfo(spr, { paletteColors = false })
    local out = {}
    for _, l in ipairs(info.layers) do
      if not args.type or args.type == l.type then out[#out + 1] = l end
    end
    for _, e in ipairs(allLayers(spr)) do
      for _, l in ipairs(out) do
        if l.path == e.path then
          if e.layer.data and e.layer.data ~= "" then l.data = e.layer.data end
        end
      end
    end
    return H.page(out, args)
  end

  -------------------------------------------------------------------------
  -- Frames
  -------------------------------------------------------------------------

  OPS["frame.add"] = function(spr, op)
    local count = op.count or 1
    local after = op.after or #spr.frames
    if after < 0 or after > #spr.frames then fail(string.format("`after` must be between 0 and %d", #spr.frames)) end
    local src = op.copyFrom
    if src then findFrame(spr, src) end
    local created = {}
    H.insertFrames(spr, after + 1, count)
    if src and src > after then src = src + count end
    for i = 1, count do
      local at = after + i
      local f = spr.frames[at]
      if src then
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

  -- Copy every cel of frame `from` (all layers, incl. tilemaps) to frame `to`.
  local function copyFrameCels(spr, from, to)
    if from == to then return end
    for _, e in ipairs(allLayers(spr)) do
      local l = e.layer
      if not l.isGroup then
        local cel = l:cel(from)
        local existing = l:cel(to)
        if existing then spr:deleteCel(existing) end
        if cel then
          local c = spr:newCel(l, to, cel.image:clone(), cel.position)
          c.opacity = cel.opacity
        end
      end
    end
    spr.frames[to].duration = spr.frames[from].duration
  end
  H.copyFrameCels = copyFrameCels

  OPS["frame.delete"] = function(spr, op)
    local from, to = op.from, op.to or op.from
    findFrame(spr, from); findFrame(spr, to)
    if to - from + 1 >= #spr.frames then fail("cannot delete every frame") end
    for n = to, from, -1 do spr:deleteFrame(n) end
    return { deleted = to - from + 1 }
  end

  OPS["frame.set_duration"] = function(spr, op)
    local frames = frameList(spr, op, "all")
    if op.durations then
      if #op.durations ~= #frames then fail(string.format("durations has %d entries but %d frames are selected", #op.durations, #frames)) end
      for i, n in ipairs(frames) do spr.frames[n].duration = op.durations[i] / 1000 end
    else
      if not op.durationMs then fail("pass durationMs or durations") end
      for _, n in ipairs(frames) do spr.frames[n].duration = op.durationMs / 1000 end
    end
    return { frames = #frames }
  end

  OPS["frame.scale_timing"] = function(spr, op)
    local frames = frameList(spr, op, "all")
    for _, n in ipairs(frames) do
      local ms = math.max(1, round(spr.frames[n].duration * 1000 * op.factor))
      spr.frames[n].duration = math.min(65535, ms) / 1000
    end
    return { frames = #frames }
  end

  -- Snapshot/restore every cel of a frame range (all non-group layers).
  local function snapFrames(spr, a, b)
    local snap = {}
    local layers = {}
    for _, e in ipairs(allLayers(spr)) do if not e.layer.isGroup then layers[#layers + 1] = e.layer end end
    for n = a, b do
      snap[n] = { duration = spr.frames[n].duration, cels = {} }
      for i, l in ipairs(layers) do
        local cel = l:cel(n)
        if cel then snap[n].cels[i] = { image = cel.image:clone(), position = cel.position, opacity = cel.opacity } end
      end
    end
    return snap, layers
  end

  local function writeFrame(spr, layers, n, s)
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

  OPS["frame.duplicate"] = function(spr, op)
    local from, to = op.from, op.to or op.from
    findFrame(spr, from); findFrame(spr, to)
    if to < from then fail("`to` must be >= `from`") end
    local at = op.insertAt or (to + 1)
    if at < 1 or at > #spr.frames + 1 then fail("insertAt out of range") end
    local snap, layers = snapFrames(spr, from, to)
    local created = {}
    H.insertFrames(spr, at, to - from + 1)
    for i = 0, to - from do
      writeFrame(spr, layers, at + i, snap[from + i])
      created[#created + 1] = at + i
    end
    return { frames = created }
  end

  OPS["frame.reverse"] = function(spr, op)
    local a, b = op.from, op.to
    findFrame(spr, a); findFrame(spr, b)
    local snap, layers = snapFrames(spr, a, b)
    for n = a, b do writeFrame(spr, layers, n, snap[a + b - n]) end
    return {}
  end

  OPS["frame.move"] = function(spr, op)
    local from, to = op.from, op.to
    findFrame(spr, from); findFrame(spr, to)
    if from == to then return {} end
    local a, b = math.min(from, to), math.max(from, to)
    local snap, layers = snapFrames(spr, a, b)
    local order = {}
    for n = a, b do order[#order + 1] = n end
    table.remove(order, from - a + 1)
    table.insert(order, to - a + 1, from)
    for i, src in ipairs(order) do writeFrame(spr, layers, a + i - 1, snap[src]) end
    return { order = order }
  end

  OPS["frame.swap"] = function(spr, op)
    findFrame(spr, op.frameA); findFrame(spr, op.frameB)
    local a, b = math.min(op.frameA, op.frameB), math.max(op.frameA, op.frameB)
    local snap, layers = snapFrames(spr, a, b)
    writeFrame(spr, layers, a, snap[b])
    writeFrame(spr, layers, b, snap[a])
    return {}
  end

  QUERIES["frame.list"] = function(spr, args)
    local out = {}
    for i, f in ipairs(spr.frames) do
      local tags = {}
      for _, t in ipairs(spr.tags) do
        if i >= t.fromFrame.frameNumber and i <= t.toFrame.frameNumber then tags[#tags + 1] = t.name end
      end
      local cels = 0
      for _, e in ipairs(allLayers(spr)) do if not e.layer.isGroup and e.layer:cel(i) then cels = cels + 1 end end
      out[#out + 1] = { frame = i, durationMs = round(f.duration * 1000), tags = #tags > 0 and table.concat(tags, ",") or nil, cels = cels }
    end
    return H.page(out, args)
  end

  -------------------------------------------------------------------------
  -- Tags & slices
  -------------------------------------------------------------------------

  OPS["tag.add"] = function(spr, op)
    findFrame(spr, op.from); findFrame(spr, op.to)
    if op.to < op.from then fail("tag `to` must be >= `from`") end
    for _, t in ipairs(spr.tags) do
      if t.name == op.name then fail("a tag named '" .. op.name .. "' already exists") end
    end
    local t = spr:newTag(op.from, op.to)
    t.name = op.name
    if op.direction then t.aniDir = ANIDIR[op.direction] end
    if op.repeats then t.repeats = op.repeats end
    if op.color then t.color = H.toColorObject(spr, op.color) end
    return {}
  end

  OPS["tag.set"] = function(spr, op)
    local t = findTag(spr, op.tag)
    if op.name then t.name = op.name end
    if op.from then t.fromFrame = findFrame(spr, op.from) end
    if op.to then t.toFrame = findFrame(spr, op.to) end
    if op.direction then t.aniDir = ANIDIR[op.direction] end
    if op.repeats then t.repeats = op.repeats end
    if op.color then t.color = H.toColorObject(spr, op.color) end
    if op.data then t.data = op.data end
    return {}
  end

  OPS["tag.delete"] = function(spr, op)
    spr:deleteTag(findTag(spr, op.tag))
    return {}
  end

  QUERIES["tag.list"] = function(spr, args)
    local info = H.spriteInfo(spr, { paletteColors = false })
    for _, t in ipairs(info.tags) do
      local ms = 0
      for n = t.from, t.to do ms = ms + round(spr.frames[n].duration * 1000) end
      t.frames = t.to - t.from + 1
      t.totalMs = ms
    end
    return H.page(info.tags, args)
  end

  OPS["slice.add"] = function(spr, op)
    for _, s in ipairs(spr.slices) do
      if s.name == op.name then fail("a slice named '" .. op.name .. "' already exists") end
    end
    local s = spr:newSlice(Rectangle(op.x, op.y, op.width, op.height))
    s.name = op.name
    if op.pivot then s.pivot = Point(op.pivot.x, op.pivot.y) end
    if op.center then s.center = Rectangle(op.center.x, op.center.y, op.center.width, op.center.height) end
    if op.data then s.data = op.data end
    return {}
  end

  OPS["slice.set"] = function(spr, op)
    local s = findSlice(spr, op.slice)
    if op.name then s.name = op.name end
    if op.x or op.y or op.width or op.height then
      local b = s.bounds
      s.bounds = Rectangle(op.x or b.x, op.y or b.y, op.width or b.width, op.height or b.height)
    end
    if op.pivot then s.pivot = Point(op.pivot.x, op.pivot.y) end
    if op.center then s.center = Rectangle(op.center.x, op.center.y, op.center.width, op.center.height) end
    if op.data then s.data = op.data end
    if op.color then s.color = H.toColorObject(spr, op.color) end
    return {}
  end

  OPS["slice.delete"] = function(spr, op)
    spr:deleteSlice(findSlice(spr, op.slice or op.name))
    return {}
  end

  QUERIES["slice.list"] = function(spr, args)
    local info = H.spriteInfo(spr, { paletteColors = false })
    for i, s in ipairs(spr.slices) do
      if s.data and s.data ~= "" then info.slices[i].data = s.data end
    end
    return H.page(info.slices, args)
  end

  -------------------------------------------------------------------------
  -- Palette basics
  -------------------------------------------------------------------------

  OPS["pal.set"] = function(spr, op)
    local pal = Palette(#op.colors)
    for i, c in ipairs(op.colors) do
      local r, g, b, a = c.r or 0, c.g or 0, c.b or 0, c.a or 255
      if c.index ~= nil then r, g, b, a = H.paletteRGBA(spr, c.index) end
      pal:setColor(i - 1, Color { r = r, g = g, b = b, a = a })
    end
    if spr.colorMode == ColorMode.INDEXED and op.remap then
      local old = spr.palettes[1]
      local list = {}
      for i = 0, #pal - 1 do local c = pal:getColor(i); list[#list + 1] = { c.red, c.green, c.blue } end
      for _, cel in ipairs(H.targetCels(spr, {})) do
        local img = cel.image:clone()
        for it in img:pixels() do
          local v = it()
          if v ~= spr.transparentColor and v < #old then
            local c = old:getColor(v)
            it(H.nearestInList(list, c.red, c.green, c.blue) - 1)
          end
        end
        cel.image = img
      end
    end
    spr:setPalette(pal)
    local res = { size = #op.colors }
    if op.remap and spr.colorMode ~= ColorMode.INDEXED then
      res.remapped = OPS["pal.quantize"](spr, { colors = op.colors }).pixels
    end
    return res
  end

  OPS["pal.set_color"] = function(spr, op)
    local pal = spr.palettes[1]
    if op.index >= #pal then pal:resize(op.index + 1) end
    pal:setColor(op.index, H.toColorObject(spr, op.color))
    return {}
  end

  -------------------------------------------------------------------------
  -- Document-level edits
  -------------------------------------------------------------------------

  OPS["doc.resize_canvas"] = function(spr, op)
    local anchor = op.anchor or "center"
    local dw, dh = spr.width - op.width, spr.height - op.height
    local x, y = math.floor(dw / 2), math.floor(dh / 2)
    if anchor:find("left") then x = 0 elseif anchor:find("right") then x = dw end
    if anchor:find("^top") then y = 0 elseif anchor:find("^bottom") then y = dh end
    spr:crop(x, y, op.width, op.height)
    return { width = spr.width, height = spr.height }
  end

  OPS["doc.crop"] = function(spr, op)
    spr:crop(op.x, op.y, op.width, op.height)
    return { width = spr.width, height = spr.height }
  end

  -- Union of the visible content bounds over every frame.
  local function unionContent(spr)
    local u
    for i = 1, #spr.frames do
      local b = H.contentBounds(H.renderFrame(spr, i))
      if b then
        if not u then u = { x0 = b.x, y0 = b.y, x1 = b.x + b.width - 1, y1 = b.y + b.height - 1 }
        else
          u.x0, u.y0 = math.min(u.x0, b.x), math.min(u.y0, b.y)
          u.x1, u.y1 = math.max(u.x1, b.x + b.width - 1), math.max(u.y1, b.y + b.height - 1)
        end
      end
    end
    return u
  end
  H.unionContent = unionContent

  OPS["doc.trim"] = function(spr, op)
    local u = unionContent(spr)
    if not u then fail("sprite is empty; nothing to trim to") end
    local m = op.margin or 0
    local x0, y0 = math.max(0, u.x0 - m), math.max(0, u.y0 - m)
    local x1, y1 = math.min(spr.width - 1, u.x1 + m), math.min(spr.height - 1, u.y1 + m)
    spr:crop(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    return { x = x0, y = y0, width = spr.width, height = spr.height }
  end

  OPS["doc.scale"] = function(spr, op)
    local w = op.width or round(spr.width * op.factor)
    local h = op.height or round(spr.height * op.factor)
    app.activeSprite = spr
    app.command.SpriteSize { ui = false, width = w, height = h, lockRatio = false, method = op.method or "nearest" }
    return { width = spr.width, height = spr.height }
  end

  OPS["doc.set_color_mode"] = function(spr, op)
    app.activeSprite = spr
    app.command.ChangePixelFormat { ui = false, format = op.mode, dithering = op.dithering or "none" }
    return { colorMode = H.COLOR_MODE_NAME[spr.colorMode] }
  end

  OPS["doc.set_metadata"] = function(spr, op)
    if op.data then spr.data = op.data end
    if op.properties then
      local p = spr.properties("mcp-user")
      for k, v in pairs(op.properties) do
        if v == false and op.deleteFalse then p[k] = nil else p[k] = v end
      end
    end
    return {}
  end

  QUERIES["doc.get_metadata"] = function(spr)
    local props = {}
    local ok = pcall(function()
      for k, v in pairs(spr.properties("mcp-user")) do props[k] = H.plain(v) end
    end)
    return {
      data = spr.data ~= "" and spr.data or nil,
      properties = ok and next(props) and props or nil,
      pivot = H.getProp(spr, "pivot"),
      grid = { x = spr.gridBounds.x, y = spr.gridBounds.y, width = spr.gridBounds.width, height = spr.gridBounds.height },
      pixelRatio = { width = spr.pixelRatio.width, height = spr.pixelRatio.height },
      generated = H.getProp(spr, "generated"),
    }
  end

  OPS["doc.set_grid"] = function(spr, op)
    spr.gridBounds = Rectangle(op.x or 0, op.y or 0, op.width, op.height)
    return {}
  end

  OPS["doc.set_pixel_ratio"] = function(spr, op)
    spr.pixelRatio = Size(op.width, op.height)
    return {}
  end

  OPS["doc.set_transparent_index"] = function(spr, op)
    if spr.colorMode ~= ColorMode.INDEXED then fail("only indexed sprites have a transparent index") end
    if op.index >= #spr.palettes[1] then fail("index is outside the palette") end
    spr.transparentColor = op.index
    return {}
  end

  QUERIES["doc.inspect"] = function(spr, args)
    return H.spriteInfo(spr, { paletteColors = args.paletteColors, brief = args.brief })
  end

  -- Build a sprite from separate PNG frames (one per frame, same size).
  H.CMD.from_images = function(req, ctx)
    local first = Image { fromFile = req.files[1] }
    if not first then fail("could not load " .. req.files[1]) end
    local spr = Sprite(first.width, first.height, ColorMode.RGB)
    app.activeSprite = spr
    spr.layers[1].name = req.layerName or "frames"
    for i, f in ipairs(req.files) do
      if i > 1 then spr:newEmptyFrame(i) end
      local img = Image { fromFile = f }
      if not img then fail("could not load " .. f) end
      if img.width ~= first.width or img.height ~= first.height then fail(f .. " has a different size") end
      local canvas = Image(spr.spec)
      canvas:clear(0)
      for it in img:pixels() do
        local r, g, b, a = pixelRGBA(spr, it(), img.colorMode)
        if a > 0 then canvas:drawPixel(it.x, it.y, pc.rgba(r, g, b, a)) end
      end
      commitImage(spr, spr.layers[1], spr.frames[i], canvas, spr.layers[1]:cel(i))
      if req.durationMs then spr.frames[i].duration = req.durationMs / 1000 end
    end
    if req.tag then
      local t = spr:newTag(1, #spr.frames)
      t.name = req.tag
    end
    if req.output then spr:saveCopyAs(req.output) end
    return { sprite = H.spriteInfo(spr, { paletteColors = false }) }
  end

  -- Generic paging for list queries: {offset, limit}
  function H.page(list, args)
    local offset = args.offset or 0
    local limit = args.limit or 100
    local out = {}
    for i = offset + 1, math.min(#list, offset + limit) do out[#out + 1] = list[i] end
    local res = { items = out, total = #list }
    if offset + limit < #list then res.nextOffset = offset + limit end
    return res
  end
end
