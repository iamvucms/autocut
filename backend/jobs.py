"""Background render jobs with progress tracking."""
from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .ffmpeg_utils import FFmpegError, probe
from .render import StickerInput, build_filter_chain, build_sticker_chain, sticker_inputs
from .schemas import RenderRequest
from .settings import FFMPEG, OUTPUT_DIR, TMP_DIR, file_url

_TIME_RE = re.compile(r"out_time_ms=(\d+)")
_UNSAFE_RE = re.compile(r"[^\w\- ]+", re.UNICODE)

# Output options that drop container/stream metadata and encoder signatures.
_STRIP_METADATA_ARGS = [
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    # Drop the x264 "options" SEI NAL (type 6) that embeds encoder settings.
    "-bsf:v",
    "filter_units=remove_types=6",
    "-metadata:s:v:0",
    "handler_name=",
    "-metadata:s:a:0",
    "handler_name=",
]

# The MP4 sample entry stores the encoder as a Pascal string, e.g.
# b"\x0cLavc libx264" padded with zeros up to 32 bytes.
_COMPRESSOR_RE = re.compile(rb"[\x01-\x1f]Lavc [\x20-\x7e]*\x00*")


def scrub_encoder_signature(path: Path) -> None:
    """Blank the encoder name inside the MP4 in place (same byte length)."""
    data = path.read_bytes()
    patched = _COMPRESSOR_RE.sub(lambda m: b"\x00" * len(m.group()), data)
    if patched != data:
        path.write_bytes(patched)


