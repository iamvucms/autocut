"""Verify flip + crop by comparing marker positions against the source."""
import json
import subprocess
import time
import urllib.request

import numpy as np
from PIL import Image

API = "http://127.0.0.1:8787"
FF = (
    "/Library/Frameworks/Python.framework/Versions/3.13/lib/python3.13/site-packages/"
    "static_ffmpeg/bin/darwin_arm64/ffmpeg"
)


def post(path, payload):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req).read())


def get(path):
    return json.loads(urllib.request.urlopen(API + path).read())


def render(payload):
    job = post("/api/render", payload)["job_id"]
    for _ in range(120):
        data = get(f"/api/jobs/{job}")
        if data["status"] in ("done", "error"):
            return data
        time.sleep(0.5)
    raise RuntimeError("timeout")


def frame(path, out):
    subprocess.run([FF, "-y", "-v", "error", "-i", path, "-frames:v", "1", out], check=True)
    return np.asarray(Image.open(out).convert("RGB"), dtype=float)


def marker_x(arr):
    """Return (green_centroid_x, red_centroid_x) or None where absent."""
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    green = (g > 170) & (r < 100) & (b < 100)
    red = (r > 170) & (g < 100) & (b < 100)
    out = []
    for mask in (green, red):
        if mask.sum() < 50:
            out.append(None)
        else:
            ys, xs = np.nonzero(mask)
            out.append(float(xs.mean()))
    return tuple(out)


def main():
    base = {
        "video_id": "mark",
        "start": 0,
        "end": 1,
        "fit_mode": "color",
        "background_color": "#000000",
        "overlays": [],
    }
    cases = {
        "noflip": {"flip": False},
        "flip": {"flip": True},
        "crophalf": {"flip": False, "crop_x": 0.0, "crop_y": 0.0, "crop_width": 0.5, "crop_height": 1.0},
        "crophalf_flip": {"flip": True, "crop_x": 0.0, "crop_y": 0.0, "crop_width": 0.5, "crop_height": 1.0},
    }

    print(f"{'case':16} {'green_x':>9} {'red_x':>9}   verdict")
    for label, extra in cases.items():
        res = render({**base, **extra})
        assert res["status"] == "done", res
        arr = frame("data" + res["output"].replace("/api/files", "/outputs"), f"/tmp/m_{label}.png")
        gx, rx = marker_x(arr)
        verdict = "flip OK" if (rx is not None and gx is not None and rx < gx) else "flip NOT applied"
        if label.startswith("crophalf"):
            verdict = "crop+flip OK" if (rx is not None and gx is not None and rx < gx) else "crop/flip check"
        print(f"{label:16} {str(round(gx,1) if gx else None):>9} {str(round(rx,1) if rx else None):>9}   {verdict}")


if __name__ == "__main__":
    main()
