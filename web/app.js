/* AutoCut front-end: pick -> trim -> fill 9:16 + overlays */
const API = "";

const state = {
  videos: [],
  selected: null,
  trim: { start: 0, end: 0, duration: 0 },
  overlays: [],
  stickers: [],
  stickerLib: [],
  fitMode: "blur",
  bgColor: "#000000",
  blurStrength: 28,
  blurZoom: 1.25,
  crf: 18,
  keepAudio: true,
  volume: 0.7,
  flip: true,
  speed: 1.02,
  brightness: 0.02,
  noise: 2,
  sharpen: 0.3,
  bitrate: 4000,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  jobId: null,
  poll: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const fmt = (s) => {
  if (!isFinite(s)) return "0.00s";
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2);
  return m > 0 ? `${m}:${sec.padStart(5, "0")}` : `${sec}s`;
};

/* ------------------------------------------------------------------ steps */
function showStep(n) {
  $$(".step").forEach((b) => b.classList.toggle("active", b.dataset.step == n));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${n}`));
  window.scrollTo({ top: 0, behavior: "instant" });
  if (n === 3) setupEditor();
}

/* ------------------------------------------------------------ video list */
async function loadVideos() {
  const res = await fetch(`${API}/api/videos`);
  state.videos = await res.json();
  renderGrid();
}

function renderGrid() {
  const grid = $("#videoGrid");
  grid.innerHTML = "";
  $("#emptyState").classList.toggle("hidden", state.videos.length > 0);

  for (const v of state.videos) {
    const card = document.createElement("div");
    card.className = "vcard";
    card.innerHTML = `
      <img class="thumb" src="${v.poster}" loading="lazy" />
      <div class="meta">
        <div class="name" title="${v.filename}">${v.filename}</div>
        <div class="sub">${v.width}×${v.height} · ${fmt(v.duration)} · ${v.has_audio ? "có audio" : "không audio"}</div>
      </div>`;
    const del = document.createElement("button");
    del.className = "del";
    del.style.cssText = "top:8px;right:8px;position:absolute";
    del.textContent = "✕";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Xoá ${v.filename}?`)) return;
      await fetch(`${API}/api/videos/${v.id}`, { method: "DELETE" });
      loadVideos();
    };
    card.appendChild(del);
    card.onclick = () => selectVideo(v);
    grid.appendChild(card);
  }
}

/* ------------------------------------------------------- upload / drag&drop */
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
let uploading = false;

const isVideoFile = (f) => (f.type && f.type.startsWith("video/")) || VIDEO_EXT.test(f.name);

function setUploadStatus(text, isError = false) {
  const el = $("#uploadStatus");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

/** Upload one file with progress reporting (fetch cannot report upload progress). */
function uploadOne(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/api/videos/upload`);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress(ev.loaded / ev.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let detail = "Upload lỗi";
      try { detail = JSON.parse(xhr.responseText).detail || detail; } catch (_) { /* keep default */ }
      reject(new Error(detail));
    };
    xhr.onerror = () => reject(new Error("Mất kết nối khi upload"));
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

async function uploadFiles(fileList) {
  if (uploading) {
    setUploadStatus("Đang upload, vui lòng đợi xong rồi thả tiếp", true);
    return;
  }
  const all = Array.from(fileList);
  const files = all.filter(isVideoFile);
  const skipped = all.length - files.length;
  if (!files.length) {
    if (all.length) setUploadStatus("Chỉ hỗ trợ tệp video (mp4, mov, m4v, webm, mkv, avi)", true);
    return;
  }

  uploading = true;
  let ok = 0;
  const errors = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const prefix = files.length > 1 ? `(${i + 1}/${files.length}) ` : "";
    setUploadStatus(`${prefix}Đang upload ${f.name} · 0%`);
    try {
      await uploadOne(f, (p) => setUploadStatus(`${prefix}Đang upload ${f.name} · ${Math.round(p * 100)}%`));
      ok++;
      await loadVideos();
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }
  uploading = false;

  let msg = `Đã upload ${ok}/${files.length} video`;
  if (skipped) msg += ` · bỏ qua ${skipped} tệp không phải video`;
  if (errors.length) msg += ` · lỗi: ${errors.join("; ")}`;
  setUploadStatus(msg, errors.length > 0);
  if (!errors.length) setTimeout(() => { if (!uploading) setUploadStatus(""); }, 5000);
}

function bindDropZone() {
  const zone = $("#dropZone");
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  // Counter avoids flicker when the pointer crosses child elements.
  let depth = 0;

  zone.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  zone.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) zone.classList.remove("dragover");
  });
  zone.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove("dragover");
    uploadFiles(e.dataTransfer.files);
  });

  // Stop the browser from navigating to a file dropped outside the zone.
  ["dragover", "drop"].forEach((type) =>
    window.addEventListener(type, (e) => { if (hasFiles(e)) e.preventDefault(); })
  );
}

/* ---------------------------------------------------------- clear folders */
async function clearStorage(target, folderName) {
  try {
    const countRes = await fetch(`${API}/api/storage/${target}`);
    const { count } = await countRes.json();
    if (!count) {
      alert(`Thư mục ${folderName} đang trống, không có tệp nào để xoá.`);
      return;
    }
    if (!confirm(`Xoá toàn bộ ${count} tệp trong thư mục ${folderName}?\nHành động này không thể hoàn tác.`)) return;

    const res = await fetch(`${API}/api/storage/${target}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      alert(data.detail || "Xoá thất bại");
      return;
    }
    let msg = `Đã xoá ${data.deleted} tệp trong thư mục ${folderName}.`;
    if (data.failed) msg += `\n${data.failed} tệp không xoá được.`;
    alert(msg);

    if (target === "input") {
      // The selected source video no longer exists.
      state.selected = null;
      state.jobId = null;
      await loadVideos();
      showStep(1);
    }
  } catch (err) {
    alert(`Lỗi: ${err.message || err}`);
  }
}

async function selectVideo(v) {
  state.selected = v;
  renderGrid();
  showStep(2);
  setupTrim();
}

/* --------------------------------------------------------------- trimming */
function setupTrim() {
  const v = state.selected;
  if (!v) return;

  const vid = $("#trimVideo");
  vid.src = `${API}/api/videos/${v.id}/stream`;
  vid.onloadedmetadata = () => {
    state.trim.duration = vid.duration || v.duration || 0;
    state.trim.start = 0;
    state.trim.end = state.trim.duration;
    syncTrimUI();
    drawWaveform();
  };

  $("#trimMeta").textContent = `${v.filename} — ${v.width}×${v.height} — ${fmt(state.trim.duration)}`;
  ["#startRange", "#endRange", "#durRange"].forEach((s) => {
    $(s).max = state.trim.duration || 100;
  });
}

function syncTrimUI() {
  const { start, end, duration } = state.trim;
  $("#startRange").value = start;
  $("#endRange").value = end;
  $("#durRange").value = end - start;
  $("#startVal").textContent = fmt(start);
  $("#endVal").textContent = fmt(end);
  $("#durVal").textContent = fmt(end - start);

  const pct = (t) => (duration ? (t / duration) * 100 : 0);
  const a = pct(start);
  const b = pct(end);
  $("#tlSelection").style.left = a + "%";
  $("#tlSelection").style.width = Math.max(0, b - a) + "%";
  $("#tlStart").style.left = a + "%";
  $("#tlEnd").style.left = b + "%";

  $("#btnToStep3").disabled = end - start < 0.1;
}

function setStart(t) {
  state.trim.start = Math.min(Math.max(0, t), state.trim.end - 0.05);
  syncTrimUI();
}
function setEnd(t) {
  state.trim.end = Math.max(Math.min(state.trim.duration, t), state.trim.start + 0.05);
  syncTrimUI();
}

function bindTrim() {
  $("#startRange").oninput = (e) => setStart(parseFloat(e.target.value));
  $("#endRange").oninput = (e) => setEnd(parseFloat(e.target.value));
  $("#durRange").oninput = (e) => {
    const d = parseFloat(e.target.value);
    const start = Math.min(state.trim.start, state.trim.duration - d);
    state.trim.start = Math.max(0, start);
    state.trim.end = Math.min(state.trim.duration, state.trim.start + d);
    syncTrimUI();
  };
  $("#btnSetStart").onclick = () => setStart($("#trimVideo").currentTime);
  $("#btnSetEnd").onclick = () => setEnd($("#trimVideo").currentTime);
  $("#btnToStep3").onclick = () => {
    showStep(3);
  };

  document.addEventListener("keydown", (e) => {
    if (!$("#panel-2").classList.contains("active")) return;
    if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
    const v = $("#trimVideo");
    if (e.key === "ArrowLeft") { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 0.05); }
    if (e.key === "ArrowRight") { e.preventDefault(); v.currentTime = Math.min(state.trim.duration, v.currentTime + 0.05); }
  });

  // Timeline dragging
  const tl = $(".timeline");
  let dragTarget = null;
  tl.addEventListener("mousedown", (e) => {
    const rect = tl.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const t = ratio * state.trim.duration;
    if (Math.abs(t - state.trim.start) < 0.3) dragTarget = "start";
    else if (Math.abs(t - state.trim.end) < 0.3) dragTarget = "end";
    else dragTarget = "move";
    dragState = { ratio, origStart: state.trim.start, origEnd: state.trim.end };
    onTimelineDrag(e);
  });
  let dragState = null;
  document.addEventListener("mousemove", (e) => { if (dragTarget) onTimelineDrag(e); });
  document.addEventListener("mouseup", () => { dragTarget = null; dragState = null; });

  function onTimelineDrag(e) {
    if (!dragState) return;
    const rect = tl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const t = ratio * state.trim.duration;
    if (dragTarget === "start") setStart(t);
    else if (dragTarget === "end") setEnd(t);
    else {
      const delta = t - dragState.ratio * state.trim.duration;
      let s = Math.max(0, Math.min(state.trim.duration - (dragState.origEnd - dragState.origStart), dragState.origStart + delta));
      let e2 = s + (dragState.origEnd - dragState.origStart);
      state.trim.start = s; state.trim.end = e2;
      syncTrimUI();
    }
  }
}

