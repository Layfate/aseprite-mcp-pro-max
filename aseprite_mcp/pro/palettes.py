"""Palette craft: perceptual ramps, cohesive palettes, analysis, quantize + dither.

The template's ramps step in HSL, where equal steps don't look equal (yellow
jumps, blue barely moves). These work in OKLCH, so every step is the same
visible distance, shadows lean cool and lights warm, and chroma behaves the
way painted ramps do.
"""
from __future__ import annotations

import numpy as np

from .. import mcp
from ..core.commands import AsepriteCommand
from . import colorsci as cs
from . import pixops as po
from . import pixio
from .common import as_json, check_file, image_reply, swatches, titled, column, tool_errors
from .fixers import targets

MOODS = {
    # base colours per mood: (hex, role)
    "fantasy": ["#C0503C", "#3C78C8", "#58A048", "#E8C060", "#8C5AA8", "#C89C78"],
    "forest": ["#4E8A3A", "#2F6B4F", "#8A6A3C", "#C9B458", "#6E8FA0", "#A0503C"],
    "desert": ["#D8A05C", "#B8643C", "#E8D09C", "#6C8CA0", "#7C9C4C", "#8C4C3C"],
    "night": ["#3C4C8C", "#5C3C8C", "#2C7C8C", "#E8C870", "#9CA8C8", "#C05C7C"],
    "candy": ["#F07CA8", "#7CC8F0", "#F0D070", "#A8E07C", "#B890F0", "#F0A070"],
    "sci-fi": ["#3CC8D8", "#5C6C8C", "#E8503C", "#9CE04C", "#C8C8D8", "#E8A030"],
    "horror": ["#7C2C2C", "#4C5C4C", "#8C8C6C", "#3C3C5C", "#C8B890", "#5C3C4C"],
    "ocean": ["#2C6CB0", "#3CA8B8", "#E8D8A8", "#5C9C6C", "#F08C6C", "#2C3C6C"],
    "autumn": ["#C8642C", "#A83C2C", "#E0A83C", "#6C7C3C", "#8C5C3C", "#5C6C8C"],
    "retro-warm": ["#D8503C", "#F0A040", "#F0E0A0", "#4C9C8C", "#3C5C8C", "#8C3C6C"],
}


def build_palette(bases: list[tuple[int, int, int]], steps: int, hue_shift: float, step_l: float,
                  neutrals: int, shared_extremes: bool) -> tuple[list[list], list]:
    darker = (steps - 1) // 2 + (1 if steps % 2 == 0 else 0)
    lighter = steps - 1 - darker
    ramps = []
    for b in bases:
        ramps.append(cs.hue_shift_ramp(b, darker, lighter, step_l=step_l, hue_shift=hue_shift))
    extra = []
    if neutrals:
        # a cool, slightly blue-violet grey ramp: reads as neutral, sits well next to colour
        n = max(2, neutrals)
        for i in range(n):
            t = i / (n - 1)
            L = 0.16 + t * 0.78
            h = cs.SHADOW_HUE if t < 0.6 else cs.LIGHT_HUE
            extra.append(cs.oklch_to_rgb_gamut(L, 0.018 + 0.01 * (1 - t), h))
    if shared_extremes:
        # Merge each ramp's darkest step into one shared near-black and the
        # brightest highlights into one shared near-white when they are close:
        # fewer colours, more cohesion (the classic "ramps share ends" trick).
        darks = [r[0] for r in ramps]
        ld = cs.rgb_to_oklab(np.array(darks, np.float64))
        if len(darks) > 1 and np.max(np.linalg.norm(ld - ld.mean(0), axis=1)) < 0.12:
            shared = tuple(int(v) for v in cs.oklab_to_rgb(ld.mean(0)))
            ramps = [[shared] + r[1:] for r in ramps]
    return ramps, extra


