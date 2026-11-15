"""The Pro Max art direction guide: how good pixel art is made, step by step,
mapped onto the tools that do each step."""
from __future__ import annotations

from .. import mcp

LOOP = """THE PRO MAX LOOP (every piece, every pass)
1. save_checkpoint(label) before any big step.
2. Do the step.
3. view_quality - look at it at 1x/2x (what players see), silhouette and values.
4. critique_sprite - fix every "high" issue, then the "medium" ones.
5. compare_versions against the checkpoint: better? keep. Worse? restore_checkpoint.
6. polish_sprite at the end of each stage (merge near-duplicate colours, pixel-perfect lines, strays).
Aim for score >= 90 (grade A) before calling a sprite done."""

TOPICS = {
    "workflow": """END-TO-END WORKFLOW
1. Brief: size (16/24/32/48/64 px characters; 128+ for scenes), view (side, 3/4 top-down, iso), light
   direction (default top-left, light_angle=135), mood.
2. Palette: generate_palette_pro(base_colors=[one per material] or mood=..., steps=3-4 small / 5-6 large,
   apply_to=file). 8-16 colours for a 32 px sprite. analyze_palette to check it.
3. Silhouette: one dark flat colour, big shapes first. view_quality -> the silhouette panel must read
   (pose, weapon, head) with no detail at all. Exaggerate: big head/hands at small sizes.
4. Flats: one base colour per material, drawn with draw_rows / shapes. No shading yet.
5. Outline: outline_pro(style="selective") on the character layer (or "fixed" near-black for 16 px).
6. Shade: auto_shade(light_angle=135) as a first pass -> view_quality -> refine clusters by hand with
   draw_rows. Clusters should be readable shapes, not noise; no pillow shading.
7. Details last: eyes, highlights (1-2 px glints, protected from cleanup), small accents in a saturated colour.
8. Clean: polish_sprite(protect="eye glint coords"), cleanup_lines on outlines, anti_alias_edges only at 48 px+.
9. Animate (see topic "animation"), then critique_animation.
10. Ship: export_showcase for presentation, export_spritesheet_pro / export_upscaled for use.""",
    "character": """CHARACTERS
- Readability beats detail. At 32 px a face is 2 eyes + maybe a mouth; hands are 2-3 px blobs.
- Proportions: chibi 2-3 heads tall at 16-32 px; 4-5 heads at 48-64 px.
- Contrast hierarchy: the face and the weapon/item get the highest contrast; clothes less; background least.
- Separate materials by VALUE, not just hue (view_quality 'values' panel must still separate them).
- Leave 1-2 px margin around the sprite (room for outline and animation).
- Draw each body part on its own layer (head, torso, arm_front, arm_back, legs, weapon, hair): animation,
  secondary_motion and smears all work per layer.""",
    "shading": """SHADING
- One light direction for the whole piece and every frame (auto_shade frames="" keeps it consistent).
- Hue-shift: shadows cooler (toward blue/violet), lights warmer (toward yellow) - color_ramp_pro does it.
- 2-3 shadow steps, 1-2 highlight steps per material at 32 px. More steps = more noise, not more quality.
- Core shadow on the far side, cast/contact shadow under overhangs (chin, arms, hat brim).
- NO pillow shading (dark ring around a light centre). critique_sprite flags it.
- Highlights: few, small, on the surfaces facing the light; specular glints on metal and eyes only.
- Rim light (auto_shade rim_light_color) separates a dark character from a dark background.
- Dither only on 48 px+ and large smooth surfaces (sky, big metal); never on small sprites.""",
    "lines": """LINES & OUTLINES
- Pixel-perfect: no L-shaped doubles on 1 px lines (cleanup_lines).
- Curves step gradually: 1-1-2-3-4 or 4-3-2-1-1, never 1-3-1 (critique 'jaggies').
- Straight diagonals use equal runs: 1:1, 2:1, 3:1 - not 2-1-2-3.
- Outline darker than everything it touches. Selective outlines: lighter on the lit side, darkest
  on the shadow side and at the ground contact.
- Anti-aliasing: hand-placed in-between pixels at the corners of long steps (anti_alias_edges),
  only between colours inside the sprite unless you know the final background.""",
    "color": """COLOUR & PALETTE
- 8 colours at 16 px, 16 at 32 px, 24-32 at 64 px, 32-48 for scenes.
- Every colour must earn its place: merge_similar_colors removes ones you can't tell apart.
- Saturation is an accent: keep big areas muted, put full saturation on the focal point.
- Ramps share their darkest colour (generate_palette_pro shared_extremes) -> cohesion.
- Black is rarely pure #000; use a deep blue/violet near-black. Same for white.
- Reference art or a mood board? palette_from_image extracts a palette from it.""",
    "animation": """ANIMATION
- Plan key poses first (contact, down, passing, up for walks; anticipation -> action -> follow-through for attacks).
- Redraw poses; never move the whole sprite as the main motion.
- Spacing: ease in and out - small steps near key poses, large in the middle. critique_animation flags
  mechanical even spacing.
- Timing: holds 150-250 ms, normal 80-120 ms, fast/smear 40-70 ms. Vary it.
- squash_stretch for soft bodies and impacts; add_smear for fast swings; hit_flash for damage;
  generate_particles for dust/sparks/burst; secondary_motion for hair/capes/tails.
- No pixel boil: unchanged parts must stay pixel-identical between frames.
- Same palette in every frame (quantize_pro use_sprite_palette=True); critique_animation flags flicker.
- Loops close: the last frame leads into the first.""",
    "environment": """ENVIRONMENTS & TILES
- Value layers: background lightest/least saturated, playfield mid, foreground darkest/most contrast.
- Characters must pop: keep backgrounds lower contrast than sprites.
- Tiles: design on the grid (16 or 32), check with view_tiled; fix seams with offset_wrap(half, half),
  paint over the centre, offset back.
- Avoid obvious repetition: 2-3 variants of each tile, break lines with props.
- Textures: clusters of 2-4 px, not single-pixel noise.""",
    "conversion": """CONVERTING IMAGES / AI ART
- image_to_pixel_art detects the true grid of upscaled/AI 'pixel art' and rebuilds it 1 px per cell,
  or scales a painting/photo down with median sampling, then reduces colours perceptually.
- Treat the result as a sketch: critique_sprite, then fix silhouette, outline and clusters by hand.
- Use a preset/palette for consistency with the rest of your art.""",
}


@mcp.tool()
async def pro_art_guide(topic: str = "workflow") -> str:
    """The Pro Max art-direction guide: the craft rules for high-quality pixel
    art and which tool does each step. Read "workflow" before starting a piece.

    Topics: workflow, character, shading, lines, color, animation,
    environment, conversion, all.
    """
    topic = (topic or "workflow").strip().lower()
    if topic == "all":
        return LOOP + "\n\n" + "\n\n".join(TOPICS.values())
    if topic not in TOPICS:
        return f"Unknown topic '{topic}'. Topics: {', '.join(TOPICS)}, all"
    return LOOP + "\n\n" + TOPICS[topic]
