"""Animation polish: squash & stretch, smears, hit flashes, particles,
secondary motion, and an animation critic.

All generators write real pixels into real frames (no tweened cel offsets),
so the result is exactly what exports and what you can hand-fix.
"""
from __future__ import annotations

import math

import numpy as np

from .. import mcp
from . import colorsci as cs
from . import pixops as po
from . import pixio
from .common import as_json, check_file, fit_scale, image_reply, on_bg, row, titled, tool_errors, zoom
from .fixers import targets

EASINGS = {
    "linear": lambda t: t,
    "ease_in": lambda t: t * t,
    "ease_out": lambda t: 1 - (1 - t) ** 2,
    "ease_in_out": lambda t: 3 * t * t - 2 * t ** 3,
    "back_out": lambda t: 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2,
    "bounce_out": lambda t: (7.5625 * t * t if t < 1 / 2.75 else
                             7.5625 * (t - 1.5 / 2.75) ** 2 + 0.75 if t < 2 / 2.75 else
                             7.5625 * (t - 2.25 / 2.75) ** 2 + 0.9375 if t < 2.5 / 2.75 else
                             7.5625 * (t - 2.625 / 2.75) ** 2 + 0.984375),
}


def _anchor(img: np.ndarray, anchor: str) -> tuple[float, float]:
    b = po.bbox(po.opaque(img))
    if not b:
        return img.shape[1] / 2, img.shape[0] / 2
    x0, y0, x1, y1 = b
    cx = (x0 + x1) / 2
    return {"bottom": (cx, y1), "top": (cx, y0), "center": (cx, (y0 + y1) / 2),
            "left": (x0, (y0 + y1) / 2), "right": (x1, (y0 + y1) / 2)}[anchor]


@mcp.tool()
@tool_errors
async def squash_stretch(filename: str, layer_name: str, frame_index: int, amounts: list[float],
                         anchor: str = "bottom", start_frame: int = 0, preserve_volume: bool = True,
                         frame_duration_ms: int = 0) -> str:
    """Generate squash & stretch frames of a layer from one pose.

    Each value in `amounts` makes one frame: 0.3 = stretched 30% taller
    (and narrower when preserve_volume), -0.3 = squashed 30% flatter and
    wider. A jump might be [-0.25, 0.3, 0.1, 0, -0.2, 0]: crouch, launch,
    air, apex, land, settle. Pixels are resampled nearest-neighbour about
    the anchor (bottom keeps the feet on the ground), with no blur and no
    new colours; clean the result with cleanup_lines.

    Args:
        filename: Aseprite file
        layer_name: Layer with the pose
        frame_index: Frame holding the source pose
        amounts: One deformation per output frame, -0.6 to 0.8
        anchor: bottom, top, center, left or right
        start_frame: First frame to write (0 = the frame after frame_index);
            missing frames are added
        preserve_volume: Widen when squashing, narrow when stretching
        frame_duration_ms: Duration for added frames (0 = copy the last one)
    """
    if anchor not in ("bottom", "top", "center", "left", "right"):
        return "ERROR: anchor must be bottom, top, center, left or right"
    if not amounts or len(amounts) > 64:
        return "ERROR: give 1-64 amounts"
    check_file(filename)
    info = pixio.sprite_info(filename)
    layer = pixio.resolve_layer(info, layer_name)
    src = pixio.read_layer(filename, layer, frame_index)
    if not po.opaque(src).any():
        return "ERROR: that layer is empty on that frame"
    ax, ay = _anchor(src, anchor)
    start = start_frame or frame_index + 1
    writes = []
    for i, a in enumerate(amounts):
        a = max(-0.6, min(0.8, float(a)))
        sy = 1 + a
        sx = 1 / math.sqrt(sy) if preserve_volume else 1.0
        if anchor in ("left", "right"):
            sx, sy = sy, sx
        writes.append(pixio.Write(layer, start + i, po.resample_nearest(src, sx, sy, (ax, ay)), create=False))
    pixio.write_images(filename, writes, frame_duration_ms or None)
    return as_json({"frames_written": [start, start + len(amounts) - 1], "anchor": anchor,
                    "next": "view_sprite the range, cleanup_lines, then set_frame_duration per frame"})


