"""Sticker library: the image files users overlay on top of the 9:16 video."""
from __future__ import annotations

import math
import re
import threading
from pathlib import Path
from urllib.parse import quote

from .ffmpeg_utils import FFmpegError, probe_image, run
from .settings import CACHE_DIR, FFMPEG, STICKER_DIR

STICKER_URL_PREFIX = "/api/stickers/"

# Animated stickers are also published as a sprite sheet so the preview can
# play them back (a canvas drawImage of a GIF only ever shows frame one).
SHEET_URL_PREFIX = "/api/sticker-sheets/"
# Longest side of one sheet cell, and a ceiling on total frames per sheet.
SHEET_CELL = 160
SHEET_MAX_FRAMES = 120


def sticker_url(name: str) -> str:
    """Public URL that streams a sticker file back to the browser."""
    return STICKER_URL_PREFIX + quote(name)


# Formats ffmpeg can decode and that make sense as an overlay.
STICKER_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".bmp",
    ".avif",
    ".apng",
    ".tif",
    ".tiff",
    ".webm",
    ".mp4",
    ".mov",
    ".m4v",
    ".mkv",
}

# Suffix fallback for files that cannot be probed at all. Animation itself is
# decided by content (see `is_animated`), because an APNG is usually saved as
# `.png` and a `.webp`/`.gif` may well be a still.
ANIMATED_SUFFIXES = {".gif", ".webp", ".apng", ".webm", ".mp4", ".mov", ".m4v", ".mkv"}

# Time-based containers. These animate but are never flattened into a sprite
# sheet: decoding a clip just to preview it is costly.
CONTAINER_SUFFIXES = {".webm", ".mp4", ".mov", ".m4v", ".mkv", ".avif"}

_UNSAFE_RE = re.compile(r"[^\w\-. ]+", re.UNICODE)

# name -> (mtime, metadata); probing every file on every list call is wasteful.
_META_CACHE: dict[str, tuple[float, dict]] = {}
_CACHE_LOCK = threading.Lock()


def _safe_stem(filename: str) -> str:
    stem = Path(filename or "sticker").stem
    cleaned = _UNSAFE_RE.sub("", stem).strip().replace(" ", "_")
    return (cleaned or "sticker")[:60]


def unique_destination(filename: str) -> Path:
    """`cat.png` -> `cat.png`, or `cat_1.png` ... when the name is taken."""
    suffix = Path(filename or "").suffix.lower()
    if suffix not in STICKER_SUFFIXES:
        suffix = ".png"
    STICKER_DIR.mkdir(parents=True, exist_ok=True)
    stem = _safe_stem(filename)
    dest = STICKER_DIR / f"{stem}{suffix}"
    index = 1
    while dest.exists():
        dest = STICKER_DIR / f"{stem}_{index}{suffix}"
        index += 1
    return dest


def sticker_path(name: str) -> Path | None:
    """Resolve a sticker name to a file inside STICKER_DIR (no traversal)."""
    safe = Path(name or "").name
    if not safe:
        return None
    candidate = STICKER_DIR / safe
    if not candidate.is_file():
        return None
    return candidate


def is_animated(path: Path) -> bool:
    """True when the file really carries more than one frame.

    Extension alone is not enough: an APNG saved as `.png` is animated, and a
    still `.webp`/`.gif` is not. Falling back to the suffix only happens when
    the file cannot be probed at all.
    """
    try:
        return probe_image(path).animated
    except (FFmpegError, OSError):
        return path.suffix.lower() in ANIMATED_SUFFIXES


def _sheet_path(name: str) -> Path:
    return CACHE_DIR / "sticker_sheets" / f"{name}.png"


def sheet_url(name: str) -> str:
    return SHEET_URL_PREFIX + quote(name)


