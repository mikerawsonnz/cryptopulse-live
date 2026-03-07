import type { CryptoData, AITradeSignal, Position, TradeRecord } from "@shared/schema";
import { openPosition, closePosition, persistPairPositions, getPortfolioState, getTrades, updatePositionPrices, estimatePositionValue, getMaxPositionValue, isSymbolOnCooldown } from "./paperTrading";
import { isSymbolInTop15 } from "./binanceCandles";

interface PriceHistory {
  symbol: string;
  prices: number[];
  returns: number[];
  timestamps: number[];
}

interface CorrelationPair {
  pair1: string;
  pair2: string;
  currentCorrelation: number;
  historicalCorrelation: number;
  correlationDelta: number;
  zScore: number;
  spreadReturn: number;
}

interface PairPosition {
  pairId: string;
  longSymbol: string;
  shortSymbol: string;
  longPositionId: string | null;
  shortPositionId: string | null;
  entrySpread: number;
  entryTime: string;
  targetSpread: number;
  hedgeRatio: number;      // OLS-derived β for proper position sizing
  entryZScore: number;     // Z-score at entry for monitoring
}

export interface StrategyMetrics {
  sharpeRatio: number;
  ulcerIndex: number;
  sharpeUlcerRatio: number;
  totalReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  avgHoldingPeriodHours: number;
}

interface CorrelationStrategyState {
  priceHistory: Map<string, PriceHistory>;
  correlationMatrix: Map<string, number>;
  activePairs: PairPosition[];
  dailyReturns: number[];
  equityHistory: number[];
  lastAnalysis: number;
  enabled: boolean;
}

const LOOKBACK_PERIOD = 20;
const CORRELATION_THRESHOLD = 0.85;
const ZSCORE_ENTRY = 2.5;
const ZSCORE_EXIT = 0.5;
const ZSCORE_BROKEN_LEASH = 3.5;
const MAX_PAIRS = 3;
const ANALYSIS_COOLDOWN = 300000;
const PAIR_COOLDOWN_MS = 15 * 60 * 1000;

const pairCooldowns: Map<string, number> = new Map();

let strategyState: CorrelationStrategyState = {
  priceHistory: new Map(),
  correlationMatrix: new Map(),
  activePairs: [],
  dailyReturns: [],
  equityHistory: [100],
  lastAnalysis: 0,
  enabled: true,
};

const STABLECOINS = ['usdt', 'usdc', 'dai', 'busd', 'tusd', 'usdp', 'usdd', 'frax', 'lusd', 'susd'];

function isStablecoin(symbol: string): boolean {
  return STABLECOINS.includes(symbol.toLowerCase());
}

function calculateReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return returns;
}

function calculateCorrelation(returns1: number[], returns2: number[]): number {
  if (returns1.length !== returns2.length || returns1.length < 5) return 0;
  
  const n = returns1.length;
  const mean1 = returns1.reduce((a, b) => a + b, 0) / n;
  const mean2 = returns2.reduce((a, b) => a + b, 0) / n;
  
  let cov = 0;
  let var1 = 0;
  let var2 = 0;
  
  for (let i = 0; i < n; i++) {
    const diff1 = returns1[i] - mean1;
    const diff2 = returns2[i] - mean2;
    cov += diff1 * diff2;
    var1 += diff1 * diff1;
    var2 += diff2 * diff2;
  }
  
  const std1 = Math.sqrt(var1 / n);
  const std2 = Math.sqrt(var2 / n);
  
  if (std1 === 0 || std2 === 0) return 0;
  
  return cov / (n * std1 * std2);
}

function calculateZScore(currentSpread: number, spreadHistory: number[]): number {
  if (spreadHistory.length < 5) return 0;
  
  const mean = spreadHistory.reduce((a, b) => a + b, 0) / spreadHistory.length;
  const variance = spreadHistory.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / spreadHistory.length;
  const std = Math.sqrt(variance);
  
  if (std === 0) return 0;
  return (currentSpread - mean) / std;
}

