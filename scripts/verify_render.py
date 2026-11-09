"""Manual verification of flip / crop / volume rendering."""
import json
import subprocess
import time
import urllib.request

API = "http://127.0.0.1:8787"


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
    return {"status": "timeout"}


def main():
    base = {
        "video_id": "mark",
        "start": 0,
        "end": 1,
        "fit_mode": "color",
        "background_color": "#000000",
        "overlays": [],
    }

    results = {}
    for label, extra in {
        "flip": {"flip": True},
        "noflip": {"flip": False},
        "crophalf": {"flip": False, "crop_x": 0.0, "crop_y": 0.0, "crop_width": 0.5, "crop_height": 1.0},
        "crophalf_flip": {"flip": True, "crop_x": 0.0, "crop_y": 0.0, "crop_width": 0.5, "crop_height": 1.0},
    }.items():
        payload = {**base, **extra}
        res = render(payload)
        results[label] = res
        print(label, "->", res["status"], res.get("output", res.get("message"))[:80])

    with open("/tmp/render_results.json", "w") as fh:
        json.dump(results, fh, indent=2)


if __name__ == "__main__":
    main()