@mcp.tool()
@tool_errors
async def add_smear(filename: str, layer_name: str, from_frame: int, to_frame: int, target_frame: int = 0,
                    style: str = "streak", steps: int = 6, fade: bool = True, color: str = "") -> str:
    """Draw a smear frame: the shape stretched along its motion between two poses.

    Fast actions (a sword swing, a dash, a punch) read better with one smear
    frame than with in-betweens. This compares the layer at from_frame and
    to_frame, and paints the in-between positions of the moving pixels into
    target_frame.

    styles:
      streak - copies of the shape along the path, oldest at the back
               (motion trail; fade=True makes the tail lighter/cooler)
      solid  - one continuous filled shape spanning the path (classic
               cartoon smear; uses `color` or the shape's main colour)

    Args:
        filename: Aseprite file
        layer_name: Layer that moves (draw the weapon/limb on its own layer)
        from_frame, to_frame: The poses before and after the smear
        target_frame: Frame to draw into (0 = to_frame, i.e. the strike frame)
        style: streak or solid
        steps: In-between samples, 2-16
        fade: Fade the trail toward the background colour
        color: Fill colour for solid style
    """
    if style not in ("streak", "solid"):
        return "ERROR: style must be streak or solid"
    check_file(filename)
    info = pixio.sprite_info(filename)
    layer = pixio.resolve_layer(info, layer_name)
    a, b = pixio.read_images(filename, [("layer", layer, from_frame), ("layer", layer, to_frame)])
    ma, mb = po.opaque(a), po.opaque(b)
    if not ma.any() or not mb.any():
        return "ERROR: the layer must have pixels on both frames"
    ya, xa = np.nonzero(ma)
    yb, xb = np.nonzero(mb)
    dx, dy = xb.mean() - xa.mean(), yb.mean() - ya.mean()
    target = target_frame or to_frame
    base = pixio.read_layer(filename, layer, target) if target not in (from_frame,) else a
    steps = max(2, min(16, steps))
    out = np.zeros_like(a)
    if style == "solid":
        col = cs.hex_to_rgb(color) if color else po.colors_used(b)[0][0][:3]
        if col is None:
            return f"ERROR: Invalid color {color}"
        acc = np.zeros(ma.shape, bool)
        for i in range(steps + 1):
            t = i / steps
            acc |= po.shift(ma, -int(round(dx * t)), -int(round(dy * t)), False) | (mb if i == steps else False)
        # close small gaps between samples
        acc = po.dilate(acc, 4) & ~po.boundary(po.dilate(acc, 4), 4) | acc
        out[acc] = (*col, 255)
    else:
        bg_l = 0.95
        for i in range(steps):
            t = i / steps
            frame = po.translate(a, int(round(dx * t)), int(round(dy * t)))
            if fade:
                m = po.opaque(frame)
                lab = po.lab_image(frame)
                k = 0.55 * (1 - t)
                lab[..., 0] = lab[..., 0] * (1 - k) + bg_l * k
                lab[..., 1:] *= (1 - k)
                rgb = np.clip(np.round(cs.oklab_to_rgb(lab)), 0, 255).astype(np.uint8)
                frame = frame.copy()
                frame[m, :3] = rgb[m]
            m = po.opaque(frame)
            out[m] = frame[m]
    # the final pose stays on top
    final = base if target == to_frame else b
    fm = po.opaque(final)
    out[fm] = final[fm]
    pixio.write_images(filename, [pixio.Write(layer, target, out, create=False)])
    return as_json({"smear_frame": target, "motion": [round(float(dx), 1), round(float(dy), 1)], "style": style,
                    "tip": "Give the smear frame 40-70 ms with set_frame_duration."})


