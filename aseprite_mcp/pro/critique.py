"""Art-quality critique: the feedback a pixel-art lead would give, as data.

`critique_sprite` scores a frame and lists concrete problems with
coordinates and the tool that fixes each one. `view_quality` shows the same
sprite the way artists check readability: actual size, silhouette, values,
palette, with the problems marked on a zoomed copy.
"""
from __future__ import annotations

import math
from collections import Counter

import numpy as np
from PIL import Image as PILImage
from PIL import ImageDraw

from .. import mcp
from . import colorsci as cs
from . import pixops as po
from . import pixio
from .common import (as_json, check_file, column, fit_scale, image_reply, on_bg, row, swatches,
                     titled, tool_errors, zoom)

MAX_LISTED = 25


def recommended_colors(w: int, h: int, scene: bool) -> int:
    s = max(w, h)
    if scene:
        return 32 if s <= 128 else 48
    if s <= 16:
        return 8
    if s <= 32:
        return 16
    if s <= 64:
        return 24
    return 32


def _near_duplicates(colors, threshold=0.035):
    labs = [cs.rgb_to_oklab(np.array(c[:3], dtype=np.float64)) for c, _ in colors]
    pairs = []
    for i in range(len(colors)):
        for j in range(i + 1, len(colors)):
            d = float(np.linalg.norm(labs[i] - labs[j]))
            if d < threshold:
                pairs.append({"a": cs.rgb_to_hex(colors[i][0]), "b": cs.rgb_to_hex(colors[j][0]),
                              "distance": round(d, 4), "counts": [colors[i][1], colors[j][1]]})
    pairs.sort(key=lambda p: p["distance"])
    return pairs


def _light_estimate(mask: np.ndarray, L: np.ndarray, dist: np.ndarray):
    """Where the light comes from, how directional it is, and how 'pillowed'."""
    ys, xs = np.nonzero(mask)
    if len(xs) < 12:
        return None
    lv = L[mask]
    if lv.std() < 0.02:
        return {"flat": True}
    cx, cy = xs.mean(), ys.mean()
    radius = max(1.0, math.sqrt(len(xs) / math.pi))
    wts = lv - lv.mean()
    vx = float((wts * (xs - cx)).sum() / (np.abs(wts).sum() * radius))
    vy = float((wts * (ys - cy)).sum() / (np.abs(wts).sum() * radius))
    strength = math.hypot(vx, vy)
    angle = (math.degrees(math.atan2(-vy, vx)) + 360) % 360  # 90 = light from the top
    dv = dist[mask]
    corr = float(np.corrcoef(dv, lv)[0, 1]) if dv.std() > 0 else 0.0
    return {"flat": False, "direction_strength": round(strength, 3), "angle": round(angle),
            "edge_brightness_correlation": round(corr if math.isfinite(corr) else 0.0, 3)}


