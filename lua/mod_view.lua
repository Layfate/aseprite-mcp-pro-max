-- Rendered views (previews, contact sheets, tile repeats, value checks), pixel
-- reads and reference-image processing.
return function(M, H)
  local QUERIES, VIEWS, CMD = M.QUERIES, M.VIEWS, M.CMD
  local fail, round, pc = H.fail, H.round, H.pc
  local findFrame, frameList, renderFrame = H.findFrame, H.frameList, H.renderFrame

  local MAP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&*+=?@"

  -------------------------------------------------------------------------
  -- Pixel reads
  -------------------------------------------------------------------------

  local function region(spr, args)
    local x0, y0 = args.x or 0, args.y or 0
    local w = math.min(args.width or spr.width, spr.width - x0)
    local h = math.min(args.height or spr.height, spr.height - y0)
    if x0 < 0 or y0 < 0 or w <= 0 or h <= 0 then fail("region is outside the canvas") end
    local max = args.maxPixels or 4096
    if w * h > max then
      fail(string.format("region %dx%d is too large to read as text (max %d pixels); pass a smaller x/y/width/height region or use a preview", w, h, max))
    end
    return x0, y0, w, h
  end

  QUERIES["pixels.read"] = function(spr, args)
    local img = renderFrame(spr, args.frame, args.layer)
    local x0, y0, w, h = region(spr, args)
    local legend, charOf, nextChar = {}, {}, 1
    -- optional fixed legend so reads line up with an existing pixel_map legend
    if args.legend then
      for ch, c in pairs(args.legend) do
        local key = H.hex(c.r, c.g, c.b, c.a)
        charOf[key] = ch
        legend[ch] = key
      end
    end
    local rows = {}
    for y = y0, y0 + h - 1 do
      local row = {}
      for x = x0, x0 + w - 1 do
        local v = img:getPixel(x, y)
        local a = pc.rgbaA(v)
        if a == 0 then row[#row + 1] = "." else
          local key = H.hex(pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), a)
          local ch = charOf[key]
          if not ch then
            repeat
              if nextChar > #MAP_CHARS then fail("region uses more than " .. #MAP_CHARS .. " colors; read a smaller region or use a preview") end
              ch = MAP_CHARS:sub(nextChar, nextChar)
              nextChar = nextChar + 1
            until legend[ch] == nil
            charOf[key] = ch
            legend[ch] = key
          end
          row[#row + 1] = ch
        end
      end
      rows[#rows + 1] = table.concat(row)
    end
    local count = 0
    for _ in pairs(legend) do count = count + 1 end
    return { x = x0, y = y0, width = w, height = h, rows = rows, legend = legend, colorCount = count }
  end

  local DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"

  -- Palette index grid (base-36 digits; '.' transparent; '?' not in the palette).
  QUERIES["pixels.read_indices"] = function(spr, args)
    local x0, y0, w, h = region(spr, args)
    local pal = spr.palettes[1]
    local lookup = {}
    for i = #pal - 1, 0, -1 do
      local c = pal:getColor(i)
      lookup[pc.rgba(c.red, c.green, c.blue, c.alpha)] = i
    end
    local img = renderFrame(spr, args.frame, args.layer)
    local rows, wide, unknown = {}, false, 0
    for y = y0, y0 + h - 1 do
      local row = {}
      for x = x0, x0 + w - 1 do
        local v = img:getPixel(x, y)
        if pc.rgbaA(v) == 0 then row[#row + 1] = "." else
          local i = lookup[v]
          if i == nil then row[#row + 1] = "?"; unknown = unknown + 1
          elseif i < 36 then row[#row + 1] = DIGITS:sub(i + 1, i + 1)
          else wide = true; row[#row + 1] = "[" .. i .. "]" end
        end
      end
      rows[#rows + 1] = table.concat(row)
    end
    return { x = x0, y = y0, width = w, height = h, rows = rows, offPalette = unknown, note = wide and "indices >= 36 are written as [n]" or nil }
  end

  -------------------------------------------------------------------------
  -- Rendering helpers
  -------------------------------------------------------------------------

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

  local function fitScale(req, W, H_)
    local scale = req.scale or math.max(1, math.floor((req.targetSize or 384) / math.max(W, H_)))
    if W * scale > 4096 or H_ * scale > 4096 then scale = math.max(1, math.floor(4096 / math.max(W, H_))) end
    return scale
  end

  -- Composite `sheet` (RGBA) scaled up over a background, with an optional pixel grid.
  local function present(sheet, args, scale)
    local big = sheet:clone()
    if scale > 1 then big:resize(sheet.width * scale, sheet.height * scale) end
    local out = Image(big.width, big.height, ColorMode.RGB)
    out:clear(0)
    fillBackground(out, args.background, scale)
    if args.grid and scale >= 4 then
      local gc = pc.rgba(0, 0, 0, 40)
      for y = 0, out.height - 1 do
        for x = 0, out.width - 1 do
          if x % scale == 0 or y % scale == 0 then out:drawPixel(x, y, gc) end
        end
      end
    end
    out:drawImage(big, Point(0, 0))
    return out
  end
  H.present = present

  local function text(img, s, x, y, color)
    local cx = x
    for i = 1, #s do
      local glyph = H.FONT3x5[s:sub(i, i):upper()] or H.FONT3x5["?"]
      for gy = 0, 4 do
        for gx = 0, 2 do
          local bit = gy * 3 + gx + 1
          if glyph:sub(bit, bit) == "1" then
            local px, py = cx + gx, y + gy
            if px >= 0 and py >= 0 and px < img.width and py < img.height then img:drawPixel(px, py, color) end
          end
        end
      end
      cx = cx + 4
    end
  end

  -- Frames laid out in a grid separated by magenta lines; onion shows the previous frame.
  VIEWS["view.frames"] = function(spr, args, req)
    local frames = frameList(spr, args)
    local n = #frames
    local cols = math.min(args.columns or n, n)
    local rows = math.ceil(n / cols)
    local gap = n > 1 and 1 or 0
    local W = spr.width * cols + gap * (cols - 1)
    local Hh = spr.height * rows + gap * (rows - 1)
    local scale = fitScale(args, W, Hh)
    local sheet = Image(W, Hh, ColorMode.RGB)
    sheet:clear(0)
    for i, fn in ipairs(frames) do
      local col, row = (i - 1) % cols, (i - 1) // cols
      local frameImg = renderFrame(spr, fn, args.layer)
      if args.onion and fn > 1 then
        local ghost = Image(spr.width, spr.height, ColorMode.RGB)
        ghost:clear(0)
        ghost:drawImage(renderFrame(spr, fn - 1, args.layer), Point(0, 0), args.onionOpacity or 70)
        if args.onionNext and fn < #spr.frames then ghost:drawImage(renderFrame(spr, fn + 1, args.layer), Point(0, 0), 40) end
        ghost:drawImage(frameImg, Point(0, 0))
        frameImg = ghost
      end
      sheet:drawImage(frameImg, Point(col * (spr.width + gap), row * (spr.height + gap)))
    end
    local out = present(sheet, args, scale)
    if gap > 0 and args.background ~= "transparent" then
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

  -- Contact sheet: one row per tag (or all frames), each cell labelled "frame:ms".
  VIEWS["view.contact_sheet"] = function(spr, args, req)
    local groups = {}
    local tags = {}
    for _, t in ipairs(spr.tags) do if not t.name:match("^mcp:") then tags[#tags + 1] = t end end
    if #tags > 0 and args.byTag ~= false then
      for _, t in ipairs(tags) do
        local fr = {}
        for n = t.fromFrame.frameNumber, t.toFrame.frameNumber do fr[#fr + 1] = n end
        groups[#groups + 1] = { name = t.name, frames = fr }
      end
    else
      local fr = {}
      for n = 1, #spr.frames do fr[#fr + 1] = n end
      groups[1] = { name = "", frames = fr }
    end
    local maxCols = 0
    for _, g in ipairs(groups) do maxCols = math.max(maxCols, #g.frames) end
    local scale = args.scale or math.max(1, math.min(8, math.floor(48 / math.max(spr.width, spr.height)) + 1))
    local cw, ch = spr.width * scale + 4, spr.height * scale + 4 + 7
    local labelH = 7
    local W = math.max(maxCols * cw + 2, 40)
    local Hh = #groups * (ch + labelH) + 2
    if W > 8192 or Hh > 8192 then fail("contact sheet would be too large; pass scale: 1 or fewer frames") end
    local out = Image(W, Hh, ColorMode.RGB)
    out:clear(pc.rgba(40, 40, 48, 255))
    local white, grey = pc.rgba(240, 240, 240, 255), pc.rgba(150, 150, 160, 255)
    for gi, g in ipairs(groups) do
      local y0 = (gi - 1) * (ch + labelH) + 1
      if g.name ~= "" then text(out, g.name:sub(1, 40), 2, y0 + 1, white) end
      for i, fnum in ipairs(g.frames) do
        local x0 = (i - 1) * cw + 2
        local cell = Image(spr.width, spr.height, ColorMode.RGB)
        cell:clear(0)
        cell:drawImage(renderFrame(spr, fnum, args.layer), Point(0, 0))
        local big = present(cell, { background = args.background or "checker" }, scale)
        out:drawImage(big, Point(x0, y0 + labelH))
        text(out, tostring(fnum) .. ":" .. round(spr.frames[fnum].duration * 1000), x0, y0 + labelH + spr.height * scale + 2, grey)
      end
    end
    out:saveAs(req.output)
    return { width = out.width, height = out.height, rows = #groups, scale = scale }
  end

  -- Repeat a frame, a layer or a tile NxM to check that it tiles without seams.
  VIEWS["view.tile_repeat"] = function(spr, args, req)
    local unit
    if args.tile then
      local layer = H.tilemapLayer(spr, args.layer)
      local timg = layer.tileset:tile(args.tile).image
      unit = Image(timg.width, timg.height, ColorMode.RGB)
      unit:clear(0)
      for it in timg:pixels() do
        local r, g, b, a = H.pixelRGBA(spr, it(), timg.colorMode)
        if a > 0 then unit:drawPixel(it.x, it.y, pc.rgba(r, g, b, a)) end
      end
    else
      unit = renderFrame(spr, args.frame or 1, args.layer)
    end
    local nx, ny = args.columns or 3, args.rows or 3
    local sheet = Image(unit.width * nx, unit.height * ny, ColorMode.RGB)
    sheet:clear(0)
    for y = 0, ny - 1 do for x = 0, nx - 1 do sheet:drawImage(unit, Point(x * unit.width, y * unit.height)) end end
    local scale = fitScale(args, sheet.width, sheet.height)
    local out = present(sheet, args, scale)
    out:saveAs(req.output)
    return { width = out.width, height = out.height, scale = scale, repeat_ = nx .. "x" .. ny }
  end

  -- A | B | diff (red = changed), same sprite or another file.
  VIEWS["view.compare"] = function(spr, args, req)
    local a = renderFrame(spr, args.frameA, args.layer)
    local b
    if args.other then
      local other = app.open(args.other)
      if not other then fail("could not open '" .. args.other .. "'") end
      if other.width ~= spr.width or other.height ~= spr.height then
        fail(string.format("sprites differ in size (%dx%d vs %dx%d)", spr.width, spr.height, other.width, other.height))
      end
      b = renderFrame(other, args.frameB or args.frameA, args.layer)
      other:close()
      app.activeSprite = spr
    else
      if not args.frameB then fail("pass frameB or other") end
      b = renderFrame(spr, args.frameB, args.layer)
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
      differentPixels = count, totalPixels = spr.width * spr.height, identical = count == 0,
      bounds = x0 and { x = x0, y = y0, width = x1 - x0 + 1, height = y1 - y0 + 1 } or nil,
    }
    if req.output then
      local scale = math.max(1, math.floor((args.targetSize or 256) / math.max(spr.width, spr.height)))
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

  VIEWS["view.palette"] = function(spr, args, req)
    local pal = spr.palettes[1]
    local n = #pal
    local cols = args.columns or math.min(16, n)
    local rows = math.ceil(n / cols)
    local cs = args.swatch or 16
    local out = Image(cols * cs, rows * (cs + 7), ColorMode.RGB)
    out:clear(pc.rgba(32, 32, 32, 255))
    for i = 0, n - 1 do
      local c = pal:getColor(i)
      local x0, y0 = (i % cols) * cs, (i // cols) * (cs + 7)
      for y = 1, cs - 2 do for x = 1, cs - 2 do
        local checker = (((x // 4) + (y // 4)) % 2 == 0) and 200 or 255
        local a = c.alpha / 255
        local r = round(c.red * a + checker * (1 - a))
        local g = round(c.green * a + checker * (1 - a))
        local b = round(c.blue * a + checker * (1 - a))
        out:drawPixel(x0 + x, y0 + y, pc.rgba(r, g, b, 255))
      end end
      text(out, tostring(i), x0 + 1, y0 + cs + 1, pc.rgba(220, 220, 220, 255))
    end
    local scale = args.scale or 2
    local big = out:clone()
    big:resize(out.width * scale, out.height * scale)
    big:saveAs(req.output)
    return { colors = n, width = big.width, height = big.height }
  end

  -- Silhouette (shape readability) or value (grayscale luminance) render.
  local function monoView(spr, args, req, fn)
    local frames = frameList(spr, args)
    local n = #frames
    local cols = math.min(args.columns or n, n)
    local rows = math.ceil(n / cols)
    local sheet = Image(spr.width * cols + (cols - 1), spr.height * rows + (rows - 1), ColorMode.RGB)
    sheet:clear(0)
    for i, fnum in ipairs(frames) do
      local img = renderFrame(spr, fnum, args.layer)
      for it in img:pixels() do
        local v = it()
        if pc.rgbaA(v) > 0 then it(fn(v)) end
      end
      sheet:drawImage(img, Point(((i - 1) % cols) * (spr.width + 1), ((i - 1) // cols) * (spr.height + 1)))
    end
    local scale = fitScale(args, sheet.width, sheet.height)
    local out = present(sheet, { background = args.background or { r = 255, g = 255, b = 255 }, grid = args.grid }, scale)
    out:saveAs(req.output)
    return { frames = frames, scale = scale, width = out.width, height = out.height }
  end

  VIEWS["view.silhouette"] = function(spr, args, req)
    local c = args.color or { r = 0, g = 0, b = 0 }
    return monoView(spr, args, req, function() return pc.rgba(c.r, c.g, c.b, 255) end)
  end

  VIEWS["view.values"] = function(spr, args, req)
    local steps = args.steps
    return monoView(spr, args, req, function(v)
      local l = 0.299 * pc.rgbaR(v) + 0.587 * pc.rgbaG(v) + 0.114 * pc.rgbaB(v)
      if steps then l = round(round(l / 255 * (steps - 1)) * 255 / (steps - 1)) end
      l = H.clamp(round(l), 0, 255)
      return pc.rgba(l, l, l, 255)
    end)
  end

  -------------------------------------------------------------------------
  -- Reference images (PNG/JPG in, PNG or sprite out). No external services.
  -------------------------------------------------------------------------

  local spr0 = { colorMode = ColorMode.RGB, transparentColor = 0, palettes = { Palette(1) } }

  local function loadRGBA(file)
    local src = Image { fromFile = file }
    if not src then fail("could not load image '" .. tostring(file) .. "'") end
    local rgba = Image(src.width, src.height, ColorMode.RGB)
    if src.colorMode == ColorMode.RGB then
      rgba:drawImage(src, Point(0, 0), 255, BlendMode.SRC)
    else
      for it in src:pixels() do
        local r, g, b, a = H.pixelRGBA(spr0, it(), src.colorMode)
        rgba:drawPixel(it.x, it.y, pc.rgba(r, g, b, a))
      end
    end
    return rgba
  end
  H.loadRGBA = loadRGBA

  -- Block-majority ("mode") or nearest downscale with binary alpha.
  local function downscale(src, tw, th, method, thr)
    local out = Image(tw, th, ColorMode.RGB)
    out:clear(0)
    local bx, by = src.width / tw, src.height / th
    for ty = 0, th - 1 do
      for tx = 0, tw - 1 do
        local sx0, sy0 = math.floor(tx * bx), math.floor(ty * by)
        local sx1, sy1 = math.max(sx0, math.floor((tx + 1) * bx) - 1), math.max(sy0, math.floor((ty + 1) * by) - 1)
        local v
        if method == "nearest" or (sx0 == sx1 and sy0 == sy1) then
          v = src:getPixel(math.min(src.width - 1, math.floor((tx + 0.5) * bx)), math.min(src.height - 1, math.floor((ty + 0.5) * by)))
          if pc.rgbaA(v) < thr then v = 0 end
        else
          local counts, best, bestN, opaque, total = {}, 0, 0, 0, 0
          for sy = sy0, sy1 do
            for sx = sx0, sx1 do
              local p = src:getPixel(sx, sy)
              total = total + 1
              if pc.rgbaA(p) >= thr then
                opaque = opaque + 1
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
    return out
  end

  local function targetSize(src, req)
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
    return tw, th
  end

  -- Corner flood (or key color) background removal; returns removed pixel count.
  local function removeBackground(out, mode, tol)
    local removed = 0
    local function close(p, ref)
      return pc.rgbaA(p) > 0 and math.abs(pc.rgbaR(p) - pc.rgbaR(ref)) <= tol and math.abs(pc.rgbaG(p) - pc.rgbaG(ref)) <= tol and math.abs(pc.rgbaB(p) - pc.rgbaB(ref)) <= tol
    end
    local w, h = out.width, out.height
    if mode == "corners" then
      for _, c in ipairs({ { 0, 0 }, { w - 1, 0 }, { 0, h - 1 }, { w - 1, h - 1 } }) do
        local ref = out:getPixel(c[1], c[2])
        if pc.rgbaA(ref) > 0 then
          H.flood(out, c[1], c[2], function(p) return close(p, ref) end, function(x, y) out:drawPixel(x, y, 0); removed = removed + 1 end, false)
        end
      end
    else
      local ref = pc.rgba(mode.r, mode.g, mode.b, 255)
      for y = 0, h - 1 do
        for x = 0, w - 1 do
          if close(out:getPixel(x, y), ref) then out:drawPixel(x, y, 0); removed = removed + 1 end
        end
      end
    end
    return removed
  end

  local function snapToPalette(out, palette)
    local list = {}
    for _, c in ipairs(palette) do if (c.a or 255) > 0 then list[#list + 1] = { c.r, c.g, c.b } end end
    for it in out:pixels() do
      local p = it()
      if pc.rgbaA(p) > 0 then
        local c = list[H.nearestInList(list, pc.rgbaR(p), pc.rgbaG(p), pc.rgbaB(p))]
        it(pc.rgba(c[1], c[2], c[3], 255))
      end
    end
  end

  -- Reference image -> clean pixel art in a new sprite, or a new layer in an existing one.
  CMD.import = function(req, ctx)
    local rgba = loadRGBA(req.file)
    local tw, th = targetSize(rgba, req)
    local out = downscale(rgba, tw, th, req.method, req.alphaThreshold or 128)
    local removed = 0
    if req.removeBackground then removed = removeBackground(out, req.removeBackground, req.backgroundTolerance or 24) end
    if req.palette then snapToPalette(out, req.palette) end
    local spr
    if req.input then
      spr = H.getSprite(req, ctx)
      local apply = function()
        local layer = spr:newLayer()
        layer.name = req.layerName or (req.asReference and "reference" or "Imported")
        local frame = findFrame(spr, req.frame or 1)
        local img = Image(spr.spec)
        img:clear(H.transparentValue(spr))
        for it in out:pixels() do
          local p = it()
          local x, y = (req.x or 0) + it.x, (req.y or 0) + it.y
          if pc.rgbaA(p) > 0 and x >= 0 and y >= 0 and x < spr.width and y < spr.height then
            img:drawPixel(x, y, H.encode(spr, pc.rgbaR(p), pc.rgbaG(p), pc.rgbaB(p), 255))
          end
        end
        spr:newCel(layer, frame, img, Point(0, 0))
        if req.asReference then
          layer.opacity = req.opacity or 96
          layer.stackIndex = 1
          layer.isEditable = false
          H.setProp(layer, "reference", true)
        end
      end
      if ctx.live then app.transaction("MCP import", apply) else apply() end
    else
      spr = Sprite(tw, th, ColorMode.RGB)
      app.activeSprite = spr
      spr.layers[1].name = req.layerName or "Imported"
      spr.cels[1].image = out
      if req.palette then M.OPS["pal.set"](spr, { colors = req.palette }) end
      if req.colorMode == "indexed" then
        app.command.ChangePixelFormat { ui = false, format = "indexed", dithering = "none" }
      end
    end
    if req.output then spr:saveCopyAs(req.output) end
    return { sprite = H.spriteInfo(spr, { paletteColors = false }), removedBackgroundPixels = removed, sourceWidth = rgba.width, sourceHeight = rgba.height }
  end

  -- Most likely pixel scale of an upscaled pixel-art image (GCD of frequent run lengths).
  local function detectScale(img)
    local hist, runs = {}, 0
    local function scan(getter, outer, inner)
      for o = 0, outer - 1 do
        local prev, len = nil, 0
        for i = 0, inner - 1 do
          local v = getter(o, i)
          if v == prev then len = len + 1 else
            if prev ~= nil then hist[len] = (hist[len] or 0) + 1; runs = runs + 1 end
            prev, len = v, 1
          end
        end
      end
    end
    local step = math.max(1, img.height // 64)
    scan(function(o, i) return img:getPixel(i, math.min(img.height - 1, o * step)) end, math.ceil(img.height / step), img.width)
    step = math.max(1, img.width // 64)
    scan(function(o, i) return img:getPixel(math.min(img.width - 1, o * step), i) end, math.ceil(img.width / step), img.height)
    local function gcd(a, b) while b ~= 0 do a, b = b, a % b end return a end
    local g = 0
    local frequent = 0
    for len, n in pairs(hist) do
      if n >= runs * 0.03 and len < math.min(img.width, img.height) then g = gcd(g, len); frequent = frequent + n end
    end
    if g < 1 then g = 1 end
    return g, runs > 0 and math.floor(frequent * 100 / runs) / 100 or 0
  end

  local function crop(img, x, y, w, h)
    local out = Image(w, h, ColorMode.RGB)
    out:clear(0)
    out:drawImage(img, Point(-x, -y), 255, BlendMode.SRC)
    return out
  end

  CMD.image = function(req)
    local action = req.action
    local img = loadRGBA(req.file)
    if action == "analyze" then
      local colors, n, semi, transparent = {}, 0, 0, 0
      for it in img:pixels() do
        local v = it()
        local a = pc.rgbaA(v)
        if a == 0 then transparent = transparent + 1 elseif a < 255 then semi = semi + 1 end
        if a > 0 and n <= 4096 and not colors[v] then colors[v] = true; n = n + 1 end
      end
      local scale, confidence = detectScale(img)
      local corners = {}
      for _, c in ipairs({ { 0, 0 }, { img.width - 1, 0 }, { 0, img.height - 1 }, { img.width - 1, img.height - 1 } }) do
        local v = img:getPixel(c[1], c[2])
        corners[#corners + 1] = H.hex(pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), pc.rgbaA(v))
      end
      local total = img.width * img.height
      return {
        width = img.width, height = img.height, colors = n > 4096 and ">4096" or n,
        transparentRatio = math.floor(transparent * 1000 / total) / 1000, semiTransparentRatio = math.floor(semi * 1000 / total) / 1000,
        pixelScale = scale, scaleConfidence = confidence, nativeSize = { width = img.width // scale, height = img.height // scale },
        corners = corners,
      }
    elseif action == "crop" then
      if req.x + req.width > img.width or req.y + req.height > img.height then fail("crop rectangle is outside the image") end
      local out = crop(img, req.x, req.y, req.width, req.height)
      out:saveAs(req.output)
      return { width = out.width, height = out.height }
    elseif action == "isolate" then
      local work = img:clone()
      if req.background ~= "alpha" then removeBackground(work, req.background or "corners", req.tolerance or 24) end
      local r = work:shrinkBounds(0)
      if r.isEmpty then fail("no subject found (everything matched the background)") end
      local m = req.margin or 0
      local x0, y0 = math.max(0, r.x - m), math.max(0, r.y - m)
      local x1, y1 = math.min(img.width - 1, r.x + r.width - 1 + m), math.min(img.height - 1, r.y + r.height - 1 + m)
      local out = crop(req.keepBackground and img or work, x0, y0, x1 - x0 + 1, y1 - y0 + 1)
      out:saveAs(req.output)
      return { x = x0, y = y0, width = out.width, height = out.height }
    elseif action == "remove_background" then
      local removed = removeBackground(img, req.background or "corners", req.tolerance or 24)
      img:saveAs(req.output)
      return { removed = removed, width = img.width, height = img.height }
    elseif action == "downscale" then
      local tw, th = targetSize(img, req)
      local out = downscale(img, tw, th, req.method, req.alphaThreshold or 128)
      if req.palette then snapToPalette(out, req.palette) end
      out:saveAs(req.output)
      return { width = tw, height = th }
    elseif action == "extract_palette" then
      local used, order = {}, {}
      for it in img:pixels() do
        local v = it()
        if pc.rgbaA(v) >= 128 then
          local k = v
          local e = used[k]
          if not e then e = { r = pc.rgbaR(v), g = pc.rgbaG(v), b = pc.rgbaB(v), n = 0 }; used[k] = e; order[#order + 1] = e end
          e.n = e.n + 1
        end
      end
      if #order == 0 then fail("image has no opaque pixels") end
      local colors = H.medianCut(order, req.colors or 16)
      local out = {}
      for _, c in ipairs(colors) do out[#out + 1] = H.hex(c.r, c.g, c.b, 255) end
      return { colors = out, sourceColors = #order }
    end
    fail("unknown image action '" .. tostring(action) .. "'")
  end

  -- Slice a grid sprite sheet into the frames of a new sprite.
  CMD.sheet_import = function(req)
    local img = loadRGBA(req.file)
    local fw, fh = req.frameWidth, req.frameHeight
    local pad, margin = req.padding or 0, req.margin or 0
    local cols = req.columns or math.max(1, math.floor((img.width - 2 * margin + pad) / (fw + pad)))
    local rows = math.max(1, math.floor((img.height - 2 * margin + pad) / (fh + pad)))
    local count = req.count or cols * rows
    if count > cols * rows then fail(string.format("sheet has room for %d frames of %dx%d, asked for %d", cols * rows, fw, fh, count)) end
    local spr = Sprite(fw, fh, ColorMode.RGB)
    app.activeSprite = spr
    spr.layers[1].name = "frames"
    for i = 0, count - 1 do
      if i > 0 then spr:newEmptyFrame(i + 1) end
      local cx, cy = i % cols, i // cols
      local cell = Image(fw, fh, ColorMode.RGB)
      cell:clear(0)
      cell:drawImage(img, Point(-(margin + cx * (fw + pad)), -(margin + cy * (fh + pad))), 255, BlendMode.SRC)
      H.commitImage(spr, spr.layers[1], spr.frames[i + 1], cell, spr.layers[1]:cel(i + 1))
      if req.durationMs then spr.frames[i + 1].duration = req.durationMs / 1000 end
    end
    for _, t in ipairs(req.tags or {}) do
      local tag = spr:newTag(t.from, t.to)
      tag.name = t.name
    end
    if req.output then spr:saveCopyAs(req.output) end
    return { sprite = H.spriteInfo(spr, { paletteColors = false }) }
  end

  -- Compare a sprite frame with a reference image (downscaled to the sprite size).
  QUERIES["ref.compare"] = function(spr, args)
    local refImg = loadRGBA(args.file)
    local ref = downscale(refImg, spr.width, spr.height, args.method or "mode", 128)
    local img = renderFrame(spr, args.frame or 1, args.layer)
    local inter, union, dist, both, close = 0, 0, 0, 0, 0
    local tol = args.tolerance or 32
    for y = 0, spr.height - 1 do
      for x = 0, spr.width - 1 do
        local a, b = img:getPixel(x, y), ref:getPixel(x, y)
        local oa, ob = pc.rgbaA(a) > 0, pc.rgbaA(b) > 0
        if oa or ob then union = union + 1 end
        if oa and ob then
          inter = inter + 1
          both = both + 1
          local d = math.sqrt((pc.rgbaR(a) - pc.rgbaR(b)) ^ 2 + (pc.rgbaG(a) - pc.rgbaG(b)) ^ 2 + (pc.rgbaB(a) - pc.rgbaB(b)) ^ 2)
          dist = dist + d
          if d <= tol then close = close + 1 end
        end
      end
    end
    return {
      silhouetteIoU = union > 0 and math.floor(inter * 1000 / union) / 1000 or 1,
      meanColorDistance = both > 0 and math.floor(dist / both) or 0,
      colorMatchRatio = both > 0 and math.floor(close * 1000 / both) / 1000 or 0,
      note = "Measures silhouette overlap and color distance only; it does not measure style or quality.",
    }
  end
end
