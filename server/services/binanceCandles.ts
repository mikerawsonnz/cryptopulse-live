export interface BinanceCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type TimeframeKey = '1m' | '5m' | '15m' | '1h';

const BINANCE_BASE_URL = "https://data-api.binance.vision/api/v3";

const COIN_TO_BINANCE_SYMBOL: Record<string, string> = {
  bitcoin: "BTCUSDT",
  ethereum: "ETHUSDT",
  solana: "SOLUSDT",
  binancecoin: "BNBUSDT",
  ripple: "XRPUSDT",
  dogecoin: "DOGEUSDT",
  cardano: "ADAUSDT",
  "avalanche-2": "AVAXUSDT",
  avalanche: "AVAXUSDT",
  chainlink: "LINKUSDT",
  tron: "TRXUSDT",
  litecoin: "LTCUSDT",
  uniswap: "UNIUSDT",
  sui: "SUIUSDT",
  "bitcoin-cash": "BCHUSDT",
  zcash: "ZECUSDT",
  aave: "AAVEUSDT",
  pepe: "PEPEUSDT",
  injective: "INJUSDT",
  near: "NEARUSDT",
  aptos: "APTUSDT",
  arbitrum: "ARBUSDT",
  optimism: "OPUSDT",
  polkadot: "DOTUSDT",
  cosmos: "ATOMUSDT",
  stellar: "XLMUSDT",
  hedera: "HBARUSDT",
  filecoin: "FILUSDT",
  render: "RENDERUSDT",
  hyperliquid: "HYPEUSDT",
  "sahara-ai": "SAHARAUSDT",
  enso: "ENSOUSDT",
};

const TIMEFRAME_CONFIG: Record<TimeframeKey, { interval: string; candlesNeeded: number; refreshMs: number; historyDays: number; maxCandles: number }> = {
  '1m':  { interval: '1m',  candlesNeeded: 25,  refreshMs: 30_000,      historyDays: 0.03, maxCandles: 30  },
  '5m':  { interval: '5m',  candlesNeeded: 30,  refreshMs: 60_000,      historyDays: 0.2,  maxCandles: 30  },
  '15m': { interval: '15m', candlesNeeded: 30,  refreshMs: 2 * 60_000,  historyDays: 0.5,  maxCandles: 30  },
  '1h':  { interval: '1h',  candlesNeeded: 30,  refreshMs: 5 * 60_000,  historyDays: 2,    maxCandles: 30  },
};

export function hasBinanceSymbol(coinId: string): boolean {
  return coinId in COIN_TO_BINANCE_SYMBOL;
}

const EXCLUDED_TICKERS = new Set([
  'USDCUSDT', 'FDUSDUSDT', 'USD1USDT', 'TUSDUSDT', 'DAIUSDT', 'BUSDUSDT',
  'EURUSDT', 'PAXGUSDT', 'XAUTUSDT', 'WBTCUSDT', 'WETHUSDT', 'WBETHUSDT',
  'WBNBUSDT', 'AEURUSDT', 'GBPUSDT', 'BRLUSDT', 'TRYUSDT',
]);

const BINANCE_TICKER_TO_SYMBOL: Record<string, string> = {};
for (const [coinId, ticker] of Object.entries(COIN_TO_BINANCE_SYMBOL)) {
  const sym = ticker.replace('USDT', '');
  if (!BINANCE_TICKER_TO_SYMBOL[ticker]) {
    BINANCE_TICKER_TO_SYMBOL[ticker] = sym;
  }
}

export interface BinanceTop15Entry {
  symbol: string;
  binanceTicker: string;
  coinId: string;
  price: number;
  volume24h: number;
  priceChangePercent: number;
}

let cachedTop15: BinanceTop15Entry[] = [];
let top15LastFetch = 0;
const TOP15_CACHE_MS = 60_000;

let currentTop15Symbols: Set<string> = new Set();

export function getCurrentTop15Symbols(): Set<string> {
  return currentTop15Symbols;
}