@mcp.tool()
@tool_errors
async def hit_flash(filename: str, layer_name: str, frames: str, color: str = "#FFFFFF", amount: float = 1.0,
                    keep_outline: bool = True) -> str:
    """Tint a layer toward a colour on some frames: the damage/hit flash.

    amount 1.0 = solid silhouette in `color` (the classic white flash),
    0.5 = half-way tint (a red pain tint). keep_outline leaves outline
    colours alone so the shape still reads.

    Args:
        filename: Aseprite file
        layer_name: Layer to flash ("*" for all image layers)
        frames: Frames to flash, e.g. "5" or "5,7"
        color: Flash colour
        amount: 0-1
        keep_outline: Keep the outline pixels unchanged
    """
    col = cs.hex_to_rgb(color)
    if col is None:
        return f"ERROR: Invalid color {color}"
    info, pairs = targets(filename, layer_name, frames, default_all_frames=False)
    imgs = pixio.read_images(filename, [("layer", l, f) for l, f in pairs])
    writes = []
    amount = max(0.0, min(1.0, amount))
    for (l, f), img in zip(pairs, imgs):
        m = po.opaque(img)
        if not m.any():
            continue
        if keep_outline:
            # dark pixels on the silhouette edge are the outline, whatever their colour
            L = po.lab_image(img)[..., 0]
            m &= ~(po.boundary(m, 8) & (L < 0.5))
        out = img.copy()
        if amount >= 0.999:
            out[m, :3] = col
        else:
            lab = po.lab_image(img)
            tl = cs.rgb_to_oklab(np.array(col, np.float64))
            mixed = lab * (1 - amount) + tl * amount
            out[m, :3] = np.clip(np.round(cs.oklab_to_rgb(mixed[m])), 0, 255).astype(np.uint8)
        writes.append(pixio.Write(l, f, out, create=False))
    pixio.write_images(filename, writes)
    return as_json({"flashed_cels": len(writes)})