// ENGLE-GRANGER COINTEGRATION TEST
// Per spec: Use statsmodels-style cointegration check (p-value < 0.05)
// Since we can't use Python statsmodels, we implement ADF-like test on OLS residuals
function testCointegration(
  pricesY: number[],
  pricesX: number[]
): { isCointegrated: boolean; pValue: number; adfStatistic: number } {
  if (pricesY.length < 20 || pricesX.length < 20) {
    return { isCointegrated: false, pValue: 1.0, adfStatistic: 0 };
  }
  
  const minLen = Math.min(pricesY.length, pricesX.length);
  const logY = pricesY.slice(-minLen).map(p => Math.log(p));
  const logX = pricesX.slice(-minLen).map(p => Math.log(p));
  
  // Step 1: Run OLS regression to get residuals
  const n = logY.length;
  const meanY = logY.reduce((a, b) => a + b, 0) / n;
  const meanX = logX.reduce((a, b) => a + b, 0) / n;
  
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (logX[i] - meanX) * (logY[i] - meanY);
    denominator += (logX[i] - meanX) * (logX[i] - meanX);
  }
  
  const beta = denominator !== 0 ? numerator / denominator : 1.0;
  const alpha = meanY - beta * meanX;
  
  // Residuals = Y - (alpha + beta * X)
  const residuals: number[] = [];
  for (let i = 0; i < n; i++) {
    residuals.push(logY[i] - (alpha + beta * logX[i]));
  }
  
  // Step 2: ADF test on residuals (simplified Dickey-Fuller)
  // Test statistic: t-stat from regression: ΔY = α + γY_{t-1} + ε
  const deltaResiduals: number[] = [];
  const laggedResiduals: number[] = [];
  
  for (let i = 1; i < residuals.length; i++) {
    deltaResiduals.push(residuals[i] - residuals[i - 1]);
    laggedResiduals.push(residuals[i - 1]);
  }
  
  // Regress delta on lagged
  const m = deltaResiduals.length;
  const meanDelta = deltaResiduals.reduce((a, b) => a + b, 0) / m;
  const meanLag = laggedResiduals.reduce((a, b) => a + b, 0) / m;
  
  let numAdf = 0, denAdf = 0;
  for (let i = 0; i < m; i++) {
    numAdf += (laggedResiduals[i] - meanLag) * (deltaResiduals[i] - meanDelta);
    denAdf += (laggedResiduals[i] - meanLag) * (laggedResiduals[i] - meanLag);
  }
  
  const gamma = denAdf !== 0 ? numAdf / denAdf : 0;
  
  // Calculate standard error of gamma
  let ssResid = 0;
  for (let i = 0; i < m; i++) {
    const predicted = meanDelta + gamma * (laggedResiduals[i] - meanLag);
    ssResid += Math.pow(deltaResiduals[i] - predicted, 2);
  }
  const mse = ssResid / (m - 2);
  const seGamma = Math.sqrt(mse / denAdf);
  
  const adfStatistic = seGamma !== 0 ? gamma / seGamma : 0;
  
  // Critical values for Engle-Granger (n=50): -3.34 (5%), -2.93 (10%)
  // Use simplified p-value approximation based on ADF statistic
  let pValue: number;
  if (adfStatistic < -3.5) pValue = 0.01;
  else if (adfStatistic < -3.0) pValue = 0.05;
  else if (adfStatistic < -2.5) pValue = 0.10;
  else if (adfStatistic < -2.0) pValue = 0.25;
  else pValue = 0.50;
  
  const isCointegrated = pValue < 0.05;
  
  console.log(`[Cointegration] ADF stat=${adfStatistic.toFixed(3)}, p-value≈${pValue.toFixed(3)}, cointegrated=${isCointegrated}`);
  
  return { isCointegrated, pValue, adfStatistic };
}

// OLS REGRESSION FOR HEDGE RATIO (BETA) CALCULATION
// Per Mike1 spec: Run OLS Regression: ln(Y) = α + β × ln(X)
// β is the multiplier - if β = 1.5, Short $1.50 of X for every $1.00 Long of Y
// This ensures proper hedge ratio instead of naive 1:1 sizing
function calculateOLSHedgeRatio(
  pricesY: number[], // Long asset prices
  pricesX: number[]  // Short asset prices
): { beta: number; alpha: number; rSquared: number } {
  if (pricesY.length < 10 || pricesX.length < 10) {
    return { beta: 1.0, alpha: 0, rSquared: 0 };
  }
  
  // Use log prices for proper cointegration analysis
  const minLen = Math.min(pricesY.length, pricesX.length);
  const logY = pricesY.slice(-minLen).map(p => Math.log(p));
  const logX = pricesX.slice(-minLen).map(p => Math.log(p));
  
  const n = logY.length;
  const meanY = logY.reduce((a, b) => a + b, 0) / n;
  const meanX = logX.reduce((a, b) => a + b, 0) / n;
  
  // Calculate β (slope) and α (intercept) using least squares
  let numerator = 0;
  let denominator = 0;
  
  for (let i = 0; i < n; i++) {
    const xDiff = logX[i] - meanX;
    const yDiff = logY[i] - meanY;
    numerator += xDiff * yDiff;
    denominator += xDiff * xDiff;
  }
  
  const beta = denominator !== 0 ? numerator / denominator : 1.0;
  const alpha = meanY - beta * meanX;
  
  // Calculate R² (coefficient of determination)
  const ssTotal = logY.reduce((sum, y) => sum + Math.pow(y - meanY, 2), 0);
  const ssResidual = logY.reduce((sum, y, i) => {
    const predicted = alpha + beta * logX[i];
    return sum + Math.pow(y - predicted, 2);
  }, 0);
  
  const rSquared = ssTotal > 0 ? 1 - (ssResidual / ssTotal) : 0;
  
  console.log(`[OLS Hedge] β=${beta.toFixed(4)}, α=${alpha.toFixed(4)}, R²=${rSquared.toFixed(4)}`);
  
  return { beta, alpha, rSquared };
}