def _sanitize(name: str) -> str:
    """Make a filename stem safe for the filesystem."""
    cleaned = _UNSAFE_RE.sub("", name).strip()
    cleaned = re.sub(r"\s+", "_", cleaned)
    return cleaned[:80]


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        # Guards output-name allocation so parallel jobs never collide.
        self._name_lock = threading.Lock()

    def create(self) -> str:
        job_id = uuid.uuid4().hex[:12]
        with self._lock:
            self._jobs[job_id] = {
                "id": job_id,
                "status": "queued",
                "progress": 0.0,
                "message": "Đang xếp hàng",
                "output": None,
                "preview": None,
                "filename": None,
                "log": "",
            }
        return job_id

    def update(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.update(fields)

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            return dict(self._jobs.get(job_id) or {}) or None

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._jobs.values())

    def run(self, job_id: str, req: RenderRequest, src: Path, info) -> None:
        threading.Thread(
            target=self._execute, args=(job_id, req, src, info), daemon=True
        ).start()

    # ------------------------------------------------------------- internal
    def _unique_output(self, src: Path) -> tuple[Path, Path]:
        """Build an output path that keeps the source name.

        `clip.mp4` -> `clip.mp4`, or `clip_1.mp4`, `clip_2.mp4` ... when the
        name is already taken.
        """
        stem = _sanitize(src.stem) or "video"
        out_dir = OUTPUT_DIR

        with self._name_lock:
            path = out_dir / f"{stem}.mp4"
            index = 1
            while path.exists():
                path = out_dir / f"{stem}_{index}.mp4"
                index += 1
        return path, out_dir / f"{path.stem}_preview.jpg"

    def _execute(self, job_id: str, req: RenderRequest, src: Path, info) -> None:
        out_dir = OUTPUT_DIR
        out_dir.mkdir(parents=True, exist_ok=True)
        tmp_dir = TMP_DIR / job_id
        tmp_dir.mkdir(parents=True, exist_ok=True)

        out_file, preview_file = self._unique_output(src)

        self.update(job_id, status="running", message="Đang chuẩn bị", progress=0.02)
        started_at = time.time()

        chain = build_filter_chain(
            src_w=info.width,
            src_h=info.height,
            out_w=req.output_width,
            out_h=req.output_height,
            fit_mode=req.fit_mode,
            background_color=req.background_color,
            blur_strength=req.blur_strength,
            blur_zoom=req.blur_zoom,
            overlays=req.overlays,
            tmp_dir=tmp_dir,
            crop_x=req.crop_x,
            crop_y=req.crop_y,
            crop_width=req.crop_width,
            crop_height=req.crop_height,
            flip=req.flip,
            speed=req.speed,
            brightness=req.brightness,
            noise=req.noise,
            sharpen=req.sharpen,
        )

        # Stickers are extra ffmpeg inputs, appended after the source video.
        stickers: list[StickerInput] = sticker_inputs(req.stickers, index_start=1)
        if stickers:
            chain = build_sticker_chain(
                chain,
                stickers,
                out_w=req.output_width,
                out_h=req.output_height,
            )

        start = max(0.0, float(req.start))
        end = float(req.end)
        if end <= start:
            end = start + max(1.0, info.duration - start)

        speed = max(0.5, min(2.0, float(req.speed)))
        # Source seconds consumed, and resulting output seconds after retiming.
        src_duration = max(0.001, end - start)
        duration = max(0.001, src_duration / speed)
        out_fps = float(req.fps) if req.fps > 0 else min(60.0, max(1.0, info.fps))

        cmd: list[str] = [
            FFMPEG,
            "-y",
            "-v",
            "error",
            "-progress",
            "pipe:1",
            "-nostats",
        ]
        if start > 0:
            cmd += ["-ss", f"{start:.3f}"]
        cmd += ["-i", str(src)]

        # Sticker inputs come after the source so their indices match
        # `sticker_inputs(..., index_start=1)`.
        for st in stickers:
            # `-stream_loop` is understood by every demuxer we support, so it
            # loops animated stickers and holds still ones on screen. `-loop`
            # is an image2-only option and makes ffmpeg refuse gif/apng/video
            # inputs outright, which used to lose the sticker from the export.
            cmd += ["-stream_loop", "-1"]
            if not st.animated and not st.container:
                # Pin a still's frame rate; otherwise the image is read at the
                # image2 default and the overlay stutters across frames.
                # Containers carry their own timing and reject this option.
                cmd += ["-framerate", f"{out_fps:.3f}"]
            cmd += ["-i", str(st.path)]

        # Output duration (already divided by speed) so retimed clips end cleanly.
        cmd += ["-t", f"{duration:.3f}"]
        cmd += ["-filter_complex", ";".join(chain), "-map", "[vout]"]

        if req.audio and info.has_audio:
            volume = max(0.0, min(2.0, float(req.volume)))
            cmd += ["-map", "0:a?", "-c:a", "aac", "-b:a", "192k"]
            audio_filters: list[str] = []
            if abs(speed - 1.0) > 0.001:
                audio_filters.append(f"atempo={speed:.4f}")
            if abs(volume - 1.0) > 0.001:
                audio_filters.append(f"volume={volume:.3f}")
            if audio_filters:
                cmd += ["-af", ",".join(audio_filters)]
            cmd += ["-shortest"]
        else:
            cmd += ["-an"]

        cmd += [
            "-c:v",
            "libx264",
            "-preset",
            req.preset,
        ]
        if req.video_bitrate > 0:
            kbps = int(req.video_bitrate)
            cmd += ["-b:v", f"{kbps}k", "-maxrate", f"{int(kbps * 1.5)}k", "-bufsize", f"{kbps * 2}k"]
        else:
            cmd += ["-crf", str(req.crf)]
        cmd += [
            "-pix_fmt",
            "yuv420p",
            "-r",
            f"{out_fps:.3f}",
            "-movflags",
            "+faststart",
        ]
        # Strip identifying metadata (encoder tag, creation time, GPS, device
        # info, chapters, x264 settings SEI, stream handler names).
        cmd += _STRIP_METADATA_ARGS
        cmd += [str(out_file)]

        log_lines: list[str] = []
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                log_lines.append(line)
                m = _TIME_RE.search(line)
                if m:
                    done = int(m.group(1)) / 1_000_000.0
                    pct = min(0.98, max(0.0, done / duration))
                    elapsed = time.time() - started_at
                    eta = ""
                    if pct > 0.02 and elapsed > 0.5:
                        remaining = (elapsed / pct) * (1 - pct)
                        eta = f" · còn ~{remaining:.0f}s"
                    self.update(
                        job_id,
                        progress=round(0.05 + pct * 0.9, 3),
                        message=f"Đang xuất {pct * 100:.0f}%{eta}",
                    )
            proc.wait()
            if proc.returncode != 0:
                raise FFmpegError("\n".join(log_lines[-40:]))

            scrub_encoder_signature(out_file)

            self.update(job_id, progress=0.99, message="Đang tạo ảnh xem trước")
            self._make_preview(out_file, preview_file)

            self.update(
                job_id,
                status="done",
                progress=1.0,
                message="Hoàn tất",
                output=file_url(out_file.name),
                preview=file_url(preview_file.name),
                filename=out_file.name,
            )
        except Exception as exc:  # noqa: BLE001
            self.update(
                job_id,
                status="error",
                message=str(exc)[:500],
                log="\n".join(log_lines[-60:]),
            )
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def _make_preview(self, video: Path, out: Path) -> None:
        try:
            subprocess.run(
                [
                    FFMPEG,
                    "-y",
                    "-v",
                    "error",
                    "-ss",
                    "0.5",
                    "-i",
                    str(video),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=480:-2",
                    "-map_metadata",
                    "-1",
                    "-fflags",
                    "+bitexact",
                    "-flags:v",
                    "+bitexact",
                    str(out),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass
