import { HL_BASE_URL, HL_MAINNET_URL, HL_WALLET_ADDRESS, HL_TO_SYMBOL, HL_TESTNET, type CoinMeta } from "./config";
import type { BinanceCandle, TimeframeKey } from "../binanceCandles";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 10_000;

async function hlPost(body: Record<string, unknown>, retries = MAX_RETRIES): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(`${HL_BASE_URL}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return await response.json();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt < retries) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[HL Info] Request failed (attempt ${attempt}/${retries}): ${msg} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[HL Info] Request FAILED after ${retries} attempts: ${msg}`);
        throw error;
      }
    }
  }
}

export interface HLAccountState {
  equity: number;
  balance: number;
  marginUsed: number;
  withdrawable: number;
  unrealizedPnl: number;
}

export async function getAccountState(address?: string): Promise<HLAccountState> {
  const user = address || HL_WALLET_ADDRESS;
  const data = await hlPost({ type: "clearinghouseState", user });

  const margin = data.marginSummary || data.crossMarginSummary || {};
  const equity = parseFloat(margin.accountValue || "0");
  const totalRawUsd = parseFloat(margin.totalRawUsd || "0");
  const unrealizedPnl = equity - totalRawUsd;
  return {
    equity,
    balance: totalRawUsd,
    marginUsed: parseFloat(margin.totalMarginUsed || "0"),
    withdrawable: parseFloat(data.withdrawable || "0"),
    unrealizedPnl,
  };
}

export interface HLPosition {
  coin: string;
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice: number | null;
  marginUsed: number;
  returnOnEquity: number;
}

export async function getOpenPositions(address?: string): Promise<HLPosition[]> {
  const user = address || HL_WALLET_ADDRESS;
  const data = await hlPost({ type: "clearinghouseState", user });

  const positions: HLPosition[] = [];
  const assetPositions = data.assetPositions || [];

  for (const ap of assetPositions) {
    const pos = ap.position;
    if (!pos) continue;

    const szi = parseFloat(pos.szi || "0");
    if (szi === 0) continue;

    const coin = pos.coin;
    const symbol = HL_TO_SYMBOL[coin] || coin;

    positions.push({
      coin,
      symbol,
      side: szi > 0 ? "long" : "short",
      size: Math.abs(szi),
      entryPrice: parseFloat(pos.entryPx || "0"),
      markPrice: parseFloat(pos.positionValue || "0") / Math.abs(szi) || 0,
      unrealizedPnl: parseFloat(pos.unrealizedPnl || "0"),
      leverage: parseFloat(pos.leverage?.value || "1"),
      liquidationPrice: pos.liquidationPx ? parseFloat(pos.liquidationPx) : null,
      marginUsed: parseFloat(pos.marginUsed || "0"),
      returnOnEquity: parseFloat(pos.returnOnEquity || "0"),
    });
  }

  return positions;
}

export interface HLFill {
  coin: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  time: number;
  fee: number;
  oid: number;
  cloid: string | null;
  crossed: boolean;
  closedPnl: number;
  hash: string;
}

export async function getUserFills(address?: string, startTime?: number): Promise<HLFill[]> {
  const user = address || HL_WALLET_ADDRESS;
  const body: Record<string, unknown> = { type: "userFills", user };
  if (startTime) {
    body.startTime = startTime;
  }

  const data = await hlPost(body);

  return (data || []).map((f: any) => ({
    coin: f.coin,
    symbol: HL_TO_SYMBOL[f.coin] || f.coin,
    side: f.side === "B" ? "buy" : "sell",
    price: parseFloat(f.px),
    size: parseFloat(f.sz),
    time: f.time,
    fee: parseFloat(f.fee || "0"),
    oid: f.oid,
    cloid: f.cloid || null,
    crossed: f.crossed || false,
    closedPnl: parseFloat(f.closedPnl || "0"),
    hash: f.hash || "",
  }));
}

export async function getAllMids(): Promise<Record<string, number>> {
  const data = await hlPost({ type: "allMids" });
  const result: Record<string, number> = {};
  for (const [coin, price] of Object.entries(data)) {
    const symbol = HL_TO_SYMBOL[coin] || coin;
    result[symbol] = parseFloat(price as string);
  }
  return result;
}

