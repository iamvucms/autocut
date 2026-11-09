"""FastAPI application: video library, trimming, 9:16 render pipeline."""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .ffmpeg_utils import FFmpegError, extract_poster, list_fonts, probe
from .jobs import JobManager
from .schemas import RenderRequest, VideoInfo
from .settings import CACHE_DIR, FFMPEG, OUTPUT_DIR, VIDEO_DIR, WEB_DIR, file_url
from .stickers import STICKER_SUFFIXES, describe, forget, sticker_path, unique_destination


app = FastAPI(title="AutoCut", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

jobs = JobManager()
VIDEO_META: dict[str, dict] = {}


# ------------------------------------------------------------------- videos


def _register_video(path: Path) -> VideoInfo:
    try:
        info = probe(path)
    except FFmpegError as exc:
        raise HTTPException(status_code=400, detail=f"Cannot read video: {exc}") from exc

    video_id = path.stem
    poster = file_url(f"{path.stem}_poster.jpg")
    poster_path = CACHE_DIR / f"{path.stem}_poster.jpg"
    if not poster_path.exists():
        extract_poster(path, poster_path, at=min(1.0, info.duration / 3 if info.duration else 1.0))

    meta = {
        "id": video_id,
        "filename": path.name,
        "duration": info.duration,
        "width": info.width,
        "height": info.height,
        "fps": info.fps,
        "has_audio": info.has_audio,
        "poster": poster,
        "source": "local",
    }
    VIDEO_META[video_id] = meta
    return VideoInfo(**meta)


@app.get("/api/videos")
def list_videos() -> list[VideoInfo]:
    out: list[VideoInfo] = []
    for path in sorted(VIDEO_DIR.glob("*")):
        if path.suffix.lower() not in {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}:
            continue
        if path.stem in VIDEO_META:
            out.append(VideoInfo(**VIDEO_META[path.stem]))
            continue
        try:
            out.append(_register_video(path))
        except HTTPException:
            continue
    return out


@app.post("/api/videos/upload")
async def upload_video(file: UploadFile = File(...)) -> VideoInfo:
    suffix = Path(file.filename or "video.mp4").suffix.lower() or ".mp4"
    if suffix not in {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}:
        raise HTTPException(status_code=400, detail="Unsupported file type")
    video_id = uuid.uuid4().hex[:12]
    dest = VIDEO_DIR / f"{video_id}{suffix}"
    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)
    try:
        return _register_video(dest)
    except HTTPException:
        # Unreadable video: don't leave an orphan file in the library.
        dest.unlink(missing_ok=True)
        raise


@app.post("/api/videos/import")
def import_video(path: str) -> VideoInfo:
    src = Path(path).expanduser()
    if not src.exists():
        raise HTTPException(status_code=404, detail="File not found")
    video_id = uuid.uuid4().hex[:12]
    dest = VIDEO_DIR / f"{video_id}{src.suffix.lower()}"
    shutil.copy2(src, dest)
    try:
        return _register_video(dest)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise


