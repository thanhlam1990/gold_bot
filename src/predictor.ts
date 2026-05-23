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
  adx?: number;
  support?: number;
  resistance?: number;
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

    // Calculate EMA20 Slope over the last 5 candles
    const ema20Slope = (ema20Arr[ema20Arr.length - 1] - ema20Arr[ema20Arr.length - 6]) / ema20Arr[ema20Arr.length - 6] * 100;

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

    // Calculate Short-term ATR (5-period) vs. Long-term ATR (14-period) for Volatility Clustering
    const last5TR = trArray.slice(-5);
    const atr5 = last5TR.reduce((a, b) => a + b, 0) / 5;
    const volExpansionFactor = atr14 > 0 ? atr5 / atr14 : 1.0;

    // 6. Calculate Volume 24h (6 candles * 4h = 24h) & Volume Surge
    const volume24h = volumes.slice(-6).reduce((a, b) => a + b, 0);
    const volSMA20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVol = volumes[volumes.length - 1];
    const isVolumeSurge = currentVol > volSMA20 * 1.5;

    // 7. Calculate ADX 14 (Wilder's Smoothing)
    const adxPeriod = 14;
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const tr: number[] = [];

    for (let i = 1; i < klines.length; i++) {
      const high = parseFloat(klines[i][2]);
      const low = parseFloat(klines[i][3]);
      const prevHigh = parseFloat(klines[i - 1][2]);
      const prevLow = parseFloat(klines[i - 1][3]);
      const prevClose = parseFloat(klines[i - 1][4]);

      const upMove = high - prevHigh;
      const downMove = prevLow - low;

      let dmPlus = 0;
      let dmMinus = 0;

      if (upMove > 0 && upMove > downMove) {
        dmPlus = upMove;
      }
      if (downMove > 0 && downMove > upMove) {
        dmMinus = downMove;
      }

      plusDM.push(dmPlus);
      minusDM.push(dmMinus);

      const trueRange = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      tr.push(trueRange);
    }

    let smoothedPlusDM = plusDM.slice(0, adxPeriod).reduce((a, b) => a + b, 0);
    let smoothedMinusDM = minusDM.slice(0, adxPeriod).reduce((a, b) => a + b, 0);
    let smoothedTR = tr.slice(0, adxPeriod).reduce((a, b) => a + b, 0);

    const dxValues: number[] = [];

    for (let i = adxPeriod; i < tr.length; i++) {
      smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / adxPeriod) + plusDM[i];
      smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / adxPeriod) + minusDM[i];
      smoothedTR = smoothedTR - (smoothedTR / adxPeriod) + tr[i];

      const plusDI = smoothedTR > 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0;
      const minusDI = smoothedTR > 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0;

      const sum = plusDI + minusDI;
      const diff = Math.abs(plusDI - minusDI);
      const dx = sum > 0 ? (diff / sum) * 100 : 0;
      dxValues.push(dx);
    }

    let adx = 50;
    if (dxValues.length >= adxPeriod) {
      let smoothedADX = dxValues.slice(0, adxPeriod).reduce((a, b) => a + b, 0) / adxPeriod;
      for (let i = adxPeriod; i < dxValues.length; i++) {
        smoothedADX = (smoothedADX * (adxPeriod - 1) + dxValues[i]) / adxPeriod;
      }
      adx = smoothedADX;
    }

    // 8. Advanced Trend Scoring (-12 to +12) - WEIGHTED
    let score = 0;
    // EMA Weight: 3
    if (ema20 > ema50) score += 3; else score -= 3;
    
    // EMA Slope Weight: 2
    if (ema20Slope > 0.05) score += 2;
    else if (ema20Slope < -0.05) score -= 2;

    // MACD Weight: 2
    if (isMacdBullish) score += 2; else score -= 2;

    // Volume Confirmation Weight: 2
    if (isVolumeSurge) {
      if (currentPrice > ema20) score += 2; 
      else score -= 2;
    }

    // RSI contrarian / trend rules
    if (adx > 25) {
      // Strong trend: RSI confirms trend direction
      if (ema20 > ema50 && rsi > 60) score += 3;
      if (ema20 < ema50 && rsi < 40) score -= 3;
    } else {
      // Weak/Ranging trend: RSI acts as contrarian indicator
      if (rsi < 30) score += 3; // Extreme Oversold
      else if (rsi < 40) score += 1; 
      if (rsi > 70) score -= 3; // Extreme Overbought
      else if (rsi > 60) score -= 1;
    }

    score = Math.max(-12, Math.min(12, score));

    let trend: 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN' = 'NEUTRAL';
    if (score >= 7) trend = 'STRONG_UP';
    else if (score >= 2) trend = 'UP';
    else if (score <= -7) trend = 'STRONG_DOWN';
    else if (score <= -2) trend = 'DOWN';

    // 9. Support and Resistance Level Detection (from past 150 candles)
    const localMax = Math.max(...klines.slice(-150).map(k => parseFloat(k[2])));
    const localMin = Math.min(...klines.slice(-150).map(k => parseFloat(k[3])));

    // 10. Monte Carlo Simulation (T+1 to T+24)
    const numSimulations = 100;
    const steps = 24;
    const paths: number[][] = [];

    let volatility = atr14 / currentPrice;
    if (isNaN(volatility) || volatility <= 0) volatility = 0.002;

    for (let sim = 0; sim < numSimulations; sim++) {
      const path: number[] = [currentPrice];
      let p = currentPrice;

      for (let step = 1; step <= steps; step++) {
        const decayFactor = Math.pow(0.95, step);
        let drift = (score / 12) * (volatility / 2) * decayFactor;

        // EMA Mean Reversion (stronger if trend is weak)
        const meanReversionStrength = adx < 20 ? 0.05 : 0.01;
        const attractionToEMA = (ema20 - p) / ema20 * meanReversionStrength;
        drift += attractionToEMA;

        // Support / Resistance boundaries
        const distToRes = (localMax - p) / localMax;
        const distToSup = (p - localMin) / localMin;

        // Rejection / Bounce forces
        if (distToRes < 0.015) {
          // If trend is not exceptionally strong, reject from resistance
          if (score < 8 || adx < 25) {
            drift -= volatility * (1.5 - distToRes * 100);
          }
        } else if (distToSup < 0.015) {
          // Bounce from support
          if (score > -8 || adx < 25) {
            drift += volatility * (1.5 - distToSup * 100);
          }
        }

        // Volatility clustering adjustment
        const stepVolatility = volatility * Math.sqrt(volExpansionFactor);

        // Box-Muller Transform for True Gaussian Random Shocks
        let u1 = Math.random();
        let u2 = Math.random();
        if (u1 === 0) u1 = 0.0001; // Avoid log(0)
        const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

        const randomShock = z * stepVolatility * 0.7; // Scale shock slightly
        p = p * (1 + drift + randomShock);

        path.push(p);
      }
      paths.push(path);
    }

    // Compute expected (average) path
    const avgPath: number[] = [];
    for (let step = 0; step <= steps; step++) {
      let sum = 0;
      for (let sim = 0; sim < numSimulations; sim++) {
        sum += paths[sim][step];
      }
      avgPath.push(sum / numSimulations);
    }

    // Find 90th and 10th percentile high/low over simulation period
    const maxPrices = paths.map(path => Math.max(...path.slice(1)));
    const minPrices = paths.map(path => Math.min(...path.slice(1)));
    maxPrices.sort((a, b) => a - b);
    minPrices.sort((a, b) => a - b);

    const high = maxPrices[Math.floor(numSimulations * 0.90)];
    const low = minPrices[Math.floor(numSimulations * 0.10)];

    // 11. Build Chart Data
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

      upperBandData.push(null);
      lowerBandData.push(null);
    }

    // Prediction (T+1 to T+24)
    for (let i = 1; i <= 24; i++) {
      labels.push(formatTime(currentTs + i * 4 * 3600 * 1000));

      historyData.push(null);
      predictionData.push(Number(avgPath[i].toFixed(2)));

      const stepPrices = paths.map(path => path[i]).sort((a, b) => a - b);
      const stepUpper = stepPrices[Math.floor(numSimulations * 0.90)];
      const stepLower = stepPrices[Math.floor(numSimulations * 0.10)];

      upperBandData.push(i === 1 ? null : Number(stepUpper.toFixed(2)));
      lowerBandData.push(i === 1 ? null : Number(stepLower.toFixed(2)));

      // predict volume based on average
      const avgVol = volume24h / 24;
      volumeData.push(Number((avgVol * (0.5 + Math.random())).toFixed(2)));
    }

    // 12. Generate QuickChart URL
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
            label: 'Conf Upper (90%)',
            data: upperBandData,
            borderColor: 'rgba(149, 165, 166, 0.5)',
            borderDash: [2, 2],
            borderWidth: 1,
            fill: false,
            pointRadius: 0,
            yAxisID: 'y',
          },
          {
            label: 'Conf Lower (10%)',
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
          text: `${originalSymbol} - Professional AI 4H Forecast (ADX, RSI, MACD, S/R, Monte Carlo)`,
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
      predicted24hHigh: Number(high.toFixed(2)), // 96h Expected High
      predicted24hLow: Number(low.toFixed(2)),  // 96h Expected Low
      chartUrl,
      trend,
      adx: Number(adx.toFixed(2)),
      support: Number(localMin.toFixed(2)),
      resistance: Number(localMax.toFixed(2))
    };
  }
}
