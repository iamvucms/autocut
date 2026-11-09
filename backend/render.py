"""Builds the ffmpeg filter graph that turns a source clip into a 9:16 short."""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .ffmpeg_utils import FFmpegError, probe_image, resolve_font
from .schemas import OverlaySticker, OverlayText
from .stickers import is_animated, sticker_path

# ------------------------------------------------------------------ helpers


def _hex_to_ff(value: str) -> str:
    """'#RRGGBB' -> '0xRRGGBB' (ffmpeg colour syntax)."""
    v = (value or "#000000").strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if len(v) != 6:
        v = "000000"
    return f"0x{v.upper()}"


def _text_filter(
    ov: OverlayText,
    out_w: int,
    out_h: int,
    tmp_dir: Path,
) -> str | None:
    if not ov.text.strip():
        return None

    font_path = resolve_font(ov.font, bold=ov.bold)
    if not font_path:
        return None

    # Write the text to a file so quoting/escaping is never a problem.
    text_file = tmp_dir / f"text_{uuid.uuid4().hex}.txt"
    text_file.write_text(ov.text, encoding="utf-8")

    font_size = max(8, int(round(ov.font_size * out_h)))
    box_w = max(0.05, min(ov.width, 1.0))
    x = int(round(ov.x * out_w - (box_w * out_w) / 2))
    y = int(round(ov.y * out_h - (font_size / 2)))

    alpha = max(0.0, min(1.0, ov.opacity))
    fontcolor = _hex_to_ff(ov.color)
    if alpha < 1.0:
        fontcolor = f"{fontcolor}@{alpha:.3f}"

    parts = [
        f"fontfile='{font_path}'",
        f"textfile='{text_file}'",
        f"fontsize={font_size}",
        f"fontcolor={fontcolor}",
        f"x={x}",
        f"y={y}",
        "box=0",
        f"line_spacing={max(0, int(font_size * 0.15))}",
    ]
    if ov.bold:
        parts.append("shadowcolor=black@0.35")
        parts.append("shadowx=0")
        parts.append("shadowy=2")

    return "drawtext=" + ":".join(parts)


@dataclass
class StickerInput:
    """A sticker file already added to the ffmpeg command as input `index`."""

    ov: OverlaySticker
    index: int
    path: Path
    animated: bool = False
    # Time-based container (mp4/webm/mov/avif): its demuxer rejects the
    # image2-only `-framerate` option.
    container: bool = False


def sticker_inputs(overlays: Sequence[OverlaySticker], index_start: int = 1) -> list[StickerInput]:
    """Attach resolved paths to sticker overlays (skipping unknown files)."""
    out: list[StickerInput] = []
    index = index_start
    for ov in overlays:
        path = sticker_path(ov.sticker)
        if not path:
            continue
        try:
            info = probe_image(path)
            animated, container = info.animated, info.container
        except (FFmpegError, OSError):
            # Unreadable files are still handed to ffmpeg so the job fails with
            # a useful ffmpeg error instead of silently dropping the sticker.
            animated, container = is_animated(path), False
        out.append(
            StickerInput(
                ov=ov,
                index=index,
                path=path,
                animated=animated,
                container=container,
            )
        )
        index += 1
    return out