@mcp.tool()
@tool_errors
async def generate_particles(filename: str, effect: str, x: int, y: int, start_frame: int = 1, frames: int = 6,
                             layer_name: str = "fx", colors: list[str] | None = None, count: int = 12,
                             spread: float = 1.0, seed: int = 1, frame_duration_ms: int = 0) -> str:
    """Hand-made-looking particle effects drawn frame by frame.

    effects:
      dust     - puffs kicked out sideways at ground level (landing, running)
      sparks   - fast streaks flying out and falling (hits, metal)
      burst    - a ring of pixels expanding and fading (impact, magic)
      sparkle  - twinkling 4-point stars around the point (pickups, shine)
      smoke    - rising, growing, dissolving puffs
      debris   - chunks thrown up under gravity (breaking, explosions)
    Particles use 2-4 colours (given, or a warm default per effect), shrink
    and darken as they age, and are deterministic for a given seed.

    Args:
        filename: Aseprite file
        effect: dust, sparks, burst, sparkle, smoke or debris
        x, y: Origin in sprite pixels
        start_frame: First frame (missing frames are added)
        frames: Length of the effect, 2-24
        layer_name: Layer to draw on (created, default "fx")
        colors: Hex colours, lightest first
        count: Particles, 1-64
        spread: Size multiplier, 0.3-3
        seed: Change for a different random variation
        frame_duration_ms: Duration for added frames
    """
    defaults = {"dust": ["#F4EAD5", "#C8B89A", "#8C7C68"], "sparks": ["#FFFBE0", "#FFD040", "#E86A20"],
                "burst": ["#FFFFFF", "#9CE8FF", "#4C8CE8"], "sparkle": ["#FFFFFF", "#FFF0A0", "#E8B030"],
                "smoke": ["#D8D8E0", "#A0A0B0", "#686878"], "debris": ["#C89060", "#8C5C38", "#5C3820"]}
    if effect not in defaults:
        return f"ERROR: effect must be one of {', '.join(defaults)}"
    pal = cs.parse_colors(colors or defaults[effect])
    if isinstance(pal, str):
        return f"ERROR: {pal}"
    check_file(filename)
    info = pixio.sprite_info(filename)
    frames = max(2, min(24, frames))
    count = max(1, min(64, count))
    spread = max(0.3, min(3.0, spread))
    rng = np.random.default_rng(seed)
    W, H = info.width, info.height
    existing = {}
    if info.has_layer(layer_name):
        fr = [f for f in range(start_frame, start_frame + frames) if f <= info.frames]
        for f, im in zip(fr, pixio.read_images(filename, [("layer", layer_name, f) for f in fr])):
            existing[f] = im
    # particle state
    if effect == "dust":
        ang = np.where(rng.random(count) < 0.5, math.pi, 0) + rng.normal(0, 0.35, count)
        spd = rng.uniform(0.6, 1.6, count) * spread
        vx, vy = np.cos(ang) * spd, -np.abs(np.sin(ang)) * spd * 0.5 - 0.15
        g, size0 = 0.0, rng.integers(1, 3, count) + (spread > 1.5)
    elif effect == "smoke":
        vx, vy = rng.normal(0, 0.25, count) * spread, -rng.uniform(0.4, 0.9, count) * spread
        g, size0 = 0.0, rng.integers(1, 3, count)
    elif effect in ("sparks", "debris"):
        ang = rng.uniform(math.pi * 0.1, math.pi * 0.9, count)
        spd = rng.uniform(1.2, 3.0 if effect == "sparks" else 2.2, count) * spread
        vx, vy = np.cos(ang) * spd * np.where(rng.random(count) < 0.5, -1, 1), -np.sin(ang) * spd
        g = 0.35 * spread
        size0 = np.ones(count, int) if effect == "sparks" else rng.integers(1, 3, count)
    elif effect == "burst":
        ang = np.linspace(0, 2 * math.pi, count, endpoint=False) + rng.uniform(0, 0.3)
        spd = np.full(count, 1.6 * spread)
        vx, vy = np.cos(ang) * spd, np.sin(ang) * spd
        g, size0 = 0.0, np.ones(count, int)
    else:  # sparkle
        g, vx, vy = 0.0, np.zeros(count), np.zeros(count)
        size0 = np.ones(count, int)
        offs = rng.normal(0, 4 * spread, (count, 2))
        births = rng.integers(0, max(1, frames - 2), count)
    px, py = np.full(count, float(x)), np.full(count, float(y))
    writes = []

    def put(img, xx, yy, c):
        xx, yy = int(round(xx)), int(round(yy))
        if 0 <= xx < W and 0 <= yy < H:
            img[yy, xx] = (*c, 255)

    for i in range(frames):
        f = start_frame + i
        img = existing.get(f, np.zeros((H, W, 4), np.uint8)).copy()
        age = i / (frames - 1)
        if effect == "sparkle":
            for j in range(count):
                life = i - births[j]
                if life < 0 or life > 3:
                    continue
                cx, cy = x + offs[j, 0], y + offs[j, 1]
                r = [0, 1, 2, 1][life] if spread >= 1 else [0, 1, 1, 0][life]
                c = pal[min(len(pal) - 1, abs(life - 1))]
                put(img, cx, cy, pal[0] if life == 1 else c)
                for k in range(1, r + 1):
                    for ddx, ddy in po.N4:
                        put(img, cx + ddx * k, cy + ddy * k, pal[min(len(pal) - 1, k)])
        else:
            ci = min(len(pal) - 1, int(age * len(pal)))
            for j in range(count):
                if effect == "burst" and age > 0.85:
                    continue
                if effect in ("dust", "smoke"):
                    s = size0[j] + (1 if age > 0.3 else 0) - (1 if age > 0.75 else 0)
                    if age > 0.9 or s <= 0:
                        continue
                    for ox in range(s):
                        for oy in range(s):
                            if s > 1 and (ox, oy) in ((0, 0), (s - 1, 0), (0, s - 1), (s - 1, s - 1)) and s > 2:
                                continue
                            put(img, px[j] + ox, py[j] + oy, pal[ci])
                elif effect == "sparks":
                    put(img, px[j], py[j], pal[ci])
                    put(img, px[j] - vx[j] * 0.6, py[j] - vy[j] * 0.6, pal[min(len(pal) - 1, ci + 1)])
                else:
                    for ox in range(size0[j]):
                        for oy in range(size0[j]):
                            put(img, px[j] + ox, py[j] + oy, pal[ci])
            px += vx
            py += vy
            vy += g
            if effect in ("dust", "smoke"):
                vx *= 0.78
                vy *= 0.85
        writes.append(pixio.Write(layer_name, f, img, create=True))
    pixio.write_images(filename, writes, frame_duration_ms or None)
    return as_json({"effect": effect, "frames": [start_frame, start_frame + frames - 1], "layer": layer_name})


