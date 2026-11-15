---
name: fix
description: Change a sprite that already exists - the user's work or an earlier draft - without destroying what is already right. Scope tightly (layer, selection, region), checkpoint first, edit pixel rows rather than redraw, verify the change with changes/preview, and prove it improved with check.craft and a side-by-side comparison. Use for edits, touch-ups, "make it more X" and fixing review findings.
---

# Fix existing art

Editing has a failure mode drawing from scratch does not: breaking something
that was already correct. Everything below exists to prevent that.

## Procedure
1. **Understand what is there.** `inspect {detail: "full"}`, `preview`, and
   `pixels.read` on the region. Never assume layer names, frames or the palette.
   Use group paths ("left/arm") when names repeat.
2. **Say what you will change** in one line for anything beyond a touch-up,
   especially before changing the palette, resizing, merging layers or editing a
   layer you did not create.
3. **Checkpoint and keep a baseline**: `checkpoint {action: "create", label:
   "before <fix>"}`, `doc.duplicate {to: "review/before.aseprite", overwrite: true}`
   and `check.craft` (note the score).
4. **Scope tightly**: a `layer`, a selection (`sel.*` then `inSelection: true`),
   or x/y/width/height.
5. **Edit rows, not coordinates.** `pixels.read` the region, change the cells
   that are wrong, write the same rows back with `draw.pixel_map` at the same
   origin, in one `batch` with a `label`.
6. **Verify the change, not just the result.** `changes {against: <checkpoint>}`:
   if you edited the hand and the changed bounds span the whole sprite, something
   else moved. More than ~a quarter of a layer changed means you redrew:
   `restore` and make the smaller fix.
7. **Prove it improved.** `check.craft` again (same or better score, the targeted
   finding gone) and before/after side by side: `preview {view: "compare", args:
   {frameA: 1, other: "review/before.aseprite"}}`. Keep it only if it wins;
   otherwise `restore {action: "restore", id: <checkpoint>}`.

## Reading vague requests
| Request | Usually means |
|---|---|
| "more contrast" | widen the value range of the ramps, not the hue |
| "cleaner" | strays, uneven runs, near-duplicate colours (check.craft C5, G6, C2) |
| "less flat" | shading without hue shift or without one light direction (C3, C6) |
| "muddy colours" | near-duplicates and too many colours (C1, C2): `pal.reduce`, `pal.quantize` |
| "more detail" | usually wrong at small sizes; ask what should read better |
| "pop more" | contrast against the background, or one brighter accent |
| "off / uncanny" | run `skill://review` and name the cause |

## Must not
- Redraw from scratch because it is easier than editing, unless asked.
- "Improve" things nobody mentioned.
- Widen the palette to fit a colour you chose; say the palette lacks it.
- Flatten, resize or re-index without being asked.
