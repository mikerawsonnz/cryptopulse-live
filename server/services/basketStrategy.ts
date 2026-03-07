import { getCurrentTop15Symbols, refreshCandlesForCoin, forceRefreshCandles, type BinanceCandle, type TimeframeKey } from "./binanceCandles";

import { hlPreflightCheck } from "./hyperliquid/adapter";
import { getPortfolioState } from "./paperTrading";
import { basketMetaStats, type AITradeSignal, type BasketMetaStats } from "@shared/schema";
import { db } from "../db";
import { lt } from "drizzle-orm";
import { desc } from "drizzle-orm";

const MOMENTUM_LOOKBACK = 6;
const ATR_PERIOD = 20;
const ATR_SL_MULTIPLIER = 3;
const ATR_TP_MULTIPLIER = 4.5;
const BASKET_SIZE = 3;
const MAX_BASKET_PERCENT = 0.40;
const REBALANCE_INTERVAL_MS = 30 * 60 * 1000;
const LAYER_SIZES = [0.05, 0.04, 0.03, 0.02, 0.02];
const MAX_LAYERS = LAYER_SIZES.length;

export interface MomentumRanking {
  symbol: string;
  coinId: string;
  coinName: string;
  price: number;
  momentum30m: number;
  lastCandleDirection: number;
  confirmed: boolean;
  atr: number;
  atrPercent: number;
}

export type ConfirmationMode = '5m' | '1m';

export interface BasketState {
  longBasket: MomentumRanking[];
  shortBasket: MomentumRanking[];
  rankings: MomentumRanking[];
  lastRebalance: number;
  nextRebalance: number;
  totalBudget: number;
  pendingLongs: Set<string>;
  pendingShorts: Set<string>;
  symbolLayers: Map<string, number>;
  confirmationMode: ConfirmationMode;
}

let basketState: BasketState = {
  longBasket: [],
  shortBasket: [],
  rankings: [],
  lastRebalance: 0,
  nextRebalance: 0,
  totalBudget: 0,
  pendingLongs: new Set(),
  pendingShorts: new Set(),
  symbolLayers: new Map(),
  confirmationMode: '1m',
};

const SYMBOL_TO_COINID: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple",
  BNB: "binancecoin", DOGE: "dogecoin", TRX: "tron", SUI: "sui",
  ADA: "cardano", AVAX: "avalanche-2", BCH: "bitcoin-cash", ZEC: "zcash",
  PEPE: "pepe", LINK: "chainlink", AAVE: "aave", LTC: "litecoin",
  UNI: "uniswap", INJ: "injective", NEAR: "near", APT: "aptos",
  ARB: "arbitrum", OP: "optimism", DOT: "polkadot", ATOM: "cosmos",
  XLM: "stellar", HBAR: "hedera", FIL: "filecoin", RENDER: "render",
  HYPE: "hyperliquid", ENSO: "enso", SAHARA: "sahara-ai",
};

function calculateATR(candles: BinanceCandle[], period: number = ATR_PERIOD): number {
  if (candles.length < period + 1) return 0;
  const recent = candles.slice(-period - 1);
  let atrSum = 0;
  for (let i = 1; i < recent.length; i++) {
    const tr = Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i - 1].close),
      Math.abs(recent[i].low - recent[i - 1].close)
    );
    atrSum += tr;
  }
  return atrSum / period;
}

