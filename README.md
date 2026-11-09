# AutoCut

A video cutting and 9:16 Shorts publishing tool. Python backend (FastAPI + ffmpeg) with a plain web UI (no build step required).

## Run

```bash
./run.sh
```

Then open <http://127.0.0.1:8787>. The UI is currently in Vietnamese; the button labels quoted below are shown with an English gloss.

Requires Python 3.10+. ffmpeg is discovered automatically in this order: `ffmpeg` on `PATH` → `static-ffmpeg` (pip) → `imageio-ffmpeg` (pip). If you don't have it yet:

```bash
pip install -r requirements.txt
# or
brew install ffmpeg
```

## The three-step workflow

1. **Pick a video** — drag and drop files onto the drop zone (multiple files at once, with upload progress percentage), click Upload, paste a local path, or choose from the library. Non-video files are skipped. The list shows a poster thumbnail, duration, and resolution.
2. **Trim** — set the start / end points with sliders, the draggable timeline bar, or the "Đặt điểm bắt đầu / kết thúc" (set start / end) buttons at the current playback position. The `←` / `→` keys nudge by one frame (0.05s).
3. **Fill 9:16 & Overlay** — choose a background fill mode, add text / cover boxes / stickers, preview live on the 9:16 canvas, then export MP4.

## 9:16 background fill options

| Mode | Result |
|---|---|
| **Blur nền** (blur background) | The source keeps its aspect ratio in the center; the surrounding area is a blurred copy of the same frame (adjustable blur + zoom) |
| **Màu** (color) | The source keeps its aspect ratio in the center; the surrounding area is filled with a custom color |
| **Crop xuyên** (crop through) | The video covers the full 9:16 frame, cropping the excess on both sides |

### Source settings

| Option | Default | Notes |
|---|---|---|
| **Lật ngang** (horizontal flip) | ✅ On | `hflip` in ffmpeg — use when the source was recorded mirrored |
| **Âm lượng** (volume) | 70% | 0–200% slider, applied via the `volume` filter |
| **Độ nén (CRF)** (compression) | 18 | Only used when bitrate = 0 |
| **FPS** (API only) | Keep source | `fps: 0` = follow source, set a value > 0 to force |
| **Tốc độ** (speed) | 1.02x | Very slight change (+2%). Range 0.5x–2x. Video uses `setpts`, audio uses `atempo` |
| **Độ sáng** (brightness) | +0.02 | Range ±0.30 via `eq=brightness` |
| **Nhiễu nhẹ** (light grain) | 2 | Range 0–20, `noise=alls=N:allf=t+u` filter on the final frame (after overlay). 0 = off |
| **Độ nét** (sharpness) | 0.30 | 0–1, `cas` filter (Contrast Adaptive Sharpening) applied only to the main video layer, before overlay and grain. Scaling always uses Lanczos. 0 = cas off |
| **Bitrate video** | 4000 kbps | 0 = use CRF; > 0 = `-b:v` (with `maxrate`/`bufsize`), capped at 12000 kbps in the UI |

### Crop vùng nguồn (source crop)

Choose a region to cut from the **original video** before the 9:16 fill.

- **4 sliders** (X, Y, Rộng / width, Cao / height)
- **Drag corners** (`tl`/`tr`/`bl`/`br`) — changes both dimensions
- **Drag edges** (`t`/`b`/`l`/`r`) — changes one dimension, keeping the opposite edge fixed
- **Đặt lại crop** (reset crop) restores the full frame

The crop region uses normalized 0..1 coordinates, so it applies correctly at any output size.

Processing order in ffmpeg: **crop → flip → brightness → speed → 9:16 fill → overlay → grain**. Output is always re-encoded with libx264. The web preview mirrors this exact order.

## Export progress

Clicking **Xuất video** (export video) shows a full-screen overlay with:

- An SVG progress ring plus the percentage
- A horizontal progress bar
- Status and an **estimated time remaining** (ETA) — e.g. `Đang xuất 42% · còn ~3s` ("exporting 42% · ~3s left")
- On success: the ring turns green and a **Tải video** (download video) button appears
- On failure: the ring turns red and the ffmpeg error message is shown

The backend reads progress from ffmpeg's `-progress pipe:1` and derives the ETA from elapsed time.

## Overlay