// Check for "Broken Leash" condition - correlation breakdown
// Per Mike1 spec: Hard stop if Spread Z-Score expands beyond 3.5 standard deviations
function isBrokenLeash(zScore: number): boolean {
  const absZ = Math.abs(zScore);
  if (absZ > ZSCORE_BROKEN_LEASH) {
    console.log(`[BROKEN LEASH] Z-Score ${zScore.toFixed(2)} exceeds ${ZSCORE_BROKEN_LEASH} - correlation failure detected!`);
    return true;
  }
  return false;
}

export function calculateSharpeRatio(returns: number[], riskFreeRate: number = 0): number {
  if (returns.length < 5) return 0;
  
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const excessReturn = meanReturn - (riskFreeRate / 252);
  
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
  const std = Math.sqrt(variance);
  
  if (std === 0) return 0;
  
  return (excessReturn / std) * Math.sqrt(252);
}

export function calculateUlcerIndex(equityHistory: number[]): number {
  if (equityHistory.length < 2) return 0;
  
  let peak = equityHistory[0];
  let sumSquaredDrawdown = 0;
  
  for (const equity of equityHistory) {
    if (equity > peak) {
      peak = equity;
    }
    const drawdown = ((peak - equity) / peak) * 100;
    sumSquaredDrawdown += drawdown * drawdown;
  }
  
  return Math.sqrt(sumSquaredDrawdown / equityHistory.length);
}

function calculateMaxDrawdown(equityHistory: number[]): number {
  if (equityHistory.length < 2) return 0;
  
  let peak = equityHistory[0];
  let maxDD = 0;
  
  for (const equity of equityHistory) {
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  return maxDD * 100;
}

export function updatePriceHistory(cryptos: CryptoData[]): void {
  const now = Date.now();
  
  for (const crypto of cryptos) {
    if (isStablecoin(crypto.symbol)) continue;
    
    const symbol = crypto.symbol.toLowerCase();
    let history = strategyState.priceHistory.get(symbol);
    
    if (!history) {
      history = {
        symbol,
        prices: [],
        returns: [],
        timestamps: [],
      };
      strategyState.priceHistory.set(symbol, history);
    }
    
    if (history.timestamps.length === 0 || now - history.timestamps[history.timestamps.length - 1] >= 30000) {
      history.prices.push(crypto.current_price);
      history.timestamps.push(now);
      
      if (history.prices.length > LOOKBACK_PERIOD + 1) {
        history.prices.shift();
        history.timestamps.shift();
      }
      
      history.returns = calculateReturns(history.prices);
    }
  }
}

export function findCorrelationPairs(): CorrelationPair[] {
  const pairs: CorrelationPair[] = [];
  const symbols = Array.from(strategyState.priceHistory.keys());
  
  // "Distance Matching" approach: Find the most correlated pairs
  // No strict cointegration needed - just high Pearson correlation (> 0.80)
  // This ensures pairs mode always finds valid hedges (usually BTC/ETH ~0.95)
  
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const sym1 = symbols[i];
      const sym2 = symbols[j];
      
      const history1 = strategyState.priceHistory.get(sym1);
      const history2 = strategyState.priceHistory.get(sym2);
      
      if (!history1 || !history2) continue;
      if (history1.returns.length < 10 || history2.returns.length < 10) continue;
      if (history1.prices.length < 15 || history2.prices.length < 15) continue;
      
      const minLen = Math.min(history1.returns.length, history2.returns.length);
      const returns1 = history1.returns.slice(-minLen);
      const returns2 = history2.returns.slice(-minLen);
      
      const currentCorr = calculateCorrelation(returns1, returns2);
      
      // Only consider pairs with high correlation (> 0.80)
      if (currentCorr < CORRELATION_THRESHOLD) {
        continue;
      }
      
      const halfLen = Math.floor(minLen / 2);
      const historicalCorr = halfLen >= 5 
        ? calculateCorrelation(returns1.slice(0, halfLen), returns2.slice(0, halfLen))
        : currentCorr;
      
      const corrDelta = currentCorr - historicalCorr;
      
      // Calculate spread using price ratios for Z-Score
      const spreadValues: number[] = [];
      const prices1 = history1.prices.slice(-minLen - 1);
      const prices2 = history2.prices.slice(-minLen - 1);
      const pMinLen = Math.min(prices1.length, prices2.length);
      for (let k = 0; k < pMinLen; k++) {
        spreadValues.push(prices1[k] / prices2[k]);
      }
      
      const currentSpread = spreadValues.length > 0 ? spreadValues[spreadValues.length - 1] : 0;
      const zScore = calculateZScore(currentSpread, spreadValues);
      
      pairs.push({
        pair1: sym1,
        pair2: sym2,
        currentCorrelation: currentCorr,
        historicalCorrelation: historicalCorr,
        correlationDelta: corrDelta,
        zScore,
        spreadReturn: currentSpread,
      });
    }
  }
  
  // Sort by correlation first (highest), then by Z-score magnitude for entry
  return pairs.sort((a, b) => {
    // Primary sort: highest correlation
    if (Math.abs(b.currentCorrelation - a.currentCorrelation) > 0.05) {
      return b.currentCorrelation - a.currentCorrelation;
    }
    // Secondary sort: highest |z-score| (most diverged = best entry)
    return Math.abs(b.zScore) - Math.abs(a.zScore);
  });
}

