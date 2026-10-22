"""Build transparent WebM emote clips from the four reference mp4s.

Background removal is the same rule as sheetlib.cut_alpha: border flood fill
restricted to pixels close to the clip's own paper colour, so enclosed cream
areas (the white dress) survive. On video the extra step is keeping only the
largest connected component, which drops sparkles, hearts and other floating
decorations that would otherwise hover around the pet.

Usage: python -I make-emote-clips.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "assets", "pet", "anims")
FFMPEG = os.environ.get("FFMPEG_EXE", "ffmpeg")
SRC_DIR = os.environ.get(
    "EMOTE_SRC_DIR",
    r"C:\Users\MushanLuo\Documents\xwechat_files\wxid_corpootnioag22_5f33\msg\video\2026-10",
)

# name -> source file. "tea" is intentionally absent: its tablecloth is the same
# cream as the dress, so it cannot be separated without hand-drawn mattes.
CLIPS = [
    ("hug", "c2c01ae4f52445d32f10af044c443de2.mp4"),
    ("wave", "b5c7dcc949db45860721a8b9c511fccb.mp4"),
    ("love", "7d631366ba9df8823d393fc3e31915e0.mp4"),
    ("read", "0abd31008ab8bf9b15e408944ea18bdc.mp4"),
    # 书桌和手臂是连着的，最大连通域会把桌子一起留下；当地「书桌场景」用，不硬拆
    ("think", "b72a0e8b2f700cee088f908fd7609bc6.mp4"),
]

FPS = 24
TOL = 60
ENCODE_H = 560
PAD = 8


def paper_colour(frame):
    edge = np.concatenate(
        [
            frame[0:3].reshape(-1, 3),
            frame[-3:].reshape(-1, 3),
            frame[:, 0:3].reshape(-1, 3),
            frame[:, -3:].reshape(-1, 3),
        ]
    )
    return np.median(edge, axis=0)


def cut(frame, bg):
    """Return (rgba, alpha_mask) with the paper background and stray islands gone.

    Paper colour is flood-filled from the border, so pockets that are *connected*
    to the outside (the gaps between hair strands) leave with the background,
    while enclosed cream areas (the dress, the plush) stay opaque.
    """
    h, w = frame.shape[:2]
    dist = np.abs(frame.astype(np.int16) - bg.astype(np.int16)).sum(axis=2)

    free = (dist < TOL).astype(np.uint8) * 255
    reach = free.copy()
    scratch = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(reach, scratch, (0, 0), 128)
    fg = np.where(reach == 128, 0, 255).astype(np.uint8)

    count, labels, stats, _ = cv2.connectedComponentsWithStats(fg, 8)
    if count <= 1:
        return np.dstack([frame, np.zeros((h, w), np.uint8)]), np.zeros((h, w), np.uint8)
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = (labels == best).astype(np.uint8) * 255

    # close the small gap a soft outline leaves, then fill interior holes
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

    # hard 0/255 edge reads as stair-steps on a dark desktop: erode 1px + feather
    mask = cv2.erode(mask, np.ones((3, 3), np.uint8), iterations=1)
    mask = cv2.GaussianBlur(mask, (5, 5), 1.0)

    # despill: semi-transparent edge pixels still carry the cream paper colour.
    # Undo the mix F = (C - (1-a)B) / a so the rim stops glowing on dark desktops.
    a = (mask.astype(np.float32) / 255.0)[..., None]
    rgb = frame.astype(np.float32)
    unmixed = (rgb - (1.0 - a) * bg.reshape(1, 1, 3)) / np.maximum(a, 0.10)
    unmixed = np.where(a > 0.02, np.clip(unmixed, 0, 255), rgb)
    return np.dstack([unmixed, mask]).astype(np.uint8), mask


def extract_frames(video, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    subprocess.run(
        [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
         "-i", video, "-vf", f"fps={FPS}", os.path.join(out_dir, "%04d.png")],
        check=True,
    )
    return sorted(f for f in os.listdir(out_dir) if f.endswith(".png"))


def build(name, video, work):
    frame_dir = os.path.join(work, name, "src")
    names = extract_frames(video, frame_dir)
    if not names:
        raise RuntimeError("no frames from " + video)

    first = cv2.imread(os.path.join(frame_dir, names[0]), cv2.IMREAD_COLOR)
    bg = paper_colour(first)

    # pass 1: union bbox over a sample, so the crop stays fixed for the whole clip
    x0 = y0 = 10**9
    x1 = y1 = -1
    for n in names[::3]:
        f = cv2.imread(os.path.join(frame_dir, n), cv2.IMREAD_COLOR)
        _, m = cut(f, bg)
        ys, xs = np.nonzero(m > 8)
        if not len(xs):
            continue
        x0, y0 = min(x0, xs.min()), min(y0, ys.min())
        x1, y1 = max(x1, xs.max()), max(y1, ys.max())
    if x1 < 0:
        raise RuntimeError("empty matte for " + name)

    h, w = first.shape[:2]
    x0, y0 = max(0, x0 - PAD), max(0, y0 - PAD)
    x1, y1 = min(w, x1 + PAD), min(h, y1 + PAD)
    cw, ch = x1 - x0, y1 - y0
    scale = min(1.0, ENCODE_H / float(ch))
    ow, oh = max(2, int(round(cw * scale))), max(2, int(round(ch * scale)))

    out_frames = os.path.join(work, name, "out")
    os.makedirs(out_frames, exist_ok=True)
    for i, n in enumerate(names, start=1):
        f = cv2.imread(os.path.join(frame_dir, n), cv2.IMREAD_COLOR)
        rgba, _ = cut(f, bg)
        crop = rgba[y0:y1, x0:x1]
        if crop.shape[0] != oh or crop.shape[1] != ow:
            crop = cv2.resize(crop, (ow, oh), interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(out_frames, "%04d.png" % i), crop)

    os.makedirs(OUT_DIR, exist_ok=True)
    target = os.path.join(OUT_DIR, name + ".webm")
    subprocess.run(
        [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
         "-framerate", str(FPS), "-i", os.path.join(out_frames, "%04d.png"),
         "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "20",
         "-auto-alt-ref", "0", "-row-mt", "1", target],
        check=True,
    )
    return {
        "file": "anims/%s.webm" % name,
        "w": ow,
        "h": oh,
        "frames": len(names),
        "fps": FPS,
        "seconds": round(len(names) / float(FPS), 2),
        "bytes": os.path.getsize(target),
    }


def main():
    work = tempfile.mkdtemp(prefix="emote-")
    manifest = {"clips": {}, "source": "wechat-2026-10"}
    try:
        for name, fn in CLIPS:
            src = os.path.join(SRC_DIR, fn)
            if not os.path.exists(src):
                print("missing source:", src)
                continue
            info = build(name, src, work)
            manifest["clips"][name] = info
            print("%-5s %dx%d %2d frames  %.1f KB" % (name, info["w"], info["h"], info["frames"], info["bytes"] / 1024.0))
    finally:
        shutil.rmtree(work, ignore_errors=True)

    path = os.path.join(OUT_DIR, "manifest.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    print("wrote", path)


if __name__ == "__main__":
    main()
