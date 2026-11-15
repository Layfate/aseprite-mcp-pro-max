"""Automatic shading from one light, and normal maps for engine lighting.

auto_shade turns flat colour areas into shaded forms the way a pixel artist
would block them in: one light direction, a hue-shifted ramp per material
(shadows cooler, lights warmer), a core shadow on the far side, contact
shadows under overhangs, optional rim light, and no pillow shading. It is a
strong first pass to refine by hand, not a replacement for judgement: look
at it with view_quality and fix the clusters that don't read.
"""
from __future__ import annotations

import numpy as np

from .. import mcp
from . import colorsci as cs
from . import pixops as po
from . import pixio
from .common import as_json, check_file, check_out, tool_errors
from .fixers import targets


def _outline_colors(img: np.ndarray, mask: np.ndarray) -> set:
    """Colours that form the outline: almost all their pixels lie on the
    silhouette edge (black, dark or coloured/selective outlines alike)."""
    edge = po.boundary(mask, 8)
    keys = po.pack(img)
    out = set()
    for k, n in zip(*np.unique(keys[mask], return_counts=True)):
        sel = keys == k
        on_edge = (sel & edge).sum() / max(1, n)
        if on_edge >= 0.8 and cs.lightness(po.unpack(int(k))[:3]) < 0.7:
            out.add(int(k))
    return out


def _decal_hosts(keys: np.ndarray, base_keys: list[int], enclosed: float = 0.65) -> dict:
    """Map decal colours to the colour they sit on.

    A colour is a decal when most of the pixels bordering it (4-neighbours of
    other colours) are one single other colour that is at least 3x larger.
    """
    hosts = {}
    sizes = {k: int((keys == k).sum()) for k in base_keys}
    for k in base_keys:
        m = keys == k
        ring = po.dilate(m, 4) & ~m
        around = keys[ring]
        around = around[around != 0]
        if around.size == 0:
            continue
        vals, cnt = np.unique(around, return_counts=True)
        top = int(vals[np.argmax(cnt)])
        if cnt.max() / around.size >= enclosed and top in sizes and sizes[top] >= 3 * sizes[k]:
            hosts[k] = top
    for k in list(hosts):   # a decal on a decal -> the final host
        seen = {k}
        while hosts[k] in hosts and hosts[k] not in seen:
            seen.add(hosts[k])
            hosts[k] = hosts[hosts[k]]
    return hosts


def _keep_as_is(img: np.ndarray, keys: np.ndarray, k: int, min_area: int) -> bool:
    """Small details (eyes, buttons, glints) keep their colour."""
    n = int((keys == k).sum())
    return n < min_area or (n < 3 * min_area and cs.lightness(po.unpack(k)[:3]) < 0.3)


