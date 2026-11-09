# AutoCut

Công cụ cắt video và xuất bản Shorts 9:16. Backend Python (FastAPI + ffmpeg), giao diện web thuần (không cần build step).

## Chạy

```bash
./run.sh
```

Mở <http://127.0.0.1:8787>.

Cần Python 3.10+. ffmpeg được tự tìm theo thứ tự: `ffmpeg` trong PATH → `static-ffmpeg` (pip) → `imageio-ffmpeg` (pip). Nếu chưa có:

```bash
pip install -r requirements.txt
# hoặc
brew install ffmpeg
```

## Quy trình 3 bước

1. **Chọn video** — kéo thả file vào khung (nhiều file cùng lúc, có % tiến độ upload), bấm Upload, nhập đường dẫn từ máy, hoặc chọn trong thư viện. Tệp không phải video sẽ bị bỏ qua. Danh sách có poster thumbnail, độ dài, độ phân giải.
2. **Cắt** — chọn điểm bắt đầu / kết thúc bằng slider, thanh timeline kéo-thả, hoặc nút "Đặt điểm" theo vị trí video đang phát. Phím `←` / `→` dịch khung hình 0.05s.
3. **Fill 9:16 & Overlay** — chọn cách fill nền, thêm text/khung che/sticker, xem preview trực tiếp trên khung 9:16, rồi xuất MP4.

## Tuỳ chọn fill nền 9:16

| Chế độ | Kết quả |
|---|---|
| **Blur nền** | Video gốc giữ nguyên tỉ lệ ở giữa, phần nền thừa lấy từ chính frame đó làm blur (tuỳ chỉnh độ blur + zoom) |
| **Màu** | Video gốc giữ tỉ lệ ở giữa, phần nền thừa lấp bằng màu tuỳ chỉnh |
| **Crop xuyên** | Video phủ kín khung 9:16, cắt bỏ phần thừa ở hai bên |

### Nguồn

| Tuỳ chọn | Mặc định | Ghi chú |
|---|---|---|
| **Lật ngang (flip)** | ✅ Bật | `hflip` trong ffmpeg — dùng khi nguồn video bị ghi ngược |
| **Âm lượng** | 70% | Slider 0–200%, áp dụng qua filter `volume` |
| **CRF** | 18 | Chỉ dùng khi bitrate = 0 |
| **FPS** | Giữ nguyên nguồn | API `fps: 0` = theo nguồn, đặt số > 0 để ép |
| **Tốc độ** | 1.02x | Thay đổi rất nhẹ (+2%). Phạm vi 0.5x–2x. Video dùng `setpts`, audio dùng `atempo` |
| **Độ sáng** | +0.02 | Phạm vi ±0.30 qua `eq=brightness` |
| **Nhiễu nhẹ** | 2 | Phạm vi 0–20, filter `noise=alls=N:allf=t+u` trên frame cuối (sau overlay). 0 = tắt |
| **Độ nét** | 0.30 | 0–1, filter `cas` (Contrast Adaptive Sharpening) chỉ áp lên lớp video chính, trước overlay và nhiễu. Scale luôn dùng Lanczos. 0 = tắt cas |
| **Bitrate video** | 4000 kbps | 0 = dùng CRF; >0 = `-b:v` (kèm `maxrate`/`bufsize`), tối đa 12000 kbps trên UI |

### Crop vùng nguồn

Chọn vùng cắt khỏi **video gốc** trước khi fill 9:16.

- **4 slider** (X, Y, Rộng, Cao)
- **Kéo góc** (`tl`/`tr`/`bl`/`br`) — đổi cả 2 chiều
- **Kéo cạnh** (`t`/`b`/`l`/`r`) — chỉ đổi 1 chiều, giữ nguyên cạnh đối diện

Vùng crop dùng toạ độ chuẩn hoá 0..1 nên áp dụng đúng cho mọi kích thước xuất.

Thứ tự xử lý trong ffmpeg: **crop → flip → độ sáng → tốc độ → fill 9:16 → overlay → nhiễu**. Output luôn được re-encode libx264. Preview trên web mô phỏng đúng thứ tự này.

