import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { AssetPrice } from './types';

interface HistoryRecord {
  timestamp: number;
  price: number;
}

export class HistoryManager {
  private historyPath: string;
  private history: Map<string, HistoryRecord[]> = new Map();
  private readonly MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(dataDir: string = 'data') {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.historyPath = path.join(dataDir, 'history.json');
    this.load();
  }

  /**
   * Add a new price point and prune old data
   */
  public addPrice(asset: AssetPrice): void {
    const symbol = asset.symbol;
    const records = this.history.get(symbol) || [];

    // Add new record
    records.push({
      timestamp: asset.timestamp.getTime(),
      price: asset.price
    });

    // Prune data older than 24 hours
    const now = Date.now();
    const filtered = records.filter(r => (now - r.timestamp) <= this.MAX_AGE_MS);

    this.history.set(symbol, filtered);
    this.save();
  }

  /**
   * Get history for a specific symbol
   */
  public getHistory(symbol: string): HistoryRecord[] {
    return this.history.get(symbol) || [];
  }

  /**
   * Get High/Low stats for the last 24h
   */
  public getStats(symbol: string): { high: number; low: number } | null {
    const records = this.history.get(symbol) || [];
    if (records.length === 0) return null;

    let high = -Infinity;
    let low = Infinity;

    for (const r of records) {
      if (r.price > high) high = r.price;
      if (r.price < low) low = r.price;
    }

    return { high, low };
  }

  private save(): void {
    try {
      // Convert Map to plain object for JSON serialization
      const obj: Record<string, HistoryRecord[]> = {};
      for (const [symbol, records] of this.history) {
        obj[symbol] = records;
      }
      fs.writeFileSync(this.historyPath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`Failed to save history: ${(err as Error).message}`);
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.historyPath)) {
        const content = fs.readFileSync(this.historyPath, 'utf-8');
        const obj = JSON.parse(content) as Record<string, HistoryRecord[]>;

        const now = Date.now();
        for (const symbol in obj) {
          // Filter out stale data on load too
          const validRecords = obj[symbol].filter(r => (now - r.timestamp) <= this.MAX_AGE_MS);
          this.history.set(symbol, validRecords);
        }
        logger.info(`Loaded history for ${this.history.size} assets from ${this.historyPath}`);
      }
    } catch (err) {
      logger.warn(`Failed to load history (starting fresh): ${(err as Error).message}`);
    }
  }
}