@mcp.tool()
@tool_errors
async def secondary_motion(filename: str, layer_name: str, driver_layer: str, frames: str = "", lag: int = 1,
                           amount: float = 1.0, max_offset: int = 4) -> str:
    """Make hair, capes, tails, ears or antennae follow through.

    Reads how the driver layer (the body) moves from frame to frame and
    shifts the follower layer by the driver's movement from `lag` frames
    earlier, scaled by `amount`. The follower drags behind on the way and
    overshoots when the body stops - follow-through and overlapping action,
    the cheapest way to make an animation feel alive.

    Args:
        filename: Aseprite file
        layer_name: Follower layer (hair, cape...)
        driver_layer: Layer whose motion drives it (body)
        frames: Frames to process ("" = all)
        lag: Delay in frames, 1-3
        amount: Strength of the drag, 0.2-2
        max_offset: Limit in pixels
    """
    check_file(filename)
    info = pixio.sprite_info(filename)
    fl = pixio.parse_frames(frames, info.frames)
    if len(fl) < 2:
        return "ERROR: need at least 2 frames"
    reqs = [("layer", driver_layer, f) for f in fl] + [("layer", layer_name, f) for f in fl]
    imgs = pixio.read_images(filename, reqs)
    drv, fol = imgs[:len(fl)], imgs[len(fl):]
    cent = []
    for im in drv:
        ys, xs = np.nonzero(po.opaque(im))
        cent.append((xs.mean(), ys.mean()) if len(xs) else (0.0, 0.0))
    lag = max(1, min(3, lag))
    writes, offsets = [], []
    n = len(fl)
    for i in range(n):
        # follower should be where the driver was `lag` frames ago (relative to the driver now)
        j = (i - lag) % n
        ox = (cent[j][0] - cent[i][0]) * amount
        oy = (cent[j][1] - cent[i][1]) * amount
        ox = int(round(max(-max_offset, min(max_offset, ox))))
        oy = int(round(max(-max_offset, min(max_offset, oy))))
        offsets.append({"frame": fl[i], "dx": ox, "dy": oy})
        if ox or oy:
            writes.append(pixio.Write(layer_name, fl[i], po.translate(fol[i], ox, oy), create=False))
    pixio.write_images(filename, writes)
    return as_json({"offsets": offsets, "tip": "Check with render_onion_skin; redraw stretched frames by hand."})


def _motion_track(imgs):
    out = []
    for im in imgs:
        m = po.opaque(im)
        if not m.any():
            out.append(None)
            continue
        ys, xs = np.nonzero(m)
        b = po.bbox(m)
        used = po.colors_used(im)
        # a colour covering most of the shape is a deliberate flash, not drift
        flash = {c[:3] for c, n in used if n > 0.4 * m.sum()}
        out.append({"cx": float(xs.mean()), "cy": float(ys.mean()), "area": int(m.sum()),
                    "w": b[2] - b[0], "h": b[3] - b[1], "bottom": b[3],
                    "colors": {c[:3] for c, _ in used} - flash if len(used) > 1 else {c[:3] for c, _ in used},
                    "flash": flash})
    return out