function getCryptoName(symbol: string, cryptos: CryptoData[]): string {
  const crypto = cryptos.find(c => c.symbol.toLowerCase() === symbol.toLowerCase());
  return crypto?.name || symbol.toUpperCase();
}

export async function analyzeCorrelationOpportunities(
  cryptos: CryptoData[]
): Promise<{ signals: any[]; executedTrades: any[] }> {
  const now = Date.now();
  const signals: any[] = [];
  const executedTrades: any[] = [];
  
  if (!strategyState.enabled) {
    return { signals, executedTrades };
  }
  
  if (now - strategyState.lastAnalysis < ANALYSIS_COOLDOWN) {
    return { signals, executedTrades };
  }
  
  strategyState.lastAnalysis = now;
  
  updatePriceHistory(cryptos);
  
  const priceMap = new Map(cryptos.map(c => [c.symbol.toLowerCase(), c.current_price]));
  await updatePositionPrices(priceMap);
  
  const portfolio = getPortfolioState();
  strategyState.equityHistory.push(portfolio.equity);
  if (strategyState.equityHistory.length > 252) {
    strategyState.equityHistory.shift();
  }
  
  if (strategyState.equityHistory.length >= 2) {
    const prevEquity = strategyState.equityHistory[strategyState.equityHistory.length - 2];
    const currEquity = strategyState.equityHistory[strategyState.equityHistory.length - 1];
    const dailyReturn = (currEquity - prevEquity) / prevEquity;
    strategyState.dailyReturns.push(dailyReturn);
    if (strategyState.dailyReturns.length > 252) {
      strategyState.dailyReturns.shift();
    }
  }
  
  for (const pair of [...strategyState.activePairs]) {
    const portfolio = getPortfolioState();
    const longExists = portfolio.positions.some(p => p.id === pair.longPositionId);
    const shortExists = portfolio.positions.some(p => p.id === pair.shortPositionId);

    if (!longExists || !shortExists) {
      const survivorId = longExists ? pair.longPositionId : shortExists ? pair.shortPositionId : null;
      const survivorSymbol = longExists ? pair.longSymbol : shortExists ? pair.shortSymbol : null;
      const closedSymbol = !longExists ? pair.longSymbol : pair.shortSymbol;

      if (survivorId && survivorSymbol) {
        const survivorPrice = priceMap.get(survivorSymbol);
        const survivorPos = portfolio.positions.find(p => p.id === survivorId);
        const closePrice = survivorPrice || survivorPos?.currentPrice;
        if (closePrice) {
          console.log(`[PAIR ORPHAN] ${closedSymbol} leg already closed - closing orphan ${survivorSymbol}`);
          const result = await closePosition(survivorId, closePrice, "closed", `Pair Orphan - Partner ${closedSymbol} stopped out`);
          if (result) {
            executedTrades.push({ type: longExists ? 'close_long' : 'close_short', symbol: survivorSymbol, reason: 'orphan_cleanup' });
          }
        }
      }

      const orphanPairKey = [pair.longSymbol, pair.shortSymbol].sort().join('-');
      pairCooldowns.set(orphanPairKey, Date.now() + PAIR_COOLDOWN_MS);
      console.log(`[Pairs PAIR-COOLDOWN] SET ${orphanPairKey}: 15min cooldown after orphan close`);
      strategyState.activePairs = strategyState.activePairs.filter(p => p.pairId !== pair.pairId);
      continue;
    }

    const history1 = strategyState.priceHistory.get(pair.longSymbol);
    const history2 = strategyState.priceHistory.get(pair.shortSymbol);
    
    if (!history1 || !history2) continue;
    
    const minLen = Math.min(history1.prices.length, history2.prices.length);
    if (minLen < 5) continue;
    
    // Use price ratio spreads (consistent with findCorrelationPairs entry logic)
    const spreadValues: number[] = [];
    const prices1 = history1.prices.slice(-minLen);
    const prices2 = history2.prices.slice(-minLen);
    for (let k = 0; k < minLen; k++) {
      spreadValues.push(prices1[k] / prices2[k]);
    }
    
    const currentSpread = spreadValues[spreadValues.length - 1] || 0;
    const zScore = calculateZScore(currentSpread, spreadValues);
    
    // Per Mike1 spec: BROKEN LEASH check - correlation failure kill switch
    // Exit immediately if z-score exceeds 3.5 (correlation breakdown)
    if (isBrokenLeash(zScore)) {
      const blPairKey = [pair.longSymbol, pair.shortSymbol].sort().join('-');
      pairCooldowns.set(blPairKey, Date.now() + PAIR_COOLDOWN_MS);
      console.log(`[BROKEN LEASH] Force closing ${pair.longSymbol}/${pair.shortSymbol} z=${zScore.toFixed(2)} | 15min pair cooldown set`);
      
      if (pair.longPositionId) {
        const longPrice = priceMap.get(pair.longSymbol);
        if (longPrice) {
          const longResult = await closePosition(pair.longPositionId, longPrice, "stopped_out", `Broken Leash z=${zScore.toFixed(2)} - Correlation Failure`);
          if (longResult) {
            executedTrades.push({ type: 'close_long', symbol: pair.longSymbol, reason: 'broken_leash' });
          }
        }
      }
      if (pair.shortPositionId) {
        const shortPrice = priceMap.get(pair.shortSymbol);
        if (shortPrice) {
          const shortResult = await closePosition(pair.shortPositionId, shortPrice, "stopped_out", `Broken Leash z=${zScore.toFixed(2)} - Correlation Failure`);
          if (shortResult) {
            executedTrades.push({ type: 'close_short', symbol: pair.shortSymbol, reason: 'broken_leash' });
          }
        }
      }
      
      strategyState.activePairs = strategyState.activePairs.filter(p => p.pairId !== pair.pairId);
      continue;
    }
    
    // Normal exit: z-score reverted to mean
    if (Math.abs(zScore) < ZSCORE_EXIT) {
      console.log(`[Correlation Strategy] Closing pair ${pair.longSymbol}/${pair.shortSymbol} - z-score reverted to ${zScore.toFixed(2)}`);
      
      if (pair.longPositionId) {
        const longPrice = priceMap.get(pair.longSymbol);
        if (longPrice) {
          const longResult = await closePosition(pair.longPositionId, longPrice, "closed", `Spread Reversion z=${zScore.toFixed(2)} - Pair Trade Profit`);
          if (longResult) {
            executedTrades.push({ type: 'close_long', symbol: pair.longSymbol, reason: 'spread_reversion' });
          }
        }
      }
      if (pair.shortPositionId) {
        const shortPrice = priceMap.get(pair.shortSymbol);
        if (shortPrice) {
          const shortResult = await closePosition(pair.shortPositionId, shortPrice, "closed", `Spread Reversion z=${zScore.toFixed(2)} - Pair Trade Profit`);
          if (shortResult) {
            executedTrades.push({ type: 'close_short', symbol: pair.shortSymbol, reason: 'spread_reversion' });
          }
        }
      }
      
      strategyState.activePairs = strategyState.activePairs.filter(p => p.pairId !== pair.pairId);
    }
  }
  
  if (strategyState.activePairs.length >= MAX_PAIRS) {
    return { signals, executedTrades };
  }
  
  const correlationPairs = findCorrelationPairs();
  
  for (const pair of correlationPairs) {
    if (strategyState.activePairs.length >= MAX_PAIRS) break;
    
    const alreadyTrading = strategyState.activePairs.some(
      p => (p.longSymbol === pair.pair1 && p.shortSymbol === pair.pair2) ||
           (p.longSymbol === pair.pair2 && p.shortSymbol === pair.pair1)
    );
    
    if (alreadyTrading) continue;
    
    if (Math.abs(pair.zScore) >= ZSCORE_ENTRY) {
      const longSymbol = pair.zScore < 0 ? pair.pair1 : pair.pair2;
      const shortSymbol = pair.zScore < 0 ? pair.pair2 : pair.pair1;
      
      // PER-PAIR COOLDOWN: prevent retrying same pair after failure/close
      const pairKey = [longSymbol, shortSymbol].sort().join('-');
      const pairCooldownExpiry = pairCooldowns.get(pairKey) || 0;
      if (Date.now() < pairCooldownExpiry) {
        const remainMin = ((pairCooldownExpiry - Date.now()) / 60000).toFixed(1);
        console.log(`[Pairs PAIR-COOLDOWN] SKIP ${longSymbol}/${shortSymbol} - ${remainMin}min remaining`);
        continue;
      }
      
      // PRE-CHECK BOTH SYMBOLS' COOLDOWNS before opening either leg
      // This eliminates atomic rollbacks where short opens but long is blocked
      const longCooldown = isSymbolOnCooldown(longSymbol);
      const shortCooldown = isSymbolOnCooldown(shortSymbol);
      if (longCooldown.onCooldown || shortCooldown.onCooldown) {
        const blocked = longCooldown.onCooldown ? longSymbol : shortSymbol;
        const remainSec = Math.ceil(Math.max(longCooldown.remainingMs, shortCooldown.remainingMs) / 1000);
        console.log(`[Pairs PRE-CHECK] SKIP ${longSymbol}/${shortSymbol} - ${blocked} on cooldown (${remainSec}s remaining)`);
        continue;
      }
      
      // TOP 15 ENFORCEMENT for pairs trading
      if (!isSymbolInTop15(longSymbol) || !isSymbolInTop15(shortSymbol)) {
        console.log(`[Pairs] SKIP ${longSymbol}/${shortSymbol} - not both in top 15`);
        continue;
      }
      
      const longPrice = priceMap.get(longSymbol);
      const shortPrice = priceMap.get(shortSymbol);
      
      if (!longPrice || !shortPrice) continue;
      
      // COINTEGRATION CHECK: Require statistical mean-reversion evidence
      const longHistory = strategyState.priceHistory.get(longSymbol);
      const shortHistory = strategyState.priceHistory.get(shortSymbol);
      
      if (longHistory && shortHistory && longHistory.prices.length >= 20 && shortHistory.prices.length >= 20) {
        const cointResult = testCointegration(longHistory.prices, shortHistory.prices);
        if (!cointResult.isCointegrated) {
          console.log(`[Pairs COINT-REJECT] SKIP ${longSymbol}/${shortSymbol} - not cointegrated (p=${cointResult.pValue.toFixed(3)}, ADF=${cointResult.adfStatistic.toFixed(3)})`);
          continue;
        }
      }
      
      let hedgeRatio = 1.0;
      if (longHistory && shortHistory && longHistory.prices.length >= 10) {
        const olsResult = calculateOLSHedgeRatio(longHistory.prices, shortHistory.prices);
        if (olsResult.rSquared > 0.3) {
          hedgeRatio = Math.abs(olsResult.beta);
          hedgeRatio = Math.min(Math.max(hedgeRatio, 0.5), 2.0);
        }
      }
      
      // Per Mike1 spec: Use hedge ratio (β) for position sizing
      // Short $β of X for every $1.00 Long of Y
      const baseLongSize = 0.03; // 3% of equity for long leg
      const adjustedShortSize = baseLongSize * hedgeRatio; // β-weighted short size

      const longEstimate = estimatePositionValue(longPrice, baseLongSize);
      const shortEstimate = estimatePositionValue(shortPrice, adjustedShortSize);
      const maxPosValue = getMaxPositionValue();
      if (longEstimate > maxPosValue || shortEstimate > maxPosValue) {
        console.log(`[Pairs PRE-CHECK] SKIP ${longSymbol}/${shortSymbol}: leg would exceed max (long=$${longEstimate.toFixed(2)}, short=$${shortEstimate.toFixed(2)}, max=$${maxPosValue.toFixed(2)})`);
        continue;
      }

      signals.push({
        type: 'correlation_pair',
        longSymbol: longSymbol.toUpperCase(),
        shortSymbol: shortSymbol.toUpperCase(),
        zScore: pair.zScore,
        correlation: pair.currentCorrelation,
        correlationDelta: pair.correlationDelta,
        confidence: Math.min(1, Math.abs(pair.zScore) / 3),
        hedgeRatio,
      });
      
      console.log(`[Correlation Strategy] Opening pair: Long ${longSymbol.toUpperCase()}, Short ${shortSymbol.toUpperCase()}`);
      console.log(`  Z-Score: ${pair.zScore.toFixed(2)}, Correlation: ${pair.currentCorrelation.toFixed(2)}, Hedge β: ${hedgeRatio.toFixed(3)}`);
      
      const pairOpenReason = `Pairs Trading | z=${pair.zScore.toFixed(2)} | corr=${pair.currentCorrelation.toFixed(2)} | β=${hedgeRatio.toFixed(3)}`;
      
      const longSignal: AITradeSignal = {
        symbol: longSymbol,
        coinName: getCryptoName(longSymbol, cryptos),
        action: 'buy',
        side: 'long',
        confidence: Math.min(1, Math.abs(pair.zScore) / 3),
        targetEntry: longPrice,
        stopLoss: longPrice * 0.95,
        takeProfit: longPrice * 1.03,
        riskRewardRatio: 0.6,
        positionSize: baseLongSize,
        reasoning: `Correlation pair trade: z-score ${pair.zScore.toFixed(2)}, hedge β=${hedgeRatio.toFixed(3)}`,
        signalMode: 'pairsTrading',
        openReason: `${pairOpenReason} | LONG leg`,
        signals: {
          correlation: pair.currentCorrelation,
        },
        timestamp: new Date().toISOString(),
      };
      
      const shortSignal: AITradeSignal = {
        symbol: shortSymbol,
        coinName: getCryptoName(shortSymbol, cryptos),
        action: 'sell',
        side: 'short',
        confidence: Math.min(1, Math.abs(pair.zScore) / 3),
        targetEntry: shortPrice,
        stopLoss: shortPrice * 1.05,
        takeProfit: shortPrice * 0.97,
        riskRewardRatio: 0.6,
        positionSize: adjustedShortSize,
        reasoning: `Correlation pair trade: z-score ${pair.zScore.toFixed(2)}, hedge β=${hedgeRatio.toFixed(3)}`,
        signalMode: 'pairsTrading',
        openReason: `${pairOpenReason} | SHORT leg`,
        signals: {
          correlation: pair.currentCorrelation,
        },
        timestamp: new Date().toISOString(),
      };
      
      // ATOMIC PAIR EXECUTION: SHORT first (hard leg), then LONG
      // Short leg is more likely to fail (cooldowns, margin, borrow constraints)
      // Opening it first avoids wasteful rollbacks of the long leg
      const pairId = `${longSymbol}-${shortSymbol}-${Date.now()}`;
      longSignal.pairId = pairId;
      shortSignal.pairId = pairId;

      const shortResult = await openPosition(shortSignal);
      if (!shortResult) {
        console.log(`[Pairs ATOMIC] ABORT: Short ${shortSymbol} failed - skipping pair entirely`);
        pairCooldowns.set(pairKey, Date.now() + PAIR_COOLDOWN_MS);
        continue;
      }
      
      const longResult = await openPosition(longSignal);
      if (!longResult) {
        console.log(`[Pairs ATOMIC] Long ${longSymbol} failed - CLOSING short ${shortSymbol} to prevent naked position`);
        const shortPriceNow = priceMap.get(shortSymbol);
        if (shortPriceNow) {
          await closePosition(shortResult.id, shortPriceNow, "closed", `Atomic Rollback - Long ${longSymbol} leg failed`);
        }
        pairCooldowns.set(pairKey, Date.now() + PAIR_COOLDOWN_MS);
        console.log(`[Pairs PAIR-COOLDOWN] SET ${pairKey}: 15min cooldown after atomic rollback`);
        continue;
      }
      
      console.log(`[Pairs ATOMIC] SUCCESS: Both legs opened for pair ${pairId}`);
      
      persistPairPositions(pairId);
      
      // Both legs opened successfully
      strategyState.activePairs.push({
        pairId,
        longSymbol,
        shortSymbol,
        longPositionId: longResult.id,
        shortPositionId: shortResult.id,
        entrySpread: pair.spreadReturn,
        entryTime: new Date().toISOString(),
        targetSpread: 0,
        hedgeRatio,
        entryZScore: pair.zScore,
      });
      
      executedTrades.push({ 
        type: 'open_long', 
        symbol: longSymbol, 
        price: longResult.entryPrice,
        reason: 'correlation_divergence',
        hedgeRatio,
      });
      executedTrades.push({ 
        type: 'open_short', 
        symbol: shortSymbol, 
        price: shortResult.entryPrice,
        reason: 'correlation_divergence',
        hedgeRatio,
      });
    }
  }
  
  return { signals, executedTrades };
}

