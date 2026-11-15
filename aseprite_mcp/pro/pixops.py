"""Pixel-art image operations on RGBA numpy arrays (H, W, 4, uint8).

Pure functions, no Aseprite: the tools read images through pixio, run these,
and write the result back. Everything is exact-pixel (no resampling blur),
because pixel art is judged pixel by pixel.
"""
from __future__ import annotations

from collections import Counter, deque

import numpy as np

from . import colorsci as cs

N4 = ((0, -1), (1, 0), (0, 1), (-1, 0))
N8 = ((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1))


# --- basics ------------------------------------------------------------------------

def opaque(img: np.ndarray) -> np.ndarray:
    return img[..., 3] > 0


def shift(a: np.ndarray, dx: int, dy: int, fill=0) -> np.ndarray:
    """out[y, x] = a[y + dy, x + dx]  (neighbour in direction dx,dy), padded with fill."""
    h, w = a.shape[:2]
    out = np.full_like(a, fill)
    ys = slice(max(0, -dy), min(h, h - dy))
    xs = slice(max(0, -dx), min(w, w - dx))
    ys2 = slice(max(0, dy), min(h, h + dy))
    xs2 = slice(max(0, dx), min(w, w + dx))
    out[ys, xs] = a[ys2, xs2]
    return out


def pack(img: np.ndarray) -> np.ndarray:
    """RGBA -> one uint32 key per pixel (transparent pixels all become 0)."""
    a = img.astype(np.uint32)
    key = (a[..., 0] << 24) | (a[..., 1] << 16) | (a[..., 2] << 8) | a[..., 3]
    key[img[..., 3] == 0] = 0
    return key


def unpack(key: int) -> tuple[int, int, int, int]:
    return (key >> 24) & 255, (key >> 16) & 255, (key >> 8) & 255, key & 255


