"""End-to-end tests for the Pro Max tools (aseprite_mcp/pro), run against a real Aseprite."""
import io
import json
import os

import numpy as np
import pytest
from PIL import Image as PILImage

from conftest import BASE, ok, run

from aseprite_mcp.tools import animation, canvas, drawing
from aseprite_mcp.pro import (anim, checkpoints, colorsci as cs, convert, critique, exports, fixers, guide,
                              palettes, pixio, pixops as po, shading)


def js(result):
    ok(result)
    return json.loads(result)


def img_of(result):
    text, im = result
    return text, PILImage.open(io.BytesIO(im.data))


@pytest.fixture(scope="module")
def blob():
    """A 40x40 sprite: green body, skin head, two dark eyes, on layer 'body'."""
    path = f"{BASE}/pro_blob.aseprite"
    ok(run(canvas.create_canvas(40, 40, path)))
    ok(run(canvas.add_layer(path, "body")))
    ok(run(drawing.draw_ellipse_at(path, "body", 1, 20, 26, 14, 10, "#5FAF3F", True)))
    ok(run(drawing.draw_circle_at(path, "body", 1, 20, 12, 7, "#E0A070", True)))
    ok(run(drawing.draw_rectangle_at(path, "body", 1, 17, 11, 2, 2, "#202020", True)))
    ok(run(drawing.draw_rectangle_at(path, "body", 1, 22, 11, 2, 2, "#202020", True)))
    return path


# --- pure helpers -------------------------------------------------------------------

def test_oklab_round_trip():
    rgb = np.array([[208, 70, 72], [0, 0, 0], [255, 255, 255], [12, 200, 90]], float)
    back = cs.oklab_to_rgb(cs.rgb_to_oklab(rgb))
    assert np.abs(back - rgb).max() < 0.6


def test_ramp_is_ordered_and_hue_shifted():
    ramp = cs.hue_shift_ramp((208, 70, 72), 2, 2)
    Ls = [cs.lightness(c) for c in ramp]
    assert Ls == sorted(Ls)
    assert ramp[2] == (208, 70, 72)
    hues = cs.oklab_to_oklch(cs.rgb_to_oklab(np.array(ramp, float)))[:, 2]
    assert cs.angle_diff(hues[0], hues[-1]) > 10


def test_doubles_removed_corners_kept():
    img = np.zeros((6, 10, 4), np.uint8)
    for x, y in [(0, 0), (1, 0), (1, 1), (2, 1), (3, 1), (3, 2), (4, 2), (5, 2)]:
        img[y, x] = (0, 0, 0, 255)
    out, removed = po.clean_doubles(img)
    assert len(removed) == 2 and not po.find_doubles(out)
    box = np.zeros((8, 8, 4), np.uint8)
    box[1, 1:6] = box[5, 1:6] = box[1:6, 1] = box[1:6, 5] = (0, 0, 0, 255)
    assert po.find_doubles(box) == []


def test_jaggies_detects_1_3_1():
    m = np.zeros((12, 12), bool)
    for x, t in enumerate([2, 3, 3, 3, 4, 5, 6, 6, 6, 7]):
        m[t:, x] = True
    m2 = np.zeros((12, 12), bool)
    for x, t in enumerate([2, 3, 4, 4, 4, 5, 6, 7, 8, 9]):   # 1-1-3-1-1: a jaggy at x=2..4
        m2[t:, x] = True
    assert po.find_jaggies(m2)
    smooth = np.zeros((12, 12), bool)
    for x, t in enumerate([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]):
        smooth[t:, x] = True
    assert po.find_jaggies(smooth) == []


def test_scalers_keep_colours():
    img = np.zeros((5, 5, 4), np.uint8)
    img[1:4, 2] = (200, 30, 30, 255)
    img[2, 1:4] = (200, 30, 30, 255)
    for big in (po.scale2x(img), po.scale3x(img), po.rotsprite(img, 30)):
        assert {c for c, _ in po.colors_used(big)} == {(200, 30, 30, 255)}