@app.get("/api/videos/{video_id}")
def get_video(video_id: str) -> VideoInfo:
    if video_id in VIDEO_META:
        return VideoInfo(**VIDEO_META[video_id])
    matches = list(VIDEO_DIR.glob(f"{video_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Video not found")
    return _register_video(matches[0])


@app.get("/api/videos/{video_id}/stream")
def stream_video(video_id: str):
    matches = list(VIDEO_DIR.glob(f"{video_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Video not found")
    return FileResponse(matches[0], media_type="video/mp4")


@app.delete("/api/videos/{video_id}")
def delete_video(video_id: str) -> dict:
    matches = list(VIDEO_DIR.glob(f"{video_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Video not found")
    for m in matches:
        m.unlink(missing_ok=True)
    VIDEO_META.pop(video_id, None)
    poster = CACHE_DIR / f"{video_id}_poster.jpg"
    poster.unlink(missing_ok=True)
    return {"ok": True}


# ------------------------------------------------------------------- render


@app.post("/api/render")
def start_render(req: RenderRequest) -> dict:
    matches = list(VIDEO_DIR.glob(f"{req.video_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Video not found")
    src = matches[0]
    try:
        info = probe(src)
    except FFmpegError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job_id = jobs.create()
    jobs.run(job_id, req, src, info)
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


# ------------------------------------------------------------------ storage

# Only these two folders can be cleared through the API.
_CLEARABLE = {"input": VIDEO_DIR, "output": OUTPUT_DIR}


def _clearable_files(folder: Path) -> list[Path]:
    """Regular files directly inside `folder`, ignoring dotfiles like .gitkeep."""
    return [p for p in folder.iterdir() if not p.name.startswith(".") and (p.is_file() or p.is_symlink())]


def _folder(target: str) -> Path:
    folder = _CLEARABLE.get(target)
    if folder is None:
        raise HTTPException(status_code=404, detail="Unknown target")
    return folder


@app.get("/api/storage/{target}")
def storage_count(target: str) -> dict:
    return {"target": target, "count": len(_clearable_files(_folder(target)))}


@app.delete("/api/storage/{target}")
def clear_storage(target: str) -> dict:
    folder = _folder(target)
    if any(j.get("status") in ("queued", "running") for j in jobs.list()):
        raise HTTPException(status_code=409, detail="Đang có video được xuất, hãy đợi xong rồi thử lại")

    deleted = 0
    failed = 0
    for path in _clearable_files(folder):
        try:
            path.unlink()
            deleted += 1
        except OSError:
            failed += 1

    if target == "input":
        # Drop cached metadata and posters of the removed videos.
        VIDEO_META.clear()
        for poster in CACHE_DIR.glob("*_poster.jpg"):
            poster.unlink(missing_ok=True)
    return {"target": target, "deleted": deleted, "failed": failed}


@app.get("/api/fonts")
def fonts() -> list[str]:
    return list_fonts()


# ---------------------------------------------------------------- stickers


@app.get("/api/stickers")
def list_sticker_files() -> list[dict]:
    from .stickers import list_stickers

    return list_stickers()


@app.post("/api/stickers/upload")
async def upload_sticker(file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "sticker.png").suffix.lower()
    if suffix not in STICKER_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail="Chỉ hỗ trợ ảnh PNG/JPG/WEBP/GIF/BMP hoặc video ngắn",
        )
    dest = unique_destination(file.filename or f"sticker{suffix}")
    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)
    try:
        return describe(dest, strict=True)
    except (FFmpegError, OSError) as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=_upload_hint(suffix, exc)) from exc


def _upload_hint(suffix: str, exc: Exception) -> str:
    """Explain the common rejection: a file the bundled ffmpeg cannot decode."""
    if suffix == ".webp":
        # Animated WebP needs ANIM/ANMF support that some static ffmpeg builds
        # lack, and the raw ffmpeg error ("image data not found") is cryptic.
        return (
            "Không đọc được ảnh WebP này. Bản ffmpeg đang dùng không giải mã được "
            "WebP động — hãy xuất sticker đó sang GIF rồi tải lại."
        )
    return f"Không đọc được ảnh: {exc}"


@app.post("/api/stickers/import")
def import_sticker(path: str) -> dict:
    src = Path(path).expanduser()
    if not src.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    if src.suffix.lower() not in STICKER_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail="Chỉ hỗ trợ ảnh PNG/JPG/WEBP/GIF/BMP hoặc video ngắn",
        )
    dest = unique_destination(src.name)
    shutil.copy2(src, dest)
    try:
        return describe(dest, strict=True)
    except (FFmpegError, OSError) as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=_upload_hint(src.suffix.lower(), exc)) from exc


@app.get("/api/stickers/{name}")
def get_sticker(name: str) -> FileResponse:
    path = sticker_path(name)
    if not path:
        raise HTTPException(status_code=404, detail="Sticker not found")
    return FileResponse(path)


@app.get("/api/sticker-sheets/{name}")
def get_sticker_sheet(name: str) -> FileResponse:
    """Sprite sheet used by the preview to animate GIF/WebP/APNG stickers."""
    safe = Path(name or "").name
    path = CACHE_DIR / "sticker_sheets" / f"{safe}.png"
    if not safe or not path.is_file():
        raise HTTPException(status_code=404, detail="Sheet not found")
    # Sheets are content-addressed by the sticker's mtime, so they never go stale.
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


@app.delete("/api/stickers/{name}")
def delete_sticker(name: str) -> dict:
    path = sticker_path(name)
    if not path:
        raise HTTPException(status_code=404, detail="Sticker not found")
    path.unlink(missing_ok=True)
    (CACHE_DIR / "sticker_sheets" / f"{Path(name).name}.png").unlink(missing_ok=True)
    forget(name)
    return {"ok": True}


@app.get("/api/files/{name}")
def get_file(name: str):
    safe = Path(name).name
    for folder in (OUTPUT_DIR, CACHE_DIR):
        candidate = folder / safe
        if candidate.exists():
            return FileResponse(candidate)
    raise HTTPException(status_code=404, detail="File not found")


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


@app.exception_handler(FFmpegError)
def ffmpeg_error_handler(_request, exc: FFmpegError):
    return JSONResponse(status_code=500, content={"detail": str(exc)})
