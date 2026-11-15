---
name: draw
description: Draw a sprite from silhouette to finished pixels in the order that catches mistakes while they are cheap - block in one flat colour, check the silhouette at 1x, separate materials, shade, outline, verify with pixels.read and check.craft. Use for the main body of any drawing task in Aseprite MCP Pro Max.
---

# Draw a sprite

Order matters more than technique. Detail added before the form is right just
makes the wrongness harder to see and more expensive to fix.

## Procedure

### 1. Look before you draw
`inspect {detail: "full"}`: real layer names, frames, palette. A wrong layer name
draws into the user's finished art. If `skill://concept` produced a PixelSpec, it
is the plan: its boxes and landmarks are where shapes go.

Read the subject rules (2-3 files, `kb.rules {query: "hands"}` etc.: characters
-> rules://30, 31, 36; faces -> 32, 33; animals -> 50-54; props -> 73). Their
`grid` templates are proven starting points: `kb.template {name, x, y, layer,
colors}` returns ready `draw.pixel_map` args. Transcribe, then adapt to the pose,
rather than inventing a shape from nothing.

### 2. Block in the silhouette: one flat colour, one batch
Up to ~32x32, write it as a grid: one character per pixel, so you see the whole
shape while writing it:
```
batch [{op:"draw.pixel_map", layer:"body", x:8, y:10, legend:{"O":"#5f574f"}, rows:[
  "....OOOO....",
  "..OOOOOOOO..",
  ".OOOOOOOOOO.",
  "OOOOOOOOOOOO"]}]
```
Every row the same width; `.` keeps existing pixels (map a char to "transparent"
to erase). Bigger sprites: one grid per body part or per layer, each at its own
x/y - long rows of one character are where a model miscounts. Big regular forms
(a floor, a 40 px disc) are cheaper as `draw.ellipse` / `draw.polygon` /
`draw.rect`.

### 3. Check the silhouette immediately
`preview {view: "silhouette", scale: 1}` then `preview {scale: 6}`. The only
question: **is it recognisable as one flat shape?** Watch for: perfect
symmetry (reads as a statue), tangents where an arm fuses into the torso, all
limbs the same thickness, a boxy outline made only of rectangles (G7). Fix now;
shading a bad silhouette is wasted work.

### 4. Separate the materials, still flat
Replace regions with each material's base colour (skin, cloth, metal, leather)
in one batch. Pick bases from the middle of their ramps so a darker and a lighter
step exist in the palette (`pal.ramp` builds hue-shifted ramps; `pal.add_colors`
adds them).

### 5. Shade
`skill://shade`. One shadow step, look, one light step, look.

### 6. Outline
One style, applied consistently (rules://04-outlines-and-edges). Selective
outline (dark version of the adjacent fill, not black everywhere) usually reads
best. `draw.outline` does the mechanical part; then hand-break it where light
hits. `clean.outline` + `clean.pixel_perfect` remove doubles and elbows.

### 7. Verify precisely
`pixels.read {x, y, width, height}` on the busiest region and one outline
stretch. This is where you catch the pixel one row too low, the run of 3 in a
line of 2s, a lone pixel of an odd colour. Fix by editing the returned rows and
writing them back with `draw.pixel_map` at the same origin.

### 8. Measure, then report
`check.craft` and `check.lint`. Fix every `blocking`; justify each kept
`warning`. Then `skill://review` (or the pixel-critic agent). Not before.

## Batching rules
- Ops run in array order: fills before outlines, outlines before highlights.
- One `batch` per stage, with a `label` describing the intent: one checkpoint,
  one undo.
- Stay inside the palette. If a colour you want is missing, say so; `check.palette`
  proves you did not drift.

## Related
rules://00-core-principles, rules://03-silhouette-and-form,
rules://04-outlines-and-edges, rules://10-lines-and-curves,
rules://11-clusters-and-noise, rules://14-readability-and-scale.
