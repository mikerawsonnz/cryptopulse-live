import type { LiquidationData, CryptoData } from "@shared/schema";

const BINANCE_FUTURES_URL = "https://fapi.binance.com/fapi/v1";

let cachedLiquidations: LiquidationData[] = [];
let lastFetch: number = 0;
const CACHE_DURATION = 30000;

const TRACKED_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];

export async function getLiquidations(): Promise<LiquidationData[]> {
  const now = Date.now();
  
  if (cachedLiquidations.length > 0 && now - lastFetch < CACHE_DURATION) {
    return cachedLiquidations;
  }

  try {
    console.log("[Liquidations] Fetching from Binance Futures...");
    
    const allLiquidations: LiquidationData[] = [];
    
    for (const symbol of TRACKED_SYMBOLS) {
      try {
        const response = await fetch(
          `${BINANCE_FUTURES_URL}/allForceOrders?symbol=${symbol}&limit=20`,
          {
            headers: {
              "Accept": "application/json",
            },
          }
        );

        if (!response.ok) {
          console.error(`[Liquidations] ${symbol} error:`, response.status);
          continue;
        }

        const orders = await response.json();
        
        for (const order of orders) {
          const price = parseFloat(order.price);
          const qty = parseFloat(order.origQty);
          const usdValue = price * qty;
          
          if (usdValue >= 10000) {
            allLiquidations.push({
              symbol: order.symbol,
              side: order.side.toLowerCase() as "buy" | "sell",
              price,
              quantity: qty,
              usdValue,
              time: order.time,
              type: order.side === "BUY" ? "short" : "long",
            });
          }
        }
      } catch (err) {
        console.error(`[Liquidations] Error fetching ${symbol}:`, err);
      }
    }
    
    const sorted = allLiquidations
      .sort((a, b) => b.time - a.time)
      .slice(0, 50);
    
    cachedLiquidations = sorted;
    lastFetch = now;
    
    console.log(`[Liquidations] Found ${sorted.length} significant liquidations`);
    return sorted;
  } catch (error) {
    console.error("[Liquidations] Fetch error:", error);
    return cachedLiquidations;
  }
}

export function calculateLiquidationClusters(liquidations: LiquidationData[]): {
  symbol: string;
  longLiquidationLevel: number;
  shortLiquidationLevel: number;
  totalLongLiquidated: number;
  totalShortLiquidated: number;
  volatilityTrap: "high" | "medium" | "low";
}[] {
  const bySymbol = new Map<string, LiquidationData[]>();
  
  for (const liq of liquidations) {
    const existing = bySymbol.get(liq.symbol) || [];
    existing.push(liq);
    bySymbol.set(liq.symbol, existing);
  }
  
  const clusters = [];
  
  for (const [symbol, liqs] of Array.from(bySymbol.entries())) {
    const longs = liqs.filter((l: LiquidationData) => l.type === "long");
    const shorts = liqs.filter((l: LiquidationData) => l.type === "short");
    
    const avgLongPrice = longs.length > 0
      ? longs.reduce((sum: number, l: LiquidationData) => sum + l.price, 0) / longs.length
      : 0;
    const avgShortPrice = shorts.length > 0
      ? shorts.reduce((sum: number, l: LiquidationData) => sum + l.price, 0) / shorts.length
      : 0;
    
    const totalLongUsd = longs.reduce((sum: number, l: LiquidationData) => sum + l.usdValue, 0);
    const totalShortUsd = shorts.reduce((sum: number, l: LiquidationData) => sum + l.usdValue, 0);
    
    const totalLiquidated = totalLongUsd + totalShortUsd;
    let volatilityTrap: "high" | "medium" | "low" = "low";
    
    if (totalLiquidated > 1000000) volatilityTrap = "high";
    else if (totalLiquidated > 100000) volatilityTrap = "medium";
    
    clusters.push({
      symbol: symbol.replace("USDT", ""),
      longLiquidationLevel: avgLongPrice,
      shortLiquidationLevel: avgShortPrice,
      totalLongLiquidated: totalLongUsd,
      totalShortLiquidated: totalShortUsd,
      volatilityTrap,
    });
  }
  
  return clusters;
}

export function calculateVolatilityZones(cryptos: CryptoData[]): {
  symbol: string;
  currentPrice: number;
  support: number;
  resistance: number;
  volatility24h: number;
  riskLevel: "high" | "medium" | "low";
  priceRange: string;
}[] {
  const zones = [];
  
  const tracked = cryptos.filter(c => 
    ["btc", "eth", "sol", "xrp", "doge", "bnb"].includes(c.symbol.toLowerCase())
  );
  
  for (const crypto of tracked) {
    const sparkline = crypto.sparkline_in_7d?.price || [];
    if (sparkline.length < 24) continue;
    
    const last24h = sparkline.slice(-24);
    const high24h = Math.max(...last24h);
    const low24h = Math.min(...last24h);
    const current = crypto.current_price;
    
    const volatility = ((high24h - low24h) / current) * 100;
    
    const support = low24h * 0.98;
    const resistance = high24h * 1.02;
    
    let riskLevel: "high" | "medium" | "low" = "low";
    if (volatility > 8) riskLevel = "high";
    else if (volatility > 4) riskLevel = "medium";
    
    const distToSupport = ((current - support) / current) * 100;
    const distToResistance = ((resistance - current) / current) * 100;
    
    zones.push({
      symbol: crypto.symbol.toUpperCase(),
      currentPrice: current,
      support,
      resistance,
      volatility24h: volatility,
      riskLevel,
      priceRange: `$${support.toFixed(2)} - $${resistance.toFixed(2)}`,
    });
  }
  
  return zones.sort((a, b) => b.volatility24h - a.volatility24h);
}

export function getCachedLiquidations(): LiquidationData[] {
  return cachedLiquidations;
}
