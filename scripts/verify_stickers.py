"""Verify sticker overlays land where / when they should in the export.

Runs against a live server (default http://127.0.0.1:8787). Uploads its own
test sticker, renders a few short clips and samples frames to check position,
visibility window and fades.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

API = os.environ.get("AUTOCUT_API", "http://127.0.0.1:8787")
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "outputs"

# The test sticker is solid yellow so it is trivial to detect in a frame.
STICKER_PNG = Path("/tmp/__autocut_verify_sticker.png")


def post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req).read())


def get(path: str) -> dict:
    return json.loads(urllib.request.urlopen(API + path).read())


def upload(path: Path) -> dict:
    boundary = uuid.uuid4().hex
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
        f'filename="{path.name}"\r\nContent-Type: image/png\r\n\r\n'
    ).encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        API + "/api/stickers/upload",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    return json.loads(urllib.request.urlopen(req).read())


def render(payload: dict) -> dict:
    job = post("/api/render", payload)["job_id"]
    for _ in range(240):
        data = get(f"/api/jobs/{job}")
        if data["status"] in ("done", "error"):
            return data
        time.sleep(0.5)
    raise RuntimeError("timeout")


def frame(video: Path, at: float, out: Path) -> np.ndarray:
    from backend.settings import FFMPEG

    subprocess.run(
        [FFMPEG, "-y", "-v", "error", "-ss", f"{at:.3f}", "-i", str(video), "-frames:v", "1", str(out)],
        check=True,
    )
    return np.asarray(Image.open(out).convert("RGB"), dtype=float)


def yellow_centroid(arr: np.ndarray):
    """Centre of the test sticker (255,200,0) or None when absent."""
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    mask = (r > 200) & (g > 150) & (g < 230) & (b < 90)
    if mask.sum() < 200:
        return None
    ys, xs = np.nonzero(mask)
    return float(xs.mean()), float(ys.mean()), int(mask.sum())


def make_sticker() -> Path:
    img = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    ImageDraw.Draw(img).rectangle([20, 20, 180, 180], fill=(255, 200, 0, 255))
    img.save(STICKER_PNG)
    return STICKER_PNG


def make_animated_sticker() -> Path:
    """A short GIF whose frames cycle through distinct hues.

    Sampling the sticker's mean colour over time then tells us whether the
    export really animated it, rather than freezing on the first frame.
    """
    out = Path("/tmp/__autocut_verify_sticker.gif")
    frames = []
    for i in range(10):
        img = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        # 0 -> red, mid -> green, end -> blue.
        t = i / 9
        colour = (
            int(255 * max(0.0, 1 - 2 * t)) if t < 0.5 else 0,
            int(255 * max(0.0, 2 * t)) if t < 0.5 else int(255 * max(0.0, 2 - 2 * t)),
            int(255 * max(0.0, 2 * t - 1)),
            255,
        )
        draw.rectangle([20, 20, 180, 180], fill=colour)
        frames.append(img)
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=60, loop=0, disposal=2)
    return out


def make_apng_sticker() -> Path:
    """An APNG deliberately saved with a `.png` extension.

    This is how browsers and most sites hand out APNGs, and it used to be
    misread as a still image: the export then passed `-loop` to a demuxer that
    does not accept it and lost the sticker entirely.
    """
    out = Path("/tmp/__autocut_verify_sticker_apng.png")
    frames = []
    for i in range(10):
        img = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        t = i / 9
        draw.rectangle([20, 20, 180, 180], fill=(int(255 * t), 80, int(255 * (1 - t)), 255))
        frames.append(img)
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=60, loop=0)
    return out


def sticker_colour(arr: np.ndarray, box=(0.3, 0.7, 0.3, 0.7)) -> np.ndarray:
    """Mean colour inside the sticker area (default: centre third)."""
    y0, y1, x0, x1 = box
    h, w, _ = arr.shape
    region = arr[int(h * y0):int(h * y1), int(w * x0):int(w * x1)]
    return region.reshape(-1, 3).mean(axis=0)


def main() -> int:
    static = upload(make_sticker())
    animated = upload(make_animated_sticker())

    if not animated.get("animated"):
        print("animated probe failed: file reported as still")
        return 1
    if not animated.get("sheet"):
        print("animated preview sheet missing")
        return 1
    print(
        f"animated   ok                       "
        f"{animated['frames']} khung @ {animated['fps']:.1f}fps, sheet {animated['sheet']}"
    )

    videos = get("/api/videos")
    if not videos:
        print("No source videos in the library.")
        return 1
    video_id = videos[0]["id"]

    base = {
        "video_id": video_id,
        "start": 0,
        "end": 2,
        "fit_mode": "crop",
        "flip": False,
        "overlays": [],
    }

    cases = {
        "centre": (dict(sticker=static["name"], x=0.5, y=0.5, width=0.4), [0.5, 1.0], "centre"),
        "top-left": (dict(sticker=static["name"], x=0.15, y=0.15, width=0.25), [0.5], "top-left"),
        "window": (
            dict(sticker=static["name"], x=0.5, y=0.8, width=0.3, start=0.8, end=1.4),
            [0.3, 1.0, 1.8],
            "timed",
        ),
        "rotated": (dict(sticker=static["name"], x=0.5, y=0.5, width=0.35, rotation=45), [0.6], "rotated"),
        "faded": (
            dict(sticker=static["name"], x=0.5, y=0.5, width=0.4, fade_in=0.6, fade_out=0.6, end=2.0),
            [0.05, 1.0, 1.8],
            "fade",
        ),
    }

    failures = 0
    for label, (st, times, kind) in cases.items():
        res = render({**base, "stickers": [st]})
        if res["status"] != "done":
            print(f"{label:10} RENDER FAILED: {res.get('message')}")
            failures += 1
            continue
        out = OUT_DIR / res["filename"]
        case_label = label
        samples = []
        for t in times:
            arr = frame(out, t, Path(f"/tmp/st_{label}_{t}.png"))
            samples.append((t, yellow_centroid(arr), arr.shape))

        verdict = "ok"
        if kind == "centre":
            for _, c, shape in samples:
                if not c or abs(c[0] - shape[1] / 2) > shape[1] * 0.05:
                    verdict = "sticker not centred"
        elif kind == "top-left":
            _, c, shape = samples[0]
            if not c or c[0] > shape[1] * 0.35 or c[1] > shape[0] * 0.35:
                verdict = "sticker not top-left"
        elif kind == "timed":
            vis = [bool(c) for _, c, _ in samples]
            if vis != [False, True, False]:
                verdict = f"visibility window wrong: {vis}"
        elif kind == "rotated":
            _, c, _ = samples[0]
            if not c:
                verdict = "rotated sticker missing"
            elif c[2] < 10000:
                verdict = f"rotated sticker too small: {c[2]}px"
        elif kind == "fade":
            counts = [c[2] if c else 0 for _, c, _ in samples]
            if not (counts[0] < counts[1] and counts[2] < counts[1]):
                verdict = f"fade not applied: {counts}"

        if verdict != "ok":
            failures += 1
        detail = ", ".join(f"t={t}:{'visible' if c else 'hidden'}" for t, c, _ in samples)
        print(f"{label:10} {verdict:24} {detail}")

    # --- animated GIF: the export must actually play the frames ----------
    # Dense, non-periodic sampling so a short loop cannot alias into "no
    # change" (sampling every 0.25s would land on the same frame index).
    anim_times = [0.12 + i * 0.037 for i in range(20)]
    failures += check_animates("animating GIF", animated["name"], base, anim_times)

    # --- APNG saved as .png: detection must go by content, not suffix ---
    apng = upload(make_apng_sticker())
    if not apng.get("animated"):
        print(f"{'apng-as-png':10} FAILED                 file reported as still")
        failures += 1
    else:
        print(f"{'apng-as-png':10} ok                     {apng['frames']} khung (nhận diện theo nội dung)")
        failures += check_animates("animating APNG", apng["name"], base, anim_times)

    print("\nOK" if failures == 0 else f"\n{failures} case(s) failed")
    # Leave the library as we found it.
    for entry in (static, animated, apng):
        try:
            urllib.request.urlopen(
                urllib.request.Request(
                    API + "/api/stickers/" + urllib.parse.quote(entry["name"]),
                    method="DELETE",
                )
            )
        except Exception:
            pass
    return 0 if failures == 0 else 1


def check_animates(label: str, sticker: str, base: dict, times: list[float]) -> int:
    """Render one clip and confirm the sticker's colours actually change."""
    res = render({**base, "stickers": [dict(sticker=sticker, x=0.5, y=0.5, width=0.5)]})
    if res["status"] != "done":
        print(f"{label:10} RENDER FAILED: {str(res.get('message'))[:110]}")
        return 1
    out = OUT_DIR / res["filename"]
    colours = np.array([sticker_colour(frame(out, t, Path(f"/tmp/st_anim_{t}.png"))) for t in times])
    # Span of each channel across the clip: a frozen sticker stays flat.
    spread = float((colours.max(axis=0) - colours.min(axis=0)).mean())
    if spread <= 3.0:
        print(f"{label:10} FROZEN                 spread {spread:.2f}")
        return 1
    print(f"{label:10} ok                     spread {spread:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
