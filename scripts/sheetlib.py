"""Shared helpers for slicing character sheets into transparent sprites.

Kept in one place so make-sprites.py and make-action-sprites.py cannot drift
apart on the background-removal rule.
"""

import numpy as np
from PIL import Image, ImageFilter

TOL = 46
MAX_ITERS = 4000
# 抠完的边是 0/255 硬边，渲染出来是阶梯状毛刺。先腐蚀 1px（把冲击出来的
# 奶油色描边残余切掉，否则在深色桌面上会看到一圈白晕），再高斯羽化做出抗锯齿。
EDGE_ERODE = 1
EDGE_BLUR = 0.6


def flood(free, seeds):
    """Reachability inside `free`, grown from `seeds` (4-way dilation until fixed point)."""
    reach = seeds & free
    for _ in range(MAX_ITERS):
        grown = reach.copy()
        grown[1:, :] |= reach[:-1, :]
        grown[:-1, :] |= reach[1:, :]
        grown[:, 1:] |= reach[:, :-1]
        grown[:, :-1] |= reach[:, 1:]
        grown &= free
        if grown.sum() == reach.sum():
            break
        reach = grown
    return reach


def box_mean(mask, r):
    """Mean of `mask` over a (2r+1) square window, via an integral image."""
    m = mask.astype(np.float64)
    ii = np.pad(m.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    H, W = m.shape
    ys, ye = np.clip(np.arange(H) - r, 0, H), np.clip(np.arange(H) + r + 1, 0, H)
    xs, xe = np.clip(np.arange(W) - r, 0, W), np.clip(np.arange(W) + r + 1, 0, W)
    total = ii[np.ix_(ye, xe)] - ii[np.ix_(ys, xe)] - ii[np.ix_(ye, xs)] + ii[np.ix_(ys, xs)]
    area = (ye - ys)[:, None] * (xe - xs)[None, :]
    return total / area


def keep_bottom_component(rgba, rows=8):
    """Drop everything not connected to the figure's lowest band.

    On a "card" style sheet the panel frame walls off the interior paper, so the
    border flood fill cannot reach it; and the badge, title, bubble, sparkles and
    the frame line are all separate opaque islands. Seeding a flood from the
    lowest opaque band (where the figure's feet are) keeps exactly the artwork and
    removes every island — no text heuristics, no connected-component library.

    Returns (rgba, dropped_fraction).
    """
    opaque = rgba[:, :, 3] > 8
    if not opaque.any():
        return rgba, 0.0
    rows_with_ink = np.nonzero(opaque.any(axis=1))[0]
    bottom = int(rows_with_ink.max())
    seed = np.zeros_like(opaque)
    y0 = max(0, bottom - rows + 1)
    seed[y0 : bottom + 1, :] = opaque[y0 : bottom + 1, :]
    keep = flood(opaque, seed)
    out = rgba.copy()
    out[~keep, 3] = 0
    dropped = float((opaque & ~keep).mean())
    return out, dropped


def cut_alpha(rgb, bg, tol=TOL, feather=True, extra_seed=None):
    """Transparent-out the paper background reachable from the crop border.

    Only pixels that are (a) close to the sheet's own paper colour and
    (b) connected to the crop edge are removed, so enclosed cream areas — the
    white dress — stay opaque. Returns (rgba array, transparent fraction).
    """
    dist = np.abs(rgb.astype(np.int16) - bg).sum(axis=2)
    free = dist < tol
    reach = np.zeros_like(free)
    reach[0, :] = free[0, :]
    reach[-1, :] = free[-1, :]
    reach[:, 0] = free[:, 0]
    reach[:, -1] = free[:, -1]
    if extra_seed is not None:
        # 已判定为"文字/气泡"的像素也当种子：它们该变透明，不能只靠边缘连通
        reach |= extra_seed
    for _ in range(MAX_ITERS):
        grown = reach.copy()
        grown[1:, :] |= reach[:-1, :]
        grown[:-1, :] |= reach[1:, :]
        grown[:, 1:] |= reach[:, :-1]
        grown[:, :-1] |= reach[:, 1:]
        grown &= free
        if grown.sum() == reach.sum():
            break
        reach = grown

    alpha = np.where(reach, 0, 255).astype(np.uint8)
    if feather:
        img = Image.fromarray(alpha, "L")
        for _ in range(max(0, EDGE_ERODE)):
            img = img.filter(ImageFilter.MinFilter(3))
        if EDGE_BLUR > 0:
            img = img.filter(ImageFilter.GaussianBlur(EDGE_BLUR))
        alpha = np.asarray(img, dtype=np.uint8)
    return np.dstack([rgb, alpha]), float(reach.mean())


def profile(vec, buckets, scale=9):
    edges = np.linspace(0, len(vec), buckets + 1).astype(int)
    out = []
    for i in range(buckets):
        seg = vec[edges[i] : edges[i + 1]]
        out.append(int(round(scale * seg.mean())) if len(seg) else 0)
    return "".join(str(d) for d in out)


def runs_of(flags, min_len):
    out = []
    start = None
    for i, v in enumerate(flags):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_len:
                out.append((start, i))
            start = None
    if start is not None and len(flags) - start >= min_len:
        out.append((start, len(flags)))
    return out