- **Chữ** (text): content, font (Arial, Arial Black, Impact, Verdana, Helvetica, Georgia, Times, Courier), color, size (% of frame height), bold, opacity, rotation. Drag directly on the preview canvas to position it.
- **Khung che** (cover box): an opaque rectangle to hide logos/watermarks — color, opacity, position, size.
- **Sticker**: see the [Sticker](#sticker) section below.

Overlay coordinates are stored as normalized 0..1 values, so they render correctly at any export size.

## Sticker

Attach image stickers to the 9:16 canvas. The sticker library lives in `data/stickers/`.

- **Upload from file** — the "⬆ Tải sticker từ file" (upload sticker from file) button accepts PNG / JPG / WEBP / GIF / BMP / AVIF / APNG, or short videos (MP4 / WEBM / MOV). Multiple files at once.
- **Import from disk** — paste an absolute path to a sticker file.
- **Add to canvas** — click a sticker in the library to place it on the canvas. Drag directly on the preview to move it; drag the bottom-right corner to resize.

Each sticker can be adjusted:

| Option | Default | Notes |
|---|---|---|
| **X / Y** | 0.5 | Normalized 0..1 coordinates (sticker center) |
| **Rộng (% khung)** (width, % of frame) | 30% | Height follows the image aspect ratio |
| **Xoay (°)** (rotation) | 0 | -180 → 180 |
| **Độ đục** (opacity) | 100% | 0–100% |
| **Bắt đầu / Kết thúc (s)** (start / end) | 0 / end of clip | Visibility window, relative to output duration |
| **Mờ dần vào / ra (s)** (fade in / out) | 0 | Alpha fade at the start / end of the window |

Static stickers are used as alpha images (transparent PNG gives the best result). Stickers are drawn above text and cover boxes.

### Animated GIF / APNG / WEBP

Animated images are detected **by file content, not by file extension** (an `animated` flag, along with `frames` / `fps` / `duration`), and they play correctly in both the preview and the exported video:

- **Preview**: a canvas can only draw the first frame of a GIF, so the backend splits animated stickers into a PNG *sprite sheet* (`data/cache/sticker_sheets/`) and the frontend plays back the cells on a time clock. Stickers keep animating while the video is paused.
- **Export**: every sticker is loaded with `-stream_loop -1`. Static images (not a container) additionally get `-framerate` to avoid stutter; then `scale`, `rotate`, `fade`, `overlay` apply as usual, so the animation loops for the whole clip and transparency is preserved.
- Animated stickers are tagged **ĐỘNG** (animated) in the library and in the list of placed stickers.

Content-based detection is mandatory: APNGs are often saved with a `.png` extension, and treating one as a static image makes ffmpeg reject the file outright (`-loop` is not an option of the image2 demuxer), which makes the sticker vanish from the exported video. Conversely, a `.webp`/`.gif` can very well be a static image.

Video containers (MP4/WEBM/MOV/AVIF) used as stickers are also looped with `-stream_loop -1` but do not get a sprite sheet — they only show their first frame in the preview, while the export keeps full motion.

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/videos` | List videos in the library |
| `POST` | `/api/videos/upload` | Upload a file (multipart `file`) |
| `POST` | `/api/videos/import?path=...` | Import from a local path |
| `GET` | `/api/videos/{id}` | Video metadata |
| `GET` | `/api/videos/{id}/stream` | Stream a video (supports seeking) |
| `DELETE` | `/api/videos/{id}` | Delete a video |
| `POST` | `/api/render` | Create a 9:16 render job |
| `GET` | `/api/jobs/{id}` | Job status + progress |
| `GET` | `/api/files/{name}` | Static files (output, preview, poster) |
| `GET` | `/api/storage/{input\|output}` | Count files in `data/videos` or `data/outputs` |
| `DELETE` | `/api/storage/{input\|output}` | Delete every file in that folder, returns `deleted` / `failed` (409 if a render job is running) |
| `GET` | `/api/fonts` | Available fonts |
| `GET` | `/api/stickers` | List stickers in the library (with size, `animated` flag, `frames`/`fps`/`duration`, and a sprite sheet for animated images) |
| `POST` | `/api/stickers/upload` | Upload a sticker (multipart `file`) |
| `POST` | `/api/stickers/import?path=...` | Import a sticker from a local path |
| `GET` | `/api/stickers/{name}` | Serve a sticker file |
| `GET` | `/api/sticker-sheets/{name}` | Sprite sheet PNG used to play animated stickers in the preview |
| `DELETE` | `/api/stickers/{name}` | Delete a sticker from the library |

## Structure

```
backend/
  main.py          FastAPI app + REST endpoints
  render.py        Builds the ffmpeg filter graph (9:16 fill, drawtext, drawbox, sticker overlay)
  stickers.py      Sticker library: listing, probing, uploads
  jobs.py          Background render jobs, progress tracking
  ffmpeg_utils.py  ffprobe, poster, font resolution
  settings.py      Data paths, ffmpeg/ffprobe discovery
  schemas.py       Pydantic models
web/
  index.html       Three panels: pick video / trim / editor
  app.js           UI logic, preview canvas, API calls
  style.css
data/
  videos/          Source videos
  stickers/        Stickers (PNG/GIF/WEBP…) used on videos
  outputs/         Rendered videos + preview jpg
  cache/           Poster thumbnails + sticker_sheets/ (animated sticker sprite sheets)
  tmp/             Temporary render files
scripts/
  verify_flip_crop.py   Flip + crop verification
  verify_render.py      Render matrix check
  verify_stickers.py    Sticker position / timing / fade / animation checks
```

## Environment options

| Variable | Default | Meaning |
|---|---|---|
| `AUTOCUT_HOST` | `127.0.0.1` | Host |
| `AUTOCUT_PORT` | `8787` | Port |
| `AUTOCUT_DATA_DIR` | `./data` | Data directory |
| `AUTOCUT_PYTHON` | `python3` | Python interpreter used by `run.sh` |
| `AUTOCUT_API` | `http://127.0.0.1:8787` | Server address used by `scripts/verify_stickers.py` |

## Verification

```bash
# the server must be running at 127.0.0.1:8787
python3 scripts/verify_flip_crop.py    # flip + crop
python3 scripts/verify_render.py       # flip / crop render matrix (writes /tmp/render_results.json)
python3 scripts/verify_stickers.py     # position / timing / fade, and that animated GIFs really animate
```

`verify_flip_crop.py` needs `numpy` and `Pillow`, and uses a hard-coded ffmpeg path at the top of the file — update `FF` if your ffmpeg lives elsewhere.

`verify_stickers.py` uploads its own test stickers (a static image, an animated GIF, and an APNG saved with a `.png` extension), renders a few short clips, then samples frames to check position, visibility window, fade, and motion, and finally deletes those stickers. Set `AUTOCUT_API` if the server runs at a different address.
