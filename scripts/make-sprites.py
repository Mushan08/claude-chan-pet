"""Slice the Claude-chan design sheet into transparent pet sprites.

Crop boxes come from analyze-sheet.py's measured layout, not from guesswork.
Background removal is a border flood fill restricted to pixels close to the
sheet's own cream paper colour, so enclosed cream areas (the white dress)
stay opaque.

Usage: python -I make-sprites.py <sheet.png> <out-dir>
"""

import json
import os
import sys

import numpy as np
from PIL import Image

# -I 隔离模式隐含 -P：脚本目录不会进 sys.path，所以要自己加
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheetlib import cut_alpha  # noqa: E402

# Measured on sheet-threeview.png (1536x1024) by analyze-sheet.py.
FIGURES = {
    "front": (74, 70, 454, 515),
    "side": (518, 70, 820, 515),
    "back": (860, 70, 1205, 515),
}

# band y613-731 holds ten equally spaced expression cells
FACE_RUNS = [
    (53, 191),
    (201, 341),
    (354, 493),
    (503, 641),
    (649, 787),
    (795, 932),
    (940, 1077),
    (1085, 1222),
    (1229, 1365),
    (1372, 1483),
]
FACE_BAND = (613, 731)
FACE_INSET = 6

PAD = 6


def save(arr, path):
    Image.fromarray(arr, "RGBA").save(path)
    return arr.shape[1], arr.shape[0], float((arr[:, :, 3] == 0).mean())


def main():
    sheet_path, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    img = Image.open(sheet_path).convert("RGB")
    a = np.asarray(img)
    bg = a[0, 0].astype(np.int16)
    manifest = {"source": os.path.basename(sheet_path), "bg": bg.tolist(), "sprites": {}}

    def emit(name, box):
        x0, y0, x1, y1 = box
        crop = a[y0:y1, x0:x1]
        arr, _ = cut_alpha(crop, bg)
        w, h, alpha_ratio = save(arr, os.path.join(out_dir, name + ".png"))
        manifest["sprites"][name] = {
            "box": [int(x0), int(y0), int(x1), int(y1)],
            "size": [w, h],
            "alpha_ratio": round(alpha_ratio, 3),
        }
        flag = "  <-- SUSPICIOUS: figure may have been eaten" if alpha_ratio > 0.75 else ""
        print("%-16s %4dx%-4d box=%s  transparent=%.1f%%%s" % (name, w, h, box, alpha_ratio * 100, flag))

    for name, (x0, y0, x1, y1) in FIGURES.items():
        emit(name, (max(0, x0 - PAD), max(0, y0 - PAD), x1 + PAD, y1 + PAD))

    fb0, fb1 = FACE_BAND
    for i, (x0, x1) in enumerate(FACE_RUNS, start=1):
        emit("face-%02d" % i, (x0 + FACE_INSET, fb0 + FACE_INSET, x1 - FACE_INSET, fb1 - FACE_INSET))

    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    print("wrote", os.path.join(out_dir, "manifest.json"))


if __name__ == "__main__":
    main()