def _angle_name(a: float) -> str:
    names = ["right", "top-right", "top", "top-left", "left", "bottom-left", "bottom", "bottom-right"]
    return names[int(((a + 22.5) % 360) // 45)]


def analyze(img: np.ndarray) -> dict:
    """Full quality analysis of one RGBA frame (composite or layer)."""
    h, w = img.shape[:2]
    mask = po.opaque(img)
    total = int(mask.sum())
    issues = []
    marks = []   # (x, y, w, h, kind) for the overlay
    if total == 0:
        return {"score": 0, "issues": [{"severity": "high", "kind": "empty", "message": "Nothing is drawn."}],
                "marks": [], "stats": {"opaque_pixels": 0}}
    scene = total > 0.97 * w * h
    colors = po.colors_used(img)
    rgb_colors = [((c[0], c[1], c[2]), n) for c, n in colors]
    lab = po.lab_image(img)
    L = lab[..., 0]
    stats = {"size": [w, h], "opaque_pixels": total, "unique_colors": len(colors),
             "mode": "scene (fills the canvas)" if scene else "sprite (transparent background)"}

    def add(sev, kind, message, fix, items=None, penalty=0):
        e = {"severity": sev, "kind": kind, "message": message, "fix": fix}
        if items:
            e["where"] = items[:MAX_LISTED]
            if len(items) > MAX_LISTED:
                e["more"] = len(items) - MAX_LISTED
        e["_penalty"] = penalty
        issues.append(e)

    # --- palette discipline
    rec = recommended_colors(w, h, scene)
    stats["recommended_max_colors"] = rec
    semi = int(((img[..., 3] > 0) & (img[..., 3] < 255)).sum())
    if semi:
        add("medium", "semi_transparent", f"{semi} pixels are semi-transparent; pixel art reads crisper with "
            "fully opaque pixels.", "quantize_pro or merge_similar_colors (alpha is snapped to 0/255)", penalty=4)
    if len(colors) > rec * 2:
        add("high", "too_many_colors", f"{len(colors)} colours (aim for <= {rec} at this size). Extra shades "
            "blur the forms and break palette consistency.", "merge_similar_colors, then quantize_pro",
            penalty=min(18, 6 + (len(colors) - rec) // 4))
    elif len(colors) > rec:
        add("medium", "many_colors", f"{len(colors)} colours; {rec} or fewer usually reads cleaner at this size.",
            "merge_similar_colors", penalty=5)
    dups = _near_duplicates(rgb_colors[:96])
    if dups:
        add("medium", "near_duplicate_colors", f"{len(dups)} pair(s) of colours are almost identical "
            "(OKLab distance < 0.035): they read as noise, not as shading.", "merge_similar_colors",
            items=dups, penalty=min(12, 3 + 2 * len(dups)))

    # --- value structure
    lv = L[mask]
    p5, p95 = float(np.percentile(lv, 5)), float(np.percentile(lv, 95))
    stats["value_range"] = round(p95 - p5, 3)
    stats["mean_lightness"] = round(float(lv.mean()), 3)
    if p95 - p5 < 0.28:
        add("high", "low_value_contrast", f"Values only span {p95 - p5:.2f} of the 0-1 lightness range: the "
            "sprite will read as a blob. Push darks darker and lights lighter.",
            "auto_shade (stronger), adjust_hsl on the shadow colours, or a wider generate_palette_pro ramp",
            penalty=12)
    chroma = np.hypot(lab[..., 1], lab[..., 2])[mask]
    loud = float((chroma > 0.2).mean())
    stats["high_saturation_share"] = round(loud, 3)
    if loud > 0.45 and len(colors) > 3:
        add("low", "oversaturated", f"{loud:.0%} of pixels are very saturated. Keep full saturation for "
            "accents; desaturate large areas so the focal colours pop.", "adjust_hsl (saturation -0.2)", penalty=4)

    # --- stray pixels
    orphans = po.find_orphans(img, include_lone=True)
    if scene:
        # In a scene, single highlights on a busy texture are normal: only count
        # orphans that differ strongly from every neighbour.
        strong = []
        for x, y in orphans:
            here = lab[y, x]
            nb = [lab[y + dy, x + dx] for dx, dy in po.N8 if 0 <= x + dx < w and 0 <= y + dy < h]
            if nb and min(float(np.linalg.norm(here - n)) for n in nb) > 0.12:
                strong.append((x, y))
        orphans = strong
    if orphans:
        sev = "medium" if len(orphans) > max(4, total // 150) else "low"
        add(sev, "stray_pixels", f"{len(orphans)} pixel(s) match none of their neighbours (noise, stray "
            "shading). Keep deliberate ones (eye glints, sparkles); clean the rest.",
            "remove_stray_pixels (protect=\"x,y;...\" for glints)",
            items=[{"x": x, "y": y} for x, y in orphans], penalty=min(14, 2 + len(orphans) // 2))
        marks += [(x, y, 1, 1, "stray") for x, y in orphans[:400]]

    if not scene:
        labels, n = po.components(mask, 8)
        if n > 1:
            sizes = np.bincount(labels.ravel())[1:]
            main = int(np.argmax(sizes)) + 1
            pieces = []
            for i in range(1, n + 1):
                if i == main:
                    continue
                b = po.bbox(labels == i)
                pieces.append({"x": b[0], "y": b[1], "w": b[2] - b[0], "h": b[3] - b[1], "pixels": int(sizes[i - 1])})
                marks.append((b[0], b[1], b[2] - b[0], b[3] - b[1], "detached"))
            pieces.sort(key=lambda p: p["pixels"])
            small = [p for p in pieces if p["pixels"] <= 3]
            if small:
                add("medium", "floating_specks", f"{len(small)} tiny piece(s) float off the main shape.",
                    "remove_stray_pixels or erase_region", items=small, penalty=min(8, 2 * len(small)))
            big = [p for p in pieces if p["pixels"] > 3]
            if big:
                add("info", "detached_parts", f"{len(big)} part(s) are not connected to the main shape. Fine for "
                    "effects and separate props; a held item or a limb should touch the body.", "move_region",
                    items=big, penalty=0)

        # --- silhouette edges
        jag = po.find_jaggies(mask)
        if jag:
            add("medium", "jaggies", f"{len(jag)} uneven step(s) on the silhouette edge (a run that is much "
                "longer or shorter than both its neighbours, like 1-3-1). Curves should step gradually "
                "(1-2-3) and straight diagonals evenly (2-2-2).", "draw_rows on the region, or anti_alias_edges",
                items=jag, penalty=min(14, 2 + len(jag)))
            for j in jag[:200]:
                marks.append((j["x"], j["y"], 1 if j["edge"] in ("left", "right") else j["run"],
                              j["run"] if j["edge"] in ("left", "right") else 1, "jaggy"))

        edge = po.boundary(mask, 4)
        # outline: an edge pixel is "outlined" when it is darker than the pixel inside it
        dist = po.distance_inside(mask)
        inner = mask & ~edge
        dark_edge = 0
        light_outline = []
        edge_ys, edge_xs = np.nonzero(edge)
        for y, x in zip(edge_ys.tolist(), edge_xs.tolist()):
            ins = [L[y + dy, x + dx] for dx, dy in po.N4 if 0 <= x + dx < w and 0 <= y + dy < h and inner[y + dy, x + dx]]
            if not ins:
                continue
            if L[y, x] < min(ins) - 0.06:
                dark_edge += 1
        coverage = dark_edge / max(1, len(edge_xs))
        stats["outline_coverage"] = round(coverage, 3)
        keys = po.pack(img)
        line_keys = po.line_colors(img)
        if max(w, h) <= 96 and coverage < 0.35 and total > 30:
            add("medium", "weak_outline", f"Only {coverage:.0%} of the silhouette edge is darker than the inside. "
                "Small sprites read much better with a clean 1 px dark (or selective) outline.",
                "outline_pro (style=\"selective\")", penalty=9)
        doubles = po.find_doubles(img, line_keys) if line_keys else []
        if doubles:
            add("medium", "doubles", f"{len(doubles)} L-shaped double pixel(s) on 1 px lines make them look "
                "thick and jagged.", "cleanup_lines", items=[{"x": x, "y": y} for x, y in doubles],
                penalty=min(12, 2 + len(doubles)))
            marks += [(x, y, 1, 1, "double") for x, y in doubles[:300]]

        # --- lighting
        le = _light_estimate(mask & ~edge, L, dist)
        # Flat fill: almost every interior pixel belongs to a material that
        # has only one colour (no darker or lighter shade of the same hue).
        interior_keys = keys[mask & ~edge]
        fam = {}
        for c, n in rgb_colors:
            lch = cs.oklab_to_oklch(cs.rgb_to_oklab(np.array(c, dtype=np.float64)))
            fid = "neutral" if lch[1] < 0.035 else int(((lch[2] + 15) % 360) // 30)
            fam.setdefault(fid, []).append(c)
        single = set()
        for fid, cl in fam.items():
            if len(cl) == 1 and fid != "neutral":
                single.add(cl[0])
        flat_share = 0.0
        if interior_keys.size:
            flat_px = sum(int((np.all(img[..., :3] == np.array(c), axis=-1) & mask & ~edge).sum()) for c in single)
            flat_share = flat_px / interior_keys.size
        stats["flat_fill_share"] = round(flat_share, 3)
        if le:
            stats["light"] = le
            if le.get("flat") or flat_share > 0.7:
                if total > 40:
                    add("medium", "no_shading", f"{flat_share:.0%} of the fill is flat colour with no shade of "
                        "its own: no light and shadow to show form.",
                        "auto_shade (light_angle=135 for top-left)", penalty=14)
            if not le.get("flat"):
                stats["light"]["from"] = _angle_name(le["angle"])
                if le["edge_brightness_correlation"] > 0.45 and le["direction_strength"] < 0.18:
                    add("high", "pillow_shading", "Pillow shading: it gets lighter toward the centre on every "
                        "side instead of being lit from one direction. That flattens the form.",
                        "auto_shade (repaints shading from one light), then check view_quality",
                        penalty=12)
                elif le["direction_strength"] < 0.08 and total > 80:
                    add("low", "unclear_light", "No clear light direction: shading does not lean to any side.",
                        "auto_shade", penalty=4)

        # --- banding: shade colours forming even rings that follow the outline
        rings = []
        for (c, n) in rgb_colors:
            if n < 8:
                continue
            sel = np.all(img[..., :3] == np.array(c), axis=-1) & mask & ~edge
            if sel.sum() < 8:
                continue
            dv = dist[sel]
            if dv.std() < 0.55 and 1.2 <= dv.mean() <= 6:
                rings.append((round(float(dv.mean()), 1), cs.rgb_to_hex(c)))
        if len(rings) >= 3:
            add("medium", "banding", f"{len(rings)} shade colours run in even bands parallel to the outline "
                "(each sits at one fixed distance from the edge). Vary the band widths and let them follow the "
                "light, not the contour.", "auto_shade", items=[{"color": c, "distance": d} for d, c in sorted(rings)],
                penalty=8)

        # --- canvas edge
        touching = int(mask[0].sum() + mask[-1].sum() + mask[:, 0].sum() + mask[:, -1].sum())
        if touching:
            add("low", "touches_canvas_edge", f"{touching} pixel(s) touch the canvas border; leave 1-2 px of "
                "margin so outlines and motion are not clipped.", "resize_canvas / move_region", penalty=3)

    # --- ramps: hue shifting
    groups = []
    labs = [(c, cs.oklab_to_oklch(cs.rgb_to_oklab(np.array(c, dtype=np.float64)))) for c, n in rgb_colors if n >= 2]
    used = set()
    for i, (c, lch) in enumerate(labs):
        if i in used or lch[1] < 0.05:
            continue
        g = [(c, lch)]
        used.add(i)
        for j in range(i + 1, len(labs)):
            if j not in used and labs[j][1][1] >= 0.05 and cs.angle_diff(lch[2], labs[j][1][2]) < 20:
                g.append(labs[j])
                used.add(j)
        if len(g) >= 3:
            groups.append(g)
    straight = []
    for g in groups:
        g.sort(key=lambda t: t[1][0])
        hues = [t[1][2] for t in g]
        span = max(cs.angle_diff(hues[0], hh) for hh in hues)
        if span < 4:
            straight.append([cs.rgb_to_hex(t[0]) for t in g])
    if straight:
        add("low", "flat_ramps", f"{len(straight)} colour ramp(s) only change lightness. Shifting the hue "
            "(shadows cooler, lights warmer) makes the colours richer.", "generate_palette_pro / color_ramp_pro",
            items=[{"ramp": r} for r in straight], penalty=3)

    score = max(0, 100 - sum(e["_penalty"] for e in issues))
    for e in issues:
        e.pop("_penalty")
    order = {"high": 0, "medium": 1, "low": 2, "info": 3}
    issues.sort(key=lambda e: order[e["severity"]])
    grade = "A" if score >= 90 else "B" if score >= 78 else "C" if score >= 62 else "D" if score >= 45 else "E"
    return {"score": score, "grade": grade, "stats": stats, "issues": issues, "marks": marks}


@mcp.tool()
@tool_errors
async def critique_sprite(filename: str, frame_index: int = 1, layer_name: str = "",
                          check_animation: bool = True) -> str:
    """Score a frame like a pixel-art lead would, with exact problems and fixes.

    Checks palette discipline (colour count for the size, near-duplicate
    colours, semi-transparent pixels), value contrast, saturation, stray
    pixels, floating specks, jaggies on the silhouette, L-shaped doubles on
    1 px lines, outline coverage, lighting (flat fill, pillow shading,
    unclear light direction), banding, flat (non hue-shifted) ramps and
    pixels touching the canvas edge. With several frames, also flags colours
    that appear in only some frames (palette drift) and size jumps.

    Every issue says how bad it is, where it is (coordinates) and which tool
    fixes it. Use it after each pass; view_quality(show_issues=True) shows
    the same problems marked on the sprite.

    Args:
        filename: Aseprite file
        frame_index: Frame to critique (1-based)
        layer_name: Critique one layer or group alone ("" = everything visible).
            Critique a character on its own layer to get silhouette checks
            even when the scene has a background.
        check_animation: Also compare palettes and bounds across all frames

    Returns:
        JSON: score (0-100), grade (A-E), stats, and issues sorted by severity.
    """
    check_file(filename)
    info = pixio.sprite_info(filename)
    if frame_index < 1 or frame_index > info.frames:
        return f"ERROR: frame_index out of range (sprite has {info.frames} frames)"
    reqs = [("composite", layer_name, frame_index)]
    if check_animation and info.frames > 1:
        reqs += [("composite", layer_name, f) for f in range(1, min(info.frames, 64) + 1) if f != frame_index]
    imgs = pixio.read_images(filename, reqs)
    result = analyze(imgs[0])
    result.pop("marks")
    if len(imgs) > 1:
        frames_order = [frame_index] + [f for f in range(1, min(info.frames, 64) + 1) if f != frame_index]
        sets = {}
        heights = {}
        for f, im in zip(frames_order, imgs):
            sets[f] = {c[:3] for c, _ in po.colors_used(im)}
            b = po.bbox(po.opaque(im))
            heights[f] = (b[3] - b[1]) if b else 0
        allc = set().union(*sets.values())
        rare = []
        for c in allc:
            present = [f for f, s in sets.items() if c in s]
            if 0 < len(present) <= max(1, len(sets) // 4) and len(sets) >= 3:
                rare.append({"color": cs.rgb_to_hex(c), "frames": sorted(present)})
        if rare:
            result["issues"].append({"severity": "medium", "kind": "palette_drift",
                                     "message": f"{len(rare)} colour(s) appear in only a few frames: the "
                                     "animation will flicker. Snap every frame to one palette.",
                                     "fix": "quantize_pro(frames=\"all\") with the sprite palette, or merge_similar_colors",
                                     "where": rare[:MAX_LISTED]})
            result["score"] = max(0, result["score"] - min(10, 2 + len(rare)))
        hs = [v for v in heights.values() if v]
        if hs and max(hs) - min(hs) > max(3, 0.25 * max(hs)):
            result["stats"]["height_range_across_frames"] = [min(hs), max(hs)]
        result["stats"]["frames_checked"] = len(imgs)
    result["frame"] = frame_index
    result["layer"] = layer_name or None
    if not result["issues"]:
        result["summary"] = "Clean: no problems found."
    else:
        hi = sum(1 for e in result["issues"] if e["severity"] == "high")
        md = sum(1 for e in result["issues"] if e["severity"] == "medium")
        result["summary"] = f"{hi} high and {md} medium issue(s). Fix the high ones first, then re-run."
    return as_json(result)


# --- visual checks -------------------------------------------------------------------------

MARK_COLORS = {"stray": (255, 0, 160), "double": (255, 120, 0), "jaggy": (0, 140, 255), "detached": (200, 0, 0)}


def _silhouette(img: np.ndarray) -> PILImage.Image:
    m = po.opaque(img)
    arr = np.full(img.shape[:2] + (3,), 255, np.uint8)
    arr[m] = (20, 20, 28)
    return PILImage.fromarray(arr, "RGB")


def _values(img: np.ndarray, bg=(255, 255, 255)) -> PILImage.Image:
    L = po.lab_image(img)[..., 0]
    g = np.clip(L * 255, 0, 255).astype(np.uint8)
    arr = np.stack([g, g, g, img[..., 3]], -1)
    return on_bg(arr, bg).convert("RGB")


@mcp.tool()
@tool_errors
async def view_quality(filename: str, frame_index: int = 1, layer_name: str = "", show_issues: bool = True,
                       background: str = "", output_filename: str = ""):
    """Look at a sprite the way pixel artists check it, in one image.

    Panels: the sprite at 1x and 2x (what players actually see), a large
    zoom with the critique's problems outlined (pink = stray pixel,
    orange = double, blue = jaggy, red = detached part), the silhouette (does
    the pose read as a solid shape?), the values in greyscale (does it read
    without colour?) and the palette sorted dark to light with pixel counts.

    Args:
        filename: Aseprite file
        frame_index: Frame (1-based)
        layer_name: One layer or group alone ("" = all visible)
        show_issues: Outline the problems on the zoomed panel
        background: Hex colour to show the sprite on (default checkerboard)
        output_filename: Optional path to also save the PNG
    """
    check_file(filename)
    img = pixio.read_composite(filename, frame_index, layer_name)
    h, w = img.shape[:2]
    bg = cs.hex_to_rgb(background) if background else None
    if background and bg is None:
        return f"ERROR: Invalid background colour {background}"
    result = analyze(img)
    k = fit_scale(w, h, 560)
    big = zoom(on_bg(img, bg), k).convert("RGB")
    if show_issues and result["marks"]:
        d = ImageDraw.Draw(big)
        for x, y, mw, mh, kind in result["marks"]:
            col = MARK_COLORS.get(kind, (255, 0, 0))
            d.rectangle([x * k - 1, y * k - 1, (x + mw) * k, (y + mh) * k], outline=col, width=2 if k >= 6 else 1)
    small_k = fit_scale(w, h, 200)
    side = column([titled(on_bg(img, bg).convert("RGB"), "1x"), titled(zoom(on_bg(img, bg), 2).convert("RGB"), "2x")], gap=8) \
        if max(w, h) <= 128 else titled(zoom(on_bg(img, bg), 1).convert("RGB"), "1x")
    sil = titled(zoom(_silhouette(img), small_k), "silhouette")
    val = titled(zoom(_values(img, (255, 255, 255) if bg is None else bg), small_k), "values")
    cols = sorted(po.colors_used(img)[:48], key=lambda t: cs.lightness(t[0]))
    pal = titled(swatches([(c[:3], str(n)) for c, n in cols], size=18, per_row=12),
                 f"palette ({len(po.colors_used(img))} colours, dark to light)")
    top = row([side, titled(big, f"{k}x  score {result['score']} ({result['grade']})"), column([sil, val], gap=8)])
    sheet = column([top, row([pal])])
    if max(sheet.size) > 1900:
        f = 1900 / max(sheet.size)
        sheet = sheet.resize((int(sheet.width * f), int(sheet.height * f)), PILImage.NEAREST)
    kinds = Counter(m[4] for m in result["marks"])
    text = (f"{w}x{h} frame {frame_index}: score {result['score']} ({result['grade']}), "
            f"{len(result['issues'])} issue(s)"
            + (f"; marked: " + ", ".join(f"{v} {k_}" for k_, v in kinds.items()) if kinds and show_issues else "")
            + ". Run critique_sprite for coordinates and fixes.")
    return image_reply(text, sheet, output_filename)


@mcp.tool()
@tool_errors
async def view_tiled(filename: str, frame_index: int = 1, layer_name: str = "", tiles: int = 3,
                     output_filename: str = ""):
    """Show a frame repeated in a grid to check that a texture or tile is seamless.

    Returns the tiled image plus a seam report: how different the left and
    right (and top and bottom) edges are, so you know whether the wrap shows.
    Fix seams with offset_wrap (moves the seams to the middle of the tile),
    paint over them, then offset back.

    Args:
        filename: Aseprite file
        frame_index: Frame (1-based)
        layer_name: One layer alone ("" = all visible)
        tiles: Repeats per side, 2-5
        output_filename: Optional PNG path
    """
    check_file(filename)
    tiles = max(2, min(5, tiles))
    img = pixio.read_composite(filename, frame_index, layer_name)
    h, w = img.shape[:2]
    lab = po.lab_image(img)
    seam_x = float(np.linalg.norm(lab[:, 0] - lab[:, -1], axis=-1).mean())
    seam_y = float(np.linalg.norm(lab[0] - lab[-1], axis=-1).mean())
    inner_x = float(np.linalg.norm(lab[:, 1:] - lab[:, :-1], axis=-1).mean())
    inner_y = float(np.linalg.norm(lab[1:] - lab[:-1], axis=-1).mean())
    tiled = np.tile(img, (tiles, tiles, 1))
    k = fit_scale(w * tiles, h * tiles, 1200)
    im = zoom(on_bg(tiled), k).convert("RGB")

    def verdict(seam, inner):
        return "seamless" if seam <= inner * 1.3 + 0.01 else "visible seam" if seam > inner * 2 else "slight seam"
    rep = {"horizontal_wrap": {"edge_difference": round(seam_x, 3), "typical_difference": round(inner_x, 3),
                               "verdict": verdict(seam_x, inner_x)},
           "vertical_wrap": {"edge_difference": round(seam_y, 3), "typical_difference": round(inner_y, 3),
                             "verdict": verdict(seam_y, inner_y)}}
    return image_reply(f"{tiles}x{tiles} tiling of {w}x{h} at {k}x. Seams: {as_json(rep)}", im, output_filename)
