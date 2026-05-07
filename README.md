# 🪙 Gold Price Alert Bot

Bot theo dõi giá vàng realtime (USD/ oz) và thông báo khi giá biến động ≥ 1% so với lần check trước.

---

## Cấu trúc dự án

```
gold-alert-bot/
├── src/
│   ├── index.ts          # Entry point, scheduler
│   ├── config.ts         # Load & validate env vars
│   ├── types.ts          # Shared TypeScript types
│   ├── goldFetcher.ts    # Fetch giá vàng (GoldAPI.io + fallback)
│   ├── alertEngine.ts    # So sánh giá, gửi thông báo
│   └── logger.ts         # Colored console logger
├── .env.example          # Template cấu hình
├── package.json
└── tsconfig.json
```

---

## Cài đặt

```bash
# 1. Cài dependencies
npm install

# 2. Copy và điền config
cp .env.example .env
nano .env
```

---

## Lấy API Key (miễn phí)

1. Đăng ký tại **https://www.goldapi.io/**
2. Copy API key vào `.env`:
   ```
   GOLD_API_KEY=your_key_here
   ```

---

## Cấu hình `.env`

| Biến | Mặc định | Mô tả |
|---|---|---|
| `GOLD_API_KEY` | *(bắt buộc)* | API key từ goldapi.io |
| `ALERT_THRESHOLD_PERCENT` | `1` | % thay đổi để kích hoạt alert |
| `POLL_INTERVAL_MINUTES` | `5` | Tần suất check (phút) |
| `NOTIFY_CONSOLE` | `true` | In ra terminal |
| `NOTIFY_TELEGRAM` | `false` | Gửi qua Telegram bot |
| `TELEGRAM_BOT_TOKEN` | — | Token của bot Telegram |
| `TELEGRAM_CHAT_ID` | — | Chat ID nhận thông báo |
| `NOTIFY_WEBHOOK` | `false` | POST JSON đến webhook URL |
| `WEBHOOK_URL` | — | URL webhook |
| `LOG_LEVEL` | `info` | debug / info / warn / error |

---

## Chạy Bot

```bash
# Development (hot-reload)
npm run dev

# Production
npm run build
npm start
```

---

## Ví dụ output

```
╔══════════════════════════════════════════╗
║        🪙  Gold Price Alert Bot          ║
╚══════════════════════════════════════════╝
  Alert threshold : ±1%
  Poll interval   : every 5 min
  Notifiers       : console, telegram

[2024-06-01 08:00:00] [INFO]  📌 Baseline set: $2,340.50 at 1/6/2024, 08:00:00
[2024-06-01 08:05:00] [INFO]  💰 Gold: $2,340.50  |  prev: $2,340.50  |  Δ +0.000%
[2024-06-01 08:10:00] [INFO]  💰 Gold: $2,364.90  |  prev: $2,340.50  |  Δ +1.043%

════════════════════════════════════════════════════════════
 🚨 GOLD ALERT  2024-06-01 08:10:00
════════════════════════════════════════════════════════════
📈 GOLD PRICE UP  +1.04%

  Current  : $2,364.90 / oz
  Previous : $2,340.50 / oz
  Change   : +$24.40

  Prev time : 1/6/2024, 08:05:00
  Now       : 1/6/2024, 08:10:00
════════════════════════════════════════════════════════════
```

---

## Tích hợp Telegram

1. Tạo bot qua [@BotFather](https://t.me/BotFather) → lấy `TELEGRAM_BOT_TOKEN`
2. Gửi 1 tin nhắn cho bot, rồi truy cập:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   Tìm `"chat":{"id":...}` → đó là `TELEGRAM_CHAT_ID`
3. Set trong `.env`:
   ```
   NOTIFY_TELEGRAM=true
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=987654321
   ```

---

## Webhook payload

```json
{
  "event": "gold_price_alert",
  "direction": "UP",
  "changePercent": 1.043,
  "previousPrice": 2340.50,
  "currentPrice": 2364.90,
  "previousTimestamp": "2024-06-01T01:05:00.000Z",
  "currentTimestamp": "2024-06-01T01:10:00.000Z",
  "message": "📈 GOLD PRICE UP  +1.04%\n..."
}
```
