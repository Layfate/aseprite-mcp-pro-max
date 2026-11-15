"""Automatic fixes for the problems critique_sprite reports.

Every fixer works on image layers (not on the flattened picture), on one
frame, a frame list or all frames, and reports exactly what it changed.
`dry_run=True` reports without writing.
"""
from __future__ import annotations

import numpy as np

from .. import mcp
from . import colorsci as cs
from . import pixops as po
from . import pixio
from .common import as_json, check_file, tool_errors

MAX_LISTED = 40


def targets(filename: str, layer_name: str, frames: str, default_all_frames: bool = True):
    """Resolve (info, [(layer, frame), ...]) for a fixer.

    layer_name "" = topmost image layer, "*" = every image layer.
    """
    check_file(filename)
    info = pixio.sprite_info(filename)
    if layer_name == "*":
        layers = info.image_layers
    else:
        layers = [pixio.resolve_layer(info, layer_name)]
        if any(l["path"] == layers[0] and (l["group"] or l["tilemap"]) for l in info.layers):
            kids = [p for p in info.image_layers if p.startswith(layers[0] + "/")]
            if not kids:
                raise pixio.PixError(f"'{layers[0]}' is a group or tilemap with no image layers")
            layers = kids
    fl = pixio.parse_frames(frames, info.frames, default_all=default_all_frames)
    return info, [(l, f) for l in layers for f in fl]


def _run(filename, pairs, fn, dry_run=False):
    """Read every (layer, frame), apply fn(img, layer, frame) -> (new_img, report), write changes."""
    imgs = pixio.read_images(filename, [("layer", l, f) for l, f in pairs])
    writes, reports = [], []
    for (l, f), img in zip(pairs, imgs):
        new, rep = fn(img, l, f)
        if rep:
            reports.append({"layer": l, "frame": f, **rep})
        if new is not None and not np.array_equal(new, img):
            writes.append(pixio.Write(l, f, new, create=False))
    if writes and not dry_run:
        pixio.write_images(filename, writes)
    return reports, len(writes)


def _j(result: str) -> dict:
    """Parse a fixer's JSON reply (dropping per-cel details), or wrap an error."""
    import json
    try:
        d = json.loads(result)
    except (TypeError, ValueError):
        return {"error": str(result)}
    d.pop("details", None)
    return d


def _parse_points(spec: str) -> set:
    pts = set()
    for part in (spec or "").replace(" ", "").split(";"):
        if not part:
            continue
        try:
            x, y = part.split(",")
            pts.add((int(x), int(y)))
        except ValueError:
            raise pixio.PixError(f"Invalid point '{part}': use \"x,y;x,y\"")
    return pts


@mcp.tool()
@tool_errors
async def cleanup_lines(filename: str, layer_name: str = "", frames: str = "", colors: list[str] | None = None,
                        dry_run: bool = False) -> str:
    """Make 1 px lines pixel-perfect: remove L-shaped 'doubles'.

    A line drawn with a mouse or from shapes often has a pixel at each step
    where two would touch only at a corner; that makes the line look thick
    and jagged. This finds those pixels (keeping real square corners of
    boxes and frames) and removes the one that evens out the step lengths.
    A removed outline pixel takes the colour beside it (fill inside, empty
    outside), so the shape is not dented.

    Args:
        filename: Aseprite file
        layer_name: Image layer ("" = topmost, "*" = all image layers; a group = its layers)
        frames: "" or "all" = every frame, or "3", "1-4", "1,3,6-8"
        colors: Only clean lines of these hex colours (default: the colours used
            as 1 px lines - outlines and detail lines; fills are never touched)
        dry_run: Report what would change without writing
    """
    info, pairs = targets(filename, layer_name, frames)
    keys = None
    if colors:
        parsed = cs.parse_colors(colors)
        if isinstance(parsed, str):
            return f"ERROR: {parsed}"
        keys = {int(po.pack(np.array([[[*c, 255]]], np.uint8))[0, 0]) for c in parsed}

    def fix(img, l, f):
        ck = keys if keys is not None else po.line_colors(img)
        if not ck:
            return img, None
        new, removed = po.clean_doubles(img, ck)
        return new, ({"removed": len(removed), "pixels": removed[:MAX_LISTED]} if removed else None)

    reports, n = _run(filename, pairs, fix, dry_run)
    total = sum(r["removed"] for r in reports)
    return as_json({"removed_pixels": total, "cels_changed": n, "dry_run": dry_run, "details": reports})


