---
name: concept
description: Design it first. Before drawing anything new, write an art spec (silhouette, landmarks, palette roles, poses, must-nots) and an image-model prompt for a concept sheet or storyboard, and offer the user the choice to generate references or continue without. When reference art arrives, read it into a PixelSpec and import it as a reference layer to draw OVER, never to pixelize. Use after the brief for anything drawn from scratch and whenever the user supplies reference art; skip it for edits.
---

# Concept: design before pixels

Division of labour: an image model (or the user) owns the **design**, the look
and the key poses; you own the **pixel interpretation**: reading that design
into a canvas, palette and shapes, and drawing it with pixel-art rules.

The reference is a guide for proportion, pose and colour masses. **It is never
the final pixels.** Downscaling a concept onto the canvas gives mixels,
hundreds of colours and mush that no cleanup fixes (rules://92-generated-art-tells
G1-G3, D1-D4).

| Input | Mode | Start at |
|---|---|---|
| Words only | creative | step 1 |
| An image (concept, sketch, screenshot, sheet) | reference | step 5 |
| Edits to existing art | neither: `skill://fix` | |

## Procedure

1. **Start from the brief** (`skill://brief`): size, palette, view, light,
   outline are fixed. Palette hex values: `pal.preset_get {name}`.

2. **Write the art spec**, short working notes:
   - subject, personality, scenario; for animation, what happens first to last frame
   - target: canvas, subject height in px, view and facing, light, outline style
   - silhouette: head-to-body ratio and the 2-3 shapes that must read at 1x
     (rules://03-silhouette-and-form, rules://30-proportions-by-size)
   - palette with roles: outline, skin ramp, cloth ramp, metal ramp, one accent.
     Its size is the ceiling.
   - animation: cycle, frame count, one line per key pose, timing in ms
   - must-nots: text, background scenery, off-brief props, camera changes

3. **Build the prompt** (English, every placeholder filled). Layout must be
   sliceable: equal panels in one row, same scale and ground line, flat
   background, no text.
   - *Concept sheet:* "pixel art, {H} px tall sprite, hard edges, no
     anti-aliasing, no gradients, limited palette {hex list}, front / side / back
     views on one ground line, flat {bg} background, no text".
   - *Storyboard:* one panel per key pose, left to right, identical size and
     ground line, locked camera, no motion lines or numbers.

4. **Offer the choice once**, in the brief's message: the prompt in one fenced
   code block, then
   1. *I'll generate references* — the user runs the prompt and sends back a
      file path. Stop and wait; do not draw meanwhile.
   2. *Continue without references* — draw from the spec, which still binds.

   If an image provider is configured (`capabilities` -> providers.image), offer
   `ref.generate` as a third option, never as a silent default.

5. **Read the reference into a PixelSpec** before placing a pixel:
   `ref.analyze {file}` (size, colours, likely pixel scale), then write:
   - `canvas`, `view`, `source` (path, panel count, panel size)
   - `silhouette`: bounding boxes `[x0,y0,x1,y1]` in **target** pixels
   - `landmarks`: eye line, waist, feet y
   - `palette`: map the reference's colour masses (`ref.extract_palette
     {file, colors: 12}`) onto the sprite palette. Do not adopt sampled colours.
   - `frames`: one line per key pose
   - `deviations`: what you deliberately drop or simplify at this size

6. **Import as a layer to draw over.** After `doc.create`:
   - one panel: `ref.crop` it out, then `ref.add_layer {image, width, height,
     opacity: 80}` (locked, faded, excluded from exports and from `check.craft`)
   - a storyboard: one `ref.crop` + `ref.add_layer {frame: i}` per panel after
     creating the frames
   - `preview` frame 1 to confirm placement before drawing.

7. **Hand over to `skill://draw`** (or `skill://animate`). The review loop at each
   stage: hide the reference (`layer.set {layer:"reference", visible:false}`),
   `preview`, show it, `preview` again; `ref.compare {file, frame}` gives
   silhouette IoU. Name the 3-5 largest mismatches (silhouette, proportion, pose,
   colour-mass placement) as a list, fix only those in one `batch`, compare again.
   Stop when every remaining mismatch is a listed deviation. Delete the reference
   layer before export.

## Must not

- Pixelize the concept: import it as the art, copy its pixels with `pixels.read`
  into `draw.pixel_map`, or `ref.import` + recolour and call it drawn.
- Ask twice: spec, prompt and choice go in one message.
- Hide the prompt in prose or leave placeholders.
- Draw while waiting for a reference the user said they would send.
- Let the reference override the brief. Brief wins; note the change as a deviation.