def _sticker_segments(st: StickerInput, out_w: int, out_h: int) -> tuple[str, str]:
    """Return (prep filter for the sticker input, overlay filter for the base)."""
    ov = st.ov

    width = max(2, int(round(max(0.01, ov.width) * out_w)))
    parts = ["format=yuva420p"]

    # Scale first, then rotate — the same order the preview canvas uses, so the
    # on-screen size matches the export.
    parts.append(f"scale={width}:-1:flags=lanczos")
    parts.append("setsar=1")

    rotation = float(ov.rotation or 0.0) % 360
    if abs(rotation) > 0.01:
        angle = f"{rotation:.3f}*PI/180"
        parts.append(f"rotate={angle}:ow=rotw({angle}):oh=roth({angle}):c=none")

    start = max(0.0, float(ov.start))
    end = float(ov.end)
    has_end = end > start + 0.001

    # Alpha fades are expressed on the sticker's own timeline, which is
    # aligned with the output (both start at 0 after -ss / setpts).
    opacity = max(0.0, min(1.0, float(ov.opacity)))
    fade_in = max(0.0, float(ov.fade_in))
    fade_out = max(0.0, float(ov.fade_out))
    if fade_in > 0.001:
        parts.append(f"fade=t=in:st={start:.3f}:d={fade_in:.3f}:alpha=1")
    if fade_out > 0.001 and has_end:
        fade_start = max(start, end - fade_out)
        parts.append(f"fade=t=out:st={fade_start:.3f}:d={min(fade_out, end - fade_start):.3f}:alpha=1")
    if opacity < 0.999:
        parts.append(f"colorchannelmixer=aa={opacity:.3f}")

    prep = f"[{st.index}:v]" + ",".join(parts) + f"[stk{st.index}]"

    x = max(0.0, min(1.0, float(ov.x)))
    y = max(0.0, min(1.0, float(ov.y)))
    timing = ""
    if start > 0.001 or has_end:
        end_expr = f"{end:.3f}" if has_end else "1e9"
        timing = f":enable='between(t,{start:.3f},{end_expr})'"

    overlay = (
        f"overlay=x={x:.5f}*W-w/2:y={y:.5f}*H-h/2"
        ":eof_action=repeat:repeatlast=1:format=auto"
        f"{timing}"
    )
    return prep, overlay


def _box_filter(ov: OverlayText, out_w: int, out_h: int) -> str | None:
    """A solid rounded-ish box used to cover a watermark/logo."""
    w = max(0.02, min(ov.width, 1.0)) * out_w
    h = max(0.02, min(ov.font_size * 2.2, 1.0)) * out_h
    x = ov.x * out_w - w / 2
    y = ov.y * out_h - h / 2
    x = max(0, min(x, out_w - w))
    y = max(0, min(y, out_h - h))

    color = _hex_to_ff(ov.box_color)
    opacity = max(0.0, min(1.0, ov.box_opacity))
    if opacity < 1.0:
        color = f"{color}@{opacity:.3f}"

    return f"drawbox=x={int(round(x))}:y={int(round(y))}:w={int(round(w))}:h={int(round(h))}:color={color}:t=fill"


# ------------------------------------------------------- background fitting


def _crop_filter(
    src_w: int,
    src_h: int,
    crop_x: float,
    crop_y: float,
    crop_width: float,
    crop_height: float,
) -> str | None:
    """Crop a normalized window out of the source frame.

    Returns a filter expression, or None when the whole frame is used.
    """
    x = max(0.0, min(1.0, crop_x))
    y = max(0.0, min(1.0, crop_y))
    w = max(0.01, min(1.0 - x, crop_width))
    h = max(0.01, min(1.0 - y, crop_height))

    # Nothing to do when the crop covers the full frame.
    if x <= 0.001 and y <= 0.001 and w >= 0.999 and h >= 0.999:
        return None

    cw = max(2, int(round(src_w * w)))
    ch = max(2, int(round(src_h * h)))
    cx = int(round(src_w * x))
    cy = int(round(src_h * y))
    # Keep the crop inside the frame.
    cx = max(0, min(cx, src_w - cw))
    cy = max(0, min(cy, src_h - ch))
    cw = min(cw, src_w - cx)
    ch = min(ch, src_h - cy)

    return f"crop={cw}:{ch}:{cx}:{cy}"


