import TelegramBot from 'node-telegram-bot-api';
import { AssetFetcher } from './goldFetcher';
import { BotConfig, AlertPayload } from './types';
import { logger } from './logger';
import { AlertEngine, buildAlertMessage, getExchangeRateVND } from './alertEngine';
import { HistoryManager } from './historyManager';
import { PricePredictor } from './predictor';
import { UserManager } from './userManager';

export class TelegramBotService {
  private bot: TelegramBot;
  private readonly fetcher: AssetFetcher;
  private readonly engine: AlertEngine;
  private readonly history: HistoryManager;
  private readonly config: BotConfig;

  private readonly userManager: UserManager;

  constructor(config: BotConfig, fetcher: AssetFetcher, engine: AlertEngine, history: HistoryManager, userManager: UserManager) {
    if (!config.notifications.telegramBotToken) {
      throw new Error('Telegram Bot Token is required for TelegramBotService');
    }
    // Initialize bot with polling enabled
    this.bot = new TelegramBot(config.notifications.telegramBotToken, { polling: true });
    this.fetcher = fetcher;
    this.engine = engine;
    this.history = history;
    this.config = config;
    this.userManager = userManager;
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

    // --- /start command ---
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const adminUsername = this.config.notifications.telegramAdminUsername;

      const text = [
        `👋 Chào mừng đến với *Bot Cảnh Báo Giá Vàng & Crypto!*`,
        ``,
        `🆔 Chat ID của bạn là: \`${chatId}\``,
        ``,
        `📌 Để nhận *push cảnh báo tự động* khi giá biến động, bạn cần đăng ký gói VIP.`,
        `Nhấn nút bên dưới để gửi ID của bạn cho Admin nhé! 👇`,
      ].join('\n');

      const options: any = { parse_mode: 'Markdown' };

      if (adminUsername) {
        const prefilledMsg = encodeURIComponent(`Đăng ký VIP - Chat ID: ${chatId}`);
        options.reply_markup = {
          inline_keyboard: [[
            {
              text: '📩 Liên hệ Admin đăng ký VIP',
              url: `https://t.me/${adminUsername}?text=${prefilledMsg}`
            }
          ]]
        };
      }

      await this.bot.sendMessage(chatId, text, options);
    });

    const isAdmin = (chatId: number) => {
      return this.config.notifications.telegramChatId &&
        chatId.toString() === this.config.notifications.telegramChatId;
    };

    // --- /addvip <chatId> <days> ---
    this.bot.onText(/\/addvip\s+(\-?\d+)\s+(\d+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) return;

      const targetChatId = match![1];
      const days = parseInt(match![2], 10);

      await this.userManager.addVip(targetChatId, days);
      await this.bot.sendMessage(chatId, `✅ Đã cấp quyền VIP cho ${targetChatId} thêm ${days} ngày.`);
      try {
        await this.bot.sendMessage(targetChatId, `🎉 Chúc mừng! Bạn đã được cấp quyền VIP nhận push cảnh báo tự động trong ${days} ngày.`);
      } catch (err) {
        logger.warn(`Could not notify user ${targetChatId}: ${(err as Error).message}`);
      }
    });

    // --- /removevip <chatId> ---
    this.bot.onText(/\/removevip\s+(\-?\d+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) return;

      const targetChatId = match![1];
      await this.userManager.removeVip(targetChatId);
      await this.bot.sendMessage(chatId, `❌ Đã hủy quyền VIP của ${targetChatId}.`);
      try {
        await this.bot.sendMessage(targetChatId, `🚫 Quyền VIP nhận cảnh báo của bạn đã bị hủy.`);
      } catch (err) {
        logger.warn(`Could not notify user ${targetChatId}: ${(err as Error).message}`);
      }
    });

    // --- /listvip ---
    this.bot.onText(/\/listvip/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) return;

      const vips = await this.userManager.getActiveVips();
      if (vips.length === 0) {
        await this.bot.sendMessage(chatId, `Danh sách VIP đang trống.`);
        return;
      }

      const lines = vips.map(v => {
        const d = new Date(v.expireAt).toLocaleDateString('vi-VN');
        return `- ${v.chatId}: hết hạn ${d}`;
      });
      await this.bot.sendMessage(chatId, `📋 Danh sách VIP active:\n${lines.join('\n')}`);
    });

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
              const exchangeRateVND = await getExchangeRateVND();
              const payload: AlertPayload = {
                symbol,
                direction: changePercent >= 0 ? "UP" : "DOWN",
                changePercent,
                currentPrice: assetPrice.price,
                currentTimestamp: assetPrice.timestamp,
                exchangeRateVND: exchangeRateVND,
                amountVND: exchangeRateVND !== null ? Math.round(assetPrice.price * (symbol.toUpperCase().includes('XAU') ? 1.205653 : 1) * exchangeRateVND) : null,
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

      const isUserVip = isAdmin(chatId) || await this.userManager.isVip(chatId.toString());
      if (!isUserVip) {
        const adminUsername = this.config.notifications.telegramAdminUsername;
        const options: any = { parse_mode: 'Markdown' };

        if (adminUsername) {
          const prefilledMsg = encodeURIComponent(`Đăng ký VIP - Chat ID: ${chatId}`);
          options.reply_markup = {
            inline_keyboard: [[
              {
                text: '📩 Liên hệ Admin đăng ký VIP',
                url: `https://t.me/${adminUsername}?text=${prefilledMsg}`
              }
            ]]
          };
        }

        await this.bot.sendMessage(
          chatId,
          `🚫 Lệnh này chỉ dành cho tài khoản VIP. Vui lòng liên hệ Admin để đăng ký VIP.`,
          options
        );
        return;
      }

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
              `📈 Predicted High (4D): *$${result.predicted24hHigh.toLocaleString('en-US')}*`,
              `📉 Predicted Low (4D):  *$${result.predicted24hLow.toLocaleString('en-US')}*`,
              ``,
              `📊 *Key Levels & Indicators (PRO)*`,
              `• Support (25D): $${result.support ? result.support.toLocaleString('en-US') : 'N/A'}`,
              `• Resistance (25D): $${result.resistance ? result.resistance.toLocaleString('en-US') : 'N/A'}`,
              `• ADX (14): ${result.adx !== undefined ? result.adx.toFixed(1) : 'N/A'} (${result.adx !== undefined && result.adx > 25 ? 'Strong Trend' : 'Ranging/Weak Trend'})`,
              `• CMF (20): ${result.cmf !== undefined ? result.cmf.toFixed(2) : 'N/A'} (${result.cmf !== undefined && result.cmf > 0.1 ? 'Accumulation' : result.cmf !== undefined && result.cmf < -0.1 ? 'Distribution' : 'Neutral'})`,
              `• RSI (14): ${result.rsi} ${result.rsi > 70 ? '(Overbought)' : result.rsi < 30 ? '(Oversold)' : '(Neutral)'}`,
              `• EMA (20/50/200): $${result.ema20.toLocaleString('en-US')} / $${result.ema50.toLocaleString('en-US')} / $${result.ema200 ? result.ema200.toLocaleString('en-US') : 'N/A'}`,
              `• MACD: *${result.macd}*`,
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