/* Simple waveform (RMS per pixel via decodeAudioData is heavy; use <video> seek sampling) */
async function drawWaveform() {
  const canvas = $("#waveCanvas");
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = 70 * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.fillStyle = "#171922";
  ctx.fillRect(0, 0, rect.width, 70);

  // Analyser-free approximation: draw a synthetic profile from duration.
  const grad = ctx.createLinearGradient(0, 0, 0, 70);
  grad.addColorStop(0, "#6d5cff");
  grad.addColorStop(1, "#21d4a2");
  ctx.fillStyle = grad;
  const bars = 180;
  for (let i = 0; i < bars; i++) {
    const h = 6 + Math.abs(Math.sin(i * 0.35) * 22 + Math.sin(i * 0.11) * 16);
    const x = (i / bars) * rect.width;
    ctx.globalAlpha = 0.75;
    ctx.fillRect(x, 70 - h, rect.width / bars - 1.5, h);
  }
  ctx.globalAlpha = 1;
}

/* ---------------------------------------------------------------- overlays */
let ovSeq = 0;

function addOverlay(type) {
  const ov = {
    id: `ov${++ovSeq}`,
    type,               // 'text' | 'box'
    text: type === "text" ? "Văn bản" : "",
    x: 0.5, y: type === "text" ? 0.12 : 0.9,
    font_size: 0.06,
    color: "#FFFFFF",
    font: "Arial",
    bold: true,
    opacity: 1,
    is_box: type === "box",
    box_color: "#000000",
    box_opacity: 1,
    // Text overlays start hidden so nothing covers the video by accident.
    // Logo-masking boxes start visible since that is their purpose.
    visible: type !== "text",
    width: 0.8,
  };
  state.overlays.push(ov);
  renderOverlays();
  drawOverlay();
}

function renderOverlays() {
  const list = $("#overlayList");
  list.innerHTML = "";
  for (const ov of state.overlays) {
    const card = document.createElement("div");
    card.className = "ov-card";
    card.innerHTML = `
      <div class="ov-head">
        <div class="t">${ov.type === "box" ? "Khung che" : escapeHtml(ov.text || "Chữ")}</div>
        <button class="vis ${ov.visible ? "on" : ""}">${ov.visible ? "👁" : "🚫"}</button>
        <button class="del danger">✕</button>
      </div>
      <div class="ov-grid"></div>`;
    const grid = card.querySelector(".ov-grid");

    if (ov.type === "text") {
      grid.appendChild(row("Nội dung", `<input type="text" value="${escapeAttr(ov.text)}">`, "full", (e) => { ov.text = e.target.value; card.querySelector(".t").textContent = ov.text || "Chữ"; }));
      grid.appendChild(row("Font", `<select>${["Arial", "Arial Black", "Impact", "Verdana", "Helvetica", "Georgia", "Times", "Courier"].map((f) => `<option ${f === ov.font ? "selected" : ""}>${f}</option>`).join("")}</select>`, "", (e) => { ov.font = e.target.value; }));
      grid.appendChild(row("Màu chữ", `<input type="color" value="${ov.color}">`, "", (e) => { ov.color = e.target.value; }));
      grid.appendChild(row("Cỡ chữ (% cao)", `<input type="number" step="0.005" min="0.02" max="0.3" value="${ov.font_size}">`, "", (e) => { ov.font_size = parseFloat(e.target.value) || 0.06; }));
      grid.appendChild(row("X (%)", `<input type="number" step="0.005" min="0" max="1" value="${ov.x.toFixed(3)}">`, "", (e) => { ov.x = parseFloat(e.target.value); }));
      grid.appendChild(row("Y (%)", `<input type="number" step="0.005" min="0" max="1" value="${ov.y.toFixed(3)}">`, "", (e) => { ov.y = parseFloat(e.target.value); }));
      grid.appendChild(row("Đậm", `<select><option value="1" ${ov.bold ? "selected" : ""}>Có</option><option value="0" ${!ov.bold ? "selected" : ""}>Không</option></select>`, "", (e) => { ov.bold = e.target.value === "1"; }));
      grid.appendChild(row("Độ đục (%)", `<input type="number" step="0.05" min="0" max="1" value="${ov.opacity}">`, "", (e) => { ov.opacity = parseFloat(e.target.value); }));
      grid.appendChild(row("Xoay (°)", `<input type="number" step="1" min="-180" max="180" value="${ov.rotation || 0}">`, "", (e) => { ov.rotation = parseFloat(e.target.value) || 0; drawOverlay(); }));
    } else {
      grid.appendChild(row("Màu khung", `<input type="color" value="${ov.box_color}">`, "", (e) => { ov.box_color = e.target.value; }));
      grid.appendChild(row("Độ đục", `<input type="number" step="0.05" min="0" max="1" value="${ov.box_opacity}">`, "", (e) => { ov.box_opacity = parseFloat(e.target.value); }));
      grid.appendChild(row("X (%)", `<input type="number" step="0.005" min="0" max="1" value="${ov.x.toFixed(3)}">`, "", (e) => { ov.x = parseFloat(e.target.value); }));
      grid.appendChild(row("Y (%)", `<input type="number" step="0.005" min="0" max="1" value="${ov.y.toFixed(3)}">`, "", (e) => { ov.y = parseFloat(e.target.value); }));
      grid.appendChild(row("Rộng (%)", `<input type="number" step="0.01" min="0.05" max="1" value="${ov.width}">`, "", (e) => { ov.width = parseFloat(e.target.value); }));
      grid.appendChild(row("Cao (%)", `<input type="number" step="0.01" min="0.02" max="1" value="${ov.font_size}">`, "", (e) => { ov.font_size = parseFloat(e.target.value); }));
      grid.appendChild(row("Xoay (°)", `<input type="number" step="1" min="-180" max="180" value="${ov.rotation || 0}">`, "", (e) => { ov.rotation = parseFloat(e.target.value) || 0; drawOverlay(); }));
    }

    card.querySelector(".vis").onclick = (e) => { ov.visible = !ov.visible; renderOverlays(); drawOverlay(); };
    card.querySelector(".del").onclick = () => {
      state.overlays = state.overlays.filter((o) => o.id !== ov.id);
      renderOverlays(); drawOverlay();
    };
    list.appendChild(card);
  }
}

function row(label, inputHTML, cls, onInput) {
  const wrap = document.createElement("div");
  if (cls) wrap.className = cls;
  wrap.innerHTML = `<label>${label}</label>${inputHTML}`;
  const inp = wrap.querySelector("input, select");
  // Some rows render a read-only summary instead of a control.
  if (inp && onInput) inp.addEventListener("input", (e) => { onInput(e); drawOverlay(); });
  return wrap;
}

const escapeHtml = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const escapeAttr = (s) => escapeHtml(s);

/* --------------------------------------------------------------- stickers */
let stSeq = 0;
// url -> HTMLImageElement, so a redraw never waits on the network.
const stickerImages = new Map();

function stickerImage(url) {
  let img = stickerImages.get(url);
  if (!img) {
    img = new Image();
    img.onload = () => drawOverlay();
    img.src = url;
    stickerImages.set(url, img);
  }
  return img;
}

/** Sprite sheet for an animated library entry, or null if it has none. */
function stickerSheet(lib) {
  if (!lib || !lib.sheet) return null;
  return stickerImage(lib.sheet);
}

/** Library entry for the file behind a placed sticker overlay. */
function stickerLibEntry(ov) {
  return (state.stickerLib || []).find((s) => s.name === ov.sticker) || null;
}

/** True when any visible sticker needs per-frame redraws to animate. */
function hasAnimatedStickers(t) {
  for (const ov of state.stickers) {
    if (!stickerVisibleAt(ov, t)) continue;
    const lib = stickerLibEntry(ov);
    if (lib && lib.animated && lib.sheet) return true;
  }
  return false;
}

function setStickerStatus(text, isError = false) {
  const el = $("#stickerStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", isError);
  clearTimeout(setStickerStatus._t);
  if (text && !isError) {
    setStickerStatus._t = setTimeout(() => { el.textContent = ""; }, 4000);
  }
}

async function loadStickers() {
  try {
    const res = await fetch(`${API}/api/stickers`);
    state.stickerLib = res.ok ? await res.json() : [];
  } catch (_) {
    state.stickerLib = [];
  }
  // Warm the image cache so the first drag is not laggy.
  for (const s of state.stickerLib) {
    stickerImage(s.url);
    stickerSheet(s);
  }
  renderStickerPicker();
}

function renderStickerPicker() {
  const picker = $("#stickerPicker");
  picker.innerHTML = "";
  if (!state.stickerLib.length) {
    picker.innerHTML = `<div class="sticker-empty muted">Chưa có sticker. Tải ảnh PNG/GIF/WEBP từ file để dùng.</div>`;
    return;
  }
  for (const s of state.stickerLib) {
    const item = document.createElement("div");
    item.className = "sticker-item";
    const details = [
      s.width ? `${s.width}×${s.height}` : "",
      s.animated && s.frames ? `${s.frames} khung` : "",
      s.animated && s.duration ? `${s.duration.toFixed(1)}s` : "",
    ].filter(Boolean);
    item.title = [s.name, ...details].join(" · ");
    // GIF thumbnails animate on their own; other animated formats get the
    // sheet's first frame so the tile is not blank.
    item.innerHTML = `<img src="${s.url}" alt="${escapeAttr(s.name)}" loading="lazy" />`;
    if (s.animated) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "ĐỘNG";
      item.appendChild(badge);
    }
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Xoá khỏi thư viện";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Xoá sticker ${s.name} khỏi thư viện?`)) return;
      await fetch(`${API}/api/stickers/${encodeURIComponent(s.name)}`, { method: "DELETE" });
      state.stickers = state.stickers.filter((x) => x.sticker !== s.name);
      stickerImages.delete(s.url);
      if (s.sheet) stickerImages.delete(s.sheet);
      await loadStickers();
      renderStickers();
      drawOverlay();
    };
    item.appendChild(del);
    item.onclick = () => addSticker(s);
    picker.appendChild(item);
  }
}

