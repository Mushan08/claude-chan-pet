"""Slice the twelve action poses out of the closet sheet into transparent sprites.

Boxes come from analyze-sheet.py run over the block region (20,400)-(680,750):
the caption row under each tile gave six evenly spaced centres, so the columns
are a uniform grid; the caption bands are excluded by clipping y.

Usage: python -I make-action-sprites.py <sheet.webp> <out-dir>
"""

import json
import os
import sys

import numpy as np
from PIL import Image

# -I 隔离模式隐含 -P：脚本目录不会进 sys.path，所以要自己加，否则 import 不到同目录的 sheetlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheetlib import cut_alpha  # noqa: E402

# Original-image coordinates. Row 1 stops at y=574 so the caption band (578-589)
# is left out; row 2 stops at y=739 for the same reason.
ROW1_Y = (420, 574)
ROW2_Y = (602, 739)
ROW1_CENTERS = [72, 178, 285, 393, 502, 610]  # from the caption centres, pitch ~107
HALF = 53
ROW2_X = [(21, 133), (139, 232), (236, 340), (342, 456), (461, 560), (563, 664)]

ROW1_NAMES = ["act-01", "act-02", "act-03", "act-04", "act-05", "act-06"]
ROW2_NAMES = ["act-07", "act-08", "act-09", "act-10", "act-11", "act-12"]

# 按格子序号命名而不是按"姿势名"：设定稿的标题行和图上画的姿势并不总是一致
# （实测第二行第 2 格画的是抱着小玩偶，标题却不是"抱抱"），所以只记录我肉眼看图
# 得到的描述。命名错一个只会影响配置里一个映射值，不会被当成事实传播。
POSE_NOTES = [
    ("act-01", "站立，双手垂放"),
    ("act-02", "坐下，抱膝"),
    ("act-03", "蹲下，单手抬到脸旁"),
    ("act-04", "躺下，抱着小玩偶"),
    ("act-05", "站立抱着小玩偶，闭眼笑"),
    ("act-06", "双手比心，张嘴"),
    ("act-07", "挥手打招呼"),
    ("act-08", "抱着小玩偶，闭眼"),
    ("act-09", "站立张嘴，像在说话"),
    ("act-10", "双手交叠在胸前，像在思考"),
    ("act-11", "单手抬到脸旁，像端着杯"),
    ("act-12", "低头看书"),
]


def main():
    sheet_path, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    img = Image.open(sheet_path).convert("RGB")
    a = np.asarray(img)
    bg = a[0, 0].astype(np.int16)
    manifest = {"source": os.path.basename(sheet_path), "sprites": {}}

    def emit(name, box):
        x0, y0, x1, y1 = box
        crop = a[y0:y1, x0:x1]
        arr, _ = cut_alpha(crop, bg)
        out = os.path.join(out_dir, name + ".png")
        Image.fromarray(arr, "RGBA").save(out)
        h, w = arr.shape[0], arr.shape[1]
        ratio = float((arr[:, :, 3] == 0).mean())
        manifest["sprites"][name] = {
            "box": [int(x0), int(y0), int(x1), int(y1)],
            "size": [w, h],
            "aspect": round(w / h, 3),
            "alpha_ratio": round(ratio, 3),
        }
        flag = ""
        if ratio > 0.8:
            flag = "  <-- SUSPICIOUS: figure may have been eaten"
        elif ratio < 0.12:
            flag = "  <-- SUSPICIOUS: background may not have been removed"
        print("%-16s %4dx%-4d aspect=%.3f  transparent=%.1f%%%s" % (name, w, h, w / h, ratio * 100, flag))

    for name, cx in zip(ROW1_NAMES, ROW1_CENTERS):
        emit(name, (cx - HALF, ROW1_Y[0], cx + HALF, ROW1_Y[1]))
    for name, (x0, x1) in zip(ROW2_NAMES, ROW2_X):
        emit(name, (x0, ROW2_Y[0], x1, ROW2_Y[1]))

    manifest["pose_notes"] = dict(POSE_NOTES)

    with open(os.path.join(out_dir, "actions-manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    print("wrote", os.path.join(out_dir, "actions-manifest.json"))


if __name__ == "__main__":
    main()