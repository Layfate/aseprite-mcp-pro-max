"""Shared plumbing for the Pro Max tools: error handling, image replies, panels."""
from __future__ import annotations

import functools
import io
import json
import os

import numpy as np
from mcp.server.fastmcp import Image
from PIL import Image as PILImage
from PIL import ImageDraw, ImageFont

from ..core.commands import reject_traversal
from .pixio import PixError

MAX_REPLY_PX = 1568   # larger images are shrunk by most clients, blurring pixels


def tool_errors(fn):
    """Turn PixError (and stray exceptions) into a plain error string for the model."""
    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except PixError as e:
            return f"ERROR: {e}"
        except Exception as e:  # pragma: no cover - surfaced to the caller
            return f"ERROR: {type(e).__name__}: {e}"
    return wrapper


def check_file(filename: str) -> None:
    if not filename or not os.path.exists(filename):
        raise PixError(f"File {filename} not found")


def check_out(path: str) -> None:
    err = reject_traversal(path)
    if err:
        raise PixError(err)
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)


def as_json(d) -> str:
    return json.dumps(d, separators=(",", ":"), default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o))


def image_reply(text: str, im: PILImage.Image, save_to: str = ""):
    """[text, Image] reply, optionally also saving the PNG."""
    if save_to:
        check_out(save_to)
        if not save_to.lower().endswith(".png"):
            save_to += ".png"
        im.save(save_to)
        text += f" Saved to {save_to}."
    buf = io.BytesIO()
    im.convert("RGB").save(buf, format="PNG")
    return [text, Image(data=buf.getvalue(), format="png")]


@functools.cache
def font(size: int):
    return ImageFont.load_default(size=size)


CHECK_A, CHECK_B = (236, 236, 236, 255), (250, 250, 250, 255)


def checker(w: int, h: int, cell: int = 1) -> PILImage.Image:
    yy, xx = np.mgrid[0:h, 0:w]
    m = ((xx // cell + yy // cell) % 2).astype(bool)
    arr = np.where(m[..., None], np.array(CHECK_B, np.uint8), np.array(CHECK_A, np.uint8))
    return PILImage.fromarray(arr.astype(np.uint8), "RGBA")


def on_bg(img: np.ndarray, bg=None) -> PILImage.Image:
    """Composite an RGBA array over a checkerboard (bg None) or a solid colour."""
    h, w = img.shape[:2]
    base = checker(w, h) if bg is None else PILImage.new("RGBA", (w, h), (*bg[:3], 255))
    return PILImage.alpha_composite(base, PILImage.fromarray(img, "RGBA"))


def zoom(im: PILImage.Image, k: int) -> PILImage.Image:
    return im.resize((im.width * k, im.height * k), PILImage.NEAREST)


def titled(im: PILImage.Image, title: str, pad: int = 6) -> PILImage.Image:
    f = font(12)
    out = PILImage.new("RGB", (max(im.width, 10 + int(f.getlength(title))), im.height + 18), (255, 255, 255))
    ImageDraw.Draw(out).text((0, 2), title, fill=(30, 30, 30), font=f)
    out.paste(im.convert("RGB"), (0, 18))
    return out


def row(panels: list[PILImage.Image], gap: int = 14, bg=(255, 255, 255)) -> PILImage.Image:
    w = sum(p.width for p in panels) + gap * (len(panels) + 1)
    h = max(p.height for p in panels) + gap * 2
    out = PILImage.new("RGB", (w, h), bg)
    x = gap
    for p in panels:
        out.paste(p.convert("RGB"), (x, gap))
        x += p.width + gap
    return out


def column(panels: list[PILImage.Image], gap: int = 0, bg=(255, 255, 255)) -> PILImage.Image:
    w = max(p.width for p in panels)
    h = sum(p.height for p in panels) + gap * (len(panels) - 1)
    out = PILImage.new("RGB", (w, h), bg)
    y = 0
    for p in panels:
        out.paste(p.convert("RGB"), (0, y))
        y += p.height + gap
    return out


def fit_scale(w: int, h: int, budget: int) -> int:
    return max(1, min(32, budget // max(w, h, 1)))


def swatches(colors: list[tuple[tuple[int, int, int], str]], size: int = 22, per_row: int = 16,
             bg=(255, 255, 255)) -> PILImage.Image:
    """A strip of colour squares, each labelled underneath (e.g. with a count)."""
    n = max(1, len(colors))
    cols = min(per_row, n)
    rows_ = (n + cols - 1) // cols
    cell_h = size + (14 if any(l for _, l in colors) else 4)
    out = PILImage.new("RGB", (cols * (size + 4) + 4, rows_ * cell_h + 4), tuple(bg[:3]))
    d = ImageDraw.Draw(out)
    f = font(10)
    for i, (rgb, label) in enumerate(colors):
        x = 4 + (i % cols) * (size + 4)
        y = 4 + (i // cols) * cell_h
        d.rectangle([x, y, x + size - 1, y + size - 1], fill=tuple(rgb[:3]), outline=(60, 60, 60))
        if label:
            d.text((x + size // 2, y + size + 1), label, fill=(70, 70, 70), font=f, anchor="mt")
    return out