/** Upload one sticker file; resolves to the created library entry. */
function uploadStickerFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/api/stickers/upload`);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch (_) { resolve(null); }
        return;
      }
      let detail = "Upload sticker lỗi";
      try { detail = JSON.parse(xhr.responseText).detail || detail; } catch (_) { /* keep default */ }
      reject(new Error(detail));
    };
    xhr.onerror = () => reject(new Error("Mất kết nối khi upload sticker"));
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

async function uploadStickerFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let ok = 0;
  const errors = [];
  let last = null;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    setStickerStatus(`Đang tải ${f.name}${files.length > 1 ? ` (${i + 1}/${files.length})` : ""}…`);
    try {
      last = await uploadStickerFile(f);
      ok++;
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }
  await loadStickers();
  // Drop the freshly uploaded sticker straight onto the canvas.
  if (last && ok === 1) addSticker(last);
  const msg = `Đã tải ${ok}/${files.length} sticker`;
  setStickerStatus(errors.length ? `${msg} · lỗi: ${errors.join("; ")}` : msg, errors.length > 0);
}

function addSticker(lib) {
  // Stagger new stickers slightly so a stack of them stays visible.
  const n = state.stickers.length;
  const ov = {
    id: `st${++stSeq}`,
    sticker: lib.name,
    url: lib.url,
    x: 0.5,
    y: 0.5,
    width: 0.3,
    rotation: 0,
    opacity: 1,
    start: 0,
    end: 0,
    fade_in: 0,
    fade_out: 0,
    visible: true,
    // Remembered only for the preview; the backend re-probes the file.
    aspect: lib.width && lib.height ? lib.width / lib.height : 1,
  };
  if (n > 0) {
    const offset = Math.min(0.18, 0.06 * n);
    ov.x = clamp01(0.5 + ((n % 2 ? 1 : -1) * offset));
    ov.y = clamp01(0.5 + offset * 0.6);
  }
  state.stickers.push(ov);
  selectedSticker = ov.id;
  selectedOv = null;
  stickerImage(lib.url);
  stickerSheet(lib);
  renderStickers();
  drawOverlay();
  return ov;
}

function stickerTimingLabel(ov) {
  const hasEnd = ov.end > ov.start + 0.001;
  if (ov.start <= 0.001 && !hasEnd) return "cả clip";
  return `${fmt(ov.start)} → ${hasEnd ? fmt(ov.end) : "hết"}`;
}

function renderStickers() {
  const list = $("#stickerList");
  if (!list) return;
  list.innerHTML = "";
  for (const ov of state.stickers) {
    const card = document.createElement("div");
    card.className = "ov-card";
    const lib = stickerLibEntry(ov);
    const animatedTag = lib && lib.animated ? ` <span class="badge inline">ĐỘNG</span>` : "";
    card.innerHTML = `
      <div class="ov-head">
        <div class="t" title="${escapeAttr(ov.sticker)}">🖼 ${escapeHtml(ov.sticker)}${animatedTag}</div>
        <button class="vis ${ov.visible ? "on" : ""}">${ov.visible ? "👁" : "🚫"}</button>
        <button class="del danger">✕</button>
      </div>
      <div class="ov-grid"></div>`;
    const grid = card.querySelector(".ov-grid");

    grid.appendChild(row("X (%)", `<input type="number" step="0.005" min="0" max="1" value="${ov.x.toFixed(3)}">`, "", (e) => { ov.x = clamp01(parseFloat(e.target.value)); }));
    grid.appendChild(row("Y (%)", `<input type="number" step="0.005" min="0" max="1" value="${ov.y.toFixed(3)}">`, "", (e) => { ov.y = clamp01(parseFloat(e.target.value)); }));
    grid.appendChild(row("Rộng (% khung)", `<input type="number" step="0.01" min="0.02" max="1.5" value="${ov.width}">`, "", (e) => { ov.width = parseFloat(e.target.value) || 0.3; }));
    grid.appendChild(row("Xoay (°)", `<input type="number" step="1" min="-180" max="180" value="${ov.rotation}">`, "", (e) => { ov.rotation = parseFloat(e.target.value) || 0; }));
    grid.appendChild(row("Độ đục", `<input type="number" step="0.05" min="0" max="1" value="${ov.opacity}">`, "", (e) => { ov.opacity = clamp01(parseFloat(e.target.value)); }));
    grid.appendChild(row("Bắt đầu (s)", `<input type="number" step="0.1" min="0" value="${ov.start}">`, "", (e) => { ov.start = Math.max(0, parseFloat(e.target.value) || 0); updateTiming(card, ov); }));
    grid.appendChild(row("Kết thúc (s)", `<input type="number" step="0.1" min="0" value="${ov.end}">`, "", (e) => { ov.end = Math.max(0, parseFloat(e.target.value) || 0); updateTiming(card, ov); }));
    grid.appendChild(row("Mờ dần vào (s)", `<input type="number" step="0.1" min="0" value="${ov.fade_in}">`, "", (e) => { ov.fade_in = Math.max(0, parseFloat(e.target.value) || 0); }));
    grid.appendChild(row("Mờ dần ra (s)", `<input type="number" step="0.1" min="0" value="${ov.fade_out}">`, "", (e) => { ov.fade_out = Math.max(0, parseFloat(e.target.value) || 0); }));
    grid.appendChild(row("Hiện", `<div class="hint timing">${stickerTimingLabel(ov)}</div>`, "full"));

    card.querySelector(".vis").onclick = () => { ov.visible = !ov.visible; renderStickers(); drawOverlay(); };
    card.querySelector(".del").onclick = () => {
      state.stickers = state.stickers.filter((o) => o.id !== ov.id);
      renderStickers();
      drawOverlay();
    };
    list.appendChild(card);
  }
}

const clamp01 = (v) => (isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Refresh the "shows for …" summary in a sticker card without a full re-render. */
function updateTiming(card, ov) {
  const el = card.querySelector(".timing");
  if (el) el.textContent = stickerTimingLabel(ov);
}

/** Is a sticker visible at output time `t` (seconds after the trim start)? */
function stickerVisibleAt(ov, t) {
  if (!ov.visible) return false;
  if (t + 0.001 < ov.start) return false;
  if (ov.end > ov.start + 0.001 && t > ov.end) return false;
  return true;
}

/** Current preview time in OUTPUT seconds (the clip is retimed by `speed`). */
function previewTime() {
  if (!srcVideo) return 0;
  const srcT = Math.max(0, (srcVideo.currentTime || 0) - state.trim.start);
  return srcT / (state.speed || 1);
}

/** Alpha for a sticker at time `t`, honouring the fade in/out windows. */
function stickerAlpha(ov, t) {
  let a = clamp01(ov.opacity);
  if (ov.fade_in > 0.001 && t < ov.start + ov.fade_in) {
    a *= Math.max(0, (t - ov.start) / ov.fade_in);
  }
  if (ov.fade_out > 0.001 && ov.end > ov.start + 0.001) {
    const from = Math.max(ov.start, ov.end - ov.fade_out);
    if (t > from) a *= Math.max(0, (ov.end - t) / ov.fade_out);
  }
  return Math.min(1, Math.max(0, a));
}

/** Size of a sticker in canvas pixels, rotation included. */
function stickerRect(ov, OW, OH) {
  const w = Math.max(2, ov.width * OW);
  const h = Math.max(2, w / (ov.aspect || 1));
  return { w, h, cx: ov.x * OW, cy: ov.y * OH };
}

/** Axis-aligned box that contains the (possibly rotated) sticker. */
function stickerBounds(ov, OW, OH) {
  const { w, h, cx, cy } = stickerRect(ov, OW, OH);
  const rad = (ov.rotation || 0) * Math.PI / 180;
  const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
}

/**
 * Clock that drives sticker animation.
 *
 * While the clip plays this is the output timeline, so the preview matches the
 * export. While it is paused a wall clock takes over so GIF/WebP stickers keep
 * moving instead of freezing on one frame.
 */
function stickerAnimTime(t) {
  if (srcVideo && !srcVideo.paused && !srcVideo.ended) return t;
  return performance.now() / 1000;
}

function drawStickers(ctx, OW, OH, t) {
  const animT = stickerAnimTime(t);
  for (const ov of state.stickers) {
    if (!stickerVisibleAt(ov, t)) continue;
    const { w, h, cx, cy } = stickerRect(ov, OW, OH);
    const rad = (ov.rotation || 0) * Math.PI / 180;

    ctx.save();
    ctx.globalAlpha = stickerAlpha(ov, t);
    ctx.translate(cx, cy);
    if (rad) ctx.rotate(rad);

    const lib = stickerLibEntry(ov);
    const sheet = stickerSheet(lib);
    if (lib && lib.animated && sheet && sheet.complete && sheet.naturalWidth) {
      // Walk the sprite sheet on the output clock so the preview loops the
      // animation exactly like ffmpeg does with -stream_loop -1.
      const cols = Math.max(1, lib.sheet_cols || 1);
      const rows = Math.max(1, lib.sheet_rows || 1);
      const total = Math.max(1, lib.sheet_frames || cols * rows);
      const fps = lib.fps > 0 ? lib.fps : 12;
      const frame = Math.floor(Math.max(0, animT) * fps) % total;
      const cw = sheet.naturalWidth / cols;
      const ch = sheet.naturalHeight / rows;
      const sx = (frame % cols) * cw;
      const sy = Math.floor(frame / cols) * ch;
      ctx.drawImage(sheet, sx, sy, cw, ch, -w / 2, -h / 2, w, h);
    } else {
      const img = stickerImage(ov.url);
      if (img.complete && img.naturalWidth) ctx.drawImage(img, -w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }
}

/* ------------------------------------------------------- editor preview */
let srcVideo, ovCanvas, ovCtx;

function setupEditor() {
  if (!state.selected) return;
  srcVideo = $("#srcVideo");
  ovCanvas = $("#overlayCanvas");
  ovCtx = ovCanvas.getContext("2d");
  setupCrop();

  if (state.selected && srcVideo.dataset.vid !== state.selected.id) {
    srcVideo.dataset.vid = state.selected.id;
    srcVideo.src = `${API}/api/videos/${state.selected.id}/stream`;
    srcVideo.onloadedmetadata = () => {
      $("#scrub").max = srcVideo.duration;
      srcVideo.currentTime = state.trim.start;
      drawOverlay();
    };
    // A frame must be decoded before it can be drawn on a canvas.
    srcVideo.onloadeddata = () => {
      drawCropPreview();
      drawOverlay();
    };
    // Keep the preview inside the trimmed range.
    srcVideo.ontimeupdate = () => {
      if (srcVideo.currentTime >= state.trim.end - 0.02) {
        srcVideo.currentTime = state.trim.start;
      }
      if (!srcVideo.paused) {
        $("#scrub").value = srcVideo.currentTime;
        $("#scrubTime").textContent = fmt(srcVideo.currentTime);
      }
      drawOverlay();
      drawCropPreview();
    };
  }
  if (state.overlays.length === 0) addOverlay("text");

  srcVideo.playbackRate = state.speed;
  $("#btnPlay").onclick = () => {
    if (srcVideo.paused) srcVideo.play(); else srcVideo.pause();
  };
  $("#scrub").oninput = (e) => {
    srcVideo.currentTime = parseFloat(e.target.value);
    $("#scrubTime").textContent = fmt(srcVideo.currentTime);
    drawOverlay();
    drawCropPreview();
  };
  // Redraw once a seek has produced a new frame.
  srcVideo.onseeked = () => {
    drawOverlay();
    drawCropPreview();
  };

  enableOverlayDrag();
  startPreviewLoop();
  drawOverlay();
}

/**
 * Keep the preview refreshing while animated stickers are on screen.
 *
 * The canvas only redraws on video events, which stall as soon as playback is
 * paused; a small rAF loop keeps GIF/WebP stickers moving at all times.
 */
let previewLoopId = null;
function startPreviewLoop() {
  if (previewLoopId !== null) return;
  const tick = () => {
    previewLoopId = requestAnimationFrame(tick);
    if (!ovCtx) return;
    if (!hasAnimatedStickers(previewTime())) return;
    // Skip work while the tab is hidden; nothing is visible to animate.
    if (document.hidden) return;
    drawOverlay();
  };
  previewLoopId = requestAnimationFrame(tick);
}

let overlayDragBound = false;

/**
 * Geometry of the source inside the 9:16 canvas.
 * Uses the CROPPED source dimensions so the preview matches the render.
 *
 * fit_mode "blur"/"color" -> ffmpeg scales with force_original_aspect_ratio=decrease
 * (the whole cropped source fits inside the canvas, letterboxed).
 * fit_mode "crop"          -> the canvas is fully covered.
 */
function fitModeGeometry() {
  const OW = 1080, OH = 1920;
  const src = sourceGeometry();
  let srcRect = { x: 0, y: 0, w: OW, h: OH };
  if (state.fitMode !== "crop") {
    const va = src.w / src.h;
    const ta = OW / OH;
    if (va > ta) {
      // Wider than the canvas -> limited by width, letterboxed vertically.
      const w = OW, h = OW / va;
      srcRect = { x: 0, y: (OH - h) / 2, w, h };
    } else {
      // Taller than the canvas -> limited by height, letterboxed horizontally.
      const h = OH, w = OH * va;
      srcRect = { x: (OW - w) / 2, y: 0, w, h };
    }
  }
  return { OW, OH, srcRect };
}

/** The cropped source rectangle in source pixels. */
function sourceGeometry() {
  const v = srcVideo;
  const vw = v && v.videoWidth ? v.videoWidth : (state.selected ? state.selected.width : 16);
  const vh = v && v.videoHeight ? v.videoHeight : (state.selected ? state.selected.height : 9);
  const c = state.crop;
  return {
    x: c.x * vw,
    y: c.y * vh,
    w: Math.max(1, c.w * vw),
    h: Math.max(1, c.h * vh),
  };
}

/** CSS approximation of ffmpeg `eq=brightness` for the canvas preview. */
function brightnessCss() {
  const b = 1 + state.brightness * 2;
  return Math.abs(state.brightness) < 0.001 ? "none" : `brightness(${b.toFixed(3)})`;
}

/**
 * Draw the source frame honouring the crop window and horizontal flip.
 * Mirrors the ffmpeg filter order: crop -> hflip.
 */
function drawSourceFrame(ctx, dx, dy, dw, dh, mode) {
  const v = srcVideo;
  if (!v || v.readyState < 2) return;

  const s = sourceGeometry();

  ctx.save();
  ctx.filter = brightnessCss();
  if (state.flip) {
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(v, s.x, s.y, s.w, s.h, 0, 0, dw, dh);
  } else {
    ctx.drawImage(v, s.x, s.y, s.w, s.h, dx, dy, dw, dh);
  }
  ctx.restore();
}

/**
 * Draw the video layer (backdrop + foreground frame) at its current time.
 *
 * Split out from `drawOverlay()` so the paused-frame cache can reuse it: the
 * animation loop redraws ~60x/s while a GIF plays, and re-running blur filters
 * on an unchanging video frame would starve the animation of CPU.
 */
function drawVideoLayers(ctx, OW, OH, srcRect, hasFrame) {
  // --- background layer -------------------------------------------------
  if (state.fitMode === "color") {
    ctx.fillStyle = state.bgColor;
    ctx.fillRect(0, 0, OW, OH);
  } else if (hasFrame) {
    if (state.fitMode === "blur") {
      // Blurred, zoomed copy of the frame used as the backdrop.
      // ffmpeg: scale=increase (cover) -> crop -> gblur -> scale(zoom) -> crop
      const zoom = Math.max(1, state.blurZoom);
      const s = sourceGeometry();
      const va = s.w / s.h, ta = OW / OH;
      let sw, sh;
      if (va > ta) { sh = s.h; sw = sh * ta; }
      else { sw = s.w; sh = sw / ta; }
      const sx = s.x + (s.w - sw) / 2;
      const sy = s.y + (s.h - sh) / 2;

      const bw = OW * zoom, bh = OH * zoom;
      ctx.filter = `blur(${Math.round(state.blurStrength * 1.6)}px) brightness(${(0.95 * (1 + state.brightness * 2)).toFixed(3)}) saturate(1.15)`;
      ctx.save();
      if (state.flip) {
        ctx.translate(OW, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(srcVideo, sx, sy, sw, sh, (OW - bw) / 2, (OH - bh) / 2, bw, bh);
      } else {
        ctx.drawImage(srcVideo, sx, sy, sw, sh, (OW - bw) / 2, (OH - bh) / 2, bw, bh);
      }
      ctx.restore();
      ctx.filter = "none";
    } else {
      // crop: fill the frame, cropping the overflow of the CROPPED source
      const s = sourceGeometry();
      const va = s.w / s.h;
      const ta = OW / OH;
      let sw, sh;
      if (va > ta) { sh = s.h; sw = sh * ta; }
      else { sw = s.w; sh = sw / ta; }
      const sx = s.x + (s.w - sw) / 2;
      const sy = s.y + (s.h - sh) / 2;
      ctx.save();
      ctx.filter = brightnessCss();
      if (state.flip) {
        ctx.translate(OW, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(srcVideo, sx, sy, sw, sh, 0, 0, OW, OH);
      } else {
        ctx.drawImage(srcVideo, sx, sy, sw, sh, 0, 0, OW, OH);
      }
      ctx.restore();
    }
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, OW, OH);
  }

  // --- foreground video (contained) --------------------------------------
  if (hasFrame && state.fitMode !== "crop") {
    drawSourceFrame(ctx, srcRect.x, srcRect.y, srcRect.w, srcRect.h);
  }
}

// Offscreen copy of the video layer for the paused case, plus the key it was
// rendered from. Any change to the frame or the fit settings invalidates it.
let pausedLayer = null;
let pausedLayerKey = "";

function pausedLayerKeyFor(OW, OH) {
  if (!srcVideo) return "";
  const s = sourceGeometry();
  return [
    srcVideo.currentTime.toFixed(3),
    state.fitMode, state.bgColor, state.blurZoom, state.blurStrength,
    state.brightness, state.flip, state.selected && state.selected.id,
    s.x.toFixed(1), s.y.toFixed(1), s.w.toFixed(1), s.h.toFixed(1),
    OW, OH,
  ].join("|");
}

function drawOverlay() {
  if (!ovCtx) return;
  const { OW, OH, srcRect } = fitModeGeometry();
  const v = state.selected;
  const hasFrame = v && srcVideo && srcVideo.readyState >= 2;

  ovCtx.clearRect(0, 0, OW, OH);

  // While paused, the video frame does not change between animation ticks, so
  // render it once and blit it instead of re-running blur on every tick.
  const paused = srcVideo && srcVideo.paused;
  const key = paused && hasFrame ? pausedLayerKeyFor(OW, OH) : "";
  if (key && pausedLayer && pausedLayerKey === key) {
    ovCtx.drawImage(pausedLayer, 0, 0, OW, OH);
  } else {
    ovCtx.save();
    drawVideoLayers(ovCtx, OW, OH, srcRect, hasFrame);
    ovCtx.restore();
    if (key) {
      if (!pausedLayer || pausedLayer.width !== OW || pausedLayer.height !== OH) {
        pausedLayer = document.createElement("canvas");
        pausedLayer.width = OW;
        pausedLayer.height = OH;
      }
      const pctx = pausedLayer.getContext("2d");
      pctx.clearRect(0, 0, OW, OH);
      pctx.save();
      drawVideoLayers(pctx, OW, OH, srcRect, hasFrame);
      pctx.restore();
      pausedLayerKey = key;
    }
  }

  // --- overlays ----------------------------------------------------------
  for (const ov of state.overlays) {
    if (!ov.visible) continue;
    const rad = ((ov.rotation || 0) * Math.PI) / 180;
    ovCtx.save();
    // Rotate around the overlay's centre; the unrotated box is drawn at the
    // origin so both shapes share one code path.
    ovCtx.translate(ov.x * OW, ov.y * OH);
    if (rad) ovCtx.rotate(rad);

    if (ov.type === "box") {
      const w = ov.width * OW;
      const h = ov.font_size * 2.2 * OH;
      ovCtx.globalAlpha = ov.box_opacity;
      ovCtx.fillStyle = ov.box_color;
      ovCtx.fillRect(-w / 2, -h / 2, w, h);
      ovCtx.globalAlpha = 1;
    } else {
      const size = Math.max(8, ov.font_size * OH);
      ovCtx.globalAlpha = ov.opacity;
      ovCtx.font = `${ov.bold ? "bold " : ""}${size}px ${ov.font}`;
      ovCtx.textAlign = "center";
      ovCtx.textBaseline = "middle";
      ovCtx.fillStyle = ov.color;
      ovCtx.fillText(ov.text, 0, 0);
      ovCtx.globalAlpha = 1;
    }
    ovCtx.restore();
  }

  // --- stickers (on top of text and boxes) -------------------------------
  drawStickers(ovCtx, OW, OH, previewTime());

  drawSelectionHandles();
}

let selectedOv = null;
let selectedSticker = null;
// Corner grip size in canvas pixels for resizing a selected sticker.
const STICKER_GRIP = 26;
// Radius of the round rotate handle that floats above a selected sticker.
const STICKER_ROTATE_R = 18;

/** Centre a sticker's rotate handle sits at, in canvas pixels. */
function stickerRotateHandle(st, OW, OH) {
  const b = stickerBounds(st, OW, OH);
  const gap = STICKER_ROTATE_R * 2.6;
  const x = Math.min(OW - STICKER_ROTATE_R, Math.max(STICKER_ROTATE_R, b.x + b.w / 2));
  // Flip the handle below the box when there is no room above it, so the
  // control never leaves the canvas on stickers pinned to the top edge.
  let y = b.y - gap;
  if (y - STICKER_ROTATE_R < 0) y = Math.min(OH - STICKER_ROTATE_R, b.y + b.h + gap);
  return { x, y };
}

/** True when the rotate handle should hang above (vs. below) the box. */
function stickerRotateAbove(st, OW, OH) {
  const b = stickerBounds(st, OW, OH);
  return b.y - STICKER_ROTATE_R * 2.6 - STICKER_ROTATE_R >= 0;
}

/** Size of a text/box overlay in canvas pixels. */
function ovBox(ov, OW, OH) {
  let w;
  if (ov.type === "box") {
    w = ov.width * OW;
  } else {
    // measureText depends on the current font, so set it before measuring to
    // keep hit-testing in sync with what drawOverlay() actually renders.
    const size = Math.max(8, ov.font_size * OH);
    ovCtx.font = `${ov.bold ? "bold " : ""}${size}px ${ov.font}`;
    w = Math.min(OW * 0.9, Math.max(80, ovCtx.measureText(ov.text || "").width + 40));
  }
  const h = ov.type === "box" ? ov.font_size * 2.2 * OH : ov.font_size * OH * 1.4;
  return { w, h };
}

/** Round rotate handle floating above a text/box overlay, in canvas pixels. */
function ovRotateHandle(ov, OW, OH) {
  const { h } = ovBox(ov, OW, OH);
  const gap = STICKER_ROTATE_R * 2.6;
  const x = Math.min(OW - STICKER_ROTATE_R, Math.max(STICKER_ROTATE_R, ov.x * OW));
  let y = ov.y * OH - h / 2 - gap;
  if (y - STICKER_ROTATE_R < 0) y = Math.min(OH - STICKER_ROTATE_R, ov.y * OH + h / 2 + gap);
  return { x, y };
}

function ovRotateAbove(ov, OW, OH) {
  const { h } = ovBox(ov, OW, OH);
  return ov.y * OH - h / 2 - STICKER_ROTATE_R * 2.6 - STICKER_ROTATE_R >= 0;
}

/** Draw the round ↻ grip used by both stickers and overlays. */
function drawRotateGrip(h, above, anchorX, anchorY) {
  ovCtx.strokeStyle = "#ffd166";
  ovCtx.lineWidth = 3;
  ovCtx.beginPath();
  ovCtx.moveTo(anchorX, anchorY);
  ovCtx.lineTo(h.x, above ? h.y + STICKER_ROTATE_R : h.y - STICKER_ROTATE_R);
  ovCtx.stroke();
  ovCtx.beginPath();
  ovCtx.arc(h.x, h.y, STICKER_ROTATE_R, 0, Math.PI * 2);
  ovCtx.fillStyle = "#ffd166";
  ovCtx.fill();
  ovCtx.fillStyle = "#1a1408";
  ovCtx.font = `bold ${Math.round(STICKER_ROTATE_R * 1.3)}px system-ui, sans-serif`;
  ovCtx.textAlign = "center";
  ovCtx.textBaseline = "middle";
  ovCtx.fillText("↻", h.x, h.y);
}

function drawSelectionHandles() {
  const { OW, OH } = fitModeGeometry();

  if (selectedSticker) {
    const st = state.stickers.find((s) => s.id === selectedSticker);
    if (st && stickerVisibleAt(st, previewTime())) {
      const b = stickerBounds(st, OW, OH);
      ovCtx.save();
      ovCtx.strokeStyle = "#ffd166";
      ovCtx.lineWidth = 4;
      ovCtx.setLineDash([12, 8]);
      ovCtx.strokeRect(b.x, b.y, b.w, b.h);
      ovCtx.setLineDash([]);

      // Corner grip (bottom-right) resizes, the round handle above rotates.
      ovCtx.fillStyle = "#ffd166";
      ovCtx.fillRect(b.x + b.w - STICKER_GRIP, b.y + b.h - STICKER_GRIP, STICKER_GRIP * 2, STICKER_GRIP * 2);

      const h = stickerRotateHandle(st, OW, OH);
      const above = stickerRotateAbove(st, OW, OH);
      drawRotateGrip(h, above, b.x + b.w / 2, above ? b.y : b.y + b.h);
      ovCtx.restore();
    }
  }

  if (!selectedOv) return;
  const ov = state.overlays.find((o) => o.id === selectedOv);
  if (!ov) return;
  const { w, h } = ovBox(ov, OW, OH);
  const rad = ((ov.rotation || 0) * Math.PI) / 180;

  ovCtx.save();
  ovCtx.translate(ov.x * OW, ov.y * OH);
  if (rad) ovCtx.rotate(rad);
  ovCtx.strokeStyle = "#21d4a2";
  ovCtx.lineWidth = 4;
  ovCtx.setLineDash([12, 8]);
  ovCtx.strokeRect(-w / 2, -h / 2, w, h);
  ovCtx.setLineDash([]);
  ovCtx.restore();

  const grip = ovRotateHandle(ov, OW, OH);
  const above = ovRotateAbove(ov, OW, OH);
  drawRotateGrip(grip, above, ov.x * OW, above ? ov.y * OH - h / 2 : ov.y * OH + h / 2);
}

function enableOverlayDrag() {
  // setupEditor() runs on every visit to step 3; bind the handler once.
  if (overlayDragBound) return;
  overlayDragBound = true;
  const wrap = $("#canvasWrap");
  wrap.addEventListener("mousedown", (e) => {
    const rect = wrap.getBoundingClientRect();
    const { OW, OH } = fitModeGeometry();
    const px = ((e.clientX - rect.left) / rect.width) * OW;
    const py = ((e.clientY - rect.top) / rect.height) * OH;

    // Stickers are drawn on top, so they get the first hit test. The handles of
    // the currently selected sticker win even when they sit outside its box.
    let hitSticker = null;
    let onRotate = false;
    const sel = state.stickers.find((s) => s.id === selectedSticker);
    if (sel && stickerVisibleAt(sel, previewTime())) {
      const h = stickerRotateHandle(sel, OW, OH);
      if (Math.hypot(px - h.x, py - h.y) <= STICKER_ROTATE_R * 1.6) {
        hitSticker = sel;
        onRotate = true;
      }
    }
    if (!hitSticker) hitSticker = stickerAtPointer(e.clientX, e.clientY);

    if (hitSticker) {
      selectedSticker = hitSticker.id;
      selectedOv = null;
      drawOverlay();

      const b = stickerBounds(hitSticker, OW, OH);

      // Which handle did the click land on?
      const onGrip = px >= b.x + b.w - STICKER_GRIP && py >= b.y + b.h - STICKER_GRIP;

      const startWidth = hitSticker.width;
      const startRotation = hitSticker.rotation || 0;
      // Angle from the sticker centre to the pointer, captured on mousedown so
      // the sticker does not jump when the drag starts.
      const centre = { x: hitSticker.x * OW, y: hitSticker.y * OH };
      const grabAngle = Math.atan2(py - centre.y, px - centre.x);
      const startPointer = { x: px, y: py };

      const moveS = (ev) => {
        const r = wrap.getBoundingClientRect();
        const nx = ((ev.clientX - r.left) / r.width) * OW;
        const ny = ((ev.clientY - r.top) / r.height) * OH;

        if (onRotate) {
          const angle = Math.atan2(ny - centre.y, nx - centre.x);
          let deg = startRotation + ((angle - grabAngle) * 180) / Math.PI;
          // Normalise into (-180, 180] to match the number input's range.
          while (deg > 180) deg -= 360;
          while (deg <= -180) deg += 360;
          hitSticker.rotation = ev.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg);
        } else if (onGrip) {
          // Scale with the drag distance projected on the horizontal axis.
          const w = Math.max(0.02, Math.min(1.5, startWidth + (nx - startPointer.x) / OW));
          hitSticker.width = Math.round(w * 1000) / 1000;
        } else {
          hitSticker.x = clamp01(nx / OW);
          hitSticker.y = clamp01(ny / OH);
        }
        syncStickerInputs(hitSticker);
        drawOverlay();
      };
      const upS = () => {
        document.removeEventListener("mousemove", moveS);
        document.removeEventListener("mouseup", upS);
        wrap.classList.remove("sticker-dragging");
        renderStickers();
      };
      wrap.classList.add("sticker-dragging");
      document.addEventListener("mousemove", moveS);
      document.addEventListener("mouseup", upS);
      return;
    }

    if (!state.overlays.length) { selectedOv = null; selectedSticker = null; drawOverlay(); return; }

    // The rotate handle of the currently selected overlay wins over hit tests.
    let hit = null;
    let ovRotate = false;
    const selOv = state.overlays.find((o) => o.id === selectedOv);
    if (selOv) {
      const g = ovRotateHandle(selOv, OW, OH);
      if (Math.hypot(px - g.x, py - g.y) <= STICKER_ROTATE_R * 1.6) { hit = selOv; ovRotate = true; }
    }
    if (!hit) {
      for (const ov of state.overlays) {
        if (!ov.visible) continue;
        const { w, h } = ovBox(ov, OW, OH);
        if (Math.abs(px - ov.x * OW) < w / 2 && Math.abs(py - ov.y * OH) < h / 2) { hit = ov; break; }
      }
    }
    selectedSticker = null;
    selectedOv = hit ? hit.id : null;
    if (!hit) { drawOverlay(); return; }

    const startRotation = hit.rotation || 0;
    const centre = { x: hit.x * OW, y: hit.y * OH };
    const grabAngle = Math.atan2(py - centre.y, px - centre.x);

    const move = (ev) => {
      const r = wrap.getBoundingClientRect();
      const nx = ((ev.clientX - r.left) / r.width) * OW;
      const ny = ((ev.clientY - r.top) / r.height) * OH;

      if (ovRotate) {
        const angle = Math.atan2(ny - centre.y, nx - centre.x);
        let deg = startRotation + ((angle - grabAngle) * 180) / Math.PI;
        while (deg > 180) deg -= 360;
        while (deg <= -180) deg += 360;
        hit.rotation = ev.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg);
      } else {
        hit.x = Math.min(1, Math.max(0, nx / OW));
        hit.y = Math.min(1, Math.max(0, ny / OH));
      }
      drawOverlay();
      syncOverlayInputs(hit);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      renderOverlays();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  // --- wheel: zoom (plain), rotate (Shift), opacity (Alt) ----------------
  wrap.addEventListener(
    "wheel",
    (e) => {
      // Ctrl+wheel is the browser's page zoom; leave that gesture alone.
      if (e.ctrlKey || e.metaKey) return;

      // Stickers are on top, so they win the pointer test.
      const st = stickerAtPointer(e.clientX, e.clientY);
      const ov = st ? null : overlayAtPointer(e.clientX, e.clientY);
      if (!st && !ov) return; // let the page scroll when adjusting nothing
      // Own the gesture so the page does not scroll while adjusting.
      e.preventDefault();

      if (st) {
        selectedSticker = st.id;
        selectedOv = null;

        if (e.shiftKey) {
          st.rotation = stepRotation(st.rotation, e.deltaY);
        } else if (e.altKey) {
          st.opacity = stepOpacity(st.opacity, e.deltaY);
        } else {
          // Multiplicative zoom feels linear at any size; 8% per notch,
          // clamped to the same range as the number input.
          const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
          st.width = Math.round(Math.max(0.02, Math.min(1.5, st.width * factor)) * 1000) / 1000;
        }
        syncStickerInputs(st);
      } else {
        selectedOv = ov.id;
        selectedSticker = null;

        if (e.shiftKey) {
          ov.rotation = stepRotation(ov.rotation, e.deltaY);
        } else if (e.altKey) {
          // Text uses `opacity`, boxes use `box_opacity`.
          if (ov.type === "box") ov.box_opacity = stepOpacity(ov.box_opacity, e.deltaY);
          else ov.opacity = stepOpacity(ov.opacity, e.deltaY);
        } else {
          zoomOverlay(ov, e.deltaY);
        }
        syncOverlayInputs(ov);
      }

      drawOverlay();
      scheduleStickerCommit();
    },
    { passive: false }
  );

  // Show a grab cursor when the pointer is over something draggable.
  wrap.addEventListener("mousemove", (e) => {
    const hot = !!stickerAtPointer(e.clientX, e.clientY) || !!overlayAtPointer(e.clientX, e.clientY);
    wrap.classList.toggle("sticker-hot", hot);
  });
}

/** Advance a rotation angle by one wheel notch, wrapped to (-180, 180]. */
function stepRotation(current, deltaY) {
  let deg = (current || 0) + (deltaY < 0 ? 5 : -5);
  while (deg > 180) deg -= 360;
  while (deg <= -180) deg += 360;
  return Math.round(deg);
}

/** Advance an opacity value by one wheel notch, clamped to 0..1. */
function stepOpacity(current, deltaY) {
  const step = deltaY < 0 ? 0.05 : -0.05;
  return Math.round(Math.max(0, Math.min(1, (current ?? 1) + step)) * 100) / 100;
}

/** Wheel-zoom a text/box overlay: text scales its font, boxes scale both. */
function zoomOverlay(ov, deltaY) {
  const factor = deltaY < 0 ? 1.08 : 1 / 1.08;
  if (ov.type === "box") {
    ov.width = Math.round(Math.max(0.02, Math.min(1, ov.width * factor)) * 1000) / 1000;
    ov.font_size = Math.round(Math.max(0.01, Math.min(0.5, ov.font_size * factor)) * 10000) / 10000;
  } else {
    ov.font_size = Math.round(Math.max(0.01, Math.min(0.5, ov.font_size * factor)) * 10000) / 10000;
  }
}

/** Debounce re-rendering the sticker cards after a rapid wheel gesture. */
let stickerCommitTimer = null;
function scheduleStickerCommit() {
  clearTimeout(stickerCommitTimer);
  stickerCommitTimer = setTimeout(renderStickers, 220);
}

/** Topmost visible sticker under a client-space point, if any. */
function stickerAtPointer(clientX, clientY) {
  const wrap = $("#canvasWrap");
  const rect = wrap.getBoundingClientRect();
  const { OW, OH } = fitModeGeometry();
  const px = ((clientX - rect.left) / rect.width) * OW;
  const py = ((clientY - rect.top) / rect.height) * OH;

  for (let i = state.stickers.length - 1; i >= 0; i--) {
    const st = state.stickers[i];
    if (!stickerVisibleAt(st, previewTime())) continue;
    const b = stickerBounds(st, OW, OH);
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return st;
  }
  return null;
}

/** Topmost visible text/box overlay under a client-space point, if any. */
function overlayAtPointer(clientX, clientY) {
  const wrap = $("#canvasWrap");
  const rect = wrap.getBoundingClientRect();
  const { OW, OH } = fitModeGeometry();
  const px = ((clientX - rect.left) / rect.width) * OW;
  const py = ((clientY - rect.top) / rect.height) * OH;

  // Later entries are drawn on top, so iterate backwards.
  for (let i = state.overlays.length - 1; i >= 0; i--) {
    const ov = state.overlays[i];
    if (!ov.visible) continue;
    const { w, h } = ovBox(ov, OW, OH);
    if (Math.abs(px - ov.x * OW) < w / 2 && Math.abs(py - ov.y * OH) < h / 2) return ov;
  }
  return null;
}

function syncOverlayInputs(ov) {
  // Overlay cards and sticker cards share the .ov-card class, so scope the
  // lookup to the text/box list.
  const cards = $$("#overlayList .ov-card");
  const idx = state.overlays.indexOf(ov);
  const card = cards[idx];
  if (!card) return;
  const inputs = card.querySelectorAll("input[type=number]");
  const nums = Array.from(inputs);
  const byLabel = (l) => nums.find((i) => (i.previousElementSibling?.textContent || "").startsWith(l));
  const xi = byLabel("X (%)");
  const yi = byLabel("Y (%)");
  const ri = byLabel("Xoay (°)");
  if (xi) xi.value = ov.x.toFixed(3);
  if (yi) yi.value = ov.y.toFixed(3);
  if (ri) ri.value = String(Math.round(ov.rotation || 0));
  // Text cards label this "Cỡ chữ (% cao)", box cards reuse it as "Cao (%)".
  const si = byLabel("Cỡ chữ") || byLabel("Cao (%)");
  if (si) si.value = ov.font_size.toFixed(3);
  const wi = byLabel("Rộng (%)");
  if (wi) wi.value = ov.width.toFixed(3);
  // Text cards have "Độ đục (%)", box cards just "Độ đục".
  const oi = byLabel("Độ đục");
  if (oi) oi.value = (ov.type === "box" ? ov.box_opacity : ov.opacity).toFixed(2);
}

/** Push live drag changes back into the sticker's number inputs. */
function syncStickerInputs(st) {
  const idx = state.stickers.indexOf(st);
  const card = $$("#stickerList .ov-card")[idx];
  if (!card) return;
  const nums = Array.from(card.querySelectorAll("input[type=number]"));
  const byLabel = (label) => nums.find((i) => i.previousElementSibling?.textContent === label);
  const xi = byLabel("X (%)");
  const yi = byLabel("Y (%)");
  const wi = byLabel("Rộng (% khung)");
  const ri = byLabel("Xoay (°)");
  const oi = byLabel("Độ đục");
  if (xi) xi.value = st.x.toFixed(3);
  if (yi) yi.value = st.y.toFixed(3);
  if (wi) wi.value = st.width.toFixed(3);
  if (ri) ri.value = String(Math.round(st.rotation || 0));
  if (oi) oi.value = st.opacity.toFixed(2);
}

/* ---------------------------------------------------------- crop source */
let cropCanvas, cropCtx;

function setupCrop() {
  cropCanvas = $("#cropCanvas");
  cropCtx = cropCanvas.getContext("2d");
  syncCropAspect();
  syncCropUI();
  drawCropPreview();
  enableCropDrag();
}

/** Match the crop widget's aspect ratio to the source video. */
function syncCropAspect() {
  const v = state.selected;
  const box = $("#cropBox");
  if (!v || !v.width || !v.height) return;
  box.style.aspectRatio = `${v.width} / ${v.height}`;  if (cropCanvas) {
    cropCanvas.width = Math.min(960, Math.max(320, v.width));
    cropCanvas.height = Math.round((cropCanvas.width * v.height) / v.width);
  }
}

function drawCropPreview() {
  if (!cropCtx) return;
  const W = cropCanvas.width, H = cropCanvas.height;
  cropCtx.clearRect(0, 0, W, H);
  cropCtx.fillStyle = "#0a0b0e";
  cropCtx.fillRect(0, 0, W, H);

  const v = state.selected;
  if (v && srcVideo && srcVideo.readyState >= 2) {
    // Draw the FULL source frame letterboxed, so the crop window can be
    // positioned over any part of the original.
    const va = srcVideo.videoWidth / srcVideo.videoHeight;
    const ca = cropCanvas.width / cropCanvas.height;
    let dw, dh;
    if (va > ca) { dw = cropCanvas.width; dh = cropCanvas.width / va; }
    else { dh = cropCanvas.height; dw = cropCanvas.height * va; }
    const dx = (cropCanvas.width - dw) / 2, dy = (cropCanvas.height - dh) / 2;
    if (state.flip) {
      cropCtx.save();
      cropCtx.translate(cropCanvas.width, 0);
      cropCtx.scale(-1, 1);
      cropCtx.drawImage(srcVideo, dx, dy, dw, dh);
      cropCtx.restore();
    } else {
      cropCtx.drawImage(srcVideo, dx, dy, dw, dh);
    }
    // Letterbox areas are excluded from the crop rectangle.
    state._cropBox = { dx, dy, dw, dh };
  } else {
    state._cropBox = null;
  }

  drawCropOverlay();
}

function drawCropOverlay() {
  const box = state._cropBox;
  if (!box) return;
  const W = cropCanvas.width, H = cropCanvas.height;
  const { x, y, w, h } = state.crop;

  // The canvas shows the FLIPPED frame, but the crop is defined in source
  // coordinates. Mirror the rectangle horizontally when flip is on.
  const dispX = state.flip ? 1 - x - w : x;

  // Convert normalized source crop -> canvas pixel rect.
  const px = box.dx + dispX * box.dw;
  const py = box.dy + y * box.dh;
  const pw = w * box.dw;
  const ph = h * box.dh;

  // Dim everything outside the selection.
  cropCtx.fillStyle = "rgba(0,0,0,0.6)";
  cropCtx.fillRect(0, 0, W, py);
  cropCtx.fillRect(0, py + ph, W, H - py - ph);
  cropCtx.fillRect(0, py, px, ph);
  cropCtx.fillRect(px + pw, py, W - px - pw, ph);

  cropCtx.strokeStyle = "#21d4a2";
  cropCtx.lineWidth = 3;
  cropCtx.strokeRect(px, py, pw, ph);

  // Position the draggable handles.
  const wrap = $("#cropBox");
  const rect = wrap.getBoundingClientRect();
  const sx = rect.width / W, sy = rect.height / H;
  const set = (sel, l, t) => {
    const el = wrap.querySelector(sel);
    el.style.left = l + "px";
    el.style.top = t + "px";
  };
  set(".crop-handle.tl", px * sx - 6, py * sy - 6);
  set(".crop-handle.tr", (px + pw) * sx - 6, py * sy - 6);
  set(".crop-handle.bl", px * sx - 6, (py + ph) * sy - 6);
  set(".crop-handle.br", (px + pw) * sx - 6, (py + ph) * sy - 6);

  // Edge hit areas cover the whole side (12px thick), kept inside the box
  // so they stay grabbable even when the crop touches the frame border.
  const T = 12;
  const boxW = rect.width, boxH = rect.height;
  const clamp = (v, max) => Math.max(0, Math.min(max, v));
  const rx = px * sx, ry = py * sy, rw = pw * sx, rh = ph * sy;
  const edges = {
    t: { left: rx, top: clamp(ry - T / 2, boxH - T), width: rw, height: T },
    b: { left: rx, top: clamp(ry + rh - T / 2, boxH - T), width: rw, height: T },
    l: { left: clamp(rx - T / 2, boxW - T), top: ry, width: T, height: rh },
    r: { left: clamp(rx + rw - T / 2, boxW - T), top: ry, width: T, height: rh },
  };
  for (const key of Object.keys(edges)) {
    const el = wrap.querySelector(`.crop-edge.${key}`);
    const e = edges[key];
    el.style.left = e.left + "px";
    el.style.top = e.top + "px";
    el.style.width = e.width + "px";
    el.style.height = e.height + "px";
  }
}

function syncCropUI() {
  const c = state.crop;
  $("#cropX").value = Math.round(c.x * 100);
  $("#cropY").value = Math.round(c.y * 100);
  $("#cropW").value = Math.round(c.w * 100);
  $("#cropH").value = Math.round(c.h * 100);
  $("#cxVal").textContent = Math.round(c.x * 100) + "%";
  $("#cyVal").textContent = Math.round(c.y * 100) + "%";
  $("#cwVal").textContent = Math.round(c.w * 100) + "%";
  $("#chVal").textContent = Math.round(c.h * 100) + "%";
}

function setCrop(x, y, w, h) {
  // Clamp so the selection always stays inside the frame.
  w = Math.max(0.05, Math.min(1, w));
  h = Math.max(0.05, Math.min(1, h));
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  state.crop = { x, y, w, h };
  syncCropUI();
  drawCropPreview();
  drawOverlay();
}

function enableCropDrag() {
  const wrap = $("#cropBox");

  const set = (kind, dx, dy) => {
    // dx / dy are deltas in DISPLAY space (already divided by the box size).
    const start = state._dragStart;
    let dl = start.dl, dt = start.dt, dr = start.dr, db = start.db; // display rect
    if (kind === "tl") { dl += dx; dt += dy; }
    else if (kind === "tr") { dr += dx; dt += dy; }
    else if (kind === "bl") { dl += dx; db += dy; }
    else if (kind === "br") { dr += dx; db += dy; }
    // Single-edge drags move only that side.
    else if (kind === "t") { dt += dy; }
    else if (kind === "b") { db += dy; }
    else if (kind === "l") { dl += dx; }
    else if (kind === "r") { dr += dx; }
    else if (kind === "move") { dl += dx; dt += dy; dr += dx; db += dy; }

    if (dr - dl < 0.05) { if (kind === "tl" || kind === "l") dl = dr - 0.05; else dr = dl + 0.05; }
    if (db - dt < 0.05) { if (kind === "tl" || kind === "tr" || kind === "t") dt = db - 0.05; else db = dt + 0.05; }
    dl = Math.max(0, dl); dt = Math.max(0, dt);
    dr = Math.min(1, dr); db = Math.min(1, db);

    const w = dr - dl, h = db - dt;
    // Convert the display rect back to source coordinates.
    const sx = state.flip ? 1 - dr : dl;
    setCrop(sx, dt, w, h);
  };

  const onDown = (kind) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const box = state._cropBox;
    if (!box) return;
    const c = state.crop;
    const dispX = state.flip ? 1 - c.x - c.w : c.x;
    state._dragStart = {
      dl: dispX, dt: c.y, dr: dispX + c.w, db: c.y + c.h,
    };
    const rect = wrap.getBoundingClientRect();
    const sx = rect.width / cropCanvas.width;
    const sy = rect.height / cropCanvas.height;
    const startMx = e.clientX, startMy = e.clientY;

    const move = (ev) => {
      const ddx = (ev.clientX - startMx) / sx / box.dw;
      const ddy = (ev.clientY - startMy) / sy / box.dh;
      set(kind, ddx, ddy);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      state._dragStart = null;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  wrap.querySelectorAll(".crop-handle").forEach((h) => {
    h.addEventListener("mousedown", onDown(h.className.replace("crop-handle ", "")));
  });
  wrap.querySelectorAll(".crop-edge").forEach((e) => {
    e.addEventListener("mousedown", onDown(e.dataset.edge));
  });
}

/* ------------------------------------------------------------- rendering */
async function render() {
  if (!state.selected) return;
  const btn = $("#btnRender");
  btn.disabled = true;
  $("#renderProgress").classList.remove("hidden");
  $("#renderMsg").textContent = "Đang chuẩn bị...";
  $("#btnDownload").classList.add("hidden");
  showExportOverlay();

  const payload = {
    video_id: state.selected.id,
    start: state.trim.start,
    end: state.trim.end,
    fit_mode: state.fitMode,
    background_color: state.bgColor,
    blur_strength: state.blurStrength,
    blur_zoom: state.blurZoom,
    crf: state.crf,
    audio: state.keepAudio,
    volume: state.volume,
    flip: state.flip,
    speed: state.speed,
    brightness: state.brightness,
    noise: state.noise,
    sharpen: state.sharpen,
    video_bitrate: state.bitrate,
    crop_x: state.crop.x,
    crop_y: state.crop.y,
    crop_width: state.crop.w,
    crop_height: state.crop.h,
    overlays: state.overlays
      .filter((o) => o.visible)
      .map((o) => ({
        id: o.id,
        text: o.text,
        x: o.x, y: o.y, width: o.width,
        font_size: o.font_size,
        color: o.color,
        font: o.font,
        bold: o.bold,
        opacity: o.opacity,
        is_box: o.is_box,
        box_color: o.box_color,
        box_opacity: o.box_opacity,
      })),
    stickers: state.stickers
      .filter((s) => s.visible && s.sticker)
      .map((s) => ({
        id: s.id,
        sticker: s.sticker,
        x: s.x,
        y: s.y,
        width: s.width,
        rotation: s.rotation,
        opacity: s.opacity,
        start: s.start,
        end: s.end,
        fade_in: s.fade_in,
        fade_out: s.fade_out,
      })),
  };

  const res = await fetch(`${API}/api/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    btn.disabled = false;
    $("#renderMsg").textContent = data.detail || "Lỗi";
    showExportError(data.detail || "Không tạo được job render");
    return;
  }
  state.jobId = data.job_id;
  pollJob();
}

