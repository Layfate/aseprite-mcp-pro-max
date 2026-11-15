-- Tilesets and tilemap layers (Aseprite 1.3 tilemaps).
-- Cell coordinates are in tiles from the top-left of the canvas grid.
-- Tile 0 is the empty tile; tile indices start at 1.
return function(M, H)
  local OPS, QUERIES, VIEWS = M.OPS, M.QUERIES, M.VIEWS
  local fail, pc, Mask = H.fail, H.pc, H.Mask
  local findFrame, frameList = H.findFrame, H.frameList
  local pixelValue, transparentValue = H.pixelValue, H.transparentValue

  local FLIP_X, FLIP_Y, FLIP_D = 0x80000000, 0x40000000, 0x20000000
  local MAP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&*+=?@"

  local function tilemapLayer(spr, ref)
    local l = H.findLayer(spr, ref, true, true)
    if not l.isTilemap then fail("layer '" .. tostring(ref) .. "' is not a tilemap layer (create one with tile.create_layer)") end
    return l
  end
  H.tilemapLayer = tilemapLayer

  local function tileSize(layer)
    local s = layer.tileset.grid.tileSize
    return s.width, s.height
  end

  local function gridDims(spr, layer)
    local tw, th = tileSize(layer)
    return math.ceil(spr.width / tw), math.ceil(spr.height / th)
  end

  -- Full-grid copy of a tilemap cel: map[y][x] = raw value (index | flags).
  local function readMap(spr, layer, frameNo)
    local cols, rows = gridDims(spr, layer)
    local tw, th = tileSize(layer)
    local map = {}
    for y = 0, rows - 1 do map[y] = {} for x = 0, cols - 1 do map[y][x] = 0 end end
    local cel = layer:cel(frameNo)
    if cel then
      local ox, oy = cel.position.x // tw, cel.position.y // th
      for it in cel.image:pixels() do
        local x, y = it.x + ox, it.y + oy
        if x >= 0 and y >= 0 and x < cols and y < rows then map[y][x] = it() end
      end
    end
    return map, cols, rows
  end
  H.readTileMap = readMap

  local function writeMap(spr, layer, frameNo, map, cols, rows)
    if not layer.isEditable then fail("layer '" .. layer.name .. "' is locked") end
    local img = Image(cols, rows, ColorMode.TILEMAP)
    img:clear(0)
    for y = 0, rows - 1 do for x = 0, cols - 1 do img:drawPixel(x, y, map[y][x]) end end
    local cel = layer:cel(frameNo)
    if cel then
      cel.image = img
      cel.position = Point(0, 0)
    else
      spr:newCel(layer, frameNo, img, Point(0, 0))
    end
  end

  local function checkTile(layer, index)
    local n = #layer.tileset
    if index < 0 or index >= n then fail(string.format("tile %d does not exist (tileset has tiles 0-%d; 0 is empty)", index, n - 1)) end
  end

  -- Run fn(map, cols, rows) on each selected frame and write it back.
  local function editMaps(spr, op, fn)
    local layer = tilemapLayer(spr, op.layer)
    local changed = 0
    for _, fnum in ipairs(frameList(spr, op)) do
      local map, cols, rows = readMap(spr, layer, fnum)
      changed = changed + (fn(map, cols, rows, layer) or 0)
      writeMap(spr, layer, fnum, map, cols, rows)
    end
    return { cells = changed }
  end

  OPS["tile.create_layer"] = function(spr, op)
    H.checkLayerName(spr, op.name, false)
    app.activeSprite = spr
    local shared
    if op.tilesetFrom then shared = tilemapLayer(spr, op.tilesetFrom).tileset end
    app.command.NewLayer { tilemap = true, gridBounds = Rectangle(0, 0, op.tileWidth, op.tileHeight) }
    local layer = app.activeLayer
    if not layer or not layer.isTilemap then fail("Aseprite did not create a tilemap layer") end
    layer.name = op.name
    if shared then layer.tileset = shared end
    if op.tilesetName then layer.tileset.name = op.tilesetName end
    H.placeLayer(spr, layer, op)
    return { path = H.pathOf(spr, layer), tiles = #layer.tileset }
  end

  local function tileImageFromRows(spr, layer, rows, legend)
    local tw, th = tileSize(layer)
    local img = Image(tw, th, spr.colorMode)
    img:clear(transparentValue(spr))
    if rows then
      local values = {}
      for ch, c in pairs(legend or {}) do values[ch] = pixelValue(spr, c) end
      for y, row in ipairs(rows) do
        for x = 1, #row do
          local ch = row:sub(x, x)
          if ch ~= "." and ch ~= " " then
            local v = values[ch]
            if v == nil then fail("character '" .. ch .. "' is not in the legend") end
            if x <= tw and y <= th then img:drawPixel(x - 1, y - 1, v) end
          end
        end
      end
    end
    return img
  end

  OPS["tile.add"] = function(spr, op)
    local layer = tilemapLayer(spr, op.layer)
    local created = {}
    for _ = 1, op.count or 1 do
      local t = spr:newTile(layer.tileset)
      if op.rows then t.image = tileImageFromRows(spr, layer, op.rows, op.legend) end
      created[#created + 1] = t.index
    end
    return { tiles = created, total = #layer.tileset }
  end

  OPS["tile.draw"] = function(spr, op)
    local layer = tilemapLayer(spr, op.layer)
    checkTile(layer, op.tile)
    if op.tile == 0 then fail("tile 0 is the empty tile and cannot be drawn on") end
    local tile = layer.tileset:tile(op.tile)
    local img = tile.image:clone()
    local values = {}
    for ch, c in pairs(op.legend) do values[ch] = pixelValue(spr, c) end
    local n = 0
    for y, row in ipairs(op.rows) do
      for x = 1, #row do
        local ch = row:sub(x, x)
        if ch ~= "." and ch ~= " " then
          local v = values[ch]
          if v == nil then fail("character '" .. ch .. "' is not in the legend") end
          local px, py = (op.x or 0) + x - 1, (op.y or 0) + y - 1
          if px >= 0 and py >= 0 and px < img.width and py < img.height then img:drawPixel(px, py, v); n = n + 1 end
        end
      end
    end
    tile.image = img
    return { pixels = n }
  end

  local function imagesEqual(a, b) return a.width == b.width and a.height == b.height and a.bytes == b.bytes end

  local function flipped(img, fx, fy)
    local out = img:clone()
    if fx then out:flip(FlipType.HORIZONTAL) end
    if fy then out:flip(FlipType.VERTICAL) end
    return out
  end

  -- Find an existing tile equal to img (optionally under flips) -> index, flags.
  local function findTile(ts, img, flips)
    for i = 1, #ts - 1 do
      local t = ts:tile(i).image
      if imagesEqual(t, img) then return i, 0 end
      if flips then
        if imagesEqual(flipped(t, true, false), img) then return i, FLIP_X end
        if imagesEqual(flipped(t, false, true), img) then return i, FLIP_Y end
        if imagesEqual(flipped(t, true, true), img) then return i, FLIP_X | FLIP_Y end
      end
    end
    return nil
  end

  -- Cut an image region (layer pixels or a PNG) into tiles, reuse duplicates and paint the map.
  OPS["tile.import"] = function(spr, op)
    local layer = tilemapLayer(spr, op.layer)
    local tw, th = tileSize(layer)
    local src
    if op.file then
      local loaded = Image { fromFile = op.file }
      if not loaded then fail("could not load '" .. op.file .. "'") end
      src = Image(loaded.width, loaded.height, spr.colorMode)
      src:clear(transparentValue(spr))
      for it in loaded:pixels() do
        local r, g, b, a = H.pixelRGBA(spr, it(), loaded.colorMode)
        if a > 0 then src:drawPixel(it.x, it.y, H.encode(spr, r, g, b, a)) end
      end
    else
      local srcLayer = H.findLayer(spr, op.sourceLayer)
      src = H.editableImage(spr, srcLayer, findFrame(spr, op.sourceFrame or op.frame))
      if op.clearSource then
        -- remove the source pixels once they live in the tilemap
        local img, cel = H.editableImage(spr, srcLayer, findFrame(spr, op.sourceFrame or op.frame))
        img:clear(transparentValue(spr))
        H.commitImage(spr, srcLayer, findFrame(spr, op.sourceFrame or op.frame), img, cel)
      end
    end
    local sx, sy = op.x or 0, op.y or 0
    local sw, sh = op.width or (src.width - sx), op.height or (src.height - sy)
    local cols, rows = math.floor(sw / tw), math.floor(sh / th)
    if cols < 1 or rows < 1 then fail("source region is smaller than one tile") end
    local fnum = op.frame or 1
    local map, mc, mr = readMap(spr, layer, fnum)
    local ox, oy = op.cellX or (sx // tw), op.cellY or (sy // th)
    local added, reused, empty = 0, 0, 0
    local tv = transparentValue(spr)
    for cy = 0, rows - 1 do
      for cx = 0, cols - 1 do
        local img = Image(tw, th, spr.colorMode)
        img:clear(tv)
        img:drawImage(src, Point(-(sx + cx * tw), -(sy + cy * th)), 255, BlendMode.SRC)
        local value
        if img:isEmpty() then
          value = 0
          empty = empty + 1
        else
          local idx, flags = nil, 0
          if op.dedupe ~= false then idx, flags = findTile(layer.tileset, img, op.flips) end
          if idx then reused = reused + 1 else
            local t = spr:newTile(layer.tileset)
            t.image = img
            idx, flags = t.index, 0
            added = added + 1
          end
          value = pc.tile(idx, flags or 0)
        end
        local mx, my = ox + cx, oy + cy
        if mx < mc and my < mr then map[my][mx] = value end
      end
    end
    writeMap(spr, layer, fnum, map, mc, mr)
    return { added = added, reused = reused, emptyCells = empty, tiles = #layer.tileset, cols = cols, rows = rows }
  end

  -- Paint cells from a character grid ('.' keeps, legend char -> tile index) or a numeric grid.
  OPS["tile.paint"] = function(spr, op)
    return editMaps(spr, op, function(map, cols, rows, layer)
      local n = 0
      local x0, y0 = op.x or 0, op.y or 0
      local function set(x, y, idx)
        checkTile(layer, idx)
        if x >= 0 and y >= 0 and x < cols and y < rows then map[y][x] = pc.tile(idx, 0); n = n + 1 end
      end
      if op.cells then
        for r, row in ipairs(op.cells) do
          for c, idx in ipairs(row) do if idx >= 0 then set(x0 + c - 1, y0 + r - 1, idx) end end
        end
      else
        for r, row in ipairs(op.rows) do
          for c = 1, #row do
            local ch = row:sub(c, c)
            if ch ~= "." and ch ~= " " then
              local idx = op.legend and op.legend[ch]
              if idx == nil then fail("character '" .. ch .. "' is not in the legend") end
              set(x0 + c - 1, y0 + r - 1, idx)
            end
          end
        end
      end
      return n
    end)
  end

  OPS["tile.fill"] = function(spr, op)
    return editMaps(spr, op, function(map, cols, rows, layer)
      checkTile(layer, op.tile)
      if op.x < 0 or op.y < 0 or op.x >= cols or op.y >= rows then fail("seed cell is outside the map") end
      local target = pc.tileI(map[op.y][op.x])
      if target == op.tile then return 0 end
      local n, stack, seen = 0, { { op.x, op.y } }, {}
      while #stack > 0 do
        local p = table.remove(stack)
        local x, y = p[1], p[2]
        local k = y * 65536 + x
        if x >= 0 and y >= 0 and x < cols and y < rows and not seen[k] and pc.tileI(map[y][x]) == target then
          seen[k] = true
          map[y][x] = pc.tile(op.tile, 0)
          n = n + 1
          stack[#stack + 1] = { x + 1, y }; stack[#stack + 1] = { x - 1, y }
          stack[#stack + 1] = { x, y + 1 }; stack[#stack + 1] = { x, y - 1 }
        end
      end
      return n
    end)
  end

  OPS["tile.rect"] = function(spr, op)
    return editMaps(spr, op, function(map, cols, rows, layer)
      checkTile(layer, op.tile)
      local n = 0
      for y = op.y, op.y + op.height - 1 do
        for x = op.x, op.x + op.width - 1 do
          local edge = x == op.x or y == op.y or x == op.x + op.width - 1 or y == op.y + op.height - 1
          if x >= 0 and y >= 0 and x < cols and y < rows and (not op.outline or edge) then map[y][x] = pc.tile(op.tile, 0); n = n + 1 end
        end
      end
      return n
    end)
  end

  -- Replace tile index `from` with `to` in maps (all frames by default).
  OPS["tile.replace"] = function(spr, op)
    local args = { layer = op.layer, frame = op.frame, frames = op.frames, fromFrame = op.fromFrame, toFrame = op.toFrame, tag = op.tag }
    if not H.hasFrameSel(op) then args.fromFrame, args.toFrame = 1, #spr.frames end
    return editMaps(spr, args, function(map, cols, rows, layer)
      checkTile(layer, op.to)
      local n = 0
      for y = 0, rows - 1 do
        for x = 0, cols - 1 do
          if pc.tileI(map[y][x]) == op.from then
            map[y][x] = pc.tile(op.to, op.keepFlags and pc.tileF(map[y][x]) or 0)
            n = n + 1
          end
        end
      end
      return n
    end)
  end

  -- Every tilemap layer that uses a tileset.
  local function layersUsing(spr, ts)
    local out = {}
    for _, e in ipairs(H.allLayers(spr)) do
      if e.layer.isTilemap and e.layer.tileset == ts then out[#out + 1] = e.layer end
    end
    return out
  end

  -- Remap tile indices in every map using the tileset (index -> new index or 0).
  local function remapTiles(spr, ts, map_)
    for _, l in ipairs(layersUsing(spr, ts)) do
      for _, cel in ipairs(l.cels) do
        local img = cel.image:clone()
        local changed = false
        for it in img:pixels() do
          local v = it()
          local i = pc.tileI(v)
          local ni = map_[i]
          if ni and ni ~= i then it(pc.tile(ni, pc.tileF(v))); changed = true end
        end
        if changed then cel.image = img end
      end
    end
  end

  local function deleteTiles(spr, ts, doomed)
    -- doomed: set of indices to remove; remap everything above them
    local map_, shift = {}, 0
    for i = 0, #ts - 1 do
      if doomed[i] then shift = shift + 1 else map_[i] = i - shift end
    end
    remapTiles(spr, ts, map_)
    local list = {}
    for i in pairs(doomed) do list[#list + 1] = i end
    table.sort(list, function(a, b) return a > b end)
    for _, i in ipairs(list) do spr:deleteTile(ts, i) end
  end

  OPS["tile.dedupe"] = function(spr, op)
    local layer = tilemapLayer(spr, op.layer)
    local ts = layer.tileset
    local canon, doomed, n = {}, {}, 0
    for i = 1, #ts - 1 do
      local img = ts:tile(i).image
      if img:isEmpty() then
        canon[i] = 0; doomed[i] = true; n = n + 1
      else
        for j = 1, i - 1 do
          if not doomed[j] and imagesEqual(ts:tile(j).image, img) then canon[i] = j; doomed[i] = true; n = n + 1; break end
        end
      end
    end
    if n == 0 then return { removed = 0, tiles = #ts } end
    remapTiles(spr, ts, canon)
    deleteTiles(spr, ts, doomed)
    return { removed = n, tiles = #ts }
  end

  OPS["tile.delete"] = function(spr, op)
    local layer = tilemapLayer(spr, op.layer)
    checkTile(layer, op.tile)
    if op.tile == 0 then fail("tile 0 is the empty tile") end
    local ts = layer.tileset
    remapTiles(spr, ts, { [op.tile] = op.replaceWith or 0 })
    deleteTiles(spr, ts, { [op.tile] = true })
    return { tiles = #ts }
  end

  -- Shift a tile's pixels with wrap-around (exposes seams so they can be painted out).
  OPS["tile.offset_wrap"] = function(spr, op)
    local layer = tilemapLayer(spr, op.layer)
    checkTile(layer, op.tile)
    local tile = layer.tileset:tile(op.tile)
    local src = tile.image
    local w, h = src.width, src.height
    local dx, dy = op.dx or (w // 2), op.dy or (h // 2)
    local out = Image(w, h, src.colorMode)
    for it in src:pixels() do out:drawPixel((it.x + dx) % w, (it.y + dy) % h, it()) end
    tile.image = out
    return { dx = dx, dy = dy }
  end

  -- Generate tile variants (flips, 90-degree rotations, recolors, deterministic noise).
  OPS["tile.variants"] = function(spr, op)
    local layer = tilemapLayer(spr, op.layer)
    checkTile(layer, op.tile)
    local base = layer.tileset:tile(op.tile).image
    local created = {}
    local function add(img)
      if op.skipDuplicates ~= false and findTile(layer.tileset, img, false) then return end
      local t = spr:newTile(layer.tileset)
      t.image = img
      created[#created + 1] = t.index
    end
    for _, f in ipairs(op.flips or {}) do add(flipped(base, f:find("x") ~= nil, f:find("y") ~= nil)) end
    for _, a in ipairs(op.rotations or {}) do
      local w, h = base.width, base.height
      if w ~= h then fail("rotations need square tiles") end
      local out = Image(w, h, base.colorMode)
      for it in base:pixels() do
        local x, y = it.x, it.y
        local nx, ny
        if a == 90 then nx, ny = w - 1 - y, x elseif a == 180 then nx, ny = w - 1 - x, h - 1 - y else nx, ny = y, w - 1 - x end
        out:drawPixel(nx, ny, it())
      end
      add(out)
    end
    for _, rc in ipairs(op.recolors or {}) do
      local out = base:clone()
      local map_ = {}
      for _, m in ipairs(rc) do map_[pixelValue(spr, m.from)] = pixelValue(spr, m.to) end
      for it in out:pixels() do local v = map_[it()]; if v then it(v) end end
      add(out)
    end
    if op.noise then
      local values = {}
      for i, c in ipairs(op.noise.colors) do values[i] = pixelValue(spr, c) end
      for k = 1, op.noise.count or 1 do
        local rand = H.rng((op.noise.seed or 1) + k * 7919)
        local out = base:clone()
        for it in out:pixels() do
          local r1, r2 = rand(), rand()
          if r1 < (op.noise.density or 0.1) and H.isOpaque(spr, it(), out.colorMode) then it(values[math.floor(r2 * #values) + 1]) end
        end
        add(out)
      end
    end
    return { tiles = created }
  end

  -- Autotile rules: 4-bit masks (N=1, E=2, S=4, W=8 set when that neighbour is the same terrain).
  OPS["tile.terrain_set"] = function(spr, op)
    local layer = tilemapLayer(spr, op.layer)
    local terrains = H.getProp(layer.tileset, "terrains") or {}
    local rules = {}
    for k, v in pairs(op.rules) do
      local mask = tonumber(k)
      if not mask or mask < 0 or mask > 15 then fail("rule keys are 4-bit masks 0-15 (N=1,E=2,S=4,W=8), got '" .. tostring(k) .. "'") end
      checkTile(layer, v)
      rules[tostring(mask)] = v
    end
    if op.default then checkTile(layer, op.default) end
    terrains[op.terrain] = { rules = rules, default = op.default }
    H.setProp(layer.tileset, "terrains", terrains)
    local missing = {}
    for m = 0, 15 do if rules[tostring(m)] == nil then missing[#missing + 1] = m end end
    return { terrain = op.terrain, rules = 16 - #missing, missing = #missing > 0 and missing or nil }
  end

  OPS["tile.autotile"] = function(spr, op)
    local layer = tilemapLayer(spr, op.layer)
    local terrains = H.getProp(layer.tileset, "terrains") or {}
    local t = terrains[op.terrain]
    if not t then fail("terrain '" .. op.terrain .. "' is not defined (use tile.terrain_set)") end
    local function on(x, y)
      local row = op.rows[y + 1]
      if not row then return op.edgesSolid or false end
      local ch = row:sub(x + 1, x + 1)
      if ch == "" then return op.edgesSolid or false end
      return ch == "#"
    end
    local missing = {}
    local res = editMaps(spr, op, function(map, cols, rows)
      local n = 0
      for y, row in ipairs(op.rows) do
        for x = 1, #row do
          local mx, my = (op.x or 0) + x - 1, (op.y or 0) + y - 1
          if row:sub(x, x) == "#" and mx < cols and my < rows then
            local cx, cy = x - 1, y - 1
            local mask = (on(cx, cy - 1) and 1 or 0) + (on(cx + 1, cy) and 2 or 0) + (on(cx, cy + 1) and 4 or 0) + (on(cx - 1, cy) and 8 or 0)
            local idx = t.rules[tostring(mask)] or t.default
            if not idx then missing[mask] = true else map[my][mx] = pc.tile(idx, 0); n = n + 1 end
          elseif op.clearOthers and mx < cols and my < rows and row:sub(x, x) == "." then
            map[my][mx] = 0
          end
        end
      end
      return n
    end)
    local m = {}
    for k in pairs(missing) do m[#m + 1] = k end
    table.sort(m)
    if #m > 0 then res.missingMasks = m end
    return res
  end

  OPS["tile.collision_set"] = function(spr, op)
    local layer = tilemapLayer(spr, op.layer)
    local tiles = op.tiles or { op.tile }
    for _, i in ipairs(tiles) do
      checkTile(layer, i)
      if i == 0 then fail("tile 0 (empty) cannot carry collision") end
      local tile = layer.tileset:tile(i)
      if op.shape == "none" then
        H.setProp(tile, "collision", nil)
      else
        H.setProp(tile, "collision", { shape = op.shape, polygon = op.polygon, oneWay = op.oneWay, layer = op.physicsLayer })
      end
    end
    return { tiles = #tiles }
  end

  QUERIES["tile.collision_get"] = function(spr, args)
    local layer = tilemapLayer(spr, args.layer)
    local out = {}
    for i = 1, #layer.tileset - 1 do
      local c = H.getProp(layer.tileset:tile(i), "collision")
      if c then c.tile = i; out[#out + 1] = c end
    end
    return { tiles = out }
  end

  OPS["tile.set_flags"] = function(spr, op)
    return editMaps(spr, op, function(map, cols, rows)
      local n = 0
      local w, h = op.width or 1, op.height or 1
      local flags = (op.flipX and FLIP_X or 0) | (op.flipY and FLIP_Y or 0) | (op.diagonal and FLIP_D or 0)
      for y = op.y, op.y + h - 1 do
        for x = op.x, op.x + w - 1 do
          if x >= 0 and y >= 0 and x < cols and y < rows and pc.tileI(map[y][x]) > 0 then
            map[y][x] = pc.tile(pc.tileI(map[y][x]), flags)
            n = n + 1
          end
        end
      end
      return n
    end)
  end

  QUERIES["tile.read_map"] = function(spr, args)
    local layer = tilemapLayer(spr, args.layer)
    local map, cols, rows = readMap(spr, layer, args.frame or 1)
    local x0, y0 = args.x or 0, args.y or 0
    local w, h = math.min(args.width or cols, cols - x0), math.min(args.height or rows, rows - y0)
    local charOf, legend, nextChar, rowsOut, flagged = {}, {}, 1, {}, {}
    for y = y0, y0 + h - 1 do
      local r = {}
      for x = x0, x0 + w - 1 do
        local v = map[y][x]
        local i = pc.tileI(v)
        if i == 0 then r[#r + 1] = "." else
          local ch = charOf[i]
          if not ch then
            if nextChar > #MAP_CHARS then fail("region uses too many distinct tiles; read a smaller region") end
            ch = MAP_CHARS:sub(nextChar, nextChar)
            nextChar = nextChar + 1
            charOf[i] = ch
            legend[ch] = i
          end
          r[#r + 1] = ch
          local f = pc.tileF(v)
          if f ~= 0 and #flagged < 32 then
            flagged[#flagged + 1] = { x = x, y = y, flipX = (f & FLIP_X) ~= 0 or nil, flipY = (f & FLIP_Y) ~= 0 or nil, diagonal = (f & FLIP_D) ~= 0 or nil }
          end
        end
      end
      rowsOut[#rowsOut + 1] = table.concat(r)
    end
    local tw, th = tileSize(layer)
    return { x = x0, y = y0, cols = w, rows = rowsOut, legend = legend, tileWidth = tw, tileHeight = th, flags = #flagged > 0 and flagged or nil }
  end

  QUERIES["tile.list"] = function(spr, args)
    local layer = tilemapLayer(spr, args.layer)
    local ts = layer.tileset
    local usage = {}
    for _, l in ipairs(layersUsing(spr, ts)) do
      for _, cel in ipairs(l.cels) do
        for it in cel.image:pixels() do
          local i = pc.tileI(it())
          usage[i] = (usage[i] or 0) + 1
        end
      end
    end
    local tiles = {}
    for i = 1, #ts - 1 do
      local img = ts:tile(i).image
      local colors, set = 0, {}
      for it in img:pixels() do
        local v = it()
        if H.isOpaque(spr, v, img.colorMode) and not set[v] then set[v] = true; colors = colors + 1 end
      end
      tiles[#tiles + 1] = {
        tile = i, colors = colors, empty = img:isEmpty() or nil, uses = usage[i] or 0,
        collision = H.getProp(ts:tile(i), "collision") and true or nil,
      }
    end
    local page = H.page(tiles, args)
    local tw, th = tileSize(layer)
    page.tileset = { name = ts.name, tileWidth = tw, tileHeight = th, count = #ts - 1, terrains = H.getProp(ts, "terrains") }
    return page
  end

  -- Seam check. mode=self: does each tile wrap seamlessly? mode=map: are neighbouring
  -- cells continuous? A seam is flagged when the color change across a tile edge is much
  -- larger than the average change between neighbouring pixel columns/rows inside tiles.
  QUERIES["tile.check_seams"] = function(spr, args)
    local layer = tilemapLayer(spr, args.layer)
    local ts = layer.tileset
    local tw, th = tileSize(layer)
    local factor = args.factor or 2
    local function dist(img, x1, y1, img2, x2, y2)
      local r1, g1, b1, a1 = H.pixelRGBA(spr, img:getPixel(x1, y1), img.colorMode)
      local r2, g2, b2, a2 = H.pixelRGBA(spr, img2:getPixel(x2, y2), img2.colorMode)
      return math.abs(r1 - r2) + math.abs(g1 - g2) + math.abs(b1 - b2) + math.abs(a1 - a2)
    end
    local function interior(img)
      local s, n = 0, 0
      for y = 0, th - 1 do for x = 0, tw - 2 do s = s + dist(img, x, y, img, x + 1, y); n = n + 1 end end
      for y = 0, th - 2 do for x = 0, tw - 1 do s = s + dist(img, x, y, img, x, y + 1); n = n + 1 end end
      return n > 0 and s / n or 0
    end
    local function edgeH(a, b) -- a's right edge vs b's left edge
      local s = 0
      for y = 0, th - 1 do s = s + dist(a, tw - 1, y, b, 0, y) end
      return s / th
    end
    local function edgeV(a, b) -- a's bottom vs b's top
      local s = 0
      for x = 0, tw - 1 do s = s + dist(a, x, th - 1, b, x, 0) end
      return s / tw
    end
    local seams = {}
    local checked = 0
    if (args.mode or "self") == "self" then
      for i = 1, #ts - 1 do
        local img = ts:tile(i).image
        if not img:isEmpty() then
          checked = checked + 1
          local base = math.max(interior(img), 8)
          local hx, vy = edgeH(img, img), edgeV(img, img)
          if hx > factor * base or vy > factor * base then
            seams[#seams + 1] = { tile = i, horizontal = math.floor(hx) , vertical = math.floor(vy), interior = math.floor(base), wrapsX = hx <= factor * base, wrapsY = vy <= factor * base }
          end
        end
      end
    else
      local map, cols, rows = readMap(spr, layer, args.frame or 1)
      for y = 0, rows - 1 do
        for x = 0, cols - 1 do
          local i = pc.tileI(map[y][x])
          if i > 0 and i < #ts then
            local a = ts:tile(i).image
            local base = math.max(interior(a), 8)
            for _, d in ipairs({ { 1, 0 }, { 0, 1 } }) do
              local nx, ny = x + d[1], y + d[2]
              if nx < cols and ny < rows then
                local j = pc.tileI(map[ny][nx])
                if j > 0 and j < #ts then
                  checked = checked + 1
                  local b = ts:tile(j).image
                  local e = d[1] == 1 and edgeH(a, b) or edgeV(a, b)
                  if e > factor * base and #seams < 64 then
                    seams[#seams + 1] = { x = x, y = y, toX = nx, toY = ny, tiles = { i, j }, edge = math.floor(e), interior = math.floor(base) }
                  end
                end
              end
            end
          end
        end
      end
    end
    return { mode = args.mode or "self", checked = checked, seams = seams, seamless = #seams == 0 }
  end

  -- Tileset atlas PNG (columns x rows of tiles, optional spacing).
  VIEWS["tile.export_atlas"] = function(spr, args, req)
    local layer = tilemapLayer(spr, args.layer)
    local ts = layer.tileset
    local tw, th = tileSize(layer)
    local n = #ts - 1
    local cols = args.columns or math.max(1, math.ceil(math.sqrt(n)))
    local rows = math.max(1, math.ceil(n / cols))
    local sp = args.spacing or 0
    local out = Image(cols * tw + (cols - 1) * sp, rows * th + (rows - 1) * sp, ColorMode.RGB)
    out:clear(0)
    for i = 1, n do
      local timg = ts:tile(i).image
      local cx, cy = (i - 1) % cols, (i - 1) // cols
      for it in timg:pixels() do
        local r, g, b, a = H.pixelRGBA(spr, it(), timg.colorMode)
        if a > 0 then out:drawPixel(cx * (tw + sp) + it.x, cy * (th + sp) + it.y, pc.rgba(r, g, b, a)) end
      end
    end
    out:saveAs(req.output)
    -- collision + terrain metadata for engine exporters
    local tiles = {}
    for i = 1, n do
      local cx, cy = (i - 1) % cols, (i - 1) // cols
      tiles[#tiles + 1] = { tile = i, x = cx * (tw + sp), y = cy * (th + sp), col = cx, row = cy, collision = H.getProp(ts:tile(i), "collision") }
    end
    return { width = out.width, height = out.height, columns = cols, rows = rows, tileWidth = tw, tileHeight = th, spacing = sp, tiles = tiles, name = ts.name }
  end

  -- Map dump for engine exporters: every tilemap layer's cells (tile index - 1 = atlas slot).
  QUERIES["tile.export_maps"] = function(spr, args)
    local out = {}
    for _, e in ipairs(H.allLayers(spr)) do
      if e.layer.isTilemap and (not args.layer or args.layer == e.path) then
        local map, cols, rows = readMap(spr, e.layer, args.frame or 1)
        local cells = {}
        for y = 0, rows - 1 do
          for x = 0, cols - 1 do
            local v = map[y][x]
            local i = pc.tileI(v)
            if i > 0 then
              local f = pc.tileF(v)
              cells[#cells + 1] = { x, y, i, (f & FLIP_X) ~= 0 and 1 or 0, (f & FLIP_Y) ~= 0 and 1 or 0, (f & FLIP_D) ~= 0 and 1 or 0 }
            end
          end
        end
        local tw, th = tileSize(e.layer)
        out[#out + 1] = { layer = e.path, cols = cols, rows = rows, tileWidth = tw, tileHeight = th, cells = cells, tileset = e.layer.tileset.name }
      end
    end
    return { maps = out }
  end

  H.FLIP_X, H.FLIP_Y, H.FLIP_D = FLIP_X, FLIP_Y, FLIP_D
  local _ = Mask
end
