---
name: brief
description: Turn a vague pixel-art request into a written brief (canvas size, palette, view, light, outline, states, engine) and confirm it with the user in ONE message before any pixel is drawn; then store it with brief.set so check.brief and check.craft hold every later step to it. Use when a request is open-ended ("make me a knight"), not a specific edit.
---

# Brief: decide before drawing

"Draw me a knight" contains none of the decisions that make the result usable.
Guessing them and drawing anyway wastes a full redraw when one is wrong.

## The decisions

| Decision | Why it cannot wait | Default |
|---|---|---|
| Canvas size + subject height | Sets what can be shown at all (rules://30-proportions-by-size) | 32x32, character ~28 px tall |
| Palette | Choosing later means repainting | a preset: `pal.presets` (sweetie-16, pico-8, endesga-32, ...) |
| View | Side, top-down, 3/4 are different drawings (rules://37-views-and-directions) | 3/4 for characters, side for platformers |
| Light direction | Must be fixed before any shading | top-left |
| Outline | Changes every edge (rules://04-outlines-and-edges) | selective, dark-coloured |
| States / directions | Frame budget and tags | idle only, one direction |
| Destination | Engine export needs tags, pivot, sheet | ask |

## Procedure

1. **Read what exists.** `inspect` an open or named document: its size and palette
   usually answer half the table, and matching existing work is what users want.
2. **Draft the brief** from what the user said plus the defaults. Do not ask what
   you can infer: "a Game Boy style knight" already fixed palette and size.
3. **Put it in one message, as decisions, not questions:**
   > 32x32, sweetie-16, 3/4 view, light from the upper left, selective dark
   > outline. Knight in plate with a sword, facing right. Idle (4 frames) for
   > Godot. Say if any of that is wrong; otherwise I'll start.

   For something new, `skill://concept` adds its art spec, image prompt and the
   reference choice **to this same message**.
4. **Ask only what blocks you.** The tile size of their game is worth asking;
   light direction is not.
5. **Store it** once the document exists:
   ```
   batch [{op:"brief.set", brief:{width:32, height:32, palette:[...hex], maxColors:16,
     perspective:"three-quarter", light:"top-left", outline:{style:"selective"},
     states:[{name:"idle", frames:4}], pivot:"feet", engine:"godot"}}]
   ```
   `check.brief` and `check.craft` read it from then on (light, colour budget,
   transparency, perspective).

## Then

`skill://concept` for anything drawn from scratch, then `skill://draw`.
