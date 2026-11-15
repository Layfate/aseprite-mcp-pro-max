"""Conversion and transforms that keep pixel art crisp.

- image_to_pixel_art: turn a reference, painting, photo or AI "pixel art"
  (blurry, off-grid, hundreds of colours) into a real sprite on a true pixel
  grid with a small palette.
- rotsprite_rotate: rotate by any angle without breaking lines.
- offset_wrap: shift with wrap-around, for making tiles seamless.
"""
from __future__ import annotations

import os

import numpy as np
from PIL import Image as PILImage

from .. import mcp
from ..core.commands import AsepriteCommand, lua_escape
from . import colorsci as cs
from . import pixops as po
from . import pixio
from .common import (as_json, check_file, check_out, fit_scale, image_reply, on_bg, row, titled, tool_errors,
                     zoom)
from .fixers import targets


def detect_grid(img: np.ndarray, max_cell: int = 48) -> tuple[int, int, int, float]:
    """Find the pixel size of upscaled pixel art: (cell, offset_x, offset_y, confidence).

    Colour edges in upscaled pixel art all sit on a regular grid. For each
    cell size the best offset is found per axis, and the share of all edge
    energy (above the noise floor, both axes together) that falls on the grid
    lines is measured. Every divisor of the true size also captures it all,
    so the largest size that still captures nearly everything wins.
    cell 1 means no grid was found (a painting or photo).
    """
    lab = po.lab_image(img) * (img[..., 3:4] / 255.0)
    dx = np.linalg.norm(lab[:, 1:] - lab[:, :-1], axis=-1)
    dy = np.linalg.norm(lab[1:] - lab[:-1], axis=-1)
    floor = 0.04   # ignore JPEG/AI noise below this OKLab step
    ex = np.clip(dx - floor, 0, None).sum(0)    # energy per vertical boundary x = i+1
    ey = np.clip(dy - floor, 0, None).sum(1)
    total = ex.sum() + ey.sum()
    if total <= 0:
        return 1, 0, 0, 0.0
    h, w = img.shape[:2]

    def best_offset(profile, s):
        pos = np.arange(1, len(profile) + 1)    # boundary positions
        sums = [profile[(pos % s) == o].sum() for o in range(s)]
        o = int(np.argmax(sums))
        return o, sums[o]

    scores = []
    for s in range(2, max(2, min(max_cell, min(w, h) // 4)) + 1):
        ox, cx = best_offset(ex, s)
        oy, cy = best_offset(ey, s)
        scores.append((s, ox, oy, (cx + cy) / total))
    if not scores:
        return 1, 0, 0, 0.0
    fbest = max(f for *_, f in scores)
    if fbest < 0.75:
        return 1, 0, 0, float(fbest)
    # "nearly everything": at most 1.5% more edge energy off the grid than the best size
    s, ox, oy, f = max((t for t in scores if t[3] >= fbest - 0.015), key=lambda t: t[0])
    return s, ox % s, oy % s, float(f)


def remove_background(img: np.ndarray, tolerance: float = 0.06) -> np.ndarray:
    """Make the background transparent: flood-fill from the border through
    colours close to the border colours."""
    out = img.copy()
    h, w = img.shape[:2]
    lab = po.lab_image(img)
    border = np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])
    seeds_lab = cs.kmeans_oklab(border, 3)
    near = np.zeros((h, w), bool)
    for s in seeds_lab:
        near |= np.linalg.norm(lab - s, axis=-1) < tolerance
    near &= img[..., 3] > 0
    labels, n = po.components(near, 4)
    edge_labels = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])).tolist()) - {0}
    bg = np.isin(labels, list(edge_labels))
    out[bg] = 0
    return out


def downsample(img: np.ndarray, cell: float, ox: int, oy: int, out_w: int, out_h: int) -> np.ndarray:
    """One pixel per cell: the median colour (OKLab) of the cell's centre area."""
    lab = po.lab_image(img)
    alpha = img[..., 3]
    out = np.zeros((out_h, out_w, 4), np.uint8)
    h, w = img.shape[:2]
    for j in range(out_h):
        y0 = oy + j * cell
        for i in range(out_w):
            x0 = ox + i * cell
            # sample the middle 60% of the cell, away from blurry edges
            m = max(0.0, cell * 0.2)
            xa, xb = int(x0 + m), int(np.ceil(x0 + cell - m))
            ya, yb = int(y0 + m), int(np.ceil(y0 + cell - m))
            xa, ya = max(0, min(w - 1, xa)), max(0, min(h - 1, ya))
            xb, yb = max(xa + 1, min(w, xb)), max(ya + 1, min(h, yb))
            a = alpha[ya:yb, xa:xb]
            if (a > 127).mean() < 0.5:
                continue
            sel = lab[ya:yb, xa:xb][a > 127]
            med = np.median(sel, axis=0)
            out[j, i, :3] = np.clip(np.round(cs.oklab_to_rgb(med)), 0, 255)
            out[j, i, 3] = 255
    return out


