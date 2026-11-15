-- Drawing primitives, patterns and pixel-preserving transforms.
return function(M, H)
  local OPS = M.OPS
  local fail, round, pc, Mask = H.fail, H.round, H.pc, H.Mask
  local findLayer, findFrame, frameList = H.findLayer, H.findFrame, H.frameList
  local pixelValue, transparentValue, withCel = H.pixelValue, H.transparentValue, H.withCel
  local editableImage, commitImage = H.editableImage, H.commitImage

  local DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"

  -- Palette-index grid: each char is a base-36 index ('.' = unchanged) or maps through legend.
  OPS["draw.index_map"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    local pal = spr.palettes[1]
    local legend = op.legend or {}
    local function valueOf(ch, row, col)
      local idx = legend[ch]
      if idx == nil then
        local d = DIGITS:find(ch:lower(), 1, true)
        if not d then fail(string.format("row %d col %d: '%s' is not a base-36 index and not in the legend", row, col, ch)) end
        idx = d - 1
      end
      if idx >= #pal then fail(string.format("row %d col %d: palette index %d out of range (%d colors)", row, col, idx, #pal)) end
      if spr.colorMode == ColorMode.INDEXED then return idx end
      local c = pal:getColor(idx)
      return H.encode(spr, c.red, c.green, c.blue, c.alpha)
    end
    local mask = op.inSelection and H.selection(spr) or nil
    local total = 0
    for _, fnum in ipairs(frameList(spr, op)) do
      local n = H.drawGrid(spr, layer, findFrame(spr, fnum), op.rows, valueOf, op.x or 0, op.y or 0, { mask = mask })
      total = total + n
    end
    return { pixels = total }
  end

  -- Sparse patch: runs of characters at given positions (good for small fixes).
  OPS["draw.patch"] = function(spr, op)
    local values = {}
    for ch, c in pairs(op.legend) do values[ch] = pixelValue(spr, c) end
    return withCel(spr, op, function(_, put)
      for i, run in ipairs(op.runs) do
        for k = 1, #run.s do
          local ch = run.s:sub(k, k)
          if ch ~= "." and ch ~= " " then
            local v = values[ch]
            if v == nil then fail(string.format("run %d: '%s' is not in the legend", i, ch)) end
            if run.vertical then put(run.x, run.y + k - 1, v) else put(run.x + k - 1, run.y, v) end
          end
        end
      end
    end)
  end

  local function bezierPoints(pts, steps)
    local out = {}
    local n = #pts
    for i = 0, steps do
      local t = i / steps
      local x, y
      if n == 3 then
        local u = 1 - t
        x = u * u * pts[1].x + 2 * u * t * pts[2].x + t * t * pts[3].x
        y = u * u * pts[1].y + 2 * u * t * pts[2].y + t * t * pts[3].y
      else
        local u = 1 - t
        x = u ^ 3 * pts[1].x + 3 * u * u * t * pts[2].x + 3 * u * t * t * pts[3].x + t ^ 3 * pts[4].x
        y = u ^ 3 * pts[1].y + 3 * u * u * t * pts[2].y + 3 * u * t * t * pts[3].y + t ^ 3 * pts[4].y
      end
      out[#out + 1] = { x = round(x), y = round(y) }
    end
    return out
  end

  -- Pixel-perfect filter: drop the corner pixel of L-shaped steps in a 1px path.
  local function pixelPerfect(path)
    local out = {}
    local i = 1
    while i <= #path do
      local p = path[i]
      if #out >= 1 and i < #path then
        local a, c = out[#out], path[i + 1]
        if (a.x == p.x or a.y == p.y) and (c.x == p.x or c.y == p.y) and a.x ~= c.x and a.y ~= c.y then
          i = i + 1 -- skip p (the elbow)
          goto continue
        end
      end
      out[#out + 1] = p
      i = i + 1
      ::continue::
    end
    return out
  end
  H.pixelPerfect = pixelPerfect

  local function tracePath(points)
    local path, seen = {}, {}
    for i = 1, #points - 1 do
      H.line(function(x, y)
        local k = y * 65536 + x
        if not seen[k] then seen[k] = true; path[#path + 1] = { x = x, y = y } end
      end, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y)
    end
    return path
  end
  H.tracePath = tracePath

  OPS["draw.curve"] = function(spr, op)
    if #op.points ~= 3 and #op.points ~= 4 then fail("curve needs 3 (quadratic) or 4 (cubic) points") end
    return withCel(spr, op, function(_, put)
      local len = 0
      for i = 1, #op.points - 1 do
        len = len + math.abs(op.points[i + 1].x - op.points[i].x) + math.abs(op.points[i + 1].y - op.points[i].y)
      end
      local path = tracePath(bezierPoints(op.points, math.max(8, len * 2)))
      if op.pixelPerfect ~= false then path = pixelPerfect(path) end
      for _, p in ipairs(path) do put(p.x, p.y) end
    end)
  end

  OPS["draw.polygon"] = function(spr, op)
    return withCel(spr, op, function(_, put)
      local fillV = pixelValue(spr, op.color)
      H.polygonSpans(op.points, function(xa, xb, y) for x = xa, xb do put(x, y, fillV) end end)
      local outline = op.outlineColor and pixelValue(spr, op.outlineColor) or nil
      if outline then
        local pts = op.points
        for i = 1, #pts do
          local a, b = pts[i], pts[i % #pts + 1]
          H.line(function(x, y) put(x, y, outline) end, a.x, a.y, b.x, b.y)
        end
      end
    end)
  end

  local function brushOffsets(shape, size)
    local out = {}
    local r = (size - 1) / 2
    for dy = 0, size - 1 do
      for dx = 0, size - 1 do
        local ox, oy = dx - math.floor(r), dy - math.floor(r)
        if shape == "square" or size <= 2 or ((dx - r) ^ 2 + (dy - r) ^ 2 <= (r + 0.35) ^ 2) then out[#out + 1] = { ox, oy } end
      end
    end
    return out
  end

  OPS["draw.brush_stroke"] = function(spr, op)
    local offsets = brushOffsets(op.shape or "circle", op.size or 1)
    return withCel(spr, op, function(_, put)
      local pts = op.points
      if #pts == 1 then pts = { pts[1], pts[1] } end
      local spacing = op.spacing or 1
      local path = tracePath(pts)
      for i, p in ipairs(path) do
        if (i - 1) % spacing == 0 then
          for _, o in ipairs(offsets) do put(p.x + o[1], p.y + o[2]) end
        end
      end
    end)
  end

  -- Tile a small pattern over a rectangle (or the selection with inSelection).
  OPS["draw.pattern_fill"] = function(spr, op)
    local values = {}
    for ch, c in pairs(op.legend) do values[ch] = pixelValue(spr, c) end
    local ph = #op.rows
    local pw = 0
    for _, r in ipairs(op.rows) do pw = math.max(pw, #r) end
    return withCel(spr, op, function(_, put)
      local x0, y0 = op.x or 0, op.y or 0
      local w, h = op.width or spr.width, op.height or spr.height
      local ox, oy = op.offsetX or 0, op.offsetY or 0
      for y = y0, y0 + h - 1 do
        for x = x0, x0 + w - 1 do
          local row = op.rows[((y - y0 + oy) % ph) + 1]
          local cx = ((x - x0 + ox) % pw) + 1
          local ch = row:sub(cx, cx)
          if ch ~= "" and ch ~= "." and ch ~= " " then
            local v = values[ch]
            if v == nil then fail("pattern character '" .. ch .. "' is not in the legend") end
            put(x, y, v)
          end
        end
      end
    end)
  end

  OPS["draw.radial_gradient"] = function(spr, op)
    return withCel(spr, op, function(_, put)
      local stops = {}
      for i, c in ipairs(op.colors) do stops[i] = pixelValue(spr, c) end
      local n = #stops
      local cx, cy, rad = op.cx, op.cy, op.radius
      local dither = op.dither ~= false
      for y = math.max(0, cy - rad), math.min(spr.height - 1, cy + rad) do
        for x = math.max(0, cx - rad), math.min(spr.width - 1, cx + rad) do
          local d = math.sqrt((x - cx) ^ 2 + (y - cy) ^ 2) / rad
          if d <= 1 then
            local pos = d * (n - 1)
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
      end
    end)
  end

  -- Two-color ordered dither at a fixed density (0 = all colorA, 1 = all colorB).
  OPS["draw.dither_fill"] = function(spr, op)
    return withCel(spr, op, function(_, put)
      local a = pixelValue(spr, op.color)
      local b = op.color2 and pixelValue(spr, op.color2) or nil
      local x0, y0 = op.x or 0, op.y or 0
      local w, h = op.width or spr.width, op.height or spr.height
      local density = op.density or 0.5
      for y = y0, y0 + h - 1 do
        for x = x0, x0 + w - 1 do
          local threshold = (H.BAYER4[(y % 4) + 1][(x % 4) + 1] + 0.5) / 16
          if density > threshold then
            if b then put(x, y, b) end
          else
            put(x, y, a)
          end
        end
      end
    end)
  end

  -- Symmetry: copy one half of the cel onto the other, mirrored.
  OPS["draw.mirror"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    local source = op.source or "left"
    local n = 0
    for _, fnum in ipairs(frameList(spr, op)) do
      local frame = findFrame(spr, fnum)
      local img, cel = editableImage(spr, layer, frame)
      local w, h = img.width, img.height
      local axis = op.axis -- pixel column/row of the mirror line (default canvas center)
      if source == "left" or source == "right" then
        local c = axis or (w - 1) / 2
        for y = 0, h - 1 do
          for x = 0, w - 1 do
            local isSrc = (source == "left" and x <= c) or (source == "right" and x >= c)
            if isSrc then
              local mx = round(2 * c - x)
              if mx ~= x and mx >= 0 and mx < w then img:drawPixel(mx, y, img:getPixel(x, y)); n = n + 1 end
            end
          end
        end
      else
        local c = axis or (h - 1) / 2
        for y = 0, h - 1 do
          for x = 0, w - 1 do
            local isSrc = (source == "top" and y <= c) or (source == "bottom" and y >= c)
            if isSrc then
              local my = round(2 * c - y)
              if my ~= y and my >= 0 and my < h then img:drawPixel(x, my, img:getPixel(x, y)); n = n + 1 end
            end
          end
        end
      end
      commitImage(spr, layer, frame, img, cel)
    end
    return { pixels = n }
  end

  -- Repeat a region: stamp copies `count` times stepping by dx/dy (or a cols x rows grid).
  OPS["draw.repeat"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    local frame = findFrame(spr, op.frame)
    local img, cel = editableImage(spr, layer, frame)
    local tv = transparentValue(spr)
    local region = Image(op.width, op.height, spr.colorMode)
    region:clear(tv)
    region:drawImage(img, Point(-op.x, -op.y), 255, BlendMode.SRC)
    local cols, rows = op.cols or ((op.count or 1) + 1), op.rows or 1
    local dx, dy = op.dx or op.width, op.dy or (op.rows and op.height or 0)
    local stamps = 0
    for r = 0, rows - 1 do
      for c = 0, cols - 1 do
        if not (r == 0 and c == 0 and not op.includeSource) then
          local ox, oy = op.x + c * dx, op.y + r * dy
          if op.rows == nil then ox, oy = op.x + c * dx, op.y + c * (op.dy or 0) end
          for it in region:pixels() do
            local v = it()
            local x, y = ox + it.x, oy + it.y
            if v ~= tv and x >= 0 and y >= 0 and x < img.width and y < img.height then img:drawPixel(x, y, v) end
          end
          stamps = stamps + 1
        end
      end
    end
    commitImage(spr, layer, frame, img, cel)
    return { stamps = stamps }
  end

  -- Shadow: color the pixels at (p + offset) that are transparent, for every opaque p.
  OPS["draw.drop_shadow"] = function(spr, op)
    local src = findLayer(spr, op.layer)
    local dst = op.toLayer and findLayer(spr, op.toLayer) or src
    local v = pixelValue(spr, op.color)
    local dx, dy = op.dx or 1, op.dy or 1
    local n = 0
    for _, fnum in ipairs(frameList(spr, op)) do
      local frame = findFrame(spr, fnum)
      local simg = editableImage(spr, src, frame)
      local dimg, dcel = editableImage(spr, dst, frame)
      local base = dst == src and simg:clone() or simg
      for it in base:pixels() do
        if H.isOpaque(spr, it()) then
          local x, y = it.x + dx, it.y + dy
          if x >= 0 and y >= 0 and x < spr.width and y < spr.height and not H.isOpaque(spr, base:getPixel(x, y)) then
            if dst ~= src or not H.isOpaque(spr, dimg:getPixel(x, y)) then dimg:drawPixel(x, y, v); n = n + 1 end
          end
        end
      end
      commitImage(spr, dst, frame, dimg, dcel)
    end
    return { pixels = n }
  end

  local LIGHT = {
    ["top-left"] = { -1, -1 }, top = { 0, -1 }, ["top-right"] = { 1, -1 }, left = { -1, 0 },
    right = { 1, 0 }, ["bottom-left"] = { -1, 1 }, bottom = { 0, 1 }, ["bottom-right"] = { 1, 1 },
  }
  H.LIGHT = LIGHT

  -- Rim light: recolor opaque edge pixels facing the light; optional shadow on the far side.
  OPS["draw.rim_light"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    local d = LIGHT[op.light or "top-left"]
    local hv = op.color and pixelValue(spr, op.color) or nil
    local sv = op.shadowColor and pixelValue(spr, op.shadowColor) or nil
    local depth = op.depth or 1
    local only = {}
    if op.onlyColors then for _, c in ipairs(op.onlyColors) do only[pixelValue(spr, c)] = true end end
    local lit, shaded = 0, 0
    for _, fnum in ipairs(frameList(spr, op)) do
      local frame = findFrame(spr, fnum)
      local img, cel = editableImage(spr, layer, frame)
      local src = img:clone()
      local w, h = img.width, img.height
      local function op_(x, y)
        if x < 0 or y < 0 or x >= w or y >= h then return false end
        return H.isOpaque(spr, src:getPixel(x, y))
      end
      for y = 0, h - 1 do
        for x = 0, w - 1 do
          local v = src:getPixel(x, y)
          if H.isOpaque(spr, v) and (not op.onlyColors or only[v]) then
            local towardLight, awayLight = false, false
            for k = 1, depth do
              if not op_(x + d[1] * k, y + d[2] * k) then towardLight = true end
              if not op_(x - d[1] * k, y - d[2] * k) then awayLight = true end
            end
            if towardLight and hv then img:drawPixel(x, y, hv); lit = lit + 1
            elseif awayLight and sv then img:drawPixel(x, y, sv); shaded = shaded + 1 end
          end
        end
      end
      commitImage(spr, layer, frame, img, cel)
    end
    return { lit = lit, shaded = shaded }
  end

  -- Deterministic scatter (texture noise) of colors over a region.
  OPS["draw.scatter"] = function(spr, op)
    local values = {}
    for i, c in ipairs(op.colors) do values[i] = pixelValue(spr, c) end
    local rand = H.rng(op.seed or 1)
    return withCel(spr, op, function(img, put)
      local x0, y0 = op.x or 0, op.y or 0
      local w, h = op.width or spr.width, op.height or spr.height
      local density = op.density or 0.1
      for y = y0, y0 + h - 1 do
        for x = x0, x0 + w - 1 do
          local r1, r2 = rand(), rand()
          if r1 < density then
            local inside = x >= 0 and y >= 0 and x < img.width and y < img.height
            if inside and (not op.onOpaque or H.isOpaque(spr, img:getPixel(x, y))) then
              put(x, y, values[math.floor(r2 * #values) + 1])
            end
          end
        end
      end
    end)
  end

  -- Stamp a stored pattern (rows + legend resolved by the server), optionally flipped / tiled.
  OPS["pattern.stamp"] = function(spr, op)
    local rows = op.rows
    if op.flipX then
      local out = {}
      for i, r in ipairs(rows) do out[i] = r:reverse() end
      rows = out
    end
    if op.flipY then
      local out = {}
      for i = #rows, 1, -1 do out[#out + 1] = rows[i] end
      rows = out
    end
    local values = {}
    for ch, c in pairs(op.legend) do values[ch] = pixelValue(spr, c) end
    local layer = findLayer(spr, op.layer)
    local pw = 0
    for _, r in ipairs(rows) do pw = math.max(pw, #r) end
    local count = op.count or 1
    local total = 0
    for _, fnum in ipairs(frameList(spr, op)) do
      for i = 0, count - 1 do
        local n = H.drawGrid(spr, layer, findFrame(spr, fnum), rows, function(ch)
          local v = values[ch]
          if v == nil then fail("pattern character '" .. ch .. "' is not in the legend") end
          return v
        end, (op.x or 0) + i * (op.dx or pw), (op.y or 0) + i * (op.dy or 0))
        total = total + n
      end
    end
    return { pixels = total }
  end

  -------------------------------------------------------------------------
  -- Transforms
  -------------------------------------------------------------------------

  -- Arbitrary-angle rotation with nearest-neighbour sampling (no new colors).
  OPS["xf.rotate_nn"] = function(spr, op)
    local a = math.rad(op.angle)
    local cosA, sinA = math.cos(a), math.sin(a)
    local layer = findLayer(spr, op.layer)
    for _, fnum in ipairs(frameList(spr, op)) do
      local frame = findFrame(spr, fnum)
      if layer:cel(fnum) then
        local src, cel = editableImage(spr, layer, frame)
        local w, h = src.width, src.height
        local cx, cy = op.cx or (w - 1) / 2, op.cy or (h - 1) / 2
        local out = Image(spr.spec)
        local tv = transparentValue(spr)
        out:clear(tv)
        for y = 0, h - 1 do
          for x = 0, w - 1 do
            -- inverse mapping
            local dx, dy = x - cx, y - cy
            local sx = round(cx + dx * cosA + dy * sinA)
            local sy = round(cy - dx * sinA + dy * cosA)
            if sx >= 0 and sy >= 0 and sx < w and sy < h then
              local v = src:getPixel(sx, sy)
              if v ~= tv then out:drawPixel(x, y, v) end
            end
          end
        end
        commitImage(spr, layer, frame, out, cel)
      end
    end
    return {}
  end

  OPS["xf.shear"] = function(spr, op)
    local kx, ky = op.x or 0, op.y or 0
    return H.transformCel(spr, op, function(x, y, w, h)
      local cx, cy = (w - 1) / 2, (h - 1) / 2
      return round(x + kx * (y - cy)), round(y + ky * (x - cx))
    end)
  end

  -- Scale a layer's content (nearest-neighbour) around a pivot (default: content center).
  OPS["xf.scale_layer"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    local sx, sy = op.scaleX or op.factor, op.scaleY or op.factor
    if not sx or not sy then fail("pass factor or scaleX/scaleY") end
    for _, fnum in ipairs(frameList(spr, op)) do
      local frame = findFrame(spr, fnum)
      if layer:cel(fnum) then
        local src, cel = editableImage(spr, layer, frame)
        local tv = transparentValue(spr)
        local b = src:shrinkBounds(tv)
        local px = op.pivotX or (b.x + b.width / 2)
        local py = op.pivotY or (b.y + b.height / 2)
        local out = Image(spr.spec)
        out:clear(tv)
        for y = 0, src.height - 1 do
          for x = 0, src.width - 1 do
            local srcX = math.floor((x + 0.5 - px) / sx + px)
            local srcY = math.floor((y + 0.5 - py) / sy + py)
            if srcX >= 0 and srcY >= 0 and srcX < src.width and srcY < src.height then
              local v = src:getPixel(srcX, srcY)
              if v ~= tv then out:drawPixel(x, y, v) end
            end
          end
        end
        commitImage(spr, layer, frame, out, cel)
      end
    end
    return {}
  end

  local function layerContent(spr, layer, frames)
    local u
    for _, fnum in ipairs(frames) do
      local cel = layer:cel(fnum)
      if cel then
        local r = cel.image:shrinkBounds(transparentValue(spr))
        if not r.isEmpty then
          local x0, y0 = cel.position.x + r.x, cel.position.y + r.y
          local x1, y1 = x0 + r.width - 1, y0 + r.height - 1
          if not u then u = { x0 = x0, y0 = y0, x1 = x1, y1 = y1 } else
            u.x0, u.y0, u.x1, u.y1 = math.min(u.x0, x0), math.min(u.y0, y0), math.max(u.x1, x1), math.max(u.y1, y1)
          end
        end
      end
    end
    return u
  end
  H.layerContent = layerContent

  -- Align layer content to the canvas (one offset for all frames keeps motion intact).
  OPS["xf.align"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    local frames = frameList(spr, op, "all")
    local m = op.margin or 0
    local function offsetFor(u)
      local dx, dy = 0, 0
      if op.x == "left" then dx = m - u.x0 elseif op.x == "right" then dx = spr.width - 1 - m - u.x1
      elseif op.x == "center" then dx = math.floor((spr.width - (u.x1 - u.x0 + 1)) / 2) - u.x0 end
      if op.y == "top" then dy = m - u.y0 elseif op.y == "bottom" then dy = spr.height - 1 - m - u.y1
      elseif op.y == "middle" then dy = math.floor((spr.height - (u.y1 - u.y0 + 1)) / 2) - u.y0 end
      return dx, dy
    end
    local moved = 0
    if op.perFrame then
      for _, fnum in ipairs(frames) do
        local u = layerContent(spr, layer, { fnum })
        if u then
          local dx, dy = offsetFor(u)
          local cel = layer:cel(fnum)
          cel.position = Point(cel.position.x + dx, cel.position.y + dy)
          moved = moved + 1
        end
      end
    else
      local u = layerContent(spr, layer, frames)
      if not u then fail("layer has no content in the selected frames") end
      local dx, dy = offsetFor(u)
      for _, fnum in ipairs(frames) do
        local cel = layer:cel(fnum)
        if cel then cel.position = Point(cel.position.x + dx, cel.position.y + dy); moved = moved + 1 end
      end
    end
    return { cels = moved }
  end

  -- Distribute several layers' content evenly along an axis (frame-wise).
  OPS["xf.distribute"] = function(spr, op)
    if #op.layers < 3 then fail("distribute needs at least 3 layers") end
    local frames = frameList(spr, op)
    for _, fnum in ipairs(frames) do
      local items = {}
      for _, ref in ipairs(op.layers) do
        local l = findLayer(spr, ref)
        local u = layerContent(spr, l, { fnum })
        if u then items[#items + 1] = { layer = l, u = u } end
      end
      local horiz = (op.axis or "x") == "x"
      table.sort(items, function(a, b) if horiz then return a.u.x0 < b.u.x0 end return a.u.y0 < b.u.y0 end)
      if #items >= 3 then
        local first, last = items[1].u, items[#items].u
        local total = 0
        for _, it in ipairs(items) do total = total + (horiz and (it.u.x1 - it.u.x0 + 1) or (it.u.y1 - it.u.y0 + 1)) end
        local span = horiz and (last.x1 - first.x0 + 1) or (last.y1 - first.y0 + 1)
        local gap = (span - total) / (#items - 1)
        local pos = horiz and first.x0 or first.y0
        for _, it in ipairs(items) do
          local cur = horiz and it.u.x0 or it.u.y0
          local delta = round(pos) - cur
          local cel = it.layer:cel(fnum)
          if horiz then cel.position = Point(cel.position.x + delta, cel.position.y)
          else cel.position = Point(cel.position.x, cel.position.y + delta) end
          pos = pos + (horiz and (it.u.x1 - it.u.x0 + 1) or (it.u.y1 - it.u.y0 + 1)) + gap
        end
      end
    end
    return { frames = #frames }
  end

  -- Pivot used by engine exports (stored in the document; optional "pivot" slice).
  OPS["xf.set_pivot"] = function(spr, op)
    local x, y = op.x, op.y
    if op.anchor then
      local u = H.unionContent(spr)
      if not u then fail("sprite is empty; cannot place an anchor pivot") end
      if op.anchor == "bottom-center" or op.anchor == "feet" then x, y = math.floor((u.x0 + u.x1 + 1) / 2), u.y1 + 1
      elseif op.anchor == "center" then x, y = math.floor((u.x0 + u.x1 + 1) / 2), math.floor((u.y0 + u.y1 + 1) / 2)
      elseif op.anchor == "canvas-center" then x, y = math.floor(spr.width / 2), math.floor(spr.height / 2)
      elseif op.anchor == "canvas-bottom" then x, y = math.floor(spr.width / 2), spr.height end
    end
    if x == nil or y == nil then fail("pass x/y or an anchor") end
    H.setProp(spr, "pivot", { x = x, y = y })
    if op.slice then
      for _, s in ipairs(spr.slices) do if s.name == "pivot" then spr:deleteSlice(s) end end
      local s = spr:newSlice(Rectangle(0, 0, spr.width, spr.height))
      s.name = "pivot"
      s.pivot = Point(x, y)
    end
    return { x = x, y = y }
  end
end