export async function getOpenOrders(address?: string): Promise<any[]> {
  const user = address || HL_WALLET_ADDRESS;
  const data = await hlPost({ type: "openOrders", user });
  return data || [];
}

export async function getOrderStatus(address: string, oid: number): Promise<any> {
  const data = await hlPost({ type: "orderStatus", user: address || HL_WALLET_ADDRESS, oid });
  return data;
}

export async function getUserFunding(address?: string, startTime?: number): Promise<any[]> {
  const user = address || HL_WALLET_ADDRESS;
  const body: Record<string, unknown> = { type: "userFunding", user };
  if (startTime) body.startTime = startTime;
  const data = await hlPost(body);
  return data || [];
}

async function hlMainnetPost(body: Record<string, unknown>, retries = MAX_RETRIES): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(`${HL_MAINNET_URL}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return await response.json();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt < retries) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[HL Mainnet] Request failed (attempt ${attempt}/${retries}): ${msg} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[HL Mainnet] Request FAILED after ${retries} attempts: ${msg}`);
        throw error;
      }
    }
  }
}

const candleCache: Map<string, { candles: BinanceCandle[]; fetchedAt: number }> = new Map();
const CANDLE_CACHE_MS = 30_000;

export async function getHLCandles(
  coin: string,
  interval: TimeframeKey,
  numCandles: number = 30
): Promise<BinanceCandle[]> {
  const cacheKey = `${coin}:${interval}`;
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CANDLE_CACHE_MS) {
    return cached.candles;
  }

  const intervalMs: Record<TimeframeKey, number> = {
    '1m': 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '1h': 60 * 60_000,
  };

  const endTime = Date.now();
  const startTime = endTime - (numCandles + 2) * intervalMs[interval];

  try {
    const data = await hlMainnetPost({
      type: "candleSnapshot",
      req: { coin, interval, startTime, endTime },
    });

    if (!Array.isArray(data) || data.length === 0) {
      console.warn(`[HL Candles] No data for ${coin} ${interval}`);
      return cached?.candles || [];
    }

    const candles: BinanceCandle[] = data.map((c: any) => ({
      timestamp: c.t,
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
    }));

    const trimmed = candles.slice(-numCandles);
    candleCache.set(cacheKey, { candles: trimmed, fetchedAt: Date.now() });

    return trimmed;
  } catch (error) {
    console.error(`[HL Candles] Error fetching ${coin} ${interval}:`, error instanceof Error ? error.message : error);
    return cached?.candles || [];
  }
}

export async function forceRefreshHLCandles(
  coin: string,
  interval: TimeframeKey,
  numCandles: number = 30
): Promise<BinanceCandle[]> {
  candleCache.delete(`${coin}:${interval}`);
  return getHLCandles(coin, interval, numCandles);
}

let hlPriceCache: Map<string, number> = new Map();
let hlPriceFetchedAt = 0;
const PRICE_CACHE_MS = 3_000;

export async function getHLRealtimePrices(): Promise<Map<string, number>> {
  if (hlPriceCache.size > 0 && Date.now() - hlPriceFetchedAt < PRICE_CACHE_MS) {
    return hlPriceCache;
  }

  try {
    const data = await hlMainnetPost({ type: "allMids" });
    const priceMap = new Map<string, number>();

    for (const [coin, price] of Object.entries(data)) {
      const p = parseFloat(price as string);
      if (p <= 0 || isNaN(p)) continue;

      const symbol = HL_TO_SYMBOL[coin] || coin;
      priceMap.set(symbol.toLowerCase(), p);
    }

    if (priceMap.size > 0) {
      hlPriceCache = priceMap;
      hlPriceFetchedAt = Date.now();
    }
    return priceMap.size > 0 ? priceMap : hlPriceCache;
  } catch (error) {
    console.error("[HL Prices] Fetch error:", error instanceof Error ? error.message : error);
    return hlPriceCache;
  }
}
