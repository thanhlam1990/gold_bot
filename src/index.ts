import * as cron from "node-cron";
import { loadConfig } from "./config";
import { AssetFetcher } from "./goldFetcher";
import { AlertEngine } from "./alertEngine";
import { HistoryManager } from "./historyManager";
import { logger, setLogLevel } from "./logger";

// ── Bootstrap ─────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Load config
  const config = loadConfig();
  setLogLevel(config.logLevel);

  logger.info("╔══════════════════════════════════════════╗");
  logger.info("║        🪙  Multi-Asset Alert Bot         ║");
  logger.info("╚══════════════════════════════════════════╝");
  logger.info(`  Symbols         : ${config.symbols.join(", ")}`);
  logger.info(`  Thresholds      : ${JSON.stringify(config.thresholds)}`);
  logger.info(`  Poll interval   : every ${config.pollIntervalMinutes} min`);
  logger.info(
    `  Notifiers       : ${[
      config.notifications.console && "console",
      config.notifications.telegram && "telegram",
      config.notifications.webhook && "webhook",
    ]
      .filter(Boolean)
      .join(", ")}`
  );
  logger.info("");

  // 2. Instantiate services
  const fetcher = new AssetFetcher(config.apiKey);
  const engine = new AlertEngine(config);
  const history = new HistoryManager();

  // 2.1 Start Telegram listener if enabled
  if (config.notifications.telegram && config.notifications.telegramBotToken) {
    const { TelegramBotService } = await import("./telegramBot");
    const tgBot = new TelegramBotService(config, fetcher, engine, history);
    tgBot.listen();
  }

  // 3. Define the polling tick
  async function tick(): Promise<void> {
    for (const symbol of config.symbols) {
      try {
        const assetPrice = await fetcher.fetch(symbol);
        
        // Record history
        history.addPrice(assetPrice);
        
        // Evaluate for alerts
        await engine.evaluate(symbol, assetPrice.price, assetPrice.timestamp);
      } catch (err) {
        logger.error(`Tick error for ${symbol}: ${(err as Error).message}`);
      }
    }
  }

  // 4. Run once immediately, then schedule
  logger.info("Running initial price fetch …");
  await tick();

  const cronExpr = `*/${config.pollIntervalMinutes} * * * *`;
  logger.info(`Scheduling cron: "${cronExpr}"`);

  cron.schedule(cronExpr, () => {
    void tick();
  });

  // 5. Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      logger.info(`\nReceived ${sig}. Shutting down …`);
      process.exit(0);
    });
  }

  // Keep alive
  logger.info("Bot is running. Press Ctrl+C to stop.\n");
}

main().catch((err: Error) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
