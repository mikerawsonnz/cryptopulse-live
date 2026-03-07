import { getMultiple4HCandles, type OHLCCandle } from "./coingecko";
import { getModePerformance } from "./quantStrategy";
import { saveBacktestScores, loadBacktestScores } from "./mike1Persistence";
import { isHibernating, getSizeMultiplier } from "./modeManager";
import { getDivergenceRegime } from "./signals";
import { getShadowMike1Scores } from "./shadowTrading";
import { isShadowOverrideActive, getShadowOverride } from "./equityCurveManager";

const COIN_ID_TO_SYMBOL: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  solana: "SOL",
  binancecoin: "BNB",
  ripple: "XRP",
  dogecoin: "DOGE",
  tether: "USDT",
  "usd-coin": "USDC",
  tron: "TRX",
  "staked-ether": "STETH",
  cardano: "ADA",
  sui: "SUI",
  chainlink: "LINK",
  "bitcoin-cash": "BCH",
  litecoin: "LTC",
  avalanche: "AVAX",
  "avalanche-2": "AVAX",
  polkadot: "DOT",
  matic: "MATIC",
  uniswap: "UNI",
  stellar: "XLM",
  cosmos: "ATOM",
  near: "NEAR",
  aptos: "APT",
  arbitrum: "ARB",
  optimism: "OP",
  filecoin: "FIL",
  hedera: "HBAR",
  vechain: "VET",
  algorand: "ALGO",
  "internet-computer": "ICP",
  render: "RNDR",
  injective: "INJ",
  pepe: "PEPE",
  aave: "AAVE",
  "leo-token": "LEO",
  "wrapped-bitcoin": "WBTC",
  hyperliquid: "HYPE",
  zcash: "ZEC",
};

function getCryptoSymbol(coinId: string): string {
  return COIN_ID_TO_SYMBOL[coinId] || coinId.toUpperCase();
}

export interface BacktestTrade {
  strategy: 'meanReversion' | 'volExpansion' | 'pairsTrading';
  coinId: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnlPercent: number;
  rMultiple: number;
}

export interface StrategyMike1 {
  meanReversion: number;
  volExpansion: number;
  pairsTrading: number;
}

interface BacktestResult {
  trades: BacktestTrade[];
  sharpeRatio: number;
  ulcerIndex: number;
  mike1Score: number;
}

let warmupMike1Scores: StrategyMike1 | null = null;
let warmupComplete = false;
let warmupTrades: BacktestTrade[] = [];
let cached4HOHLCData: Map<string, OHLCCandle[]> = new Map();
let warmupFirstRunTimestamp: number = 0;

const processedCandles: Map<string, number> = new Map();

function getCandleTimestamp(candles: OHLCCandle[]): number {
  if (candles.length === 0) return 0;
  return candles[candles.length - 1].timestamp;
}

function hasProcessedCandle(coinId: string, strategy: string): boolean {
  const key = `${coinId}_${strategy}`;
  const candles = cached4HOHLCData.get(coinId);
  if (!candles || candles.length === 0) return false;
  const currentCandleTime = getCandleTimestamp(candles);
  const lastProcessed = processedCandles.get(key);
  return lastProcessed === currentCandleTime;
}

function markCandleProcessed(coinId: string, strategy: string): void {
  const key = `${coinId}_${strategy}`;
  const candles = cached4HOHLCData.get(coinId);
  if (!candles || candles.length === 0) return;
  const currentCandleTime = getCandleTimestamp(candles);
  processedCandles.set(key, currentCandleTime);
}

function detectVolatilitySpike(): boolean {
  const btcCandles = cached4HOHLCData.get('bitcoin');
  if (!btcCandles || btcCandles.length < 50) return false;
  
  const returns: number[] = [];
  for (let i = 1; i < btcCandles.length; i++) {
    returns.push((btcCandles[i].close - btcCandles[i-1].close) / btcCandles[i-1].close);
  }
  
  const recentReturns = returns.slice(-6);
  const historicalReturns = returns.slice(-50);
  
  const recentVol = Math.sqrt(recentReturns.reduce((sum, r) => sum + r * r, 0) / recentReturns.length);
  const historicalVol = Math.sqrt(historicalReturns.reduce((sum, r) => sum + r * r, 0) / historicalReturns.length);
  
  if (historicalVol > 0 && recentVol > historicalVol * 3.0) {
    console.log(`[VOLATILITY SPIKE] 3x detected: recent=${(recentVol*100).toFixed(2)}% vs avg=${(historicalVol*100).toFixed(2)}%. Forcing Mean Reversion.`);
    return true;
  }
  return false;
}

export function calculate4HATR(candles: OHLCCandle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || candles[i].open;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    atrSum += tr;
  }
  
  return atrSum / period;
}

export function calculate4HBollingerBands(candles: OHLCCandle[], period: number = 20, stdDev: number = 2): {
  upper: number;
  middle: number;
  lower: number;
  zScore: number;
} | null {
  if (candles.length < period) return null;
  
  const closes = candles.slice(-period).map(c => c.close);
  const sum = closes.reduce((a, b) => a + b, 0);
  const mean = sum / period;
  
  const squaredDiffs = closes.map(c => Math.pow(c - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(variance);
  
  const currentPrice = candles[candles.length - 1].close;
  const zScore = std > 0 ? (currentPrice - mean) / std : 0;
  
  return {
    upper: mean + (stdDev * std),
    middle: mean,
    lower: mean - (stdDev * std),
    zScore,
  };
}

export function calculate4HKeltnerChannel(candles: OHLCCandle[], emaPeriod: number = 20, atrPeriod: number = 10, multiplier: number = 2): {
  upper: number;
  middle: number;
  lower: number;
} | null {
  if (candles.length < Math.max(emaPeriod, atrPeriod + 1)) return null;
  
  const closes = candles.slice(-emaPeriod).map(c => c.close);
  const ema = closes.reduce((a, b) => a + b, 0) / emaPeriod;
  
  const atr = calculate4HATR(candles, atrPeriod);
  
  return {
    upper: ema + (multiplier * atr),
    middle: ema,
    lower: ema - (multiplier * atr),
  };
}

// Calculate ADX (Average Directional Index) from 4H OHLC candles
export function calculate4HADX(candles: OHLCCandle[], period: number = 14): number {
  if (candles.length < period + 1) return 25; // Default to neutral if not enough data
  
  const recentCandles = candles.slice(-period - 1);
  
  let plusDMSum = 0;
  let minusDMSum = 0;
  let trSum = 0;
  
  for (let i = 1; i < recentCandles.length; i++) {
    const current = recentCandles[i];
    const prev = recentCandles[i - 1];
    
    const highDiff = current.high - prev.high;
    const lowDiff = prev.low - current.low;
    
    // +DM and -DM
    const plusDM = highDiff > lowDiff && highDiff > 0 ? highDiff : 0;
    const minusDM = lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0;
    
    // True Range
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close)
    );
    
    plusDMSum += plusDM;
    minusDMSum += minusDM;
    trSum += tr;
  }
  
  if (trSum === 0) return 25;
  
  const plusDI = (plusDMSum / trSum) * 100;
  const minusDI = (minusDMSum / trSum) * 100;
  
  const diSum = plusDI + minusDI;
  if (diSum === 0) return 25;
  
  const dx = Math.abs(plusDI - minusDI) / diSum * 100;
  
  return dx; // Simplified ADX (single period DX)
}