/* ------------------------------------------------------ export progress */
const RING_LEN = 2 * Math.PI * 52;

function showExportOverlay() {
  const ov = $("#exportOverlay");
  ov.classList.remove("hidden");
  const box = ov.querySelector(".export-box");
  box.classList.remove("done", "error");
  $("#exportClose").classList.add("hidden");
  $("#exportDownload").classList.add("hidden");
  updateExportProgress(0, "Đang chuẩn bị");
}

function updateExportProgress(pct, detail) {
  const p = Math.max(0, Math.min(1, pct));
  $("#exportPct").textContent = Math.round(p * 100);
  $("#ringFg").style.strokeDashoffset = String(RING_LEN * (1 - p));
  $("#exportBar").style.width = Math.round(p * 100) + "%";
  if (detail !== undefined) $("#exportDetail").textContent = detail;
}

function showExportDone(outputUrl, filename) {
  const box = $("#exportOverlay .export-box");
  box.classList.remove("error");
  box.classList.add("done");
  $("#exportTitle").textContent = "Xuất video thành công";
  $("#exportDetail").textContent = filename
    ? `Đã lưu: ${filename}`
    : "Video đã sẵn sàng để tải về.";
  updateExportProgress(1);

  const dl = $("#exportDownload");
  dl.classList.remove("hidden");
  dl.onclick = () => window.open(outputUrl, "_blank");

  const close = $("#exportClose");
  close.classList.remove("hidden");
  close.onclick = hideExportOverlay;

  $("#btnDownload").classList.remove("hidden");
  $("#btnDownload").onclick = () => window.open(outputUrl, "_blank");
}