## Tiến độ xuất video

Khi bấm **Xuất video**, hiện overlay toàn màn hình với:
- Vòng tròn SVG tiến độ + số phần trăm
- Thanh tiến độ ngang
- Trạng thái và **thời gian còn lại ước tính** (ETA) — ví dụ `Đang xuất 42% · còn ~3s`
- Khi xong: vòng tròn chuyển xanh, nút **Tải video**
- Khi lỗi: vòng tròn chuyển đỏ, hiện thông báo lỗi ffmpeg

Backend đọc tiến độ từ `-progress pipe:1` của ffmpeg và tính ETA từ thời gian đã trôi qua.

## Overlay

- **Chữ**: nội dung, font (Arial, Arial Black, Impact, Verdana, Helvetica, Georgia, Times, Courier), màu, cỡ (% chiều cao khung), đậm, độ đục. Kéo trực tiếp trên khung preview để định vị.
- **Khung che**: hình chữ nhật đục để che logo/watermark — màu, độ đục, vị trí, kích thước.
- **Sticker**: xem mục [Sticker](#sticker) bên dưới.

Tọa độ overlay lưu dạng chuẩn hoá 0..1 nên đúng khi xuất ở bất kỳ kích thước nào.

## Sticker

Gắn sticker (ảnh) lên khung 9:16. Thư viện sticker nằm ở `data/stickers/`.

- **Tải từ file** — nút "⬆ Tải sticker từ file" nhận PNG / JPG / WEBP / GIF / BMP / AVIF / APNG, hoặc video ngắn (MP4 / WEBM / MOV). Nhiều file cùng lúc.
- **Nhập từ máy** — dán đường dẫn tuyệt đối tới file sticker.
- **Thêm lên khung** — bấm vào sticker trong thư viện để đặt lên canvas. Kéo trực tiếp trên preview để di chuyển; kéo góc dưới bên phải để đổi kích thước.

Mỗi sticker có thể chỉnh:

| Tuỳ chọn | Mặc định | Ghi chú |
|---|---|---|
| **X / Y** | 0.5 | Toạ độ chuẩn hoá 0..1 (tâm sticker) |
| **Rộng (% khung)** | 30% | Chiều cao giữ nguyên tỉ lệ ảnh |
| **Xoay (°)** | 0 | -180 → 180 |
| **Độ đục** | 100% | 0–100% |
| **Bắt đầu / Kết thúc (s)** | 0 / hết clip | Khoảng thời gian hiển thị, tính theo thời lượng output |
| **Mờ dần vào / ra (s)** | 0 | Fade alpha tại đầu / cuối khoảng thời gian |

Sticker tĩnh được dùng ở dạng ảnh có alpha (PNG nền trong suốt cho kết quả tốt nhất). Sticker vẽ phía trên chữ và khung che.

### GIF / APNG / WEBP động

Ảnh động được nhận diện **theo nội dung file, không theo đuôi file** (cờ `animated`, kèm `frames` / `fps` / `duration`), rồi chạy đúng trong cả preview lẫn video xuất ra:

- **Preview**: canvas chỉ vẽ được frame đầu của GIF, nên backend tách sticker động thành một *sprite sheet* PNG (`data/cache/sticker_sheets/`) và frontend phát lại các ô theo đồng hồ thời gian. Sticker vẫn chạy khi video đang tạm dừng.
- **Xuất video**: mọi sticker đều được nạp bằng `-stream_loop -1`. Ảnh tĩnh (không phải container) nhận thêm `-framerate` để không bị stutter; sau đó `scale`, `rotate`, `fade`, `overlay` áp như bình thường, nên animation lặp suốt clip và vẫn giữ nền trong suốt.
- Thẻ sticker động có nhãn **ĐỘNG** trong thư viện và trên danh sách sticker đã đặt.

Nhận diện theo nội dung là bắt buộc: APNG thường được lưu với đuôi `.png`, và nếu bị coi là ảnh tĩnh thì ffmpeg từ chối thẳng file đó (`-loop` không phải option của demuxer image2), khiến sticker biến mất khỏi video xuất ra. Ngược lại một `.webp`/`.gif` hoàn toàn có thể là ảnh tĩnh.

Video container (MP4/WEBM/MOV/AVIF) dùng làm sticker cũng được loop bằng `-stream_loop -1` nhưng không tạo sprite sheet — chúng chỉ hiển thị frame đầu trong preview, còn bản xuất vẫn đầy đủ chuyển động.

## API

| Method | Endpoint | Mô tả |
|---|---|---|
| `GET` | `/api/videos` | Danh sách video trong thư viện |
| `POST` | `/api/videos/upload` | Upload file (multipart `file`) |
| `POST` | `/api/videos/import?path=...` | Import từ đường dẫn máy |
| `GET` | `/api/videos/{id}/stream` | Stream video (hỗ trợ seek) |
| `DELETE` | `/api/videos/{id}` | Xoá video |
| `POST` | `/api/render` | Tạo job render 9:16 |
| `GET` | `/api/jobs/{id}` | Trạng thái + tiến độ job |
| `GET` | `/api/files/{name}` | File tĩnh (output, preview, poster) |
| `GET` | `/api/storage/{input\|output}` | Đếm số tệp trong `data/videos` hoặc `data/outputs` |
| `DELETE` | `/api/storage/{input\|output}` | Xoá toàn bộ tệp trong thư mục đó, trả về `deleted` / `failed` (409 nếu đang có job xuất) |
| `GET` | `/api/stickers` | Danh sách sticker trong thư viện (kèm kích thước, cờ `animated`, `frames`/`fps`/`duration`, sprite sheet nếu là ảnh động) |
| `POST` | `/api/stickers/upload` | Upload sticker (multipart `file`) |
| `POST` | `/api/stickers/import?path=...` | Import sticker từ đường dẫn máy |
| `GET` | `/api/stickers/{name}` | Trả về file sticker |
| `GET` | `/api/sticker-sheets/{name}` | Sprite sheet PNG dùng để phát lại ảnh động trong preview |
| `DELETE` | `/api/stickers/{name}` | Xoá sticker khỏi thư viện |

## Cấu trúc

```
backend/
  main.py      FastAPI app + REST endpoints
  render.py    Dựng filter graph ffmpeg (fill 9:16, drawtext, drawbox, sticker overlay)
  stickers.py  Thư viện sticker: liệt kê, probe, upload
  jobs.py      Job render nền, theo dõi tiến độ
  ffmpeg_utils.py  ffprobe, poster, resolve font
  settings.py  Đường dẫn data, tìm ffmpeg/ffprobe
  schemas.py   Pydantic models
web/
  index.html   3 panel: chọn video / cắt / editor
  app.js       Logic UI, preview canvas, gọi API
  style.css
data/
  videos/      Video nguồn
  stickers/    Sticker (PNG/GIF/WEBP…) dùng để gắn lên video
  outputs/     Video đã xuất + preview jpg
  cache/       Poster thumbnail
```

## Tuỳ chọn môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `AUTOCUT_HOST` | `127.0.0.1` | Host |
| `AUTOCUT_PORT` | `8787` | Port |
| `AUTOCUT_DATA_DIR` | `./data` | Thư mục dữ liệu |

## Kiểm tra

```bash
# cần server đang chạy ở 127.0.0.1:8787
python3 scripts/verify_flip_crop.py    # flip + crop
python3 scripts/verify_stickers.py     # vị trí / thời gian / fade, và GIF động thật sự chạy
```

`verify_stickers.py` tự upload sticker test (một ảnh tĩnh, một GIF động và một APNG đặt đuôi `.png`), render vài clip ngắn rồi lấy mẫu frame để kiểm tra vị trí, khoảng hiển thị, fade và chuyển động, sau đó xoá các sticker đó đi. Đặt `AUTOCUT_API` nếu server chạy ở địa chỉ khác.