function backtestMeanReversion(candles: OHLCCandle[], coinId: string): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  if (candles.length < 30) return trades;
  
  let position: { side: 'long' | 'short'; entryPrice: number; entryTime: number; stopLoss: number; takeProfit: number } | null = null;
  
  for (let i = 25; i < candles.length - 1; i++) {
    const histCandles = candles.slice(0, i + 1);
    const bb = calculate4HBollingerBands(histCandles, 20, 2);
    if (!bb) continue;
    
    const currentCandle = candles[i];
    const nextCandle = candles[i + 1];
    const atr = calculate4HATR(histCandles, 14);
    
    if (!position) {
      // "Falling Knife Protocol" per replit.md:
      // - Normal entry: ADX < 30 AND |Z-Score| > 1.5 (extended price in ranging market)
      // - Panic crash bypass: |Z-Score| > 3.5 ignores ADX filter entirely
      const adx = calculate4HADX(histCandles, 14);
      const absZScore = Math.abs(bb.zScore);
      const isPanic = absZScore > 3.5;
      const isRangingMarket = adx < 30;
      const isExtendedPrice = absZScore > 1.5;
      const canEnter = isPanic || (isRangingMarket && isExtendedPrice);
      
      if (canEnter) {
        if (bb.zScore > 1.5) {
          const entryPrice = currentCandle.close;
          const stopLoss = entryPrice * 1.01;
          const takeProfit = entryPrice * 0.985;
          position = { side: 'short', entryPrice, entryTime: currentCandle.timestamp, stopLoss, takeProfit };
        } else if (bb.zScore < -1.5) {
          const entryPrice = currentCandle.close;
          const stopLoss = entryPrice * 0.99;
          const takeProfit = entryPrice * 1.015;
          position = { side: 'long', entryPrice, entryTime: currentCandle.timestamp, stopLoss, takeProfit };
        }
      }
    } else {
      let exitPrice: number | null = null;
      
      if (position.side === 'long') {
        if (nextCandle.low <= position.stopLoss) {
          exitPrice = position.stopLoss;
        } else if (nextCandle.high >= position.takeProfit) {
          exitPrice = position.takeProfit;
        } else if (bb.zScore > 0) {
          exitPrice = nextCandle.close;
        }
      } else {
        if (nextCandle.high >= position.stopLoss) {
          exitPrice = position.stopLoss;
        } else if (nextCandle.low <= position.takeProfit) {
          exitPrice = position.takeProfit;
        } else if (bb.zScore < 0) {
          exitPrice = nextCandle.close;
        }
      }
      
      if (exitPrice !== null) {
        const pnlPercent = position.side === 'long' 
          ? ((exitPrice - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
        
        trades.push({
          strategy: 'meanReversion',
          coinId,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice,
          entryTime: position.entryTime,
          exitTime: nextCandle.timestamp,
          pnlPercent,
          rMultiple: pnlPercent / 1.0,
        });
        position = null;
      }
    }
  }
  
  return trades;
}

function backtestVolExpansion(candles: OHLCCandle[], coinId: string): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  if (candles.length < 30) return trades;
  
  let position: { side: 'long' | 'short'; entryPrice: number; entryTime: number; stopLoss: number; takeProfit: number } | null = null;
  
  for (let i = 25; i < candles.length - 1; i++) {
    const histCandles = candles.slice(0, i + 1);
    const keltner = calculate4HKeltnerChannel(histCandles, 20, 10, 2);
    if (!keltner) continue;
    
    const currentCandle = candles[i];
    const nextCandle = candles[i + 1];
    const atr = calculate4HATR(histCandles, 14);
    
    if (!position) {
      if (currentCandle.close > keltner.upper) {
        const entryPrice = currentCandle.close;
        const stopLoss = entryPrice * 0.99;
        const takeProfit = entryPrice * 1.015;
        position = { side: 'long', entryPrice, entryTime: currentCandle.timestamp, stopLoss, takeProfit };
      } else if (currentCandle.close < keltner.lower) {
        const entryPrice = currentCandle.close;
        const stopLoss = entryPrice * 1.01;
        const takeProfit = entryPrice * 0.985;
        position = { side: 'short', entryPrice, entryTime: currentCandle.timestamp, stopLoss, takeProfit };
      }
    } else {
      let exitPrice: number | null = null;
      
      if (position.side === 'long') {
        if (nextCandle.low <= position.stopLoss) {
          exitPrice = position.stopLoss;
        } else if (nextCandle.high >= position.takeProfit) {
          exitPrice = position.takeProfit;
        }
      } else {
        if (nextCandle.high >= position.stopLoss) {
          exitPrice = position.stopLoss;
        } else if (nextCandle.low <= position.takeProfit) {
          exitPrice = position.takeProfit;
        }
      }
      
      if (exitPrice !== null) {
        const pnlPercent = position.side === 'long' 
          ? ((exitPrice - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
        
        trades.push({
          strategy: 'volExpansion',
          coinId,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice,
          entryTime: position.entryTime,
          exitTime: nextCandle.timestamp,
          pnlPercent,
          rMultiple: pnlPercent / 1.0,
        });
        position = null;
      }
    }
  }
  
  return trades;
}

function backtestPairSpread(candlesA: OHLCCandle[], candlesB: OHLCCandle[], pairLabel: string): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  if (candlesA.length < 30 || candlesB.length < 30) return trades;
  
  const minLen = Math.min(candlesA.length, candlesB.length);
  const a = candlesA.slice(-minLen);
  const b = candlesB.slice(-minLen);
  
  let position: { entryTime: number; spreadEntry: number; direction: 'long' | 'short' } | null = null;
  
  const LOOKBACK = 20;
  
  for (let i = LOOKBACK; i < minLen - 1; i++) {
    const window = [];
    for (let j = i - LOOKBACK; j <= i; j++) {
      window.push(b[j].close / a[j].close);
    }
    
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const std = Math.sqrt(window.map(v => Math.pow(v - mean, 2)).reduce((s, v) => s + v, 0) / window.length);
    const currentSpread = window[window.length - 1];
    const zScore = std > 0 ? (currentSpread - mean) / std : 0;
    
    if (!position) {
      if (zScore > 1.5) {
        position = { entryTime: a[i].timestamp, spreadEntry: currentSpread, direction: 'short' };
      } else if (zScore < -1.5) {
        position = { entryTime: a[i].timestamp, spreadEntry: currentSpread, direction: 'long' };
      }
    } else {
      const holdBars = Math.floor((a[i].timestamp - position.entryTime) / (4 * 60 * 60 * 1000));
      const shouldExit = Math.abs(zScore) < 0.3 || holdBars > 30;
      
      if (shouldExit) {
        const spreadExit = b[i + 1].close / a[i + 1].close;
        let pnlPercent: number;
        if (position.direction === 'long') {
          pnlPercent = ((spreadExit - position.spreadEntry) / position.spreadEntry) * 100;
        } else {
          pnlPercent = ((position.spreadEntry - spreadExit) / position.spreadEntry) * 100;
        }
        
        trades.push({
          strategy: 'pairsTrading',
          coinId: pairLabel,
          side: position.direction,
          entryPrice: position.spreadEntry,
          exitPrice: spreadExit,
          entryTime: position.entryTime,
          exitTime: a[i + 1].timestamp,
          pnlPercent,
          rMultiple: pnlPercent / 1.0,
        });
        position = null;
      }
    }
  }
  
  return trades;
}

function backtestPairsTrading(btcCandles: OHLCCandle[], ethCandles: OHLCCandle[], allCandles?: Map<string, OHLCCandle[]>): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  
  trades.push(...backtestPairSpread(btcCandles, ethCandles, 'ETH/BTC'));
  
  if (allCandles) {
    const highCorrelationPairs: [string, string][] = [
      ['bitcoin', 'solana'],
      ['bitcoin', 'binancecoin'],
      ['ethereum', 'solana'],
      ['bitcoin', 'cardano'],
      ['bitcoin', 'chainlink'],
    ];
    
    for (const [idA, idB] of highCorrelationPairs) {
      const cA = allCandles.get(idA);
      const cB = allCandles.get(idB);
      if (cA && cB && cA.length >= 30 && cB.length >= 30) {
        const symA = idA.slice(0, 3).toUpperCase();
        const symB = idB.slice(0, 3).toUpperCase();
        trades.push(...backtestPairSpread(cA, cB, `${symB}/${symA}`));
      }
    }
  }
  
  console.log(`[Pairs Backtest] Generated ${trades.length} trades across ${allCandles ? 6 : 1} pairs`);
  return trades;
}

