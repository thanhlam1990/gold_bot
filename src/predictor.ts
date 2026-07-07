import axios from 'axios';
import { logger } from './logger';

export interface PredictionResult {
  symbol: string;
  currentPrice: number;
  rsi: number;
  ema20: number;
  ema50: number;
  ema200?: number;
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
  cmf?: number;
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
   * Normalize Bybit kline data to Binance kline format.
   * Bybit: [startTimeMs, open, high, low, close, volume, turnover] — reverse chronological
   * Binance: [openTimeMs, open, high, low, close, volume, closeTimeMs, ...] — chronological
   */
  private normalizeBybitKlines(bybitList: any[]): any[] {
    // Bybit returns newest-first → reverse to oldest-first
    const sorted = [...bybitList].reverse();
    return sorted.map(k => [
      Number(k[0]),  // [0] openTime (ms)
      k[1],          // [1] open
      k[2],          // [2] high
      k[3],          // [3] low
      k[4],          // [4] close
      k[5],          // [5] volume
      Number(k[0]) + 4 * 3600 * 1000 - 1, // [6] closeTime (approx)
    ]);
  }

  /**
   * Fetch real historical data and generate prediction chart
   */
  public async generatePrediction(originalSymbol: string): Promise<PredictionResult> {
    const binanceSymbol = this.getBinanceSymbol(originalSymbol);
    logger.info(`Fetching real Klines from Bybit for ${binanceSymbol} (mapped from ${originalSymbol})`);

    // Fetch 500 periods of 4h data for deep analysis (approx 83 days) via Bybit
    const bybitUrl = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${binanceSymbol}&interval=240&limit=500`;

    let klines: any[] = [];
    let lastError: Error | null = null;

    try {
      logger.info(`Fetching from Bybit: ${bybitUrl}`);
      const response = await axios.get(bybitUrl, { timeout: 10000 });
      const bybitData = response.data?.result?.list;
      if (Array.isArray(bybitData) && bybitData.length > 0) {
        klines = this.normalizeBybitKlines(bybitData);
        logger.info(`Bybit OK — ${klines.length} candles fetched.`);
      } else {
        throw new Error('Bybit returned empty or invalid data');
      }
    } catch (err) {
      lastError = err as Error;
      logger.error(`Bybit fetch failed: ${(err as Error).message}`);
    }

    if (klines.length === 0) {
      throw new Error(
        `Failed to fetch data for ${originalSymbol} (mapped as ${binanceSymbol}) from all sources. Last error: ${lastError?.message}`
      );
    }

    if (klines.length < 200) {
      throw new Error(`Not enough historical data to calculate indicators for ${originalSymbol} (got ${klines.length} candles, need at least 200)`);
    }

    // kline format: [openTime, open, high, low, close, volume, closeTime, ...]
    const closes: number[] = klines.map(k => parseFloat(k[4]));
    const volumes: number[] = klines.map(k => parseFloat(k[5]));

    const currentPrice = closes[closes.length - 1];
    const lastReturn = (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2];

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

    // 1. Calculate EMAs (EMA20, EMA50, and Long-term structural EMA200)
    const ema20Arr = calcEMAArray(closes, 20);
    const ema50Arr = calcEMAArray(closes, 50);
    const ema200Arr = calcEMAArray(closes, 200);
    
    const ema20 = ema20Arr[ema20Arr.length - 1];
    const ema50 = ema50Arr[ema50Arr.length - 1];
    const ema200 = ema200Arr[ema200Arr.length - 1];

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
    const trArray: number[] = [];
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

    // 7. Calculate Chaikin Money Flow (CMF) 20
    let mfvSum = 0;
    let volSum = 0;
    for (let i = klines.length - 20; i < klines.length; i++) {
      const h = parseFloat(klines[i][2]);
      const l = parseFloat(klines[i][3]);
      const c = parseFloat(klines[i][4]);
      const v = parseFloat(klines[i][5]);

      const range = h - l;
      const mfv = range > 0 ? (((c - l) - (h - c)) / range) * v : 0;
      mfvSum += mfv;
      volSum += v;
    }
    const cmf = volSum > 0 ? mfvSum / volSum : 0;

    // 8. Calculate Garman-Klass Volatility Estimator (20 periods)
    let gkSum = 0;
    const gkPeriod = 20;
    for (let i = klines.length - gkPeriod; i < klines.length; i++) {
      const o = parseFloat(klines[i][1]);
      const h = parseFloat(klines[i][2]);
      const l = parseFloat(klines[i][3]);
      const c = parseFloat(klines[i][4]);

      const logHL = Math.log(h / l);
      const logCO = Math.log(c / o);

      const term1 = 0.5 * Math.pow(logHL, 2);
      const term2 = (2 * Math.log(2) - 1) * Math.pow(logCO, 2);
      gkSum += (term1 - term2);
    }
    const gkVol = Math.sqrt(gkSum / gkPeriod);

    // 9. Calculate ADX 14 with DI+ and DI- (Wilder's Smoothing)
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
    let plusDI = 0;
    let minusDI = 0;

    for (let i = adxPeriod; i < tr.length; i++) {
      smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / adxPeriod) + plusDM[i];
      smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / adxPeriod) + minusDM[i];
      smoothedTR = smoothedTR - (smoothedTR / adxPeriod) + tr[i];

      plusDI = smoothedTR > 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0;
      minusDI = smoothedTR > 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0;

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

    // 10. Calculate Autoregressive Return Coefficient AR(1) of last 30 candles
    const returns: number[] = [];
    for (let i = closes.length - 30; i < closes.length; i++) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    let num = 0;
    let den = 0;
    for (let i = 1; i < returns.length; i++) {
      num += (returns[i] - avgReturn) * (returns[i - 1] - avgReturn);
    }
    for (let i = 0; i < returns.length; i++) {
      den += Math.pow(returns[i] - avgReturn, 2);
    }
    const ar1Coef = den > 0 ? num / den : 0;

    // 11. Advanced Trend Scoring (-15 to +15) - WEIGHTED
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

    // DMI Crossover Weight: 2
    if (plusDI > minusDI) score += 2; else score -= 2;

    // CMF (Chaikin Money Flow) Weight: 2
    if (cmf > 0.1) score += 2;
    else if (cmf < -0.1) score -= 2;

    // RSI contrarian / trend rules
    if (adx > 25) {
      // Strong trend: RSI confirms trend direction
      if (ema20 > ema50 && rsi > 60) score += 2;
      if (ema20 < ema50 && rsi < 40) score -= 2;
    } else {
      // Weak/Ranging trend: RSI acts as contrarian indicator
      if (rsi < 30) score += 3; // Extreme Oversold
      else if (rsi < 40) score += 1; 
      if (rsi > 70) score -= 3; // Extreme Overbought
      else if (rsi > 60) score -= 1;
    }

    score = Math.max(-15, Math.min(15, score));

    let trend: 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN' = 'NEUTRAL';
    if (score >= 9) trend = 'STRONG_UP';
    else if (score >= 3) trend = 'UP';
    else if (score <= -9) trend = 'STRONG_DOWN';
    else if (score <= -3) trend = 'DOWN';

    // 12. Support and Resistance Level Detection (from past 150 nến)
    const localMax = Math.max(...klines.slice(-150).map(k => parseFloat(k[2])));
    const localMin = Math.min(...klines.slice(-150).map(k => parseFloat(k[3])));

    // 13. Asset Regime Classification
    const isGold = originalSymbol.toUpperCase().includes('XAU') || 
                   originalSymbol.toUpperCase().includes('GOLD') || 
                   originalSymbol.toUpperCase().includes('PAXG');

    // 14. Monte Carlo Simulation (T+1 to T+24)
    const numSimulations = 100;
    const steps = 24;
    const paths: number[][] = [];

    // Use Garman-Klass Volatility (much more precise range-based estimate)
    let volatility = gkVol;
    if (isNaN(volatility) || volatility <= 0) volatility = 0.002;
    if (isGold) volatility = Math.min(volatility, 0.0012);

    for (let sim = 0; sim < numSimulations; sim++) {
      const path: number[] = [currentPrice];
      let p = currentPrice;
      let simRes = localMax;
      let simSup = localMin;

      for (let step = 1; step <= steps; step++) {
        const decayFactor = Math.pow(0.95, step);
        let drift = 0;

        // Long-term Stretch Pull (rubber-band effect from EMA200)
        const stretch = (p - ema200) / ema200;
        let stretchPull = 0;
        if (Math.abs(stretch) > 0.06) {
          stretchPull = -Math.sign(stretch) * Math.pow(Math.abs(stretch), 1.5) * 0.08;
        }

        if (isGold) {
          // --- Ornstein-Uhlenbeck (OU) with Trend Drift for Gold ---
          const isStrongTrend = adx > 25 && Math.abs(score) >= 7;
          const theta = isStrongTrend ? 0.03 : (adx > 25 ? 0.08 : 0.15);
          const mu = (ema20 + ema50 + ema200) / 3;
          
          const reversionForce = theta * (mu - p) / p;
          const trendForce = (score / 15) * volatility * 2.0 * decayFactor;
          
          drift = reversionForce + trendForce + stretchPull;
        } else {
          // --- Geometric Brownian Motion (GBM) with Momentum for Crypto ---
          drift = (score / 15) * (volatility / 1.5) * decayFactor;

          // Autoregressive return momentum (fades out over time)
          const arMomentum = ar1Coef * lastReturn * Math.pow(0.8, step);
          drift += arMomentum;

          // Soft structural anchor to prevent exponential divergence
          drift += (ema200 - p) / p * 0.003 + stretchPull;
        }

        // --- Dynamic Support / Resistance Breakout & Rejection Simulation ---
        const distToRes = (simRes - p) / simRes;
        const distToSup = (p - simSup) / simSup;

        if (distToRes < 0.015) {
          // Approaching Resistance
          const breakProb = (score > 0 ? score / 15 : 0) * 0.4 + (adx > 25 ? 0.2 : 0.05) + (cmf > 0.1 ? 0.2 : 0) + (isVolumeSurge ? 0.25 : 0);
          if (breakProb > 0.65) {
            // BREAKOUT!
            drift += volatility * 0.5;
            simSup = simRes; 
            simRes = simRes * 1.05; 
          } else {
            // REJECTION! Price bounces down
            const trendMitigation = score > 0 ? (1 - score / 15) : 1;
            drift -= volatility * (0.5 - distToRes * 20) * trendMitigation;
          }
        } else if (distToSup < 0.015) {
          // Approaching Support
          const breakProb = (score < 0 ? Math.abs(score) / 15 : 0) * 0.4 + (adx > 25 ? 0.2 : 0.05) + (cmf < -0.1 ? 0.2 : 0) + (isVolumeSurge ? 0.25 : 0);
          if (breakProb > 0.65) {
            // BREAKDOWN!
            drift -= volatility * 0.5;
            simRes = simSup; 
            simSup = simSup * 0.95; 
          } else {
            // BOUNCE! Price bounces up
            const trendMitigation = score < 0 ? (1 - Math.abs(score) / 15) : 1;
            drift += volatility * (0.5 - distToSup * 20) * trendMitigation;
          }
        }

        // Volatility clustering adjustment
        const stepVolatility = volatility * Math.sqrt(volExpansionFactor);

        // Box-Muller Transform for True Gaussian Random Shocks
        let u1 = Math.random();
        let u2 = Math.random();
        if (u1 === 0) u1 = 0.0001; 
        const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

        const randomShock = z * stepVolatility * (isGold ? 0.5 : 0.8);
        p = p * (1 + drift + randomShock);

        path.push(p);
      }
      paths.push(path);
    }

    // Compute MEDIAN path per step (preserves natural zig-zag, avoids flat average)
    const medianPath: number[] = [];
    const upperPath: number[] = [];
    const lowerPath: number[] = [];
    for (let step = 0; step <= steps; step++) {
      const stepPricesSorted = paths.map(path => path[step]).sort((a, b) => a - b);
      medianPath.push(stepPricesSorted[Math.floor(numSimulations * 0.50)]);
      upperPath.push(stepPricesSorted[Math.floor(numSimulations * 0.85)]);
      lowerPath.push(stepPricesSorted[Math.floor(numSimulations * 0.15)]);
    }

    // Pick the single simulation path whose FINAL value is closest to the median
    // This gives a realistic zig-zag representative path
    const medianFinal = medianPath[medianPath.length - 1];
    let representativePath = paths[0];
    let minDist = Math.abs(paths[0][steps] - medianFinal);
    for (let sim = 1; sim < numSimulations; sim++) {
      const dist = Math.abs(paths[sim][steps] - medianFinal);
      if (dist < minDist) {
        minDist = dist;
        representativePath = paths[sim];
      }
    }

    // Find 85th and 15th percentile high/low over simulation period
    const maxPrices = paths.map(path => Math.max(...path.slice(1)));
    const minPrices = paths.map(path => Math.min(...path.slice(1)));
    maxPrices.sort((a, b) => a - b);
    minPrices.sort((a, b) => a - b);

    const high = maxPrices[Math.floor(numSimulations * 0.85)];
    const low = minPrices[Math.floor(numSimulations * 0.15)];

    // 15. Build Chart Data
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

    // Prediction (T+1 to T+24) — uses representative path for realistic zig-zag
    for (let i = 1; i <= 24; i++) {
      labels.push(formatTime(currentTs + i * 4 * 3600 * 1000));

      historyData.push(null);
      predictionData.push(Number(representativePath[i].toFixed(2)));

      // Use pre-computed per-step percentile bands
      upperBandData.push(i === 1 ? null : Number(upperPath[i].toFixed(2)));
      lowerBandData.push(i === 1 ? null : Number(lowerPath[i].toFixed(2)));

      // predict volume based on average
      const avgVol = volume24h / 24;
      volumeData.push(Number((avgVol * (0.5 + Math.random())).toFixed(2)));
    }

    // 16. Generate QuickChart URL
    const chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Historical',
            data: historyData,
            borderColor: '#2ecc71',
            backgroundColor: 'rgba(46, 204, 113, 0.08)',
            borderWidth: 2.5,
            pointRadius: 0,
            fill: false,
            tension: 0.3,
            yAxisID: 'y',
          },
          {
            label: 'Forecast (Representative)',
            data: predictionData,
            borderColor: '#e74c3c',
            backgroundColor: 'rgba(231, 76, 60, 0.08)',
            borderDash: [6, 3],
            borderWidth: 2,
            pointRadius: 2,
            pointBackgroundColor: '#e74c3c',
            fill: false,
            tension: 0.3,
            yAxisID: 'y',
          },
          {
            label: 'Upper Band (85%)',
            data: upperBandData,
            borderColor: 'rgba(241, 196, 15, 0.7)',
            backgroundColor: 'rgba(241, 196, 15, 0.12)',
            borderDash: [3, 3],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: '+1',
            tension: 0.3,
            yAxisID: 'y',
          },
          {
            label: 'Lower Band (15%)',
            data: lowerBandData,
            borderColor: 'rgba(241, 196, 15, 0.7)',
            backgroundColor: 'rgba(241, 196, 15, 0.05)',
            borderDash: [3, 3],
            borderWidth: 1.5,
            fill: false,
            pointRadius: 0,
            tension: 0.3,
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
          text: `${originalSymbol} - Professional AI 4H Forecast (ADX, RSI, MACD, CMF, S/R, GK Vol, Monte Carlo)`,
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
      ema200: Number(ema200.toFixed(2)),
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
      resistance: Number(localMax.toFixed(2)),
      cmf: Number(cmf.toFixed(3))
    };
  }
}