export async function scanMomentum(): Promise<MomentumRanking[]> {
  const top15 = getCurrentTop15Symbols();
  if (top15.size === 0) {
    console.warn(`[Basket] scanMomentum: No top 15 symbols available`);
    return [];
  }

  const rankings: MomentumRanking[] = [];
  const skipped: string[] = [];

  for (const symbol of top15) {
    const coinId = SYMBOL_TO_COINID[symbol.toUpperCase()];
    if (!coinId) {
      skipped.push(`${symbol}(no coinId)`);
      continue;
    }

    const candles = await refreshCandlesForCoin(coinId, "5m");
    if (candles.length < MOMENTUM_LOOKBACK + 2) {
      skipped.push(`${symbol}(${candles.length} candles)`);
      continue;
    }

    const currentClose = candles[candles.length - 1].close;
    const lookbackClose = candles[candles.length - 1 - MOMENTUM_LOOKBACK].close;
    const momentum30m = ((currentClose - lookbackClose) / lookbackClose) * 100;

    const lastCandle = candles[candles.length - 1];
    const lastCandleDirection = lastCandle.close - lastCandle.open;

    const confirmed = (momentum30m > 0 && lastCandleDirection > 0) ||
                      (momentum30m < 0 && lastCandleDirection < 0);

    const atr = calculateATR(candles);
    const atrPercent = atr / currentClose * 100;

    rankings.push({
      symbol: symbol.toUpperCase(),
      coinId,
      coinName: symbol.toUpperCase(),
      price: currentClose,
      momentum30m,
      lastCandleDirection,
      confirmed,
      atr,
      atrPercent,
    });
  }

  rankings.sort((a, b) => b.momentum30m - a.momentum30m);
  
  const skipMsg = skipped.length > 0 ? ` (${skipped.length} skipped: ${skipped.join(', ')})` : '';
  console.log(`[Basket] Momentum scan: ${rankings.length} coins ranked${skipMsg}`);
  
  return rankings;
}

function buildSignalForCandidate(candidate: MomentumRanking, side: "long" | "short", layerBudget: number, layerNum: number): AITradeSignal {
  const stopDistance = candidate.atr * ATR_SL_MULTIPLIER;
  const tpDistance = candidate.atr * ATR_TP_MULTIPLIER;

  let stopLoss: number;
  let takeProfit: number;

  if (side === "long") {
    stopLoss = candidate.price - stopDistance;
    takeProfit = candidate.price + tpDistance;
  } else {
    stopLoss = candidate.price + stopDistance;
    takeProfit = candidate.price - tpDistance;
  }

  const slPercent = (stopDistance / candidate.price * 100).toFixed(2);
  const tpPercent = (tpDistance / candidate.price * 100).toFixed(2);
  const layerPct = (LAYER_SIZES[layerNum - 1] * 100).toFixed(0);

  const regime = getMarketRegime();
  const regimeMult = side === "long" ? regime.longMultiplier : regime.shortMultiplier;

  return {
    symbol: candidate.symbol,
    coinName: candidate.coinName,
    action: side === "long" ? "buy" : "sell",
    side,
    confidence: Math.min(0.95, 0.65 + Math.abs(candidate.momentum30m) * 0.1),
    targetEntry: candidate.price,
    stopLoss,
    takeProfit,
    riskRewardRatio: 1.5,
    positionSize: layerBudget,
    reasoning: `[Basket ${side.toUpperCase()} L${layerNum}] 30m momentum: ${candidate.momentum30m.toFixed(3)}% | ATR: ${candidate.atrPercent.toFixed(3)}% | SL: ${slPercent}% | TP: ${tpPercent}% | Layer ${layerNum}/${MAX_LAYERS} (${layerPct}%) | ${regime.regime} ${regimeMult}×`,
    signalMode: "basket",
    signals: {
      priceChange24h: candidate.momentum30m,
      atr: candidate.atr,
      regime: regime.regime,
      volRegime: regime.volRegime,
      momNorm: regime.momNorm,
      regimeMultiplier: regimeMult,
    },
    timestamp: new Date().toISOString(),
    openReason: `Basket | ${side.toUpperCase()} L${layerNum} | Mom: ${candidate.momentum30m.toFixed(3)}% | ${regime.regime} ${regimeMult}× | ${candidate.symbol}`,
  };
}

function getCurrentBasketExposure(): number {
  const portfolio = getPortfolioState();
  return portfolio.positions.reduce((sum, p) => sum + (p.quantity * p.currentPrice), 0);
}

function canAddLayer(layerBudget: number): boolean {
  const portfolio = getPortfolioState();
  const maxBudget = portfolio.equity * MAX_BASKET_PERCENT;
  const currentExposure = getCurrentBasketExposure();
  return (currentExposure + layerBudget) <= maxBudget;
}

