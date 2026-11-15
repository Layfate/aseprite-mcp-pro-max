-- Asset cleanup and objective (measurable) checks.
-- Checks report facts (counts, positions, deltas); they do not judge artistic quality.
return function(M, H)
  local OPS, QUERIES = M.OPS, M.QUERIES
  local fail, round, pc, ranges = H.fail, H.round, H.pc, H.ranges
  local findLayer, findFrame, frameList = H.findLayer, H.findFrame, H.frameList
  local transparentValue, pixelValue = H.transparentValue, H.pixelValue
  local allLayers, renderFrame, contentBounds = H.allLayers, H.renderFrame, H.contentBounds

  local N8 = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 }, { 1, 1 }, { -1, -1 }, { 1, -1 }, { -1, 1 } }
  local N4 = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }

  -- Edit each targeted cel as a full-canvas image: fn(img, src, layer, frame) -> changed count
  local function eachCanvas(spr, op, fn)
    local layers = op.layer and { findLayer(spr, op.layer) } or H.imageLayers(spr)
    local total = 0
    local frameSet
    if H.hasFrameSel(op) then
      frameSet = {}
      for _, n in ipairs(frameList(spr, op)) do frameSet[n] = true end
    end
    for _, layer in ipairs(layers) do
      if layer.isEditable then
        local frames = {}
        for _, cel in ipairs(layer.cels) do
          if not frameSet or frameSet[cel.frameNumber] then frames[#frames + 1] = cel.frameNumber end
        end
        for _, fnum in ipairs(frames) do
          local frame = spr.frames[fnum]
          local img, cel = H.editableImage(spr, layer, frame)
          local n = fn(img, img:clone(), layer, frame) or 0
          if n > 0 then H.commitImage(spr, layer, frame, img, cel) end
          total = total + n
        end
      end
    end
    return total
  end

  local function opaqueAt(spr, img, x, y)
    if x < 0 or y < 0 or x >= img.width or y >= img.height then return false end
    return H.isOpaque(spr, img:getPixel(x, y))
  end

  -- Remove isolated pixels (no opaque 8-neighbour); speckle mode recolors single
  -- odd-colored pixels surrounded by one color.
  OPS["clean.stray_pixels"] = function(spr, op)
    local tv = transparentValue(spr)
    local mode = op.mode or "isolated"
    local n = eachCanvas(spr, op, function(img, src)
      local c = 0
      for y = 0, src.height - 1 do
        for x = 0, src.width - 1 do
          local v = src:getPixel(x, y)
          if H.isOpaque(spr, v) then
            if mode == "isolated" then
              local alone = true
              for _, d in ipairs(N8) do if opaqueAt(spr, src, x + d[1], y + d[2]) then alone = false; break end end
              if alone then img:drawPixel(x, y, tv); c = c + 1 end
            else
              local first, same = nil, true
              for _, d in ipairs(N8) do
                local nx, ny = x + d[1], y + d[2]
                if nx < 0 or ny < 0 or nx >= src.width or ny >= src.height then same = false; break end
                local nv = src:getPixel(nx, ny)
                if first == nil then first = nv elseif nv ~= first then same = false; break end
              end
              if same and first ~= v and H.isOpaque(spr, first) then img:drawPixel(x, y, first); c = c + 1 end
            end
          end
        end
      end
      return c
    end)
    return { pixels = n }
  end

  OPS["clean.alpha"] = function(spr, op)
    local thr = op.threshold or 128
    local n = 0
    for _, cel in ipairs(H.targetCels(spr, op)) do
      local img = cel.image:clone()
      local changed = false
      for it in img:pixels() do
        local r, g, b, a = H.pixelRGBA(spr, it(), img.colorMode)
        if a > 0 and a < 255 then
          it(a >= thr and H.encode(spr, r, g, b, 255) or transparentValue(spr))
          n = n + 1
          changed = true
        end
      end
      if changed then cel.image = img end
    end
    return { pixels = n }
  end

  -- Fill accidental holes: enclosed transparent regions up to maxSize pixels.
  OPS["clean.fill_holes"] = function(spr, op)
    local maxSize = op.maxSize or 1
    local tv = transparentValue(spr)
    local n = eachCanvas(spr, op, function(img, src)
      local w, h = src.width, src.height
      local seen, c = {}, 0
      for y = 0, h - 1 do
        for x = 0, w - 1 do
          local k = y * w + x
          if not seen[k] and not H.isOpaque(spr, src:getPixel(x, y)) then
            local region, touches = {}, false
            local stack = { { x, y } }
            seen[k] = true
            while #stack > 0 do
              local p = table.remove(stack)
              region[#region + 1] = p
              if p[1] == 0 or p[2] == 0 or p[1] == w - 1 or p[2] == h - 1 then touches = true end
              for _, d in ipairs(N4) do
                local nx, ny = p[1] + d[1], p[2] + d[2]
                local nk = ny * w + nx
                if nx >= 0 and ny >= 0 and nx < w and ny < h and not seen[nk] and not H.isOpaque(spr, src:getPixel(nx, ny)) then
                  seen[nk] = true
                  stack[#stack + 1] = { nx, ny }
                end
              end
            end
            if not touches and #region <= maxSize then
              for _, p in ipairs(region) do
                local counts, best, bestN = {}, nil, 0
                for _, d in ipairs(N8) do
                  local nx, ny = p[1] + d[1], p[2] + d[2]
                  if nx >= 0 and ny >= 0 and nx < w and ny < h then
                    local v = src:getPixel(nx, ny)
                    if H.isOpaque(spr, v) then
                      counts[v] = (counts[v] or 0) + 1
                      if counts[v] > bestN then best, bestN = v, counts[v] end
                    end
                  end
                end
                local fillV = op.color and pixelValue(spr, op.color) or best
                if fillV then img:drawPixel(p[1], p[2], fillV); c = c + 1 end
              end
            end
          end
        end
      end
      local _ = tv
      return c
    end)
    return { pixels = n }
  end

  -- Make the outline exactly the given color and 1px thick: boundary pixels become the
  -- outline color; outline-colored pixels deeper inside take the nearest interior color.
  OPS["clean.outline"] = function(spr, op)
    local ov = pixelValue(spr, op.color)
    local fixedGaps, fixedDoubles = 0, 0
    eachCanvas(spr, op, function(img, src)
      local c = 0
      local w, h = src.width, src.height
      for y = 0, h - 1 do
        for x = 0, w - 1 do
          local v = src:getPixel(x, y)
          if H.isOpaque(spr, v) then
            local boundary = false
            for _, d in ipairs(N4) do if not opaqueAt(spr, src, x + d[1], y + d[2]) then boundary = true; break end end
            if boundary and v ~= ov then img:drawPixel(x, y, ov); c = c + 1; fixedGaps = fixedGaps + 1
            elseif not boundary and v == ov and op.removeInner ~= false then
              local best
              for _, d in ipairs(N4) do
                local nv = src:getPixel(x + d[1], y + d[2])
                if nv ~= ov and H.isOpaque(spr, nv) then best = nv; break end
              end
              if best then img:drawPixel(x, y, best); c = c + 1; fixedDoubles = fixedDoubles + 1 end
            end
          end
        end
      end
      return c
    end)
    return { gapsFixed = fixedGaps, innerRemoved = fixedDoubles }
  end

  -- Pixel-perfect lines: remove L-shaped elbow pixels ("doubles") in 1px strokes.
  OPS["clean.pixel_perfect"] = function(spr, op)
    local only = op.color and pixelValue(spr, op.color) or nil
    local tv = transparentValue(spr)
    local n = eachCanvas(spr, op, function(img, src)
      local c = 0
      local w, h = src.width, src.height
      local function same(x, y, v)
        if x < 0 or y < 0 or x >= w or y >= h then return false end
        return img:getPixel(x, y) == v
      end
      for y = 0, h - 1 do
        for x = 0, w - 1 do
          local v = img:getPixel(x, y)
          if H.isOpaque(spr, v) and (not only or v == only) then
            local cnt = 0
            for _, d in ipairs(N8) do if same(x + d[1], y + d[2], v) then cnt = cnt + 1 end end
            if cnt == 2 then
              for _, pair in ipairs({ { { 0, -1 }, { 1, 0 }, { 1, -1 } }, { { 1, 0 }, { 0, 1 }, { 1, 1 } }, { { 0, 1 }, { -1, 0 }, { -1, 1 } }, { { -1, 0 }, { 0, -1 }, { -1, -1 } } }) do
                local a, b, diag = pair[1], pair[2], pair[3]
                if same(x + a[1], y + a[2], v) and same(x + b[1], y + b[2], v) and not same(x + diag[1], y + diag[2], v) then
                  img:drawPixel(x, y, tv)
                  c = c + 1
                  break
                end
              end
            end
          end
        end
      end
      return c
    end)
    return { pixels = n }
  end

  -- Drop cel content that lies outside the canvas.
  OPS["clean.clip_canvas"] = function(spr, op)
    local clipped = 0
    for _, e in ipairs(allLayers(spr)) do
      local l = e.layer
      if not l.isGroup and not l.isTilemap and l.isEditable and (not op.layer or op.layer == e.path or op.layer == l.name) then
        for _, cel in ipairs(l.cels) do
          local b = cel.bounds
          if b.x < 0 or b.y < 0 or b.x + b.width > spr.width or b.y + b.height > spr.height then
            local img = H.editableImage(spr, l, spr.frames[cel.frameNumber])
            H.commitImage(spr, l, spr.frames[cel.frameNumber], img, cel)
            clipped = clipped + 1
          end
        end
      end
    end
    return { cels = clipped }
  end

  -- Align each frame's content to a reference frame (removes jitter / sliding).
  OPS["clean.stabilize"] = function(spr, op)
    local frames = frameList(spr, op, "all")
    local anchor = op.anchor or "bottom"
    local ref = op.referenceFrame or frames[1]
    local function anchorOf(fnum)
      local b = contentBounds(renderFrame(spr, fnum, op.layer))
      if not b then return nil end
      return { cx = b.x + b.width / 2, bottom = b.y + b.height - 1, top = b.y, left = b.x }
    end
    local r = anchorOf(ref)
    if not r then fail("reference frame " .. ref .. " is empty") end
    local moved = 0
    for _, fnum in ipairs(frames) do
      local a = anchorOf(fnum)
      if a and fnum ~= ref then
        local dx, dy = 0, 0
        if anchor == "bottom" or anchor == "bottom-center" then dy = r.bottom - a.bottom end
        if anchor == "center" or anchor == "bottom-center" then dx = round(r.cx - a.cx) end
        if anchor == "top" then dy = r.top - a.top end
        if dx ~= 0 or dy ~= 0 then
          local layers = op.layer and { findLayer(spr, op.layer) } or H.imageLayers(spr)
          for _, l in ipairs(layers) do
            local cel = l:cel(fnum)
            if cel then cel.position = Point(cel.position.x + dx, cel.position.y + dy) end
          end
          moved = moved + 1
        end
      end
    end
    return { framesMoved = moved }
  end

  OPS["clean.empty"] = function(spr, op)
    local cels, layers = 0, 0
    for _, e in ipairs(allLayers(spr)) do
      local l = e.layer
      if not l.isGroup and not l.isTilemap and l.isEditable then
        for _, cel in ipairs(l.cels) do
          if cel.image:isEmpty() then spr:deleteCel(cel); cels = cels + 1 end
        end
      end
    end
    if op.layers then
      for _, e in ipairs(allLayers(spr)) do
        local l = e.layer
        if not l.isGroup and #l.cels == 0 and not l.isBackground and #spr.layers > 1 then
          spr:deleteLayer(l); layers = layers + 1
        end
      end
    end
    return { cels = cels, layers = layers }
  end

  -- Replace colors used by fewer than minPixels pixels with the nearest frequent color.
  OPS["clean.isolated_colors"] = function(spr, op)
    local minPixels = op.minPixels or 3
    local used, order = H.usedColors(spr, op)
    local keep = {}
    for _, c in ipairs(order) do if c.n >= minPixels then keep[#keep + 1] = { c.r, c.g, c.b } end end
    if #keep == 0 then fail("no color is used at least " .. minPixels .. " times") end
    local replaced = 0
    for _, c in ipairs(order) do if c.n < minPixels then replaced = replaced + 1 end end
    local n = H.mapPixels(spr, op, function(r, g, b, a)
      local e = used[H.hex(r, g, b, a)]
      if e and e.n < minPixels then
        local k = keep[H.nearestInList(keep, r, g, b)]
        return k[1], k[2], k[3], a
      end
    end)
    return { colorsReplaced = replaced, pixels = n }
  end

  -- Merge identical consecutive frames, adding up their durations.
  OPS["frame.dedupe"] = function(spr, op)
    local removed = 0
    local n = #spr.frames
    local i = n - 1
    while i >= 1 do
      local a, b = renderFrame(spr, i), renderFrame(spr, i + 1)
      if a:isEqual(b) and #spr.frames > 1 then
        local d = spr.frames[i].duration + spr.frames[i + 1].duration
        spr:deleteFrame(i + 1)
        spr.frames[i].duration = math.min(65.535, d)
        removed = removed + 1
      end
      i = i - 1
    end
    return { removed = removed, frames = #spr.frames }
  end

  -------------------------------------------------------------------------
  -- Checks
  -------------------------------------------------------------------------

  local function issueList()
    local issues = {}
    local function add(severity, code, message, data)
      issues[#issues + 1] = { severity = severity, code = code, message = message, data = data }
    end
    return issues, add
  end

  local function palSetFrom(spr, colors)
    local set = {}
    if colors then
      for _, c in ipairs(colors) do set[H.hex(c.r, c.g, c.b, c.a)] = true end
    else
      local pal = spr.palettes[1]
      for i = 0, #pal - 1 do set[H.colorHex(pal:getColor(i))] = true end
    end
    return set
  end

  -- The original all-in-one lint (kept for compatibility; see the specific checks below).
  QUERIES["check.lint"] = function(spr, rules, req)
    rules = rules.rules or rules
    local issues, issue = issueList()
    local palSet = palSetFrom(spr, rules.palette)
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
          local key = H.hex(pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), a)
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
            for _, d in ipairs(N8) do
              local nx, ny = x + d[1], y + d[2]
              if nx >= 0 and ny >= 0 and nx < img.width and ny < img.height and pc.rgbaA(img:getPixel(nx, ny)) > 0 then lonely = false; break end
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
      issue("error", "off_palette", string.format("%d pixels use colors outside the palette; use pal.quantize to fix", offPalette), { samples = offPaletteSamples })
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
    if rules.colorMode and H.COLOR_MODE_NAME[spr.colorMode] ~= rules.colorMode then
      issue("error", "wrong_color_mode", string.format("color mode is %s, expected %s", H.COLOR_MODE_NAME[spr.colorMode], rules.colorMode))
    end
    for _, e in ipairs(allLayers(spr)) do
      if not e.layer.isGroup and not e.layer.isTilemap then
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
    local realTags = {}
    for _, t in ipairs(spr.tags) do if not t.name:match("^mcp:") then realTags[#realTags + 1] = t end end
    if #realTags > 0 then
      local covered = {}
      for _, t in ipairs(realTags) do
        for n = t.fromFrame.frameNumber, t.toFrame.frameNumber do covered[n] = true end
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
        for n = t.fromFrame.frameNumber, t.toFrame.frameNumber - 1 do
          if renderFrame(spr, n):isEqual(renderFrame(spr, n + 1)) then
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
    table.sort(top, function(x, y) if x.pixels == y.pixels then return x.color < y.color end return x.pixels > y.pixels end)
    while #top > ((req and req.topColors) or rules.topColors or 16) do table.remove(top) end
    local errors = 0
    for _, i in ipairs(issues) do if i.severity == "error" then errors = errors + 1 end end
    return { valid = errors == 0, colorsUsed = usedCount, topColors = top, frameBounds = frameBounds, issues = issues }
  end

  QUERIES["check.palette"] = function(spr, args)
    local set = palSetFrom(spr, args.colors)
    local count, samples, perFrame = 0, {}, {}
    for i = 1, #spr.frames do
      local img = renderFrame(spr, i, args.layer)
      local c = 0
      for it in img:pixels() do
        local v = it()
        local a = pc.rgbaA(v)
        if a > 0 then
          local key = H.hex(pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), a)
          if not set[key] then
            c = c + 1
            if #samples < 12 then samples[#samples + 1] = { frame = i, x = it.x, y = it.y, color = key } end
          end
        end
      end
      if c > 0 then perFrame[#perFrame + 1] = { frame = i, pixels = c } end
      count = count + c
    end
    return { valid = count == 0, offPalette = count, frames = perFrame, samples = samples }
  end

  -- Content touching the canvas edge (likely clipped) and content outside the canvas.
  QUERIES["check.clipping"] = function(spr, args)
    local touching, outside = {}, {}
    local margin = args.margin or 0
    for i = 1, #spr.frames do
      local b = contentBounds(renderFrame(spr, i, args.layer))
      if b then
        local edges = {}
        if b.x <= margin then edges[#edges + 1] = "left" end
        if b.y <= margin then edges[#edges + 1] = "top" end
        if b.x + b.width - 1 >= spr.width - 1 - margin then edges[#edges + 1] = "right" end
        if b.y + b.height - 1 >= spr.height - 1 - margin then edges[#edges + 1] = "bottom" end
        if #edges > 0 then touching[#touching + 1] = { frame = i, edges = table.concat(edges, ",") } end
      end
    end
    for _, e in ipairs(allLayers(spr)) do
      if not e.layer.isGroup and not e.layer.isTilemap then
        for _, cel in ipairs(e.layer.cels) do
          local r = cel.image:shrinkBounds(transparentValue(spr))
          if not r.isEmpty then
            local x0, y0 = cel.position.x + r.x, cel.position.y + r.y
            if x0 < 0 or y0 < 0 or x0 + r.width > spr.width or y0 + r.height > spr.height then
              outside[#outside + 1] = { layer = e.path, frame = cel.frameNumber }
            end
          end
        end
      end
    end
    local ignoreBottom = args.allowBottom ~= false -- feet on the bottom row are often intentional
    local flagged = {}
    for _, t in ipairs(touching) do
      if not (ignoreBottom and t.edges == "bottom") then flagged[#flagged + 1] = t end
    end
    return { valid = #flagged == 0 and #outside == 0, touchingEdges = flagged, outsideCanvas = outside }
  end

  QUERIES["check.timing"] = function(spr, args)
    local issues, add = issueList()
    local base = args.granularityMs or 10
    for i, f in ipairs(spr.frames) do
      local ms = round(f.duration * 1000)
      if args.minMs and ms < args.minMs then add("warning", "too_fast", string.format("frame %d lasts %d ms (< %d)", i, ms, args.minMs), { frame = i }) end
      if args.maxMs and ms > args.maxMs then add("warning", "too_slow", string.format("frame %d lasts %d ms (> %d)", i, ms, args.maxMs), { frame = i }) end
      if ms % base ~= 0 then add("info", "odd_duration", string.format("frame %d lasts %d ms (not a multiple of %d ms)", i, ms, base), { frame = i }) end
    end
    local tags = {}
    for _, t in ipairs(spr.tags) do if not t.name:match("^mcp:") then tags[#tags + 1] = t end end
    for i = 1, #tags do
      for j = i + 1, #tags do
        local a, b = tags[i], tags[j]
        if a.fromFrame.frameNumber <= b.toFrame.frameNumber and b.fromFrame.frameNumber <= a.toFrame.frameNumber then
          add("info", "overlapping_tags", string.format("tags '%s' and '%s' overlap", a.name, b.name))
        end
      end
      local t = tags[i]
      local ds = {}
      for n = t.fromFrame.frameNumber, t.toFrame.frameNumber do ds[#ds + 1] = round(spr.frames[n].duration * 1000) end
      if args.expect and args.expect[t.name] then
        local e = args.expect[t.name]
        if e.frames and #ds ~= e.frames then add("error", "frame_count", string.format("tag '%s' has %d frames, expected %d", t.name, #ds, e.frames)) end
        if e.durationMs then
          for k, d in ipairs(ds) do
            if d ~= e.durationMs then add("error", "duration", string.format("tag '%s' frame %d lasts %d ms, expected %d", t.name, k, d, e.durationMs)); break end
          end
        end
      end
    end
    local errors = 0
    for _, i in ipairs(issues) do if i.severity == "error" then errors = errors + 1 end end
    return { valid = errors == 0, issues = issues }
  end

  local function anchorPoint(b, anchor)
    if anchor == "center" then return b.x + b.width / 2, b.y + b.height / 2 end
    return b.x + b.width / 2, b.y + b.height -- bottom-center (feet)
  end

  -- Content anchor (feet or center) per frame vs the document pivot / first frame.
  QUERIES["check.pivot_drift"] = function(spr, args)
    local frames = frameList(spr, args, "all")
    local pivot = H.getProp(spr, "pivot")
    local anchor = args.anchor or "bottom-center"
    local tol = args.tolerance or 1
    local ref
    local rows, flagged = {}, {}
    for _, fnum in ipairs(frames) do
      local b = contentBounds(renderFrame(spr, fnum, args.layer))
      if b then
        local ax, ay = anchorPoint(b, anchor)
        if not ref then ref = pivot and { x = pivot.x, y = pivot.y } or { x = ax, y = ay } end
        local dx, dy = ax - ref.x, ay - ref.y
        rows[#rows + 1] = { frame = fnum, dx = dx, dy = dy }
        if math.abs(dx) > tol or math.abs(dy) > tol then flagged[#flagged + 1] = { frame = fnum, dx = dx, dy = dy } end
      end
    end
    return { valid = #flagged == 0, reference = ref, pivotSet = pivot ~= nil, drift = flagged, frames = args.verbose and rows or nil }
  end

  QUERIES["check.jitter"] = function(spr, args)
    local out = {}
    local tol = args.tolerance or 1
    for _, t in ipairs(spr.tags) do
      if (not args.tag or args.tag == t.name) and not t.name:match("^mcp:") then
        local bottoms, centers = {}, {}
        for n = t.fromFrame.frameNumber, t.toFrame.frameNumber do
          local b = contentBounds(renderFrame(spr, n, args.layer))
          bottoms[#bottoms + 1] = b and (b.y + b.height - 1) or -1
          centers[#centers + 1] = b and round(b.x + b.width / 2) or -1
        end
        local function spread(list)
          local lo, hi = math.huge, -math.huge
          for _, v in ipairs(list) do if v >= 0 then lo, hi = math.min(lo, v), math.max(hi, v) end end
          return hi >= lo and hi - lo or 0
        end
        local bs, cs = spread(bottoms), spread(centers)
        out[#out + 1] = { tag = t.name, baselineSpread = bs, centerSpread = cs, bottoms = bottoms, centers = centers, jitter = (bs > tol or (args.checkCenter and cs > tol)) or nil }
      end
    end
    local bad = 0
    for _, e in ipairs(out) do if e.jitter then bad = bad + 1 end end
    return { valid = bad == 0, tags = out }
  end

  QUERIES["check.duplicates"] = function(spr, args)
    local groups, byBytes = {}, {}
    for i = 1, #spr.frames do
      local img = renderFrame(spr, i, args.layer)
      local key = img.bytes
      local g = byBytes[key]
      if g then g[#g + 1] = i else byBytes[key] = { i }; groups[#groups + 1] = byBytes[key] end
    end
    local dups = {}
    for _, g in ipairs(groups) do if #g > 1 then dups[#dups + 1] = g end end
    return { duplicates = dups, uniqueFrames = #groups }
  end

  -- Character consistency across frames: size and color-set drift vs a reference frame.
  QUERIES["check.identity"] = function(spr, args)
    local frames = frameList(spr, args, "all")
    local ref = args.referenceFrame or frames[1]
    local function stats(fnum)
      local img = renderFrame(spr, fnum, args.layer)
      local b = contentBounds(img)
      local colors, n = {}, 0
      for it in img:pixels() do
        local v = it()
        if pc.rgbaA(v) > 0 then
          if not colors[v] then colors[v] = 0 end
          colors[v] = colors[v] + 1
          n = n + 1
        end
      end
      return { b = b, colors = colors, n = n }
    end
    local r = stats(ref)
    if not r.b then fail("reference frame is empty") end
    local tolSize = args.sizeTolerance or 2
    local out, flagged = {}, {}
    for _, fnum in ipairs(frames) do
      local s = stats(fnum)
      if s.b then
        local inter, union = 0, 0
        local seen = {}
        for c in pairs(r.colors) do seen[c] = true; union = union + 1; if s.colors[c] then inter = inter + 1 end end
        local newColors = {}
        for c in pairs(s.colors) do if not seen[c] then union = union + 1; newColors[#newColors + 1] = H.hex(pc.rgbaR(c), pc.rgbaG(c), pc.rgbaB(c), pc.rgbaA(c)) end end
        local e = {
          frame = fnum, dw = s.b.width - r.b.width, dh = s.b.height - r.b.height,
          area = math.floor((s.n / r.n) * 100) / 100, colorOverlap = math.floor(inter * 100 / math.max(1, union)) / 100,
          newColors = #newColors > 0 and newColors or nil,
        }
        out[#out + 1] = e
        if math.abs(e.dw) > tolSize or math.abs(e.dh) > tolSize or e.newColors then flagged[#flagged + 1] = e end
      end
    end
    return { reference = ref, consistent = #flagged == 0, flagged = flagged, frames = args.verbose and out or nil }
  end

  -- Outline coverage: share of boundary pixels using the outline color, with gap samples.
  QUERIES["check.outline"] = function(spr, args)
    local frames = frameList(spr, args, "all")
    local r, g, b, a = H.rgbaOf(spr, args.color)
    local ov = pc.rgba(r, g, b, a)
    local boundary, ok, gaps = 0, 0, {}
    for _, fnum in ipairs(frames) do
      local img = renderFrame(spr, fnum, args.layer)
      for it in img:pixels() do
        local v = it()
        if pc.rgbaA(v) > 0 then
          local edge = false
          for _, d in ipairs(N4) do
            local nx, ny = it.x + d[1], it.y + d[2]
            if nx < 0 or ny < 0 or nx >= img.width or ny >= img.height or pc.rgbaA(img:getPixel(nx, ny)) == 0 then edge = true; break end
          end
          if edge then
            boundary = boundary + 1
            if v == ov then ok = ok + 1 elseif #gaps < 12 then gaps[#gaps + 1] = { frame = fnum, x = it.x, y = it.y } end
          end
        end
      end
    end
    local coverage = boundary > 0 and math.floor(ok * 1000 / boundary) / 1000 or 1
    return { coverage = coverage, boundaryPixels = boundary, outlined = ok, gaps = gaps, consistent = coverage >= (args.minCoverage or 0.95) }
  end

  QUERIES["check.transparency"] = function(spr, args)
    local semi, holes, samples = 0, 0, {}
    for i = 1, #spr.frames do
      local img = renderFrame(spr, i, args.layer)
      for it in img:pixels() do
        local a = pc.rgbaA(it())
        if a > 0 and a < 255 then semi = semi + 1; if #samples < 8 then samples[#samples + 1] = { frame = i, x = it.x, y = it.y, alpha = a } end end
        if a == 0 then
          local enclosed = true
          for _, d in ipairs(N4) do
            local nx, ny = it.x + d[1], it.y + d[2]
            if nx < 0 or ny < 0 or nx >= img.width or ny >= img.height or pc.rgbaA(img:getPixel(nx, ny)) == 0 then enclosed = false; break end
          end
          if enclosed then holes = holes + 1 end
        end
      end
    end
    return { valid = semi == 0 and holes == 0, semiTransparent = semi, singlePixelHoles = holes, samples = samples }
  end

  -- Objective checks against the stored asset brief (brief.set).
  QUERIES["check.brief"] = function(spr, args)
    local brief = H.getProp(spr, "brief")
    if not brief then fail("this document has no brief (use brief.set first)") end
    local issues, add = issueList()
    if brief.width and spr.width ~= brief.width or brief.height and spr.height ~= brief.height then
      add("error", "size", string.format("canvas is %dx%d, brief says %sx%s", spr.width, spr.height, tostring(brief.width), tostring(brief.height)))
    end
    if brief.palette then
      local res = QUERIES["check.palette"](spr, { colors = brief.palette })
      if not res.valid then add("error", "palette", string.format("%d pixels are outside the brief palette", res.offPalette), { samples = res.samples }) end
    end
    if brief.maxColors then
      local res = QUERIES["pal.extract"](spr, { limit = 1, includePalette = false })
      if res.colorsUsed > brief.maxColors then add("error", "max_colors", string.format("%d colors used, brief allows %d", res.colorsUsed, brief.maxColors)) end
    end
    if brief.transparency == "binary" then
      local res = QUERIES["check.transparency"](spr, {})
      if res.semiTransparent > 0 then add("error", "transparency", res.semiTransparent .. " semi-transparent pixels (brief wants binary alpha)") end
    end
    if brief.outline and brief.outline.color then
      local res = QUERIES["check.outline"](spr, { color = brief.outline.color, minCoverage = brief.outline.minCoverage })
      if not res.consistent then add("warning", "outline", string.format("outline coverage %.0f%%", res.coverage * 100), { gaps = res.gaps }) end
    end
    if brief.states then
      local names = {}
      for _, t in ipairs(spr.tags) do names[t.name] = t end
      local pattern = brief.tagPattern or "{state}_{dir}"
      for _, s in ipairs(brief.states) do
        local dirs = brief.directions and #brief.directions > 0 and brief.directions or { "" }
        for _, d in ipairs(dirs) do
          local name = d == "" and s.name or pattern:gsub("{state}", s.name):gsub("{dir}", d)
          local t = names[name]
          if not t then add("error", "missing_tag", "missing animation tag '" .. name .. "'")
          elseif s.frames and (t.toFrame.frameNumber - t.fromFrame.frameNumber + 1) ~= s.frames then
            add("error", "frame_count", string.format("tag '%s' has %d frames, brief says %d", name, t.toFrame.frameNumber - t.fromFrame.frameNumber + 1, s.frames))
          end
        end
      end
    end
    if brief.pivot and not H.getProp(spr, "pivot") then add("warning", "pivot", "brief expects a pivot but none is set (xf.set_pivot)") end
    if brief.pivot then
      local res = QUERIES["check.pivot_drift"](spr, { tolerance = brief.pivotTolerance or 1 })
      if not res.valid then add("warning", "pivot_drift", #res.drift .. " frames drift from the pivot", { drift = res.drift }) end
    end
    local errors = 0
    for _, i in ipairs(issues) do if i.severity == "error" then errors = errors + 1 end end
    return { valid = errors == 0, issues = issues, note = "Objective checks only; artistic quality needs human (or model) review." }
  end

  OPS["brief.set"] = function(spr, op)
    local brief = op.merge and (H.getProp(spr, "brief") or {}) or {}
    for k, v in pairs(op.brief) do brief[k] = v end
    H.setProp(spr, "brief", brief)
    return {}
  end

  QUERIES["brief.get"] = function(spr)
    return { brief = H.getProp(spr, "brief") }
  end

  OPS["review.note"] = function(spr, op)
    local notes = H.getProp(spr, "reviews") or {}
    notes[#notes + 1] = { note = op.note, aspect = op.aspect, frames = op.frames, verdict = op.verdict, by = op.by }
    while #notes > 50 do table.remove(notes, 1) end
    H.setProp(spr, "reviews", notes)
    return { notes = #notes }
  end

  QUERIES["review.list"] = function(spr)
    return { notes = H.getProp(spr, "reviews") or {} }
  end
end