def bbox(mask: np.ndarray):
    if not mask.any():
        return None
    ys, xs = np.nonzero(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def colors_used(img: np.ndarray) -> list[tuple[tuple[int, int, int, int], int]]:
    keys = pack(img)
    vals, counts = np.unique(keys[keys != 0], return_counts=True)
    order = np.argsort(-counts)
    return [(unpack(int(vals[i])), int(counts[i])) for i in order]


def boundary(mask: np.ndarray, conn: int = 4) -> np.ndarray:
    """Pixels of mask with at least one neighbour outside it (canvas edge counts as outside)."""
    edge = np.zeros_like(mask)
    for dx, dy in (N4 if conn == 4 else N8):
        edge |= mask & ~shift(mask, dx, dy, False)
    return edge


def dilate(mask: np.ndarray, conn: int = 8) -> np.ndarray:
    out = mask.copy()
    for dx, dy in (N4 if conn == 4 else N8):
        out |= shift(mask, dx, dy, False)
    return out


def distance_inside(mask: np.ndarray, max_d: int = 64) -> np.ndarray:
    """Octagonal distance (in px) from each pixel of mask to the outside; 0 outside.

    Mixes 4- and 8-connected erosion, which is closer to Euclidean than either.
    """
    d4 = np.zeros(mask.shape, np.float64)
    d8 = np.zeros(mask.shape, np.float64)
    m4, m8 = mask.copy(), mask.copy()
    for _ in range(max_d):
        if not m4.any() and not m8.any():
            break
        d4 += m4
        d8 += m8
        e4 = m4.copy()
        for dx, dy in N4:
            e4 &= shift(m4, dx, dy, False)
        e8 = m8.copy()
        for dx, dy in N8:
            e8 &= shift(m8, dx, dy, False)
        m4, m8 = e4, e8
    return (d4 + d8) / 2.0


def components(mask: np.ndarray, conn: int = 8) -> tuple[np.ndarray, int]:
    """Label connected components of mask. Returns (labels with 0 = background, count)."""
    h, w = mask.shape
    labels = np.zeros((h, w), np.int32)
    nb = N8 if conn == 8 else N4
    n = 0
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if labels[sy, sx]:
            continue
        n += 1
        labels[sy, sx] = n
        q = deque([(sx, sy)])
        while q:
            x, y = q.popleft()
            for dx, dy in nb:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and mask[ny, nx] and not labels[ny, nx]:
                    labels[ny, nx] = n
                    q.append((nx, ny))
    return labels, n


def color_regions(img: np.ndarray, conn: int = 4) -> tuple[np.ndarray, int]:
    """Label connected areas of one exact colour (transparent = 0)."""
    keys = pack(img)
    h, w = keys.shape
    labels = np.zeros((h, w), np.int32)
    nb = N4 if conn == 4 else N8
    n = 0
    for sy in range(h):
        for sx in range(w):
            if keys[sy, sx] == 0 or labels[sy, sx]:
                continue
            n += 1
            k = keys[sy, sx]
            labels[sy, sx] = n
            q = deque([(sx, sy)])
            while q:
                x, y = q.popleft()
                for dx, dy in nb:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not labels[ny, nx] and keys[ny, nx] == k:
                        labels[ny, nx] = n
                        q.append((nx, ny))
    return labels, n


def lab_image(img: np.ndarray) -> np.ndarray:
    return cs.rgb_to_oklab(img[..., :3].astype(np.float64))


# --- cleanup -------------------------------------------------------------------------

def find_orphans(img: np.ndarray, include_lone: bool = True) -> list[tuple[int, int]]:
    """Opaque pixels whose colour matches none of their opaque 8-neighbours."""
    keys = pack(img)
    h, w = keys.shape
    out = []
    ys, xs = np.nonzero(keys)
    for y, x in zip(ys.tolist(), xs.tolist()):
        k = keys[y, x]
        any_opaque, same = False, False
        for dx, dy in N8:
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and keys[ny, nx]:
                any_opaque = True
                if keys[ny, nx] == k:
                    same = True
                    break
        if not same and (any_opaque or include_lone):
            out.append((x, y))
    return out


def remove_orphans(img: np.ndarray, protect: set | None = None, passes: int = 2,
                   remove_lone: bool = True) -> tuple[np.ndarray, list[dict]]:
    """Replace orphan pixels by the most common colour of their 4-neighbours.

    A lone pixel (nothing opaque around it) is erased when remove_lone. Pixels
    in `protect` (a set of (x, y)) are left alone: eye glints, sparkles.
    """
    out = img.copy()
    changes = []
    protect = protect or set()
    h, w = img.shape[:2]
    for _ in range(passes):
        keys = pack(out)
        orphans = [p for p in find_orphans(out, include_lone=remove_lone) if p not in protect]
        if not orphans:
            break
        new = out.copy()
        for x, y in orphans:
            n4 = [keys[y + dy, x + dx] for dx, dy in N4 if 0 <= x + dx < w and 0 <= y + dy < h]
            n8 = [keys[y + dy, x + dx] for dx, dy in N8 if 0 <= x + dx < w and 0 <= y + dy < h]
            opaque_n = [k for k in n8 if k]
            if not opaque_n:
                new[y, x] = 0
                changes.append({"x": x, "y": y, "to": "transparent"})
                continue
            votes = Counter(n4 if n4 else n8)
            best, cnt = votes.most_common(1)[0]
            if cnt < 2:   # no clear majority among 4-neighbours: use all 8
                best = Counter(n8).most_common(1)[0][0]
            new[y, x] = unpack(int(best)) if best else (0, 0, 0, 0)
            changes.append({"x": x, "y": y, "to": cs.rgb_to_hex(unpack(int(best))[:3]) if best else "transparent"})
        out = new
    return out, changes


def find_doubles(img: np.ndarray, color_keys: set | None = None) -> list[tuple[int, int]]:
    """L-shaped 'doubles' on 1 px lines (the pixel-perfect rule).

    A pixel p is a double when two of its 4-neighbours on perpendicular sides
    (say N and E) share its colour, the pixel between them (NE) and the two
    opposite sides (S and W) do not, and every other same-coloured neighbour
    of p touches N or E - so removing p cannot break the line. Deliberate
    square corners, where both arms run on for 2+ pixels, are kept.
    """
    keys = pack(img)
    h, w = keys.shape
    found = []

    def same(x, y, k):
        return 0 <= x < w and 0 <= y < h and keys[y, x] == k

    ys, xs = np.nonzero(keys)
    for y, x in zip(ys.tolist(), xs.tolist()):
        k = keys[y, x]
        if color_keys is not None and k not in color_keys:
            continue
        orth = [(dx, dy) for dx, dy in N4 if same(x + dx, y + dy, k)]
        if len(orth) != 2:
            continue
        (ax, ay), (bx, by) = orth
        if ax * bx + ay * by != 0:
            continue  # opposite sides: p is the middle of a straight run
        if same(x + ax + bx, y + ay + by, k):
            continue  # filled corner, not a thin line
        others = [(dx, dy) for dx, dy in N8 if (dx, dy) not in orth and same(x + dx, y + dy, k)]
        if any(max(abs(dx - ax), abs(dy - ay)) > 1 and max(abs(dx - bx), abs(dy - by)) > 1
               for dx, dy in others):
            continue  # removing p would cut this neighbour off
        if same(x + 2 * ax, y + 2 * ay, k) and same(x + 2 * bx, y + 2 * by, k) and not others:
            continue  # a real square corner
        found.append((x, y))
    return found


def line_colors(img: np.ndarray, max_block_share: float = 0.15, min_pixels: int = 6) -> set:
    """Colours used as 1 px lines (outlines, contour and detail lines).

    A 1 px line never forms a filled 2x2 block of its own colour; a fill
    almost always does. A colour qualifies when few of its pixels belong to
    any 2x2 same-colour block.
    """
    keys = pack(img)
    blk = (keys[:-1, :-1] == keys[1:, :-1]) & (keys[:-1, :-1] == keys[:-1, 1:]) & \
          (keys[:-1, :-1] == keys[1:, 1:]) & (keys[:-1, :-1] != 0)
    in_block = np.zeros(keys.shape, bool)
    in_block[:-1, :-1] |= blk
    in_block[1:, :-1] |= blk
    in_block[:-1, 1:] |= blk
    in_block[1:, 1:] |= blk
    out = set()
    vals, counts = np.unique(keys[keys != 0], return_counts=True)
    for k, n in zip(vals.tolist(), counts.tolist()):
        if n < min_pixels:
            continue
        if (in_block & (keys == k)).sum() / n <= max_block_share:
            out.add(int(k))
    return out


def _run_through(keys, x, y, k):
    """Length of the longest horizontal or vertical same-colour run through (x, y)."""
    best = 1
    for dx, dy in ((1, 0), (0, 1)):
        n = 1 + _arm_len(keys, x, y, dx, dy, k, 64) + _arm_len(keys, x, y, -dx, -dy, k, 64)
        best = max(best, n)
    return best


def _arm_len(keys, x, y, dx, dy, k, limit=8):
    h, w = keys.shape
    n = 0
    while n < limit:
        x, y = x + dx, y + dy
        if not (0 <= x < w and 0 <= y < h) or keys[y, x] != k:
            break
        n += 1
    return n


def clean_doubles(img: np.ndarray, color_keys: set | None = None, max_passes: int = 400):
    """Remove L-doubles, re-checking the neighbourhood after each removal.

    Of two pixels forming a double, the one on the longer straight run goes,
    which evens out the steps (2-2-2 rather than 2-1-3). The removed pixel
    takes the colour on its open side, so an outline corner on the inside of a
    curve becomes fill and one on the outside becomes transparent.
    """
    out = img.copy()
    removed = []
    for _ in range(max_passes):
        cands = find_doubles(out, color_keys)
        if not cands:
            break
        keys = pack(out)
        h, w = keys.shape
        cands.sort(key=lambda p: (-_run_through(keys, p[0], p[1], keys[p[1], p[0]]), p[1], p[0]))
        taken = []
        for x, y in cands:
            if any(abs(x - tx) <= 3 and abs(y - ty) <= 3 for tx, ty in taken):
                continue
            k = keys[y, x]
            open_side = [keys[y + dy, x + dx] if (0 <= x + dx < w and 0 <= y + dy < h) else 0
                         for dx, dy in N4]
            open_side = [v for v in open_side if v != k]
            fill = Counter(open_side).most_common(1)[0][0] if open_side else 0
            out[y, x] = unpack(int(fill)) if fill else (0, 0, 0, 0)
            removed.append({"x": x, "y": y})
            taken.append((x, y))
    return out, removed


# --- edge profiles / jaggies ------------------------------------------------------------

def _runs_from_profile(profile: list[int | None]) -> list[tuple[int, int, int]]:
    """Group a 1-D edge profile into (start, length, value) runs of equal value."""
    runs = []
    i = 0
    n = len(profile)
    while i < n:
        if profile[i] is None:
            i += 1
            continue
        j = i
        while j + 1 < n and profile[j + 1] == profile[i]:
            j += 1
        runs.append((i, j - i + 1, profile[i]))
        i = j + 1
    return runs


def find_jaggies(mask: np.ndarray, min_jump: int = 2) -> list[dict]:
    """Uneven steps on the silhouette's edges ("jaggies").

    Reads the four edge profiles (top edge per column, bottom edge per column,
    left edge per row, right edge per row), groups them into runs, and flags a
    run that sticks out from both neighbours in a stretch that steps steadily
    one way: 1-3-1 or 3-1-3 on a curve or a diagonal. Even (2-2-2) and
    gradually changing (1-2-3) runs are clean and are not reported.
    """
    h, w = mask.shape
    found = []
    any_col = mask.any(axis=0)
    any_row = mask.any(axis=1)
    top = [int(np.argmax(mask[:, x])) if any_col[x] else None for x in range(w)]
    bottom = [int(h - 1 - np.argmax(mask[::-1, x])) if any_col[x] else None for x in range(w)]
    left = [int(np.argmax(mask[y])) if any_row[y] else None for y in range(h)]
    right = [int(w - 1 - np.argmax(mask[y, ::-1])) if any_row[y] else None for y in range(h)]
    for name, prof, horizontal in (("top", top, True), ("bottom", bottom, True),
                                   ("left", left, False), ("right", right, False)):
        runs = _runs_from_profile(prof)
        for i in range(1, len(runs) - 1):
            (s0, l0, v0), (s1, l1, v1), (s2, l2, v2) = runs[i - 1], runs[i], runs[i + 1]
            if s1 != s0 + l0 or s2 != s1 + l1:
                continue  # a gap in the profile
            d0, d1 = v1 - v0, v2 - v1
            if abs(d0) != 1 or d0 != d1:
                continue  # not a steady one-pixel staircase
            long_run = l1 - max(l0, l2) >= min_jump and l1 <= 5          # 1-3-1, 2-4-1 ...
            short_run = min(l0, l2) - l1 >= min_jump and max(l0, l2) <= 6  # 3-1-3 ...
            if long_run or short_run:
                if horizontal:
                    x, y, rw, rh = s1, v1, l1, 1
                else:
                    x, y, rw, rh = v1, s1, 1, l1
                found.append({"edge": name, "x": int(x), "y": int(y), "run": int(l1),
                              "neighbours": [int(l0), int(l2)]})
    return found


# --- scaling / rotation -----------------------------------------------------------------

def scale_nearest(img: np.ndarray, k: int) -> np.ndarray:
    return np.repeat(np.repeat(img, k, axis=0), k, axis=1)


def scale2x(img: np.ndarray) -> np.ndarray:
    """EPX / Scale2x: doubles size and rounds stair-steps without new colours."""
    keys = pack(img)
    h, w = keys.shape
    P = np.pad(keys, 1, mode="edge")
    A, B, C, D, E = P[:-2, 1:-1], P[1:-1, :-2], P[1:-1, 2:], P[2:, 1:-1], P[1:-1, 1:-1]
    # A=up, B=left, C=right, D=down
    e0 = np.where((B == A) & (B != D) & (A != C), A, E)
    e1 = np.where((A == C) & (A != B) & (C != D), C, E)
    e2 = np.where((D == B) & (D != C) & (B != A), B, E)
    e3 = np.where((C == D) & (C != A) & (D != B), D, E)
    outk = np.zeros((h * 2, w * 2), np.uint32)
    outk[0::2, 0::2], outk[0::2, 1::2], outk[1::2, 0::2], outk[1::2, 1::2] = e0, e1, e2, e3
    return keys_to_img(outk)


def scale3x(img: np.ndarray) -> np.ndarray:
    """Scale3x (AdvMAME3x): triples size, smoother diagonals, no new colours."""
    k = pack(img)
    h, w = k.shape
    P = np.pad(k, 1, mode="edge")
    A, B, C = P[:-2, :-2], P[:-2, 1:-1], P[:-2, 2:]
    D, E, F = P[1:-1, :-2], P[1:-1, 1:-1], P[1:-1, 2:]
    G, H, I = P[2:, :-2], P[2:, 1:-1], P[2:, 2:]
    cond = (B != H) & (D != F)
    e0 = np.where(cond & (D == B), D, E)
    e1 = np.where(cond & (((D == B) & (E != C)) | ((B == F) & (E != A))), B, E)
    e2 = np.where(cond & (B == F), F, E)
    e3 = np.where(cond & (((D == B) & (E != G)) | ((D == H) & (E != A))), D, E)
    e4 = E
    e5 = np.where(cond & (((B == F) & (E != I)) | ((H == F) & (E != C))), F, E)
    e6 = np.where(cond & (D == H), D, E)
    e7 = np.where(cond & (((D == H) & (E != I)) | ((H == F) & (E != G))), H, E)
    e8 = np.where(cond & (H == F), F, E)
    out = np.zeros((h * 3, w * 3), np.uint32)
    for i, e in enumerate((e0, e1, e2, e3, e4, e5, e6, e7, e8)):
        out[i // 3::3, i % 3::3] = e
    return keys_to_img(out)


def keys_to_img(keys: np.ndarray) -> np.ndarray:
    k = keys.astype(np.uint32)
    return np.stack([(k >> 24) & 255, (k >> 16) & 255, (k >> 8) & 255, k & 255], axis=-1).astype(np.uint8)


def rotsprite(img: np.ndarray, angle_deg: float, pivot: tuple[float, float] | None = None) -> np.ndarray:
    """RotSprite-style rotation: Scale2x three times (8x), rotate by nearest
    neighbour there, then sample back down. Keeps lines unbroken and adds no
    colours, unlike plain nearest-neighbour rotation. Output is the same size
    as the input, rotated about `pivot` (default: centre of the opaque pixels).
    """
    h, w = img.shape[:2]
    if pivot is None:
        b = bbox(opaque(img))
        pivot = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2) if b else (w / 2, h / 2)
    big = scale2x(scale2x(scale2x(img)))
    K = 8
    th = np.radians(angle_deg)
    cos, sin = np.cos(th), np.sin(th)
    # For each output pixel centre, find the source position in the 8x image.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    cx, cy = xx + 0.5 - pivot[0], yy + 0.5 - pivot[1]
    sx = cos * cx + sin * cy + pivot[0]
    sy = -sin * cx + cos * cy + pivot[1]
    bx = np.floor(sx * K).astype(int)
    by = np.floor(sy * K).astype(int)
    valid = (bx >= 0) & (by >= 0) & (bx < w * K) & (by < h * K)
    out = np.zeros_like(img)
    out[valid] = big[by[valid], bx[valid]]
    return out


def rotate_nearest(img: np.ndarray, angle_deg: float, pivot=None) -> np.ndarray:
    h, w = img.shape[:2]
    if pivot is None:
        pivot = (w / 2, h / 2)
    th = np.radians(angle_deg)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    cx, cy = xx + 0.5 - pivot[0], yy + 0.5 - pivot[1]
    sx = np.floor(np.cos(th) * cx + np.sin(th) * cy + pivot[0]).astype(int)
    sy = np.floor(-np.sin(th) * cx + np.cos(th) * cy + pivot[1]).astype(int)
    valid = (sx >= 0) & (sy >= 0) & (sx < w) & (sy < h)
    out = np.zeros_like(img)
    out[valid] = img[sy[valid], sx[valid]]
    return out


def resample_nearest(img: np.ndarray, sx: float, sy: float, anchor: tuple[float, float]) -> np.ndarray:
    """Scale content by (sx, sy) about anchor, nearest neighbour, same canvas size."""
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    srcx = np.floor((xx + 0.5 - anchor[0]) / sx + anchor[0]).astype(int)
    srcy = np.floor((yy + 0.5 - anchor[1]) / sy + anchor[1]).astype(int)
    valid = (srcx >= 0) & (srcy >= 0) & (srcx < w) & (srcy < h)
    out = np.zeros_like(img)
    out[valid] = img[srcy[valid], srcx[valid]]
    return out


def translate(img: np.ndarray, dx: int, dy: int, wrap: bool = False) -> np.ndarray:
    if wrap:
        return np.roll(np.roll(img, dy, axis=0), dx, axis=1)
    return shift(img, -dx, -dy, 0)


# --- dithering --------------------------------------------------------------------------

def bayer(n: int) -> np.ndarray:
    m = np.array([[0, 2], [3, 1]], dtype=np.float64)
    while m.shape[0] < n:
        k = m.shape[0]
        m = np.block([[4 * m, 4 * m + 2], [4 * m + 3, 4 * m + 1]])
    return (m + 0.5) / (m.shape[0] ** 2)


def quantize(img: np.ndarray, palette: list[tuple[int, int, int]], method: str = "none",
             strength: float = 1.0, mask: np.ndarray | None = None) -> np.ndarray:
    """Map pixels to the palette in OKLab, optionally dithering.

    method: none, bayer2, bayer4, bayer8, floyd (Floyd-Steinberg), atkinson.
    strength scales the dither (0 = plain nearest, 1 = full).
    """
    pal = np.array(palette, dtype=np.float64)
    plab = cs.rgb_to_oklab(pal)
    h, w = img.shape[:2]
    work = mask if mask is not None else opaque(img)
    lab = lab_image(img)
    out = img.copy()
    if method.startswith("bayer"):
        n = int(method[5:] or 4)
        thr = bayer(n)
        tile = np.tile(thr, (h // n + 1, w // n + 1))[:h, :w]
        # Each pixel mixes its two nearest palette colours: the share of the
        # second one follows how close the pixel is to it (at most 50%), and
        # the Bayer threshold decides which pixels of the area take it.
        flat = lab[work]
        if len(plab) < 2 or len(flat) == 0:
            idx = cs.nearest_indices(flat, plab) if len(flat) else np.zeros(0, int)
            out[work, :3] = pal[idx].astype(np.uint8)
            return out
        d = ((flat[:, None, :] - plab[None]) ** 2).sum(-1)
        order = np.argsort(d, axis=1)
        i1, i2 = order[:, 0], order[:, 1]
        d1 = np.sqrt(d[np.arange(len(flat)), i1])
        d2 = np.sqrt(d[np.arange(len(flat)), i2])
        share = d1 / np.maximum(d1 + d2, 1e-9)   # 0 = exactly c1, 0.5 = halfway to c2
        pick = np.where(tile[work] < share * strength, i2, i1)
        out[work, :3] = pal[pick].astype(np.uint8)
        return out
    if method in ("floyd", "atkinson"):
        buf = lab.copy()
        idx_img = np.zeros((h, w), np.int32)
        if method == "floyd":
            kernel = [(1, 0, 7 / 16), (-1, 1, 3 / 16), (0, 1, 5 / 16), (1, 1, 1 / 16)]
        else:
            kernel = [(1, 0, 1 / 8), (2, 0, 1 / 8), (-1, 1, 1 / 8), (0, 1, 1 / 8), (1, 1, 1 / 8), (0, 2, 1 / 8)]
        for y in range(h):
            for x in range(w):
                if not work[y, x]:
                    continue
                v = buf[y, x]
                j = int(((plab - v) ** 2).sum(-1).argmin())
                idx_img[y, x] = j
                err = (v - plab[j]) * strength
                for dx, dy, f in kernel:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and ny < h and work[ny, nx]:
                        buf[ny, nx] += err * f
        out[work, :3] = pal[idx_img[work]].astype(np.uint8)
        return out
    idx = cs.nearest_indices(lab[work], plab)
    out[work, :3] = pal[idx].astype(np.uint8)
    return out


# --- outline ------------------------------------------------------------------------------

def outline(img: np.ndarray, color=None, style: str = "fixed", placement: str = "outside",
            corners: bool = False, light=(-1.0, -1.0), darken: float = 0.28,
            region_mask: np.ndarray | None = None) -> np.ndarray:
    """Add a 1 px outline.

    style:
      fixed     - one colour (`color`)
      colored   - each outline pixel is a dark, hue-shifted version of the fill
                  it touches (softer than black, keeps materials readable)
      selective - like colored, but lighter on the side facing the light and
                  darkest on the shadow side ("sel-out")
    placement: outside (grow the shape) or inside (recolour its edge pixels).
    corners: also outline diagonal-only neighbours (boxier); False is rounder.
    """
    m = opaque(img)
    if region_mask is not None:
        m = m & region_mask
    out = img.copy()
    nb = N8 if corners else N4
    if placement == "inside":
        target = m & ~np.ones_like(m)
        for dx, dy in nb:
            target |= m & ~shift(opaque(img), dx, dy, False)
    else:
        target = np.zeros_like(m)
        for dx, dy in nb:
            target |= ~opaque(img) & shift(m, dx, dy, False)
    ys, xs = np.nonzero(target)
    h, w = m.shape
    lx, ly = light
    ln = (lx * lx + ly * ly) ** 0.5 or 1.0
    lx, ly = lx / ln, ly / ln
    if style == "fixed":
        out[target] = (*color[:3], 255)
        return out
    # First pick, per outline pixel, the fill it belongs to and (selective) its
    # light step; then smooth the steps along the line so no single pixel of
    # a different shade is left on its own.
    src_of = {}
    step = np.zeros(m.shape, np.int32)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if placement == "inside":
            src = tuple(int(v) for v in img[y, x, :3])
            nx_ = sum(dx for dx, dy in N8 if not (0 <= x + dx < w and 0 <= y + dy < h) or not m[y + dy, x + dx])
            ny_ = sum(dy for dx, dy in N8 if not (0 <= x + dx < w and 0 <= y + dy < h) or not m[y + dy, x + dx])
        else:
            neigh = [(dx, dy) for dx, dy in N8 if 0 <= x + dx < w and 0 <= y + dy < h and m[y + dy, x + dx]]
            cnt = Counter(tuple(int(v) for v in img[y + dy, x + dx, :3]) for dx, dy in neigh)
            src = cnt.most_common(1)[0][0]
            nx_ = -sum(dx for dx, _ in neigh)
            ny_ = -sum(dy for _, dy in neigh)
        src_of[(x, y)] = src
        if style == "selective":
            nl = (nx_ * nx_ + ny_ * ny_) ** 0.5 or 1.0
            facing = (nx_ / nl) * lx + (ny_ / nl) * ly    # +1 = edge faces the light
            step[y, x] = 1 if facing > 0.3 else -1
    if style == "selective":
        step = majority_filter(np.where(target, step, 9), target, 2)
    cache = {}
    for y, x in zip(ys.tolist(), xs.tolist()):
        src = src_of[(x, y)]
        # two steps only (lit / shadow): at most two outline shades per fill colour
        amt = darken * {1: 0.62, -1: 1.1}.get(int(step[y, x]), 1.0) if style == "selective" else darken
        key = (src, round(amt, 3))
        if key not in cache:
            L, C, hh = cs.oklab_to_oklch(cs.rgb_to_oklab(np.array(src, dtype=np.float64)))
            nL = max(0.08, L - amt) if L > 0.25 else max(0.04, L * 0.55)
            hh2 = cs._hue_toward(hh, cs.SHADOW_HUE, 18) if C > 0.02 else hh
            cache[key] = cs.oklch_to_rgb_gamut(nL, min(C * 0.9, 0.14), hh2)
        out[y, x] = (*cache[key], 255)
    return out


# --- shading --------------------------------------------------------------------------------

def _smooth(a: np.ndarray, mask: np.ndarray, passes: int = 2) -> np.ndarray:
    a = a.copy()
    for _ in range(passes):
        acc = a.copy()
        cnt = np.ones_like(a)
        for dx, dy in N8:
            s = shift(a, dx, dy, 0.0)
            sm = shift(mask, dx, dy, False)
            acc += s * sm
            cnt += sm
        a = np.where(mask, acc / cnt, 0.0)
    return a


def height_map(mask: np.ndarray, radius: float | None = None) -> np.ndarray:
    """Dome-shaped height from distance to the edge: rounded forms, flat tops."""
    d = distance_inside(mask)
    if radius is None:
        radius = max(2.0, float(np.percentile(d[mask], 90)) if mask.any() else 2.0)
    t = np.clip(d / radius, 0, 1)
    return np.sqrt(1 - (1 - t) ** 2) * radius


def normals(height: np.ndarray, mask: np.ndarray) -> np.ndarray:
    hs = _smooth(height, mask, 1)
    gx = (shift(hs, 1, 0, 0.0) - shift(hs, -1, 0, 0.0)) / 2
    gy = (shift(hs, 0, 1, 0.0) - shift(hs, 0, -1, 0.0)) / 2
    n = np.stack([-gx, -gy, np.ones_like(hs)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    n[~mask] = 0
    return n


def light_vector(angle_deg: float, elevation_deg: float = 40.0) -> np.ndarray:
    """Angle 0 = light from the right, 90 = from the top, 135 = from the top-left."""
    a, e = np.radians(angle_deg), np.radians(elevation_deg)
    v = np.array([np.cos(a) * np.cos(e), -np.sin(a) * np.cos(e), np.sin(e)])
    return v / np.linalg.norm(v)


def majority_filter(levels: np.ndarray, mask: np.ndarray, passes: int = 1) -> np.ndarray:
    """Clean isolated shade pixels: a pixel whose level none of its region
    neighbours share takes the most common neighbouring level."""
    out = levels.copy()
    h, w = levels.shape
    for _ in range(passes):
        new = out.copy()
        ys, xs = np.nonzero(mask)
        for y, x in zip(ys.tolist(), xs.tolist()):
            v = out[y, x]
            nb = [out[y + dy, x + dx] for dx, dy in N8
                  if 0 <= x + dx < w and 0 <= y + dy < h and mask[y + dy, x + dx]]
            if nb and v not in nb:
                new[y, x] = Counter(nb).most_common(1)[0][0]
        out = new
    return out