export async function generateBasketSignals(): Promise<AITradeSignal[]> {
  const rankings = await scanMomentum();
  if (rankings.length < BASKET_SIZE * 2) {
    console.log(`[Basket] Insufficient momentum data: only ${rankings.length} coins ranked (need ${BASKET_SIZE * 2})`);
    return [];
  }

  const regime = getMarketRegime();
  const portfolio = getPortfolioState();
  const totalBudget = portfolio.equity * MAX_BASKET_PERCENT;

  console.log(`[Basket] Regime: ${regime.regime} (MOM=${regime.momNorm.toFixed(3)}, ${regime.volRegime}) — long ${regime.longMultiplier}×, short ${regime.shortMultiplier}×, scaleIn=${regime.scaleInEnabled ? (regime.scaleInDirection === 'none' ? 'BOTH' : regime.scaleInDirection) : 'OFF'}`);

  const longCandidates: MomentumRanking[] = [];
  for (let i = 0; i < rankings.length && longCandidates.length < BASKET_SIZE; i++) {
    const r = rankings[i];
    if (r.momentum30m <= 0) break;
    const layerBudget = portfolio.equity * LAYER_SIZES[0] * regime.longMultiplier;
    const pf = hlPreflightCheck(r.symbol, layerBudget, r.price);
    if (!pf.ok) {
      console.log(`[Basket] ${r.symbol} long skipped in selection — ${pf.reason}, trying next`);
      continue;
    }
    longCandidates.push(r);
  }
  const shortCandidates: MomentumRanking[] = [];
  for (let i = rankings.length - 1; i >= 0 && shortCandidates.length < BASKET_SIZE; i--) {
    const r = rankings[i];
    if (r.momentum30m >= 0) break;
    const layerBudget = portfolio.equity * LAYER_SIZES[0] * regime.shortMultiplier;
    const pf = hlPreflightCheck(r.symbol, layerBudget, r.price);
    if (!pf.ok) {
      console.log(`[Basket] ${r.symbol} short skipped in selection — ${pf.reason}, trying next`);
      continue;
    }
    shortCandidates.push(r);
  }

  const pendingLongs = new Set(longCandidates.map(r => r.symbol));
  const pendingShorts = new Set(shortCandidates.map(r => r.symbol));

  const symbolLayers = new Map<string, number>();
  for (const c of longCandidates) {
    const existingCount = portfolio.positions.filter(
      p => p.symbol.toUpperCase() === c.symbol && p.side === "long"
    ).length;
    symbolLayers.set(c.symbol, existingCount);
    if (existingCount > 0) pendingLongs.delete(c.symbol);
  }
  for (const c of shortCandidates) {
    const existingCount = portfolio.positions.filter(
      p => p.symbol.toUpperCase() === c.symbol && p.side === "short"
    ).length;
    symbolLayers.set(c.symbol, Math.max(symbolLayers.get(c.symbol) || 0, existingCount));
    if (existingCount > 0) pendingShorts.delete(c.symbol);
  }

  console.log(`[Basket] Budget: $${totalBudget.toFixed(2)} total (40% of $${portfolio.equity.toFixed(2)})`);
  console.log(`[Basket] Long candidates (${longCandidates.length}): ${longCandidates.map(r => `${r.symbol}(${r.momentum30m.toFixed(3)}%)`).join(', ')}`);
  console.log(`[Basket] Short candidates (${shortCandidates.length}): ${shortCandidates.map(r => `${r.symbol}(${r.momentum30m.toFixed(3)}%)`).join(', ')}`);
  console.log(`[Basket] All candidates pending 2×1m confirmation — no immediate entries`);
  if (pendingLongs.size > 0) console.log(`[Basket] Pending 2×1m confirm (long): ${[...pendingLongs].join(', ')}`);
  if (pendingShorts.size > 0) console.log(`[Basket] Pending 2×1m confirm (short): ${[...pendingShorts].join(', ')}`);

  basketState = {
    longBasket: longCandidates,
    shortBasket: shortCandidates,
    rankings,
    lastRebalance: Date.now(),
    nextRebalance: Date.now() + REBALANCE_INTERVAL_MS,
    totalBudget,
    pendingLongs,
    pendingShorts,
    symbolLayers,
    confirmationMode: '1m',
  };

  return [];
}