def _unique(colors):
    seen, out = set(), []
    for c in colors:
        t = tuple(c)
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _set_palette(filename: str, colors: list[tuple[int, int, int]]) -> None:
    entries = ", ".join(f"Color({r},{g},{b},255)" for r, g, b in colors)
    script = f"""
    local spr = app.activeSprite
    if not spr then print("ERROR:No active sprite") return end
    local cols = {{ {entries} }}
    local pal = Palette(#cols + 1)
    pal:setColor(0, Color(0, 0, 0, 0))
    for i, c in ipairs(cols) do pal:setColor(i, c) end
    spr:setPalette(pal)
    spr:saveAs(spr.filename)
    print("OK")
    """
    ok, out = AsepriteCommand.execute_lua_script_checked(script, filename)
    if not ok:
        raise pixio.PixError(out)


@mcp.tool()
@tool_errors
async def color_ramp_pro(base_color: str, darker: int = 2, lighter: int = 2, step: float = 0.11,
                         hue_shift: float = 14.0, shadow_hue: float = 275.0, light_hue: float = 85.0):
    """A perceptually even shading ramp with hue shifting, plus a swatch image.

    Steps are equal in OKLab lightness (they look equally far apart);
    shadows turn toward shadow_hue (275 = blue-violet), lights toward
    light_hue (85 = warm yellow), and chroma peaks in the mid shadows the way
    painted ramps do. Use instead of generate_color_ramp for richer colour.

    Args:
        base_color: The material's main colour (it stays in the ramp unchanged)
        darker: Shades below the base, 0-5
        lighter: Shades above the base, 0-4
        step: Lightness difference per step, 0.06 (subtle) to 0.16 (punchy)
        hue_shift: Degrees the hue turns per step, 0-30
        shadow_hue / light_hue: Hues that shadows / lights lean toward
                     (e.g. shadow_hue=200 for teal shadows on a sunny scene)

    Returns:
        JSON with the ramp (darkest to lightest) and an image of it.
    """
    base = cs.hex_to_rgb(base_color)
    if base is None:
        return f"ERROR: Invalid base_color {base_color}"
    ramp = cs.hue_shift_ramp(base, max(0, min(5, darker)), max(0, min(4, lighter)), max(0.03, min(0.2, step)),
                             max(0.0, min(30.0, hue_shift)), shadow_hue, light_hue)
    hexes = [cs.rgb_to_hex(c) for c in ramp]
    img = swatches([(c, h[1:]) for c, h in zip(ramp, hexes)], size=40, per_row=12)
    return image_reply(as_json({"ramp": hexes, "base_index": max(0, min(5, darker))}), img)


@mcp.tool()
@tool_errors
async def generate_palette_pro(base_colors: list[str] | None = None, mood: str = "", steps: int = 4,
                               hue_shift: float = 14.0, contrast: float = 1.0, neutrals: int = 0,
                               shared_extremes: bool = True, apply_to: str = "", output_filename: str = ""):
    """Design a cohesive palette: one hue-shifted ramp per material.

    Give the materials' base colours (skin, cloth, metal, foliage...) or a
    mood, and get matching ramps that share their darkest shade, so the
    whole sprite or scene holds together. Applying it sets the sprite's
    palette; then draw with these colours or quantize_pro to snap existing
    art onto them.

    Args:
        base_colors: Hex base colour of each material, e.g. ["#E0A070", "#3C78C8", "#8C8C9C"]
        mood: Or start from a preset: fantasy, forest, desert, night, candy,
            sci-fi, horror, ocean, autumn, retro-warm
        steps: Colours per ramp, 2-7 (3-4 for 16-32 px sprites, 5-6 for larger)
        hue_shift: Degrees of hue turn per step
        contrast: Lightness step multiplier, 0.6-1.6
        neutrals: Add a cool grey ramp with this many steps (0 = none)
        shared_extremes: Merge close darkest shades into one shared dark
        apply_to: Aseprite file whose palette to replace with this one
        output_filename: Optional PNG of the swatches
    """
    if not base_colors and not mood:
        return "ERROR: give base_colors or a mood (" + ", ".join(MOODS) + ")"
    if mood and mood not in MOODS:
        return f"ERROR: Unknown mood '{mood}'. Moods: {', '.join(MOODS)}"
    bases = cs.parse_colors(base_colors) if base_colors else cs.parse_colors(MOODS[mood])
    if isinstance(bases, str):
        return f"ERROR: {bases}"
    steps = max(2, min(7, steps))
    ramps, extra = build_palette(bases, steps, hue_shift, 0.105 * max(0.6, min(1.6, contrast)), neutrals,
                                 shared_extremes)
    allc = _unique([c for r in ramps for c in r] + extra)
    if apply_to:
        check_file(apply_to)
        _set_palette(apply_to, allc)
    rows = [titled(swatches([(c, "") for c in r], size=30, per_row=8), f"ramp {i + 1}: base {cs.rgb_to_hex(bases[i])}")
            for i, r in enumerate(ramps)]
    if extra:
        rows.append(titled(swatches([(c, "") for c in extra], size=30, per_row=8), "neutrals"))
    img = column(rows, gap=6)
    data = {"colors": [cs.rgb_to_hex(c) for c in allc], "count": len(allc),
            "ramps": [[cs.rgb_to_hex(c) for c in r] for r in ramps],
            "neutrals": [cs.rgb_to_hex(c) for c in extra], "applied_to": apply_to or None}
    return image_reply(as_json(data), img, output_filename)


