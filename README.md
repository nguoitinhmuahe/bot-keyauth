readme create by chatgpt stupid


**SYBAU YOUNG**
Bot Discord này dùng để quản lý key (license keys) với cơ sở dữ liệu SQLite và cung cấp API RESTful để xác thực key. Bot hỗ trợ các lệnh Discord để tạo, xóa, kiểm tra, và quản lý key, cùng với các cron job tự động xử lý key hết hạn, thông báo key sắp hết hạn, và dọn dẹp log cũ.
Tính năng

Quản lý key:
Tạo key với lệnh /gen <quantity> <type> <duration> [note] (ví dụ: /gen 1 premium 1d test).
Kiểm tra key (/check), liệt kê key (/list, /actives, /inactive), tìm kiếm (/search), và quản lý (/ban, /unban, /lock, /unlock, /reset, /expire).
Gán key cho user (/bind), bỏ gán (/unbind), thêm tag (/tag), và quản lý nhóm (/group, /groupstats).


API xác thực:
Endpoint để xác thực key (/a/zx/cv/xcv/sd/g/xcv/sd/s/dv/xc/v/x/ứa/f/wsh/key), kiểm tra HWID, reset HWID, và ping.
Hỗ trợ rate limit và blocklist IP.


Cron job:
Tự động cập nhật key hết hạn (active → expired) mỗi phút.
Gửi thông báo webhook cho key sắp hết hạn (trong 24 giờ) mỗi giờ.
Xóa log cũ (>30 ngày) mỗi ngày.


Quản lý admin:
Thêm/xóa admin/mod (/admin add, /admin remove, /admin list).
Chỉ admin/mod được dùng các lệnh quản lý (trừ /mykeys, /clientconfig).


Webhook thông báo: Gửi log hành động qua webhook Discord (set bằng /setwebhook và /notify).

Cài đặt
Yêu cầu

Node.js: v22.17.1 hoặc mới hơn.
Dependencies:{
  "discord.js": "^14.15.3",
  "better-sqlite3": "^11.1.2",
  "express": "^4.21.0",
  "body-parser": "^1.20.3",
  "uuid": "^10.0.0",
  "axios": "^1.7.7",
  "node-cron": "^3.0.3",
  "dotenv": "^17.2.1"
}



Hướng dẫn cài đặt

Clone hoặc đặt dự án:

Đặt code trong thư mục, ví dụ: C:\Users\your_user\Desktop\tao có óc chó không.


Cài dependencies:
cd C:\Users\your_user\Desktop\tao có óc chó không
npm install discord.js better-sqlite3 express body-parser uuid axios node-cron dotenv


Tạo file .env:

Tạo file .env trong thư mục dự án với nội dung:DISCORD_TOKEN=your_discord_bot_token
API_KEY=your_api_key
API_AUTH_ENDPOINT=/a/zx/cv/xcv/sd/g/xcv/sd/s/dv/xc/v/x/ứa/f/wsh/key
API_CHECKHWID_ENDPOINT=/a/zx/cv/xcv/sd/g/xcv/sd/s/dv/xc/v/x/ứa/f/wsh/checkhwid
API_RESET_ENDPOINT=/a/zx/cv/xcv/sd/g/xcv/sd/s/dv/xc/v/x/ứa/f/wsh/reset
API_PING_ENDPOINT=/a/zx/cv/xcv/sd/g/xcv/sd/s/dv/xc/v/x/ứa/f/wsh/ping
API_RESTORE_ENDPOINT=/a/zx/cv/xcv/sd/g/xcv/sd/s/dv/xc/v/x/ứa/f/wsh/restore
PORT=5000
ADMIN_ID=your_discord_user_id

**LƯU Ý**
khi sửa file hay sửa api endpoint càng rốt càng tốt


Lấy DISCORD_TOKEN:
Vào Discord Developer Portal.
Tạo ứng dụng, thêm bot, bật các intent (Guilds, GuildMessages, MessageContent).
Copy token vào DISCORD_TOKEN.


Tạo API_KEY: Chuỗi ngẫu nhiên, ví dụ: 7b9f2a3d8e1c4b5f9a0d3e2c1b4a5f6d.
Lấy ADMIN_ID:
Bật Developer Mode trong Discord, right-click profile của bạn, chọn Copy ID.




Chạy bot:
node index.js


Kỳ vọng: Console in:API running
Bot ready as skibidi.py#8470




Kiểm tra database:

File keys.db sẽ tự động tạo trong thư mục dự án, chứa các bảng:
keys: Lưu thông tin key (key, type, status, expiresAt, v.v.).
logs: Lưu log hành động.
admins, ratelimits, trustlist, blocklist, groups, settings: Quản lý cấu hình.





Sử dụng
Lệnh Discord

Tạo key:/gen 1 premium 1d test


Tạo 1 key với type = premium, hết hạn sau 1 ngày, ghi chú test.
duration phải có định dạng <số><đơn vị> (h: giờ, d: ngày, m: tháng, w: tuần, y: năm). Nếu sai (ví dụ: 1), bot báo lỗi.


Kiểm tra key:/check ABC-uuid1-uuid2-uuid3-uuid4


Hiển thị thông tin key, status và expiresAt in đậm.


Liệt kê key:/actives
/inactive 1
/groupstats mygroup


/actives: Liệt kê key active.
/inactive <days>: Liệt kê key active chưa dùng trong <days> ngày.
/groupstats <group>: Thống kê key trong nhóm.


Quản lý key:/ban ABC-uuid1-uuid2-uuid3-uuid4 "Cheating"
/unban ABC-uuid1-uuid2-uuid3-uuid4
/expire ABC-uuid1-uuid2-uuid3-uuid4 2d
/reset ABC-uuid1-uuid2-uuid3-uuid4


Webhook:/setwebhook https://discord.com/api/webhooks/your_webhook
/notify on



API

Xác thực key:curl -X POST http://localhost:5000/a/zx/cv/xcv/sd/g/xcv/sd/s/dv/xc/v/x/ứa/f/wsh/key \
-H "X-API-Key: your_api_key" \
-H "Content-Type: application/json" \
-d '{"key": "ABC-uuid1-uuid2-uuid3-uuid4", "hwid": "test-hwid", "ip": "127.0.0.1"}'


Trả về JSON với status: 'success' nếu key hợp lệ.



Cron Job

Cập nhật key hết hạn: Chạy mỗi phút, chuyển key active sang expired nếu expiresAt đã qua.
Thông báo key sắp hết hạn: Chạy mỗi giờ, gửi webhook nếu key hết hạn trong 24 giờ.
Xóa log cũ: Chạy mỗi ngày, xóa log trong keys.db có timestamp trước 30 ngày.

Lưu ý

Lỗi thường gặp:
EADDRINUSE: Cổng 5000 bị chiếm, đổi PORT trong .env (ví dụ: PORT=8080).
Key không có expiresAt: Đảm bảo duration trong /gen đúng định dạng (như 1d).


Sao lưu database:
Dùng /backup để xuất keys.db thành backup.json.
Khôi phục bằng /restore (chỉ admin).


Debug:
Kiểm tra log trong keys.db (bảng logs) hoặc console.
Liên hệ qua Telegram (@hieudeptrai) nếu cần hỗ trợ.



Cấu trúc file

index.js: Code chính của bot.
.env: Cấu hình token, API key, và cổng.
keys.db: Cơ sở dữ liệu SQLite.
package.json: Quản lý dependencies.