@mcp.tool()
@tool_errors
async def remove_stray_pixels(filename: str, layer_name: str = "", frames: str = "", protect: str = "",
                              remove_lone: bool = True, dry_run: bool = False) -> str:
    """Clean noise: pixels whose colour none of their 8 neighbours share.

    Each stray pixel takes the most common colour around it; a lone pixel
    floating in empty space is erased (remove_lone=False keeps those, e.g.
    stars or sparkles). List deliberate single pixels - eye glints, a
    sword's shine - in `protect`.

    Args:
        filename: Aseprite file
        layer_name: Image layer ("" = topmost, "*" = all image layers)
        frames: "" or "all" = every frame, or "3", "1-4", "1,3,6-8"
        protect: Pixels to keep, "x,y;x,y"
        remove_lone: Also erase single pixels with nothing around them
        dry_run: Report only
    """
    info, pairs = targets(filename, layer_name, frames)
    keep = _parse_points(protect)

    def fix(img, l, f):
        new, changes = po.remove_orphans(img, keep, remove_lone=remove_lone)
        return new, ({"fixed": len(changes), "pixels": changes[:MAX_LISTED]} if changes else None)

    reports, n = _run(filename, pairs, fix, dry_run)
    return as_json({"fixed_pixels": sum(r["fixed"] for r in reports), "cels_changed": n, "dry_run": dry_run,
                    "details": reports})


@mcp.tool()
@tool_errors
async def merge_similar_colors(filename: str, threshold: float = 0.04, layer_name: str = "*", frames: str = "",
                               max_colors: int = 0, snap_alpha: bool = True, dry_run: bool = False) -> str:
    """Merge colours that are too close to tell apart, across layers and frames.

    Colours closer than `threshold` (OKLab distance: 0.02 is barely visible,
    0.04 is a subtle step, 0.08 a clear one) are merged into the most used of
    them, so the palette is tight and every frame uses the same colours.
    With max_colors > 0 it keeps merging the closest pair until at most that
    many colours remain. Semi-transparent pixels are snapped to fully
    opaque or empty when snap_alpha.

    Args:
        filename: Aseprite file
        threshold: Merge colours closer than this (default 0.04)
        layer_name: "*" = all image layers (default), or one layer
        frames: "" = every frame
        max_colors: Optional upper limit on the number of colours
        snap_alpha: Make alpha 0 or 255 (threshold 128)
        dry_run: Report the merges without writing
    """
    info, pairs = targets(filename, layer_name, frames)
    imgs = pixio.read_images(filename, [("layer", l, f) for l, f in pairs])
    counts = {}
    for img in imgs:
        m = img[..., 3] >= (128 if snap_alpha else 1)
        keys, c = np.unique(po.pack(np.concatenate([img[..., :3], np.full(img.shape[:2] + (1,), 255, np.uint8)], -1))[m],
                            return_counts=True)
        for k, n in zip(keys.tolist(), c.tolist()):
            counts[k] = counts.get(k, 0) + n
    if not counts:
        return as_json({"merged": 0, "message": "Nothing drawn"})
    keys = sorted(counts, key=lambda k: -counts[k])
    rgb = np.array([po.unpack(k)[:3] for k in keys], np.float64)
    lab = cs.rgb_to_oklab(rgb)
    target = list(range(len(keys)))   # union-find style: index -> representative

    def find(i):
        while target[i] != i:
            target[i] = target[target[i]]
            i = target[i]
        return i
    # merge pairs under threshold, most-used colour wins
    d = np.sqrt(((lab[:, None] - lab[None]) ** 2).sum(-1))
    pairs_close = np.argwhere(np.triu(d < threshold, 1))
    for i, j in sorted(pairs_close.tolist(), key=lambda p: d[p[0], p[1]]):
        a, b = find(i), find(j)
        if a != b:
            hi, lo = (a, b) if counts[keys[a]] >= counts[keys[b]] else (b, a)
            target[lo] = hi
    if max_colors > 0:
        while True:
            reps = sorted({find(i) for i in range(len(keys))})
            if len(reps) <= max_colors:
                break
            sub = lab[reps]
            dd = np.sqrt(((sub[:, None] - sub[None]) ** 2).sum(-1)) + np.eye(len(reps)) * 9
            # weight by usage so rare colours are merged first
            w = np.array([counts[keys[r]] for r in reps], np.float64)
            score = dd * np.sqrt(np.minimum(w[:, None], w[None]))
            i, j = np.unravel_index(np.argmin(score), score.shape)
            a, b = reps[i], reps[j]
            hi, lo = (a, b) if counts[keys[a]] >= counts[keys[b]] else (b, a)
            target[lo] = hi
    mapping = {keys[i]: keys[find(i)] for i in range(len(keys)) if find(i) != i}
    merges = {}
    for src, dst in mapping.items():
        merges.setdefault(cs.rgb_to_hex(po.unpack(dst)[:3]), []).append(cs.rgb_to_hex(po.unpack(src)[:3]))
    writes = []
    for (l, f), img in zip(pairs, imgs):
        new = img.copy()
        if snap_alpha:
            new[..., 3] = np.where(img[..., 3] >= 128, 255, 0).astype(np.uint8)
        k = po.pack(np.concatenate([new[..., :3], np.full(img.shape[:2] + (1,), 255, np.uint8)], -1))
        m = new[..., 3] > 0
        for src, dst in mapping.items():
            sel = m & (k == src)
            if sel.any():
                new[sel, :3] = po.unpack(dst)[:3]
        if not np.array_equal(new, img):
            writes.append(pixio.Write(l, f, new, create=False))
    if writes and not dry_run:
        pixio.write_images(filename, writes)
    final = len({find(i) for i in range(len(keys))})
    return as_json({"colors_before": len(keys), "colors_after": final, "merged_into": merges,
                    "cels_changed": len(writes), "dry_run": dry_run})