def shade_image(img: np.ndarray, light_angle=135.0, elevation=40.0, shadow_steps=2, highlight_steps=1,
                form="mixed", contrast=1.0, ambient_occlusion=True, rim=None, dither=False, clean=True,
                ramps: dict | None = None, palette: list | None = None, min_area: int = 6,
                hue_shift: float = 9.0):
    mask = po.opaque(img)
    if not mask.any():
        return img, {}
    keys = po.pack(img)
    outline_keys = _outline_colors(img, mask)
    paint = mask & ~np.isin(keys, list(outline_keys)) if outline_keys else mask.copy()
    lv = po.light_vector(light_angle, elevation)
    l2 = np.array([lv[0], lv[1]])
    l2 = l2 / (np.linalg.norm(l2) or 1)

    base_keys = [int(k) for k in np.unique(keys[paint]) if k and not _keep_as_is(img, keys, int(k), min_area)]
    paint &= np.isin(keys, base_keys)
    # Decals (spots, stripes, patches mostly enclosed by one other colour)
    # belong to their host's surface: they share its form and cast no shadow.
    all_keys = [int(k) for k in np.unique(keys[mask & ~np.isin(keys, list(outline_keys) or [0])]) if k]
    host = _decal_hosts(keys, all_keys)   # small kept details (eyes) count too: no holes in the form
    form_keys = keys.copy()
    for d, hk in host.items():
        form_keys[keys == d] = hk
    sil_mask = mask
    H_sil = po.height_map(sil_mask)
    H_reg = np.zeros(mask.shape)
    for k in set(base_keys) - set(host):
        m = form_keys == k
        if m.sum() >= min_area:
            H_reg[m] = po.height_map(m)[m]
    if form == "silhouette":
        H = H_sil
    elif form == "region":
        H = H_reg
    else:
        H = 0.6 * H_sil + 0.4 * H_reg
    N = po.normals(H, mask)
    shade = (N * lv).sum(-1) - lv[2]           # 0 on flat areas, + toward the light

    # Form-wide falloff: the side of the whole shape away from the light is darker.
    ys, xs = np.nonzero(mask)
    cx, cy = xs.mean(), ys.mean()
    radius = max(2.0, np.sqrt(mask.sum() / np.pi))
    yy, xx = np.mgrid[0:mask.shape[0], 0:mask.shape[1]]
    g = ((xx - cx) * l2[0] + (yy - cy) * l2[1]) / radius     # + on the side facing the light
    value = shade + 0.16 * np.clip(g, -1.2, 1.2)
    value *= contrast

    t_hi, t_sh, t_deep = 0.11, -0.07, -0.30
    level = np.zeros(mask.shape, np.int32)
    level[value > t_hi] = 1
    level[value > t_hi + 0.22] = 2
    level[value < t_sh] = -1
    level[value < t_deep] = -2
    level[value < t_deep - 0.25] = -3

    if dither:
        cuts = [t_deep - 0.25, t_deep, t_sh, t_hi, t_hi + 0.22]
        checker = ((xx + yy) % 2 == 0)
        for c in cuts:
            near = paint & (np.abs(value - c) < 0.035)
            up = value >= c
            # inside the band, alternate the two levels on a checkerboard
            level[near & checker & up] -= 1
            level[near & ~checker & ~up] += 1

    if ambient_occlusion:
        # A part is in contact shadow where a different, sizeable part sits
        # between it and the light (the chin over the neck, an arm over the torso).
        big = [k for k in base_keys if k not in host and (keys == k).sum() >= 3 * min_area]
        ox, oy = int(round(l2[0])), int(round(l2[1]))
        occ = np.zeros(mask.shape, bool)
        for dx, dy in {(ox, oy), (ox, 0), (0, oy)} - {(0, 0)}:
            nk = po.shift(form_keys, dx, dy, 0)
            occ |= paint & (nk != form_keys) & np.isin(nk, big)
        level[occ] -= 1

    level = np.clip(level, -shadow_steps, highlight_steps)
    if clean:
        for k in base_keys:
            m = (keys == k) & paint
            level[m] = po.majority_filter(np.where(m, level, 99), m, 1)[m]

    out = img.copy()
    used = {}
    plab = cs.rgb_to_oklab(np.array(palette, np.float64)) if palette else None
    for k in base_keys:
        m = (keys == k) & paint
        if m.sum() < min_area:
            continue
        base = po.unpack(k)[:3]
        hexb = cs.rgb_to_hex(base)
        if ramps and hexb in ramps:
            r = ramps[hexb]
            bi = r.index(base) if base in r else len(r) // 2
            ramp = {lv_: r[min(len(r) - 1, max(0, bi + lv_))] for lv_ in range(-shadow_steps, highlight_steps + 1)}
        else:
            hr = cs.hue_shift_ramp(base, shadow_steps, highlight_steps, step_l=0.1 * max(0.6, min(1.6, contrast)),
                                  hue_shift=hue_shift)
            ramp = {lv_: hr[shadow_steps + lv_] for lv_ in range(-shadow_steps, highlight_steps + 1)}
        if plab is not None:
            for lv_, c in ramp.items():
                j = int(cs.nearest_indices(cs.rgb_to_oklab(np.array([c], np.float64)), plab)[0])
                ramp[lv_] = tuple(palette[j])
        for lv_, c in ramp.items():
            sel = m & (level == lv_)
            if sel.any():
                out[sel, :3] = c
        used[hexb] = [cs.rgb_to_hex(ramp[i]) for i in sorted(ramp)]

    if rim is not None:
        edge = po.boundary(mask, 4) & paint
        facing = (N[..., 0] * l2[0] + N[..., 1] * l2[1])
        rim_px = edge & (facing < -0.35)
        out[rim_px, :3] = rim
    return out, used


