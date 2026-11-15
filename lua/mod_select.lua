-- Selections and masks. The current selection is a weighted mask (1..255)
-- persisted in the document; in live mode it mirrors the editor selection.
-- Shape operations take mode = replace | add | subtract | intersect | xor.
return function(M, H)
  local OPS, QUERIES = M.OPS, M.QUERIES
  local fail, Mask = H.fail, H.Mask
  local findLayer, findFrame, frameList = H.findLayer, H.findFrame, H.frameList
  local pixelValue, transparentValue = H.pixelValue, H.transparentValue

  local function combine(a, b, mode)
    mode = mode or "replace"
    if mode == "replace" then return b end
    local out = Mask.clone(a)
    if mode == "add" then
      Mask.each(b, function(x, y, v) Mask.set(out, x, y, math.max(v, Mask.get(a, x, y))) end)
    elseif mode == "subtract" then
      Mask.each(b, function(x, y, v)
        local cur = Mask.get(a, x, y)
        if cur > 0 then Mask.set(out, x, y, math.floor(cur * (255 - v) / 255)) end
      end)
    elseif mode == "intersect" then
      out = Mask.new()
      Mask.each(a, function(x, y, v)
        local w = math.min(v, Mask.get(b, x, y))
        if w > 0 then Mask.set(out, x, y, w) end
      end)
    elseif mode == "xor" then
      Mask.each(b, function(x, y, v)
        if Mask.get(a, x, y) > 0 then Mask.set(out, x, y, 0) else Mask.set(out, x, y, v) end
      end)
    else
      fail("unknown selection mode '" .. tostring(mode) .. "'")
    end
    return out
  end
  H.combineMasks = combine

  local function apply(spr, op, shape)
    Mask.clip(shape, spr.width, spr.height)
    local cur = H.selection(spr)
    local m = combine(cur, shape, op.mode)
    H.setSelection(spr, m)
    return { selected = m.n, bounds = Mask.bounds(m) }
  end

  local function inCanvas(spr, x, y) return x >= 0 and y >= 0 and x < spr.width and y < spr.height end

  OPS["sel.rect"] = function(spr, op)
    local m = Mask.new()
    for y = op.y, op.y + op.height - 1 do
      for x = op.x, op.x + op.width - 1 do
        if inCanvas(spr, x, y) then Mask.set(m, x, y, 255) end
      end
    end
    return apply(spr, op, m)
  end

  OPS["sel.ellipse"] = function(spr, op)
    local m = Mask.new()
    H.ellipse(function(xa, xb, y)
      for x = math.min(xa, xb), math.max(xa, xb) do
        if inCanvas(spr, x, y) then Mask.set(m, x, y, 255) end
      end
    end, op.x, op.y, op.x + op.width - 1, op.y + op.height - 1)
    return apply(spr, op, m)
  end

  -- Polygon / lasso: even-odd fill of the closed path plus its outline.
  OPS["sel.polygon"] = function(spr, op)
    local m = Mask.new()
    local function mark(x, y) if inCanvas(spr, x, y) then Mask.set(m, x, y, 255) end end
    H.polygonSpans(op.points, function(xa, xb, y) for x = xa, xb do mark(x, y) end end)
    local pts = op.points
    for i = 1, #pts do
      local a, b = pts[i], pts[i % #pts + 1]
      H.line(mark, a.x, a.y, b.x, b.y)
    end
    return apply(spr, op, m)
  end

  -- Pixels of a layer (or the flattened frame) to test colors against.
  local function sourceImage(spr, op)
    local frame = op.frame or 1
    return H.renderFrame(spr, frame, op.layer)
  end

  local function close(p, q, tol)
    local pc = H.pc
    if pc.rgbaA(p) == 0 and pc.rgbaA(q) == 0 then return true end
    return math.abs(pc.rgbaR(p) - pc.rgbaR(q)) <= tol and math.abs(pc.rgbaG(p) - pc.rgbaG(q)) <= tol
      and math.abs(pc.rgbaB(p) - pc.rgbaB(q)) <= tol and math.abs(pc.rgbaA(p) - pc.rgbaA(q)) <= tol
  end

  -- Magic wand: contiguous pixels similar to the seed.
  OPS["sel.wand"] = function(spr, op)
    local img = sourceImage(spr, op)
    if not inCanvas(spr, op.x, op.y) then fail("seed is outside the canvas") end
    local seed = img:getPixel(op.x, op.y)
    local tol = op.tolerance or 0
    local m = Mask.new()
    H.flood(img, op.x, op.y, function(p) return close(p, seed, tol) end, function(x, y) Mask.set(m, x, y, 255) end, op.diagonal)
    return apply(spr, op, m)
  end

  -- Every pixel matching a color (global select by color).
  OPS["sel.color"] = function(spr, op)
    local img = sourceImage(spr, op)
    local r, g, b, a = H.rgbaOf(spr, op.color)
    local ref = H.pc.rgba(r, g, b, a)
    local tol = op.tolerance or 0
    local m = Mask.new()
    for it in img:pixels() do
      if close(it(), ref, tol) then Mask.set(m, it.x, it.y, 255) end
    end
    return apply(spr, op, m)
  end

  -- Opaque pixels of a layer (alpha >= threshold); alpha becomes the weight when soft=true.
  OPS["sel.alpha"] = function(spr, op)
    local img = sourceImage(spr, op)
    local thr = op.threshold or 1
    local m = Mask.new()
    for it in img:pixels() do
      local a = H.pc.rgbaA(it())
      if a >= thr then Mask.set(m, it.x, it.y, op.soft and a or 255) end
    end
    return apply(spr, op, m)
  end

  OPS["sel.all"] = function(spr, op)
    return OPS["sel.rect"](spr, { x = 0, y = 0, width = spr.width, height = spr.height, mode = "replace" })
  end

  OPS["sel.none"] = function(spr)
    H.setSelection(spr, Mask.new())
    return { selected = 0 }
  end

  OPS["sel.invert"] = function(spr)
    local cur = H.selection(spr)
    local m = Mask.new()
    for y = 0, spr.height - 1 do
      for x = 0, spr.width - 1 do
        local v = 255 - Mask.get(cur, x, y)
        if v > 0 then Mask.set(m, x, y, v) end
      end
    end
    H.setSelection(spr, m)
    return { selected = m.n, bounds = Mask.bounds(m) }
  end

  local N4 = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }
  local N8 = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 }, { 1, 1 }, { -1, -1 }, { 1, -1 }, { -1, 1 } }

  local function grow(spr, m, by, square)
    local nb = square and N8 or N4
    for _ = 1, by do
      local out = Mask.clone(m)
      Mask.each(m, function(x, y, v)
        for _, d in ipairs(nb) do
          local nx, ny = x + d[1], y + d[2]
          if inCanvas(spr, nx, ny) and Mask.get(out, nx, ny) < v then Mask.set(out, nx, ny, v) end
        end
      end)
      m = out
    end
    return m
  end

  local function shrink(spr, m, by, square)
    local nb = square and N8 or N4
    for _ = 1, by do
      local out = Mask.clone(m)
      Mask.each(m, function(x, y)
        for _, d in ipairs(nb) do
          if Mask.get(m, x + d[1], y + d[2]) == 0 then Mask.set(out, x, y, 0); break end
        end
      end)
      m = out
    end
    return m
  end

  OPS["sel.expand"] = function(spr, op)
    local m = grow(spr, H.selection(spr), op.by or 1, op.square)
    H.setSelection(spr, m)
    return { selected = m.n, bounds = Mask.bounds(m) }
  end

  OPS["sel.contract"] = function(spr, op)
    local m = shrink(spr, H.selection(spr), op.by or 1, op.square)
    H.setSelection(spr, m)
    return { selected = m.n, bounds = Mask.bounds(m) }
  end

  -- Soft edge: weights fall off linearly over `radius` px outside the selection.
  OPS["sel.feather"] = function(spr, op)
    local cur = H.selection(spr)
    if cur.n == 0 then fail("nothing is selected") end
    local radius = op.radius or 2
    local out = Mask.clone(cur)
    local ring = cur
    for step = 1, radius do
      local nextRing = Mask.new()
      local w = math.floor(255 * (radius - step + 1) / (radius + 1))
      Mask.each(ring, function(x, y)
        for _, d in ipairs(N4) do
          local nx, ny = x + d[1], y + d[2]
          if inCanvas(spr, nx, ny) and Mask.get(out, nx, ny) == 0 then
            Mask.set(out, nx, ny, w)
            Mask.set(nextRing, nx, ny, 1)
          end
        end
      end)
      ring = nextRing
    end
    if op.inside then
      -- also soften the inner edge
      local inner = shrink(spr, cur, radius, false)
      Mask.each(cur, function(x, y, v)
        if Mask.get(inner, x, y) == 0 then Mask.set(out, x, y, math.floor(v * 0.6)) end
      end)
    end
    H.setSelection(spr, out)
    return { selected = out.n, bounds = Mask.bounds(out) }
  end

  -- Ring of `width` px along the selection edge (inside).
  OPS["sel.border"] = function(spr, op)
    local cur = H.selection(spr)
    local inner = shrink(spr, cur, op.width or 1, op.square)
    local m = Mask.new()
    Mask.each(cur, function(x, y, v) if Mask.get(inner, x, y) == 0 then Mask.set(m, x, y, v) end end)
    H.setSelection(spr, m)
    return { selected = m.n, bounds = Mask.bounds(m) }
  end

  local function namedMasks(spr)
    return H.getProp(spr, "masks") or {}
  end

  OPS["sel.save"] = function(spr, op)
    local masks = namedMasks(spr)
    local cur = H.selection(spr)
    masks[op.name] = Mask.encode(cur)
    H.setProp(spr, "masks", masks)
    return { name = op.name, selected = cur.n }
  end

  OPS["sel.load"] = function(spr, op)
    local masks = namedMasks(spr)
    if not masks[op.name] then
      local names = {}
      for k in pairs(masks) do names[#names + 1] = k end
      table.sort(names)
      fail("no saved selection '" .. op.name .. "' (saved: " .. (#names > 0 and table.concat(names, ", ") or "none") .. ")")
    end
    return apply(spr, op, Mask.decode(masks[op.name]))
  end

  -- Boolean combination of saved masks into the current selection.
  OPS["sel.combine"] = function(spr, op)
    local masks = namedMasks(spr)
    local acc
    for i, name in ipairs(op.masks) do
      if not masks[name] then fail("no saved selection '" .. name .. "'") end
      local m = Mask.decode(masks[name])
      acc = i == 1 and m or combine(acc, m, op.operation)
    end
    H.setSelection(spr, acc)
    return { selected = acc.n, bounds = Mask.bounds(acc) }
  end

  QUERIES["sel.info"] = function(spr)
    local cur = H.selection(spr)
    local soft = 0
    Mask.each(cur, function(_, _, v) if v < 255 then soft = soft + 1 end end)
    local names = {}
    for k in pairs(namedMasks(spr)) do names[#names + 1] = k end
    table.sort(names)
    return { selected = cur.n, soft = soft, bounds = Mask.bounds(cur), saved = names }
  end

  -- Selection as a grid: '#' fully selected, '+' partially, '.' not.
  QUERIES["sel.read"] = function(spr, args)
    local cur = H.selection(spr)
    local b = Mask.bounds(cur)
    if not b then return { selected = 0, rows = {} } end
    local x0, y0 = args.x or b.x, args.y or b.y
    local w, h = args.width or b.width, args.height or b.height
    if w * h > 16384 then fail("region too large; pass x/y/width/height") end
    local rows = {}
    for y = y0, y0 + h - 1 do
      local r = {}
      for x = x0, x0 + w - 1 do
        local v = Mask.get(cur, x, y)
        r[#r + 1] = v == 255 and "#" or (v > 0 and "+" or ".")
      end
      rows[#rows + 1] = table.concat(r)
    end
    return { x = x0, y = y0, width = w, height = h, rows = rows, selected = cur.n }
  end

  local function requireSel(spr)
    local cur = H.selection(spr)
    if cur.n == 0 then fail("nothing is selected (use a sel.* operation first)") end
    return cur
  end

  -- Fill the selection. Soft weights use ordered dithering (dither=true) or alpha.
  OPS["sel.fill"] = function(spr, op)
    local cur = requireSel(spr)
    local layer = findLayer(spr, op.layer)
    local v = pixelValue(spr, op.color)
    local r, g, b, a = H.rgbaOf(spr, op.color)
    local n = 0
    for _, fnum in ipairs(frameList(spr, op)) do
      local frame = findFrame(spr, fnum)
      local img, cel = H.editableImage(spr, layer, frame)
      Mask.each(cur, function(x, y, w)
        if w >= 255 then img:drawPixel(x, y, v); n = n + 1
        elseif op.soft == "alpha" and spr.colorMode == ColorMode.RGB then
          local cur_ = img:getPixel(x, y)
          local na = math.floor(a * w / 255)
          if na > H.pc.rgbaA(cur_) then img:drawPixel(x, y, H.pc.rgba(r, g, b, na)); n = n + 1 end
        else
          local threshold = (H.BAYER4[(y % 4) + 1][(x % 4) + 1] + 0.5) / 16
          if w / 255 > threshold then img:drawPixel(x, y, v); n = n + 1 end
        end
      end)
      H.commitImage(spr, layer, frame, img, cel)
    end
    return { pixels = n }
  end

  OPS["sel.erase"] = function(spr, op)
    local cur = requireSel(spr)
    local layer = findLayer(spr, op.layer)
    local tv = transparentValue(spr)
    local n = 0
    for _, fnum in ipairs(frameList(spr, op)) do
      local frame = findFrame(spr, fnum)
      local img, cel = H.editableImage(spr, layer, frame)
      Mask.each(cur, function(x, y)
        if img:getPixel(x, y) ~= tv then img:drawPixel(x, y, tv); n = n + 1 end
      end)
      H.commitImage(spr, layer, frame, img, cel)
    end
    return { pixels = n }
  end

  -- Outline the selection edge with a color (inside the selection).
  OPS["sel.stroke"] = function(spr, op)
    local cur = requireSel(spr)
    local layer = findLayer(spr, op.layer)
    local v = pixelValue(spr, op.color)
    local width = op.width or 1
    local inner = shrink(spr, cur, width, false)
    local n = 0
    for _, fnum in ipairs(frameList(spr, op)) do
      local frame = findFrame(spr, fnum)
      local img, cel = H.editableImage(spr, layer, frame)
      Mask.each(cur, function(x, y)
        if Mask.get(inner, x, y) == 0 then img:drawPixel(x, y, v); n = n + 1 end
      end)
      H.commitImage(spr, layer, frame, img, cel)
    end
    return { pixels = n }
  end

  -- Copy (or cut) selected pixels of a layer into a new layer.
  OPS["sel.to_layer"] = function(spr, op)
    local cur = requireSel(spr)
    local src = findLayer(spr, op.layer)
    H.checkLayerName(spr, op.name, false)
    local dst = spr:newLayer()
    dst.name = op.name
    dst.parent = src.parent
    dst.stackIndex = src.stackIndex + 1
    local tv = transparentValue(spr)
    local n = 0
    for _, fnum in ipairs(frameList(spr, op, "all")) do
      local frame = findFrame(spr, fnum)
      if src:cel(fnum) then
        local img, cel = H.editableImage(spr, src, frame)
        local out = Image(spr.spec)
        out:clear(tv)
        Mask.each(cur, function(x, y)
          local p = img:getPixel(x, y)
          if p ~= tv then
            out:drawPixel(x, y, p)
            n = n + 1
            if op.cut then img:drawPixel(x, y, tv) end
          end
        end)
        if op.cut then H.commitImage(spr, src, frame, img, cel) end
        H.commitImage(spr, dst, frame, out, nil)
      end
    end
    return { path = H.pathOf(spr, dst), pixels = n }
  end

  -- Move the selected pixels (and the selection) by dx, dy.
  OPS["sel.move_pixels"] = function(spr, op)
    local cur = requireSel(spr)
    local layer = findLayer(spr, op.layer)
    local dx, dy = op.dx or 0, op.dy or 0
    local tv = transparentValue(spr)
    local n = 0
    for _, fnum in ipairs(frameList(spr, op)) do
      local frame = findFrame(spr, fnum)
      local img, cel = H.editableImage(spr, layer, frame)
      local moved = {}
      Mask.each(cur, function(x, y)
        local p = img:getPixel(x, y)
        if p ~= tv then moved[#moved + 1] = { x + dx, y + dy, p } end
        img:drawPixel(x, y, tv)
      end)
      for _, m in ipairs(moved) do
        if inCanvas(spr, m[1], m[2]) then img:drawPixel(m[1], m[2], m[3]); n = n + 1 end
      end
      H.commitImage(spr, layer, frame, img, cel)
    end
    local shifted = Mask.new()
    Mask.each(cur, function(x, y, v) if inCanvas(spr, x + dx, y + dy) then Mask.set(shifted, x + dx, y + dy, v) end end)
    H.setSelection(spr, shifted)
    return { pixels = n }
  end

  OPS["sel.crop_canvas"] = function(spr, op)
    local cur = requireSel(spr)
    local b = Mask.bounds(cur)
    spr:crop(b.x, b.y, b.width, b.height)
    local shifted = Mask.new()
    Mask.each(cur, function(x, y, v) Mask.set(shifted, x - b.x, y - b.y, v) end)
    H.setSelection(spr, shifted)
    return { x = b.x, y = b.y, width = b.width, height = b.height }
  end
end