function showExportError(message) {
  const box = $("#exportOverlay .export-box");
  box.classList.remove("done");
  box.classList.add("error");
  $("#exportTitle").textContent = "Lỗi khi xuất video";
  $("#exportDetail").textContent = message || "Không rõ nguyên nhân";
  $("#exportDownload").classList.add("hidden");
  const close = $("#exportClose");
  close.classList.remove("hidden");
  close.onclick = hideExportOverlay;
}

function hideExportOverlay() {
  $("#exportOverlay").classList.add("hidden");
}

function pollJob() {
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    let job;
    try {
      const res = await fetch(`${API}/api/jobs/${state.jobId}`);
      job = await res.json();
    } catch (err) {
      return;
    }

    const pct = job.progress || 0;
    updateExportProgress(pct, job.message || "Đang xử lý");
    $("#renderProgress .bar").style.width = Math.round(pct * 100) + "%";
    $("#renderMsg").textContent = job.message || "";

    if (job.status === "done") {
      clearInterval(state.poll);
      $("#renderMsg").textContent = "Xong!";
      $("#btnRender").disabled = false;
      showExportDone(job.output, job.filename);
    } else if (job.status === "error") {
      clearInterval(state.poll);
      $("#renderMsg").textContent = "Lỗi: " + job.message;
      $("#btnRender").disabled = false;
      showExportError(job.message);
    }
  }, 300);
}

