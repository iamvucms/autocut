"""Low level helpers around ffmpeg / ffprobe."""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .settings import FFMPEG, FFPROBE


class FFmpegError(RuntimeError):
    pass


def run(
    cmd: Sequence[str],
    timeout: int | None = None,
    merge_stderr: bool = True,
) -> subprocess.CompletedProcess:
    """Run a command, raising FFmpegError on a non-zero exit.

    `merge_stderr=False` keeps stderr out of stdout, which matters when the
    caller parses JSON: ffprobe happily prints warnings to stderr (e.g. on
    animated WebP with no still preview) and merging them corrupts the payload.
    """
    proc = subprocess.run(
        list(cmd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT if merge_stderr else subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        output = proc.stdout or ""
        if not merge_stderr:
            output = (output or "") + (proc.stderr or "")
        raise FFmpegError(output[-4000:])
    return proc


@dataclass
class MediaInfo:
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool

    @property
    def aspect(self) -> float:
        return (self.width / self.height) if self.height else 0.0


def _parse_fps(raw: str | None) -> float:
    if not raw:
        return 0.0
    raw = raw.strip()
    if "/" in raw:
        num, _, den = raw.partition("/")
        try:
            num_f = float(num)
            den_f = float(den)
        except ValueError:
            return 0.0
        return num_f / den_f if den_f else 0.0
    try:
        return float(raw)
    except ValueError:
        return 0.0


def probe(path: Path) -> MediaInfo:
    cmd = [
        FFPROBE,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    data = json.loads(run(cmd, merge_stderr=False).stdout)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = 0.0
    for source in (video or {}, data.get("format", {})):
        try:
            duration = float(source.get("duration") or 0)
        except (TypeError, ValueError):
            duration = 0.0
        if duration:
            break

    fps = 0.0
    if video:
        fps = _parse_fps(video.get("avg_frame_rate")) or _parse_fps(video.get("r_frame_rate"))
        if not fps:
            try:
                fps = float(video.get("r_frame_rate", 0)) or 30.0
            except ValueError:
                fps = 30.0

    width = int(video.get("width", 0)) if video else 0
    height = int(video.get("height", 0)) if video else 0

    return MediaInfo(
        duration=duration,
        width=width,
        height=height,
        fps=fps or 30.0,
        has_audio=audio is not None,
    )


@dataclass
class ImageInfo:
    width: int
    height: int
    animated: bool = False
    # Animation details; all zero for still images.
    frames: int = 0
    fps: float = 0.0
    duration: float = 0.0
    # True for time-based containers (mp4/webm/mov); those are looped by ffmpeg
    # but never flattened into a preview sprite sheet.
    container: bool = False


def _fps_from_rate(raw: str | None) -> float:
    return _parse_fps(raw)


# Containers are always time-based; anything with a real duration animates.
_VIDEO_FORMATS = {"mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm", "avi"}


def probe_image(path: Path) -> ImageInfo:
    """Dimensions of an image/video file used as a sticker.

    Streams like GIF/WebP/APNG report several `nb_frames`; that is enough to
    mark them as animated without decoding the whole file. Animated files also
    report their frame count and duration so the preview can play them back.

    Detection is by *content*, never by file extension: an APNG is routinely
    saved as `.png`, and treating it as a still frame makes ffmpeg reject the
    file outright (`-loop` is not an option of the image2 demuxer).
    """
    cmd = [
        FFPROBE,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-select_streams",
        "v:0",
        str(path),
    ]
    try:
        data = json.loads(run(cmd, merge_stderr=False).stdout)
    except (FFmpegError, json.JSONDecodeError) as exc:
        raise FFmpegError(f"Unreadable image: {exc}") from exc
    streams = data.get("streams") or []
    if not streams:
        raise FFmpegError("No image stream found")
    stream = streams[0]
    fmt = data.get("format") or {}

    try:
        width = int(stream.get("width") or 0)
        height = int(stream.get("height") or 0)
    except (TypeError, ValueError):
        width = height = 0

    try:
        frames = int(stream.get("nb_frames") or 0)
    except (TypeError, ValueError):
        frames = 0

    codec = (stream.get("codec_name") or "").lower()
    format_names = set((fmt.get("format_name") or "").split(","))
    is_container = bool(format_names & _VIDEO_FORMATS)

    # APNG / animated WebP often omit nb_frames, so count them explicitly.
    # Containers are skipped: a long clip would cost a full decode just to be
    # described, and their duration already proves they move.
    if frames <= 1 and not is_container and codec in {"gif", "apng", "webp", "png"}:
        frames = max(frames, _count_frames(path))

    fps = _fps_from_rate(stream.get("avg_frame_rate")) or _fps_from_rate(stream.get("r_frame_rate"))
    duration = 0.0
    for source in (stream, fmt):
        try:
            duration = float(source.get("duration") or 0)
        except (TypeError, ValueError):
            duration = 0.0
        if duration:
            break

    animated = frames > 1 or codec in {"gif", "apng"} or (is_container and duration > 0.05)
    if animated:
        if fps <= 0 and duration > 0 and frames > 0:
            fps = frames / duration
        if duration <= 0 and frames > 0 and fps > 0:
            duration = frames / fps
        if frames <= 0 and duration > 0 and fps > 0:
            frames = max(1, int(round(duration * fps)))
    else:
        frames = 1 if width and height else 0

    # Rotated stills (e.g. phone screenshots) carry a display matrix.
    try:
        rotation = int(float((stream.get("tags") or {}).get("rotate") or 0))
    except (TypeError, ValueError):
        rotation = 0
    if abs(rotation) % 180 == 90:
        width, height = height, width

    return ImageInfo(
        width=width,
        height=height,
        animated=animated,
        frames=frames if animated else 0,
        fps=fps if animated else 0.0,
        duration=duration if animated else 0.0,
        container=is_container,
    )


def _count_frames(path: Path) -> int:
    """Decode the stream just enough to learn how many frames it holds."""
    cmd = [
        FFPROBE,
        "-v",
        "error",
        "-print_format",
        "json",
        "-count_frames",
        "-show_streams",
        "-select_streams",
        "v:0",
        str(path),
    ]
    try:
        data = json.loads(run(cmd, merge_stderr=False).stdout)
    except (FFmpegError, json.JSONDecodeError):
        return 0
    streams = data.get("streams") or []
    if not streams:
        return 0
    for key in ("nb_read_frames", "nb_frames"):
        try:
            value = int(streams[0].get(key) or 0)
        except (TypeError, ValueError):
            value = 0
        if value:
            return value
    return 0


def extract_poster(src: Path, out: Path, at: float = 1.0) -> bool:
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        FFMPEG,
        "-y",
        "-v",
        "error",
        "-ss",
        f"{max(at, 0):.3f}",
        "-i",
        str(src),
        "-frames:v",
        "1",
        "-vf",
        "scale=640:-2",
        str(out),
    ]
    try:
        run(cmd)
    except FFmpegError:
        return False
    return out.exists()


# --------------------------------------------------------------------- fonts

FONT_CANDIDATES: dict[str, list[str]] = {
    "Arial": ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"],
    "Arial Black": ["/System/Library/Fonts/Supplemental/Arial Black.ttf"],
    "Impact": ["/System/Library/Fonts/Supplemental/Impact.ttf"],
    "Verdana": ["/System/Library/Fonts/Supplemental/Verdana Bold.ttf", "/System/Library/Fonts/Supplemental/Verdana.ttf"],
    "Helvetica": ["/System/Library/Fonts/Helvetica.ttc"],
    "Courier": ["/System/Library/Fonts/Supplemental/Courier New Bold.ttf", "/System/Library/Fonts/Supplemental/Courier New.ttf"],
    "Georgia": ["/System/Library/Fonts/Supplemental/Georgia Bold.ttf", "/System/Library/Fonts/Supplemental/Georgia.ttf"],
    "Times": ["/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf", "/System/Library/Fonts/Supplemental/Times New Roman.ttf"],
}

_FONT_CACHE: dict[str, str | None] = {}


def resolve_font(name: str, bold: bool = True) -> str | None:
    key = f"{name}:{bold}"
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]

    candidates = list(FONT_CANDIDATES.get(name, []))
    if not bold:
        # Prefer the regular weight variant for non-bold text.
        candidates = [
            c.replace(" Bold", "").replace(" Black", "") if "Bold" in c or "Black" in c else c
            for c in candidates
        ]
        candidates += FONT_CANDIDATES.get(name, [])
    for cand in candidates:
        if os.path.exists(cand):
            _FONT_CACHE[key] = cand
            return cand

    # Fallback: any system font.
    for folder in ("/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts"):
        base = Path(folder)
        if not base.exists():
            continue
        for f in sorted(base.iterdir()):
            if f.suffix.lower() in (".ttf", ".ttc", ".otf"):
                _FONT_CACHE[key] = str(f)
                return str(f)

    _FONT_CACHE[key] = None
    return None


def list_fonts() -> list[str]:
    return sorted(FONT_CANDIDATES.keys())