export function isSymbolInTop15(symbol: string): boolean {
  if (currentTop15Symbols.size === 0) return false;
  return currentTop15Symbols.has(symbol.toUpperCase());
}

const SYMBOL_TO_COINID: Record<string, string> = {};
for (const [coinId, ticker] of Object.entries(COIN_TO_BINANCE_SYMBOL)) {
  const sym = ticker.replace('USDT', '');
  if (!SYMBOL_TO_COINID[sym]) {
    SYMBOL_TO_COINID[sym] = coinId;
  }
}

const TOP15_RETRY_ATTEMPTS = 3;
const TOP15_RETRY_DELAY_MS = 2000;

export async function getBinanceTop15(): Promise<BinanceTop15Entry[]> {
  const now = Date.now();
  if (cachedTop15.length > 0 && now - top15LastFetch < TOP15_CACHE_MS) {
    return cachedTop15;
  }

  for (let attempt = 1; attempt <= TOP15_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await rateLimitedFetch(`${BINANCE_BASE_URL}/ticker/24hr`);
      if (!response || !response.ok) {
        console.error(`[BinanceTop15] Fetch error attempt ${attempt}/${TOP15_RETRY_ATTEMPTS}: ${response?.status}`);
        if (attempt < TOP15_RETRY_ATTEMPTS) {
          await sleep(TOP15_RETRY_DELAY_MS);
          continue;
        }
        console.warn(`[BinanceTop15] All ${TOP15_RETRY_ATTEMPTS} attempts failed, using cached data (${cachedTop15.length} coins)`);
        return cachedTop15;
      }

      const data: Array<{ symbol: string; lastPrice: string; quoteVolume: string; priceChangePercent: string }> = await response.json();

      const usdtPairs = data
        .filter(d => d.symbol.endsWith('USDT') && !EXCLUDED_TICKERS.has(d.symbol))
        .map(d => ({
          ticker: d.symbol,
          sym: d.symbol.replace('USDT', ''),
          price: parseFloat(d.lastPrice),
          volume: parseFloat(d.quoteVolume),
          change: parseFloat(d.priceChangePercent),
        }))
        .filter(d => d.price > 0 && d.volume > 0)
        .sort((a, b) => b.volume - a.volume);

      const seen = new Set<string>();
      const top15: BinanceTop15Entry[] = [];

      for (const pair of usdtPairs) {
        if (top15.length >= 15) break;
        if (seen.has(pair.sym)) continue;

        const coinId = SYMBOL_TO_COINID[pair.sym];
        if (!coinId) continue;

        seen.add(pair.sym);
        top15.push({
          symbol: pair.sym,
          binanceTicker: pair.ticker,
          coinId,
          price: pair.price,
          volume24h: pair.volume,
          priceChangePercent: pair.change,
        });
      }

      cachedTop15 = top15;
      top15LastFetch = now;

      currentTop15Symbols = new Set(top15.map(e => e.symbol));
      console.log(`[BinanceTop15] Updated top 15: ${top15.map(e => e.symbol).join(', ')}`);

      return top15;
    } catch (error) {
      console.error(`[BinanceTop15] Error attempt ${attempt}/${TOP15_RETRY_ATTEMPTS}:`, error instanceof Error ? error.message : error);
      if (attempt < TOP15_RETRY_ATTEMPTS) {
        await sleep(TOP15_RETRY_DELAY_MS);
        continue;
      }
      console.warn(`[BinanceTop15] All ${TOP15_RETRY_ATTEMPTS} attempts failed, using cached data (${cachedTop15.length} coins)`);
      return cachedTop15;
    }
  }
  return cachedTop15;
}

const candleCache: Map<string, Map<TimeframeKey, BinanceCandle[]>> = new Map();
const lastFetchTime: Map<string, Map<TimeframeKey, number>> = new Map();

let requestCount = 0;
let requestWindowStart = Date.now();
const MAX_REQUESTS_PER_MINUTE = 600;

