---
name: studio
description: The front door for any Aseprite or pixel-art request through Aseprite MCP Pro Max. Works out what the user wants, chains the other skills (brief, concept, draw, shade, animate, fix, review) in the order that keeps mistakes cheap, and owns the result until it has been looked at, measured with check.craft and judged by someone who did not draw it. Use for anything that spans several steps ("make me an animated knight for Godot") or when unsure which skill applies.
---

# Studio: take a pixel-art request end to end

Pixel art made by a model looks like slop for predictable reasons: guessed
decisions, detail before form, shading by brightness slider, and "done" claimed
from a tool result nobody looked at. This workflow exists to stop each of those.
At every stage, read the skill it names and follow it; do not do the stage from
memory.

## The iron law

**No completion claim without fresh evidence from this turn:** a `preview` you
looked at, a `check.craft` result, and a review by a reader who did not draw it.
"412 pixels changed" is not evidence that a sprite is right. Words like
"should look good", "probably reads", "looks great!" before that evidence are
the failure this rule exists for.

## Procedure

1. **Check the room.** `capabilities` once (Aseprite found? live editor
   connected?). If the user means a sprite open in their editor, work with
   `live: true`; otherwise work on files. `inspect` anything that already exists:
   its size and palette answer questions you would otherwise ask.

2. **Classify** the request with the routing table below and write the chain
   down. It is the plan you report progress against.

3. **Decide once whether to ask.** Open-ended requests go through
   `skill://brief`, which puts every decision to the user in **one** message.
   Specific requests ("add a 1px outline", "export a GIF") do not. Never ask more
   than once per stage.

4. **Design before drawing.** Anything new goes through `skill://concept`: an art
   spec, plus an image-model prompt the user may use to make a concept sheet. Its
   offer rides in the brief's message, so the user still answers once.

5. **Run the chain.** For each stage read `skill://<name>` and the 2-3 subject
   rules it points to (`kb.rules {query}` finds them). Batch each stage's edits
   into one `batch` call: one checkpoint, one undo step.

6. **Look after every stage that changed pixels.** `preview` (scale 1 for the
   true read, default scale for detail), `view: "silhouette"` after block-in,
   `view: "values"` after shading, `pixels.read` when position matters. A stage
   is done when you have seen its result.

7. **Measure.** `check.craft` (art tells) and `check.lint` / `check.brief`
   (mechanics). Fix every `blocking` finding. For each `warning` you keep, have a
   reason you will state.

8. **Get judged by someone who did not draw it.** Hand the document to the
   `pixel-critic` agent where the harness has one; otherwise run
   `skill://review` and do its cold read *before* rereading the brief. Never grade
   your own work in its place: you know what you meant, so you see it.

   A draft ships when the critique has **no BLOCKING finding and scores 7/10 or
   more** *and* `check.craft` has no `blocking` finding. Otherwise fix, at most
   three rounds. Each round:

   - **Snapshot first:** `checkpoint {action: "create", label: "before round N"}`
     and `preview {saveTo: "review/a_or_b.png", scale: 8}` of the current state.
   - **Fix, don't redraw:** change the pixels the finding points at
     (`pixels.read` the region, edit the rows, write them back with
     `draw.pixel_map` at the same x/y). If `changes {against: <checkpoint>}`
     shows more than about a quarter of a layer changed, it was a redraw:
     `restore` and make the smaller fix.
   - **Decide by comparison, not by score:** save the new version next to the
     snapshot under coin-flipped names (`review/a.png`, `review/b.png`) and ask one
     critic call which is the better sprite for the brief and whether the blocking
     finding is gone. Keep the fix only if it wins; otherwise `restore`. The
     `check.craft` score is deterministic and may break a tie, but it never
     overrules the eye. Two rejected rounds in a row end the loop.

   If the rounds run out with a blocking finding left, say so and ask whether to
   continue. Do not change pixels after the last critique.

9. **Report** in a few lines: what exists (files, layers, tags, exports), what you
   decided for the user, what you compromised on and why, the final
   `check.craft` verdict/score and the critic's score. Show a `preview`, not an
   adjective.

## Routing

| The user wants | Chain |
|---|---|
| Something new, loosely described ("a knight") | brief + concept (one message) -> draw -> shade -> review |
| Something new, fully specified | concept -> draw -> shade -> review |
| A sprite from a picture they supplied | brief if size/palette open -> concept (reference mode) -> draw -> review |
| An animation of a character | the drawing chain if nothing exists -> animate -> review |
| A change to existing art ("fix the hands", "more menacing") | fix -> review |
| "It looks flat / AI-made / off" | review first, then fix or shade |
| An opinion ("is this good?") | review only; do not edit unless asked |
| Tiles, terrain | brief -> concept (environment sheet) -> draw with `tile.*` ops (rules://66-tiles-and-autotiling) -> review |
| Files for an engine | review if not done -> `engine.*` (search_ops "godot", ...) -> `engine.validate` |

A request that fits no row is usually one operation ("rename the layer"): do it,
`preview` if pixels changed, say what you did.

## What this workflow must not do

- Skip the brief on an open-ended request to seem fast; a guessed size or palette
  costs a full redraw.
- Pixelize a reference (downscale it and call it art). It guides shapes and poses;
  the pixels are still drawn. `ref.import` is for the user's own pixel art.
- Ask about things a default covers (light from the upper left).
- Declare done without `preview`, `check.craft` and a review.
- Leave stray scratch layers, a reference layer in the export, or colours added
  to the palette without saying so.

## Related

`skill://brief`, `skill://concept`, `skill://draw`, `skill://shade`,
`skill://animate`, `skill://fix`, `skill://review`; `rules://index`;
`rules://92-generated-art-tells` for what slop looks like.