def build_sheet(path: Path, meta: dict) -> Path | None:
    """Flatten an animated sticker into a sprite sheet PNG (cached on disk).

    The canvas can only draw the first frame of a GIF, so the preview plays
    animation by walking this grid instead. The sheet is regenerated whenever
    the sticker file changes. Returns the sheet path and fills the sheet_*
    keys of `meta`.
    """
    name = path.name
    frames = int(meta.get("frames") or 0)
    if frames <= 0:
        return None
    frames = min(frames, SHEET_MAX_FRAMES)
    cols = max(1, math.ceil(math.sqrt(frames)))
    rows = max(1, math.ceil(frames / cols))

    # Geometry is recorded even when the PNG is already on disk, otherwise a
    # cache hit would leave the preview without the grid it needs.
    def _annotate() -> None:
        meta["sheet"] = sheet_url(name)
        meta["sheet_cols"] = cols
        meta["sheet_rows"] = rows
        meta["sheet_frames"] = frames

    out = _sheet_path(name)
    if out.exists() and out.stat().st_mtime >= path.stat().st_mtime:
        _annotate()
        return out

    out.parent.mkdir(parents=True, exist_ok=True)
    # `tile` lays the frames out in reading order; trimming to exactly
    # `frames` avoids ffmpeg looping the last cell to fill the grid.
    vf = (
        f"format=rgba,scale={SHEET_CELL}:-1:flags=lanczos,"
        f"tile={cols}x{rows}:color=black@0"
    )
    cmd = [
        FFMPEG,
        "-y",
        "-v",
        "error",
        "-i",
        str(path),
        "-frames:v",
        "1",
        "-vf",
        vf,
        "-c:v",
        "png",
        str(out),
    ]
    try:
        run(cmd)
    except FFmpegError:
        out.unlink(missing_ok=True)
        return None
    if not out.exists():
        return None
    _annotate()
    return out


def describe(path: Path, strict: bool = False) -> dict:
    """Metadata for one sticker file, cached by modification time.

    With `strict=True` an unreadable file raises instead of being listed with
    zero dimensions — used to reject bad uploads. The listing path is lenient so
    one broken file never hides the rest of the library.
    """
    name = path.name
    mtime = path.stat().st_mtime
    with _CACHE_LOCK:
        cached = _META_CACHE.get(name)
        if cached and cached[0] == mtime and not strict:
            return cached[1]

    width = height = 0
    animated = False
    frames = 0
    fps = 0.0
    duration = 0.0
    container = False
    try:
        info = probe_image(path)
        width, height = info.width, info.height
        animated = info.animated
        frames, fps, duration = info.frames, info.fps, info.duration
        container = info.container
    except (FFmpegError, OSError):
        if strict:
            raise
        # Unreadable file: still list it so the user can see and delete it.
        animated = is_animated(path)
        container = path.suffix.lower() in CONTAINER_SUFFIXES

    if strict and not (width and height):
        raise FFmpegError("Không đọc được kích thước ảnh")

    meta = {
        "name": name,
        "url": sticker_url(name),
        "width": width,
        "height": height,
        "animated": animated,
        "frames": frames,
        "fps": round(fps, 4),
        "duration": round(duration, 4),
        "size": path.stat().st_size,
    }
    # Animated still images get a sprite sheet so the preview can animate them.
    # Video stickers are skipped: decoding a clip just to preview it is costly,
    # and ffmpeg already loops it correctly in the export.
    if animated and not container and width and height and frames > 1:
        try:
            build_sheet(path, meta)
        except (FFmpegError, OSError):
            # A failed sheet only costs the preview animation, not the export.
            pass
    with _CACHE_LOCK:
        _META_CACHE[name] = (mtime, meta)
    return meta


def list_stickers() -> list[dict]:
    STICKER_DIR.mkdir(parents=True, exist_ok=True)
    out: list[dict] = []
    for path in sorted(STICKER_DIR.glob("*")):
        if path.name.startswith(".") or not path.is_file():
            continue
        if path.suffix.lower() not in STICKER_SUFFIXES:
            continue
        try:
            out.append(describe(path))
        except OSError:
            continue
    return out


def forget(name: str) -> None:
    with _CACHE_LOCK:
        _META_CACHE.pop(Path(name).name, None)