export function getCorrelationStrategyMetrics(): StrategyMetrics {
  const allTrades = getTrades();
  const correlationTrades = allTrades.filter(t => 
    t.aiReasoning?.includes('Correlation pair') || t.aiReasoning?.includes('correlation')
  );
  const winningTrades = correlationTrades.filter(t => (t.pnl || 0) > 0);
  
  const sharpeRatio = calculateSharpeRatio(strategyState.dailyReturns);
  const ulcerIndex = calculateUlcerIndex(strategyState.equityHistory);
  
  const sharpeUlcerRatio = ulcerIndex > 0 ? sharpeRatio / ulcerIndex : sharpeRatio;
  
  const totalReturn = strategyState.equityHistory.length > 0
    ? ((strategyState.equityHistory[strategyState.equityHistory.length - 1] - 100) / 100) * 100
    : 0;
  
  const daysTrading = strategyState.dailyReturns.length || 1;
  const annualizedReturn = totalReturn * (252 / daysTrading);
  
  const maxDrawdown = calculateMaxDrawdown(strategyState.equityHistory);
  
  let totalHoldingMs = 0;
  for (const trade of correlationTrades) {
    if (trade.openedAt && trade.closedAt) {
      const openTime = new Date(trade.openedAt).getTime();
      const closeTime = new Date(trade.closedAt).getTime();
      totalHoldingMs += closeTime - openTime;
    }
  }
  const avgHoldingPeriodHours = correlationTrades.length > 0 ? (totalHoldingMs / correlationTrades.length) / (1000 * 60 * 60) : 0;
  
  return {
    sharpeRatio,
    ulcerIndex,
    sharpeUlcerRatio,
    totalReturn,
    annualizedReturn,
    maxDrawdown,
    winRate: correlationTrades.length > 0 ? (winningTrades.length / correlationTrades.length) * 100 : 0,
    totalTrades: correlationTrades.length,
    avgHoldingPeriodHours,
  };
}