interface StrategyMetrics {
  sharpe: number;
  ulcer: number;
  mike1: number;
  trades: number;
  wins: number;
}

function calculateStrategyMetrics(trades: BacktestTrade[]): StrategyMetrics {
  if (trades.length < 5) return { sharpe: 0, ulcer: 0, mike1: 0, trades: trades.length, wins: 0 };
  
  const returns = trades.map(t => t.pnlPercent / 100);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.map(r => Math.pow(r - mean, 2)).reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(variance);
  const sharpeRatio = std > 0 ? (mean * Math.sqrt(252 * 6)) / std : 0;
  
  let cumulative = 0;
  let peak = 0;
  const drawdowns: number[] = [];
  
  for (const ret of returns) {
    cumulative += ret;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    drawdowns.push(dd);
  }
  
  const squaredDrawdowns = drawdowns.map(d => d * d);
  const ulcerIndex = Math.sqrt(squaredDrawdowns.reduce((a, b) => a + b, 0) / squaredDrawdowns.length);
  
  const mike1 = sharpeRatio / (ulcerIndex + 0.001);
  const wins = trades.filter(t => t.pnlPercent > 0).length;
  
  return { sharpe: sharpeRatio, ulcer: ulcerIndex, mike1, trades: trades.length, wins };
}

function calculateMike1(trades: BacktestTrade[]): number {
  return calculateStrategyMetrics(trades).mike1;
}

let warmupDetailedMetrics: {
  meanReversion: StrategyMetrics;
  volExpansion: StrategyMetrics;
  pairsTrading: StrategyMetrics;
} | null = null;

