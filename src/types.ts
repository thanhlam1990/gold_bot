// ============================================================
// types.ts — Shared type definitions
// ============================================================

export interface AssetPrice {
  price: number;          // USD price
  symbol: string;         // e.g. XAU, BTC, ETH
  timestamp: Date;
  currency: string;
  metal?: string;
}

export interface PriceSnapshot {
  price: number;
  symbol: string;
  timestamp: Date;
}

export interface AlertPayload {
  symbol: string;
  direction: "UP" | "DOWN";
  changePercent: number;
  previousPrice: number;
  currentPrice: number;
  previousTimestamp: Date;
  currentTimestamp: Date;
  isHourlyReport?: boolean;
}

export interface BotConfig {
  apiKey: string;
  symbols: string[];
  thresholds: Record<string, number>; // symbol -> threshold%
  pollIntervalMinutes: number;
  notifications: {
    console: boolean;
    telegram: boolean;
    telegramBotToken?: string;
    telegramChatId?: string;
    webhook: boolean;
    webhookUrl?: string;
  };
  logLevel: "debug" | "info" | "warn" | "error";
  hourlyReport: number;
}
