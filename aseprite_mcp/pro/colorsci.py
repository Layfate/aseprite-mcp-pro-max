"""Perceptual colour science for the Pro Max tools.

Everything works in OKLab / OKLCH (Björn Ottosson, 2020), which is close to
perceptually uniform: equal distances look like equal differences, and
lightness (L) tracks how bright a colour reads. That matters for pixel art,
where a handful of colours must stay distinct and ramps must step evenly.

Arrays are numpy float64. RGB is 0-255, L is 0-1, a/b are roughly -0.4..0.4,
C (chroma) is 0..0.4 and h (hue) is degrees.
"""
from __future__ import annotations

import math

import numpy as np

from ..core.colors import parse_hex_color


# --- sRGB <-> linear ---------------------------------------------------------

def _to_linear(c: np.ndarray) -> np.ndarray:
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _from_linear(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    c = np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)
    return c * 255.0


_M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                [0.2119034982, 0.6806995451, 0.1073969566],
                [0.0883024619, 0.2817188376, 0.6299787005]])
_M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                [1.9779984951, -2.4285922050, 0.4505937099],
                [0.0259040371, 0.7827717662, -0.8086757660]])
_M2_INV = np.linalg.inv(_M2)
_M1_INV = np.linalg.inv(_M1)


def rgb_to_oklab(rgb) -> np.ndarray:
    """(..., 3) RGB 0-255 -> (..., 3) OKLab."""
    rgb = np.asarray(rgb, dtype=np.float64)[..., :3]
    lms = _to_linear(rgb) @ _M1.T
    return np.cbrt(lms) @ _M2.T


def oklab_to_rgb(lab) -> np.ndarray:
    """(..., 3) OKLab -> (..., 3) RGB floats 0-255 (clipped to gamut)."""
    lab = np.asarray(lab, dtype=np.float64)
    lms = (lab @ _M2_INV.T) ** 3
    return _from_linear(lms @ _M1_INV.T)


def oklab_to_oklch(lab) -> np.ndarray:
    lab = np.asarray(lab, dtype=np.float64)
    c = np.hypot(lab[..., 1], lab[..., 2])
    h = np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) % 360
    return np.stack([lab[..., 0], c, h], axis=-1)


def oklch_to_oklab(lch) -> np.ndarray:
    lch = np.asarray(lch, dtype=np.float64)
    hr = np.radians(lch[..., 2])
    return np.stack([lch[..., 0], lch[..., 1] * np.cos(hr), lch[..., 1] * np.sin(hr)], axis=-1)


def _in_gamut(lab) -> bool:
    lms = (np.asarray(lab) @ _M2_INV.T) ** 3
    lin = lms @ _M1_INV.T
    return bool(np.all(lin >= -1e-4) and np.all(lin <= 1 + 1e-4))


def oklch_to_rgb_gamut(L: float, C: float, h: float) -> tuple[int, int, int]:
    """OKLCH to an in-gamut 8-bit RGB, reducing chroma (not hue) when needed."""
    L = min(1.0, max(0.0, L))
    lo, hi = 0.0, max(0.0, C)
    if _in_gamut(oklch_to_oklab([L, hi, h])):
        lo = hi
    else:
        for _ in range(24):
            mid = (lo + hi) / 2
            if _in_gamut(oklch_to_oklab([L, mid, h])):
                lo = mid
            else:
                hi = mid
    rgb = oklab_to_rgb(oklch_to_oklab([L, lo, h]))
    return tuple(int(round(v)) for v in rgb)


# --- hex helpers ---------------------------------------------------------------

def hex_to_rgb(value: str) -> tuple[int, int, int] | None:
    rgba = parse_hex_color(value)
    return rgba[:3] if rgba else None


def rgb_to_hex(rgb) -> str:
    r, g, b = (int(round(min(255, max(0, v)))) for v in list(rgb)[:3])
    return f"#{r:02X}{g:02X}{b:02X}"


def parse_colors(values) -> list[tuple[int, int, int]] | str:
    """Parse a list of hex strings; returns an error string on the first bad one."""
    out = []
    for v in values:
        rgb = hex_to_rgb(v)
        if rgb is None:
            return f"Invalid color value: {v}"
        out.append(rgb)
    return out


def lightness(rgb) -> float:
    """Perceptual lightness 0-1 (OKLab L) of one colour."""
    return float(rgb_to_oklab(np.array(rgb[:3], dtype=np.float64))[0])


def delta_e(a, b) -> float:
    """OKLab distance between two RGB colours (0.02 ≈ just noticeable)."""
    return float(np.linalg.norm(rgb_to_oklab(np.array(a[:3])) - rgb_to_oklab(np.array(b[:3]))))