def test_grid_detection():
    rng = np.random.default_rng(3)
    small = rng.integers(0, 255, (12, 10, 4)).astype(np.uint8)
    small[..., 3] = 255
    big = po.scale_nearest(small, 7)
    cell, ox, oy, conf = convert.detect_grid(big)
    assert cell == 7


# --- pixel I/O ------------------------------------------------------------------------

def test_pixio_round_trip(blob):
    info = pixio.sprite_info(blob)
    assert (info.width, info.height, info.frames) == (40, 40, 1)
    layer, comp = pixio.read_images(blob, [("layer", "body", 1), ("composite", "", 1)])
    assert tuple(layer[12, 20]) == (0xE0, 0xA0, 0x70, 255)
    assert np.array_equal(layer, comp)
    probe = f"{BASE}/pro_io.aseprite"
    ok(run(canvas.create_canvas(16, 16, probe)))
    img = np.zeros((16, 16, 4), np.uint8)
    img[3:6, 4:9] = (10, 20, 30, 255)
    pixio.write_images(probe, [pixio.Write("grp_new", 3, img)])
    info = pixio.sprite_info(probe)
    assert info.frames == 3 and info.has_layer("grp_new")
    assert np.array_equal(pixio.read_layer(probe, "grp_new", 3), img)


# --- critique & views ----------------------------------------------------------------------

def test_critique_flat_sprite_flags_basics(blob):
    r = js(run(critique.critique_sprite(blob)))
    kinds = {i["kind"] for i in r["issues"]}
    assert {"no_shading", "weak_outline"} <= kinds
    assert 0 <= r["score"] < 90


def test_view_quality_and_tiled(blob):
    text, im = img_of(ok(run(critique.view_quality(blob))))
    assert "score" in text and im.width > 300
    text, im = img_of(ok(run(critique.view_tiled(blob, tiles=2))))
    assert "verdict" in text


# --- checkpoints ---------------------------------------------------------------------------

def test_checkpoints(blob):
    c = js(run(checkpoints.save_checkpoint(blob, "flats")))
    assert c["id"] >= 1 and os.path.exists(c["path"])
    lst = js(run(checkpoints.list_checkpoints(blob)))
    assert lst["checkpoints"][-1]["label"] == "flats"


# --- the quality pipeline on the blob -------------------------------------------------------

def test_outline_shade_polish_improve_score(blob):
    before = js(run(critique.critique_sprite(blob)))["score"]
    r = js(run(fixers.outline_pro(blob, "body", style="selective")))
    assert r["outline_pixels"] > 50
    s = js(run(shading.auto_shade(blob, "body", light_angle=135)))
    assert s["shaded_cels"] == 1 and len(s["ramps"]) >= 2
    p = js(run(fixers.polish_sprite(blob, protect="")))
    after = js(run(critique.critique_sprite(blob)))
    assert after["score"] > before + 15, (before, after)
    kinds = {i["kind"] for i in after["issues"]}
    assert "pillow_shading" not in kinds and "no_shading" not in kinds
    light = after["stats"]["light"]
    assert light["from"] in ("top-left", "top", "left")


def test_compare_and_restore(blob):
    text, im = img_of(ok(run(checkpoints.compare_versions(blob, "flats"))))
    assert "changed" in text
    r = js(run(checkpoints.restore_checkpoint(blob, "flats")))
    assert r["current_saved_as"]
    # back to flats: no shading again
    kinds = {i["kind"] for i in js(run(critique.critique_sprite(blob)))["issues"]}
    assert "no_shading" in kinds
    ok(run(checkpoints.restore_checkpoint(blob, str(r["current_saved_as"]), keep_current=False)))