@mcp.tool()
@tool_errors
async def outline_pro(filename: str, layer_name: str = "", frames: str = "", style: str = "selective",
                      color: str = "#1A1C2C", placement: str = "outside", corners: bool = False,
                      light_angle: float = 135.0, darkness: float = 0.3, output_layer: str = "",
                      region: str = "") -> str:
    """Pro outlines: fixed, coloured or selective ('sel-out'), inside or outside.

    styles:
      fixed     - every outline pixel is `color` (classic black/dark outline)
      colored   - each outline pixel is a darker, cooler shade of the fill it
                  touches, so skin gets a brown line and leaves a deep green
                  one: softer and more polished than black
      selective - colored, but lighter where the edge faces the light and
                  darkest on the shadow side; the look of polished
                  commercial sprites
    placement "outside" grows the shape by 1 px; "inside" recolours its own
    edge pixels (keeps the size, good when there is no room).
    corners=False (default) gives rounder outlines; True also fills
    diagonal corners.

    Args:
        filename: Aseprite file
        layer_name: Image layer to outline ("" = topmost)
        frames: "" = every frame
        style: fixed, colored or selective
        color: Outline colour for style "fixed"
        placement: outside or inside
        corners: Include diagonal neighbours
        light_angle: Light direction for "selective": 90 = top, 135 = top-left, 45 = top-right
        darkness: How much darker than the fill (OKLab lightness, 0.15-0.5)
        output_layer: Draw the outline on this layer instead (created above the source
            layer), so it stays editable on its own
        region: Only outline shapes inside "x,y,w,h"
    """
    from ..core.region import parse_region
    if style not in ("fixed", "colored", "selective"):
        return "ERROR: style must be fixed, colored or selective"
    if placement not in ("outside", "inside"):
        return "ERROR: placement must be outside or inside"
    col = cs.hex_to_rgb(color)
    if col is None:
        return f"ERROR: Invalid color {color}"
    rect = parse_region(region)
    if isinstance(rect, str):
        return f"ERROR: {rect}"
    info, pairs = targets(filename, layer_name, frames)
    lv = po.light_vector(light_angle)
    imgs = pixio.read_images(filename, [("layer", l, f) for l, f in pairs])
    writes = []
    added = 0
    for (l, f), img in zip(pairs, imgs):
        rm = None
        if rect:
            rm = np.zeros(img.shape[:2], bool)
            x, y, w, h = rect
            rm[max(0, y):y + h, max(0, x):x + w] = True
        out = po.outline(img, col, style, placement, corners, (lv[0], lv[1]), darkness, rm)
        diff = np.any(out != img, axis=-1)
        added += int(diff.sum())
        if output_layer:
            only = np.zeros_like(img)
            only[diff] = out[diff]
            writes.append(pixio.Write(output_layer, f, only, create=True, above=l))
        elif diff.any():
            writes.append(pixio.Write(l, f, out, create=False))
    pixio.write_images(filename, writes)
    return as_json({"outline_pixels": added, "cels": len(writes), "style": style, "placement": placement,
                    "layer": output_layer or None})