@mcp.tool()
@tool_errors
async def analyze_palette(filename: str = "", colors: list[str] | None = None, frames: str = "") -> str:
    """Check a palette for the things that make art look amateur.

    Reports colours sorted by lightness, near-duplicates (too close to tell
    apart), detected ramps and whether they hue-shift, the lightness range,
    gaps (big jumps in a ramp) and the share of very saturated colours.
    Reads the colours actually used in the sprite (all frames by default),
    or a list you pass.

    Args:
        filename: Aseprite file (colours used in it)
        colors: Or a list of hex colours to check
        frames: Frames to scan ("" = all)
    """
    counts = {}
    if colors:
        parsed = cs.parse_colors(colors)
        if isinstance(parsed, str):
            return f"ERROR: {parsed}"
        for c in parsed:
            counts[c] = counts.get(c, 0) + 1
    else:
        check_file(filename)
        info = pixio.sprite_info(filename)
        fl = pixio.parse_frames(frames, info.frames)
        for im in pixio.read_images(filename, [("composite", "", f) for f in fl]):
            for c, n in po.colors_used(im):
                counts[c[:3]] = counts.get(c[:3], 0) + n
    if not counts:
        return "ERROR: no colours found"
    cols = list(counts)
    lab = cs.rgb_to_oklab(np.array(cols, np.float64))
    lch = cs.oklab_to_oklch(lab)
    order = np.argsort(lab[:, 0])
    dups = []
    for i in range(len(cols)):
        for j in range(i + 1, len(cols)):
            d = float(np.linalg.norm(lab[i] - lab[j]))
            if d < 0.035:
                dups.append({"a": cs.rgb_to_hex(cols[i]), "b": cs.rgb_to_hex(cols[j]), "distance": round(d, 4)})
    # ramps: chain colours of similar hue by lightness
    ramps = []
    used = set()
    for i in order.tolist():
        if i in used or lch[i, 1] < 0.03:
            continue
        chain = [i]
        used.add(i)
        for j in order.tolist():
            if j in used or lch[j, 1] < 0.03:
                continue
            if cs.angle_diff(lch[chain[-1], 2], lch[j, 2]) < 28 and lab[j, 0] > lab[chain[-1], 0]:
                chain.append(j)
                used.add(j)
        if len(chain) >= 2:
            Ls = lab[chain, 0]
            gaps = np.diff(Ls)
            hue_turn = cs.angle_diff(lch[chain[0], 2], lch[chain[-1], 2])
            ramps.append({"colors": [cs.rgb_to_hex(cols[k]) for k in chain],
                          "hue": cs.hue_name(float(np.median(lch[chain, 2])), 0.1),
                          "hue_shift_degrees": round(float(hue_turn), 1),
                          "hue_shifted": bool(hue_turn >= 6),
                          "max_step": round(float(gaps.max()), 3), "min_step": round(float(gaps.min()), 3),
                          "even_steps": bool(gaps.max() < 2.2 * max(gaps.min(), 0.02))})
    advice = []
    if dups:
        advice.append(f"{len(dups)} near-duplicate pair(s): merge them (merge_similar_colors).")
    flat = [r for r in ramps if len(r["colors"]) >= 3 and not r["hue_shifted"]]
    if flat:
        advice.append(f"{len(flat)} ramp(s) don't hue-shift: rebuild them with color_ramp_pro.")
    uneven = [r for r in ramps if len(r["colors"]) >= 3 and not r["even_steps"]]
    if uneven:
        advice.append(f"{len(uneven)} ramp(s) have uneven steps: one jump is much bigger than the others.")
    rng = float(lab[:, 0].max() - lab[:, 0].min())
    if rng < 0.45:
        advice.append(f"Lightness only spans {rng:.2f}: add a darker dark and a lighter light.")
    sat = float((lch[:, 1] > 0.2).mean())
    if sat > 0.5:
        advice.append("Over half the colours are very saturated; desaturate the large-area ones.")
    return as_json({
        "count": len(cols),
        "by_lightness": [{"color": cs.rgb_to_hex(cols[i]), "L": round(float(lab[i, 0]), 3),
                          "chroma": round(float(lch[i, 1]), 3), "hue": round(float(lch[i, 2])),
                          "uses": counts[cols[i]]} for i in order.tolist()],
        "lightness_range": round(rng, 3), "near_duplicates": dups, "ramps": ramps,
        "advice": advice or ["Palette looks healthy."]})