export function getOverallRiskMetrics(): StrategyMetrics {
  const allTrades = getTrades();
  const winningTrades = allTrades.filter(t => (t.pnl || 0) > 0);
  
  const sharpeRatio = calculateSharpeRatio(strategyState.dailyReturns);
  const ulcerIndex = calculateUlcerIndex(strategyState.equityHistory);
  const sharpeUlcerRatio = ulcerIndex > 0 ? sharpeRatio / ulcerIndex : sharpeRatio;
  
  const portfolio = getPortfolioState();
  const totalReturn = ((portfolio.equity - 100) / 100) * 100;
  
  const daysTrading = strategyState.dailyReturns.length || 1;
  const annualizedReturn = totalReturn * (252 / daysTrading);
  
  const maxDrawdown = calculateMaxDrawdown(strategyState.equityHistory);
  
  let totalHoldingMs = 0;
  for (const trade of allTrades) {
    if (trade.openedAt && trade.closedAt) {
      const openTime = new Date(trade.openedAt).getTime();
      const closeTime = new Date(trade.closedAt).getTime();
      totalHoldingMs += closeTime - openTime;
    }
  }
  const avgHoldingPeriodHours = allTrades.length > 0 ? (totalHoldingMs / allTrades.length) / (1000 * 60 * 60) : 0;
  
  return {
    sharpeRatio,
    ulcerIndex,
    sharpeUlcerRatio,
    totalReturn,
    annualizedReturn,
    maxDrawdown,
    winRate: allTrades.length > 0 ? (winningTrades.length / allTrades.length) * 100 : 0,
    totalTrades: allTrades.length,
    avgHoldingPeriodHours,
  };
}

