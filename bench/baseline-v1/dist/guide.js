/** Sent to clients as server instructions on connect. Keep it short. */
export const INSTRUCTIONS = `Aseprite MCP Pro Max (unofficial) edits real .aseprite files through Aseprite.

Conventions: pixel coordinates from the top-left (0,0); frames are 1-based; colors are "#rrggbb", "#rrggbbaa", "transparent" or palette indices; layers are addressed by name or "Group/Child" path.

Workflow that works well:
1. aseprite_create with size, palette preset and tagged animations (e.g. idle 4f, walk 6f).
2. Draw with aseprite_edit using pixel_map ops (character grids + legend) — several ops per call; set preview: true to see the result.
3. Look before you continue: aseprite_preview (use tag + onion for animation), aseprite_read_pixels to read exact pixels back as a grid.
4. aseprite_validate to catch off-palette colors, stray pixels, semi-transparency and feet sliding (baseline jitter).
5. aseprite_export (preset: godot | roblox | unity | phaser) for game-ready sheets.
Every file edit is checkpointed: aseprite_history undo/redo/restore. With the editor extension installed, pass live: true to work in the open Aseprite window.

Pixel-art basics: pick the canvas size first (16x16, 32x32, 48x48 are common) and keep a small palette (4-16 colors); read the guide prompt for more.`;
export const PIXEL_ART_GUIDE = `# Pixel art guide for AI-assisted sprite work

## Canvas and proportions
- Pick a resolution and stick to it: 16x16 (items, tiny characters), 32x32 (standard characters), 48x48/64x64 (detailed characters, bosses).
- Leave 1-2 px of empty margin so outlines and animation squash/stretch fit.
- Chibi characters: head ≈ 1/2 to 1/3 of the body height. Realistic: head ≈ 1/6-1/8.
- Plant the feet on a consistent baseline row across all frames.

## Palette
- Start from a preset (pico-8, sweetie-16, endesga-32, db32, slso8, gameboy) or 3-5 ramps of 3-5 colors each.
- Shade with hue shifting: shadows cooler and more saturated, highlights warmer and lighter (aseprite_palette action=ramp).
- Avoid pure black outlines on everything; a dark, saturated version of the fill color reads better ("selective outline").
- Keep alpha binary (fully opaque or fully transparent) unless you need glass/glow.

## Drawing
- Block in the silhouette first in one flat color; check it reads at 1x.
- Then base colors, then shadows (one light direction, usually top-left), then highlights, then outline cleanup.
- Avoid "jaggies": lines should step in consistent runs (1-1-1, 2-2-2, 1-2-1-2), not 1-3-1.
- Avoid "pillow shading" (shading inward from every edge) and banding (parallel stair-steps of different colors).
- Remove stray single pixels and "doubles" (2px-thick outline corners) unless intentional.

## Animation
- Idle: 2-4 frames, 150-250 ms, subtle 1px bob of the head/body.
- Walk: 4-8 frames (contact, down, passing, up), 80-120 ms; the body bobs 1 px on the down/up poses.
- Run: 6-8 frames, 60-90 ms, more lean and bigger stride.
- Attack: anticipation (slow, 100-150 ms) → action (fast, 40-60 ms) → recovery (100 ms).
- Keep volume consistent between frames; use onion-skin previews (aseprite_preview onion: true) to check.
- Use tags for every animation; exporters turn tags into named animations.

## Using this server efficiently
- Draw with pixel_map: rows of characters + legend. Use '.' for "leave unchanged".
- Batch many ops into one aseprite_edit call; it is atomic and checkpointed.
- After drawing, always preview; for precise fixes, aseprite_read_pixels a small region, edit the grid, write it back.
- Put separate parts (outline, body, details, effects) on separate layers so they are easy to fix.
`;
//# sourceMappingURL=guide.js.map