@mcp.tool()
@tool_errors
async def palette_from_image(image_path: str, colors: int = 16, apply_to: str = "", ignore_transparent: bool = True,
                             output_filename: str = ""):
    """Extract a palette from a reference image (concept art, photo, screenshot).

    Perceptual k-means in OKLab, weighted by how much of the image each colour
    covers, then sorted into hue families dark to light.

    Args:
        image_path: PNG/JPG/GIF to read
        colors: How many colours, 2-64
        apply_to: Aseprite file whose palette to set
        ignore_transparent: Skip transparent pixels
        output_filename: Optional swatch PNG
    """
    check_file(image_path)
    arr = pixio.load_png(image_path)
    px = arr[arr[..., 3] > 127] if ignore_transparent else arr.reshape(-1, 4)
    if len(px) == 0:
        return "ERROR: image has no opaque pixels"
    keys, counts = np.unique(px[:, :3].astype(np.uint32) @ np.array([65536, 256, 1], np.uint32),
                             return_counts=True)
    rgb = np.stack([(keys >> 16) & 255, (keys >> 8) & 255, keys & 255], -1).astype(np.float64)
    if len(rgb) > 6000:  # bucket for speed
        idx = np.argsort(-counts)[:6000]
        rgb, counts = rgb[idx], counts[idx]
    lab = cs.rgb_to_oklab(rgb)
    centres = cs.kmeans_oklab(lab, max(2, min(64, colors)), counts.astype(np.float64))
    out = [tuple(int(round(v)) for v in cs.oklab_to_rgb(c)) for c in centres]
    lch = cs.oklab_to_oklch(np.array(centres))
    out_sorted = [out[i] for i in sorted(range(len(out)), key=lambda i: (
        0 if lch[i, 1] < 0.03 else 1, round(lch[i, 2] / 30) if lch[i, 1] >= 0.03 else 0, lch[i, 0]))]
    if apply_to:
        check_file(apply_to)
        _set_palette(apply_to, out_sorted)
    img = swatches([(c, cs.rgb_to_hex(c)[1:]) for c in out_sorted], size=34, per_row=8)
    return image_reply(as_json({"colors": [cs.rgb_to_hex(c) for c in out_sorted], "applied_to": apply_to or None}),
                       img, output_filename)


