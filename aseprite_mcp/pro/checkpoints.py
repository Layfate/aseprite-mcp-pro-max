"""Checkpoints: save a version of a sprite before a risky step, compare, roll back.

Iterating is how art gets good: try a bolder shading pass, compare it with
the last version, keep the better one. Checkpoints live next to the file in
a hidden `.checkpoints/<name>/` folder (override with
ASEPRITE_MCP_CHECKPOINT_DIR), numbered in order.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time

import numpy as np

from .. import mcp
from . import pixio
from . import pixops as po
from .common import (as_json, check_file, column, fit_scale, image_reply, on_bg, row, titled, tool_errors,
                     zoom)


def _dir(filename: str) -> str:
    base = os.getenv("ASEPRITE_MCP_CHECKPOINT_DIR")
    stem = os.path.splitext(os.path.basename(filename))[0]
    if base:
        return os.path.join(os.path.expanduser(base), stem)
    return os.path.join(os.path.dirname(os.path.abspath(filename)), ".checkpoints", stem)


def _entries(filename: str) -> list[dict]:
    d = _dir(filename)
    if not os.path.isdir(d):
        return []
    out = []
    for name in os.listdir(d):
        m = re.match(r"^(\d{3,})-(.*)\.aseprite$", name)
        if m:
            path = os.path.join(d, name)
            meta = {}
            mp = path + ".json"
            if os.path.exists(mp):
                try:
                    with open(mp, encoding="utf-8") as f:
                        meta = json.load(f)
                except (OSError, ValueError):
                    meta = {}
            out.append({"id": int(m.group(1)), "label": meta.get("label", m.group(2)), "path": path,
                        "saved": meta.get("saved", ""), "score": meta.get("score")})
    return sorted(out, key=lambda e: e["id"])


def save(filename: str, label: str = "", score: int | None = None) -> dict:
    check_file(filename)
    d = _dir(filename)
    os.makedirs(d, exist_ok=True)
    entries = _entries(filename)
    n = (entries[-1]["id"] + 1) if entries else 1
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", label.strip())[:40].strip("-") or "checkpoint"
    path = os.path.join(d, f"{n:03d}-{slug}.aseprite")
    shutil.copy2(filename, path)
    meta = {"label": label or slug, "saved": time.strftime("%Y-%m-%d %H:%M:%S"), "score": score}
    with open(path + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f)
    return {"id": n, "label": meta["label"], "path": path}


def find(filename: str, checkpoint: str) -> dict:
    entries = _entries(filename)
    if not entries:
        raise pixio.PixError(f"No checkpoints for {filename}; save one with save_checkpoint")
    if checkpoint in ("", "last", "latest"):
        return entries[-1]
    if checkpoint.lstrip("-").isdigit():
        n = int(checkpoint)
        if n < 0:  # -1 = the latest, -2 = the one before it
            if -n > len(entries):
                raise pixio.PixError(f"Only {len(entries)} checkpoint(s)")
            return entries[n]
        for e in entries:
            if e["id"] == n:
                return e
    for e in reversed(entries):
        if e["label"] == checkpoint:
            return e
    raise pixio.PixError(f"Checkpoint '{checkpoint}' not found; list_checkpoints shows them")


@mcp.tool()
@tool_errors
async def save_checkpoint(filename: str, label: str = "") -> str:
    """Save a numbered copy of the sprite to come back to.

    Save before anything you might want to undo: a shading pass, a palette
    change, a big redraw. The critique score is stored with it so
    list_checkpoints shows which version was best.

    Args:
        filename: Aseprite file
        label: Short description, e.g. "flats done" or "before shading"
    """
    from .critique import analyze
    check_file(filename)
    try:
        score = analyze(pixio.read_composite(filename, 1))["score"]
    except pixio.PixError:
        score = None
    e = save(filename, label, score)
    return as_json({**e, "score": score})


@mcp.tool()
@tool_errors
async def list_checkpoints(filename: str) -> str:
    """List saved checkpoints of a sprite, oldest first, with their scores."""
    check_file(filename)
    return as_json({"checkpoints": _entries(filename)})


@mcp.tool()
@tool_errors
async def restore_checkpoint(filename: str, checkpoint: str = "last", keep_current: bool = True) -> str:
    """Roll the sprite back to a checkpoint.

    Args:
        filename: Aseprite file
        checkpoint: "last", a number from list_checkpoints, "-2" for the one
            before the last, or a label
        keep_current: First save the current state as a checkpoint too, so
            the restore itself can be undone (default True)
    """
    check_file(filename)
    e = find(filename, checkpoint)
    saved = save(filename, f"before restoring {e['id']}") if keep_current else None
    shutil.copy2(e["path"], filename)
    return as_json({"restored": e["id"], "label": e["label"], "current_saved_as": saved["id"] if saved else None})


@mcp.tool()
@tool_errors
async def compare_versions(filename: str, checkpoint: str = "last", frame_index: int = 1,
                           other_file: str = "", output_filename: str = ""):
    """Before/after: a checkpoint (or another file) next to the current sprite,
    plus a diff panel with every changed pixel highlighted.

    Use it to decide whether a pass made things better, then keep it or
    restore_checkpoint.

    Args:
        filename: Current Aseprite file
        checkpoint: Checkpoint to compare with ("last", a number, "-2", a label)
        frame_index: Frame to compare
        other_file: Compare with this file instead of a checkpoint
        output_filename: Optional PNG path
    """
    from .critique import analyze
    check_file(filename)
    if other_file:
        check_file(other_file)
        old_path, old_label = other_file, os.path.basename(other_file)
    else:
        e = find(filename, checkpoint)
        old_path, old_label = e["path"], f"checkpoint {e['id']} ({e['label']})"
    new = pixio.read_composite(filename, frame_index)
    old = pixio.read_composite(old_path, frame_index)
    if old.shape != new.shape:
        h, w = max(old.shape[0], new.shape[0]), max(old.shape[1], new.shape[1])
        pad = lambda a: np.pad(a, ((0, h - a.shape[0]), (0, w - a.shape[1]), (0, 0)))
        old, new = pad(old), pad(new)
    h, w = new.shape[:2]
    changed = np.any(old != new, axis=-1)
    diff = (new.astype(np.int32) // 4 + 150).clip(0, 255).astype(np.uint8)
    diff[..., 3] = 255
    diff[changed] = (255, 40, 120, 255)
    k = fit_scale(w, h, 420)
    s_old, s_new = analyze(old)["score"], analyze(new)["score"]
    panels = [titled(zoom(on_bg(old), k), f"before: {old_label[:40]}  score {s_old}"),
              titled(zoom(on_bg(new), k), f"now  score {s_new}"),
              titled(zoom(on_bg(diff), k), f"changed: {int(changed.sum())} px")]
    sheet = row(panels)
    b = po.bbox(changed)
    text = (f"Frame {frame_index}: {int(changed.sum())} pixel(s) changed"
            + (f" inside x={b[0]}..{b[2] - 1}, y={b[1]}..{b[3] - 1}" if b else "")
            + f". Score before {s_old}, now {s_new}.")
    return image_reply(text, sheet, output_filename)
