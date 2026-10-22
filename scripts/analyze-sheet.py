"""Coarse layout analysis of a character-sheet image.

Prints, as plain numbers, where the content sits so that crop boxes can be
derived instead of guessed: a row/column density profile, the horizontal
content bands, and the column runs inside each band.

Usage: python -I analyze-sheet.py <image> [x0 y0 x1 y1]

Passing a region measures only that sub-rectangle (in original image pixels),
which is how you isolate a block whose neighbours are too close for the
full-image bands to separate.
"""

import sys

import numpy as np
from PIL import Image


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


def main():
    path = sys.argv[1]
    img = Image.open(path).convert("RGB")
    if len(sys.argv) >= 6:
        x0, y0, x1, y1 = (int(v) for v in sys.argv[2:6])
        img = img.crop((x0, y0, x1, y1))
        print("region: %d,%d %d,%d" % (x0, y0, x1, y1))
    a = np.asarray(img).astype(np.int16)
    h, w, _ = a.shape

    bg = a[0, 0]
    mask = np.abs(a - bg).sum(axis=2) > 40

    print("size:", w, h)
    print("corner bg:", bg.tolist())
    print("content ratio: %.3f" % mask.mean())
    print("row density  /64:", profile(mask.sum(axis=1) / w, 64))
    print("col density  /64:", profile(mask.sum(axis=0) / h, 64))

    bands = runs_of(mask.sum(axis=1) > w * 0.03, 8)
    print("bands:", bands)
    for y0, y1 in bands:
        sub = mask[y0:y1]
        print(
            "  band %d-%d (h=%d) col runs:" % (y0, y1, y1 - y0),
            runs_of(sub.sum(axis=0) > (y1 - y0) * 0.08, 6),
        )


if __name__ == "__main__":
    main()