"""The Pro Max pipeline from the README, as a script.

Draws flat colours with draw_rows, then: checkpoint -> selective outline ->
auto_shade -> polish -> critique -> before/after image. Run from the repo root:

    uv run python examples/pro_max/mushroom_pipeline.py
"""
import asyncio
import json
import os

from aseprite_mcp.tools import canvas, drawing
from aseprite_mcp.pro import checkpoints, critique, fixers, shading

OUT = os.path.join("examples", "pro_max", "out")
os.makedirs(OUT, exist_ok=True)
p = os.path.join(OUT, "mushroom.aseprite")
run = asyncio.run

run(canvas.create_canvas(32, 32, p))
run(canvas.add_layer(p, "body"))
rows = [
    "..........RRRRRRRRRRR...........",
    "........RRRRRRRRRRRRRRR.........",
    "......RRRRWWWRRRRRRRRRRRR.......",
    ".....RRRRWWWWWRRRRRWWWRRRR......",
    "....RRRRRWWWWWRRRRWWWWWRRRR.....",
    "...RRRRRRRWWWRRRRRRWWWRRRRRR....",
    "...RRRRRRRRRRRRRRRRRRRRRRRRR....",
    "..RRRWWRRRRRRRRRRRRRRRRRWWWRRR..",
    "..RRWWWWRRRRRRRRRRRRRRRWWWWWRR..",
    "..RRRWWRRRRRRRWWWWRRRRRRWWWRRR..",
    "..RRRRRRRRRRRWWWWWWRRRRRRRRRRR..",
    "..RRRRRRRRRRRRWWWWRRRRRRRRRRRR..",
    "...RRRRRRRRRRRRRRRRRRRRRRRRRR...",
    "......CCCCCCCCCCCCCCCCCCCC......",
    "........SSSSSSSSSSSSSSSS........",
    "........SSSSSSSSSSSSSSSS........",
    "........SSSKKSSSSSSKKSSS........",
    "........SSSKKSSSSSSKKSSS........",
    "........SSSSSSSSSSSSSSSS........",
    "........SSSSSSSKKSSSSSSS........",
    "........SSSSSSSSSSSSSSSS........",
    ".........SSSSSSSSSSSSSS.........",
    ".........SSSSSSSSSSSSSS.........",
    "........GGSSSSSSSSSSSSGG........",
    "......GGGGGGGGGGGGGGGGGGGG......",
    ".....GGGGGGGGGGGGGGGGGGGGGG.....",
]
legend = {"R": "#D04040", "W": "#F2E8D8", "C": "#B88870", "S": "#E8D0A8", "K": "#2A1E28", "G": "#5C9C48"}
run(drawing.draw_rows(p, "body", 1, 0, 3, rows, legend))

print("flats:", json.loads(run(critique.critique_sprite(p)))["score"])
run(checkpoints.save_checkpoint(p, "flats"))
run(fixers.outline_pro(p, "body", style="selective"))
run(shading.auto_shade(p, "body", light_angle=135, checkpoint=False))
run(fixers.polish_sprite(p, checkpoint=False))
print("after:", json.loads(run(critique.critique_sprite(p)))["score"])
run(checkpoints.compare_versions(p, "flats", output_filename=os.path.join(OUT, "before_after.png")))
run(critique.view_quality(p, output_filename=os.path.join(OUT, "view_quality.png")))