/* ------------------------------------------------------------------ init */
function bindUI() {
  $$(".step").forEach((b) => (b.onclick = () => showStep(b.dataset.step)));
  $("#fileInput").onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // allow picking the same file again
    await uploadFiles(files);
  };
  bindDropZone();
  $("#btnClearInput").onclick = () => clearStorage("input", "videos");
  $("#btnClearOutput").onclick = () => clearStorage("output", "outputs");

  $("#btnImport").onclick = async () => {
    const path = prompt("Đường dẫn file video trên máy:");
    if (!path) return;
    const res = await fetch(`${API}/api/videos/import?path=` + encodeURIComponent(path), { method: "POST" });
    if (res.ok) await loadVideos();
    else alert((await res.json()).detail || "Import lỗi");
  };

  $$("#fitMode button").forEach((b) => {
    b.onclick = () => {
      $$("#fitMode button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.fitMode = b.dataset.mode;
      $("#colorField").style.display = state.fitMode === "color" ? "flex" : "none";
      $("#blurStrengthField").style.display = state.fitMode === "blur" ? "block" : "none";
      $("#blurZoomField").style.display = state.fitMode === "blur" ? "block" : "none";
      drawOverlay();
    };
  });
  $("#bgColor").oninput = (e) => { state.bgColor = e.target.value; drawOverlay(); };
  $("#blurStrength").oninput = (e) => { state.blurStrength = +e.target.value; $("#blurVal").textContent = e.target.value; };
  $("#blurZoom").oninput = (e) => { state.blurZoom = +e.target.value; $("#zoomVal").textContent = (+e.target.value).toFixed(2) + "x"; };
  $("#crf").oninput = (e) => { state.crf = +e.target.value; $("#crfVal").textContent = e.target.value; };
  $("#keepAudio").onchange = (e) => { state.keepAudio = e.target.checked; };
  $("#volume").oninput = (e) => {
    state.volume = +e.target.value / 100;
    $("#volVal").textContent = e.target.value + "%";
  };
  $("#speed").oninput = (e) => {
    state.speed = +e.target.value / 100;
    $("#speedVal").textContent = state.speed.toFixed(2) + "x";
    if (srcVideo) srcVideo.playbackRate = state.speed;
  };
  $("#brightness").oninput = (e) => {
    state.brightness = +e.target.value / 100;
    $("#brightVal").textContent = state.brightness.toFixed(2);
    drawOverlay();
  };
  $("#noise").oninput = (e) => {
    state.noise = +e.target.value;
    $("#noiseVal").textContent = state.noise ? String(state.noise) : "Tắt";
  };
  $("#sharpen").oninput = (e) => {
    state.sharpen = +e.target.value / 100;
    $("#sharpVal").textContent = state.sharpen ? state.sharpen.toFixed(2) : "Tắt";
  };
  $("#bitrate").oninput = (e) => {
    state.bitrate = +e.target.value;
    $("#bitrateVal").textContent = state.bitrate ? `${state.bitrate} kbps` : "Theo CRF";
  };
  $("#flip").onchange = (e) => {
    state.flip = e.target.checked;
    drawOverlay();
    drawCropPreview();
  };

  // crop sliders
  $("#cropX").oninput = (e) => setCrop(+e.target.value / 100, state.crop.y, state.crop.w, state.crop.h);
  $("#cropY").oninput = (e) => setCrop(state.crop.x, +e.target.value / 100, state.crop.w, state.crop.h);
  $("#cropW").oninput = (e) => setCrop(state.crop.x, state.crop.y, +e.target.value / 100, state.crop.h);
  $("#cropH").oninput = (e) => setCrop(state.crop.x, state.crop.y, state.crop.w, +e.target.value / 100);
  $("#btnResetCrop").onclick = () => setCrop(0, 0, 1, 1);

  $("#btnAddText").onclick = () => addOverlay("text");
  $("#btnAddBox").onclick = () => addOverlay("box");

  // stickers
  $("#stickerFile").onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // allow picking the same file again
    await uploadStickerFiles(files);
  };
  $("#btnStickerImport").onclick = async () => {
    const path = prompt("Đường dẫn file sticker trên máy (PNG/JPG/GIF/WEBP):");
    if (!path) return;
    const res = await fetch(`${API}/api/stickers/import?path=${encodeURIComponent(path)}`, { method: "POST" });
    if (res.ok) {
      const lib = await res.json();
      await loadStickers();
      addSticker(lib);
      setStickerStatus(`Đã thêm ${lib.name}`);
    } else {
      setStickerStatus((await res.json().catch(() => ({}))).detail || "Import sticker lỗi", true);
    }
  };

  $("#btnRender").onclick = render;
}

bindUI();
bindTrim();
loadVideos();
loadStickers();
showStep(1);
