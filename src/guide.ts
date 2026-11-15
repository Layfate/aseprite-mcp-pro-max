/** Sent to clients as server instructions on connect. Kept short: it costs tokens every session. */
export const INSTRUCTIONS = `Aseprite MCP Pro Max (unofficial) edits real .aseprite files through Aseprite. 200+ operations live in a catalog: find them with search_ops, get schemas with describe_ops, run with run_op (one op) or batch (many edit ops, atomic). Every result carries the document version; pass it back as expectVersion to reject stale edits. Pixels from top-left (0,0); frames 1-based; colors "#rrggbb[aa]", "transparent" or palette index. Workflow: aseprite://workflow.`;

export const WORKFLOW_GUIDE = `# Production workflow: brief -> construct -> inspect -> validate -> refine

1. **Brief (once).** doc.create, then brief.set with size, palette (or maxColors), perspective, outline, light
   direction, proportions, transparency, states, directions, pivot and engine. check.brief tests the
   document against it later. Set the pivot with xf.set_pivot (anchor "feet" for characters).
2. **Construct.** Draw with draw.pixel_map / draw.index_map in one batch (several ops per call).
   Use draw.patch for small fixes, pattern.save + pattern.stamp for repeated details, sel.* to limit edits
   (inSelection: true), anim.scaffold for states x directions, frame.duplicate / cel.copy to start each pose
   from the key frame (keeps identity, scale and palette), anim.mirror_direction for left/right sets,
   anim.inbetween for reviewable in-betweens (accept or revert them).
3. **Inspect.** preview (tag + onion), view.contact_sheet, view.silhouette, view.values, view.tile_repeat,
   view.gif for playback. pixels.read returns exact pixels in pixel_map format for precise edits.
   Results are cached per document version; reading again after no change is free.
4. **Validate (objective).** check.brief, check.lint, check.palette, check.clipping, check.timing,
   check.jitter, check.pivot_drift, check.identity, check.outline, tile.check_seams, anim.loop_check.
   These measure facts; they do not grade art.
5. **Refine (subjective).** review.rubric lists what to judge by eye; record findings with review.note.
   Fix, re-run checks, repeat. checkpoint/restore/changes keep every step reversible.

Exports: engine.* (search_ops "godot", "unity", ...) then engine.validate. Re-exports skip unchanged sources.
Defaults are crisp: nearest-neighbour scaling, binary alpha, no smoothing unless you ask (doc.scale method,
sel.fill soft, draw.gradient dither).`;

export const PIXEL_ART_GUIDE = `# Pixel art guide for AI-assisted sprite work

## Canvas and proportions
- Pick a resolution and stick to it: 16x16 (items, tiny characters), 32x32 (standard characters), 48x48/64x64 (detailed characters, bosses).
- Leave 1-2 px of empty margin so outlines and animation squash/stretch fit.
- Chibi characters: head about 1/2 to 1/3 of the body height. Realistic: head about 1/6-1/8.
- Plant the feet on a consistent baseline row across all frames (check.jitter, clean.stabilize).

## Palette
- Start from a preset (pico-8, sweetie-16, endesga-32, db32, slso8, gameboy) or 3-5 ramps of 3-5 colors (pal.build).
- Shade with hue shifting: shadows cooler and more saturated, highlights warmer and lighter (pal.ramp).
- Avoid pure black outlines on everything; a dark, saturated version of the fill reads better ("selective outline").
- Keep alpha binary unless you need glass/glow (clean.alpha).

## Drawing
- Block in the silhouette first in one flat color; check it reads at 1x (view.silhouette).
- Then base colors, shadows (one light direction, see draw.rim_light), highlights, outline cleanup.
- Lines should step in consistent runs (1-1-1, 2-2-2, 1-2-1-2), not 1-3-1; clean.pixel_perfect removes doubles.
- Avoid pillow shading and banding; remove stray pixels (clean.stray_pixels).

## Animation
- Idle: 2-4 frames, 150-250 ms, subtle 1px bob (anim.offset_sequence).
- Walk: 4-8 frames, 80-120 ms; body bobs 1 px on down/up poses.
- Attack: anticipation (100-150 ms) -> action (40-60 ms) -> recovery (100 ms) (frame.set_duration durations).
- Keep volume consistent (check.identity); use onion previews; tag every animation.

## Tiles
- Use a tilemap layer (tile.create_layer); check tile.check_seams and view.tile_repeat; offset with tile.offset_wrap to paint out seams.
- Autotile with tile.terrain_set + tile.autotile; store collision with tile.collision_set for engine exports.
`;