def _create_sprite(path: str, img: np.ndarray, palette: list, layer: str) -> None:
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        png = os.path.join(tmp, "art.png")
        PILImage.fromarray(img, "RGBA").save(png)
        entries = ", ".join(f"Color({r},{g},{b},255)" for r, g, b in palette)
        script = f"""
        local img = Image{{ fromFile = "{lua_escape(png)}" }}
        local spr = Sprite({img.shape[1]}, {img.shape[0]}, ColorMode.RGB)
        local cols = {{ {entries} }}
        local pal = Palette(#cols + 1)
        pal:setColor(0, Color(0, 0, 0, 0))
        for i, c in ipairs(cols) do pal:setColor(i, c) end
        spr:setPalette(pal)
        local layer = spr.layers[1]
        layer.name = "{lua_escape(layer)}"
        spr:newCel(layer, spr.frames[1], img, Point(0, 0))
        spr:saveAs("{lua_escape(os.path.abspath(path))}")
        print("OK")
        """
        ok, out = AsepriteCommand.execute_lua_script_checked(script)
        if not ok:
            raise pixio.PixError(out)


@mcp.tool()
@tool_errors
async def image_to_pixel_art(image_path: str, output_filename: str, width: int = 0, colors: int = 16,
                             palette: list[str] | None = None, preset: str = "", dither: str = "none",
                             remove_bg: bool = True, outline: str = "", cleanup: bool = True,
                             layer_name: str = "art"):
    """Convert an image into a clean, true-grid pixel-art sprite.

    Handles three kinds of input:
    - Upscaled or AI-generated "pixel art" (blurry, off-grid pixels, many
      near-identical colours): the real pixel grid is detected and each cell
      becomes exactly one pixel.
    - A painting, photo or concept art: scaled down to `width` px, sampling
      each cell's median colour (no blur).
    - Either way the colours are reduced perceptually (OKLab k-means) to
      `colors`, or snapped to your palette/preset, stray pixels are cleaned
      and an optional outline is added. A flat background touching the image
      border is made transparent.

    The result is a new .aseprite file, ready for critique_sprite and
    hand refinement (conversion is a starting point, not a finish).

    Args:
        image_path: PNG/JPG/WebP/GIF to convert
        output_filename: .aseprite file to create
        width: Target width in px (0 = auto: the detected grid, else 64)
        colors: Palette size when no palette is given, 2-64
        palette: Hex colours to snap to
        preset: Or a palette preset (pico8, dawnbringer32, gameboy, ...)
        dither: none, bayer2, bayer4, bayer8, floyd, atkinson
        remove_bg: Make a flat border-connected background transparent
        outline: "", "fixed" (near-black), "colored" or "selective"
        cleanup: Remove stray pixels after converting
        layer_name: Name of the layer in the new sprite
    """
    from ..tools.palette import PALETTE_PRESETS
    check_file(image_path)
    check_out(output_filename)
    if not output_filename.lower().endswith((".aseprite", ".ase")):
        return "ERROR: output_filename must end in .aseprite"
    src = pixio.load_png(image_path)
    h, w = src.shape[:2]
    if max(h, w) > 4096:
        return "ERROR: image is larger than 4096 px"
    work = src.copy()
    if remove_bg and (src[..., 3] > 0).all():
        work = remove_background(src)
    cell, ox, oy, conf = detect_grid(work) if width <= 0 else (1, 0, 0, 0.0)
    if cell > 1:
        out_w, out_h = (w - ox) // cell, (h - oy) // cell
        mode = f"detected a {cell}px pixel grid (confidence {conf:.2f})"
        cellf = float(cell)
    else:
        target = width if width > 0 else 64
        target = max(4, min(512, target))
        cellf = w / target
        out_w, out_h = target, max(1, int(round(h / cellf)))
        ox = oy = 0
        mode = f"scaled to {out_w}x{out_h} ({cellf:.2f} source px per pixel)"
    small = downsample(work, cellf, ox, oy, out_w, out_h)
    if not po.opaque(small).any():
        return "ERROR: nothing left after background removal; try remove_bg=False"
    if palette:
        pal = cs.parse_colors(palette)
        if isinstance(pal, str):
            return f"ERROR: {pal}"
    elif preset:
        if preset not in PALETTE_PRESETS:
            return f"ERROR: Unknown preset '{preset}'"
        pal = cs.parse_colors(PALETTE_PRESETS[preset])
    else:
        px = small[small[..., 3] > 0][:, :3].astype(np.float64)
        c = cs.kmeans_oklab(cs.rgb_to_oklab(px), max(2, min(64, colors)))
        pal = list(dict.fromkeys(tuple(int(round(v)) for v in cs.oklab_to_rgb(x)) for x in c))
    art = po.quantize(small, pal, dither)
    if cleanup and dither == "none":
        art, _ = po.remove_orphans(art, remove_lone=True, passes=1)
    if outline in ("fixed", "colored", "selective"):
        art = np.pad(art, ((1, 1), (1, 1), (0, 0))) if po.opaque(art)[[0, -1]].any() or po.opaque(art)[:, [0, -1]].any() else art
        dark = min(pal, key=lambda c: cs.lightness(c))
        art = po.outline(art, dark, outline, "outside", False)
    used = [c[:3] for c, _ in po.colors_used(art)]
    _create_sprite(output_filename, art, list(dict.fromkeys(list(pal) + used)), layer_name)
    k1 = max(1, min(400 // max(w, h), 4)) if max(w, h) < 400 else 1
    srcv = PILImage.fromarray(src, "RGBA")
    if max(w, h) > 400:
        f = 400 / max(w, h)
        srcv = srcv.resize((max(1, int(w * f)), max(1, int(h * f))), PILImage.LANCZOS)
    else:
        srcv = srcv.resize((w * k1, h * k1), PILImage.NEAREST)
    k = fit_scale(art.shape[1], art.shape[0], 420)
    sheet = row([titled(on_bg(np.array(srcv.convert("RGBA"))), "source"),
                 titled(zoom(on_bg(art), k), f"result {art.shape[1]}x{art.shape[0]}, {len(used)} colours")])
    text = (f"Created {output_filename}: {mode}; {art.shape[1]}x{art.shape[0]}, {len(used)} colours. "
            "Next: critique_sprite and view_quality, then refine by hand.")
    return image_reply(text, sheet)


@mcp.tool()
@tool_errors
async def rotsprite_rotate(filename: str, angle: float, layer_name: str = "", frames: str = "1",
                           pivot: str = "", method: str = "rotsprite", output_layer: str = "") -> str:
    """Rotate a layer by any angle without the broken, jagged lines of plain rotation.

    RotSprite (the algorithm behind Aseprite's own rotation, done offline):
    upscale 8x with Scale2x, rotate there, sample back. Lines stay connected
    and no new colours appear. Good for swinging weapons, tilted props,
    leaning poses and spinning items. Positive angles turn clockwise.

    Args:
        filename: Aseprite file
        angle: Degrees, clockwise (e.g. 22.5, -45)
        layer_name: Image layer ("" = topmost)
        frames: Frames to rotate (default "1"; "" = all)
        pivot: "x,y" to rotate around (default: centre of the drawn pixels)
        method: rotsprite (best) or nearest (fast, blockier)
        output_layer: Write to this layer instead of replacing
    """
    if method not in ("rotsprite", "nearest"):
        return "ERROR: method must be rotsprite or nearest"
    pv = None
    if pivot:
        try:
            px, py = (float(v) for v in pivot.split(","))
            pv = (px, py)
        except ValueError:
            return "ERROR: pivot must be \"x,y\""
    info, pairs = targets(filename, layer_name, frames)
    imgs = pixio.read_images(filename, [("layer", l, f) for l, f in pairs])
    writes = []
    for (l, f), img in zip(pairs, imgs):
        out = po.rotsprite(img, angle, pv) if method == "rotsprite" else po.rotate_nearest(img, angle, pv)
        writes.append(pixio.Write(output_layer or l, f, out, create=bool(output_layer), above=l))
    pixio.write_images(filename, writes)
    return as_json({"rotated_cels": len(writes), "angle": angle, "method": method})


@mcp.tool()
@tool_errors
async def offset_wrap(filename: str, dx: int, dy: int, layer_name: str = "*", frames: str = "") -> str:
    """Shift layers with wrap-around (pixels leaving one edge come back on the other).

    The standard way to make a tile seamless: offset by half the tile size
    so the edges meet in the middle, paint over the seam there, then offset
    back. view_tiled shows whether it worked.

    Args:
        filename: Aseprite file
        dx, dy: Shift in pixels (e.g. half the width and height)
        layer_name: "*" = all image layers, or one layer
        frames: "" = every frame
    """
    info, pairs = targets(filename, layer_name, frames)
    imgs = pixio.read_images(filename, [("layer", l, f) for l, f in pairs])
    writes = [pixio.Write(l, f, po.translate(img, dx, dy, wrap=True), create=False)
              for (l, f), img in zip(pairs, imgs) if po.opaque(img).any()]
    pixio.write_images(filename, writes)
    return as_json({"shifted_cels": len(writes), "dx": dx, "dy": dy})
