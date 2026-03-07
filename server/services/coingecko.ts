import type { CryptoData } from "@shared/schema";

// CoinGecko API configuration
// Demo keys use api.coingecko.com, Pro keys use pro-api.coingecko.com
// Pro keys typically have "pro" in the environment variable name or are explicitly configured
const apiKey = process.env.COINGECKO_API_KEY || "";
const isProKey = process.env.COINGECKO_IS_PRO === "true"; // Must be explicitly set for Pro access
const COINGECKO_BASE_URL = isProKey 
  ? "https://pro-api.coingecko.com/api/v3"
  : "https://api.coingecko.com/api/v3";
const API_KEY_HEADER = isProKey ? "x-cg-pro-api-key" : "x-cg-demo-api-key";

if (apiKey) {
  console.log(`[CoinGecko] Using ${isProKey ? 'Pro' : 'Demo'} API with API key`);
}

let cachedData: CryptoData[] | null = null;
let lastFetch: number = 0;
const CACHE_DURATION = 30000;


// OHLC data cache - 4H candles for each coin
export interface OHLCCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface OHLCCache {
  data: OHLCCandle[];
  lastFetch: number;
}

const ohlcCache: Map<string, OHLCCache> = new Map();
const OHLC_CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 hours (matches candle timeframe)

export async function getTopCryptos(): Promise<CryptoData[]> {
  const now = Date.now();
  
  if (cachedData && now - lastFetch < CACHE_DURATION) {
    console.log("[CoinGecko] Returning cached data");
    return cachedData;
  }

  try {
    console.log("[CoinGecko] Fetching fresh data...");
    
    const params = new URLSearchParams({
      vs_currency: "usd",
      order: "volume_desc",
      per_page: "30",
      page: "1",
      sparkline: "true",
      price_change_percentage: "24h,7d",
    });

    const apiKey = process.env.COINGECKO_API_KEY;
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    
    if (apiKey) {
      headers[API_KEY_HEADER] = apiKey;
    }

    const response = await fetch(
      `${COINGECKO_BASE_URL}/coins/markets?${params}`,
      { headers }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[CoinGecko] API error:", response.status, errorText);
      
      if (response.status === 429) {
        console.log("[CoinGecko] Rate limited, using cached data if available");
        if (cachedData) return cachedData;
      }
      
      throw new Error(`CoinGecko API error: ${response.status}`);
    }

    const data = await response.json();
    
    const cryptos: CryptoData[] = data.map((coin: any) => ({
      id: coin.id,
      symbol: coin.symbol,
      name: coin.name,
      image: coin.image,
      current_price: coin.current_price,
      market_cap: coin.market_cap,
      market_cap_rank: coin.market_cap_rank,
      total_volume: coin.total_volume,
      price_change_percentage_24h: coin.price_change_percentage_24h,
      price_change_percentage_7d_in_currency: coin.price_change_percentage_7d_in_currency,
      sparkline_in_7d: coin.sparkline_in_7d,
      last_updated: coin.last_updated,
    }));

    cachedData = cryptos;
    lastFetch = now;
    
    console.log(`[CoinGecko] Fetched ${cryptos.length} cryptocurrencies`);
    return cryptos;
  } catch (error) {
    console.error("[CoinGecko] Fetch error:", error);
    
    if (cachedData) {
      console.log("[CoinGecko] Returning stale cached data");
      return cachedData;
    }
    
    throw error;
  }
}

export function getCachedCryptos(): CryptoData[] | null {
  return cachedData;
}

// Shared source of truth: Top 12 tradable cryptocurrencies by volume
// Excludes stablecoins, wrapped tokens, gold tokens, and USD derivatives
// Deduplicates by symbol
export interface TradableCrypto {
  id: string;
  symbol: string;
  name: string;
  volume: number;
}

const STABLECOINS = ['usdt', 'usdc', 'dai', 'busd', 'tusd', 'usdp', 'fdusd', 'usd1'];
const EXCLUDED_IDS = [
  'wrapped-solana', 
  'binance-bridged-usdt-bnb-smart-chain', 
  'tether-gold', 
  'pax-gold', 
  'usd1-wlfi',
  'weth',
  'wbnb',
  'wrapped-bitcoin',
  'l2-standard-bridged-weth-base'
];