export async function runSyntheticWarmup(): Promise<StrategyMike1> {
  console.log('[Synthetic Warmup] Starting 30-day backtest for Mike1 calculation...');
  
  // Use shared source of truth for top 15 tradable cryptos
  const { getTop12TradableCryptos } = await import('./coingecko');
  const tradableCryptos = await getTop12TradableCryptos();
  const topCoins = tradableCryptos.map(c => c.id);
  
  console.log(`[Synthetic Warmup] Top ${topCoins.length} by volume: ${topCoins.join(', ')}`);
  
  // Use CoinGecko with 30-day range (Demo tier provides 4H candles for 3-30 day ranges)
  // 90 days only gives daily candles on Demo tier
  const allCandles = await getMultiple4HCandles(topCoins, 30);
  
  const meanRevTrades: BacktestTrade[] = [];
  const volExpTrades: BacktestTrade[] = [];
  const pairsTrades: BacktestTrade[] = [];
  
  for (const coinId of topCoins) {
    const candles = allCandles.get(coinId);
    if (!candles || candles.length < 30) {
      console.log(`[Synthetic Warmup] Skipping ${coinId} - insufficient data (${candles?.length || 0} candles)`);
      continue;
    }
    
    console.log(`[Synthetic Warmup] Backtesting ${coinId} (${candles.length} candles)...`);
    
    const mrTrades = backtestMeanReversion(candles, coinId);
    meanRevTrades.push(...mrTrades);
    
    const veTrades = backtestVolExpansion(candles, coinId);
    volExpTrades.push(...veTrades);
  }
  
  const btcCandles = allCandles.get('bitcoin') || [];
  const ethCandles = allCandles.get('ethereum') || [];
  if (btcCandles.length >= 30 && ethCandles.length >= 30) {
    const ptTrades = backtestPairsTrading(btcCandles, ethCandles, allCandles);
    pairsTrades.push(...ptTrades);
  }
  
  const meanRevMetrics = calculateStrategyMetrics(meanRevTrades);
  const volExpMetrics = calculateStrategyMetrics(volExpTrades);
  const pairsMetrics = calculateStrategyMetrics(pairsTrades);
  
  warmupDetailedMetrics = {
    meanReversion: meanRevMetrics,
    volExpansion: volExpMetrics,
    pairsTrading: pairsMetrics,
  };
  
  warmupMike1Scores = {
    meanReversion: meanRevMetrics.mike1,
    volExpansion: volExpMetrics.mike1,
    pairsTrading: pairsMetrics.mike1,
  };
  
  warmupTrades = [...meanRevTrades, ...volExpTrades, ...pairsTrades];
  cached4HOHLCData = allCandles;
  warmupComplete = true;
  if (warmupFirstRunTimestamp === 0) {
    warmupFirstRunTimestamp = Date.now();
  }
  
  console.log('[Synthetic Warmup] Complete!');
  console.log(`  Mean Reversion: ${meanRevTrades.length} trades, Mike1=${meanRevMetrics.mike1.toFixed(3)}`);
  console.log(`  Vol Expansion: ${volExpTrades.length} trades, Mike1=${volExpMetrics.mike1.toFixed(3)}`);
  console.log(`  Pairs Trading: ${pairsTrades.length} trades, Mike1=${pairsMetrics.mike1.toFixed(3)}`);
  
  const bestStrategy = Object.entries(warmupMike1Scores)
    .sort((a, b) => b[1] - a[1])[0];
  console.log(`  Active Strategy: ${bestStrategy[0]} (Mike1=${bestStrategy[1].toFixed(3)})`);
  
  saveBacktestScores({ ...warmupMike1Scores }, {
    meanReversion: meanRevMetrics,
    volExpansion: volExpMetrics,
    pairsTrading: pairsMetrics,
  }).catch(err => console.error('[Synthetic Warmup] Failed to persist backtest scores:', err));
  
  return warmupMike1Scores;
}

export function getWarmupMike1Scores(): StrategyMike1 | null {
  return warmupMike1Scores;
}

export async function restoreBacktestScores(): Promise<boolean> {
  const savedScores = await loadBacktestScores();
  if (!savedScores) return false;
  
  const mr = savedScores.meanReversion;
  const ve = savedScores.volExpansion;
  const pt = savedScores.pairsTrading;
  
  if (!mr || !ve || !pt) return false;
  
  warmupMike1Scores = {
    meanReversion: mr.mike1Score,
    volExpansion: ve.mike1Score,
    pairsTrading: pt.mike1Score,
  };
  if (warmupFirstRunTimestamp === 0) {
    warmupFirstRunTimestamp = Date.now();
  }
  
  warmupDetailedMetrics = {
    meanReversion: { sharpe: mr.sharpeRatio, ulcer: mr.ulcerIndex, mike1: mr.mike1Score, trades: mr.trades, wins: mr.wins },
    volExpansion: { sharpe: ve.sharpeRatio, ulcer: ve.ulcerIndex, mike1: ve.mike1Score, trades: ve.trades, wins: ve.wins },
    pairsTrading: { sharpe: pt.sharpeRatio, ulcer: pt.ulcerIndex, mike1: pt.mike1Score, trades: pt.trades, wins: pt.wins },
  };
  
  warmupComplete = true;
  
  console.log(`[Mike1 Restore] Restored backtest scores from DB: MR=${warmupMike1Scores.meanReversion.toFixed(3)} (S=${mr.sharpeRatio.toFixed(3)}/U=${mr.ulcerIndex.toFixed(3)}), VE=${warmupMike1Scores.volExpansion.toFixed(3)}, PT=${warmupMike1Scores.pairsTrading.toFixed(3)}`);
  
  refreshOHLCData().catch(err => 
    console.error('[Mike1 Restore] Failed to fetch fresh OHLC data:', err)
  );
  
  return true;
}

export async function refreshOHLCData(): Promise<void> {
  const { getTop12TradableCryptos } = await import('./coingecko');
  const tradableCryptos = await getTop12TradableCryptos();
  const topCoins = tradableCryptos.map(c => c.id);
  
  console.log(`[OHLC Refresh] Fetching 4H candles for ${topCoins.length} coins...`);
  const allCandles = await getMultiple4HCandles(topCoins, 30);
  
  if (allCandles.size > 0) {
    cached4HOHLCData = allCandles;
    console.log(`[OHLC Refresh] Cached 4H data for ${allCandles.size} coins (${Array.from(allCandles.values()).reduce((sum, c) => sum + c.length, 0)} total candles)`);
  } else {
    console.log('[OHLC Refresh] WARNING: No OHLC data returned from API');
  }
}

export function isWarmupComplete(): boolean {
  return warmupComplete;
}

export function getWarmupTrades(): BacktestTrade[] {
  return warmupTrades;
}

export function getWarmupDetailedMetrics() {
  return warmupDetailedMetrics;
}

export function getBestStrategy(): 'meanReversion' | 'volExpansion' | 'pairsTrading' | null {
  if (!warmupMike1Scores) return null;
  
  const entries = Object.entries(warmupMike1Scores) as [keyof StrategyMike1, number][];
  const sorted = entries.sort((a, b) => b[1] - a[1]);
  
  if (sorted[0][1] <= 0) return null;
  
  return sorted[0][0];
}

export { markCandleProcessed };

const MIN_LIVE_TRADES_FOR_PRIMARY = 10;
const BACKTEST_DECAY_START_HOURS = 24;
const BACKTEST_DECAY_FULL_HOURS = 168;
const BACKTEST_DECAY_FLOOR = 0.15;

function getBacktestDecayFactor(): number {
  if (warmupFirstRunTimestamp === 0) return 1.0;
  const hoursElapsed = (Date.now() - warmupFirstRunTimestamp) / (1000 * 60 * 60);
  if (hoursElapsed <= BACKTEST_DECAY_START_HOURS) return 1.0;
  const decayProgress = Math.min((hoursElapsed - BACKTEST_DECAY_START_HOURS) / (BACKTEST_DECAY_FULL_HOURS - BACKTEST_DECAY_START_HOURS), 1.0);
  return Math.max(BACKTEST_DECAY_FLOOR, 1.0 - (1.0 - BACKTEST_DECAY_FLOOR) * decayProgress);
}

