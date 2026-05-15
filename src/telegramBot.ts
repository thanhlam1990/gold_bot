import TelegramBot from 'node-telegram-bot-api';
import { AssetFetcher } from './goldFetcher';
import { BotConfig, AlertPayload } from './types';
import { logger } from './logger';
import { AlertEngine, buildAlertMessage } from './alertEngine';
import { HistoryManager } from './historyManager';
import { PricePredictor } from './predictor';

export class TelegramBotService {
  private bot: TelegramBot;
  private readonly fetcher: AssetFetcher;
  private readonly engine: AlertEngine;
  private readonly history: HistoryManager;
  private readonly config: BotConfig;

  constructor(config: BotConfig, fetcher: AssetFetcher, engine: AlertEngine, history: HistoryManager) {
    if (!config.notifications.telegramBotToken) {
      throw new Error('Telegram Bot Token is required for TelegramBotService');
    }
    // Initialize bot with polling enabled
    this.bot = new TelegramBot(config.notifications.telegramBotToken, { polling: true });
    this.fetcher = fetcher;
    this.engine = engine;
    this.history = history;
    this.config = config;
  }

  /**
   * Start listening for commands
   */
  public listen(): void {
    logger.info('🚀 Telegram command listener active (/get, /stats)');

    // Dynamically build command menu
    const commands = [
      { command: 'get', description: 'Get current prices' },
      { command: 'stats', description: '24h stats' },
      { command: 'predict', description: 'Predict next 4days price' }
    ];
    if (this.config.symbols.length > 1) {
      this.config.symbols.map(s => {
        commands.push({
          command: `stats_${s.toLowerCase()}`,
          description: `24h stats for ${s}`
        });
        commands.push({
          command: `predict_${s.toLowerCase()}`,
          description: `Predict next 4days for ${s}`
        });
      });
    }
    this.bot.setMyCommands(commands).catch(err =>
      logger.warn(`[Telegram] Failed to set commands: ${err.message}`)
    );

    // --- /get command (Detailed status per asset) ---
    this.bot.onText(/\/get(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const requestedSymbol = match?.[1]?.trim().toUpperCase();

      try {
        const symbolsToFetch = requestedSymbol ? [requestedSymbol] : this.config.symbols;

        for (const symbol of symbolsToFetch) {
          try {
            const assetPrice = await this.fetcher.fetch(symbol);
            // Update history on demand
            this.history.addPrice(assetPrice);

            const currentSnapshot = this.engine.getSnapshot(symbol);

            if (currentSnapshot) {
              const changePercent = ((assetPrice.price - currentSnapshot.price) / currentSnapshot.price) * 100;
              const payload: AlertPayload = {
                symbol,
                direction: changePercent >= 0 ? "UP" : "DOWN",
                changePercent: changePercent,
                previousPrice: currentSnapshot.price,
                currentPrice: assetPrice.price,
                previousTimestamp: currentSnapshot.timestamp,
                currentTimestamp: assetPrice.timestamp,
              };

              const text = buildAlertMessage(payload);
              await this.bot.sendMessage(chatId, `\`\`\`\n${text}\n\`\`\``, { parse_mode: 'Markdown' });
            } else {
              // Fallback if no baseline yet
              const response = [
                `💰 *${symbol} Price*`,
                `────────────────────`,
                `💵 Price: *${assetPrice.price.toLocaleString('en-US')}* / USD`,
                `🕒 Time:  ${assetPrice.timestamp.toLocaleString('vi-VN')}`,
                `────────────────────`,
                `_Baseline not yet established_`
              ].join('\n');
              await this.bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
            }
          } catch (err) {
            await this.bot.sendMessage(chatId, `❌ Error fetching *${symbol}*: ${(err as Error).message}`, { parse_mode: 'Markdown' });
          }
        }
      } catch (error) {
        logger.error(`[Telegram] Failed to handle /get: ${(error as Error).message}`);
      }
    });

    // --- /stats command (Detailed analytics) ---
    // Matches: /stats, /stats BTC, or /stats_btc
    this.bot.onText(/\/stats(?:_(\w+))?(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      // requestedSymbol can come from /stats_BTC (group 1) or /stats BTC (group 2)
      const requestedSymbol = (match?.[1] || match?.[2])?.trim().toUpperCase();

      logger.info(`[Telegram] Received /stats command from ${chatId} for ${requestedSymbol || 'ALL'}`);

      try {
        const symbolsToFetch = requestedSymbol ? [requestedSymbol] : this.config.symbols;

        for (const symbol of symbolsToFetch) {
          try {
            const assetPrice = await this.fetcher.fetch(symbol);
            // Update history on demand
            this.history.addPrice(assetPrice);

            const stats = this.history.getStats(symbol);

            const results: string[] = [
              `📊 ${symbol} ANALYTICS (24H)`,
              ``
            ];

            if (stats) {
              const range = stats.high - stats.low;
              const rangePercent = (range / stats.low) * 100;

              results.push(
                `  💵 Price:  *$${assetPrice.price.toLocaleString('en-US')}*`,
                `  📈 High:   $${stats.high.toLocaleString('en-US')}`,
                `  📉 Low:    $${stats.low.toLocaleString('en-US')}`,
                `  🔄 Range:  $${range.toLocaleString('en-US')} (${rangePercent.toFixed(2)}%)`
              );
            } else {
              results.push(`  💵 Price:  *$${assetPrice.price.toLocaleString('en-US')}*`, `_ (No 24h history yet)_`);
            }

            results.push(``);
            results.push(`  🕒 ${new Date().toLocaleString('vi-VN')}`);

            await this.bot.sendMessage(chatId, `\`\`\`\n${results.join('\n')}\n\`\`\``, { parse_mode: 'Markdown' });
          } catch (err) {
            await this.bot.sendMessage(chatId, `❌ Error fetching *${symbol}*: ${(err as Error).message}`, { parse_mode: 'Markdown' });
          }
        }
      } catch (error) {
        logger.error(`[Telegram] Failed to handle /stats: ${(error as Error).message}`);
        await this.bot.sendMessage(chatId, `❌ Error generating stats.`);
      }
    });

    // --- /predict command ---
    this.bot.onText(/\/predict(?:_(\w+))?(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const requestedSymbol = (match?.[1] || match?.[2])?.trim().toUpperCase();

      logger.info(`[Telegram] Received /predict command from ${chatId} for ${requestedSymbol || 'ALL'}`);

      try {
        const symbolsToFetch = requestedSymbol ? [requestedSymbol] : this.config.symbols;
        const predictor = new PricePredictor();

        for (const symbol of symbolsToFetch) {
          try {
            await this.bot.sendMessage(chatId, `⏳ Generating prediction chart for ${symbol}...`);

            const result = await predictor.generatePrediction(symbol);

            const caption = [
              `🔮 *${symbol} 96h (4-DAY) PREDICTION*`,
              ``,
              `💵 Current Price: *$${result.currentPrice.toLocaleString('en-US')}*`,
              `📈 Predicted High (4D): $${result.predicted24hHigh.toLocaleString('en-US')}`,
              `📉 Predicted Low (4D):  $${result.predicted24hLow.toLocaleString('en-US')}`,
              ``,
              `📊 *Technical Indicators (PRO)*`,
              `• RSI (14): ${result.rsi} ${result.rsi > 70 ? '(Overbought)' : result.rsi < 30 ? '(Oversold)' : '(Neutral)'}`,
              `• EMA (20/50): $${result.ema20.toLocaleString('en-US')} / $${result.ema50.toLocaleString('en-US')}`,
              `• MACD: *${result.macd}*`,
              `• Bollinger Bands: $${result.bbLower.toLocaleString('en-US')} - $${result.bbUpper.toLocaleString('en-US')}`,
              `• Projected Trend: *${result.trend}*`,
              ``,
              `_Note: This is an automated prediction based on algorithmic simulation. Not financial advice._`
            ].join('\n');

            await this.bot.sendPhoto(chatId, result.chartUrl, { caption, parse_mode: 'Markdown' });
          } catch (err) {
            await this.bot.sendMessage(chatId, `❌ Error predicting *${symbol}*: ${(err as Error).message}`, { parse_mode: 'Markdown' });
          }
        }
      } catch (error) {
        logger.error(`[Telegram] Failed to handle /predict: ${(error as Error).message}`);
      }
    });

    // Handle errors
    this.bot.on('polling_error', (error) => {
      if (error.message.includes('EFATAL')) {
        logger.error(`[Telegram] Polling error: ${error.message}`);
      }
    });
  }
}
