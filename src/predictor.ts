import axios from 'axios';
import { logger } from './logger';

export interface PredictionResult {
  symbol: string;
  currentPrice: number;
  rsi: number;
  ema20: number;
  ema50: number;
  macd: string; // e.g. "BULLISH" or "BEARISH"
  bbUpper: number;
  bbLower: number;
  volume24h: number;
  predicted24hHigh: number;
  predicted24hLow: number;
  chartUrl: string;
  trend: 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN';
}

export class PricePredictor {
  private getBinanceSymbol(symbol: string): string {
    const s = symbol.toUpperCase();
    if (s === 'XAUUSD' || s === 'GOLD' || s === 'XAU') return 'PAXGUSDT';
    if (!s.endsWith('USDT') && !s.endsWith('USD')) return `${s}USDT`;
    if (s.endsWith('USD') && !s.endsWith('USDT')) return s.replace('USD', 'USDT');
    return s;
  }

  /**
   * Fetch real historical data and generate prediction chart
   */
  public async generatePrediction(originalSymbol: string): Promise<PredictionResult> {
    const binanceSymbol = this.getBinanceSymbol(originalSymbol);
    logger.info(`Fetching real Klines from Binance for ${binanceSymbol} (mapped from ${originalSymbol})`);

    // Fetch 500 periods of 4h data for deep analysis (approx 83 days)
    const url = `https://api1.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=4h&limit=500`;

    let klines: any[] = [];
    try {
      const response = await axios.get(url, { timeout: 10000 });
      klines = response.data;
    } catch (err) {
      throw new Error(`Failed to fetch real data for ${originalSymbol} (mapped as ${binanceSymbol}). Error: ${(err as Error).message}`);
    }

    if (!klines || klines.length < 50) {
      throw new Error(`Not enough historical data from Binance to calculate MA/RSI for ${originalSymbol}`);
    }

    // kline format: [openTime, open, high, low, close, volume, closeTime, ...]
    const closes: number[] = klines.map(k => parseFloat(k[4]));
    const volumes: number[] = klines.map(k => parseFloat(k[5]));

    const currentPrice = closes[closes.length - 1];

    // Helper to calculate EMA Array
    const calcEMAArray = (data: number[], period: number) => {
      if (data.length < period) return data;
      const k = 2 / (period + 1);
      const emaArray: number[] = [];
      let initialSMA = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

      for (let i = 0; i < period - 1; i++) emaArray.push(initialSMA);
      emaArray.push(initialSMA);

      for (let i = period; i < data.length; i++) {
        emaArray.push(data[i] * k + emaArray[i - 1] * (1 - k));
      }
      return emaArray;
    };

    // 1. Calculate EMAs
    const ema20Arr = calcEMAArray(closes, 20);
    const ema50Arr = calcEMAArray(closes, 50);
    const ema20 = ema20Arr[ema20Arr.length - 1];
    const ema50 = ema50Arr[ema50Arr.length - 1];

    // 2. Calculate PRO MACD (12, 26, 9) with Signal Line
    const ema12Arr = calcEMAArray(closes, 12);
    const ema26Arr = calcEMAArray(closes, 26);
    const macdLineArr = closes.map((_, i) => ema12Arr[i] - ema26Arr[i]);
    const signalLineArr = calcEMAArray(macdLineArr, 9);
    const macdHistogram = macdLineArr[macdLineArr.length - 1] - signalLineArr[signalLineArr.length - 1];
    const isMacdBullish = macdHistogram > 0;

    // 3. Calculate RSI 14 (Wilder's Smoothing)
    let gains = 0;
    let losses = 0;
    
    // Initial RSI (first 14)
    for (let i = 1; i <= 14; i++) {
      const diff = closes[closes.length - 28 + i] - closes[closes.length - 29 + i];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    let avgGain = gains / 14;
    let avgLoss = losses / 14;

    // Smoothed RSI (remaining 14)
    for (let i = closes.length - 13; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const currentGain = diff >= 0 ? diff : 0;
      const currentLoss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * 13 + currentGain) / 14;
      avgLoss = (avgLoss * 13 + currentLoss) / 14;
    }
    
    let rsi = 50;
    if (avgLoss !== 0) {
      const rs = avgGain / avgLoss;
      rsi = 100 - (100 / (1 + rs));
    } else {
      rsi = 100;
    }

    // 4. Calculate Bollinger Bands (20, 2)
    const last20 = closes.slice(-20);
    const sma20 = last20.reduce((a, b) => a + b, 0) / 20;
    const variance20 = last20.reduce((a, b) => a + Math.pow(b - sma20, 2), 0) / 20;
    const stdDev = Math.sqrt(variance20);
    const bbUpper = sma20 + (stdDev * 2);
    const bbLower = sma20 - (stdDev * 2);

    // 5. Calculate ATR (Average True Range) 14
    const trArray = [];
    for (let i = 1; i < klines.length; i++) {
      const high = parseFloat(klines[i][2]);
      const low = parseFloat(klines[i][3]);
      const prevClose = parseFloat(klines[i - 1][4]);
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trArray.push(tr);
    }
    const last14TR = trArray.slice(-14);
    const atr14 = last14TR.reduce((a, b) => a + b, 0) / 14;

    // 6. Calculate Volume 24h (6 candles * 4h = 24h) & Volume Surge
    const volume24h = volumes.slice(-6).reduce((a, b) => a + b, 0);
    const volSMA20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVol = volumes[volumes.length - 1];
    const isVolumeSurge = currentVol > volSMA20 * 1.5;

    // 7. Advanced Trend Scoring (-10 to +10) - WEIGHTED
    let score = 0;
    // EMA Weight: 3
    if (ema20 > ema50) score += 3; else score -= 3;
    
    // MACD Weight: 2
    if (isMacdBullish) score += 2; else score -= 2;

    // Volume Confirmation Weight: 2
    if (isVolumeSurge) {
      if (currentPrice > ema20) score += 2; 
      else score -= 2;
    }

    // RSI contrarian/trend Weight: 3
    if (rsi < 30) score += 3; // Extreme Oversold
    else if (rsi < 40) score += 1; 
    if (rsi > 70) score -= 3; // Extreme Overbought
    else if (rsi > 60) score -= 1;

    let trend: 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN' = 'NEUTRAL';
    if (score >= 6) trend = 'STRONG_UP';
    else if (score >= 2) trend = 'UP';
    else if (score <= -6) trend = 'STRONG_DOWN';
    else if (score <= -2) trend = 'DOWN';

    // 8. Build Chart Data
    const labels: string[] = [];
    const historyData: (number | null)[] = [];
    const predictionData: (number | null)[] = [];
    const volumeData: number[] = [];
    const upperBandData: (number | null)[] = [];
    const lowerBandData: (number | null)[] = [];

    const formatTime = (ts: number | Date) => {
      const d = new Date(ts);
      return d.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit'
      });
    };

    // Last 24h History
    const timestamps = klines.map(k => k[0] as number);
    const last24Closes = closes.slice(-24);
    const last24Volumes = volumes.slice(-24);
    const last24Timestamps = timestamps.slice(-24);
    const currentTs = last24Timestamps[last24Timestamps.length - 1];

    for (let i = 0; i < 24; i++) {
      labels.push(formatTime(last24Timestamps[i]));
      historyData.push(Number(last24Closes[i].toFixed(2)));
      predictionData.push(i === 23 ? Number(last24Closes[i].toFixed(2)) : null);
      volumeData.push(Number(last24Volumes[i].toFixed(2)));

      // We don't render BB for history to keep chart clean, only for prediction zone
      upperBandData.push(null);
      lowerBandData.push(null);
    }

    // Prediction (T+1 to T+24) - Mean Reverting Stochastic Model
    let predPrice = currentPrice;
    let high = predPrice;
    let low = predPrice;

    // Advanced volatility estimate using ATR (Average True Range)
    // ATR / Price gives a much better % of average movement per hour
    let volatility = atr14 / currentPrice;
    if (isNaN(volatility) || volatility <= 0) volatility = 0.002;

    // Dynamic bands for prediction (they expand slightly)
    let currentBbUpper = bbUpper;
    let currentBbLower = bbLower;

    for (let i = 1; i <= 24; i++) {
      labels.push(formatTime(currentTs + i * 4 * 3600 * 1000));

      // 1. Base drift from Trend with Decay (Momentum fades over time)
      const decayFactor = Math.pow(0.96, i); 
      let drift = (score / 10) * (volatility / 2) * decayFactor;

      // 2. EMA Attraction (Price tends to revert to the mean/EMA20)
      const attractionToEMA = (ema20 - predPrice) / ema20 * 0.02;
      drift += attractionToEMA;

      // 3. Mean Reversion (Bollinger Band constraints)
      const distToUpper = (currentBbUpper - predPrice) / currentBbUpper;
      const distToLower = (predPrice - currentBbLower) / currentBbLower;

      if (distToUpper < 0.01) {
        drift -= volatility * (1.2 - distToUpper * 100); 
      } else if (distToLower < 0.01) {
        drift += volatility * (1.2 - distToLower * 100);
      }

      // 4. Stochastic Noise (Brownian motion with volatility scaling)
      const randomShock = (Math.random() * 2 - 1) * volatility * 0.8;
      predPrice = predPrice * (1 + drift + randomShock);

      // Expand bands (uncertainty grows logarithmically)
      currentBbUpper *= (1 + 0.00015 * Math.sqrt(i));
      currentBbLower *= (1 - 0.00015 * Math.sqrt(i));

      historyData.push(null);
      predictionData.push(Number(predPrice.toFixed(2)));
      upperBandData.push(i === 1 ? null : Number(currentBbUpper.toFixed(2)));
      lowerBandData.push(i === 1 ? null : Number(currentBbLower.toFixed(2)));

      // predict volume based on average
      const avgVol = volume24h / 24;
      volumeData.push(Number((avgVol * (0.5 + Math.random())).toFixed(2)));

      if (predPrice > high) high = predPrice;
      if (predPrice < low) low = predPrice;
    }

    // 6. Generate QuickChart URL
    const chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Historical',
            data: historyData,
            borderColor: '#2ecc71',
            borderWidth: 2,
            fill: false,
            yAxisID: 'y',
          },
          {
            label: 'Predicted',
            data: predictionData,
            borderColor: '#e74c3c',
            borderDash: [5, 5],
            borderWidth: 2,
            fill: false,
            yAxisID: 'y',
          },
          {
            label: 'BB Upper',
            data: upperBandData,
            borderColor: 'rgba(149, 165, 166, 0.5)',
            borderDash: [2, 2],
            borderWidth: 1,
            fill: false,
            pointRadius: 0,
            yAxisID: 'y',
          },
          {
            label: 'BB Lower',
            data: lowerBandData,
            borderColor: 'rgba(149, 165, 166, 0.5)',
            borderDash: [2, 2],
            borderWidth: 1,
            fill: false,
            pointRadius: 0,
            yAxisID: 'y',
          },
          {
            type: 'bar',
            label: 'Volume',
            data: volumeData,
            backgroundColor: 'rgba(52, 152, 219, 0.3)',
            yAxisID: 'y1',
          }
        ]
      },
      options: {
        title: {
          display: true,
          text: `${originalSymbol} - AI 4H Prediction (EMA, MACD, RSI, ATR, BB)`,
          fontSize: 16
        },
        scales: {
          yAxes: [
            { id: 'y', type: 'linear', position: 'right', scaleLabel: { display: true, labelString: 'Price (USD)' } },
            { id: 'y1', type: 'linear', position: 'left', display: false, gridLines: { drawOnChartArea: false } }
          ]
        }
      }
    };

    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=800&h=400&bkg=white`;

    return {
      symbol: originalSymbol,
      currentPrice,
      rsi: Number(rsi.toFixed(2)),
      ema20: Number(ema20.toFixed(2)),
      ema50: Number(ema50.toFixed(2)),
      macd: isMacdBullish ? 'BULLISH' : 'BEARISH',
      bbUpper: Number(bbUpper.toFixed(2)),
      bbLower: Number(bbLower.toFixed(2)),
      volume24h: Number(volume24h.toFixed(2)),
      predicted24hHigh: Number(high.toFixed(2)), // This is now 96h High
      predicted24hLow: Number(low.toFixed(2)),  // This is now 96h Low
      chartUrl,
      trend
    };
  }
}