def test_fixers_individually():
    path = f"{BASE}/pro_fix.aseprite"
    ok(run(canvas.create_canvas(24, 24, path)))
    ok(run(drawing.draw_line_at(path, "Layer 1", 1, 2, 2, 20, 12, "#101018", 1)))
    ok(run(drawing.draw_pixels_at(path, "Layer 1", 1, [{"x": 5, "y": 18, "color": "#FF00FF"}])))
    ok(run(drawing.draw_rectangle_at(path, "Layer 1", 1, 10, 16, 6, 4, "#808080", True)))
    ok(run(drawing.draw_pixels_at(path, "Layer 1", 1, [{"x": 12, "y": 17, "color": "#818181"}])))
    dry = js(run(fixers.remove_stray_pixels(path, dry_run=True)))
    assert dry["fixed_pixels"] >= 1 and dry["dry_run"]
    m = js(run(fixers.merge_similar_colors(path)))
    assert m["colors_after"] < m["colors_before"]
    js(run(fixers.cleanup_lines(path)))
    js(run(fixers.anti_alias_edges(path, background="#000000")))
    out = js(run(fixers.remove_stray_pixels(path, protect="")))
    img = pixio.read_layer(path, "Layer 1", 1)
    assert img[18, 5, 3] == 0, "lone magenta pixel must be gone"


# --- palettes ----------------------------------------------------------------------------------

def test_palette_tools(blob):
    t, im = ok(run(palettes.color_ramp_pro("#3C78C8", 3, 2)))
    assert len(json.loads(t)["ramp"]) == 6
    t, im = ok(run(palettes.generate_palette_pro(mood="forest", steps=4, neutrals=3, apply_to=blob)))
    d = json.loads(t)
    assert d["count"] >= 15 and len(d["ramps"]) == 6
    info = pixio.sprite_info(blob)
    assert len(info.palette) == d["count"] + 1
    a = js(run(palettes.analyze_palette(colors=["#808080", "#818181", "#FF0000", "#FFFFFF"])))
    assert a["near_duplicates"]
    q = js(run(palettes.quantize_pro(blob, preset="pico8", layer_name="body", dither="bayer4")))
    assert q["cels_changed"] == 1
    used = {cs.rgb_to_hex(c[:3]) for c, _ in po.colors_used(pixio.read_layer(blob, "body", 1))}
    from aseprite_mcp.tools.palette import PALETTE_PRESETS
    assert used <= set(PALETTE_PRESETS["pico8"])


def test_palette_from_image():
    p = f"{BASE}/pro_ref.png"
    arr = np.zeros((20, 20, 4), np.uint8)
    arr[:, :10] = (200, 40, 40, 255)
    arr[:, 10:] = (40, 40, 200, 255)
    PILImage.fromarray(arr).save(p)
    t, im = ok(run(palettes.palette_from_image(p, colors=2)))
    assert len(json.loads(t)["colors"]) == 2


# --- conversion ---------------------------------------------------------------------------------

def test_image_to_pixel_art_detects_grid():
    rng = np.random.default_rng(5)
    small = np.zeros((16, 16, 4), np.uint8)
    small[3:13, 4:12] = (60, 160, 70, 255)
    small[5:8, 6:10] = (230, 200, 120, 255)
    big = po.scale_nearest(small, 6).astype(np.int16)
    big[..., :3] += rng.integers(-6, 7, big[..., :3].shape)   # AI-style noise
    big = np.clip(big, 0, 255).astype(np.uint8)
    bg = np.zeros_like(big)
    bg[...] = (240, 240, 250, 255)
    m = big[..., 3] > 0
    bg[m] = big[m]
    src = f"{BASE}/pro_ai.png"
    PILImage.fromarray(bg).save(src)
    out = f"{BASE}/pro_ai.aseprite"
    text, im = img_of(ok(run(convert.image_to_pixel_art(src, out, colors=4))))
    assert "6px pixel grid" in text
    info = pixio.sprite_info(out)
    assert (info.width, info.height) == (16, 16)
    art = pixio.read_layer(out, "art", 1)
    assert art[0, 0, 3] == 0, "background must be removed"
    assert len(po.colors_used(art)) <= 4


def test_rotsprite_and_offset(blob):
    path = f"{BASE}/pro_rot.aseprite"
    ok(run(canvas.create_canvas(32, 32, path)))
    ok(run(drawing.draw_rectangle_at(path, "Layer 1", 1, 14, 4, 4, 24, "#C0C0D0", True)))
    js(run(convert.rotsprite_rotate(path, 45)))
    img = pixio.read_layer(path, "Layer 1", 1)
    b = po.bbox(po.opaque(img))
    assert b[2] - b[0] > 12, "a vertical bar rotated 45 degrees gets wide"
    js(run(convert.offset_wrap(path, 16, 16)))