@mcp.tool()
@tool_errors
async def anti_alias_edges(filename: str, layer_name: str = "", frames: str = "", background: str = "",
                           min_run: int = 2, strength: float = 0.5, interior: bool = True,
                           dry_run: bool = False) -> str:
    """Hand-style anti-aliasing: soften stair-steps with in-between colours.

    Pixel artists don't blur; they place single intermediate pixels at the
    corners of long steps so a curve or diagonal looks smooth without
    getting fuzzy. This does that: where two colour areas meet in a step
    whose runs are at least `min_run` long, the corner pixel gets a colour
    between the two (OKLab mix, `strength` 0.5 = halfway).

    interior=True softens edges between colour areas inside the sprite. The
    outside edge is only softened when `background` is given (the colour the
    sprite will be shown on); anti-aliasing against transparency looks dirty
    on any other background, so it is skipped by default.

    Use on sprites of 32 px and up; small sprites look cleaner without AA.

    Args:
        filename: Aseprite file
        layer_name: Image layer ("" = topmost)
        frames: "" = every frame
        background: Hex colour of the final background, to also smooth the silhouette
        min_run: Minimum step length to smooth (2 = moderate, 3 = only long steps)
        strength: Mix toward the other colour, 0.25-0.75
        interior: Smooth edges between colours inside the sprite
        dry_run: Report only
    """
    bg = cs.hex_to_rgb(background) if background else None
    if background and bg is None:
        return f"ERROR: Invalid background {background}"
    strength = min(0.75, max(0.15, strength))
    info, pairs = targets(filename, layer_name, frames)

    def fix(img, l, f):
        keys = po.pack(img)
        h, w = keys.shape
        out = img.copy()
        placed = []
        cache = {}
        for y in range(h):
            for x in range(w):
                k = keys[y, x]
                if not k:
                    continue
                # Pixel p protrudes into colour Q when Q is on two perpendicular sides of p.
                for (ax, ay), (bx, by) in (((0, -1), (1, 0)), ((1, 0), (0, 1)), ((0, 1), (-1, 0)), ((-1, 0), (0, -1))):
                    xa, ya, xb, yb = x + ax, y + ay, x + bx, y + by
                    if not (0 <= xa < w and 0 <= ya < h and 0 <= xb < w and 0 <= yb < h):
                        continue
                    qa, qb = keys[ya, xa], keys[yb, xb]
                    if qa != qb or qa == k:
                        continue
                    if qa == 0 and bg is None:
                        continue
                    if qa != 0 and not interior:
                        continue
                    # the step's runs: p continues along -a and -b directions
                    run1 = po._arm_len(keys, x, y, -bx, -by, k, 8)   # along the edge, away from b
                    run2 = po._arm_len(keys, x, y, -ax, -ay, k, 8)
                    if max(run1, run2) + 1 < min_run:
                        continue
                    # the opposite corner must be p's colour: a true step, not a 1 px spike
                    if not (0 <= x - ax - bx < w and 0 <= y - ay - by < h) or keys[y - ay - by, x - ax - bx] != k:
                        continue
                    other = po.unpack(int(qa))[:3] if qa else bg
                    key = (int(k), int(qa))
                    if key not in cache:
                        cache[key] = cs.mix(po.unpack(int(k))[:3], other, strength)
                    out[y, x] = (*cache[key], 255)
                    placed.append({"x": x, "y": y})
                    break
        return out, ({"aa_pixels": len(placed), "pixels": placed[:MAX_LISTED]} if placed else None)

    reports, n = _run(filename, pairs, fix, dry_run)
    return as_json({"aa_pixels": sum(r["aa_pixels"] for r in reports), "cels_changed": n, "dry_run": dry_run,
                    "details": reports})


@mcp.tool()
@tool_errors
async def polish_sprite(filename: str, layer_name: str = "*", frames: str = "", protect: str = "",
                        merge_threshold: float = 0.035, clean_lines: bool = True, clean_strays: bool = True,
                        merge_colors: bool = True, checkpoint: bool = True) -> str:
    """One-shot cleanup pass: checkpoint, merge near-duplicate colours, remove
    doubles from lines, remove stray pixels, then re-score.

    Safe to run often; restore_checkpoint undoes it. Returns the critique
    score before and after and what each step changed.

    Args:
        filename: Aseprite file
        layer_name: "*" = all image layers (default), or one layer
        frames: "" = every frame
        protect: Deliberate single pixels to keep, "x,y;x,y"
        merge_threshold: OKLab distance for merging colours (0.035 = the critique's near-duplicate limit)
        clean_lines, clean_strays, merge_colors: Steps to run
        checkpoint: Save a checkpoint first
    """
    from . import checkpoints
    from .critique import analyze
    check_file(filename)
    info = pixio.sprite_info(filename)
    before = analyze(pixio.read_composite(filename, 1))["score"]
    steps = {}
    if checkpoint:
        steps["checkpoint"] = checkpoints.save(filename, "before polish")
    if merge_colors:
        steps["merge_similar_colors"] = _j(await merge_similar_colors(filename, merge_threshold, layer_name, frames))
    if clean_lines:
        steps["cleanup_lines"] = _j(await cleanup_lines(filename, layer_name, frames))
    if clean_strays:
        steps["remove_stray_pixels"] = _j(await remove_stray_pixels(filename, layer_name, frames, protect,
                                                                    remove_lone=False))
    after = analyze(pixio.read_composite(filename, 1))["score"]
    return as_json({"score_before": before, "score_after": after, "steps": steps,
                    "next": "view_quality to check, critique_sprite for what is left"})
