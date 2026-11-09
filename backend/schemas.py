"""Pydantic request/response schemas shared by the API and the web UI."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

FitMode = Literal["blur", "color", "crop"]


class VideoInfo(BaseModel):
    id: str
    filename: str
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool
    poster: str
    source: str


class OverlayText(BaseModel):
    """A text/shape overlay used to cover logos or add captions."""

    id: str = Field(default_factory=lambda: "")
    text: str = ""
    # Normalized (0..1) coordinates relative to the 9:16 canvas.
    x: float = 0.5
    y: float = 0.1
    width: float = 0.8
    font_size: float = 0.06
    color: str = "#FFFFFF"
    background: str = "#000000"
    background_opacity: float = 1.0
    font: str = "Arial"
    bold: bool = True
    opacity: float = 1.0
    # Optional solid box drawn behind the text (useful to mask a watermark).
    is_box: bool = False
    box_color: str = "#000000"
    box_opacity: float = 1.0
    rotation: float = 0.0


class OverlaySticker(BaseModel):
    """An image from the sticker library placed on the 9:16 canvas."""

    id: str = Field(default_factory=lambda: "")
    # File name inside data/stickers.
    sticker: str = ""
    # Normalized (0..1) centre of the sticker on the canvas.
    x: float = 0.5
    y: float = 0.5
    # Sticker width as a fraction of the canvas width; height keeps the aspect.
    width: float = Field(default=0.3, ge=0.01, le=3.0)
    rotation: float = 0.0
    opacity: float = Field(default=1.0, ge=0.0, le=1.0)
    # Visibility window in OUTPUT seconds. end <= start means "until the end".
    start: float = 0.0
    end: float = 0.0
    # Alpha fade-in / fade-out lengths in seconds.
    fade_in: float = 0.0
    fade_out: float = 0.0


class RenderRequest(BaseModel):
    video_id: str
    start: float = 0.0
    end: float = 0.0
    fit_mode: FitMode = "blur"
    background_color: str = "#000000"
    blur_strength: float = 28.0
    blur_zoom: float = 1.25
    overlays: list[OverlayText] = Field(default_factory=list)
    stickers: list[OverlaySticker] = Field(default_factory=list)
    output_width: int = 1080
    output_height: int = 1920
    # Output frame rate. 0 = keep the source frame rate.
    fps: int = 0
    # Only used when video_bitrate is 0.
    crf: int = 18
    preset: str = "veryfast"
    audio: bool = True
    # Audio gain, 0.0 - 2.0 (1.0 = original).
    volume: float = 0.7
    # Mirror the video horizontally.
    flip: bool = True
    # Normalized crop window on the source video (0..1).
    crop_x: float = 0.0
    crop_y: float = 0.0
    crop_width: float = 1.0
    crop_height: float = 1.0
    # Target video bitrate in kbps. 0 = quality based (CRF).
    video_bitrate: int = Field(default=4000, ge=0, le=50000)
    # Playback speed multiplier (0.5 - 2.0, 1.0 = original). Default is a barely visible +2%.
    speed: float = Field(default=1.02, ge=0.5, le=2.0)
    # Brightness offset applied by ffmpeg `eq` (-0.3 .. 0.3, 0 = original).
    brightness: float = Field(default=0.02, ge=-0.3, le=0.3)
    # Light temporal film grain, ffmpeg `noise` strength (0 = off, max 20).
    noise: int = Field(default=2, ge=0, le=20)
    # Contrast Adaptive Sharpening strength (ffmpeg `cas`, 0 = off, 1 = max).
    sharpen: float = Field(default=0.3, ge=0.0, le=1.0)


class RenderJob(BaseModel):
    id: str
    status: str  # queued | running | done | error
    progress: float = 0.0
    message: str = ""
    output: str | None = None
    preview: str | None = None
    log: str = ""