def build_filter_chain(
    src_w: int,
    src_h: int,
    out_w: int,
    out_h: int,
    fit_mode: str,
    background_color: str,
    blur_strength: float,
    blur_zoom: float,
    overlays: Sequence[OverlayText],
    tmp_dir: Path,
    crop_x: float = 0.0,
    crop_y: float = 0.0,
    crop_width: float = 1.0,
    crop_height: float = 1.0,
    flip: bool = False,
    speed: float = 1.0,
    brightness: float = 0.0,
    noise: int = 0,
    sharpen: float = 0.0,
) -> list[str]:
    """Return the ffmpeg -filter_complex chain."""
    chain: list[str] = []

    # Lanczos resampling keeps edges crisper than the default bicubic when
    # upscaling. Contrast Adaptive Sharpening (cas) is applied to the sharp
    # foreground only, right after scaling and before overlays / grain.
    scale_flags = "flags=lanczos"
    sharpen = max(0.0, min(1.0, float(sharpen)))
    sharp = f",cas={sharpen:.2f}" if sharpen > 0.001 else ""

    # --- pre-processing: crop the source window, mirror, tone, retime ----
    pre: list[str] = []
    crop = _crop_filter(src_w, src_h, crop_x, crop_y, crop_width, crop_height)
    if crop:
        pre.append(crop)
    if flip:
        pre.append("hflip")
    brightness = max(-0.3, min(0.3, float(brightness)))
    if abs(brightness) > 0.001:
        pre.append(f"eq=brightness={brightness:.3f}")
    speed = max(0.5, min(2.0, float(speed)))
    if abs(speed - 1.0) > 0.001:
        pre.append(f"setpts=PTS/{speed:.4f}")
    pre_str = ",".join(pre)

    if pre_str:
        chain.append(f"[0:v]{pre_str}[src]")
        source = "[src]"
    else:
        source = "[0:v]"

    if fit_mode == "color":
        # Solid background, source centred on top (contain).
        chain.append(
            f"{source}scale={out_w}:{out_h}:force_original_aspect_ratio=decrease:{scale_flags}{sharp}[bg]"
        )
        chain.append(
            f"[bg]pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:color={_hex_to_ff(background_color)}[bgpad]"
        )
        chain.append("[bgpad]null[base]")
    elif fit_mode == "crop":
        # Fill the frame by cropping (may cut off parts of the video).
        chain.append(
            f"{source}scale={out_w}:{out_h}:force_original_aspect_ratio=increase:{scale_flags},"
            f"crop={out_w}:{out_h}{sharp}[base]"
        )
    else:
        # Blurred copy of the frame as background, sharp copy centred on top.
        zoom = max(1.0, float(blur_zoom))
        blur = max(1, int(round(blur_strength)))
        chain.append(f"{source}split=2[bgsrc][fgsrc]")
        chain.append(
            f"[bgsrc]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{out_h},gblur=sigma={blur},"
            f"scale={int(out_w * zoom)}:{int(out_h * zoom)},"
            f"crop={out_w}:{out_h},eq=brightness=-0.05:saturation=1.15[bgblur]"
        )
        chain.append(
            f"[fgsrc]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease:{scale_flags}{sharp}[fgfit]"
        )
        chain.append(
            f"[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2,setsar=1[base]"
        )

    # Apply overlays on the composited 9:16 canvas.
    filters: list[str] = []
    for ov in overlays:
        if ov.is_box:
            box = _box_filter(ov, out_w, out_h)
            if box:
                filters.append(box)
        else:
            txt = _text_filter(ov, out_w, out_h, tmp_dir)
            if txt:
                filters.append(txt)

    # Light temporal grain on the final frame (covers overlays too).
    # Sharpening happens earlier, so grain is not amplified by it.
    noise = max(0, min(20, int(noise)))
    if noise > 0:
        filters.append(f"noise=alls={noise}:allf=t+u")

    if filters:
        chain.append("[base]" + ",".join(filters) + "[vout]")
    else:
        chain.append("[base]null[vout]")

    return chain


def build_sticker_chain(
    base_chain: Sequence[str],
    stickers: Sequence[StickerInput],
    out_w: int,
    out_h: int,
) -> list[str]:
    """Extend a chain with sticker overlays.

    Stickers live on their own ffmpeg inputs, so each one is composited with
    an extra `overlay` step that renames the running video label.
    """
    chain = list(base_chain)
    if not stickers:
        return chain

    current = "vout"
    for st in stickers:
        prep, overlay = _sticker_segments(st, out_w, out_h)
        chain.append(prep)
        nxt = f"vout{len(chain)}"
        chain.append(f"[{current}][stk{st.index}]{overlay}[{nxt}]")
        current = nxt

    # Rename the final label back to [vout] so the map stays stable.
    if current != "vout":
        chain.append(f"[{current}]null[vout]")

    return chain