@mcp.tool()
@tool_errors
async def critique_animation(filename: str, layer_name: str = "", frames: str = "", loop: bool = True,
                             ground_layer_bottom: bool = True, output_filename: str = ""):
    """Critique an animation's motion, not just its frames.

    Tracks the drawn shape over the frames and reports, with frame numbers:
      - spacing: an even, robotic speed vs. eased motion; sudden jumps
      - holds: identical consecutive frames (wasted frames, or intended holds)
      - volume: area/height changes that are not squash & stretch
        (the character swelling or shrinking between poses)
      - foot sliding: the lowest pixel row drifting while it should be planted
      - pixel boil: tiny scattered changes between near-identical frames
      - palette flicker: colours that come and go
      - loop closure: whether the last frame flows into the first
      - timing: frame durations that are all the same
    Also returns a motion-path image: the shape's centre per frame on the
    first frame, so arcs (good) and straight zig-zags (bad) are visible.

    Args:
        filename: Aseprite file
        layer_name: Layer or group ("" = everything visible)
        frames: Range ("" = all)
        loop: The animation loops (check last -> first)
        ground_layer_bottom: Check that feet stay planted when the lowest row barely moves
        output_filename: Optional PNG path for the motion-path image
    """
    check_file(filename)
    info = pixio.sprite_info(filename)
    fl = pixio.parse_frames(frames, info.frames)
    if len(fl) < 2:
        return "ERROR: need at least 2 frames"
    imgs = pixio.read_images(filename, [("composite", layer_name, f) for f in fl])
    tr = _motion_track(imgs)
    issues = []
    n = len(fl)
    pairs = [(i, i + 1) for i in range(n - 1)] + ([(n - 1, 0)] if loop else [])
    steps, holds, boil = [], [], []
    for i, j in pairs:
        a, b = imgs[i], imgs[j]
        diff = np.any(a != b, axis=-1)
        cnt = int(diff.sum())
        if cnt == 0:
            holds.append([fl[i], fl[j]])
        elif tr[i] and tr[j]:
            d = math.hypot(tr[j]["cx"] - tr[i]["cx"], tr[j]["cy"] - tr[i]["cy"])
            steps.append((fl[i], fl[j], d))
            labels, nc = po.components(diff, 8)
            if nc >= 6 and cnt <= 3 * nc and d < 0.6:
                boil.append({"frames": [fl[i], fl[j]], "scattered_changes": nc, "pixels": cnt})
    if holds:
        issues.append({"severity": "low", "kind": "identical_frames", "where": holds,
                       "message": "Consecutive identical frames. Use one frame with a longer duration instead, "
                                  "unless it is a deliberate hold.", "fix": "delete_frame + set_frame_duration"})
    if boil:
        issues.append({"severity": "medium", "kind": "pixel_boil", "where": boil,
                       "message": "Many tiny scattered changes between near-identical frames: the sprite will "
                                  "shimmer ('boil'). Keep still parts pixel-identical.",
                       "fix": "copy the unchanged region from the previous frame (copy_region), compare_frames"})
    ds = [s[2] for s in steps]
    if len(ds) >= 3:
        mean = float(np.mean(ds))
        if mean > 0.5:
            cv = float(np.std(ds) / mean)
            if cv < 0.12:
                issues.append({"severity": "medium", "kind": "even_spacing",
                               "message": f"The shape moves almost exactly the same distance every frame "
                                          f"(~{mean:.1f}px): mechanical. Ease in and out - small steps near the "
                                          "key poses, big ones in the middle.",
                               "fix": "redraw the in-betweens with eased spacing, or vary set_frame_duration"})
            jumps = [{"frames": [a, b], "distance": round(d, 1)} for a, b, d in steps if d > 3 * max(mean, 1) and d > 4]
            if jumps:
                issues.append({"severity": "low", "kind": "sudden_jump", "where": jumps,
                               "message": "A much bigger move than the rest. Fine for a strike (add a smear), "
                                          "otherwise add an in-between.", "fix": "add_smear or an in-between frame"})
    valid = [t for t in tr if t]
    if valid:
        areas = np.array([t["area"] for t in valid], float)
        hs = np.array([t["h"] for t in valid], float)
        ws = np.array([t["w"] for t in valid], float)
        vol_change = (areas.max() - areas.min()) / max(1.0, areas.mean())
        squash_like = np.corrcoef(hs, ws)[0, 1] < -0.3 if hs.std() > 0 and ws.std() > 0 else False
        if vol_change > 0.25 and not squash_like:
            big = [fl[i] for i, t in enumerate(tr) if t and abs(t["area"] - areas.mean()) > 0.15 * areas.mean()]
            issues.append({"severity": "medium", "kind": "volume_change", "where": big,
                           "message": f"The drawn area changes by {vol_change:.0%} without squash & stretch "
                                      "(height and width don't trade off): the character grows and shrinks.",
                           "fix": "compare head/torso sizes with view_sprite and get_bounds; keep part sizes fixed"})
        if ground_layer_bottom:
            bottoms = [t["bottom"] for t in valid]
            if max(bottoms) - min(bottoms) <= 1:
                # planted: check the horizontal position of the lowest row
                xs_low = []
                for im in imgs:
                    m = po.opaque(im)
                    if m.any():
                        yb = po.bbox(m)[3] - 1
                        row_x = np.nonzero(m[yb])[0]
                        xs_low.append((int(row_x.min()), int(row_x.max())))
                lefts = [a for a, _ in xs_low]
                rights = [b for _, b in xs_low]
                if max(lefts) - min(lefts) >= 3 and max(rights) - min(rights) >= 3 and \
                        abs((max(lefts) - min(lefts)) - (max(rights) - min(rights))) <= 1:
                    issues.append({"severity": "low", "kind": "foot_slide",
                                   "message": "The ground contact slides sideways while the feet stay on one row. "
                                              "A planted foot must not move.", "fix": "move_region per frame"})
        sets = [t["colors"] for t in valid]
        allc = set().union(*sets)
        flashes = set().union(*[t["flash"] for t in valid])
        flick = [cs.rgb_to_hex(c) for c in allc - flashes if 0 < sum(c in s for s in sets) <= max(1, len(sets) // 4)]
        if flick and len(sets) >= 3:
            issues.append({"severity": "medium", "kind": "palette_flicker", "where": flick[:20],
                           "message": "Colours that appear in only a few frames flicker during playback.",
                           "fix": "quantize_pro(use_sprite_palette=True) or merge_similar_colors"})
    if loop and tr[0] and tr[-1] and len(steps) >= 2:
        last = steps[-1][2]
        others = [s[2] for s in steps[:-1]]
        if last > 3 * max(np.mean(others), 1) and last > 3:
            issues.append({"severity": "medium", "kind": "loop_pop",
                           "message": f"The jump from the last frame back to the first ({last:.1f}px) is much "
                                      "bigger than the others: the loop will pop.",
                           "fix": "make the last frame lead into frame 1, or tag it pingpong"})
    durs = [info.durations[f - 1] for f in fl]
    if len(set(durs)) == 1 and n >= 4:
        issues.append({"severity": "low", "kind": "uniform_timing",
                       "message": f"Every frame lasts {durs[0]} ms. Hold key poses longer (150-250 ms) and fast "
                                  "frames shorter (40-70 ms) for snappier motion.",
                       "fix": "set_frame_duration per frame"})

    # motion path image
    base = imgs[0].copy()
    k = fit_scale(info.width, info.height, 520)
    im = zoom(on_bg(base), k).convert("RGB")
    from PIL import ImageDraw
    d = ImageDraw.Draw(im)
    pts = [((t["cx"] + 0.5) * k, (t["cy"] + 0.5) * k) if t else None for t in tr]
    ok_pts = [p for p in pts if p]
    if len(ok_pts) >= 2:
        d.line(ok_pts + ([ok_pts[0]] if loop else []), fill=(255, 60, 140), width=2)
    for idx, p in enumerate(pts):
        if p:
            d.ellipse([p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4], fill=(255, 60, 140))
            d.text((p[0] + 6, p[1] - 6), str(fl[idx]), fill=(40, 40, 40))
    sev = {"high": 0, "medium": 1, "low": 2}
    issues.sort(key=lambda e: sev[e["severity"]])
    score = max(0, 100 - sum({"high": 15, "medium": 8, "low": 3}[e["severity"]] for e in issues))
    report = {"score": score, "frames": fl, "durations_ms": durs, "issues": issues,
              "path": [{"frame": fl[i], "x": round(t["cx"], 1), "y": round(t["cy"], 1)} if t else None
                       for i, t in enumerate(tr)]}
    return image_reply(as_json(report), titled(im, "motion path of the shape's centre (pink), frame numbers"),
                       output_filename)
