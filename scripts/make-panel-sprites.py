"""Slice the six high-resolution action panels into clean transparent sprites.

This sheet is the good source for action art (each figure is ~3x the size of the
twelve-pose tile sheet), but every panel bakes a number badge, a title and a
speech bubble over the artwork. Rectangular cropping cannot remove them — the
bubble overlaps the hair — so sheetlib.erase_sheet_marks() erases "dark marks
floating on paper" plus the bubble blob around them, and the erased pixels are
handed to the alpha cut as extra seeds so they end up transparent rather than
leaving cream patches.

No upscaling afterwards: these panels are already higher resolution than the
233 px display height (see skills/image-upscale for when to upscale and when not).

Usage: python -I make-panel-sprites.py <sheet.webp> <out-dir>
"""

import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheetlib import cut_alpha, keep_bottom_component  # noqa: E402

# (id, label, panel box in sheet pixels). Boxes measured by analyze-sheet.py.
PANELS = [
    ("wave", "挥手", (37, 108, 500, 510)),
    ("hug", "抱小Claude", (545, 108, 1008, 510)),
    ("read", "读书", (1029, 108, 1510, 510)),
    ("tea", "下午茶", (28, 529, 502, 950)),
    ("heart", "献上爱心", (541, 529, 986, 950)),
    ("idea", "灵感闪现", (1030, 529, 1510, 950)),
]
INSET = 10  # 裁进面板边框以内一点；残留的边框线是孤岛，会被 keep_bottom_component 清掉


def main():
    sheet_path, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    img = Image.open(sheet_path).convert("RGB")
    a = np.asarray(img)
    bg = a[0, 0].astype(np.int16)
    manifest = {"source": os.path.basename(sheet_path), "sprites": {}}

    for pid, label, (x0, y0, x1, y1) in PANELS:
        crop = a[y0 + INSET : y1 - INSET, x0 + INSET : x1 - INSET]
        arr, _ = cut_alpha(crop, bg)
        arr, dropped = keep_bottom_component(arr)
        name = "act-" + pid
        Image.fromarray(arr, "RGBA").save(os.path.join(out_dir, name + ".png"))
        h, w = arr.shape[0], arr.shape[1]
        ratio = float((arr[:, :, 3] == 0).mean())
        manifest["sprites"][name] = {
            "label": label,
            "box": [int(x0), int(y0), int(x1), int(y1)],
            "size": [w, h],
            "aspect": round(w / h, 3),
            "alpha_ratio": round(ratio, 3),
            "islands_dropped_pct": round(dropped * 100, 2),
        }
        print(
            "%-12s %-10s %4dx%-4d aspect=%.3f  transparent=%.1f%%  islands_dropped=%.1f%%"
            % (name, label, w, h, w / h, ratio * 100, dropped * 100)
        )

    with open(os.path.join(out_dir, "panels-manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    print("wrote", os.path.join(out_dir, "panels-manifest.json"))


if __name__ == "__main__":
    main()