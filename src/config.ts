// ============================================================
// config.ts — Load & validate environment configuration
// ============================================================

import * as dotenv from "dotenv";
import { BotConfig } from "./types";

dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export function loadConfig(): BotConfig {
  const notifyTelegram = optionalEnv("NOTIFY_TELEGRAM", "false") === "true";
  const notifyWebhook = optionalEnv("NOTIFY_WEBHOOK", "false") === "true";
  const symbols = optionalEnv("SYMBOLS", "XAU").split(",").map(s => s.trim().toUpperCase());
  const defaultThreshold = parseFloat(optionalEnv("ALERT_THRESHOLD_PERCENT", "1"));

  const thresholds: Record<string, number> = {};
  for (const s of symbols) {
    thresholds[s] = parseFloat(optionalEnv(`THRESHOLD_${s}`, defaultThreshold.toString()));
  }

  return {
    apiKey: requireEnv("GOLD_API_KEY"),
    symbols,
    thresholds,
    pollIntervalMinutes: parseInt(
      optionalEnv("POLL_INTERVAL_MINUTES", "5"),
      10
    ),

    notifications: {
      console: optionalEnv("NOTIFY_CONSOLE", "true") === "true",

      telegram: notifyTelegram,
      telegramBotToken: notifyTelegram
        ? requireEnv("TELEGRAM_BOT_TOKEN")
        : undefined,
      telegramChatId: notifyTelegram
        ? requireEnv("TELEGRAM_CHAT_ID")
        : undefined,

      webhook: notifyWebhook,
      webhookUrl: notifyWebhook ? requireEnv("WEBHOOK_URL") : undefined,
    },

    logLevel: (optionalEnv("LOG_LEVEL", "info") as BotConfig["logLevel"]),
    hourlyReport: parseInt(optionalEnv("HOURLY_REPORT", "2"), 10),
    ip_http: requireEnv("IP_HTTP")
  };
}