def nearest_indices(lab_pixels: np.ndarray, lab_palette: np.ndarray) -> np.ndarray:
    """Index of the nearest palette entry (OKLab distance) for each pixel."""
    d = ((lab_pixels[:, None, :] - lab_palette[None, :, :]) ** 2).sum(-1)
    return d.argmin(axis=1)


# --- ramps -----------------------------------------------------------------------

def _hue_toward(h: float, target: float, amount: float) -> float:
    """Rotate hue h toward target by up to `amount` degrees along the short way."""
    diff = ((target - h + 540) % 360) - 180
    step = max(-abs(amount), min(abs(amount), diff))
    return (h + step) % 360


SHADOW_HUE = 275.0   # shadows lean toward blue-violet
LIGHT_HUE = 85.0     # highlights lean toward warm yellow


def hue_shift_ramp(
    base,
    darker: int = 2,
    lighter: int = 1,
    step_l: float = 0.11,
    hue_shift: float = 14.0,
    shadow_hue: float = SHADOW_HUE,
    light_hue: float = LIGHT_HUE,
) -> list[tuple[int, int, int]]:
    """A perceptual shading ramp around `base`, darkest first.

    Each step down drops OKLab lightness by step_l and turns the hue toward
    shadow_hue; each step up raises lightness and turns toward light_hue.
    Chroma rises slightly into the mid shadows and falls in highlights and in
    the deepest shadow, the way painted ramps do, so the ramp never goes muddy
    grey or neon.
    """
    L0, C0, h0 = oklab_to_oklch(rgb_to_oklab(np.array(base[:3], dtype=np.float64)))
    grey = C0 < 0.02
    out = []
    for i in range(darker, 0, -1):
        L = max(0.06, L0 - step_l * i)
        h = h0 if grey else _hue_toward(h0, shadow_hue, min(hue_shift * i, 2.2 * hue_shift))
        C = C0 * (1.08 if i == 1 else max(0.55, 1.0 - 0.12 * (i - 1)))
        if grey:
            C, h = min(0.03, 0.012 * i), shadow_hue
        out.append(oklch_to_rgb_gamut(L, C, h))
    out.append(tuple(int(v) for v in base[:3]))
    for i in range(1, lighter + 1):
        L = min(0.97, L0 + step_l * 0.9 * i)
        h = h0 if grey else _hue_toward(h0, light_hue, hue_shift * 0.8 * i)
        C = C0 * max(0.45, 1.0 - 0.18 * i)
        if grey:
            C, h = min(0.02, 0.01 * i), light_hue
        out.append(oklch_to_rgb_gamut(L, C, h))
    return out


def mix(a, b, t: float = 0.5) -> tuple[int, int, int]:
    """Perceptual mix of two RGB colours in OKLab."""
    la, lb = rgb_to_oklab(np.array(a[:3])), rgb_to_oklab(np.array(b[:3]))
    return tuple(int(round(v)) for v in oklab_to_rgb(la * (1 - t) + lb * t))


def kmeans_oklab(lab: np.ndarray, k: int, weights: np.ndarray | None = None,
                 iters: int = 30, seed: int = 0) -> np.ndarray:
    """Deterministic weighted k-means (k-means++ init) in OKLab. Returns centres."""
    n = len(lab)
    if n == 0:
        return np.zeros((0, 3))
    if weights is None:
        weights = np.ones(n)
    k = min(k, n)
    rng = np.random.default_rng(seed)
    centres = [lab[int(np.argmax(weights))]]
    for _ in range(1, k):
        d = np.min(((lab[:, None, :] - np.array(centres)[None]) ** 2).sum(-1), axis=1) * weights
        if d.sum() <= 0:
            break
        centres.append(lab[rng.choice(n, p=d / d.sum())])
    c = np.array(centres)
    for _ in range(iters):
        idx = nearest_indices(lab, c)
        new = c.copy()
        for j in range(len(c)):
            m = idx == j
            if m.any():
                new[j] = np.average(lab[m], axis=0, weights=weights[m])
        if np.allclose(new, c, atol=1e-6):
            break
        c = new
    return c


def hue_name(h: float, c: float) -> str:
    if c < 0.03:
        return "neutral"
    names = [(20, "pink-red"), (45, "red"), (70, "orange"), (100, "yellow"), (140, "lime"),
             (170, "green"), (210, "teal"), (245, "cyan-blue"), (285, "blue"), (320, "violet"),
             (350, "magenta"), (360, "pink-red")]
    for limit, name in names:
        if h < limit:
            return name
    return "pink-red"


def angle_diff(a: float, b: float) -> float:
    return abs(((a - b + 540) % 360) - 180)


def safe_round(v: float, n: int = 3) -> float:
    return float(round(v, n)) if math.isfinite(v) else 0.0