export async function checkScaleInConfirmations(): Promise<AITradeSignal[]> {
  if (basketState.lastRebalance === 0) return [];

  const regime = getMarketRegime();

  const signals: AITradeSignal[] = [];
  const portfolio = getPortfolioState();
  const maxBudget = portfolio.equity * MAX_BASKET_PERCENT;
  const currentExposure = getCurrentBasketExposure();

  if (currentExposure >= maxBudget) return [];

  const timeframe: TimeframeKey = basketState.confirmationMode === '1m' ? '1m' : '5m';

  let allCandidates = [
    ...basketState.longBasket.map(r => ({ ...r, side: "long" as const })),
    ...basketState.shortBasket.map(r => ({ ...r, side: "short" as const })),
  ];

  if (!regime.scaleInEnabled) {
    return [];
  } else if (regime.scaleInDirection !== 'none') {
    allCandidates = allCandidates.filter(c => c.side === regime.scaleInDirection);
  }

  console.log(`[Basket] Scale-in check: ${allCandidates.length} candidates [${allCandidates.map(c => `${c.symbol}(${c.side})`).join(', ')}]`);

  for (const entry of allCandidates) {
    const { symbol, side } = entry;
    const coinId = SYMBOL_TO_COINID[symbol];
    if (!coinId) { console.log(`[Basket] ${symbol}: no coinId mapping — skipped`); continue; }

    let candles: BinanceCandle[];
    try {
      const timeoutPromise = new Promise<BinanceCandle[]>((_, reject) => 
        setTimeout(() => reject(new Error(`Timeout fetching ${symbol} candles`)), 5000)
      );
      candles = await Promise.race([forceRefreshCandles(coinId, timeframe as TimeframeKey), timeoutPromise]);
    } catch (err) {
      console.warn(`[Basket] Scale-in: ${symbol} candle fetch failed: ${err instanceof Error ? err.message : err}`);
      candles = await refreshCandlesForCoin(coinId, timeframe as TimeframeKey);
    }
    if (candles.length < 4) continue;

    const lastCandle = candles[candles.length - 1];
    const now = Date.now();
    const lastCandleAge = now - lastCandle.timestamp;
    const isLastCandleForming = lastCandleAge < 60_000;
    const skipCount = isLastCandleForming ? 1 : 0;
    const c1 = candles[candles.length - 1 - skipCount - 0];
    const c2 = candles[candles.length - 1 - skipCount - 1];
    const dir1 = c1.close - c1.open;
    const dir2 = c2.close - c2.open;
    const c1Time = new Date(c1.timestamp).toISOString().slice(11, 16);
    const c2Time = new Date(c2.timestamp).toISOString().slice(11, 16);
    const isConfirmed = side === "long"
      ? (dir1 > 0 && dir2 > 0)
      : (dir1 < 0 && dir2 < 0);

    if (!isConfirmed) {
      const c1Color = dir1 > 0 ? 'GREEN' : 'RED';
      const c2Color = dir2 > 0 ? 'GREEN' : 'RED';
      console.log(`[Basket] ${symbol} ${side} 2×1m NOT confirmed: c1=${c1Color}(${dir1.toFixed(6)})@${c1Time} c2=${c2Color}(${dir2.toFixed(6)})@${c2Time} — need both ${side === 'long' ? 'GREEN' : 'RED'}`);
      continue;
    }

    const currentLayers = basketState.symbolLayers.get(symbol) || 0;
    const hasPosition = portfolio.positions.some(
      p => p.symbol.toUpperCase() === symbol && p.side === side
    );
    const isPending = side === "long"
      ? basketState.pendingLongs.has(symbol)
      : basketState.pendingShorts.has(symbol);

    if (!hasPosition && (isPending || currentLayers > 0)) {
      const regimeMult = side === "long" ? regime.longMultiplier : regime.shortMultiplier;
      const layerBudget = portfolio.equity * LAYER_SIZES[0] * regimeMult;
      if (!canAddLayer(layerBudget)) continue;

      const preflight = hlPreflightCheck(symbol, layerBudget, c1.close);
      if (!preflight.ok) {
        console.log(`[Basket] ${symbol} ${side}: HL preflight fail — ${preflight.reason}`);
        continue;
      }

      const atrForSizing = timeframe === '1m' ? entry.atr : calculateATR(candles);
      const freshCandidate = { ...entry, price: c1.close, confirmed: true };
      freshCandidate.atr = atrForSizing;
      freshCandidate.atrPercent = freshCandidate.atr / freshCandidate.price * 100;

      signals.push(buildSignalForCandidate(freshCandidate, side, layerBudget, 1));
      basketState.symbolLayers.set(symbol, 1);
      if (side === "long") basketState.pendingLongs.delete(symbol);
      else basketState.pendingShorts.delete(symbol);
      const reason = isPending ? "pending confirmed" : "re-entry (position lost)";
      console.log(`[Basket] ${symbol} ${side} L1 CONFIRMED [${timeframe}] (${reason}) — opening first layer (5% × ${regimeMult}×)`);
    } else if (hasPosition && currentLayers < MAX_LAYERS) {
      if (side === "long") basketState.pendingLongs.delete(symbol);
      else basketState.pendingShorts.delete(symbol);

      const nextLayer = currentLayers + 1;
      const layerPct = LAYER_SIZES[Math.min(nextLayer - 1, LAYER_SIZES.length - 1)];
      const regimeMult = side === "long" ? regime.longMultiplier : regime.shortMultiplier;
      const layerBudget = portfolio.equity * layerPct * regimeMult;
      if (!canAddLayer(layerBudget)) continue;

      const preflight = hlPreflightCheck(symbol, layerBudget, c1.close);
      if (!preflight.ok) {
        console.log(`[Basket] ${symbol} ${side} L${nextLayer}: HL preflight fail — ${preflight.reason}`);
        continue;
      }

      const atrForSizing = timeframe === '1m' ? entry.atr : calculateATR(candles);
      const freshCandidate = { ...entry, price: c1.close, confirmed: true };
      freshCandidate.atr = atrForSizing;
      freshCandidate.atrPercent = freshCandidate.atr / freshCandidate.price * 100;

      signals.push(buildSignalForCandidate(freshCandidate, side, layerBudget, nextLayer));
      basketState.symbolLayers.set(symbol, nextLayer);
      console.log(`[Basket] ${symbol} ${side} L${nextLayer} scale-in [${timeframe}] — adding layer (${(layerPct * 100).toFixed(0)}% × ${regimeMult}× of equity)`);
    }
  }

  return signals;
}

