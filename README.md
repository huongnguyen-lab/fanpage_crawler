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

## Output

File `posts.csv` với các cột:

| Cột | Mô tả |
|---|---|
| `post_date` | Ngày đăng (YYYY-MM-DD) |
| `content` | Nội dung bài viết |
| `fanpage_name` | Tên fanpage |
| `like` | Tổng số reactions (Like + Love + Haha + ...) |
| `share` | Số share |
| `comment` | Số comment |
| `fanpage_url` | URL fanpage |
| `post_url` | URL bài viết |
| `image_urls` | URL ảnh (nhiều ảnh cách nhau bởi " | ") |
| `video_url` | URL video (nếu có) |

## Lưu ý

- `known_posts.json` — lưu danh sách post đã crawl, tránh trùng lặp
- `session.json` — lưu session đăng nhập Facebook (KHÔNG chia sẻ file này)
- Crawler scroll tối đa 30 lần mỗi page, dừng khi đến `DATE_FROM`
- Delay ngẫu nhiên 2-4 giây giữa mỗi scroll để tránh bị detect
- `like` = tổng reactions, không tách riêng được Like từ Love/Haha/etc

## Chạy hàng tuần (tự động)

Trên Mac, dùng cron job:

```bash
# Mở crontab
crontab -e

# Thêm dòng này (chạy mỗi thứ Hai 8:00 sáng)
0 8 * * 1 cd /path/to/fb-crawler && node crawler.js >> crawl.log 2>&1
```

> Lưu ý: khi chạy qua cron, cần đổi `headless: false` thành `headless: true` trong crawler.js