const FETCH_TIMEOUT_MS = 10_000;

async function rateLimitedFetch(url: string): Promise<Response | null> {
  const now = Date.now();
  if (now - requestWindowStart > 60_000) {
    requestCount = 0;
    requestWindowStart = now;
  }
  if (requestCount >= MAX_REQUESTS_PER_MINUTE) {
    console.log(`[BinanceCandles] Rate limit reached (${MAX_REQUESTS_PER_MINUTE}/min), skipping`);
    return null;
  }
  requestCount++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      console.error(`[BinanceCandles] Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const CANDLE_RETRY_ATTEMPTS = 2;
const CANDLE_RETRY_DELAY_MS = 1000;

async function fetchCandles(coinId: string, timeframe: TimeframeKey): Promise<BinanceCandle[]> {
  const symbol = COIN_TO_BINANCE_SYMBOL[coinId.toLowerCase()];
  if (!symbol) return [];

  const config = TIMEFRAME_CONFIG[timeframe];

  const url = `${BINANCE_BASE_URL}/klines?symbol=${symbol}&interval=${config.interval}&limit=${config.maxCandles}`;

  for (let attempt = 1; attempt <= CANDLE_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await rateLimitedFetch(url);
      if (!response || !response.ok) {
        if (response) {
          const errText = await response.text();
          console.error(`[BinanceCandles] ${symbol} ${timeframe} attempt ${attempt}/${CANDLE_RETRY_ATTEMPTS}: ${response.status} ${errText}`);
        }
        if (attempt < CANDLE_RETRY_ATTEMPTS) {
          await sleep(CANDLE_RETRY_DELAY_MS);
          continue;
        }
        return [];
      }

      const data = await response.json();
      const candles = data.map((kline: any[]) => ({
        timestamp: kline[0],
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
      }));
      return candles.slice(-config.maxCandles);
    } catch (error) {
      console.error(`[BinanceCandles] Fetch error ${coinId} ${timeframe} attempt ${attempt}/${CANDLE_RETRY_ATTEMPTS}:`, error instanceof Error ? error.message : error);
      if (attempt < CANDLE_RETRY_ATTEMPTS) {
        await sleep(CANDLE_RETRY_DELAY_MS);
        continue;
      }
      return [];
    }
  }
  return [];
}

export async function refreshCandlesForCoin(coinId: string, timeframe: TimeframeKey): Promise<BinanceCandle[]> {
  const now = Date.now();
  const config = TIMEFRAME_CONFIG[timeframe];

  if (!lastFetchTime.has(coinId)) lastFetchTime.set(coinId, new Map());
  const coinTimes = lastFetchTime.get(coinId)!;
  const lastTime = coinTimes.get(timeframe) || 0;

  if (now - lastTime < config.refreshMs) {
    return getCachedCandles(coinId, timeframe);
  }

  const candles = await fetchCandles(coinId, timeframe);
  if (candles.length > 0) {
    if (!candleCache.has(coinId)) candleCache.set(coinId, new Map());
    candleCache.get(coinId)!.set(timeframe, candles);
    coinTimes.set(timeframe, now);
  }

  return candles;
}

export function getCachedCandles(coinId: string, timeframe: TimeframeKey): BinanceCandle[] {
  return candleCache.get(coinId)?.get(timeframe) || [];
}

export async function initializeAllCandles(coinIds: string[]): Promise<void> {
  let fetchedCount = 0;
  const eligibleCoins = coinIds.filter(id => COIN_TO_BINANCE_SYMBOL[id.toLowerCase()]);
  const initCoins = eligibleCoins.slice(0, 15);

  console.log(`[BinanceCandles] Initializing 5m candles for ${initCoins.length} coins...`);

  for (const coinId of initCoins) {
    const candles = await fetchCandles(coinId, '5m');
    if (candles.length > 0) {
      if (!candleCache.has(coinId)) candleCache.set(coinId, new Map());
      candleCache.get(coinId)!.set('5m', candles);
      if (!lastFetchTime.has(coinId)) lastFetchTime.set(coinId, new Map());
      lastFetchTime.get(coinId)!.set('5m', Date.now());
      fetchedCount++;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  console.log(`[BinanceCandles] Init complete: ${fetchedCount} coin datasets loaded (5m only)`);
}

export async function refreshAllCandles(coinIds: string[]): Promise<void> {
  const now = Date.now();
  const config = TIMEFRAME_CONFIG['5m'];
  let refreshed = 0;

  for (const coinId of coinIds) {
    const symbol = COIN_TO_BINANCE_SYMBOL[coinId.toLowerCase()];
    if (!symbol) continue;

    const lastTime = lastFetchTime.get(coinId)?.get('5m') || 0;
    if (now - lastTime < config.refreshMs) continue;

    const candles = await fetchCandles(coinId, '5m');
    if (candles.length > 0) {
      if (!candleCache.has(coinId)) candleCache.set(coinId, new Map());
      candleCache.get(coinId)!.set('5m', candles);
      if (!lastFetchTime.has(coinId)) lastFetchTime.set(coinId, new Map());
      lastFetchTime.get(coinId)!.set('5m', now);
      refreshed++;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  if (refreshed > 0) {
    console.log(`[BinanceCandles] Refreshed ${refreshed} datasets`);
  }
}

export function getBinanceSymbol(coinId: string): string | null {
  return COIN_TO_BINANCE_SYMBOL[coinId.toLowerCase()] || null;
}

export async function forceRefreshCandles(coinId: string, timeframe: TimeframeKey): Promise<BinanceCandle[]> {
  const candles = await fetchCandles(coinId, timeframe);
  if (candles.length > 0) {
    if (!candleCache.has(coinId)) candleCache.set(coinId, new Map());
    candleCache.get(coinId)!.set(timeframe, candles);
    if (!lastFetchTime.has(coinId)) lastFetchTime.set(coinId, new Map());
    lastFetchTime.get(coinId)!.set(timeframe, Date.now());
  }
  return candles;
}

export async function forceRefreshCandles5mAll(coinIds: string[]): Promise<{ refreshed: number; failed: string[]; cached: number }> {
  let refreshed = 0;
  const failed: string[] = [];
  let cached = 0;
  
  for (const coinId of coinIds) {
    const symbol = COIN_TO_BINANCE_SYMBOL[coinId.toLowerCase()];
    if (!symbol) continue;
    
    const candles = await fetchCandles(coinId, '5m');
    if (candles.length > 0) {
      if (!candleCache.has(coinId)) candleCache.set(coinId, new Map());
      candleCache.get(coinId)!.set('5m', candles);
      if (!lastFetchTime.has(coinId)) lastFetchTime.set(coinId, new Map());
      lastFetchTime.get(coinId)!.set('5m', Date.now());
      refreshed++;
    } else {
      const existing = getCachedCandles(coinId, '5m');
      if (existing.length > 0) {
        cached++;
      } else {
        failed.push(symbol.replace('USDT', ''));
      }
    }
    await sleep(50);
  }
  
  return { refreshed, failed, cached };
}

export function getCandleFreshnessMs(coinId: string, timeframe: TimeframeKey): number {
  const lastTime = lastFetchTime.get(coinId)?.get(timeframe) || 0;
  if (lastTime === 0) return Infinity;
  return Date.now() - lastTime;
}

export function getCandleCacheStats(): { coins: number; timeframes: Record<TimeframeKey, number>; requestsUsed: number } {
  const stats: Record<TimeframeKey, number> = { '1m': 0, '5m': 0, '15m': 0, '1h': 0 };
  for (const [, tfMap] of candleCache) {
    for (const [tf, candles] of tfMap) {
      if (candles.length > 0) stats[tf as TimeframeKey]++;
    }
  }
  return { coins: candleCache.size, timeframes: stats, requestsUsed: requestCount };
}
