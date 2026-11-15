---
name: review
description: Earn the word "done". A cold read of the preview before rereading the brief, the objective craft audit (check.craft) and mechanical checks (check.lint, check.brief), the by-eye checklist, and a report with evidence and stated compromises instead of a success claim. Use before finishing any pixel-art task and when the user asks "is this good" or "why does this look off".
---

# Review: "done" is a claim

Run it on anything you drew or changed. Better still, have it run by someone
who did not draw it (the `pixel-critic` agent): you know what you meant, so you
see it.

## Procedure

### 0. Cold read, before the brief
`preview {scale: 1}` and `preview {scale: 6}`. Write one sentence on what the
picture shows to someone who was never told what it is, plus the three things
the eye lands on first. If that sentence does not name the subject, or misses a
part the brief makes central (the face, the sword), the sprite **fails review**
whatever the checks say. Then `preview {view: "values"}`: the lit side should be
among the lightest values, the core shadow among the darkest; everything in the
bottom third reads as murk.

### 1. Craft audit (objective)
`check.craft`. Findings use the ids of rules://92-generated-art-tells:
C7 pillow shading, C3 brightness-only ramps, C6 light vs brief / conflicting,
X3 banding, C5 confetti, G6 jaggies, E4 doubled outline, S4 mirror symmetry,
V1 murky / low contrast, C1 colour bloat, C2 near-duplicates, E1 partial alpha.
Fix every `blocking`. For each `warning` you keep, have a reason and say it.
Its `notChecked` list is what you must judge by eye.

### 2. Mechanics
`check.lint` (palette, alpha, strays, empty/duplicate frames), `check.brief` if
a brief exists. Animation: `check.timing`, `check.jitter`, `check.identity`,
`anim.loop_check`.

### 3. By eye (rules://07-review-checklist)
- Silhouette reads as one flat shape? (`preview {view: "silhouette"}`)
- Value contrast survives desaturation? (view "values")
- One light direction everywhere?
- Ramps hue-shift?
- Lines: even runs, no doubles? Outline: one style?
- Detail where it matters (face, weapon), quiet areas elsewhere?
- Features placed on purpose (eyes with a pupil, not mud)?

### 4. Look closely where something felt off
`pixels.read` the region: the pixel one row too low, the run of 3 in a line of
2s, the lone odd colour.

### 5. Animation
`preview {view: "contact_sheet"}`, then key frames one by one at full zoom
(first, last, holds, extremes) and in-betweens with `onion: true`. Volume and
height consistent? Loops? Contacts held longer than passes? Anticipation before
strong actions? Light fixed?

### 6. Report with evidence
> check.craft clean (98/100; one G6 info at (14,3) kept: it is the knee).
> Cold read: "a knight in blue plate holding a sword" - matches. Silhouette reads
> at 1x; values hold. Compromise: the plume snapped from #e04a6a to #ff77a8
> because sweetie-16 has nothing closer.

Never "looks good". If you found nothing, say what you checked.

## "Why does this look off?"
Run the same checks, then name the specific cause. The usual ones, in order:
too many colours, brightness-only shading, pillow shading, semi-transparent
pixels, a mushy silhouette, uniform animation timing.

## Related
rules://07-review-checklist, rules://92-generated-art-tells, and the Review
section of the subject rule for what was drawn.
