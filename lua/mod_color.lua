-- Palettes and color: sorting, dedupe, remapping, reduction, dithering, checks.
return function(M, H)
  local OPS, QUERIES = M.OPS, M.QUERIES
  local fail, round, pc = H.fail, H.round, H.pc
  local pixelValue, pixelRGBA = H.pixelValue, H.pixelRGBA

  -- Remap palette indices in every indexed image (cels and tileset tiles).
  local function remapIndices(spr, map)
    local seen = {}
    local function remapImage(img)
      local out = img:clone()
      local changed = false
      for it in out:pixels() do
        local v = it()
        local nv = map[v]
        if nv and nv ~= v then it(nv); changed = true end
      end
      return changed and out or nil
    end
    for _, e in ipairs(H.allLayers(spr)) do
      local l = e.layer
      if not l.isGroup and not l.isTilemap then
        for _, cel in ipairs(l.cels) do
          if not seen[cel.image.id] then
            seen[cel.image.id] = true
            local out = remapImage(cel.image)
            if out then cel.image = out end
          end
        end
      end
    end
    for _, ts in ipairs(spr.tilesets) do
      for i = 1, #ts - 1 do
        local tile = ts:tile(i)
        local out = remapImage(tile.image)
        if out then tile.image = out end
      end
    end
    if map[spr.transparentColor] then spr.transparentColor = map[spr.transparentColor] end
  end
  H.remapIndices = remapIndices

  local function paletteColors(spr)
    local pal = spr.palettes[1]
    local out = {}
    for i = 0, #pal - 1 do
      local c = pal:getColor(i)
      out[#out + 1] = { r = c.red, g = c.green, b = c.blue, a = c.alpha, index = i }
    end
    return out
  end
  H.paletteColors = paletteColors

  local function setPaletteList(spr, list)
    local pal = Palette(#list)
    for i, c in ipairs(list) do pal:setColor(i - 1, Color { r = c.r, g = c.g, b = c.b, a = c.a }) end
    spr:setPalette(pal)
  end
  H.setPaletteList = setPaletteList

  -- Count used colors over the image cels (key "#rrggbbaa" -> {r,g,b,a,n}).
  local function usedColors(spr, op)
    local used, order = {}, {}
    for _, cel in ipairs(H.targetCels(spr, op or {})) do
      for it in cel.image:pixels() do
        local r, g, b, a = pixelRGBA(spr, it(), cel.image.colorMode)
        if a > 0 then
          local k = H.hex(r, g, b, a)
          local e = used[k]
          if not e then e = { r = r, g = g, b = b, a = a, n = 0, hex = k }; used[k] = e; order[#order + 1] = e end
          e.n = e.n + 1
        end
      end
    end
    return used, order
  end
  H.usedColors = usedColors

  local SORTERS = {
    hue = function(c) local h, s, l = H.rgbToHsl(c.r, c.g, c.b); return (s < 0.08 and -1 or h) * 1000 + l end,
    luminance = function(c) return H.luminance(c.r, c.g, c.b) end,
    saturation = function(c) local _, s = H.rgbToHsl(c.r, c.g, c.b); return s end,
    lightness = function(c) local _, _, l = H.rgbToHsl(c.r, c.g, c.b); return l end,
  }

  OPS["pal.sort"] = function(spr, op)
    local list = paletteColors(spr)
    local keep = {}
    local start = 1
    if spr.colorMode == ColorMode.INDEXED and op.keepTransparentFirst ~= false and spr.transparentColor == 0 then
      keep[1] = table.remove(list, 1)
      start = 2
    end
    local key
    if op.by == "usage" then
      local used = usedColors(spr, {})
      key = function(c) return -((used[H.hex(c.r, c.g, c.b, c.a)] or { n = 0 }).n) end
    else
      key = SORTERS[op.by or "hue"]
      if not key then fail("unknown sort key '" .. tostring(op.by) .. "'") end
    end
    table.sort(list, function(a, b)
      local ka, kb = key(a), key(b)
      if ka == kb then return a.index < b.index end
      if op.descending then return ka > kb end
      return ka < kb
    end)
    local final = {}
    if keep[1] then final[1] = keep[1] end
    for _, c in ipairs(list) do final[#final + 1] = c end
    if spr.colorMode == ColorMode.INDEXED then
      local map = {}
      for newI, c in ipairs(final) do map[c.index] = newI - 1 end
      remapIndices(spr, map)
    end
    setPaletteList(spr, final)
    return { size = #final, from = start }
  end

  OPS["pal.dedupe"] = function(spr, _)
    local list = paletteColors(spr)
    local first, final, map = {}, {}, {}
    for _, c in ipairs(list) do
      local k = H.hex(c.r, c.g, c.b, c.a)
      if first[k] == nil then
        final[#final + 1] = c
        first[k] = #final - 1
      end
      map[c.index] = first[k]
    end
    if spr.colorMode == ColorMode.INDEXED then remapIndices(spr, map) end
    setPaletteList(spr, final)
    return { removed = #list - #final, size = #final }
  end

  OPS["pal.remove_unused"] = function(spr, _)
    local list = paletteColors(spr)
    local keepSet = {}
    if spr.colorMode == ColorMode.INDEXED then
      keepSet[spr.transparentColor] = true
      for _, cel in ipairs(H.targetCels(spr, {})) do
        for it in cel.image:pixels() do keepSet[it()] = true end
      end
      for _, ts in ipairs(spr.tilesets) do
        for i = 1, #ts - 1 do for it in ts:tile(i).image:pixels() do keepSet[it()] = true end end
      end
    else
      local used = usedColors(spr, {})
      for _, c in ipairs(list) do if used[H.hex(c.r, c.g, c.b, c.a)] then keepSet[c.index] = true end end
    end
    local final, map = {}, {}
    for _, c in ipairs(list) do
      if keepSet[c.index] then final[#final + 1] = c; map[c.index] = #final - 1 end
    end
    if #final == 0 then fail("every palette entry is unused; refusing to empty the palette") end
    if spr.colorMode == ColorMode.INDEXED then remapIndices(spr, map) end
    setPaletteList(spr, final)
    return { removed = #list - #final, size = #final }
  end

  OPS["pal.add_colors"] = function(spr, op)
    local list = paletteColors(spr)
    local have = {}
    for _, c in ipairs(list) do have[H.hex(c.r, c.g, c.b, c.a)] = true end
    local added = 0
    for _, c in ipairs(op.colors) do
      local r, g, b, a = H.rgbaOf(spr, c)
      local k = H.hex(r, g, b, a)
      if not have[k] then
        have[k] = true
        list[#list + 1] = { r = r, g = g, b = b, a = a }
        added = added + 1
      end
    end
    if #list > 256 then fail("palette would exceed 256 colors") end
    setPaletteList(spr, list)
    return { added = added, size = #list }
  end

  -- Many-to-many color mapping applied to pixels ({from, to} pairs, exact match).
  OPS["pal.remap"] = function(spr, op)
    if spr.colorMode == ColorMode.INDEXED and op.byIndex then
      local map = {}
      for _, m in ipairs(op.map) do
        if m.from.index == nil or m.to.index == nil then fail("byIndex needs palette indices in from/to") end
        map[m.from.index] = m.to.index
      end
      remapIndices(spr, map)
      return { mapped = #op.map }
    end
    local map = {}
    for _, m in ipairs(op.map) do
      local r, g, b, a = H.rgbaOf(spr, m.from)
      map[H.hex(r, g, b, a)] = { H.rgbaOf(spr, m.to) }
    end
    local n = H.mapPixels(spr, op, function(r, g, b, a)
      local t = map[H.hex(r, g, b, a)]
      if t then return t[1], t[2], t[3], t[4] end
    end)
    return { pixels = n }
  end

  -- Median cut over the used colors.
  local function medianCut(colors, n)
    local boxes = { colors }
    local function range(box)
      local lo, hi = { 255, 255, 255 }, { 0, 0, 0 }
      for _, c in ipairs(box) do
        local v = { c.r, c.g, c.b }
        for k = 1, 3 do lo[k] = math.min(lo[k], v[k]); hi[k] = math.max(hi[k], v[k]) end
      end
      local best, bestR = 1, -1
      for k = 1, 3 do if hi[k] - lo[k] > bestR then best, bestR = k, hi[k] - lo[k] end end
      return best, bestR
    end
    while #boxes < n do
      local bi, bestR, bestK = nil, 0, 1
      for i, box in ipairs(boxes) do
        if #box > 1 then
          local k, r = range(box)
          if r > bestR then bi, bestR, bestK = i, r, k end
        end
      end
      if not bi then break end
      local box = table.remove(boxes, bi)
      local key = ({ "r", "g", "b" })[bestK]
      table.sort(box, function(a, b) return a[key] < b[key] end)
      local total = 0
      for _, c in ipairs(box) do total = total + c.n end
      local acc, split = 0, 1
      for i, c in ipairs(box) do
        acc = acc + c.n
        if acc >= total / 2 then split = math.min(math.max(i, 1), #box - 1); break end
      end
      local a, b = {}, {}
      for i, c in ipairs(box) do if i <= split then a[#a + 1] = c else b[#b + 1] = c end end
      boxes[#boxes + 1] = a
      boxes[#boxes + 1] = b
    end
    local out = {}
    for _, box in ipairs(boxes) do
      local r, g, b, w = 0, 0, 0, 0
      for _, c in ipairs(box) do r, g, b, w = r + c.r * c.n, g + c.g * c.n, b + c.b * c.n, w + c.n end
      if w > 0 then out[#out + 1] = { r = round(r / w), g = round(g / w), b = round(b / w), a = 255 } end
    end
    table.sort(out, function(x, y) return H.luminance(x.r, x.g, x.b) < H.luminance(y.r, y.g, y.b) end)
    return out
  end
  H.medianCut = medianCut

  OPS["pal.reduce"] = function(spr, op)
    if spr.colorMode == ColorMode.INDEXED then fail("pal.reduce works on RGB sprites; convert with doc.set_color_mode first") end
    local _, order = usedColors(spr, op)
    if #order == 0 then fail("sprite has no opaque pixels") end
    local colors = medianCut(order, op.colors)
    local before = #order
    local list = {}
    for _, c in ipairs(colors) do list[#list + 1] = { c.r, c.g, c.b } end
    local n = 0
    if op.apply ~= false then
      n = H.mapPixels(spr, op, function(r, g, b, a)
        local c = list[H.nearestInList(list, r, g, b)]
        return c[1], c[2], c[3], a
      end)
    end
    if op.setPalette ~= false then
      local pal = { { r = 0, g = 0, b = 0, a = 0 } }
      for _, c in ipairs(colors) do pal[#pal + 1] = c end
      setPaletteList(spr, pal)
    end
    local hexes = {}
    for _, c in ipairs(colors) do hexes[#hexes + 1] = H.hex(c.r, c.g, c.b, 255) end
    return { colorsBefore = before, colors = hexes, pixels = n }
  end

  -- Convert to a palette with error diffusion (floyd) or ordered dithering.
  OPS["pal.dither_to"] = function(spr, op)
    local list = H.colorList(spr, op.colors)
    local method = op.method or "floyd"
    local strength = op.strength or 1
    local mask = op.inSelection and H.selection(spr) or nil
    local n = 0
    for _, cel in ipairs(H.targetCels(spr, op)) do
      local img = cel.image:clone()
      local w, h = img.width, img.height
      local buf = {}
      for it in img:pixels() do
        local r, g, b, a = pixelRGBA(spr, it(), img.colorMode)
        buf[it.y * w + it.x] = { r, g, b, a }
      end
      local function inMask(x, y) return not mask or H.Mask.get(mask, x + cel.position.x, y + cel.position.y) > 0 end
      for y = 0, h - 1 do
        for x = 0, w - 1 do
          local p = buf[y * w + x]
          if p[4] > 0 and inMask(x, y) then
            local r, g, b = p[1], p[2], p[3]
            if method == "ordered" then
              local t = ((H.BAYER4[(y % 4) + 1][(x % 4) + 1] + 0.5) / 16 - 0.5) * 64 * strength
              r, g, b = r + t, g + t, b + t
            end
            local c = list[H.nearestInList(list, H.clamp(r, 0, 255), H.clamp(g, 0, 255), H.clamp(b, 0, 255))]
            if method == "floyd" then
              local er, eg, eb = (p[1] - c[1]) * strength, (p[2] - c[2]) * strength, (p[3] - c[3]) * strength
              local function spread(dx, dy, f)
                local q = buf[(y + dy) * w + (x + dx)]
                if q and x + dx >= 0 and x + dx < w and q[4] > 0 then
                  q[1], q[2], q[3] = q[1] + er * f, q[2] + eg * f, q[3] + eb * f
                end
              end
              spread(1, 0, 7 / 16); spread(-1, 1, 3 / 16); spread(0, 1, 5 / 16); spread(1, 1, 1 / 16)
            end
            local nv = H.encode(spr, c[1], c[2], c[3], 255)
            if img:getPixel(x, y) ~= nv then img:drawPixel(x, y, nv); n = n + 1 end
          end
        end
      end
      cel.image = img
    end
    return { pixels = n }
  end

  -- Map luminance onto a ramp (dark -> light), e.g. to recolor a grayscale sketch.
  OPS["pal.gradient_map"] = function(spr, op)
    local ramp = {}
    for i, c in ipairs(op.colors) do ramp[i] = { H.rgbaOf(spr, c) } end
    local n = #ramp
    return {
      pixels = H.mapPixels(spr, op, function(r, g, b, a)
        local l = (0.299 * r + 0.587 * g + 0.114 * b) / 255
        local c = ramp[math.min(n, math.floor(l * n) + 1)]
        return c[1], c[2], c[3], a
      end),
    }
  end

  QUERIES["pal.extract"] = function(spr, args)
    local used, order = usedColors(spr, args)
    table.sort(order, function(a, b) if a.n == b.n then return a.hex < b.hex end return a.n > b.n end)
    local out = {}
    for i = 1, math.min(#order, args.limit or 64) do out[#out + 1] = { color = order[i].hex, pixels = order[i].n } end
    local pal = {}
    for _, c in ipairs(paletteColors(spr)) do pal[#pal + 1] = H.hex(c.r, c.g, c.b, c.a) end
    local unusedPal = 0
    for _, hx in ipairs(pal) do if hx ~= "transparent" and not used[hx] then unusedPal = unusedPal + 1 end end
    return { colorsUsed = #order, top = out, palette = args.includePalette ~= false and pal or nil, unusedPaletteEntries = unusedPal }
  end

  local function contrastRatio(a, b)
    local la, lb = H.luminance(a.r, a.g, a.b), H.luminance(b.r, b.g, b.b)
    if la < lb then la, lb = lb, la end
    return (la + 0.05) / (lb + 0.05)
  end
  H.contrastRatio = contrastRatio

  -- Contrast between colors: near-duplicates (hard to tell apart) and optional pairs.
  QUERIES["pal.contrast"] = function(spr, args)
    local colors = {}
    if args.colors then
      for _, c in ipairs(args.colors) do local r, g, b = H.rgbaOf(spr, c); colors[#colors + 1] = { r = r, g = g, b = b, hex = H.hex(r, g, b, 255) } end
    else
      for _, c in ipairs(paletteColors(spr)) do if c.a > 0 then colors[#colors + 1] = { r = c.r, g = c.g, b = c.b, hex = H.hex(c.r, c.g, c.b, 255) } end end
    end
    local minRatio = args.minRatio or 1.15
    local similar = {}
    for i = 1, #colors do
      for j = i + 1, #colors do
        local ratio = contrastRatio(colors[i], colors[j])
        local dist = math.sqrt((colors[i].r - colors[j].r) ^ 2 + (colors[i].g - colors[j].g) ^ 2 + (colors[i].b - colors[j].b) ^ 2)
        if ratio < minRatio and dist < (args.minDistance or 40) then
          similar[#similar + 1] = { a = colors[i].hex, b = colors[j].hex, ratio = math.floor(ratio * 100) / 100, distance = round(dist) }
        end
      end
    end
    local pairs_ = {}
    for _, p in ipairs(args.pairs or {}) do
      local a = { H.rgbaOf(spr, p[1]) }
      local b = { H.rgbaOf(spr, p[2]) }
      local ratio = contrastRatio({ r = a[1], g = a[2], b = a[3] }, { r = b[1], g = b[2], b = b[3] })
      pairs_[#pairs_ + 1] = { a = H.hex(a[1], a[2], a[3], 255), b = H.hex(b[1], b[2], b[3], 255), ratio = math.floor(ratio * 100) / 100 }
    end
    table.sort(similar, function(x, y) return x.ratio < y.ratio end)
    while #similar > 32 do table.remove(similar) end
    return { colors = #colors, tooSimilar = similar, pairs = #pairs_ > 0 and pairs_ or nil }
  end

  -- Objective palette constraints: total colors, colors per grid cell, ramp ordering.
  QUERIES["pal.check_constraints"] = function(spr, args)
    local issues = {}
    local _, order = usedColors(spr, {})
    if args.maxColors and #order > args.maxColors then
      issues[#issues + 1] = { code = "too_many_colors", message = string.format("%d colors used (max %d)", #order, args.maxColors) }
    end
    if args.cellWidth and args.cellHeight and args.maxColorsPerCell then
      local cw, ch = args.cellWidth, args.cellHeight
      local bad = 0
      local samples = {}
      for f = 1, #spr.frames do
        local img = H.renderFrame(spr, f)
        for cy = 0, math.ceil(spr.height / ch) - 1 do
          for cx = 0, math.ceil(spr.width / cw) - 1 do
            local set, count = {}, 0
            for y = cy * ch, math.min(spr.height, (cy + 1) * ch) - 1 do
              for x = cx * cw, math.min(spr.width, (cx + 1) * cw) - 1 do
                local v = img:getPixel(x, y)
                if pc.rgbaA(v) > 0 and not set[v] then set[v] = true; count = count + 1 end
              end
            end
            if count > args.maxColorsPerCell then
              bad = bad + 1
              if #samples < 8 then samples[#samples + 1] = { frame = f, x = cx * cw, y = cy * ch, colors = count } end
            end
          end
        end
      end
      if bad > 0 then issues[#issues + 1] = { code = "cell_colors", message = string.format("%d cells exceed %d colors", bad, args.maxColorsPerCell), samples = samples } end
    end
    for ri, ramp in ipairs(args.ramps or {}) do
      local prev
      for i, c in ipairs(ramp) do
        local r, g, b = H.rgbaOf(spr, c)
        local l = H.luminance(r, g, b)
        if prev and l <= prev then
          issues[#issues + 1] = { code = "ramp_order", message = string.format("ramp %d: color %d is not lighter than color %d", ri, i, i - 1) }
          break
        end
        prev = l
      end
    end
    return { valid = #issues == 0, colorsUsed = #order, issues = issues }
  end
end