export function getBasketState(): BasketState {
  return basketState;
}

export function resetBasketState(): void {
  basketState = {
    longBasket: [],
    shortBasket: [],
    rankings: [],
    lastRebalance: 0,
    nextRebalance: 0,
    totalBudget: 0,
    pendingLongs: new Set(),
    pendingShorts: new Set(),
    symbolLayers: new Map(),
    confirmationMode: '1m',
  };
  console.log("[Basket] Basket state fully reset");
}

export function onEntryFailed(symbol: string): void {
  const current = basketState.symbolLayers.get(symbol) || 0;
  if (current > 0) {
    basketState.symbolLayers.set(symbol, current - 1);
  }
  console.log(`[Basket] ${symbol}: entry failed — reverted layer count to ${Math.max(0, current - 1)}`);
}

export function onEntrySucceeded(symbol: string): void {
}

export function setConfirmationMode(_mode: ConfirmationMode): void {
  console.log(`[Basket] Confirmation mode locked to 1m — ignoring change request`);
}

export function getConfirmationMode(): ConfirmationMode {
  return basketState.confirmationMode;
}

export function getScaleInState(): Record<string, { layers: number; maxLayers: number; nextLayerPct: number | null }> {
  const result: Record<string, { layers: number; maxLayers: number; nextLayerPct: number | null }> = {};
  const portfolio = getPortfolioState();

  for (const [symbol, trackedLayers] of basketState.symbolLayers.entries()) {
    const actualPositions = portfolio.positions.filter(
      p => p.symbol.toUpperCase() === symbol
    ).length;
    const layers = Math.min(trackedLayers, actualPositions);
    if (layers !== trackedLayers) {
      basketState.symbolLayers.set(symbol, layers);
    }
    if (layers > 0) {
      const nextLayerPct = layers < MAX_LAYERS ? LAYER_SIZES[Math.min(layers, LAYER_SIZES.length - 1)] * 100 : null;
      result[symbol] = { layers, maxLayers: MAX_LAYERS, nextLayerPct };
    }
  }
  return result;
}

