import axios, { AxiosInstance } from "axios";
import { AssetPrice } from "./types";
import { logger } from "./logger";
import https from "https";
import dns from "dns";
// ── GoldAPI.io response shape ────────────────────────────────
interface GoldApiResponse {
  timestamp: number;
  metal: string;
  currency: string;
  exchange: string;
  symbol: string;
  prev_close_price: number;
  open_price: number;
  low_price: number;
  high_price: number;
  open_time: number;
  price: number;
  ch: number;       // change
  chp: number;      // change percent
  ask: number;
  bid: number;
}

export class AssetFetcher {
  private readonly client: AxiosInstance;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: "https://www.goldapi.io/api",
      timeout: 10_000,
      headers: {
        "x-access-token": apiKey,
        "Content-Type": "application/json",
      },
    });
  }

  // ── Primary: GoldAPI.io ────────────────────────────────────
  async fetchFromGoldApi(symbol: string): Promise<AssetPrice> {
    logger.debug(`Fetching ${symbol} from GoldAPI.io …`);
    const { data } = await this.client.get<GoldApiResponse>(`/${symbol}/USD`);

    if (!data?.price) {
      throw new Error(`GoldAPI returned empty price for ${symbol}`);
    }

    return {
      price: data.price,
      symbol,
      timestamp: new Date(data.timestamp * 1000),
      currency: data.currency,
      metal: data.metal,
    };
  }

  // ── Fallback: gold-api.com public JSON ───────────────────────
  // api.gold-api.com provides a free, no-auth endpoint
  async fetchFromGoldApiFallback(symbol: string): Promise<AssetPrice> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    const agent = new https.Agent({
      lookup: (
        hostname: string,
        options: any,
        callback: any
      ) => {

        // override DNS
        if (hostname === "api.gold-api.com") {
          return callback(null, "137.184.95.73", 4);
        }

        // important
        return dns.lookup(
          hostname,
          {
            ...options,
            all: false
          },
          callback
        );
      }
    });
    for (let i = 0; i < maxRetries; i++) {
      try {
        logger.debug(`Fetching ${symbol} from api.gold-api.com fallback (attempt ${i + 1}) …`);
        const { data } = await axios.get<{ price: number; updatedAt: string }>(
          `https://api.gold-api.com/price/${symbol}`,
          {
            httpsAgent: agent,
            timeout: 10_000,
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; AssetAlertBot/1.0)",
              "Accept": "application/json",
            },
          }
        );

        if (!data?.price) {
          throw new Error(`gold-api.com returned empty price for ${symbol}`);
        }

        return {
          price: data.price,
          symbol,
          timestamp: data.updatedAt ? new Date(data.updatedAt) : new Date(),
          currency: "USD",
        };
      } catch (err) {
        lastError = err as Error;
        logger.warn(`Attempt ${i + 1} failed for ${symbol}: ${lastError.message}`);
        if (i < maxRetries - 1) {
          const delay = 2000 * (i + 1); // Exponential-ish backoff
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`All ${maxRetries} fallback attempts failed for ${symbol}. Last error: ${lastError?.message}`);
  }

  // ── Public method: try primary → fallback ──────────────────
  async fetch(symbol: string): Promise<AssetPrice> {
    // try {
    //   const price = await this.fetchFromGoldApi(symbol);
    //   logger.debug(`${symbol} GoldAPI price: $${price.price} at ${price.timestamp.toISOString()}`);
    //   return price;
    // } catch (err) {
    //   logger.warn(`GoldAPI failed for ${symbol} (${(err as Error).message}), trying fallback …`);
    // }

    // Fallback
    const price = await this.fetchFromGoldApiFallback(symbol);
    logger.debug(`${symbol} Fallback price: $${price.price} at ${price.timestamp.toISOString()}`);
    return price;
  }

}