@mcp.tool()
@tool_errors
async def auto_shade(filename: str, layer_name: str = "", frames: str = "", light_angle: float = 135.0,
                     shadow_steps: int = 2, highlight_steps: int = 1, contrast: float = 1.0,
                     form: str = "mixed", ambient_occlusion: bool = True, rim_light_color: str = "",
                     dither: bool = False, use_sprite_palette: bool = False,
                     ramps: dict[str, list[str]] | None = None, output_layer: str = "",
                     hue_shift: float = 9.0, checkpoint: bool = True) -> str:
    """Shade flat colours into lit forms from one light direction.

    Draw the flats first (each material one colour, optionally a dark
    outline), then run this. For each flat colour it builds a hue-shifted
    ramp (or uses yours), estimates the 3D form from the silhouette and the
    colour areas, and paints highlight, base, shadow and deep shadow
    clusters lit from `light_angle`. Outline colours are detected and left
    alone; tiny areas (eyes, buttons) are kept as they are.

    Then: view_quality to judge it, critique_sprite, and hand-fix clusters
    with draw_rows. A checkpoint is saved first so restore_checkpoint undoes
    it.

    Args:
        filename: Aseprite file
        layer_name: Image layer with the flats ("" = topmost)
        frames: "" = every frame (consistent light across an animation)
        light_angle: Where the light comes from, degrees: 90 = top, 135 = top-left
            (the classic), 45 = top-right, 180 = left
        shadow_steps: Shadow shades below the base colour, 1-3
        highlight_steps: Highlight shades above the base, 0-2
        contrast: 0.6 (soft, overcast) to 1.8 (harsh, dramatic)
        form: "mixed" (default: whole body plus each part), "silhouette" (one
            volume, best for simple shapes), "region" (each colour area rounded)
        ambient_occlusion: Contact shadow where one part overlaps another
        rim_light_color: Hex colour for a thin back-light on the shadow-side edge
        dither: Checkerboard the boundaries between shades (only for 48 px+)
        use_sprite_palette: Snap all shades to the sprite's current palette
        ramps: Your own ramps, {"#base": ["#dark", ..., "#base", ..., "#light"]}
        hue_shift: Degrees the hue turns per shade step (0 = none, 9 = subtle default,
            15+ = stylised: shadows clearly cooler, lights warmer)
        output_layer: Write the shaded result to this layer instead of in place
        checkpoint: Save a checkpoint first
    """
    from . import checkpoints
    if form not in ("mixed", "silhouette", "region"):
        return "ERROR: form must be mixed, silhouette or region"
    shadow_steps = max(1, min(3, shadow_steps))
    highlight_steps = max(0, min(2, highlight_steps))
    rim = cs.hex_to_rgb(rim_light_color) if rim_light_color else None
    if rim_light_color and rim is None:
        return f"ERROR: Invalid rim_light_color {rim_light_color}"
    parsed_ramps = None
    if ramps:
        parsed_ramps = {}
        for base, lst in ramps.items():
            b = cs.hex_to_rgb(base)
            r = cs.parse_colors(lst)
            if b is None or isinstance(r, str):
                return f"ERROR: Invalid ramp for {base}"
            parsed_ramps[cs.rgb_to_hex(b)] = r
    info, pairs = targets(filename, layer_name, frames)
    pal = None
    if use_sprite_palette:
        pal = [cs.hex_to_rgb(c) for c in info.palette if not c.endswith("00")]
        pal = [c for c in pal if c]
        if len(pal) < 3:
            return "ERROR: The sprite palette has fewer than 3 colours; set one first (generate_palette_pro apply=True)"
    cp = checkpoints.save(filename, "before auto_shade") if checkpoint else None
    imgs = pixio.read_images(filename, [("layer", l, f) for l, f in pairs])
    writes, ramps_used = [], {}
    for (l, f), img in zip(pairs, imgs):
        out, used = shade_image(img, light_angle, 40.0, shadow_steps, highlight_steps, form, contrast,
                                ambient_occlusion, rim, dither, True, parsed_ramps, pal,
                                hue_shift=max(0.0, min(30.0, hue_shift)))
        ramps_used.update(used)
        writes.append(pixio.Write(output_layer or l, f, out, create=bool(output_layer), above=l))
    pixio.write_images(filename, writes)
    return as_json({"shaded_cels": len(writes), "light_angle": light_angle, "ramps": ramps_used,
                    "checkpoint": cp["id"] if cp else None,
                    "next": "view_quality, then refine clusters with draw_rows; restore_checkpoint to undo"})