export function getSymbolsToClose(): { symbol: string; side: string }[] {
  if (basketState.lastRebalance === 0) return [];

  const currentLongSymbols = new Set(basketState.longBasket.map(r => r.symbol));
  const currentShortSymbols = new Set(basketState.shortBasket.map(r => r.symbol));

  const portfolio = getPortfolioState();
  const seen = new Set<string>();
  const toClose: { symbol: string; side: string }[] = [];

  for (const pos of portfolio.positions) {
    const sym = pos.symbol.toUpperCase();
    const key = `${sym}-${pos.side}`;
    if (seen.has(key)) continue;

    if (pos.side === "long" && !currentLongSymbols.has(sym)) {
      toClose.push({ symbol: sym, side: pos.side });
      seen.add(key);
    } else if (pos.side === "short" && !currentShortSymbols.has(sym)) {
      toClose.push({ symbol: sym, side: pos.side });
      seen.add(key);
    }
  }

  return toClose;
}

export function shouldRebalance(): boolean {
  if (basketState.lastRebalance === 0) return true;
  return Date.now() >= basketState.nextRebalance;
}

export function getRebalanceIntervalMs(): number {
  return REBALANCE_INTERVAL_MS;
}

const MOM_SUM_RANGE = 15;

let latestMetaStats: BasketMetaStats | null = null;

export type MarketRegime = 'BULLISH' | 'NEUTRAL' | 'BEARISH';
export type VolRegime = 'HIGH_VOL' | 'MED_VOL' | 'LOW_VOL';

export interface RegimeState {
  regime: MarketRegime;
  momNorm: number;
  atrAvg: number;
  volRegime: VolRegime;
  longMultiplier: number;
  shortMultiplier: number;
  scaleInEnabled: boolean;
  scaleInDirection: 'long' | 'short' | 'none';
  portfolioStopPercent: number;
}

const REGIME_BULLISH_THRESHOLD = 0.70;
const REGIME_BEARISH_THRESHOLD = 0.40;
const VOL_HIGH_THRESHOLD = 0.60;
const VOL_LOW_THRESHOLD = 0.40;

let cachedRegime: RegimeState | null = null;
let regimeCacheTime = 0;
const REGIME_CACHE_MS = 30_000;
let lastLoggedRegime: MarketRegime | null = null;

