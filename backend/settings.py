"""Application settings and path layout."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("AUTOCUT_DATA_DIR", BASE_DIR / "data"))
VIDEO_DIR = DATA_DIR / "videos"
OUTPUT_DIR = DATA_DIR / "outputs"
CACHE_DIR = DATA_DIR / "cache"
TMP_DIR = DATA_DIR / "tmp"
STICKER_DIR = DATA_DIR / "stickers"
WEB_DIR = BASE_DIR / "web"

for _d in (VIDEO_DIR, OUTPUT_DIR, CACHE_DIR, TMP_DIR, STICKER_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def file_url(name: str) -> str:
    """Build a percent-encoded URL for a file served by /api/files."""
    return f"/api/files/{quote(name)}"


HOST = os.environ.get("AUTOCUT_HOST", "127.0.0.1")
PORT = int(os.environ.get("AUTOCUT_PORT", "8787"))

# ---------------------------------------------------------------- ffmpeg setup


def _works(path: str | None) -> bool:
    if not path:
        return False
    try:
        subprocess.run(
            [path, "-hide_banner", "-version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        return True
    except Exception:
        return False


def _static_bin_dir() -> Path | None:
    """Locate the static_ffmpeg bin folder (contains both ffmpeg and ffprobe)."""
    try:
        import static_ffmpeg

        base = Path(static_ffmpeg.__file__).parent / "bin"
        if base.exists():
            for folder in sorted(base.iterdir()):
                if (folder / "ffmpeg").exists() and (folder / "ffprobe").exists():
                    return folder
    except Exception:
        pass
    return None


def _imageio_ffmpeg() -> str | None:
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        return exe if _works(exe) else None
    except Exception:
        return None


def _resolve_all() -> tuple[str, str]:
    """Return (ffmpeg, ffprobe) paths, preferring a matched pair of binaries."""
    system_ffmpeg = shutil.which("ffmpeg")
    system_ffprobe = shutil.which("ffprobe")
    if _works(system_ffmpeg) and _works(system_ffprobe):
        return system_ffmpeg, system_ffprobe

    static_dir = _static_bin_dir()
    if static_dir:
        ff = str(static_dir / "ffmpeg")
        fp = str(static_dir / "ffprobe")
        if _works(ff) and _works(fp):
            return ff, fp

    ff = _imageio_ffmpeg()
    if ff:
        fp = shutil.which("ffprobe")
        if fp and _works(fp):
            return ff, fp
        if static_dir:
            return ff, str(static_dir / "ffprobe")
        return ff, "ffprobe"

    raise RuntimeError(
        "ffmpeg/ffprobe not found. Run `pip install static-ffmpeg` or `brew install ffmpeg`."
    )


FFMPEG, FFPROBE = _resolve_all()
