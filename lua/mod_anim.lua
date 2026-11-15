-- Animation: tweens, reviewable in-betweens, direction sets, scaffolding, timing.
return function(M, H)
  local OPS, QUERIES = M.OPS, M.QUERIES
  local fail, round, pc = H.fail, H.round, H.pc
  local findLayer, findFrame, findTag, frameList = H.findLayer, H.findFrame, H.findTag, H.frameList
  local editableImage, commitImage, transparentValue = H.editableImage, H.commitImage, H.transparentValue
  local allLayers, imageLayers = H.allLayers, H.imageLayers

  OPS["anim.tween"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    H.assertEditable(layer)
    findFrame(spr, op.fromFrame); findFrame(spr, op.toFrame)
    if op.toFrame <= op.fromFrame then fail("toFrame must be greater than fromFrame") end
    local ease = H.EASE[op.easing or "linear"]
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

  local function centroid(spr, img)
    local sx, sy, n = 0, 0, 0
    local tv = transparentValue(spr)
    for it in img:pixels() do
      if it() ~= tv then sx, sy, n = sx + it.x, sy + it.y, n + 1 end
    end
    if n == 0 then return nil end
    return sx / n, sy / n
  end

  local function generatedList(spr) return H.getProp(spr, "generated") or {} end

  -- Insert `count` editable in-between frames between two keyframes. Every
  -- generated frame range is marked with a tag "mcp:inbetween:<id>" so it can be
  -- reviewed, accepted (anim.accept_generated) or reverted (anim.remove_generated).
  OPS["anim.inbetween"] = function(spr, op)
    local a, b = op.fromFrame, op.toFrame
    findFrame(spr, a); findFrame(spr, b)
    if b <= a then fail("toFrame must be greater than fromFrame") end
    local count = op.count or 1
    local mode = op.mode or "motion"
    local layers = {}
    if op.layers then for _, ref in ipairs(op.layers) do layers[#layers + 1] = findLayer(spr, ref) end
    else layers = imageLayers(spr) end
    -- capture keyframe images before inserting frames
    local keys = {}
    for i, l in ipairs(layers) do
      local fa = findFrame(spr, a)
      local fb = findFrame(spr, b)
      local ia = editableImage(spr, l, fa)
      local ib = editableImage(spr, l, fb)
      keys[i] = { a = ia, b = ib }
    end
    local dur = op.durationMs and op.durationMs / 1000 or spr.frames[a].duration
    local insertAt = b -- new frames go right before keyframe B
    local created = {}
    created = H.insertFrames(spr, insertAt, count)
    for _, n in ipairs(created) do spr.frames[n].duration = dur end
    local tv = transparentValue(spr)
    for k, fnum in ipairs(created) do
      local t = k / (count + 1)
      if op.easing then t = H.EASE[op.easing](t) end
      for i, l in ipairs(layers) do
        local ia, ib = keys[i].a, keys[i].b
        local out = Image(spr.spec)
        out:clear(tv)
        if mode == "motion" then
          local ax, ay = centroid(spr, ia)
          local bx, by = centroid(spr, ib)
          local src = ia
          if not ax then src = ib end
          if ax and bx then
            local dx, dy = round((bx - ax) * t), round((by - ay) * t)
            out:drawImage(src, Point(dx, dy), 255, BlendMode.SRC)
          elseif ax or bx then
            out:drawImage(src, Point(0, 0), 255, BlendMode.SRC)
          end
        elseif mode == "blend" then
          for y = 0, spr.height - 1 do
            for x = 0, spr.width - 1 do
              local threshold = (H.BAYER4[(y % 4) + 1][(x % 4) + 1] + 0.5) / 16
              local v = (t > threshold) and ib:getPixel(x, y) or ia:getPixel(x, y)
              if v ~= tv then out:drawPixel(x, y, v) end
            end
          end
        else -- hold
          out:drawImage(t < 0.5 and ia or ib, Point(0, 0), 255, BlendMode.SRC)
        end
        commitImage(spr, l, spr.frames[fnum], out, nil)
      end
    end
    local list = generatedList(spr)
    local id = op.id or string.format("g%d", #list + 1)
    for _, g in ipairs(list) do if g.id == id then fail("generated id '" .. id .. "' already exists") end end
    local tag = spr:newTag(created[1], created[#created])
    tag.name = "mcp:inbetween:" .. id
    tag.color = Color { r = 255, g = 0, b = 255 }
    list[#list + 1] = { id = id, mode = mode, count = count, keyA = a, keyB = b + count }
    H.setProp(spr, "generated", list)
    return { id = id, frames = created, tag = tag.name }
  end

  local function generatedTags(spr, id)
    local out = {}
    for _, t in ipairs(spr.tags) do
      local gid = t.name:match("^mcp:inbetween:(.+)$")
      if gid and (id == nil or gid == id) then out[#out + 1] = { tag = t, id = gid } end
    end
    return out
  end

  local function dropRecord(spr, ids)
    local list = generatedList(spr)
    local keep = {}
    for _, g in ipairs(list) do if not ids[g.id] then keep[#keep + 1] = g end end
    H.setProp(spr, "generated", #keep > 0 and keep or nil)
  end

  OPS["anim.remove_generated"] = function(spr, op)
    local tags = generatedTags(spr, op.id)
    if #tags == 0 then fail(op.id and ("no generated frames with id '" .. op.id .. "'") or "no generated frames to remove") end
    -- delete from the last range to the first so frame numbers stay valid
    table.sort(tags, function(x, y) return x.tag.fromFrame.frameNumber > y.tag.fromFrame.frameNumber end)
    local removed, ids = 0, {}
    for _, e in ipairs(tags) do
      local from, to = e.tag.fromFrame.frameNumber, e.tag.toFrame.frameNumber
      spr:deleteTag(e.tag)
      if to - from + 1 >= #spr.frames then fail("refusing to delete every frame") end
      for n = to, from, -1 do spr:deleteFrame(n); removed = removed + 1 end
      ids[e.id] = true
    end
    dropRecord(spr, ids)
    return { removedFrames = removed }
  end

  OPS["anim.accept_generated"] = function(spr, op)
    local tags = generatedTags(spr, op.id)
    if #tags == 0 then fail("no generated frames to accept") end
    local ids = {}
    for _, e in ipairs(tags) do spr:deleteTag(e.tag); ids[e.id] = true end
    dropRecord(spr, ids)
    return { accepted = #tags }
  end

  -- Add a repeating offset pattern to cel positions (bobbing, shaking, breathing).
  OPS["anim.offset_sequence"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    local frames = frameList(spr, op, "all")
    local n = 0
    for i, fnum in ipairs(frames) do
      local o = op.offsets[((i - 1) % #op.offsets) + 1]
      local cel = layer:cel(fnum)
      if cel and ((o.dx or 0) ~= 0 or (o.dy or 0) ~= 0) then
        cel.position = Point(cel.position.x + (o.dx or 0), cel.position.y + (o.dy or 0))
        n = n + 1
      end
    end
    return { cels = n }
  end

  -- Squash & stretch: per-frame nearest-neighbour scale around the content's bottom center.
  OPS["anim.squash_stretch"] = function(spr, op)
    local layer = findLayer(spr, op.layer)
    local frames = frameList(spr, op, "all")
    for i, fnum in ipairs(frames) do
      local s = op.scales[((i - 1) % #op.scales) + 1]
      if (s.x or 1) ~= 1 or (s.y or 1) ~= 1 then
        local u = H.layerContent(spr, layer, { fnum })
        if u then
          M.OPS["xf.scale_layer"](spr, {
            layer = op.layer, frame = fnum, scaleX = s.x or 1, scaleY = s.y or 1,
            pivotX = (u.x0 + u.x1 + 1) / 2, pivotY = u.y1 + 1,
          })
        end
      end
    end
    return { frames = #frames }
  end

  -- Create the mirrored direction of a tagged animation (e.g. walk_e -> walk_w).
  OPS["anim.mirror_direction"] = function(spr, op)
    local src = findTag(spr, op.tag)
    for _, t in ipairs(spr.tags) do if t.name == op.name then fail("a tag named '" .. op.name .. "' already exists") end end
    local from, to = src.fromFrame.frameNumber, src.toFrame.frameNumber
    local at = #spr.frames + 1
    OPS["frame.duplicate"](spr, { from = from, to = to, insertAt = at })
    local newFrom, newTo = at, at + (to - from)
    local axis = op.axis or "horizontal"
    for _, e in ipairs(allLayers(spr)) do
      local l = e.layer
      if not l.isGroup and not l.isTilemap and l.isEditable then
        for n = newFrom, newTo do
          if l:cel(n) then OPS["xf.flip"](spr, { layer = e.path, frame = n, direction = axis }) end
        end
      end
    end
    local t = spr:newTag(newFrom, newTo)
    t.name = op.name
    t.aniDir = src.aniDir
    t.repeats = src.repeats
    return { from = newFrom, to = newTo }
  end

  -- Lay out states x directions as tags (frames appended; optionally filled with a base frame).
  OPS["anim.scaffold"] = function(spr, op)
    local pattern = op.pattern or "{state}_{dir}"
    local dirs = op.directions or { "" }
    local created = {}
    local existing = {}
    for _, t in ipairs(spr.tags) do existing[t.name] = true end
    local firstUse = #spr.frames == 1 and #spr.tags == 0 and op.reuseFirstFrame ~= false
    for _, state in ipairs(op.states) do
      for _, dir in ipairs(dirs) do
        local name = dir == "" and state.name or pattern:gsub("{state}", state.name):gsub("{dir}", dir)
        if existing[name] then fail("tag '" .. name .. "' already exists") end
        local start
        if firstUse then
          start = 1
          if state.frames > 1 then H.insertFrames(spr, 2, state.frames - 1) end
          firstUse = false
        else
          start = #spr.frames + 1
          H.insertFrames(spr, start, state.frames)
        end
        local stop = start + state.frames - 1
        for n = start, stop do
          if state.durationMs then spr.frames[n].duration = state.durationMs / 1000 end
          if op.baseFrame and op.baseFrame ~= n then H.copyFrameCels(spr, op.baseFrame, n); if state.durationMs then spr.frames[n].duration = state.durationMs / 1000 end end
        end
        local t = spr:newTag(start, stop)
        t.name = name
        if state.direction then t.aniDir = H.ANIDIR[state.direction] end
        if state.repeats then t.repeats = state.repeats end
        created[#created + 1] = { name = name, from = start, to = stop }
        existing[name] = true
      end
    end
    return { tags = created }
  end

  -- Rotate the frame order inside a tag (choose which pose the loop starts on).
  OPS["anim.cycle_shift"] = function(spr, op)
    local t = findTag(spr, op.tag)
    local from, to = t.fromFrame.frameNumber, t.toFrame.frameNumber
    local len = to - from + 1
    local by = op.by % len
    if by == 0 then return {} end
    for _ = 1, by do OPS["frame.move"](spr, { from = from, to = to }) end
    return { by = by }
  end

  -- Palette cycling: in the k-th selected frame, shift colors along `colors` by k*step.
  OPS["anim.palette_cycle"] = function(spr, op)
    local frames = frameList(spr, op, "all")
    local list = {}
    for i, c in ipairs(op.colors) do list[i] = { H.rgbaOf(spr, c) } end
    local n = #list
    local total = 0
    for k, fnum in ipairs(frames) do
      local shift = ((k - 1) * (op.step or 1)) % n
      if shift ~= 0 then
        local map = {}
        for i, c in ipairs(list) do map[H.hex(c[1], c[2], c[3], c[4])] = list[((i - 1 + shift) % n) + 1] end
        total = total + H.mapPixels(spr, { layer = op.layer, frame = fnum }, function(r, g, b, a)
          local t = map[H.hex(r, g, b, a)]
          if t then return t[1], t[2], t[3], t[4] end
        end)
      end
    end
    return { pixels = total }
  end

  QUERIES["anim.timing_report"] = function(spr, args)
    local out = {}
    local function report(name, from, to)
      local total, minD, maxD = 0, math.huge, 0
      for n = from, to do
        local d = round(spr.frames[n].duration * 1000)
        total, minD, maxD = total + d, math.min(minD, d), math.max(maxD, d)
      end
      local frames = to - from + 1
      return { name = name, from = from, to = to, frames = frames, totalMs = total, avgFps = math.floor(frames * 100000 / total) / 100, minMs = minD, maxMs = maxD, uniform = minD == maxD }
    end
    for _, t in ipairs(spr.tags) do
      if not args.tag or args.tag == t.name then out[#out + 1] = report(t.name, t.fromFrame.frameNumber, t.toFrame.frameNumber) end
    end
    local all = report("(all frames)", 1, #spr.frames)
    return { tags = out, overall = all }
  end

  local function frameDiff(spr, a, b, layer)
    local ia, ib = H.renderFrame(spr, a, layer), H.renderFrame(spr, b, layer)
    local n = 0
    for y = 0, spr.height - 1 do
      for x = 0, spr.width - 1 do
        local va, vb = ia:getPixel(x, y), ib:getPixel(x, y)
        if va ~= vb and not (pc.rgbaA(va) == 0 and pc.rgbaA(vb) == 0) then n = n + 1 end
      end
    end
    return n
  end
  H.frameDiff = frameDiff

  -- Loop seam check: is last->first a much bigger jump than the typical step?
  QUERIES["anim.loop_check"] = function(spr, args)
    local out = {}
    for _, t in ipairs(spr.tags) do
      if (not args.tag or args.tag == t.name) and not t.name:match("^mcp:") then
        local from, to = t.fromFrame.frameNumber, t.toFrame.frameNumber
        if to > from then
          local steps = {}
          for n = from, to - 1 do steps[#steps + 1] = frameDiff(spr, n, n + 1, args.layer) end
          local seam = frameDiff(spr, to, from, args.layer)
          local sorted = { table.unpack(steps) }
          table.sort(sorted)
          local median = sorted[math.ceil(#sorted / 2)]
          local entry = { tag = t.name, steps = steps, seam = seam, median = median }
          if seam == 0 and t.aniDir == H.ANIDIR.forward then entry.issue = "last frame equals first frame (the loop stutters on a repeated pose)"
          elseif median > 0 and seam > (args.factor or 2.5) * median then entry.issue = "loop seam jump is much larger than the typical frame-to-frame change" end
          out[#out + 1] = entry
        end
      end
    end
    return { tags = out }
  end
end