@mcp.tool()
@tool_errors
async def generate_normal_map(filename: str, output_filename: str, layer_name: str = "", frame_index: int = 1,
                              strength: float = 1.0, use_luminance: float = 0.35, convention: str = "opengl",
                              as_layer: str = "") -> str:
    """Make a normal map of a sprite for dynamic 2D lighting in a game engine.

    The form is estimated from the silhouette and colour areas, plus (with
    use_luminance) the sprite's own shading. Pixel-crisp, same size as the
    sprite, transparent where the sprite is.

    Args:
        filename: Aseprite file
        output_filename: PNG to write (e.g. hero_n.png)
        layer_name: Layer or group ("" = all visible)
        frame_index: Frame
        strength: Bumpiness, 0.3-3
        use_luminance: How much the existing shading adds detail, 0-1
        convention: "opengl" (Godot, Unity: green up) or "directx" (green down)
        as_layer: Also add it to the sprite as this (hidden) layer
    """
    check_file(filename)
    check_out(output_filename)
    img = pixio.read_composite(filename, frame_index, layer_name)
    mask = po.opaque(img)
    if not mask.any():
        return "ERROR: nothing drawn on that frame/layer"
    keys = po.pack(img)
    H = 0.6 * po.height_map(mask)
    for k in np.unique(keys[mask]):
        m = keys == k
        if m.sum() >= 4:
            H[m] += 0.4 * po.height_map(m)[m]
    if use_luminance > 0:
        L = po.lab_image(img)[..., 0]
        H = H + use_luminance * 4 * np.where(mask, L - L[mask].mean(), 0)
    H *= strength
    N = po.normals(H, mask)
    if convention != "directx":
        N[..., 1] = -N[..., 1]   # image y points down; OpenGL-style maps want green = up
    rgb = np.clip((N * 0.5 + 0.5) * 255, 0, 255).astype(np.uint8)
    out = np.zeros_like(img)
    out[..., :3] = rgb
    out[..., 3] = np.where(mask, 255, 0)
    from PIL import Image as PILImage
    PILImage.fromarray(out, "RGBA").save(output_filename)
    if as_layer:
        pixio.write_images(filename, [pixio.Write(as_layer, frame_index, out, create=True)])
        from ..core.commands import AsepriteCommand, lua_escape
        from ..core.lua import FIND_LAYER
        AsepriteCommand.execute_lua_script_checked(
            f'{FIND_LAYER}\nlocal spr=app.activeSprite\nlocal l=find_layer(spr,"{lua_escape(as_layer)}")\n'
            f'if l then l.isVisible=false end\nspr:saveAs(spr.filename)\nprint("OK")', filename)
    return f"Normal map ({convention}) written to {output_filename}" + (f" and layer '{as_layer}' (hidden)" if as_layer else "")
