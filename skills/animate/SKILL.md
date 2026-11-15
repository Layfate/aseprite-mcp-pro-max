---
name: animate
description: Build an idle, walk, run or attack cycle from planned key poses on separate part layers, with timing that reads as motion rather than a metronome, tagged for engines, and reviewed frame by frame with contact sheets, onion skin and the consistency checks (check.identity, check.jitter, check.craft across frames). Use when a sprite needs to move.
---

# Animate a cycle

## Before you start
Parts that move independently (arms, legs, head, cape) belong on their own
layers. Animating a flattened sprite means redrawing every frame. Split with
`sel.*` + `sel.to_layer`, or `layer.extract_colors`. Read rules://40-timing-and-spacing
and the cycle's rule (41 idle, 42 walk/run, 43 jump, 44 attacks; animals 51/52):
their frame tables and key-pose templates (`kb.template`) come before invention.

## Procedure
1. **Plan the key poses in writing.** Walk: contact (widest stance) -> down (body
   lowest) -> pass (legs together, body highest; the frame everyone forgets) ->
   up; mirror for the other leg. Idle: 2-4 frames, the chest rises 1 px and the
   shoulders follow a frame later. Attack: anticipation -> strike -> hold -> recover.
2. **Lay out frames and tags**: `anim.scaffold {states:[{name:"walk", frames:8}],
   directions:["e"]}` or `frame.duplicate` from the key frame (keeps identity,
   scale and palette).
3. **Block the keys by moving cels**, not redrawing: `cel.copy`, `cel.move
   {dx, dy}`. Redraw only where a part changes shape (a bending knee): `pixels.read`
   the part on the previous key, edit the rows, `draw.pixel_map` them onto the new
   frame at the same origin, so volume cannot drift.
4. **Look at the keys before in-betweens.** `preview {view: "contact_sheet"}`, then
   each key at full zoom (`preview {frame: n, scale: 8}`). Fix volume and height
   now, while there are 4 frames to fix rather than 8. `check.identity` flags size
   and colour drift against frame 1.
5. **In-betweens.** Spacing is easing: close poses read slow, far apart read fast.
   Judge each against its neighbours with `preview {frame: n, onion: true}`.
   `anim.inbetween` makes reviewable candidates (accept with
   `anim.accept_generated`, revert with `anim.remove_generated`).
   `anim.offset_sequence` / `anim.tween` suit secondary motion (bob, breath,
   float); primary motion is keyed by hand. Something that grows or shrinks on
   screen is drawn at 3-4 sizes by hand, never re-rasterised per frame.
6. **Timing.** `frame.set_duration {tag, durations:[...]}`: contacts held longer
   than passes; anticipation 100-150 ms, strike 40-60 ms. Uniform timing reads
   mechanical however good the drawings are (`check.timing`).
7. **Tag and pivot.** Every animation tagged; `xf.set_pivot {anchor: "feet"}`;
   `check.jitter` and `check.pivot_drift` for sliding feet.
8. **Review.** `check.craft {tag}` (light must not move between frames: C6
   across frames), `anim.loop_check`, `view.gif` for playback, then
   `skill://review` section 5.

## Related
rules://05-animation, rules://06-layers-and-rigging, rules://40-timing-and-spacing,
rules://41-idle-and-breathing, rules://42-walk-and-run, rules://43-jump-fall-land,
rules://44-attacks-and-impacts, rules://45-secondary-motion, rules://46-subpixel-animation,
rules://47-top-down-animation.
