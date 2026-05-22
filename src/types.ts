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
  currentPrice: number;
  currentTimestamp: Date;
  exchangeRateVND: number | null;
  amountVND: number | null;
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
  ip_http: string;
}