export function getMarketRegime(): RegimeState {
  const now = Date.now();
  if (cachedRegime && now - regimeCacheTime < REGIME_CACHE_MS) {
    return cachedRegime;
  }

  const meta = latestMetaStats;
  if (!meta) {
    cachedRegime = {
      regime: 'NEUTRAL',
      momNorm: 0.5,
      atrAvg: 0.4,
      volRegime: 'MED_VOL',
      longMultiplier: 1.0,
      shortMultiplier: 1.0,
      scaleInEnabled: true,
      scaleInDirection: 'none',
      portfolioStopPercent: 0.01,
    };
    regimeCacheTime = now;
    return cachedRegime;
  }

  const momNorm = meta.momSumNormalized;
  const atrAvg = meta.atrAvg;

  let regime: MarketRegime;
  let regimeLongMult: number;
  let regimeShortMult: number;
  let scaleInEnabled: boolean;
  let scaleInDirection: 'long' | 'short' | 'none';
  let portfolioStopPercent: number;

  if (momNorm >= REGIME_BULLISH_THRESHOLD) {
    regime = 'BULLISH';
    regimeLongMult = 1.0;
    regimeShortMult = 1.0;
    scaleInEnabled = true;
    scaleInDirection = 'long';
    portfolioStopPercent = 0.015;
  } else if (momNorm <= REGIME_BEARISH_THRESHOLD) {
    regime = 'BEARISH';
    regimeLongMult = 1.0;
    regimeShortMult = 1.0;
    scaleInEnabled = true;
    scaleInDirection = 'short';
    portfolioStopPercent = 0.015;
  } else {
    regime = 'NEUTRAL';
    regimeLongMult = 1.0;
    regimeShortMult = 1.0;
    scaleInEnabled = true;
    scaleInDirection = 'none';
    portfolioStopPercent = 0.01;
  }

  let volRegime: VolRegime;
  let volMult: number;

  if (atrAvg >= VOL_HIGH_THRESHOLD) {
    volRegime = 'HIGH_VOL';
    volMult = 1.0;
  } else if (atrAvg < VOL_LOW_THRESHOLD) {
    volRegime = 'LOW_VOL';
    volMult = 1.0;
  } else {
    volRegime = 'MED_VOL';
    volMult = 1.0;
  }

  const longMultiplier = parseFloat((regimeLongMult * volMult).toFixed(2));
  const shortMultiplier = parseFloat((regimeShortMult * volMult).toFixed(2));

  if (regime !== lastLoggedRegime) {
    console.log(`[REGIME] ${lastLoggedRegime || 'INIT'} → ${regime} (MOM=${momNorm.toFixed(3)}, ATR=${atrAvg.toFixed(3)}, vol=${volRegime}, longMult=${longMultiplier}×, shortMult=${shortMultiplier}×)`);
    lastLoggedRegime = regime;
  }

  cachedRegime = {
    regime,
    momNorm,
    atrAvg,
    volRegime,
    longMultiplier,
    shortMultiplier,
    scaleInEnabled,
    scaleInDirection,
    portfolioStopPercent,
  };
  regimeCacheTime = now;
  return cachedRegime;
}

function normalizeMomSum(sum: number): number {
  const clamped = Math.max(-MOM_SUM_RANGE, Math.min(MOM_SUM_RANGE, sum));
  return (clamped + MOM_SUM_RANGE) / (2 * MOM_SUM_RANGE);
}

export async function computeAndSaveMetaStats(): Promise<BasketMetaStats | null> {
  const rankings = basketState.rankings;
  if (rankings.length === 0) return null;

  const moms = rankings.map(r => r.momentum30m);
  const atrs = rankings.map(r => r.atrPercent);

  const momMax = Math.max(...moms);
  const momMin = Math.min(...moms);
  const momSum = moms.reduce((a, b) => a + b, 0);
  const momAvg = momSum / moms.length;
  const momSumNormalized = normalizeMomSum(momSum);

  const atrMax = Math.max(...atrs);
  const atrMin = Math.min(...atrs);
  const atrSum = atrs.reduce((a, b) => a + b, 0);
  const atrAvg = atrSum / atrs.length;

  try {
    const [saved] = await db.insert(basketMetaStats).values({
      momMax,
      momMin,
      momAvg,
      momSum,
      momSumNormalized,
      atrMax,
      atrMin,
      atrAvg,
      atrSum,
      coinCount: rankings.length,
    }).returning();

    latestMetaStats = saved;
    regimeCacheTime = 0;

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.delete(basketMetaStats).where(lt(basketMetaStats.createdAt, cutoff));

    console.log(`[MetaStats] Saved: MOM sum=${momSum.toFixed(3)} norm=${momSumNormalized.toFixed(3)} | ATR avg=${atrAvg.toFixed(3)} | ${rankings.length} coins`);

    return saved;
  } catch (error) {
    console.error("[MetaStats] Save error:", error);
    return null;
  }
}

export function getLatestMetaStats(): BasketMetaStats | null {
  return latestMetaStats;
}

export async function loadLatestMetaStats(): Promise<void> {
  try {
    const [latest] = await db.select().from(basketMetaStats).orderBy(desc(basketMetaStats.id)).limit(1);
    if (latest) {
      latestMetaStats = latest;
      regimeCacheTime = 0;
      console.log(`[MetaStats] Loaded latest from DB: MOM norm=${latest.momSumNormalized.toFixed(3)}`);
    }
  } catch (error) {
    console.error("[MetaStats] Load error:", error);
  }
}