export function computeBlendedScore(warmupScore: number, liveMike1: number, liveTradeCount: number): { blended: number; liveWeight: number } {
  if (liveTradeCount === 0) {
    const decay = getBacktestDecayFactor();
    return { blended: warmupScore * decay, liveWeight: 0 };
  }

  const tradeBasedWeight = Math.min(Math.sqrt(liveTradeCount / 30), 1.0);

  const decay = getBacktestDecayFactor();
  const adjustedWarmup = warmupScore * decay;

  const liveWeight = tradeBasedWeight;
  let blended = adjustedWarmup * (1 - liveWeight) + liveMike1 * liveWeight;

  if (liveTradeCount >= 5 && liveMike1 < 0 && blended > 0) {
    const ceiling = Math.max(adjustedWarmup * 0.3, Math.abs(liveMike1) * 5);
    if (blended > ceiling) {
      console.log(`[BLEND CAP] Capping blended score from ${blended.toFixed(1)} to ${ceiling.toFixed(1)} (live Mike1=${liveMike1.toFixed(3)}, ${liveTradeCount} trades)`);
      blended = ceiling;
    }
  }

  return { blended, liveWeight };
}

export function getStrategyAllocation(): { primary: string; primaryWeight: number; secondary: string | null; secondaryWeight: number; cashFloor: boolean; shadowOverrideActive?: boolean } {
  if (isShadowOverrideActive()) {
    const override = getShadowOverride();
    console.log(`[Allocation] SHADOW OVERRIDE ACTIVE: ${override.primary}(${(override.primaryWeight * 100).toFixed(0)}%)${override.secondary ? ` + ${override.secondary}(${(override.secondaryWeight * 100).toFixed(0)}%)` : ''}`);
    return {
      primary: override.primary,
      primaryWeight: override.primaryWeight,
      secondary: override.secondary,
      secondaryWeight: override.secondaryWeight,
      cashFloor: false,
      shadowOverrideActive: true,
    };
  }
  
  if (!warmupMike1Scores) {
    return { primary: 'volExpansion', primaryWeight: 0.7, secondary: 'meanReversion', secondaryWeight: 0.3, cashFloor: false };
  }
  
  if (detectVolatilitySpike()) {
    return { primary: 'meanReversion', primaryWeight: 1.0, secondary: null, secondaryWeight: 0, cashFloor: false };
  }
  
  const modePerf = getModePerformance();
  const PROVEN_LOSER_TRADE_THRESHOLD = 20;
  const modes = ['meanReversion', 'volExpansion', 'pairsTrading', 'momentum'] as const;
  
  const scored = modes.map(mode => {
    const perf = modePerf[mode];
    const warmupScore = mode === 'momentum' ? 0 : warmupMike1Scores![mode as keyof StrategyMike1];
    
    if (perf.trades === 0 && mode !== 'momentum') {
      const decay = getBacktestDecayFactor();
      return { mode, score: warmupScore * decay, liveTrades: 0, liveMike1: 0, blocked: false };
    }
    
    if (perf.trades === 0 && mode === 'momentum') {
      return { mode, score: 0, liveTrades: 0, liveMike1: 0, blocked: false };
    }
    
    const returns = perf.returns;
    const drawdowns = perf.drawdowns;
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 1 ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length : 0;
    const stdDev = Math.sqrt(variance);
    const liveSharpe = stdDev > 0.001 ? avgReturn / stdDev : 0;
    const sumSqDD = drawdowns.length > 0 ? drawdowns.reduce((sum, d) => sum + d * d, 0) : 0;
    const liveUlcer = drawdowns.length > 0 ? Math.sqrt(sumSqDD / drawdowns.length) : 0;
    const liveMike1 = liveUlcer > 0.001 ? liveSharpe / liveUlcer : (liveSharpe > 0 ? liveSharpe * 10 : 0);
    
    if (perf.trades >= PROVEN_LOSER_TRADE_THRESHOLD && liveMike1 < 0) {
      const shadowScores = getShadowMike1Scores();
      const shadowMike1 = shadowScores[mode] ?? 0;
      const SHADOW_REHAB_MIN_SCORE = 0.5;
      if (shadowMike1 >= SHADOW_REHAB_MIN_SCORE) {
        console.log(`[PROVEN LOSER REHAB] ${mode}: live Mike1=${liveMike1.toFixed(3)} negative BUT shadow Mike1=${shadowMike1.toFixed(3)} positive (>=${SHADOW_REHAB_MIN_SCORE}) - rehabilitation exploration allowed`);
        return { mode, score: shadowMike1 * 0.3, liveTrades: perf.trades, liveMike1, blocked: false };
      }
      console.log(`[PROVEN LOSER] ${mode} blocked: ${perf.trades} live trades, live Mike1=${liveMike1.toFixed(3)}, shadow Mike1=${shadowMike1.toFixed(3)} - insufficient for rehab (need >=${SHADOW_REHAB_MIN_SCORE})`);
      return { mode, score: 0, liveTrades: perf.trades, liveMike1, blocked: true };
    }
    
    const { blended } = computeBlendedScore(warmupScore, liveMike1, perf.trades);
    return { mode, score: blended, liveTrades: perf.trades, liveMike1, blocked: false };
  });
  
  const divRegime = getDivergenceRegime();
  if (divRegime && divRegime.confidence > 0) {
    const maxScore = Math.max(...scored.map(s => Math.abs(s.score)), 1);
    const minScoreForModifier = 10;
    for (const s of scored) {
      if (s.blocked) continue;
      const mod = divRegime.modifiers[s.mode as keyof typeof divRegime.modifiers] || 0;
      if (maxScore >= minScoreForModifier) {
        s.score += mod * maxScore;
      }
    }
    if (divRegime.confidence > 0.3) {
      const applied = maxScore >= minScoreForModifier;
      console.log(`[Divergence Regime] ${divRegime.regime} (conf=${(divRegime.confidence * 100).toFixed(0)}%) | Mods: MR=${(divRegime.modifiers.meanReversion * 100).toFixed(1)}%, VE=${(divRegime.modifiers.volExpansion * 100).toFixed(1)}%, PT=${(divRegime.modifiers.pairsTrading * 100).toFixed(1)}%${applied ? '' : ' (SKIPPED: scores too low)'} | ${divRegime.summary}`);
    }
  }
  
  scored.sort((a, b) => b.score - a.score);
  
  const decayFactor = getBacktestDecayFactor();
  console.log(`[Allocation] Backtest decay: ${(decayFactor * 100).toFixed(0)}% | Scores: ${scored.map(s => `${s.mode}=${s.score.toFixed(1)}(${s.liveTrades}t)`).join(', ')}`);
  
  let bestMode = scored[0].mode;
  let secondMode = scored[1].mode;
  
  const bestHasEnoughTrades = scored[0].liveTrades >= MIN_LIVE_TRADES_FOR_PRIMARY || scored[0].liveTrades === 0;
  if (!bestHasEnoughTrades && scored[0].liveTrades > 0 && scored[0].liveTrades < MIN_LIVE_TRADES_FOR_PRIMARY) {
    const nextWithEnough = scored.find((s, idx) => idx > 0 && (s.liveTrades >= MIN_LIVE_TRADES_FOR_PRIMARY || s.liveTrades === 0) && s.score > 0);
    if (nextWithEnough) {
      console.log(`[Allocation] ${bestMode} has only ${scored[0].liveTrades} live trades (need ${MIN_LIVE_TRADES_FOR_PRIMARY}) - demoting to secondary, promoting ${nextWithEnough.mode}`);
      const demoted = bestMode;
      bestMode = nextWithEnough.mode;
      secondMode = demoted;
    } else {
      console.log(`[Allocation] ${bestMode} has only ${scored[0].liveTrades} live trades - no better alternative, keeping as primary`);
    }
  }
  
  const allNegative = scored.every(s => s.score <= 0);
  
  if (allNegative) {
    console.log(`[CASH FLOOR] All strategies negative - PAUSED but tracking: ${bestMode}(${scored[0].score.toFixed(1)}), ${secondMode}(${scored[1]?.score.toFixed(1)})`);
    return { 
      primary: bestMode, 
      primaryWeight: 0.7, 
      secondary: secondMode, 
      secondaryWeight: 0.3,
      cashFloor: true
    };
  }
  
  let primaryWeight = 0.7;
  let secondaryWeight = 0.3;
  let actualPrimary = bestMode;
  let actualSecondary: string | null = secondMode;
  
  const primaryHibernating = isHibernating(bestMode);
  const secondaryHibernating = isHibernating(secondMode);
  
  if (primaryHibernating && secondaryHibernating) {
    console.log(`[Allocation] Both ${bestMode} and ${secondMode} HIBERNATING - CASH FLOOR`);
    return {
      primary: bestMode,
      primaryWeight: 0.7,
      secondary: secondMode,
      secondaryWeight: 0.3,
      cashFloor: true,
    };
  } else if (primaryHibernating) {
    console.log(`[Allocation] ${bestMode} HIBERNATING - shifting weight to ${secondMode}`);
    const thirdMode = scored[2].mode;
    const thirdHibernating = isHibernating(thirdMode);
    if (!thirdHibernating) {
      actualPrimary = secondMode;
      primaryWeight = 0.7;
      actualSecondary = thirdMode;
      secondaryWeight = 0.3;
    } else {
      actualPrimary = secondMode;
      primaryWeight = 1.0;
      actualSecondary = null;
      secondaryWeight = 0;
    }
  } else if (secondaryHibernating) {
    console.log(`[Allocation] ${secondMode} HIBERNATING - ${bestMode} gets full weight`);
    const thirdMode = scored[2].mode;
    const thirdHibernating = isHibernating(thirdMode);
    if (!thirdHibernating) {
      actualSecondary = thirdMode;
    } else {
      primaryWeight = 1.0;
      actualSecondary = null;
      secondaryWeight = 0;
    }
  }
  
  console.log(`[Allocation] ${actualPrimary}(${(primaryWeight * 100).toFixed(0)}%)${actualSecondary ? ` + ${actualSecondary}(${(secondaryWeight * 100).toFixed(0)}%)` : ''} | Momentum: ${getAllModeStatesForLog()}`);
  
  return { 
    primary: actualPrimary, 
    primaryWeight, 
    secondary: actualSecondary, 
    secondaryWeight,
    cashFloor: false
  };
}