export function enableCorrelationStrategy(): void {
  strategyState.enabled = true;
  console.log("[Correlation Strategy] Enabled");
}

export function disableCorrelationStrategy(): void {
  strategyState.enabled = false;
  console.log("[Correlation Strategy] Disabled");
}

export function isCorrelationStrategyEnabled(): boolean {
  return strategyState.enabled;
}

export function getActivePairs(): PairPosition[] {
  return strategyState.activePairs;
}

export function getCorrelationMatrix(): CorrelationPair[] {
  return findCorrelationPairs().slice(0, 10);
}

export function getEquityHistory(): number[] {
  return strategyState.equityHistory;
}

export function getDailyReturns(): number[] {
  return strategyState.dailyReturns;
}

// Get price history maps for dynamic order updates
export function getPriceHistoryMaps(): { 
  priceHistory: Map<string, number[]>;
  atrMap: Map<string, number>;
  volatilityMap: Map<string, number>;
} {
  const priceHistory = new Map<string, number[]>();
  const atrMap = new Map<string, number>();
  const volatilityMap = new Map<string, number>();
  
  strategyState.priceHistory.forEach((history, symbol) => {
    if (history.prices.length >= 10) {
      priceHistory.set(symbol, [...history.prices]);
      
      // Calculate ATR from price history (using close-to-close as proxy)
      const prices = history.prices;
      const trueRanges: number[] = [];
      for (let i = 1; i < prices.length; i++) {
        const priceChange = Math.abs(prices[i] - prices[i - 1]);
        // Multiply by 1.5 to approximate intraday high-low from close-to-close
        trueRanges.push(priceChange * 1.5);
      }
      if (trueRanges.length >= 14) {
        const atr = trueRanges.slice(-14).reduce((a, b) => a + b, 0) / 14;
        atrMap.set(symbol, atr);
      }
      
      // Calculate volatility from returns
      if (history.returns.length >= 10) {
        const recentReturns = history.returns.slice(-20);
        const mean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
        const variance = recentReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / recentReturns.length;
        const volatility = Math.sqrt(variance);
        volatilityMap.set(symbol, volatility);
      }
    }
  });
  
  return { priceHistory, atrMap, volatilityMap };
}