@mcp.tool()
@tool_errors
async def quantize_pro(filename: str, palette: list[str] | None = None, use_sprite_palette: bool = False,
                       preset: str = "", max_colors: int = 0, dither: str = "none", strength: float = 1.0,
                       layer_name: str = "*", frames: str = "") -> str:
    """Snap art onto a palette, perceptually, with optional dithering.

    Nearest colour is chosen in OKLab (what looks closest, not what is
    numerically closest in RGB), so skin stays skin and shadows don't turn
    green. Dithering options for gradients and painted sources:
      none      - clean flat colours (best for sprites)
      bayer2 / bayer4 / bayer8 - ordered patterns, the retro look, stable in animation
      floyd / atkinson - error diffusion, for converting painted or photo
                  material (atkinson keeps more contrast); avoid on animation

    The palette comes from `palette`, the sprite's own palette, a preset
    (gameboy, pico8, c64, cga, dawnbringer16, dawnbringer32, ...), or is
    built from the art itself with max_colors.

    Args:
        filename: Aseprite file
        palette: Hex colours to snap to
        use_sprite_palette: Use the sprite's current palette
        preset: Name of a built-in palette preset
        max_colors: Build an optimal palette of this many colours from the art
        dither: none, bayer2, bayer4, bayer8, floyd, atkinson
        strength: Dither amount 0-1
        layer_name: "*" = every image layer, or one layer
        frames: "" = every frame
    """
    from ..tools.palette import PALETTE_PRESETS
    if dither not in ("none", "bayer2", "bayer4", "bayer8", "floyd", "atkinson"):
        return "ERROR: dither must be none, bayer2, bayer4, bayer8, floyd or atkinson"
    info, pairs = targets(filename, layer_name, frames)
    imgs = pixio.read_images(filename, [("layer", l, f) for l, f in pairs])
    if palette:
        pal = cs.parse_colors(palette)
        if isinstance(pal, str):
            return f"ERROR: {pal}"
    elif preset:
        if preset not in PALETTE_PRESETS:
            return f"ERROR: Unknown preset '{preset}'. Presets: {', '.join(PALETTE_PRESETS)}"
        pal = cs.parse_colors(PALETTE_PRESETS[preset])
    elif use_sprite_palette:
        pal = [cs.hex_to_rgb(c) for c in info.palette if not c.upper().endswith("00")]
        pal = _unique([c for c in pal if c])
    elif max_colors > 1:
        allpx = np.concatenate([im[im[..., 3] > 0][:, :3] for im in imgs] or [np.zeros((0, 3))])
        if len(allpx) == 0:
            return "ERROR: nothing drawn"
        keys, counts = np.unique(allpx.astype(np.uint32) @ np.array([65536, 256, 1], np.uint32), return_counts=True)
        rgb = np.stack([(keys >> 16) & 255, (keys >> 8) & 255, keys & 255], -1).astype(np.float64)
        c = cs.kmeans_oklab(cs.rgb_to_oklab(rgb), max_colors, counts.astype(np.float64))
        pal = _unique([tuple(int(round(v)) for v in cs.oklab_to_rgb(x)) for x in c])
    else:
        return "ERROR: give palette, preset, use_sprite_palette=True or max_colors"
    if not pal:
        return "ERROR: empty palette"
    writes = []
    for (l, f), img in zip(pairs, imgs):
        work = img.copy()
        work[..., 3] = np.where(img[..., 3] >= 128, 255, 0)
        out = po.quantize(work, pal, dither, max(0.0, min(1.0, strength)))
        if not np.array_equal(out, img):
            writes.append(pixio.Write(l, f, out, create=False))
    pixio.write_images(filename, writes)
    return as_json({"palette": [cs.rgb_to_hex(c) for c in pal], "dither": dither, "cels_changed": len(writes)})
