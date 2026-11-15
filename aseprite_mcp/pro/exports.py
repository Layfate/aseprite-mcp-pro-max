"""Export for showing and for shipping.

- export_showcase: a presentation image (sprite upscaled on a background,
  optional frames row and palette strip) - what you post or put in a README.
- export_upscaled: integer, Scale2x/3x (EPX) or combinations, as PNG or GIF.
- export_spritesheet_pro: padded, edge-extruded sheets (no texture bleeding
  in engines) with JSON for Godot/Unity/Phaser-style loaders.
"""
from __future__ import annotations

import json
import math
import os

import numpy as np
from PIL import Image as PILImage

from .. import mcp
from . import colorsci as cs
from . import pixops as po
from . import pixio
from .common import (as_json, check_file, check_out, column, image_reply, on_bg, row, swatches, titled,
                     tool_errors, zoom)


def _upscale(img: np.ndarray, method: str, scale: int) -> np.ndarray:
    if method == "nearest":
        return po.scale_nearest(img, scale)
    if method == "scale2x":
        out = img
        k = 1
        while k * 2 <= scale:
            out = po.scale2x(out)
            k *= 2
        return po.scale_nearest(out, max(1, scale // k)) if scale % k == 0 else po.scale_nearest(out, max(1, round(scale / k)))
    if method == "scale3x":
        out = img
        k = 1
        while k * 3 <= scale:
            out = po.scale3x(out)
            k *= 3
        return po.scale_nearest(out, max(1, round(scale / k)))
    raise pixio.PixError("method must be nearest, scale2x or scale3x")


@mcp.tool()
@tool_errors
async def export_upscaled(filename: str, output_filename: str, scale: int = 4, method: str = "nearest",
                          frames: str = "", layer_name: str = "", background: str = "") -> str:
    """Export frames upscaled for display, as PNG (one frame / sheet) or animated GIF.

    method:
      nearest - exact big pixels (the default; what pixel art should look like)
      scale2x - EPX: rounds stair-steps with no new colours (2x, 4x, 8x)
      scale3x - smoother diagonals (3x, 9x)
    GIF output keeps each frame's own duration and a transparent background
    unless `background` is given.

    Args:
        filename: Aseprite file
        output_filename: .png or .gif
        scale: 1-32
        method: nearest, scale2x or scale3x
        frames: "" = all; a PNG with several frames becomes a horizontal strip
        layer_name: Only this layer or group
        background: Hex colour behind the sprite
    """
    check_file(filename)
    check_out(output_filename)
    ext = os.path.splitext(output_filename)[1].lower()
    if ext not in (".png", ".gif"):
        return "ERROR: output must be .png or .gif"
    scale = max(1, min(32, scale))
    info = pixio.sprite_info(filename)
    fl = pixio.parse_frames(frames, info.frames)
    bg = cs.hex_to_rgb(background) if background else None
    if background and bg is None:
        return f"ERROR: Invalid background {background}"
    imgs = pixio.read_images(filename, [("composite", layer_name, f) for f in fl])
    big = [_upscale(im, method, scale) for im in imgs]
    pil = []
    for b in big:
        if bg:
            pil.append(PILImage.alpha_composite(PILImage.new("RGBA", (b.shape[1], b.shape[0]), (*bg, 255)),
                                                PILImage.fromarray(b, "RGBA")))
        else:
            pil.append(PILImage.fromarray(b, "RGBA"))
    if ext == ".gif":
        durs = [info.durations[f - 1] for f in fl]
        if bg:
            frames_p = [p.convert("RGB").quantize(colors=256, method=PILImage.Quantize.MEDIANCUT, dither=0)
                        for p in pil]
            frames_p[0].save(output_filename, save_all=True, append_images=frames_p[1:], duration=durs, loop=0,
                             disposal=2, optimize=False)
        else:
            conv = []
            for p in pil:
                a = np.array(p)
                q = PILImage.fromarray(a[..., :3], "RGB").quantize(colors=255, method=PILImage.Quantize.MEDIANCUT,
                                                                  dither=0)
                qa = np.array(q)
                qa = np.where(a[..., 3] < 128, 255, qa).astype(np.uint8)
                qp = PILImage.fromarray(qa, "P")
                pal = q.getpalette()[:765] + [0, 0, 0]
                qp.putpalette(pal)
                qp.info["transparency"] = 255
                conv.append(qp)
            conv[0].save(output_filename, save_all=True, append_images=conv[1:], duration=durs, loop=0, disposal=2,
                         transparency=255, optimize=False)
    else:
        if len(pil) == 1:
            pil[0].save(output_filename)
        else:
            w, h = pil[0].size
            strip = PILImage.new("RGBA", (w * len(pil), h), (0, 0, 0, 0))
            for i, p in enumerate(pil):
                strip.paste(p, (i * w, 0))
            strip.save(output_filename)
    w, h = pil[0].size
    return f"Exported {len(pil)} frame(s) at {scale}x ({method}) to {output_filename} ({w}x{h} per frame)"


@mcp.tool()
@tool_errors
async def export_showcase(filename: str, output_filename: str, frames: str = "", background: str = "#2B2B3A",
                          scale: int = 0, show_palette: bool = True, title: str = "", layer_name: str = ""):
    """A presentation image of the sprite: big hero view, the frames in a row and
    the palette - ready to post, share or put in a README. Also returned so
    you can see it.

    Args:
        filename: Aseprite file
        output_filename: PNG path
        frames: Frames to show in the strip ("" = all, up to 16)
        background: Background colour (dark neutrals make colours pop)
        scale: Hero zoom (0 = auto)
        show_palette: Add the palette strip
        title: Caption text
        layer_name: Only this layer or group
    """
    check_file(filename)
    check_out(output_filename)
    info = pixio.sprite_info(filename)
    fl = pixio.parse_frames(frames, info.frames)[:16]
    bg = cs.hex_to_rgb(background)
    if bg is None:
        return f"ERROR: Invalid background {background}"
    imgs = pixio.read_images(filename, [("composite", layer_name, f) for f in fl])
    w, h = info.width, info.height
    hk = scale or max(2, min(16, 480 // max(w, h)))
    hero = zoom(on_bg(imgs[0], bg), hk)
    parts = [hero]
    if len(imgs) > 1:
        per = len(imgs)
        fit = lambda n: max(1, min(6, (hero.width - 6 * (n + 1)) // (n * max(w, 1))))
        while fit(per) < 3 and per > 2:
            per = math.ceil(per / 2)
        sk = fit(per)
        strips = [row([zoom(on_bg(im, bg), sk) for im in imgs[i:i + per]], gap=6, bg=bg)
                  for i in range(0, len(imgs), per)]
        parts.append(column(strips, bg=bg))
    if show_palette:
        cols = {}
        for im in imgs:
            for c, n in po.colors_used(im):
                cols[c[:3]] = cols.get(c[:3], 0) + n
        ordered = sorted(cols, key=lambda c: cs.lightness(c))[:64]
        sw = swatches([(c, "") for c in ordered], size=16, per_row=32, bg=bg)
        parts.append(sw)
    sheet = column([p.convert("RGB") for p in parts], gap=10, bg=bg)
    pad = 24
    top = 30 if title else 0
    out = PILImage.new("RGB", (sheet.width + 2 * pad, sheet.height + 2 * pad + top), bg)
    out.paste(sheet, (pad, pad + top))
    if title:
        from PIL import ImageDraw
        from .common import font
        light = cs.lightness(bg) < 0.5
        ImageDraw.Draw(out).text((pad, pad - 4), title, fill=(235, 235, 240) if light else (20, 20, 25), font=font(18))
    out.save(output_filename)
    return image_reply(f"Showcase saved to {output_filename} ({out.width}x{out.height}).", out)


@mcp.tool()
@tool_errors
async def export_spritesheet_pro(filename: str, output_png: str, columns: int = 0, padding: int = 2,
                                 extrude: int = 1, trim: bool = False, scale: int = 1, power_of_two: bool = False,
                                 frames: str = "", by_tag: bool = True, layer_name: str = "") -> str:
    """A game-ready sprite sheet: padding and edge extrusion against texture
    bleeding, optional trimming with offsets, power-of-two size, and JSON
    metadata (frame rects, durations, tags, pivots) next to the PNG.

    Extrusion repeats each frame's border pixels outward into the padding,
    so engines that filter or round UVs never sample a neighbour frame.

    Args:
        filename: Aseprite file
        output_png: Sheet PNG path; metadata goes to the same name with .json
        columns: Frames per row (0 = roughly square)
        padding: Empty pixels between frames (>= 2*extrude recommended)
        extrude: Border pixels repeated outward, 0-4
        trim: Crop each frame to its drawn pixels (offsets are in the JSON)
        scale: Integer upscale before packing, 1-8
        power_of_two: Round the sheet size up to powers of two
        frames: "" = all frames
        by_tag: One row per tag (when the sprite has tags and columns is 0)
        layer_name: Only this layer or group
    """
    check_file(filename)
    check_out(output_png)
    info = pixio.sprite_info(filename)
    fl = pixio.parse_frames(frames, info.frames)
    scale = max(1, min(8, scale))
    extrude = max(0, min(4, extrude))
    padding = max(padding, 2 * extrude)
    imgs = pixio.read_images(filename, [("composite", layer_name, f) for f in fl])
    cells = []
    for f, im in zip(fl, imgs):
        im = po.scale_nearest(im, scale) if scale > 1 else im
        ox = oy = 0
        if trim:
            b = po.bbox(po.opaque(im))
            if b:
                ox, oy = b[0], b[1]
                im = im[b[1]:b[3], b[0]:b[2]]
            else:
                im = im[:1, :1]
        cells.append((f, im, ox, oy))
    # layout rows
    rows_ = []
    if by_tag and info.tags and columns == 0:
        placed = set()
        for t in info.tags:
            r = [c for c in cells if t["from"] <= c[0] <= t["to"]]
            if r:
                rows_.append(r)
                placed.update(c[0] for c in r)
        rest = [c for c in cells if c[0] not in placed]
        if rest:
            rows_.append(rest)
    else:
        cols = columns or max(1, math.ceil(math.sqrt(len(cells))))
        rows_ = [cells[i:i + cols] for i in range(0, len(cells), cols)]
    cw = max(c[1].shape[1] for c in cells) + padding
    ch = max(c[1].shape[0] for c in cells) + padding
    W = max(len(r) for r in rows_) * cw + padding
    H = len(rows_) * ch + padding
    if power_of_two:
        W, H = 1 << (W - 1).bit_length(), 1 << (H - 1).bit_length()
    sheet = np.zeros((H, W, 4), np.uint8)
    meta_frames = []
    for ri, r in enumerate(rows_):
        for ci, (f, im, ox, oy) in enumerate(r):
            x0, y0 = padding + ci * cw, padding + ri * ch
            hh, ww = im.shape[:2]
            if extrude:
                ext = np.pad(im, ((extrude, extrude), (extrude, extrude), (0, 0)), mode="edge")
                sheet[y0 - extrude:y0 + hh + extrude, x0 - extrude:x0 + ww + extrude] = ext
            sheet[y0:y0 + hh, x0:x0 + ww] = im
            meta_frames.append({"frame": f, "x": x0, "y": y0, "w": ww, "h": hh,
                                "offset_x": ox, "offset_y": oy,
                                "source_w": info.width * scale, "source_h": info.height * scale,
                                "duration_ms": info.durations[f - 1]})
    PILImage.fromarray(sheet, "RGBA").save(output_png)
    meta = {"image": os.path.basename(output_png), "size": {"w": W, "h": H}, "scale": scale,
            "padding": padding, "extrude": extrude, "trimmed": trim, "frames": meta_frames,
            "tags": [{**t, "frames": [m for m in range(t["from"], t["to"] + 1) if m in fl]} for t in info.tags]}
    jpath = os.path.splitext(output_png)[0] + ".json"
    with open(jpath, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1)
    return as_json({"sheet": output_png, "json": jpath, "size": [W, H], "frames": len(meta_frames),
                    "rows": len(rows_)})