function getAllModeStatesForLog(): string {
  const modes = ['meanReversion', 'volExpansion', 'pairsTrading', 'momentum'] as const;
  return modes.map(m => {
    const mult = getSizeMultiplier(m);
    const hib = isHibernating(m);
    return `${m}=${hib ? 'HIB' : (mult * 100).toFixed(0) + '%'}`;
  }).join(', ');
}

// LIVE SIGNAL GENERATION USING 4H OHLC DATA
// These functions mirror the backtest logic exactly to ensure consistency

export interface Live4HSignal {
  coinId: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  strategy: 'meanReversion' | 'volExpansion' | 'momentum' | 'pairsTrading';
  reasoning: string[];
  confidence: number;
  zScore?: number;
  atr?: number;
  candleId?: string;
}

export function generateLiveMeanReversionSignal(coinId: string, currentPrice: number, skipDedup: boolean = false): Live4HSignal | null {
  const candles = cached4HOHLCData.get(coinId);
  if (!candles || candles.length < 30) {
    return null;
  }
  
  const bb = calculate4HBollingerBands(candles, 20, 2);
  if (!bb) return null;
  
  const atr = calculate4HATR(candles, 14);
  const absZScore = Math.abs(bb.zScore);
  
  if (absZScore < 0.4) {
    return null;
  }
  
  if (bb.zScore < -0.4) {
    const stopDist = Math.max(atr * 2, currentPrice * 0.01);
    const tpDist = stopDist * 1.5;
    const stopLoss = currentPrice - stopDist;
    const takeProfit = currentPrice + tpDist;
    
    if (!skipDedup) console.log(`[LIVE 4H] ${getCryptoSymbol(coinId)}: Mean Rev LONG signal Z=${bb.zScore.toFixed(2)} ATR-SL=$${stopDist.toFixed(2)}`);
    
    return {
      coinId,
      symbol: getCryptoSymbol(coinId),
      side: 'long',
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      strategy: 'meanReversion',
      reasoning: [
        `[4H OHLC] Mean Reversion LONG`,
        `Z-Score: ${bb.zScore.toFixed(2)}`,
        `Extended below mean - expect snap-back`,
        `4H ATR: $${atr.toFixed(2)} | SL: 2x ATR ($${stopDist.toFixed(2)}) | TP: 3x ATR ($${tpDist.toFixed(2)})`,
      ],
      confidence: Math.min(0.9, 0.5 + Math.abs(bb.zScore) * 0.1),
      zScore: bb.zScore,
      atr,
    };
  } else if (bb.zScore > 0.4) {
    const stopDist = Math.max(atr * 2, currentPrice * 0.01);
    const tpDist = stopDist * 1.5;
    const stopLoss = currentPrice + stopDist;
    const takeProfit = currentPrice - tpDist;
    
    if (!skipDedup) console.log(`[LIVE 4H] ${getCryptoSymbol(coinId)}: Mean Rev SHORT signal Z=${bb.zScore.toFixed(2)} ATR-SL=$${stopDist.toFixed(2)}`);
    
    return {
      coinId,
      symbol: getCryptoSymbol(coinId),
      side: 'short',
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      strategy: 'meanReversion',
      reasoning: [
        `[4H OHLC] Mean Reversion SHORT`,
        `Z-Score: ${bb.zScore.toFixed(2)}`,
        `Extended above mean - expect reversion`,
        `4H ATR: $${atr.toFixed(2)} | SL: 2x ATR ($${stopDist.toFixed(2)}) | TP: 3x ATR ($${tpDist.toFixed(2)})`,
      ],
      confidence: Math.min(0.9, 0.5 + Math.abs(bb.zScore) * 0.1),
      zScore: bb.zScore,
      atr,
    };
  }
  
  return null;
}