export async function getTop12TradableCryptos(): Promise<TradableCrypto[]> {
  const cryptos = await getTopCryptos();
  const seenSymbols = new Set<string>();
  
  const result = cryptos
    .filter(c => {
      const sym = c.symbol.toLowerCase();
      if (STABLECOINS.includes(sym) || EXCLUDED_IDS.includes(c.id)) return false;
      if (seenSymbols.has(sym)) return false;
      seenSymbols.add(sym);
      return true;
    })
    .slice(0, 15)
    .map(c => ({
      id: c.id,
      symbol: c.symbol.toUpperCase(),
      name: c.name,
      volume: c.total_volume
    }));
  
  return result;
}

/**
 * Fetch 4H OHLC candles for a specific coin (up to 90 days)
 * CoinGecko returns 4H candles for 31-90 day requests
 * @param coinId - CoinGecko coin ID (e.g., "bitcoin", "ethereum")
 * @param days - Number of days (default 90 for full historical data)
 */
export async function get4HCandles(coinId: string, days: number = 90): Promise<OHLCCandle[]> {
  const now = Date.now();
  const cached = ohlcCache.get(coinId);
  
  // Return cached data if fresh
  if (cached && now - cached.lastFetch < OHLC_CACHE_DURATION) {
    console.log(`[CoinGecko] Returning cached 4H OHLC for ${coinId}`);
    return cached.data;
  }

  try {
    console.log(`[CoinGecko] Fetching 4H OHLC for ${coinId} (${days} days)...`);
    
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    
    if (apiKey) {
      headers[API_KEY_HEADER] = apiKey;
    }

    // CoinGecko OHLC endpoint
    // For Pro keys: use interval=hourly to get hourly candles (up to 90 days)
    // For Demo keys: auto-granularity (4-day intervals for 31+ days)
    const intervalParam = isProKey ? "&interval=hourly" : "";
    const response = await fetch(
      `${COINGECKO_BASE_URL}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}${intervalParam}`,
      { headers }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CoinGecko] OHLC error for ${coinId}:`, response.status, errorText);
      
      if (response.status === 429 && cached) {
        console.log(`[CoinGecko] Rate limited, using stale OHLC cache for ${coinId}`);
        return cached.data;
      }
      
      throw new Error(`CoinGecko OHLC API error: ${response.status}`);
    }

    const data = await response.json();
    
    // CoinGecko returns [timestamp, open, high, low, close] arrays
    const candles: OHLCCandle[] = data.map((candle: number[]) => ({
      timestamp: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
    }));

    // Cache the data
    ohlcCache.set(coinId, {
      data: candles,
      lastFetch: now,
    });
    
    console.log(`[CoinGecko] Fetched ${candles.length} 4H candles for ${coinId}`);
    return candles;
  } catch (error) {
    console.error(`[CoinGecko] OHLC fetch error for ${coinId}:`, error);
    
    // Return stale cache if available
    if (cached) {
      console.log(`[CoinGecko] Returning stale OHLC cache for ${coinId}`);
      return cached.data;
    }
    
    return [];
  }
}

/**
 * Fetch 4H OHLC data for multiple coins in parallel
 * Used for synthetic warm-up on startup
 */
export async function getMultiple4HCandles(coinIds: string[], days: number = 90): Promise<Map<string, OHLCCandle[]>> {
  console.log(`[CoinGecko] Fetching 4H OHLC for ${coinIds.length} coins...`);
  
  const results = new Map<string, OHLCCandle[]>();
  
  // Fetch with rate limiting (1 request per 1.5 seconds for free tier)
  for (const coinId of coinIds) {
    try {
      const candles = await get4HCandles(coinId, days);
      results.set(coinId, candles);
      
      // Rate limit delay (CoinGecko free tier: ~30 calls/min)
      await new Promise(resolve => setTimeout(resolve, 2100));
    } catch (error) {
      console.error(`[CoinGecko] Failed to fetch OHLC for ${coinId}:`, error);
      results.set(coinId, []);
    }
  }
  
  return results;
}

/**
 * Get cached 4H candles for a coin (if available)
 */
export function getCached4HCandles(coinId: string): OHLCCandle[] | null {
  const cached = ohlcCache.get(coinId);
  return cached ? cached.data : null;
}
