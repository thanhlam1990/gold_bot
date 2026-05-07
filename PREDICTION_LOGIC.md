# Logic Dự Đoán Giá 24h (AI Prediction Logic)

Tài liệu này mô tả chi tiết cách hệ thống lấy dữ liệu và tính toán dựa trên các chỉ báo kỹ thuật chuyên sâu (Technical Analysis) để đưa ra kết quả dự đoán giá 24h.

## 1. Nguồn dữ liệu (Data Source)
Hệ thống trích xuất lịch sử giá từ **Binance Klines API** (`https://api.binance.com/api/v3/klines`).
- **Khung thời gian (Interval):** 1 giờ (1h) mỗi nến.
- **Số lượng (Limit):** 100 nến gần nhất tính từ thời điểm yêu cầu.
- **Ánh xạ Mã (Symbol Mapping):** 
  - Riêng với Vàng (`XAU` hoặc `XAUUSD`), hệ thống tự động ánh xạ sang mã **`PAXGUSDT`** (Pax Gold - Token neo giá 1:1 với vàng).

## 2. Các Chỉ Báo Kỹ Thuật Chuyên Sâu (PRO Technical Indicators)
Hệ thống được nâng cấp để sử dụng bộ chỉ báo của một nhà phân tích định lượng (Quantitative Analyst) chuyên nghiệp:

* **EMA (Exponential Moving Average 20 & 50):** 
  - Hệ thống sử dụng cặp **EMA20** (Ngắn hạn) và **EMA50** (Trung hạn) để bắt giao cắt xu hướng (Golden Cross / Death Cross).
* **MACD (Moving Average Convergence Divergence):** 
  - Sử dụng MACD tiêu chuẩn (12, 26, 9) tính cả **Signal Line** và **Histogram**. Xung lực được đánh giá chính xác hơn khi Histogram > 0.
* **RSI14 (Relative Strength Index):** 
  - Phát hiện vùng Quá mua (Overbought - trên 60/70) hoặc Quá bán (Oversold - dưới 40/30) để bắt đỉnh/đáy.
* **ATR (Average True Range 14):**
  - Chỉ báo đo lường biến động thực tế bao gồm cả những khoảng trống giá (gaps) và râu nến. Cung cấp độ rộng dao động trung bình mỗi giờ.
* **Bollinger Bands (20, 2):**
  - Cung cấp hỗ trợ/kháng cự động và giới hạn biên độ mô phỏng giá (Mean Reversion).
* **Volume Surge (Đột biến thanh khoản):**
  - Xác nhận xu hướng bằng cách so sánh Volume hiện tại với SMA20 của Volume (Đột biến > 1.5x).

## 3. Hệ thống Chấm Điểm Xu hướng (Advanced Trend Scoring System)
Thuật toán sử dụng hệ thống **Chấm Điểm Nâng Cao (-5 đến +5)**:
- Điểm cộng: EMA20 nằm trên EMA50 (+1), MACD Histogram Bullish (+1), RSI Oversold (<40: +1, <30: +2), Có Volume Surge củng cố giá nằm trên EMA20 (+1).
- Điểm trừ: EMA20 nằm dưới EMA50 (-1), MACD Histogram Bearish (-1), RSI Overbought (>60: -1, >70: -2), Có Volume Surge củng cố giá nằm dưới EMA20 (-1).
- Tổng điểm phân loại thành 5 trạng thái: `STRONG_UP` (>=3), `UP` (>=1), `NEUTRAL` (0), `DOWN` (<=-1), `STRONG_DOWN` (<=-3).

## 4. Mô hình Phục hồi Trung bình Động (Mean-Reverting Stochastic Model)
Khi vẽ đường giá cho 24 giờ tới, hệ thống sử dụng thuật toán **Mean Reversion** kết hợp **ATR**:

1. **Tính Độ Biến Động (Dynamic Volatility):** 
   Sử dụng `ATR(14) / Current Price` để lấy chính xác phần trăm biến động thực tế kỳ vọng cho mỗi giờ.
2. **Nội suy từng giờ:** 
   - `Drift` (Lực kéo): Dựa vào Điểm Trend Score. Lực kéo sẽ mạnh nếu Trend mạnh.
   - `Mean Reversion`: Nếu giá mô phỏng chạm vào Cạnh trên (Upper Band) của Bollinger, tự động sinh ra "Lực đẩy xuống" (Drift âm). Nếu chạm Cạnh dưới, sinh ra lực bật lên.
   - Giá được cập nhật thêm một mức nhiễu ngẫu nhiên dựa trên ATR.
3. **Cập nhật dải Bollinger:** Dải Bollinger sẽ hơi mở rộng về tương lai đại diện cho sự bất định của thời gian.

## 5. Cảnh báo (Disclaimer)
Thuật toán dự đoán dựa hoàn toàn vào Phân Tích Kỹ Thuật (Technical Analysis) định lượng tiên tiến và không bao gồm Yếu tố Cơ bản. Không phải là lời khuyên đầu tư tài chính.