export function generateLiveVolExpansionSignal(coinId: string, currentPrice: number, skipDedup: boolean = false): Live4HSignal | null {
  const candles = cached4HOHLCData.get(coinId);
  if (!candles || candles.length < 30) {
    return null;
  }
  
  const keltner = calculate4HKeltnerChannel(candles, 20, 10, 2);
  if (!keltner) return null;
  
  const atr = calculate4HATR(candles, 14);
  
  // Check for Keltner breakout OR near-Keltner approach (within 0.5 ATR)
  const nearThreshold = atr * 0.5;
  const isAboveUpper = currentPrice > keltner.upper;
  const isNearUpper = !isAboveUpper && currentPrice > (keltner.upper - nearThreshold) && currentPrice > keltner.middle;
  const isBelowLower = currentPrice < keltner.lower;
  const isNearLower = !isBelowLower && currentPrice < (keltner.lower + nearThreshold) && currentPrice < keltner.middle;
  
  if (isAboveUpper || isNearUpper) {
    const stopDist = Math.max(atr * 2, currentPrice * 0.01);
    const tpDist = stopDist * 1.5;
    const stopLoss = currentPrice - stopDist;
    const takeProfit = currentPrice + tpDist;
    const signalType = isAboveUpper ? 'Keltner breakout UP' : 'Near-Keltner approach UP';
    const confidence = isAboveUpper ? 0.7 : 0.6;
    
    if (!skipDedup) console.log(`[LIVE 4H] ${getCryptoSymbol(coinId)}: Vol Exp LONG signal - ${signalType} ATR-SL=$${stopDist.toFixed(2)}`);
    
    return {
      coinId,
      symbol: getCryptoSymbol(coinId),
      side: 'long',
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      strategy: 'volExpansion',
      reasoning: [
        `[4H OHLC] Vol Expansion LONG`,
        isAboveUpper 
          ? `Keltner Breakout: Price $${currentPrice.toFixed(2)} > Upper $${keltner.upper.toFixed(2)}`
          : `Near-Keltner: Price $${currentPrice.toFixed(2)} approaching Upper $${keltner.upper.toFixed(2)} (within ${nearThreshold.toFixed(2)})`,
        `EMA(20): $${keltner.middle.toFixed(2)}`,
        `4H ATR: $${atr.toFixed(2)} | SL: 2x ATR ($${stopDist.toFixed(2)}) | TP: 3x ATR ($${tpDist.toFixed(2)})`,
      ],
      confidence,
      atr,
    };
  } else if (isBelowLower || isNearLower) {
    const stopDist = Math.max(atr * 2, currentPrice * 0.01);
    const tpDist = stopDist * 1.5;
    const stopLoss = currentPrice + stopDist;
    const takeProfit = currentPrice - tpDist;
    const signalType = isBelowLower ? 'Keltner breakout DOWN' : 'Near-Keltner approach DOWN';
    const confidence = isBelowLower ? 0.7 : 0.6;
    
    if (!skipDedup) console.log(`[LIVE 4H] ${getCryptoSymbol(coinId)}: Vol Exp SHORT signal - ${signalType} ATR-SL=$${stopDist.toFixed(2)}`);
    
    return {
      coinId,
      symbol: getCryptoSymbol(coinId),
      side: 'short',
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      strategy: 'volExpansion',
      reasoning: [
        `[4H OHLC] Vol Expansion SHORT`,
        isBelowLower
          ? `Keltner Breakout: Price $${currentPrice.toFixed(2)} < Lower $${keltner.lower.toFixed(2)}`
          : `Near-Keltner: Price $${currentPrice.toFixed(2)} approaching Lower $${keltner.lower.toFixed(2)} (within ${nearThreshold.toFixed(2)})`,
        `EMA(20): $${keltner.middle.toFixed(2)}`,
        `4H ATR: $${atr.toFixed(2)} | SL: 2x ATR ($${stopDist.toFixed(2)}) | TP: 3x ATR ($${tpDist.toFixed(2)})`,
      ],
      confidence,
      atr,
    };
  }
  
  return null;
}

// Get all live signals from cached 4H OHLC data
export function generateAllLiveSignals(cryptos: { id: string; current_price: number }[]): Live4HSignal[] {
  if (!warmupComplete || cached4HOHLCData.size === 0) {
    console.log('[LIVE 4H] Warmup not complete or no OHLC data cached');
    return [];
  }
  
  const allocation = getStrategyAllocation();
  
  if (allocation.cashFloor) {
    console.log('[LIVE 4H] CASH FLOOR active - all strategies negative Mike1. No signals but tracking continues.');
    return [];
  }
  
  const signals: Live4HSignal[] = [];
  
  for (const crypto of cryptos) {
    const coinId = crypto.id;
    const currentPrice = crypto.current_price;
    
    const mrSignal = generateLiveMeanReversionSignal(coinId, currentPrice);
    if (mrSignal) signals.push(mrSignal);
    
    const veSignal = generateLiveVolExpansionSignal(coinId, currentPrice);
    if (veSignal) signals.push(veSignal);
    
    const momSignal = generateLiveMomentumSignal(coinId, currentPrice);
    if (momSignal) signals.push(momSignal);
  }
  
  const pairsSignals = generateLivePairsSignals(cryptos);
  signals.push(...pairsSignals);
  
  console.log(`[LIVE 4H] Generated ${signals.length} signals from ${cryptos.length} cryptos (alloc: ${allocation.primary}/${allocation.secondary || 'none'})`);
  return signals;
}