# --- animation ------------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def ball():
    path = f"{BASE}/pro_ball.aseprite"
    ok(run(canvas.create_canvas(48, 48, path)))
    ok(run(canvas.add_layer(path, "ball")))
    ok(run(drawing.draw_circle_at(path, "ball", 1, 24, 34, 8, "#E05050", True)))
    return path


def test_squash_stretch(ball):
    r = js(run(anim.squash_stretch(ball, "ball", 1, [-0.3, 0.4, 0.0])))
    assert r["frames_written"] == [2, 4]
    s, t = pixio.read_images(ball, [("layer", "ball", 2), ("layer", "ball", 3)])
    bs, bt = po.bbox(po.opaque(s)), po.bbox(po.opaque(t))
    assert (bs[3] - bs[1]) < (bt[3] - bt[1]), "squash must be shorter than stretch"
    assert bs[3] == bt[3], "bottom anchor keeps the ground line"


def test_smear_flash_particles_secondary(ball):
    ok(run(drawing.draw_circle_at(ball, "ball", 4, 24, 34, 1, "#E05050", True)))
    img = pixio.read_layer(ball, "ball", 3)
    pixio.write_images(ball, [pixio.Write("ball", 4, po.translate(img, 14, -10))])
    js(run(anim.add_smear(ball, "ball", 3, 4)))
    js(run(anim.hit_flash(ball, "ball", "2")))
    flashed = pixio.read_layer(ball, "ball", 2)
    assert {c[:3] for c, _ in po.colors_used(flashed)} == {(255, 255, 255)}
    js(run(anim.generate_particles(ball, "dust", 24, 42, start_frame=1, frames=4)))
    assert pixio.sprite_info(ball).has_layer("fx")
    js(run(anim.generate_particles(ball, "sparkle", 24, 20, start_frame=1, frames=4, layer_name="shine")))
    ok(run(canvas.add_layer(ball, "tail")))
    for f in range(1, 5):
        ok(run(drawing.draw_rectangle_at(ball, "tail", f, 10, 30, 4, 2, "#303030", True)))
    js(run(anim.secondary_motion(ball, "tail", "ball")))


def test_critique_animation(ball):
    t, im = img_of(ok(run(anim.critique_animation(ball, layer_name="ball"))))
    d = json.loads(t)
    assert "issues" in d and len(d["path"]) == 4


# --- export ------------------------------------------------------------------------------------------

def test_exports(ball):
    gif = f"{BASE}/pro_ball.gif"
    ok(run(exports.export_upscaled(ball, gif, scale=4)))
    with PILImage.open(gif) as g:
        assert g.n_frames == 4 and g.size == (192, 192)
    png = f"{BASE}/pro_ball_2x.png"
    ok(run(exports.export_upscaled(ball, png, scale=4, method="scale2x", frames="1")))
    assert PILImage.open(png).size == (192, 192)
    text, im = img_of(ok(run(exports.export_showcase(ball, f"{BASE}/pro_show.png", title="Ball"))))
    assert os.path.exists(f"{BASE}/pro_show.png")
    ok(run(animation.set_tag(ball, "bounce", 1, 4)))
    r = js(run(exports.export_spritesheet_pro(ball, f"{BASE}/pro_sheet.png", padding=2, extrude=1, trim=True)))
    meta = json.load(open(r["json"]))
    assert len(meta["frames"]) == 4 and meta["tags"][0]["name"] == "bounce"


def test_normal_map(blob):
    out = f"{BASE}/pro_blob_n.png"
    ok(run(shading.generate_normal_map(blob, out)))
    n = np.array(PILImage.open(out))
    assert n[26, 20, 3] == 255 and n[0, 0, 3] == 0
    # left edge normal points left (red < 128), right edge points right
    assert n[26, 8, 0] < 110 and n[26, 32, 0] > 145


def test_guide():
    assert "PRO MAX LOOP" in run(guide.pro_art_guide("shading"))
    assert "Unknown topic" in run(guide.pro_art_guide("nope"))
