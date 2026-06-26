# Facebook Fanpage Crawler

Thu thập posts và engagement metrics từ 9 fanpage bảo hiểm nhân thọ.

## Cài đặt (chạy 1 lần)

```bash
# 1. Cài Node.js từ https://nodejs.org (chọn bản LTS)

# 2. Vào thư mục project
cd fb-crawler

# 3. Cài dependencies
npm install

# 4. Cài Chromium
npx playwright install chromium
```

## Cấu hình date range

Mở file `crawler.js`, tìm phần CONFIG và chỉnh:

```js
const DATE_FROM = '2025-06-01'; // lấy post từ ngày này
const DATE_TO   = null;          // đến ngày này (null = đến hôm nay)
```

**Ví dụ:**
- Lấy 7 ngày gần nhất: `DATE_FROM = '2025-06-17'` (hôm nay - 7)
- Lấy tháng 5/2025: `DATE_FROM = '2025-05-01'`, `DATE_TO = '2025-05-31'`
- Lấy tất cả: `DATE_FROM = null`, `DATE_TO = null`

## Chạy

```bash
npm start
```

**Lần đầu chạy:**
- Trình duyệt Chrome sẽ mở ra
- Đăng nhập Facebook thủ công
- Nhấn Enter trong terminal để crawler bắt đầu
- Session sẽ được lưu vào `session.json` → những lần sau không cần đăng nhập lại

**Các lần sau:**
- Crawler tự động chạy không cần tương tác

## Chạy nhanh hơn

Mặc định crawler chạy 2 fanpage song song và chặn tải ảnh/video/font để giảm thời gian tải trang:

```bash
npm start
```

Muốn nhanh hơn nữa có thể tăng số tab chạy song song:

```bash
PAGE_CONCURRENCY=3 npm start
```

Nếu Facebook bắt đầu trả thiếu dữ liệu hoặc chậm bất thường, giảm lại:

```bash
PAGE_CONCURRENCY=1 npm start
```

## Output

Mỗi fanpage được ghi ra 1 file CSV riêng trong thư mục `data/`, đặt tên theo tên fanpage (ví dụ `data/SunLife_Vietnam.csv`). Mỗi file có các cột:

| Cột | Mô tả |
|---|---|
| `post_date` | Ngày đăng (YYYY-MM-DD) |
| `content` | Nội dung bài viết |
| `fanpage_name` | Tên fanpage |
| `reaction` | Tổng số reactions (Like + Love + Haha + ...) |
| `share` | Số share |
| `comment` | Số comment |
| `fanpage_url` | URL fanpage |
| `post_url` | URL bài viết |
| `post_id` | ID bài viết trên Facebook |
| `image_urls` | URL ảnh (nhiều ảnh cách nhau bởi " | ") |
| `video_url` | URL video (nếu có) |
| `video_view` | Số lượt xem video/reel, được bổ sung bằng script riêng |

## Bổ sung video views

Sau khi chạy `npm start`, có thể chạy thêm script này để crawl tab `/reels/` của từng fanpage và map views về CSV bằng reel/video ID trong `post_url`:

```bash
npm run fill-video-views
```

Script này chỉ map được các dòng có `post_url` dạng `/reel/<id>` hoặc `/videos/<id>`. Các post thường dạng `/posts/pfbid...` không có reel/video ID trong URL thì sẽ không được map.

## Lưu ý

- Mỗi lần chạy, crawler ghi lại file CSV như một snapshot mới theo `DATE_FROM`/`DATE_TO`: dữ liệu cũ của fanpage đó sẽ bị thay bằng dữ liệu vừa crawl được. Cơ chế này tránh việc cùng một bài bị ghi thành nhiều dòng khi reaction/comment/share thay đổi giữa các lần crawl.
- `session.json` — lưu session đăng nhập Facebook (KHÔNG chia sẻ file này)
- Crawler scroll tối đa 30 lần mỗi page, dừng khi đến `DATE_FROM`
- Delay ngẫu nhiên mặc định 1.2-2.2 giây giữa mỗi scroll. Có thể chỉnh bằng `SCROLL_WAIT_MIN_MS`, `SCROLL_WAIT_MAX_MS`, `MAX_SCROLLS`.
- `reaction` = tổng reactions, không tách riêng được Like từ Love/Haha/etc
- Bài viết mới nhất (top of feed) có thể được Facebook nhúng sẵn trong HTML ban đầu (không qua GraphQL) — crawler đọc cả 2 nguồn (GraphQL response + HTML nhúng sẵn) để không bị sót bài mới nhất.

## Chạy hàng tuần (tự động)

Trên Mac, dùng cron job:

```bash
# Mở crontab
crontab -e

# Thêm dòng này (chạy mỗi thứ Hai 8:00 sáng)
0 8 * * 1 cd /path/to/fb-crawler && node crawler.js >> crawl.log 2>&1
```

> Lưu ý: khi chạy qua cron, cần đổi `headless: false` thành `headless: true` trong crawler.js
