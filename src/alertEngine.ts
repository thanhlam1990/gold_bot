// ============================================================
// alertEngine.ts — Detect price changes & send notifications
// ============================================================

import axios from "axios";
import { AlertPayload, BotConfig, PriceSnapshot } from "./types";
import { logger } from "./logger";
import { UserManager } from "./userManager";

// ── Helpers ──────────────────────────────────────────────────

export function formatUSD(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export async function getExchangeRateVND(): Promise<number | null> {
  try {
    const { data } = await axios.get("https://api.exchangerate-api.com/v4/latest/USD");
    return data?.rates?.VND ? Math.round(data.rates.VND) : null;
  } catch (err) {
    logger.warn(`Failed to fetch VND exchange rate: ${(err as Error).message}`);
    return null;
  }
}

export function buildAlertMessage(payload: AlertPayload): string {
  const arrow = payload.direction === "UP" ? "📈" : "📉";

  const title = payload.isHourlyReport
    ? `⏱ ${payload.symbol} REPORT`
    : `${arrow} ${payload.symbol} PRICE ${payload.direction}`;

  return [
    title,
    ``,
    `  Current  : ${payload.currentPrice.toLocaleString('en-US')} / USD`,
    `  Rate     : ${payload.exchangeRateVND !== null ? payload.exchangeRateVND.toLocaleString('vi-VN') + ' VND / USD' : '--'}`,
    `  Amount   : ${payload.amountVND !== null ? payload.amountVND.toLocaleString('vi-VN') + ' VND' : '--'}`,
    ``,
    `  Now       : ${payload.currentTimestamp.toLocaleString("vi-VN")}`,
  ].join("\n");
}

// ── Notifiers ─────────────────────────────────────────────────

async function notifyConsole(payload: AlertPayload): Promise<void> {
  logger.alert(buildAlertMessage(payload));
}

async function notifyTelegram(
  payload: AlertPayload,
  botToken: string,
  chatId: string
): Promise<void> {
  const text = buildAlertMessage(payload);
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  await axios.post(url, {
    chat_id: chatId,
    text: `\`\`\`\n${text}\n\`\`\``,
    parse_mode: "Markdown",
  });

  logger.info(`Telegram notification sent for ${payload.symbol}.`);
}

async function notifyWebhook(
  payload: AlertPayload,
  webhookUrl: string
): Promise<void> {
  await axios.post(webhookUrl, {
    event: "asset_price_alert",
    symbol: payload.symbol,
    direction: payload.direction,
    currentPrice: payload.currentPrice,
    exchangeRateVND: payload.exchangeRateVND,
    amountVND: payload.amountVND,
    currentTimestamp: payload.currentTimestamp.toISOString(),
    message: buildAlertMessage(payload),
  });

  logger.info(`Webhook notification sent for ${payload.symbol} to ${webhookUrl}`);
}

// ── Alert Engine class ────────────────────────────────────────

export class AlertEngine {
  private snapshots: Map<string, PriceSnapshot> = new Map();
  private readonly config: BotConfig;
  private readonly userManager: UserManager;

  constructor(config: BotConfig, userManager: UserManager) {
    this.config = config;
    this.userManager = userManager;
  }

  /**
   * Compare newPrice against the last stored snapshot for the given symbol.
   * Fires alerts if |change| >= threshold%.
   * Updates the snapshot ONLY when an alert is fired, 
   * so small changes over time accumulate until they hit the threshold.
   */
  async evaluate(symbol: string, currentPrice: number, currentTimestamp: Date): Promise<void> {
    const previousSnapshot = this.snapshots.get(symbol);

    if (!previousSnapshot) {
      // First run for this symbol — just store baseline, no alert
      this.snapshots.set(symbol, { symbol, price: currentPrice, timestamp: currentTimestamp });
      logger.info(
        `📌 Baseline set for ${symbol}: ${currentPrice.toLocaleString('en-US')} at ${currentTimestamp.toLocaleString("vi-VN")}`
      );
      return;
    }

    const { price: prevPrice, timestamp: prevTimestamp } = previousSnapshot;
    const changePercent = ((currentPrice - prevPrice) / prevPrice) * 100;
    const absChange = Math.abs(changePercent);
    const threshold = this.config.thresholds[symbol] || 1; // Default to 1% if missing
    const hourlyReportInterval = this.config.hourlyReport;

    logger.info(
      `💰 ${symbol}: ${currentPrice.toLocaleString('en-US')}  |  ` +
      `prev: ${prevPrice.toLocaleString('en-US')}  |  ` +
      `Δ ${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(3)}% (threshold: ${threshold}%)`
    );

    const timeDiffMs = currentTimestamp.getTime() - prevTimestamp.getTime();
    const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
    const isHourlyReport = timeDiffHours >= hourlyReportInterval;

    if (absChange < threshold && !isHourlyReport) {
      logger.debug(
        `[${symbol}] No alert — change ${absChange.toFixed(3)}% < threshold ${threshold}%`
      );
      return;
    }

    // Update snapshot only when an alert is actually fired
    this.snapshots.set(symbol, { symbol, price: currentPrice, timestamp: currentTimestamp });

    if (isHourlyReport && absChange < threshold) {
      logger.info(`⏱ Hourly report sent for ${symbol}. New baseline set: ${currentPrice.toLocaleString('en-US')}`);
    } else {
      logger.info(`📌 New baseline set for ${symbol}: ${currentPrice.toLocaleString('en-US')}`);
    }

    const exchangeRateVND = await getExchangeRateVND();

    const payload: AlertPayload = {
      symbol,
      direction: changePercent >= 0 ? "UP" : "DOWN",
      currentPrice: currentPrice,
      currentTimestamp: currentTimestamp,
      exchangeRateVND: exchangeRateVND,
      amountVND: exchangeRateVND !== null ? Math.round(currentPrice * (symbol.toUpperCase().includes('XAU') ? 1.205653 : 1) * exchangeRateVND) : null,
      isHourlyReport: isHourlyReport && absChange < threshold,
    };

    await this.dispatch(payload);
  }

  private async dispatch(payload: AlertPayload): Promise<void> {
    const { notifications } = this.config;
    const tasks: Promise<void>[] = [];

    if (notifications.console) {
      tasks.push(notifyConsole(payload));
    }

    if (
      notifications.telegram &&
      notifications.telegramBotToken
    ) {
      tasks.push(
        (async () => {
          const vips = await this.userManager.getActiveVips();
          const targetChats = new Set<string>();
          // Include the admin channel/chat if set
          if (notifications.telegramChatId) {
            targetChats.add(notifications.telegramChatId);
          }
          for (const vip of vips) {
            targetChats.add(vip.chatId);
          }

          for (const chatId of targetChats) {
            try {
              await notifyTelegram(payload, notifications.telegramBotToken!, chatId);
              // Small delay to avoid rate limit (30 msgs/sec limit on Telegram)
              await new Promise(resolve => setTimeout(resolve, 100));
            } catch (err) {
              logger.error(`Telegram error for ${payload.symbol} to ${chatId}: ${(err as Error).message}`);
            }
          }
        })()
      );
    }

    if (notifications.webhook && notifications.webhookUrl) {
      tasks.push(
        notifyWebhook(payload, notifications.webhookUrl).catch((err) =>
          logger.error(`Webhook error for ${payload.symbol}: ${(err as Error).message}`)
        )
      );
    }

    await Promise.all(tasks);
  }

  /** Expose last snapshot for status display */
  getSnapshot(symbol: string): PriceSnapshot | undefined {
    return this.snapshots.get(symbol);
  }
}
