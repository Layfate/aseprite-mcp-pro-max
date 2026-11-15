-- Craft checks: objective detectors for the pixel-art "tells" that plain lint cannot see
-- (rules://92-generated-art-tells): pillow shading, brightness-only ramps, conflicting light,
-- banding, confetti, jaggies, doubled outlines, mirror symmetry, murky values, colour bloat.
-- Each finding carries the catalogue id, evidence and a location. They measure; they do not
-- grade taste — a clean result still needs a cold read by eye (skill://review).
return function(M, H)
  local QUERIES = M.QUERIES
  local pc = H.pc

  local N4 = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }
  local N8 = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 }, { 1, 1 }, { -1, -1 }, { 1, -1 }, { -1, 1 } }

  ---------------------------------------------------------------------------
  -- colour science
  ---------------------------------------------------------------------------
  local function lin(c)
    c = c / 255
    if c <= 0.04045 then return c / 12.92 end
    return ((c + 0.055) / 1.055) ^ 2.4
  end
  local function fl(t)
    if t > 0.008856 then return t ^ (1 / 3) end
    return 7.787 * t + 16 / 116
  end
  local function lab(r, g, b)
    local R, G, B = lin(r), lin(g), lin(b)
    local X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
    local Y = R * 0.2126 + G * 0.7152 + B * 0.0722
    local Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
    local fx, fy, fz = fl(X), fl(Y), fl(Z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)
  end
  local function hueDiff(a, b)
    local d = math.abs(a - b) % 360
    return d > 180 and 360 - d or d
  end

  ---------------------------------------------------------------------------
  -- small statistics
  ---------------------------------------------------------------------------
  -- Ordinary least squares on centred data. rows[i] = { y, x1, ..., xk } (extra columns ignored).
  -- Returns { r2, beta } or { flat = true } when y has no variance, nil when singular.
  local function ols(rows, k)
    local n = #rows
    if n < k + 3 then return nil end
    local mean = {}
    for j = 1, k + 1 do mean[j] = 0 end
    for _, r in ipairs(rows) do for j = 1, k + 1 do mean[j] = mean[j] + r[j] end end
    for j = 1, k + 1 do mean[j] = mean[j] / n end
    local A, b, sst = {}, {}, 0
    for i = 1, k do
      A[i] = {}
      for j = 1, k do A[i][j] = 0 end
      b[i] = 0
    end
    for _, r in ipairs(rows) do
      local yy = r[1] - mean[1]
      sst = sst + yy * yy
      for i = 1, k do
        local xi = r[i + 1] - mean[i + 1]
        b[i] = b[i] + xi * yy
        for j = 1, k do A[i][j] = A[i][j] + xi * (r[j + 1] - mean[j + 1]) end
      end
    end
    if sst < 1e-9 then return { flat = true, r2 = 0, beta = {} } end
    -- Gaussian elimination with partial pivoting on a copy
    local m = {}
    for i = 1, k do
      m[i] = {}
      for j = 1, k do m[i][j] = A[i][j] end
      m[i][k + 1] = b[i]
    end
    for c = 1, k do
      local p = c
      for r = c + 1, k do if math.abs(m[r][c]) > math.abs(m[p][c]) then p = r end end
      if math.abs(m[p][c]) < 1e-9 then return nil end
      m[c], m[p] = m[p], m[c]
      for r = c + 1, k do
        local f = m[r][c] / m[c][c]
        for j = c, k + 1 do m[r][j] = m[r][j] - f * m[c][j] end
      end
    end
    local beta = {}
    for i = k, 1, -1 do
      local s = m[i][k + 1]
      for j = i + 1, k do s = s - m[i][j] * beta[j] end
      beta[i] = s / m[i][i]
    end
    local ssr = 0
    for i = 1, k do ssr = ssr + beta[i] * b[i] end
    return { r2 = math.max(0, math.min(1, ssr / sst)), beta = beta }
  end

  local function percentile(sorted, p)
    if #sorted == 0 then return 0 end
    local i = math.max(1, math.min(#sorted, math.floor(p * (#sorted - 1) + 1.5)))
    return sorted[i]
  end

  ---------------------------------------------------------------------------
  -- light directions (x right, y DOWN; vectors point toward the light)
  ---------------------------------------------------------------------------
  local LIGHT = {
    ["top-left"] = { -1, -1 }, top = { 0, -1 }, ["top-right"] = { 1, -1 },
    left = { -1, 0 }, right = { 1, 0 },
    ["bottom-left"] = { -1, 1 }, bottom = { 0, 1 }, ["bottom-right"] = { 1, 1 },
  }
  local function lightName(dx, dy)
    local ang = math.deg(math.atan(-dy, dx)) % 360 -- y up for naming
    local names = { "right", "top-right", "top", "top-left", "left", "bottom-left", "bottom", "bottom-right" }
    return names[(math.floor((ang + 22.5) / 45) % 8) + 1]
  end
  local function angleBetween(ax, ay, bx, by)
    local la, lb = math.sqrt(ax * ax + ay * ay), math.sqrt(bx * bx + by * by)
    if la == 0 or lb == 0 then return 0 end
    local c = (ax * bx + ay * by) / (la * lb)
    return math.deg(math.acos(math.max(-1, math.min(1, c))))
  end

  ---------------------------------------------------------------------------
  -- rendering the subject (reference + background layers excluded)
  ---------------------------------------------------------------------------
  local function isReference(layer)
    if H.getProp(layer, "reference") == true then return true end
    return layer.name:lower():match("^reference") ~= nil
  end

  local function renderSubject(spr, fnum, layerRef)
    if layerRef then return H.renderFrame(spr, fnum, layerRef), {} end
    local hidden, names = {}, {}
    for _, e in ipairs(H.allLayers(spr)) do
      local l = e.layer
      if l.isVisible and (l.isBackground or isReference(l)) then
        l.isVisible = false
        hidden[#hidden + 1] = l
        names[#names + 1] = e.path
      end
    end
    local ok, img = pcall(H.renderFrame, spr, fnum)
    for _, l in ipairs(hidden) do l.isVisible = true end
    if not ok then error(img, 0) end
    return img, names
  end

  ---------------------------------------------------------------------------
  -- one frame
  ---------------------------------------------------------------------------
  local function hexOf(key) return H.hex(pc.rgbaR(key), pc.rgbaG(key), pc.rgbaB(key), 255) end

  local function analyzeFrame(img, opts)
    local W, Hh = img.width, img.height
    local function idx(x, y) return y * W + x + 1 end
    local px = {} -- idx -> opaque colour key (alpha forced to 255); nil = transparent
    local colors = {} -- key -> info
    local nColors = 0
    local semi, semiSamples = 0, {}
    local minx, miny, maxx, maxy = W, Hh, -1, -1
    local opaque = 0
    for it in img:pixels() do
      local v = it()
      local a = pc.rgbaA(v)
      if a > 0 then
        local r, g, b = pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v)
        local key = pc.rgba(r, g, b, 255)
        px[idx(it.x, it.y)] = key
        opaque = opaque + 1
        if a < 255 then
          semi = semi + 1
          if #semiSamples < 6 then semiSamples[#semiSamples + 1] = { x = it.x, y = it.y, alpha = a } end
        end
        local c = colors[key]
        if not c then
          local L, A, B = lab(r, g, b)
          local h, s, l = H.rgbToHsl(r, g, b)
          c = { key = key, n = 0, r = r, g = g, b = b, L = L, A = A, B = B, h = h, s = s, l = l, edge = 0 }
          colors[key] = c
          nColors = nColors + 1
        end
        c.n = c.n + 1
        if it.x < minx then minx = it.x end
        if it.x > maxx then maxx = it.x end
        if it.y < miny then miny = it.y end
        if it.y > maxy then maxy = it.y end
      end
    end
    local R = { findings = {}, colors = nColors, opaque = opaque }
    if opaque == 0 then R.empty = true; return R end
    R.bounds = { x = minx, y = miny, width = maxx - minx + 1, height = maxy - miny + 1 }
    local cw, ch = maxx - minx + 1, maxy - miny + 1
    local function at(x, y)
      if x < 0 or y < 0 or x >= W or y >= Hh then return nil end
      return px[idx(x, y)]
    end
    local function add(id, severity, tell, message, evidence, samples, fix)
      R.findings[#R.findings + 1] = { id = id, severity = severity, tell = tell, message = message, evidence = evidence, samples = samples, fix = fix }
    end
    if opts.fullCanvas == nil and cw == W and ch == Hh and opaque == W * Hh then
      R.note = "every pixel is opaque: the subject cannot be separated from a background; pass layer to check one subject"
    end

    -- edges and outline colours ------------------------------------------------
    local edgeCount = 0
    local isEdge = {}
    for y = miny, maxy do
      for x = minx, maxx do
        local k = at(x, y)
        if k then
          for _, d in ipairs(N4) do
            if not at(x + d[1], y + d[2]) then
              isEdge[idx(x, y)] = true
              edgeCount = edgeCount + 1
              colors[k].edge = colors[k].edge + 1
              break
            end
          end
        end
      end
    end
    local Ls = {}
    for _, c in pairs(colors) do Ls[#Ls + 1] = c.L end
    table.sort(Ls)
    local medianL = percentile(Ls, 0.5)
    local outline, outlineList = {}, {}
    if opts.outline then
      outline[opts.outline] = true
      outlineList[1] = opts.outline
    else
      -- Outline candidates: dark colours living mostly on the silhouette edge (>= 45% covers
      -- 2 px outlines too). They only count as an outline when together they wrap at least
      -- half of the silhouette; a dark end of a thin strip is not an outline.
      -- Strict tier first (>= 75% on the edge); the relaxed tier only when the strict one does
      -- not wrap the silhouette, so a dark rim shade is not mistaken for outline.
      local candEdge = 0
      for _, minFrac in ipairs({ 0.75, 0.45 }) do
        outlineList, candEdge = {}, 0
        for k, c in pairs(colors) do
          if c.n >= 3 and c.edge / c.n >= minFrac and c.L <= medianL and nColors > 1 then
            outlineList[#outlineList + 1] = k
            candEdge = candEdge + c.edge
          end
        end
        if edgeCount > 0 and candEdge / edgeCount >= 0.5 then break end
      end
      -- ...and only around a fill that has pixels away from the edge (a 2-row strip has none)
      local isCand, fillN, fillInner = {}, 0, 0
      for _, k in ipairs(outlineList) do isCand[k] = true end
      for k, c in pairs(colors) do
        if not isCand[k] then fillN, fillInner = fillN + c.n, fillInner + (c.n - c.edge) end
      end
      if edgeCount > 0 and candEdge / edgeCount >= 0.5 and fillN > 0 and fillInner >= math.max(1, fillN * 0.2) then
        for _, k in ipairs(outlineList) do outline[k] = true end
        table.sort(outlineList, function(a, b) return colors[a].n > colors[b].n end)
      else
        outlineList = {}
      end
    end
    local onOutline = 0
    for i in pairs(isEdge) do if outline[px[i]] then onOutline = onOutline + 1 end end
    local outlineHex = {}
    for i, k in ipairs(outlineList) do if i <= 4 then outlineHex[#outlineHex + 1] = hexOf(k) end end
    R.outline = { colors = outlineHex, coverage = edgeCount > 0 and math.floor(onOutline * 100 / edgeCount + 0.5) / 100 or 0 }

    local function interior(x, y)
      local k = at(x, y)
      if k and not outline[k] then return k end
      return nil
    end

    -- depth inside the non-outline area (chessboard distance to anything else) -
    local depth, queue, qh = {}, {}, 1
    local interiorCount = 0
    for y = miny, maxy do
      for x = minx, maxx do
        if interior(x, y) then
          interiorCount = interiorCount + 1
          for _, d in ipairs(N8) do
            if not interior(x + d[1], y + d[2]) then
              depth[idx(x, y)] = 1
              queue[#queue + 1] = { x, y }
              break
            end
          end
        end
      end
    end
    while qh <= #queue do
      local p = queue[qh]
      qh = qh + 1
      local dp = depth[idx(p[1], p[2])]
      for _, d in ipairs(N8) do
        local nx, ny = p[1] + d[1], p[2] + d[2]
        if interior(nx, ny) and not depth[idx(nx, ny)] then
          depth[idx(nx, ny)] = dp + 1
          queue[#queue + 1] = { nx, ny }
        end
      end
    end

    -- interior components (4-connected) ----------------------------------------
    local comp, comps = {}, {}
    for y = miny, maxy do
      for x = minx, maxx do
        if interior(x, y) and not comp[idx(x, y)] then
          local id = #comps + 1
          local list, stack = {}, { { x, y } }
          comp[idx(x, y)] = id
          while #stack > 0 do
            local p = table.remove(stack)
            list[#list + 1] = p
            for _, d in ipairs(N4) do
              local nx, ny = p[1] + d[1], p[2] + d[2]
              if interior(nx, ny) and not comp[idx(nx, ny)] then
                comp[idx(nx, ny)] = id
                stack[#stack + 1] = { nx, ny }
              end
            end
          end
          comps[id] = list
        end
      end
    end

    -- shading model per component: L* ~ x + y (+ depth) -------------------------
    local minComp = math.max(16, math.floor(interiorCount * 0.08))
    local lx, ly, lw = 0, 0, 0
    local dirs, pillow, flatComps, shadedComps = {}, nil, 0, 0
    for _, list in ipairs(comps) do
      if #list >= minComp then
        local rows, keys, nk, maxD = {}, {}, 0, 0
        for _, p in ipairs(list) do
          local k = px[idx(p[1], p[2])]
          local dd = depth[idx(p[1], p[2])] or 1
          if dd > maxD then maxD = dd end
          if not keys[k] then keys[k] = true; nk = nk + 1 end
          rows[#rows + 1] = { colors[k].L, p[1], p[2], dd }
        end
        local sum, sum2 = 0, 0
        for _, r in ipairs(rows) do sum, sum2 = sum + r[1], sum2 + r[1] * r[1] end
        local sd = math.sqrt(math.max(0, sum2 / #rows - (sum / #rows) ^ 2))
        if nk <= 1 or sd < 4 then
          -- one colour, or value steps too small to see (ΔL* < ~4): no readable shading
          flatComps = flatComps + 1
        else
          shadedComps = shadedComps + 1
          local mxy = ols(rows, 2)
          local mfull = maxD >= 3 and ols(rows, 3) or nil
          if mxy and not mxy.flat then
            local bx, by = mxy.beta[1], mxy.beta[2]
            local len = math.sqrt(bx * bx + by * by)
            if len > 0 and mxy.r2 >= 0.08 then
              local w = #list * mxy.r2
              lx, ly, lw = lx + bx / len * w, ly + by / len * w, lw + #list
              dirs[#dirs + 1] = { dx = bx / len, dy = by / len, r2 = mxy.r2, n = #list, at = list[1] }
            else
              lw = lw + #list
            end
            if mfull and not mfull.flat and mfull.beta[3] > 0 then
              local unique = mfull.r2 - mxy.r2
              if unique >= 0.2 and mxy.r2 < 0.35 and (not pillow or unique > pillow.unique) then
                local bx0, by0, bx1, by1 = math.huge, math.huge, -1, -1
                for _, p in ipairs(list) do
                  bx0, by0 = math.min(bx0, p[1]), math.min(by0, p[2])
                  bx1, by1 = math.max(bx1, p[1]), math.max(by1, p[2])
                end
                pillow = { unique = unique, directional = mxy.r2, total = mfull.r2, pixels = #list, bounds = { x = bx0, y = by0, width = bx1 - bx0 + 1, height = by1 - by0 + 1 } }
              end
            end
          end
        end
      end
    end
    local strength = lw > 0 and math.sqrt(lx * lx + ly * ly) / lw or 0
    R.light = { strength = math.floor(strength * 100 + 0.5) / 100 }
    if strength >= 0.1 then
      R.light.estimated = lightName(lx, ly)
      R.light.vector = { lx / (lw * strength), ly / (lw * strength) }
    else
      R.light.estimated = "none"
    end

    -- C7 pillow shading
    if pillow then
      add("C7", pillow.unique >= 0.3 and "blocking" or "warning", "pillow shading",
        string.format("values follow the distance from the edge (%.0f%% of the variance) far more than any light direction (%.0f%%): rings, not form", pillow.unique * 100, pillow.directional * 100),
        { depthShare = math.floor(pillow.unique * 100 + 0.5) / 100, directionalShare = math.floor(pillow.directional * 100 + 0.5) / 100, bounds = pillow.bounds },
        nil, "Offset the highlight toward the light, put a crescent shadow on the far side (rules://92 tells-sphere-lit, rules://02)")
    end

    -- C6 light direction vs brief, and conflicting light inside the frame
    local brief = opts.light and LIGHT[opts.light]
    if brief and R.light.estimated ~= "none" then
      local ang = angleBetween(lx, ly, brief[1], brief[2])
      if ang > 100 then
        add("C6", "blocking", "light against the brief", string.format("shading is lit from the %s; the brief says %s (%.0f° apart)", R.light.estimated, opts.light, ang),
          { estimated = R.light.estimated, brief = opts.light, angle = math.floor(ang + 0.5) }, nil, "Reshade: lighter steps on the " .. opts.light .. " side, shadows opposite (draw.shade)")
      elseif ang > 60 then
        add("C6", "warning", "light drifts from the brief", string.format("shading leans %s; the brief says %s (%.0f° apart)", R.light.estimated, opts.light, ang),
          { estimated = R.light.estimated, brief = opts.light, angle = math.floor(ang + 0.5) }, nil, "Move highlights toward the " .. opts.light .. " side")
      end
    end
    for i = 1, #dirs do
      for j = i + 1, #dirs do
        local a, b = dirs[i], dirs[j]
        if a.r2 >= 0.25 and b.r2 >= 0.25 and angleBetween(a.dx, a.dy, b.dx, b.dy) > 120 then
          if not R.conflict then
            R.conflict = true
            add("C6", "warning", "conflicting light", string.format("one part is lit from the %s, another from the %s", lightName(a.dx, a.dy), lightName(b.dx, b.dy)),
              { parts = { { lit = lightName(a.dx, a.dy), near = { x = a.at[1], y = a.at[2] } }, { lit = lightName(b.dx, b.dy), near = { x = b.at[1], y = b.at[2] } } } },
              nil, "One light direction for every part (rules://02-shading-and-light)")
          end
        end
      end
    end
    if shadedComps == 0 and flatComps > 0 then
      add("F1", "info", "no form shading", "every region is a single flat colour: no light, no volume",
        { flatRegions = flatComps }, nil, "If the style is not deliberately flat: one shadow step away from the light, one light step toward it (skill://shade)")
    end

    -- C3 brightness-only ramps (HSL hue kept while lightness changes) ----------
    local pairs_ = {}
    for y = miny, maxy do
      for x = minx, maxx do
        local a = interior(x, y)
        if a then
          for _, d in ipairs({ { 1, 0 }, { 0, 1 } }) do
            local b = interior(x + d[1], y + d[2])
            if b and b ~= a then
              local k1, k2 = a < b and a or b, a < b and b or a
              local key = k1 .. ":" .. k2
              local e = pairs_[key]
              if not e then e = { a = colors[k1], b = colors[k2], n = 0 }; pairs_[key] = e end
              e.n = e.n + 1
            end
          end
        end
      end
    end
    local flatW, shiftW, flatPairs = 0, 0, {}
    for _, e in pairs(pairs_) do
      local a, b = e.a, e.b
      if a.s >= 0.15 and b.s >= 0.15 and math.abs(a.L - b.L) >= 6 then
        local hd = hueDiff(a.h, b.h)
        if hd < 4 then
          flatW = flatW + e.n
          flatPairs[#flatPairs + 1] = { from = hexOf(a.key), to = hexOf(b.key), hueDiff = math.floor(hd * 10 + 0.5) / 10, boundary = e.n }
        elseif hd <= 70 then
          shiftW = shiftW + e.n
        end
      end
    end
    local flatShare = flatW / math.max(1, flatW + shiftW)
    if flatW >= 4 and ((#flatPairs >= 2 and flatShare >= 0.6) or flatShare >= 0.85) then
      table.sort(flatPairs, function(p, q) return p.boundary > q.boundary end)
      while #flatPairs > 4 do table.remove(flatPairs) end
      local share = flatW / (flatW + shiftW)
      add("C3", share >= 0.75 and "blocking" or "warning", "brightness-only ramps",
        string.format("%.0f%% of shading edges change only lightness, not hue (a brightness slider)", share * 100),
        { flatShare = math.floor(share * 100 + 0.5) / 100, pairs = flatPairs }, nil,
        "Rebuild the ramp with pal.ramp (shadows cooler, lights warmer) and recolour with draw.shade or pal.remap")
    end

    -- C2 near-duplicate colours (CIE76 ΔE < 3) -----------------------------------
    local list = {}
    for _, c in pairs(colors) do list[#list + 1] = c end
    if #list <= 256 then
      local dups = {}
      for i = 1, #list do
        for j = i + 1, #list do
          local a, b = list[i], list[j]
          local dE = math.sqrt((a.L - b.L) ^ 2 + (a.A - b.A) ^ 2 + (a.B - b.B) ^ 2)
          if dE < 3 then dups[#dups + 1] = { hexOf(a.key), hexOf(b.key), math.floor(dE * 10 + 0.5) / 10 } end
        end
      end
      if #dups > 0 then
        local shown = {}
        for i = 1, math.min(6, #dups) do shown[i] = dups[i] end
        add("C2", "warning", "near-duplicate colours", string.format("%d colour pair(s) are indistinguishable (ΔE < 3)", #dups),
          { pairs = shown, total = #dups }, nil, "Merge each pair with pal.replace_color")
      end
    end

    -- C1 colour bloat ----------------------------------------------------------
    local dim = math.max(cw, ch)
    local cap = opts.maxColors or (dim <= 8 and 4 or dim <= 16 and 8 or dim <= 32 and 16 or dim <= 64 and 32 or 48)
    R.colorCap = cap
    if nColors > cap then
      add("C1", nColors > cap * 2 and "blocking" or "warning", "colour bloat",
        string.format("%d colours for a %dx%d subject (budget %d)", nColors, cw, ch, cap), { used = nColors, budget = cap }, nil,
        "pal.reduce to the budget, then pal.quantize; rebuild ramps")
    end

    -- E1 semi-transparency -----------------------------------------------------
    if semi > 0 and not opts.allowSemi then
      add("E1", "blocking", "semi-transparent pixels", string.format("%d pixels have partial alpha (soft brush, resize or opacity)", semi),
        { count = semi }, semiSamples, "clean.alpha (or repaint them opaque)")
    end

    -- C5 confetti and strays ----------------------------------------------------
    local singles, singleSamples, strays, straySamples = 0, {}, 0, {}
    for y = miny, maxy do
      for x = minx, maxx do
        local k = at(x, y)
        if k then
          local same, opq = false, 0
          for _, d in ipairs(N8) do
            local nk = at(x + d[1], y + d[2])
            if nk then
              opq = opq + 1
              if nk == k then same = true end
            end
          end
          if opq == 0 then
            strays = strays + 1
            if #straySamples < 6 then straySamples[#straySamples + 1] = { x = x, y = y } end
          elseif not same and not outline[k] and opq >= 6 then
            singles = singles + 1
            if #singleSamples < 8 then singleSamples[#singleSamples + 1] = { x = x, y = y, color = hexOf(k) } end
          end
        end
      end
    end
    local allowance = 1 + math.floor(interiorCount / 300)
    if singles > allowance then
      add("C5", singles > allowance * 3 and "warning" or "info", "confetti",
        string.format("%d lone pixels inside fills (allowance %d for eyes/speculars): reads as noise", singles, allowance),
        { count = singles, allowance = allowance }, singleSamples, "Gather lights and darks into clusters of 3+ that follow the form; keep one deliberate specular")
    end
    if strays > 0 then
      add("X0", "warning", "stray pixels", string.format("%d isolated pixels floating in transparency", strays), { count = strays }, straySamples, "clean.stray_pixels")
    end

    -- X3 banding: parallel long straight boundaries between the same colours ----
    local segs = { h = {}, v = {} }
    local minH, minV = math.max(8, math.floor(cw / 3)), math.max(8, math.floor(ch / 3))
    for y = miny, maxy - 1 do
      local ra, rb, start = nil, nil, nil
      for x = minx, maxx + 1 do
        local a = x <= maxx and interior(x, y) or nil
        local b = x <= maxx and interior(x, y + 1) or nil
        local valid = a and b and a ~= b
        if not (valid and ra == a and rb == b) then
          if ra and x - start >= minH then segs.h[#segs.h + 1] = { pos = y, from = start, to = x - 1 } end
          if valid then ra, rb, start = a, b, x else ra = nil end
        end
      end
    end
    for x = minx, maxx - 1 do
      local ra, rb, start = nil, nil, nil
      for y = miny, maxy + 1 do
        local a = y <= maxy and interior(x, y) or nil
        local b = y <= maxy and interior(x + 1, y) or nil
        local valid = a and b and a ~= b
        if not (valid and ra == a and rb == b) then
          if ra and y - start >= minV then segs.v[#segs.v + 1] = { pos = x, from = start, to = y - 1 } end
          if valid then ra, rb, start = a, b, y else ra = nil end
        end
      end
    end
    local bands = {}
    for o, list_ in pairs(segs) do
      for i = 1, #list_ do
        for j = i + 1, #list_ do
          local a, b = list_[i], list_[j]
          if math.abs(a.pos - b.pos) <= 4 then
            local ov = math.min(a.to, b.to) - math.max(a.from, b.from) + 1
            local shorter = math.min(a.to - a.from, b.to - b.from) + 1
            if ov >= shorter * 0.7 then
              bands[#bands + 1] = o == "h" and { rows = { a.pos, b.pos }, x = { math.max(a.from, b.from), math.min(a.to, b.to) } }
                or { columns = { a.pos, b.pos }, y = { math.max(a.from, b.from), math.min(a.to, b.to) } }
            end
          end
        end
      end
    end
    if #bands > 0 then
      local shown = {}
      for i = 1, math.min(4, #bands) do shown[i] = bands[i] end
      add("X3", "warning", "banding", string.format("%d pair(s) of long, parallel colour boundaries with aligned ends", #bands),
        { bands = shown }, nil, "Stagger the band ends, let boundaries wander, break one transition with a short dither")
    end

    -- G6 jaggies on the silhouette (run lengths along each side's profile) -------
    local jag, jagSamples, seen = 0, {}, {}
    local function scanProfile(n, valueAt, toXY)
      local i = 0
      while i < n do
        while i < n and valueAt(i) == nil do i = i + 1 end
        local runs = {}
        while i < n and valueAt(i) ~= nil do
          local v = valueAt(i)
          local last = runs[#runs]
          if last and last.v == v then last.len = last.len + 1 else runs[#runs + 1] = { start = i, v = v, len = 1 } end
          i = i + 1
        end
        local s = 1
        while s < #runs do
          local d = runs[s + 1].v - runs[s].v
          if math.abs(d) ~= 1 then
            s = s + 1
          else
            local e = s + 1
            while e < #runs and runs[e + 1].v - runs[e].v == d do e = e + 1 end
            if e - s >= 2 then
              local distinct, nd = {}, 0
              for r = s + 1, e - 1 do if not distinct[runs[r].len] then distinct[runs[r].len] = true; nd = nd + 1 end end
              local alternating = false
              if nd == 2 then
                local a, b
                for k in pairs(distinct) do if a then b = k else a = k end end
                alternating = math.abs(a - b) == 1
              end
              if not alternating then
                for r = s + 1, e - 1 do
                  local p, c, q = runs[r - 1].len, runs[r].len, runs[r + 1].len
                  if (c > p and c > q) or (c < p and c < q) then
                    local x, y = toXY(runs[r].start, runs[r].v)
                    local key = x .. "," .. y
                    if not seen[key] then
                      seen[key] = true
                      jag = jag + 1
                      if #jagSamples < 8 then jagSamples[#jagSamples + 1] = { x = x, y = y, runs = { p, c, q } } end
                    end
                  end
                end
              end
            end
            s = e
          end
        end
      end
    end
    local function top(x) for y = miny, maxy do if at(x, y) then return y end end end
    local function bottom(x) for y = maxy, miny, -1 do if at(x, y) then return y end end end
    local function left(y) for x = minx, maxx do if at(x, y) then return x end end end
    local function right(y) for x = maxx, minx, -1 do if at(x, y) then return x end end end
    scanProfile(cw, function(i) return top(minx + i) end, function(i, v) return minx + i, v end)
    scanProfile(cw, function(i) return bottom(minx + i) end, function(i, v) return minx + i, v end)
    scanProfile(ch, function(i) return left(miny + i) end, function(i, v) return v, miny + i end)
    scanProfile(ch, function(i) return right(miny + i) end, function(i, v) return v, miny + i end)
    if jag > 0 then
      local limit = math.max(2, math.floor((cw + ch) / 16))
      add("G6", jag > limit and "warning" or "info", "jaggies",
        string.format("%d place(s) where a silhouette staircase breaks its rhythm (a run longer or shorter than both neighbours)", jag),
        { count = jag }, jagSamples, "Make run lengths uniform on lines and monotone on curves; move one end pixel, do not re-stroke (rules://10-lines-and-curves)")
    end

    -- E4 doubled outline: 2x2 clumps of outline colour --------------------------
    if next(outline) then
      local clumps, clumpSamples = 0, {}
      for y = miny, maxy - 1 do
        for x = minx, maxx - 1 do
          local a, b, c, d = at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)
          if a and b and c and d and outline[a] and outline[b] and outline[c] and outline[d] then
            clumps = clumps + 1
            if #clumpSamples < 6 then clumpSamples[#clumpSamples + 1] = { x = x, y = y } end
          end
        end
      end
      if clumps >= 2 then
        add("E4", "warning", "doubled outline", string.format("%d 2x2 clumps of outline colour: the line thickens and blobs", clumps),
          { count = clumps }, clumpSamples, "clean.outline (1px, one colour), clean.pixel_perfect for elbows")
      end
    end

    -- S4 perfect mirror symmetry -------------------------------------------------
    if cw >= 6 and opaque >= 20 then
      local match = 0
      for y = miny, maxy do
        for x = minx, maxx do
          local k = at(x, y)
          if k and at(minx + maxx - x, y) == k then match = match + 1 end
        end
      end
      local sym = match / opaque
      R.symmetry = math.floor(sym * 100 + 0.5) / 100
      if sym >= 0.97 and not opts.allowSymmetry then
        add("S4", opts.front and "info" or "warning", "mirror symmetry",
          string.format("%.0f%% of pixels mirror exactly left-right: reads as a statue or a stamped icon", sym * 100),
          { symmetry = R.symmetry }, nil, "Break it: tilt the head, offset a limb, move the highlight toward the light (rules://03-silhouette-and-form)")
      end
    end

    -- V1 value: murk (fill only: the lit side never gets light) and low contrast
    -- (whole subject, outline included: would it survive desaturation?) -----------
    local vals, all = {}, {}
    for y = miny, maxy do
      for x = minx, maxx do
        local k = at(x, y)
        if k then
          all[#all + 1] = colors[k].L
          if not outline[k] then vals[#vals + 1] = colors[k].L end
        end
      end
    end
    if #all >= 12 then
      table.sort(vals)
      table.sort(all)
      local p10, p50, p90 = percentile(all, 0.1), percentile(all, 0.5), percentile(all, 0.9)
      local fill90 = #vals > 0 and percentile(vals, 0.9) or p90
      R.values = { p10 = math.floor(p10 + 0.5), median = math.floor(p50 + 0.5), p90 = math.floor(p90 + 0.5), fillP90 = math.floor(fill90 + 0.5) }
      if #vals >= 12 and fill90 < 45 then
        add("V1", "warning", "murky values", string.format("the lightest tenth of the fill only reaches L*%.0f: everything sits in the dark third", fill90),
          R.values, nil, "Lift the lit side to the light end of each ramp; keep the darkest step for core shadows")
      elseif p90 - p10 < 18 then
        add("V1", "warning", "low value contrast", string.format("the whole subject spans only L*%.0f..%.0f: it will not survive desaturation", p10, p90),
          R.values, nil, "Widen the ramp: darker core shadow, lighter light side (preview view 'values')")
      end
    end

    R.interior = interiorCount
    return R
  end

  ---------------------------------------------------------------------------
  -- draw.shade: move pixels one ramp step darker/lighter, hue-shifted, within the palette
  ---------------------------------------------------------------------------
  local SHADOW_HUE, LIGHT_HUE = 300, 85 -- Lab hue angles: blue-violet shadows, warm yellow lights

  local function labInfo(r, g, b)
    local L, A, B = lab(r, g, b)
    local C = math.sqrt(A * A + B * B)
    local hue = C > 0 and math.deg(math.atan(B, A)) % 360 or 0
    return { r = r, g = g, b = b, L = L, A = A, B = B, C = C, hue = hue }
  end

  -- Rotate hue a toward hue b by at most `by` degrees.
  local function toward(a, b, by)
    local d = ((b - a + 540) % 360) - 180
    if math.abs(d) <= by then return b end
    return (a + (d > 0 and by or -by)) % 360
  end

  -- Best palette colour one step from `s` in direction dir (-1 shadow, +1 light), or nil.
  local function stepColor(s, dir, cands, stepL)
    local targetL = s.L + dir * stepL
    local chromatic = s.C >= 8
    local targetHue = chromatic and toward(s.hue, dir < 0 and SHADOW_HUE or LIGHT_HUE, 20) or nil
    local best, bestScore
    for _, p in ipairs(cands) do
      local dL = (p.L - s.L) * dir
      if dL >= 3 and dL <= 45 then
        local score = math.abs(p.L - targetL) / 10
        if chromatic then
          if p.C >= 8 then
            local hd = hueDiff(p.hue, s.hue)
            if hd > 75 then score = nil else score = score + hueDiff(p.hue, targetHue) / 25 end
          else
            score = score + 2.5 -- greying out is a last resort for a coloured material
          end
        else
          score = score + p.C / 12
        end
        if score and (not bestScore or score < bestScore) then best, bestScore = p, score end
      end
    end
    return best
  end

  M.OPS["draw.shade"] = function(spr, op)
    local steps = op.steps or -1
    if steps == 0 then H.fail("steps must not be 0 (negative = shadow, positive = light)") end
    local cands = {}
    if op.palette then
      for _, c in ipairs(op.palette) do
        local r, g, b, a = H.rgbaOf(spr, c)
        if a == 255 then cands[#cands + 1] = labInfo(r, g, b) end
      end
    else
      local pal = spr.palettes[1]
      local seen = {}
      for i = 0, #pal - 1 do
        local c = pal:getColor(i)
        local k = c.red .. "," .. c.green .. "," .. c.blue
        if c.alpha == 255 and not seen[k] then seen[k] = true; cands[#cands + 1] = labInfo(c.red, c.green, c.blue) end
      end
    end
    local only
    if op.colors then
      only = {}
      for _, c in ipairs(op.colors) do
        local r, g, b = H.rgbaOf(spr, c)
        only[r .. "," .. g .. "," .. b] = true
      end
    end
    local stepL = op.stepL or 14
    local cache, mapping, missing, mapped = {}, {}, {}, {}
    local function target(r, g, b)
      local k = r .. "," .. g .. "," .. b
      if cache[k] ~= nil then return cache[k] end
      local cur = labInfo(r, g, b)
      for _ = 1, math.abs(steps) do
        local nxt = stepColor(cur, steps < 0 and -1 or 1, cands, stepL)
        if not nxt then break end
        cur = nxt
      end
      if cur.r == r and cur.g == g and cur.b == b then
        cache[k] = false
        missing[#missing + 1] = H.hex(r, g, b, 255)
      else
        cache[k] = { cur.r, cur.g, cur.b }
        if not mapped[k] then
          mapped[k] = true
          mapping[#mapping + 1] = { from = H.hex(r, g, b, 255), to = H.hex(cur.r, cur.g, cur.b, 255) }
        end
      end
      return cache[k]
    end
    local res = H.withCel(spr, op, function(img, put)
      local x0, y0 = op.x or 0, op.y or 0
      local x1 = math.min(img.width - 1, op.width and x0 + op.width - 1 or img.width - 1)
      local y1 = math.min(img.height - 1, op.height and y0 + op.height - 1 or img.height - 1)
      for y = math.max(0, y0), y1 do
        for x = math.max(0, x0), x1 do
          local r, g, b, a = H.pixelRGBA(spr, img:getPixel(x, y), img.colorMode)
          if a > 0 and (not only or only[r .. "," .. g .. "," .. b]) then
            local t = target(r, g, b)
            if t then put(x, y, H.encode(spr, t[1], t[2], t[3], a)) end
          end
        end
      end
      return {}
    end)
    return {
      pixels = res.pixels,
      mapping = mapping,
      unchanged = #missing > 0 and missing or nil,
      hint = #missing > 0 and "no palette colour one step " .. (steps < 0 and "darker" or "lighter") .. " in the same hue family for some colours: add a ramp with pal.ramp (+ pal.add_colors)" or nil,
    }
  end

  ---------------------------------------------------------------------------
  -- the query
  ---------------------------------------------------------------------------
  QUERIES["check.craft"] = function(spr, args)
    local brief = H.getProp(spr, "brief") or {}
    local frames = H.frameList(spr, args, "all")
    local maxFrames = args.maxFrames or 24
    local truncated = #frames > maxFrames
    while #frames > maxFrames do table.remove(frames) end
    local outlineKey
    if args.outline then
      local r, g, b = H.rgbaOf(spr, args.outline)
      outlineKey = pc.rgba(r, g, b, 255)
    end
    local opts = {
      light = args.light or brief.light,
      maxColors = args.maxColors or brief.maxColors,
      allowSemi = args.allowSemiTransparency or brief.transparency == "soft",
      allowSymmetry = args.allowSymmetry,
      front = brief.perspective == "front",
      outline = outlineKey,
    }
    if opts.light == "front" then opts.light = nil end
    local ignore = {}
    for _, id in ipairs(args.ignore or {}) do ignore[id] = true end

    local agg, order, perFrame, excluded = {}, {}, {}, nil
    local lightByFrame = {}
    local first
    for _, fnum in ipairs(frames) do
      local img, ex = renderSubject(spr, fnum, args.layer)
      excluded = excluded or ex
      local r = analyzeFrame(img, opts)
      first = first or r
      perFrame[#perFrame + 1] = { frame = fnum, colors = r.colors, light = r.light and r.light.estimated, findings = #r.findings }
      if r.light and r.light.estimated ~= "none" then lightByFrame[#lightByFrame + 1] = { frame = fnum, v = r.light.vector, name = r.light.estimated } end
      for _, f in ipairs(r.findings) do
        if not ignore[f.id] then
          local key = f.id .. "|" .. f.tell
          local a = agg[key]
          if not a then
            a = f
            a.frames = { fnum }
            agg[key] = a
            order[#order + 1] = key
          else
            a.frames[#a.frames + 1] = fnum
            if f.severity == "blocking" then a.severity = "blocking" end
          end
        end
      end
    end
    -- light that moves between frames
    if not ignore.C6 and #lightByFrame >= 2 then
      local worst, wa, wb = 0, nil, nil
      for i = 1, #lightByFrame do
        for j = i + 1, #lightByFrame do
          local a, b = lightByFrame[i], lightByFrame[j]
          local ang = angleBetween(a.v[1], a.v[2], b.v[1], b.v[2])
          if ang > worst then worst, wa, wb = ang, a, b end
        end
      end
      if worst > 90 and wa and wb then
        local key = "C6|light moves between frames"
        agg[key] = { id = "C6", severity = "warning", tell = "light moves between frames",
          message = string.format("frame %d is lit from the %s, frame %d from the %s", wa.frame, wa.name, wb.frame, wb.name),
          evidence = { frames = { wa.frame, wb.frame }, angle = math.floor(worst + 0.5) }, fix = "Keep one light direction in every frame (rules://02)" }
        order[#order + 1] = key
      end
    end

    local findings, counts = {}, { blocking = 0, warning = 0, info = 0 }
    local rank = { blocking = 1, warning = 2, info = 3 }
    for _, k in ipairs(order) do
      local f = agg[k]
      if f.frames and #frames == 1 then f.frames = nil end
      f.rule = "rules://92-generated-art-tells#" .. f.id
      findings[#findings + 1] = f
      counts[f.severity] = counts[f.severity] + 1
    end
    table.sort(findings, function(a, b)
      if rank[a.severity] ~= rank[b.severity] then return rank[a.severity] < rank[b.severity] end
      return a.id < b.id
    end)
    local score = math.max(0, 100 - 25 * counts.blocking - 8 * counts.warning - 2 * counts.info)
    local verdict = counts.blocking > 0 and "blocking" or counts.warning > 0 and "needs-work" or "clean"
    local out = {
      verdict = verdict,
      score = score,
      counts = counts,
      findings = findings,
      subject = first and not first.empty and {
        bounds = first.bounds, colors = first.colors, colorBudget = first.colorCap, outline = first.outline,
        light = first.light and { estimated = first.light.estimated, strength = first.light.strength, brief = opts.light },
        symmetry = first.symmetry, values = first.values,
      } or nil,
      frames = #frames > 1 and perFrame or nil,
      framesTruncated = truncated or nil,
      excludedLayers = excluded and #excluded > 0 and excluded or nil,
      note = first and first.note,
      notChecked = "anatomy, readability of the silhouette, detail placement, interior colour-edge jaggies, diagonal banding, tile repetition: look at preview (frames, silhouette, values) and run skill://review",
    }
    if first and first.empty then out.note = "nothing opaque to check" end
    return out
  end
end
