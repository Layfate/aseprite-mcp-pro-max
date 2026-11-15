---
name: shade
description: Add light and shadow to flat pixel art with hue-shifted ramps, one step at a time, from one fixed light direction, so the sprite gains form without pillow shading or the brightness-slider look of generated art. Uses draw.shade, pal.ramp and selections, verified with view values and check.craft. Use when flat art needs volume or "it looks flat".
---

# Shade

Two tells give generated pixel art away fastest: **pillow shading** (dark rim,
light centre, rings that follow the outline) and **brightness-only ramps**
(shadow = same hue, darker). `check.craft` measures both (C7, C3).

## The rules
- **One light direction**, stated up front (brief `light`, default top-left). It
  never moves: not across the sprite, not across frames.
- **Shadows** rotate toward blue/violet and lose a little saturation;
  **highlights** rotate toward yellow/orange. `draw.shade` does exactly this,
  using only palette colours. Use it instead of picking darker hex values.
- **Shade the form, not the outline.** A shadow follows the object's cross
  section (a crescent on the far side of a ball, the underside of an arm), not a
  ring inside the silhouette. Compare the templates `tells-sphere-pillow` and
  `tells-sphere-lit` (`kb.template`).

## Procedure
1. **Confirm the flat art is right.** `preview`. Shading a bad silhouette is wasted.
2. **Make sure ramps exist.** For each material: `pal.ramp {base, steps: 4-5}`
   then `pal.add_colors` the steps you lack. Reuse the darkest step across
   materials: it ties the sprite together and saves slots.
3. **One shadow step.** Select the side away from the light per form
   (`sel.ellipse`, `sel.polygon`, `sel.alpha` then `sel.ellipse {mode: "subtract"}`
   offset toward the light for a crescent...) and
   `draw.shade {layer, steps: -1, inSelection: true}`. For a shape selections
   cannot describe, draw it with `draw.pixel_map` from the ramp.
4. **Look.** `preview {view: "values", args: {steps: 4}}`. Does it read as
   volume or as a stain? Then `check.craft`: C7 (pillow) and C6 (light vs brief)
   must not appear; `subject.light.estimated` should match the brief.
5. **One light step** on the side facing the light: `draw.shade {steps: 1, ...}`.
6. **Look again.** Most sprites are finished here.
7. Only if it needs it: a deeper shadow in occluded crevices (`steps: -2`), a 1-2
   px specular on the hardest material, a faint cool reflected light on the
   shadow side's outer edge (metal). `draw.rim_light` can place edge light from a
   direction.

## Dithering
Only on 32 px+, only in large areas, only between adjacent ramp steps
(`draw.dither_fill`, `draw.gradient`), only in short 1-3 px transitions. Dither
as a field or random noise is a tell (X2). Never on a 16x16 character.

## Checks
- Light in exactly one place? (`check.craft` C6, `subject.light`)
- Shadows hue-shift? (C3)
- No rings following the outline? (C7)
- No long parallel stripes of adjacent steps? (X3: stagger band ends)
- Values: lit side among the lightest, core shadow among the darkest? (V1, view "values")

## Related
rules://02-shading-and-light, rules://20-color-for-pixel-art,
rules://22-materials-hard, rules://23-materials-soft, rules://24-lighting-scenarios,
rules://72-3d-forms, rules://13-dithering-and-texture.