function generateLivePairsSignals(cryptos: { id: string; current_price: number }[]): Live4HSignal[] {
  const signals: Live4HSignal[] = [];
  const btcCandles = cached4HOHLCData.get('bitcoin');
  if (!btcCandles || btcCandles.length < 25) return signals;
  
  const pairCandidates = ['ethereum', 'solana', 'binancecoin', 'ripple', 'dogecoin', 'sui', 'cardano', 'litecoin', 'chainlink', 'tron'];
  const LOOKBACK = 20;
  
  for (const altId of pairCandidates) {
    const altCandles = cached4HOHLCData.get(altId);
    if (!altCandles || altCandles.length < LOOKBACK + 1) continue;
    
    const altCrypto = cryptos.find(c => c.id === altId);
    const btcCrypto = cryptos.find(c => c.id === 'bitcoin');
    if (!altCrypto || !btcCrypto || btcCrypto.current_price <= 0) continue;
    
    const minLen = Math.min(btcCandles.length, altCandles.length);
    if (minLen < LOOKBACK + 1) continue;
    
    const window: number[] = [];
    for (let j = minLen - LOOKBACK - 1; j < minLen; j++) {
      window.push(altCandles[j].close / btcCandles[j].close);
    }
    
    const currentSpread = altCrypto.current_price / btcCrypto.current_price;
    window[window.length - 1] = currentSpread;
    
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const std = Math.sqrt(window.map(v => Math.pow(v - mean, 2)).reduce((s, v) => s + v, 0) / window.length);
    if (std <= 0) continue;
    const zScore = (currentSpread - mean) / std;
    
    if (Math.abs(zScore) > 0.8) {
      const symbol = getCryptoSymbol(altId);
      const side: 'long' | 'short' = zScore < -0.8 ? 'long' : 'short';
      const atr = calculate4HATR(altCandles.slice(-15));
      const stopDist = atr * 1.5 || altCrypto.current_price * 0.02;
      
      signals.push({
        coinId: altId,
        symbol,
        side,
        entryPrice: altCrypto.current_price,
        stopLoss: side === 'long' ? altCrypto.current_price - stopDist : altCrypto.current_price + stopDist,
        takeProfit: side === 'long' ? altCrypto.current_price + stopDist * 1.5 : altCrypto.current_price - stopDist * 1.5,
        confidence: Math.min(0.95, 0.5 + Math.abs(zScore) * 0.1),
        reasoning: [`Pairs Z-score ${zScore.toFixed(2)} on ${symbol}/BTC spread`],
        strategy: 'pairsTrading',
        candleId: `${altId}_pairs_${Date.now()}`,
      });
    }
  }
  
  return signals;
}

function generateLiveMomentumSignal(coinId: string, currentPrice: number): Live4HSignal | null {
  const candles = cached4HOHLCData.get(coinId);
  if (!candles || candles.length < 10) return null;
  
  const recent = candles.slice(-3);
  const prev = candles.slice(-10, -3);
  
  if (prev.length === 0) return null;
  
  const latestCandle = recent[recent.length - 1];
  const candleBody = Math.abs(latestCandle.close - latestCandle.open);
  const candleBodyPct = candleBody / latestCandle.open;
  
  const avgBodySize = prev.reduce((sum, c) => sum + Math.abs(c.close - c.open) / c.open, 0) / prev.length;
  const bodySurge = avgBodySize > 0 ? candleBodyPct / avgBodySize : 0;
  
  const priceChange3Candles = (recent[recent.length - 1].close - recent[0].open) / recent[0].open;
  const absChange = Math.abs(priceChange3Candles);
  
  if (candleBodyPct < 0.002 || bodySurge < 1.0 || absChange < 0.003) return null;
  
  const side: 'long' | 'short' = priceChange3Candles > 0 ? 'long' : 'short';
  const atr = calculate4HATR(candles.slice(-15));
  const stopDist = atr * 1.2 || currentPrice * 0.015;
  const tpDist = stopDist * 1.5;
  
  const symbol = coinId.replace(/-/g, '').toUpperCase().slice(0, 6);
  
  return {
    coinId,
    symbol,
    side,
    entryPrice: currentPrice,
    stopLoss: side === 'long' ? currentPrice - stopDist : currentPrice + stopDist,
    takeProfit: side === 'long' ? currentPrice + tpDist : currentPrice - tpDist,
    strategy: 'momentum',
    reasoning: [`Momentum: ${(candleBodyPct * 100).toFixed(1)}% candle (${bodySurge.toFixed(1)}x avg), ${(absChange * 100).toFixed(1)}% 3-candle move`],
    confidence: Math.min(0.9, 0.55 + candleBodyPct * 5 + (bodySurge - 2) * 0.05),
    atr,
  };
}

export function generateAllShadowSignals(cryptos: { id: string; current_price: number }[]): Live4HSignal[] {
  if (!warmupComplete || cached4HOHLCData.size === 0) {
    return [];
  }
  
  const signals: Live4HSignal[] = [];
  
  for (const crypto of cryptos) {
    const coinId = crypto.id;
    const currentPrice = crypto.current_price;
    
    const mrSignal = generateLiveMeanReversionSignal(coinId, currentPrice, true);
    if (mrSignal) {
      signals.push(mrSignal);
    }
    
    const veSignal = generateLiveVolExpansionSignal(coinId, currentPrice, true);
    if (veSignal) {
      signals.push(veSignal);
    }
    
    const momSignal = generateLiveMomentumSignal(coinId, currentPrice);
    if (momSignal) {
      signals.push(momSignal);
    }
  }
  
  const pairsSignals = generateLivePairsSignals(cryptos);
  signals.push(...pairsSignals);
  
  console.log(`[Shadow Signals] Generated ${signals.length} shadow signals (MR: ${signals.filter(s => s.strategy === 'meanReversion').length}, VE: ${signals.filter(s => s.strategy === 'volExpansion').length}, Mom: ${signals.filter(s => s.strategy === 'momentum').length}, Pairs: ${signals.filter(s => s.strategy === 'pairsTrading').length})`);
  
  return signals;
}

// Get cached OHLC data for a specific coin
export function getCached4HOHLC(coinId: string): OHLCCandle[] {
  return cached4HOHLCData.get(coinId) || [];
}
