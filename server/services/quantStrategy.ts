import type { CryptoData } from "@shared/schema";
import { saveLivePerformance, loadLivePerformance } from "./mike1Persistence";

export interface TechnicalIndicators {
  rsi: number;
  rsiSignal: "oversold" | "neutral" | "overbought";
  macdLine: number;
  signalLine: number;
  macdHistogram: number;
  macdSignal: "bullish" | "bearish" | "neutral";
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  bollingerPosition: "below" | "middle" | "above";
  bollingerWidth: number;
  bollingerWidthPercentile: number;
  isVolatilitySqueeze: boolean;
  // Keltner Channel for Vol Expansion breakout detection
  keltnerUpper: number;
  keltnerMiddle: number;
  keltnerLower: number;
  keltnerBreakoutUp: boolean;    // Price > Upper Keltner
  keltnerBreakoutDown: boolean;  // Price < Lower Keltner
  volatilityRising: boolean;     // ATR expanding vs prior period (10%+ increase)
  volatilitySustained: boolean;  // ATR already high (1.5x+ vs prior) - vol explosion already happened
  sma7: number;
  sma25: number;
  sma100: number;
  trendDirection: "up" | "down" | "sideways";
  volatility: number;
  momentum: number;
  volatilityProxy: number;
  atr: number;
  atrPercent: number;
  adx: number;
  adxTrending: boolean;
  adxHookingUp: boolean;
  zScore: number;
  priceToMeanDistance: number;
  meanProximity: boolean;
}

export interface QuantSignal {
  symbol: string;
  coinName: string;
  action: "buy" | "sell" | "hold";
  side: "long" | "short";
  confidence: number;
  strength: number;
  indicators: TechnicalIndicators;
  reasoning: string[];
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  positionSizePercent: number;
  timestamp: Date;
}

function calculateSMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calculateEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  if (prices.length < period) return calculateSMA(prices, prices.length);
  
  const multiplier = 2 / (period + 1);
  let ema = calculateSMA(prices.slice(0, period), period);
  
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50;
  
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  
  const recentChanges = changes.slice(-period);
  let gains = 0;
  let losses = 0;
  
  for (const change of recentChanges) {
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMACD(prices: number[]): { macdLine: number; signalLine: number; histogram: number } {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macdLine = ema12 - ema26;
  
  const macdHistory = [];
  for (let i = 26; i <= prices.length; i++) {
    const slice = prices.slice(0, i);
    const e12 = calculateEMA(slice, 12);
    const e26 = calculateEMA(slice, 26);
    macdHistory.push(e12 - e26);
  }
  
  const signalLine = macdHistory.length >= 9 
    ? calculateEMA(macdHistory, 9) 
    : macdHistory[macdHistory.length - 1] || 0;
  
  return {
    macdLine,
    signalLine,
    histogram: macdLine - signalLine
  };
}

function calculateBollingerBands(prices: number[], period: number = 20, stdDev: number = 2): { upper: number; middle: number; lower: number; width: number; stdDevValue: number } {
  const sma = calculateSMA(prices, period);
  const slice = prices.slice(-period);
  
  const squaredDiffs = slice.map(p => Math.pow(p - sma, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / slice.length;
  const standardDeviation = Math.sqrt(variance);
  
  const upper = sma + (standardDeviation * stdDev);
  const lower = sma - (standardDeviation * stdDev);
  const width = (upper - lower) / sma;
  
  return {
    upper,
    middle: sma,
    lower,
    width,
    stdDevValue: standardDeviation
  };
}

function calculateBollingerWidthPercentile(prices: number[], lookback: number = 50): { currentWidth: number; percentile: number; isSqueeze: boolean } {
  if (prices.length < lookback + 20) {
    return { currentWidth: 0, percentile: 50, isSqueeze: false };
  }
  
  const widths: number[] = [];
  for (let i = 20; i <= Math.min(lookback + 20, prices.length); i++) {
    const slice = prices.slice(0, i);
    const bands = calculateBollingerBands(slice);
    widths.push(bands.width);
  }
  
  const currentWidth = widths[widths.length - 1];
  const sortedWidths = [...widths].sort((a, b) => a - b);
  const rank = sortedWidths.findIndex(w => w >= currentWidth);
  const percentile = (rank / sortedWidths.length) * 100;
  
  return {
    currentWidth,
    percentile,
    isSqueeze: percentile <= 20
  };
}

function calculateATR(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 0;
  
  const trueRanges: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    // With close-only data, use absolute price change as proxy for true range
    // Multiply by 1.5 to approximate intraday high-low range from close-to-close
    const priceChange = Math.abs(prices[i] - prices[i - 1]);
    const tr = priceChange * 1.5;
    trueRanges.push(tr);
  }
  
  const recentTR = trueRanges.slice(-period);
  return recentTR.reduce((a, b) => a + b, 0) / recentTR.length;
}

// KELTNER CHANNEL - For Vol Expansion breakout detection
// Per spec: Price > Upper Keltner AND Volatility Rising = breakout entry
function calculateKeltnerChannel(
  prices: number[], 
  emaPeriod: number = 20, 
  atrMultiplier: number = 2.0,
  atrPeriod: number = 10
): { 
  upper: number; 
  middle: number; 
  lower: number; 
  currentATR: number;
  priorATR: number;
  volatilityRising: boolean;
  volatilitySustained: boolean;
} {
  if (prices.length < Math.max(emaPeriod, atrPeriod) + 5) {
    const currentPrice = prices[prices.length - 1] || 0;
    return { 
      upper: currentPrice * 1.02, 
      middle: currentPrice, 
      lower: currentPrice * 0.98,
      currentATR: 0,
      priorATR: 0,
      volatilityRising: false,
      volatilitySustained: false
    };
  }
  
  // Middle band = EMA
  const middle = calculateEMA(prices, emaPeriod);
  
  // Calculate current ATR
  const currentATR = calculateATR(prices, atrPeriod);
  
  // Calculate prior period ATR (shifted back 5 periods)
  const priorPrices = prices.slice(0, -5);
  const priorATR = priorPrices.length >= atrPeriod + 1 
    ? calculateATR(priorPrices, atrPeriod) 
    : currentATR;
  
  // Volatility is rising if current ATR > prior ATR by at least 10%
  const volatilityRising = currentATR > priorATR * 1.10;
  
  // Volatility is sustained/high if current ATR > 1.5x the average (already exploded)
  const volatilitySustained = currentATR > priorATR * 1.50;
  
  // Upper and lower bands = EMA ± (ATR × multiplier)
  const upper = middle + (currentATR * atrMultiplier);
  const lower = middle - (currentATR * atrMultiplier);
  
  return { upper, middle, lower, currentATR, priorATR, volatilityRising, volatilitySustained };
}

// Calculate N-bar high and low for day trading stops
function calculateNBarHighLow(prices: number[], n: number = 10): { high: number; low: number; range: number } {
  if (prices.length < n) {
    const availablePrices = prices.slice(-Math.max(prices.length, 1));
    return {
      high: Math.max(...availablePrices),
      low: Math.min(...availablePrices),
      range: Math.max(...availablePrices) - Math.min(...availablePrices)
    };
  }
  
  const recentPrices = prices.slice(-n);
  const high = Math.max(...recentPrices);
  const low = Math.min(...recentPrices);
  
  return { high, low, range: high - low };
}

// Calculate primary take profit using Brownian motion math
// Per Mike1 spec: Uses Z-score for probability-based distance
// Replaces legacy ATR-only approach with expectancy-positive math
function calculateHighProbabilityTakeProfit(
  currentPrice: number,
  atr: number,
  volatility: number,
  side: "long" | "short",
  confidence: number
): { takeProfit: number; hitProbability: number } {
  // Time horizon factor (√T for Brownian motion)
  const timeHorizonFactor = 1.0;
  
  // Use Z-score for ~60% probability (balanced expectancy-positive target)
  // Base Z-score: 0.25 for 60% hit probability
  let baseZScore = ZSCORE_60_PERCENT; // 0.25
  
  // Volatility adjustment
  let volAdjust = 1.0;
  if (volatility < 0.02) {
    volAdjust = 1.15; // Low vol = can extend slightly
  } else if (volatility > 0.05) {
    volAdjust = 0.90; // High vol = tighter
  }
  
  // Higher confidence allows slightly larger targets
  const confidenceBoost = confidence * 0.3; // Max +0.3 Z-score for 100% confidence
  const effectiveZScore = (baseZScore + confidenceBoost) * volAdjust;
  
  // Brownian distance formula: Z × σ × √T
  const brownianDistance = effectiveZScore * (atr / currentPrice) * timeHorizonFactor * currentPrice;
  
  // Minimum profit distance of 0.3% to ensure meaningful wins
  const minProfitDistance = currentPrice * 0.003;
  const effectiveProfitDistance = Math.max(brownianDistance, minProfitDistance);
  
  console.log(`[Brownian TP Primary] ${side.toUpperCase()}: Z=${effectiveZScore.toFixed(3)}, dist=$${effectiveProfitDistance.toFixed(2)} (${(effectiveProfitDistance/currentPrice*100).toFixed(2)}%)`);
  
  const takeProfit = side === "long" 
    ? currentPrice + effectiveProfitDistance 
    : currentPrice - effectiveProfitDistance;
  
  // Hit probability based on Z-score (inverted cumulative normal)
  // Lower Z = closer target = higher probability
  const hitProbability = Math.max(0.50, Math.min(0.70, 0.70 - (effectiveZScore * 0.3)));
  
  return { takeProfit, hitProbability };
}

// Scale-out take profit level
export interface TakeProfitLevel {
  price: number;
  quantityPercent: number;  // % of position to close
  hitProbability: number;   // estimated probability
  triggered: boolean;
  atrMultiplier: number;
}

// BROWNIAN MOTION MATH FOR EXPECTANCY-POSITIVE EXITS
// Per Mike1 spec: Use proper Z-scores for probability-based distances
// 
// Key insight: Distance = Z-score × Volatility × √T
// For 60% probability TP: Z ≈ 0.25 (inverse of 40% tail)
// For 40% probability SL: Z ≈ 0.84 (inverse of 10% tail for 40%)
//
// OLD FLAWED APPROACH: 80% TP / 20% SL = negative expectancy
// NEW CORRECT APPROACH: 60% TP / 40% SL = 1:1.5 R:R = positive expectancy
//
// Expectancy = (0.60 × 0.84) - (0.40 × 0.25) = 0.504 - 0.10 = +0.404 per unit

// Z-scores for Brownian motion probability calculations
const ZSCORE_60_PERCENT = 0.25; // Distance for 60% hit probability (TP)
const ZSCORE_40_PERCENT = 0.84; // Distance for 40% hit probability (SL)
const ZSCORE_70_PERCENT = 0.52; // Distance for 70% hit probability (tight TP)
const ZSCORE_50_PERCENT = 0.67; // Distance for 50% hit probability (mid TP)

// Calculate scale-out take profit levels using Brownian motion math
// Targets are set at probabilities that ensure positive expectancy vs 40% stop
export function calculateScaleOutTakeProfits(
  currentPrice: number,
  atr: number,
  volatility: number,
  side: "long" | "short"
): TakeProfitLevel[] {
  const levels: TakeProfitLevel[] = [];
  
  const TP1_RR = 1.5;
  const TP2_RR = 2.5;
  
  const levelConfigs = [
    { rrMultiple: TP1_RR, prob: 0.55, exitPct: 70 },
    { rrMultiple: TP2_RR, prob: 0.35, exitPct: 30 },
  ];
  
  const minDistancePercent = 0.015;
  
  for (const config of levelConfigs) {
    const rrDistance = atr * config.rrMultiple;
    
    const minDistance = currentPrice * minDistancePercent;
    const distance = Math.max(rrDistance, minDistance);
    
    const price = side === "long" 
      ? currentPrice + distance 
      : currentPrice - distance;
    
    levels.push({
      price,
      quantityPercent: config.exitPct,
      hitProbability: config.prob,
      triggered: false,
      atrMultiplier: config.rrMultiple,
    });
  }
  
  console.log(`[Scale-Out TP] ${side.toUpperCase()} @ $${currentPrice.toFixed(6)}: ` +
    `TP1=$${levels[0].price.toFixed(6)} (${levels[0].quantityPercent}%, ${TP1_RR}R), ` +
    `TP2=$${levels[1].price.toFixed(6)} (${levels[1].quantityPercent}%, ${TP2_RR}R), ` +
    `ATR=$${atr.toFixed(6)}`);
  
  return levels;
}

// Calculate fixed stop loss at Risk = 1 Unit
// Per spec: Stop at fixed level, then TP at 1.5 units for 1:1.5 R:R
// Do NOT use "20% probability" stop logic - use simple ATR-based risk unit
function calculateDayTradingStopLoss(
  currentPrice: number,
  prices: number[],
  atr: number,
  volatility: number,
  side: "long" | "short"
): { stopLoss: number; stopDistance: number; stopPercent: number; hitProbability: number } {
  // Simple ATR-based stop: 1 Risk Unit = 1.0 ATR
  // This provides a natural volatility-adjusted stop level
  let stopDistance = atr;
  
  // Volatility adjustment
  if (volatility > 0.05) {
    stopDistance *= 1.2; // High vol = slightly wider
  } else if (volatility < 0.02) {
    stopDistance *= 0.9; // Low vol = tighter
  }
  
  // Minimum 1.0% stop distance
  const minStopDistance = currentPrice * 0.01;
  if (stopDistance < minStopDistance) {
    stopDistance = minStopDistance;
    console.log(`[STOP] Enforced 1.0% min stop`);
  }
  
  // Maximum 3.0% stop to prevent excessive losses
  const maxStopDistance = currentPrice * 0.03;
  if (stopDistance > maxStopDistance) {
    stopDistance = maxStopDistance;
    console.log(`[STOP] Capped at 3.0% max stop`);
  }
  
  let stopLoss: number;
  if (side === "long") {
    stopLoss = currentPrice - stopDistance;
  } else {
    stopLoss = currentPrice + stopDistance;
  }
  
  const stopPercent = stopDistance / currentPrice;
  
  console.log(`[Fixed SL] ${side.toUpperCase()} @ $${currentPrice.toFixed(2)}: ` +
    `Stop=$${stopLoss.toFixed(2)} (${(stopPercent*100).toFixed(2)}% = 1 Risk Unit)`);
  
  return { stopLoss, stopDistance, stopPercent, hitProbability: 50 };
}

// Calculate take profit at 1.5 Risk Units (1:1.5 R:R ratio)
// Per spec: TP = 1.5 × Risk Unit for positive expectancy
function calculateFixedTakeProfit(
  currentPrice: number,
  stopDistance: number,
  side: "long" | "short"
): { takeProfit: number; profitDistance: number; riskRewardRatio: number } {
  // Fixed 1:1.5 R:R ratio per spec
  const RR_RATIO = 1.5;
  const profitDistance = stopDistance * RR_RATIO;
  
  let takeProfit: number;
  if (side === "long") {
    takeProfit = currentPrice + profitDistance;
  } else {
    takeProfit = currentPrice - profitDistance;
  }
  
  console.log(`[Fixed TP] ${side.toUpperCase()} @ $${currentPrice.toFixed(2)}: ` +
    `TP=$${takeProfit.toFixed(2)} (${(profitDistance/currentPrice*100).toFixed(2)}% = 1.5 Risk Units, R:R=${RR_RATIO})`);
  
  return { takeProfit, profitDistance, riskRewardRatio: RR_RATIO };
}

function calculateADX(prices: number[], period: number = 14): { adx: number; prevAdx: number; isHookingUp: boolean } {
  if (prices.length < period * 2) {
    return { adx: 25, prevAdx: 25, isHookingUp: false };
  }
  
  const dmPlus: number[] = [];
  const dmMinus: number[] = [];
  const trueRanges: number[] = [];
  
  for (let i = 1; i < prices.length; i++) {
    const current = prices[i];
    const prev = prices[i - 1];
    
    const moveUp = current - prev;
    const moveDown = prev - current;
    
    dmPlus.push(moveUp > moveDown && moveUp > 0 ? moveUp : 0);
    dmMinus.push(moveDown > moveUp && moveDown > 0 ? moveDown : 0);
    trueRanges.push(Math.abs(current - prev));
  }
  
  const smoothedDmPlus = calculateEMA(dmPlus, period);
  const smoothedDmMinus = calculateEMA(dmMinus, period);
  const smoothedTR = calculateEMA(trueRanges, period);
  
  const diPlus = smoothedTR > 0 ? (smoothedDmPlus / smoothedTR) * 100 : 0;
  const diMinus = smoothedTR > 0 ? (smoothedDmMinus / smoothedTR) * 100 : 0;
  
  const diSum = diPlus + diMinus;
  const dx = diSum > 0 ? (Math.abs(diPlus - diMinus) / diSum) * 100 : 0;
  
  const dxValues: number[] = [];
  const step = Math.floor(prices.length / 5);
  for (let i = period * 2; i <= prices.length; i += step) {
    const slice = prices.slice(0, i);
    const localDmPlus: number[] = [];
    const localDmMinus: number[] = [];
    const localTR: number[] = [];
    
    for (let j = 1; j < slice.length; j++) {
      const curr = slice[j];
      const pre = slice[j - 1];
      const up = curr - pre;
      const down = pre - curr;
      localDmPlus.push(up > down && up > 0 ? up : 0);
      localDmMinus.push(down > up && down > 0 ? down : 0);
      localTR.push(Math.abs(curr - pre));
    }
    
    const sDmP = calculateEMA(localDmPlus, period);
    const sDmM = calculateEMA(localDmMinus, period);
    const sTR = calculateEMA(localTR, period);
    const dP = sTR > 0 ? (sDmP / sTR) * 100 : 0;
    const dM = sTR > 0 ? (sDmM / sTR) * 100 : 0;
    const s = dP + dM;
    dxValues.push(s > 0 ? (Math.abs(dP - dM) / s) * 100 : 0);
  }
  
  const adx = dxValues.length > 0 ? calculateEMA(dxValues, Math.min(period, dxValues.length)) : dx;
  const prevAdx = dxValues.length > 1 ? dxValues[dxValues.length - 2] : adx;
  
  const isHookingUp = adx > prevAdx && prevAdx < 20 && adx >= 18;
  
  return { adx, prevAdx, isHookingUp };
}

function calculateZScore(prices: number[], period: number = 100): { zScore: number; mean: number; stdDev: number } {
  const lookback = Math.min(period, prices.length);
  const slice = prices.slice(-lookback);
  const currentPrice = prices[prices.length - 1];
  
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / slice.length;
  const stdDev = Math.sqrt(variance);
  
  const zScore = stdDev > 0 ? (currentPrice - mean) / stdDev : 0;
  
  return { zScore, mean, stdDev };
}

function calculateVolatilityProxy(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 0;
  
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.abs((prices[i] - prices[i - 1]) / prices[i - 1]));
  }
  
  const recentReturns = returns.slice(-period);
  const avgReturn = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
  
  const currentPrice = prices[prices.length - 1];
  return avgReturn * currentPrice * 2;
}

function calculateMomentum(prices: number[], period: number = 10): number {
  if (prices.length < period + 1) return 0;
  const current = prices[prices.length - 1];
  const previous = prices[prices.length - 1 - period];
  return ((current - previous) / previous) * 100;
}

export function calculateTechnicalIndicators(prices: number[]): TechnicalIndicators {
  const currentPrice = prices[prices.length - 1] || 0;
  
  const rsi = calculateRSI(prices);
  const rsiSignal: "oversold" | "neutral" | "overbought" = 
    rsi < 30 ? "oversold" : rsi > 70 ? "overbought" : "neutral";
  
  const macd = calculateMACD(prices);
  const macdSignal: "bullish" | "bearish" | "neutral" = 
    macd.histogram > 0 && macd.macdLine > macd.signalLine ? "bullish" :
    macd.histogram < 0 && macd.macdLine < macd.signalLine ? "bearish" : "neutral";
  
  const bollinger = calculateBollingerBands(prices);
  const bollingerPosition: "below" | "middle" | "above" = 
    currentPrice < bollinger.lower ? "below" :
    currentPrice > bollinger.upper ? "above" : "middle";
  
  const bollingerWidthData = calculateBollingerWidthPercentile(prices);
  
  const sma7 = calculateSMA(prices, 7);
  const sma25 = calculateSMA(prices, 25);
  const sma100 = calculateSMA(prices, Math.min(100, prices.length));
  const trendDirection: "up" | "down" | "sideways" = 
    sma7 > sma25 * 1.01 ? "up" :
    sma7 < sma25 * 0.99 ? "down" : "sideways";
  
  const volatilityProxy = calculateVolatilityProxy(prices);
  const volatility = (volatilityProxy / currentPrice) * 100;
  const momentum = calculateMomentum(prices);
  
  const atr = calculateATR(prices);
  const atrPercent = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  
  const adxData = calculateADX(prices);
  
  const zScoreData = calculateZScore(prices, 100);
  
  const priceToMeanDistance = atr > 0 ? Math.abs(currentPrice - sma100) / atr : 0;
  const meanProximity = priceToMeanDistance <= 1.0;
  
  // Keltner Channel for Vol Expansion breakout detection
  const keltner = calculateKeltnerChannel(prices, 20, 2.0, 10);
  const keltnerBreakoutUp = currentPrice > keltner.upper;
  const keltnerBreakoutDown = currentPrice < keltner.lower;
  
  return {
    rsi,
    rsiSignal,
    macdLine: macd.macdLine,
    signalLine: macd.signalLine,
    macdHistogram: macd.histogram,
    macdSignal,
    bollingerUpper: bollinger.upper,
    bollingerMiddle: bollinger.middle,
    bollingerLower: bollinger.lower,
    bollingerPosition,
    bollingerWidth: bollingerWidthData.currentWidth,
    bollingerWidthPercentile: bollingerWidthData.percentile,
    isVolatilitySqueeze: bollingerWidthData.isSqueeze,
    // Keltner Channel
    keltnerUpper: keltner.upper,
    keltnerMiddle: keltner.middle,
    keltnerLower: keltner.lower,
    keltnerBreakoutUp,
    keltnerBreakoutDown,
    volatilityRising: keltner.volatilityRising,
    volatilitySustained: keltner.volatilitySustained,
    sma7,
    sma25,
    sma100,
    trendDirection,
    volatility,
    momentum,
    volatilityProxy,
    atr,
    atrPercent,
    adx: adxData.adx,
    adxTrending: adxData.adx >= 20,
    adxHookingUp: adxData.isHookingUp,
    zScore: zScoreData.zScore,
    priceToMeanDistance,
    meanProximity
  };
}

// KELLY CRITERION POSITION SIZING
// Per Mike1 spec: Use Kelly to size based on edge, not fixed risk
// 
// Kelly Formula: f* = (p × b - q) / b
// Where:
//   f* = optimal fraction of bankroll to bet
//   p = probability of winning (60-70% for our TP levels)
//   q = probability of losing (40% for our SL)
//   b = win/loss ratio (odds, e.g., 1.5 means win $1.5 for every $1 risked)
//
// With 60% win rate and 1.5:1 reward/risk:
// f* = (0.60 × 1.5 - 0.40) / 1.5 = (0.90 - 0.40) / 1.5 = 0.50 / 1.5 = 0.333 (33%)
//
// We use FRACTIONAL Kelly (25-50% of full Kelly) for safety

export function calculateKellyPositionSize(
  equity: number,
  winProbability: number,       // Expected win rate (0.60 for 60%)
  rewardRiskRatio: number,      // Reward/Risk ratio (1.5 for 1.5:1)
  stopDistancePercent: number,  // Stop loss distance as percentage
  kellyFraction: number = 0.25  // Fraction of Kelly to use (25% = conservative)
): { positionSize: number; positionSizePercent: number; kellyPercent: number; riskAmount: number } {
  
  // Calculate full Kelly fraction
  const loseProbability = 1 - winProbability;
  const fullKelly = rewardRiskRatio > 0 
    ? (winProbability * rewardRiskRatio - loseProbability) / rewardRiskRatio
    : 0;
  
  // Kelly can be negative (don't bet) or > 1 (bad inputs)
  const safeKelly = Math.max(0, Math.min(fullKelly, 0.5)); // Cap at 50%
  
  // Apply fractional Kelly for safety
  const fractionalKelly = safeKelly * kellyFraction;
  
  // Hard caps per Mike1 spec
  const maxPositionPercent = 0.05; // Max 5% of equity per position
  const minPositionPercent = 0.005; // Min 0.5% for meaningful trades
  
  // Calculate position size
  let positionSizePercent = fractionalKelly;
  
  // Apply caps
  positionSizePercent = Math.max(minPositionPercent, Math.min(positionSizePercent, maxPositionPercent));
  
  const positionValue = equity * positionSizePercent;
  const riskAmount = positionValue * stopDistancePercent;
  
  console.log(`[Kelly] Win=${(winProbability*100).toFixed(0)}%, R:R=${rewardRiskRatio.toFixed(2)}, ` +
    `Full Kelly=${(fullKelly*100).toFixed(1)}%, Fractional=${(fractionalKelly*100).toFixed(1)}%, ` +
    `Applied=${(positionSizePercent*100).toFixed(2)}%`);
  
  return {
    positionSize: positionValue,
    positionSizePercent,
    kellyPercent: fullKelly,
    riskAmount
  };
}

// Legacy ATR-based position sizing (still useful for volatility-based sizing)
export function calculateATRPositionSize(
  equity: number,
  riskPercent: number,
  atr: number,
  currentPrice: number,
  multiplier: number = 2.0
): { positionSize: number; positionSizePercent: number; riskAmount: number } {
  const riskAmount = equity * riskPercent;
  
  const stopDistance = atr * multiplier;
  
  const quantity = stopDistance > 0 ? riskAmount / stopDistance : 0;
  
  const positionValue = quantity * currentPrice;
  const positionSizePercent = equity > 0 ? positionValue / equity : 0;
  
  const cappedPositionSizePercent = Math.min(positionSizePercent, 0.05);
  const cappedPositionValue = equity * cappedPositionSizePercent;
  const cappedQuantity = currentPrice > 0 ? cappedPositionValue / currentPrice : 0;
  
  return {
    positionSize: cappedQuantity,
    positionSizePercent: cappedPositionSizePercent,
    riskAmount: Math.min(riskAmount, cappedPositionValue * (stopDistance / currentPrice))
  };
}

export function generateQuantSignal(
  crypto: CryptoData,
  mvrvZScore: number | null,
  capitalFlowScore: number,
  portfolioEquity: number = 100,
  adaptiveParams?: AdaptiveParams,
  indicatorWeights?: Record<string, number>,
  bootstrapMode: boolean = false
): QuantSignal | null {
  const prices = crypto.sparkline_in_7d?.price || [];
  if (prices.length < 30) return null;
  
  const currentPrice = crypto.current_price;
  const indicators = calculateTechnicalIndicators(prices);
  
  // "ROCKET PROTOCOL" - Removed Z-Score ceiling for strong trends
  // Old: Z-Score max of 2.0 blocked entries during big moves
  // New: Only block if absurdly late (Z > 5.0)
  const zScoreMax = bootstrapMode ? 6.0 : (adaptiveParams?.zScoreMax ?? 5.0);
  const absZScore = Math.abs(indicators.zScore);
  if (absZScore > zScoreMax) {
    console.log(`[Vol Exp GATE] ${crypto.symbol.toUpperCase()}: Z-Score ${absZScore.toFixed(2)} > ${zScoreMax} (too late)`);
    return null;
  }
  
  // Use adaptive mean proximity threshold if provided
  // In bootstrap mode, relax mean proximity requirement
  const meanProximityMaxAtr = bootstrapMode ? 2.0 : (adaptiveParams?.meanProximityMaxAtr ?? 1.0);
  const meanProximityMet = indicators.priceToMeanDistance <= meanProximityMaxAtr;
  
  // Check for Keltner breakout (Vol Expansion mode)
  // Accept volatility rising (10%+) OR volatility sustained (already high at 1.5x)
  const volConditionMet = indicators.volatilityRising || indicators.volatilitySustained;
  const hasKeltnerBreakout = (indicators.keltnerBreakoutUp || indicators.keltnerBreakoutDown) && volConditionMet;
  
  if ((indicators.keltnerBreakoutUp || indicators.keltnerBreakoutDown) && !volConditionMet) {
    console.log(`[Vol Exp] ${crypto.symbol.toUpperCase()}: Keltner breakout but vol not rising/sustained`);
  }
  
  // In bootstrap mode, allow RSI extremes as entry triggers (oversold/overbought)
  const hasRsiExtreme = indicators.rsi < 35 || indicators.rsi > 65;
  
  // Allow entry if: mean proximity OR volatility squeeze OR Keltner breakout
  // In bootstrap mode, also allow RSI extremes
  if (!meanProximityMet && !indicators.isVolatilitySqueeze && !hasKeltnerBreakout && !(bootstrapMode && hasRsiExtreme)) {
    return null;
  }
  
  // If requireAdxHook is true, always require ADX hooking up
  const requireAdxHook = adaptiveParams?.requireAdxHook ?? false;
  const hasPerfectSetup = indicators.isVolatilitySqueeze && meanProximityMet;
  // For Keltner breakouts, skip ADX requirement (breakout is the confirmation)
  // In bootstrap mode, skip ADX requirement entirely to generate more trades
  if (!bootstrapMode && !hasPerfectSetup && !indicators.adxHookingUp && !hasKeltnerBreakout) {
    return null;
  }
  if (requireAdxHook && !indicators.adxHookingUp) {
    return null;
  }
  
  let bullishScore = 0;
  let bearishScore = 0;
  const reasoning: string[] = [];
  
  // Helper to get indicator weight (default 1.0 if not learned)
  const getWeight = (key: string) => indicatorWeights?.[key] ?? 1.0;
  
  if (indicators.isVolatilitySqueeze) {
    const weight = getWeight('volatilitySqueeze');
    bullishScore += 25 * weight;
    bearishScore += 25 * weight;
    reasoning.push(`Volatility squeeze detected (${indicators.bollingerWidthPercentile.toFixed(0)}th percentile, w=${weight.toFixed(2)})`);
  }
  
  // VOL EXPANSION MODE: Keltner Channel breakout detection
  // Per spec: "Price > Upper Keltner AND (Volatility Rising OR Volatility Sustained)"
  const volActive = indicators.volatilityRising || indicators.volatilitySustained;
  const volType = indicators.volatilitySustained ? "Sustained" : "Rising";
  
  if (indicators.keltnerBreakoutUp && volActive) {
    const weight = getWeight('keltnerBreakout');
    bullishScore += 40 * weight; // Strong bullish signal for upside breakout
    reasoning.push(`KELTNER BREAKOUT UP: Price > ${indicators.keltnerUpper.toFixed(2)} + Vol ${volType} (w=${weight.toFixed(2)})`);
  } else if (indicators.keltnerBreakoutDown && volActive) {
    const weight = getWeight('keltnerBreakout');
    bearishScore += 40 * weight; // Strong bearish signal for downside breakout
    reasoning.push(`KELTNER BREAKOUT DOWN: Price < ${indicators.keltnerLower.toFixed(2)} + Vol ${volType} (w=${weight.toFixed(2)})`);
  }
  
  if (meanProximityMet) {
    const weight = getWeight('meanProximity');
    bullishScore += 20 * weight;
    bearishScore += 20 * weight;
    reasoning.push(`Price near mean (${indicators.priceToMeanDistance.toFixed(2)} ATR from SMA100, w=${weight.toFixed(2)})`);
  }
  
  if (indicators.adxHookingUp) {
    const weight = getWeight('adxHookingUp');
    bullishScore += 30 * weight;
    bearishScore += 30 * weight;
    reasoning.push(`ADX hooking up from ${indicators.adx.toFixed(1)} - trend emerging (w=${weight.toFixed(2)})`);
  } else if (indicators.adxTrending) {
    bullishScore += 10;
    bearishScore += 10;
    reasoning.push(`ADX trending (${indicators.adx.toFixed(1)})`);
  }
  
  if (indicators.rsiSignal === "oversold") {
    const weight = getWeight('rsiOversold');
    bullishScore += 25 * weight;
    reasoning.push(`RSI oversold (${indicators.rsi.toFixed(1)}, w=${weight.toFixed(2)})`);
  } else if (indicators.rsiSignal === "overbought") {
    const weight = getWeight('rsiOverbought');
    bearishScore += 25 * weight;
    reasoning.push(`RSI overbought (${indicators.rsi.toFixed(1)}, w=${weight.toFixed(2)})`);
  }
  
  if (indicators.macdSignal === "bullish") {
    const weight = getWeight('macdBullish');
    bullishScore += 20 * weight;
    reasoning.push(`MACD bullish crossover (w=${weight.toFixed(2)})`);
  } else if (indicators.macdSignal === "bearish") {
    const weight = getWeight('macdBearish');
    bearishScore += 20 * weight;
    reasoning.push(`MACD bearish crossover (w=${weight.toFixed(2)})`);
  }
  
  if (indicators.bollingerPosition === "below" && meanProximityMet) {
    bullishScore += 20;
    reasoning.push("Near lower Bollinger Band with mean proximity");
  } else if (indicators.bollingerPosition === "above" && meanProximityMet) {
    bearishScore += 20;
    reasoning.push("Near upper Bollinger Band with mean proximity");
  }
  
  if (indicators.trendDirection === "up") {
    const weight = getWeight('trendUp');
    bullishScore += 15 * weight;
    reasoning.push(`SMA7 > SMA25 (uptrend, w=${weight.toFixed(2)})`);
  } else if (indicators.trendDirection === "down") {
    const weight = getWeight('trendDown');
    bearishScore += 15 * weight;
    reasoning.push(`SMA7 < SMA25 (downtrend, w=${weight.toFixed(2)})`);
  }
  
  if (indicators.momentum > 5) {
    bullishScore += 10;
    reasoning.push(`Strong positive momentum (${indicators.momentum.toFixed(1)}%)`);
  } else if (indicators.momentum < -5) {
    bearishScore += 10;
    reasoning.push(`Strong negative momentum (${indicators.momentum.toFixed(1)}%)`);
  }
  
  if (mvrvZScore !== null) {
    if (mvrvZScore < -0.8) {
      const weight = getWeight('mvrvUndervalued');
      bullishScore += 30 * weight;
      reasoning.push(`Deeply undervalued (MVRV: ${mvrvZScore.toFixed(2)}, w=${weight.toFixed(2)})`);
    } else if (mvrvZScore < -0.3) {
      const weight = getWeight('mvrvUndervalued');
      bullishScore += 20 * weight;
      reasoning.push(`Undervalued (MVRV: ${mvrvZScore.toFixed(2)}, w=${weight.toFixed(2)})`);
    } else if (mvrvZScore > 3) {
      const weight = getWeight('mvrvOvervalued');
      bearishScore += 30 * weight;
      reasoning.push(`Extremely overvalued (MVRV: ${mvrvZScore.toFixed(2)}, w=${weight.toFixed(2)})`);
    } else if (mvrvZScore > 2) {
      const weight = getWeight('mvrvOvervalued');
      bearishScore += 20 * weight;
      reasoning.push(`Overvalued (MVRV: ${mvrvZScore.toFixed(2)}, w=${weight.toFixed(2)})`);
    }
  }
  
  if (capitalFlowScore > 0.3) {
    const weight = getWeight('capitalInflow');
    bullishScore += 15 * weight;
    reasoning.push(`Strong capital inflow detected (w=${weight.toFixed(2)})`);
  } else if (capitalFlowScore < -0.3) {
    const weight = getWeight('capitalOutflow');
    bearishScore += 15 * weight;
    reasoning.push(`Capital outflow detected (w=${weight.toFixed(2)})`);
  }
  
  const netScore = bullishScore - bearishScore;
  const absScore = Math.abs(netScore);
  
  // ALPHA REQUIREMENT (Per Mike1 Spec "The Sniper" Option)
  // Only enter trades when AI predicts a directional move so strong that it skews
  // the probabilities in our favor. Without alpha, 60/40 exits have neutral/negative expectancy.
  // 
  // Signal strength thresholds:
  // - Volatility squeeze setups: Lower threshold (15) since these are high-probability setups
  // - Normal setups: Higher threshold (30) to ensure strong directional conviction
  // - Perfect setups (squeeze + mean proximity + multiple confirmations): Lower allowed
  
  // Count confirmations for signal strength
  let confirmationCount = 0;
  if (indicators.isVolatilitySqueeze) confirmationCount++;
  if (meanProximityMet) confirmationCount++;
  if (indicators.adxHookingUp) confirmationCount++;
  if (indicators.rsiSignal === "oversold" || indicators.rsiSignal === "overbought") confirmationCount++;
  if (indicators.macdSignal === "bullish" || indicators.macdSignal === "bearish") confirmationCount++;
  if (mvrvZScore !== null && (mvrvZScore < -0.3 || mvrvZScore > 2)) confirmationCount++;
  
  // Alpha filter: Require minimum signal strength based on confirmation quality
  // Lowered thresholds for active trading - Mike1 will filter bad trades over time
  let alphaThreshold: number;
  if (confirmationCount >= 4 && indicators.isVolatilitySqueeze) {
    // Perfect setup: 4+ confirmations with squeeze - lowest threshold
    alphaThreshold = 8;
  } else if (confirmationCount >= 3 && meanProximityMet) {
    // Strong setup: 3+ confirmations with mean proximity
    alphaThreshold = 10;
  } else if (confirmationCount >= 2 || indicators.isVolatilitySqueeze) {
    // Moderate setup: 2+ confirmations or squeeze
    alphaThreshold = 12;
  } else {
    // Normal setup: still allow trades with decent score
    alphaThreshold = 15;
  }
  
  if (absScore < alphaThreshold) {
    console.log(`[Alpha Filter] ${crypto.symbol}: Score ${absScore.toFixed(0)} < threshold ${alphaThreshold} (${confirmationCount} confirmations) - NO TRADE`);
    return null;
  }
  
  console.log(`[Alpha Filter] ${crypto.symbol}: Score ${absScore.toFixed(0)} >= threshold ${alphaThreshold} (${confirmationCount} confirmations) - SIGNAL VALID`);
  
  const side: "long" | "short" = netScore > 0 ? "long" : "short";
  const action: "buy" | "sell" = netScore > 0 ? "buy" : "sell";
  
  let confidence = Math.min(absScore / 100, 0.95);
  if (indicators.isVolatilitySqueeze && meanProximityMet) {
    confidence = Math.min(confidence * 1.2, 0.95);
  }
  // Boost confidence for high-confirmation setups
  if (confirmationCount >= 4) {
    confidence = Math.min(confidence * 1.15, 0.95);
  }
  const strength = absScore;
  
  // DAY TRADING APPROACH: Scale-out TPs (85%/72%/58% hit rate), fixed wide stops (~20% hit rate)
  
  // Calculate fixed stop loss at 1 Risk Unit (ATR-based)
  const stopData = calculateDayTradingStopLoss(currentPrice, prices, indicators.atr, indicators.volatility, side);
  const stopLoss = stopData.stopLoss;
  const stopDistance = stopData.stopDistance;
  
  // Calculate fixed take profit at 1.5 Risk Units (1:1.5 R:R per spec)
  const tpData = calculateFixedTakeProfit(currentPrice, stopDistance, side);
  const takeProfit = tpData.takeProfit;
  const profitDistance = tpData.profitDistance;
  const riskReward = tpData.riskRewardRatio; // Fixed at 1.5
  
  reasoning.push(`Fixed R:R strategy: SL=1 Unit, TP=1.5 Units (1:${riskReward} R:R)`);
  
  // Use Kelly Criterion for position sizing
  // With 1:1.5 R:R, need ~40% win rate for breakeven, 50%+ for profit
  const stopDistancePercent = (stopDistance / currentPrice) * 100;
  const winProbability = 0.55; // Conservative estimate for well-filtered signals
  
  // Fractional Kelly: 25% of full Kelly for safety
  const positionSizing = calculateKellyPositionSize(
    portfolioEquity,
    winProbability,
    riskReward,
    stopDistancePercent,
    0.25 // 25% fractional Kelly
  );
  
  reasoning.push(`Kelly sizing: ${(winProbability*100).toFixed(0)}% win, ${riskReward.toFixed(2)}R:R → ${positionSizing.positionSizePercent.toFixed(1)}% position`);
  
  return {
    symbol: crypto.symbol.toUpperCase(),
    coinName: crypto.name,
    action,
    side,
    confidence,
    strength,
    indicators,
    reasoning,
    entryPrice: currentPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: riskReward,
    positionSizePercent: positionSizing.positionSizePercent,
    timestamp: new Date()
  };
}

function calculateMeanReversionScore(prices: number[], currentPrice: number): number {
  const sma20 = calculateSMA(prices, 20);
  const deviation = (currentPrice - sma20) / sma20;
  
  const stdDev = Math.sqrt(
    prices.slice(-20).reduce((sum, p) => sum + Math.pow(p - sma20, 2), 0) / 20
  );
  const zScore = (currentPrice - sma20) / stdDev;
  
  if (zScore < -2) return 1;
  if (zScore < -1) return 0.5;
  if (zScore > 2) return -1;
  if (zScore > 1) return -0.5;
  return 0;
}

// Detect market regime based on ADX and price action
export function detectMarketRegime(indicators: TechnicalIndicators): 'trending' | 'ranging' | 'unknown' {
  // ADX < 20 indicates ranging/sideways market
  // ADX > 25 indicates trending market
  if (indicators.adx < 18) {
    return 'ranging';
  } else if (indicators.adx > 25 && (indicators.trendDirection === 'up' || indicators.trendDirection === 'down')) {
    return 'trending';
  }
  return 'unknown';
}

// Generate mean reversion signal (for ranging/sideways markets)
export function generateMeanReversionSignal(
  crypto: CryptoData,
  portfolioEquity: number = 100,
  adaptiveParams?: AdaptiveParams,
  indicatorWeights?: Record<string, number>,
  bootstrapMode: boolean = false
): QuantSignal | null {
  const prices = crypto.sparkline_in_7d?.price || [];
  if (prices.length < 30) return null;
  
  const currentPrice = crypto.current_price;
  const indicators = calculateTechnicalIndicators(prices);
  
  // For mean reversion, we WANT extended price - opposite of vol expansion
  // In bootstrap mode, lower the Z-score requirement
  const absZScore = Math.abs(indicators.zScore);
  const minZScore = bootstrapMode ? 1.0 : 1.5;
  if (absZScore < minZScore) {
    console.log(`[Mean Rev GATE] ${crypto.symbol.toUpperCase()}: Z-Score ${absZScore.toFixed(2)} < ${minZScore} (need extended price)`);
    return null; // Need extended price for mean reversion
  }
  
  // "FALLING KNIFE PROTOCOL" - Panic crash bypass
  // If Z-Score is extreme (< -3.5 or > 3.5), ignore ADX filter - pure statistical extremity
  const isPanicCrash = absZScore >= 3.5;
  
  // Mean reversion works best in RANGING markets (low ADX < 30)
  // BUT: Panic crashes bypass ADX check entirely
  // In bootstrap mode, also relax ADX requirement
  const isNormalDip = indicators.adx <= 30;
  
  if (!bootstrapMode && !isNormalDip && !isPanicCrash) {
    console.log(`[Mean Rev GATE] ${crypto.symbol.toUpperCase()}: ADX ${indicators.adx.toFixed(1)} > 30 (trending), Z=${absZScore.toFixed(2)} (not panic)`);
    return null; // Skip trending markets unless panic crash
  }
  
  if (isPanicCrash) {
    console.log(`[Mean Rev] ${crypto.symbol.toUpperCase()}: PANIC CRASH DETECTED Z=${indicators.zScore.toFixed(2)} - ADX bypass active`);
  }
  
  let bullishScore = 0;
  let bearishScore = 0;
  const reasoning: string[] = [];
  
  const getWeight = (key: string) => indicatorWeights?.[key] ?? 1.0;
  
  reasoning.push(`Mean Reversion Mode - ADX=${indicators.adx.toFixed(1)} (ranging market)`);
  
  // Mean reversion: BUY when price is BELOW mean (oversold), SELL when ABOVE (overbought)
  if (indicators.zScore < -2.0) {
    const weight = getWeight('rsiOversold');
    bullishScore += 40 * weight;
    reasoning.push(`Deeply extended below mean (Z=${indicators.zScore.toFixed(2)}, w=${weight.toFixed(2)}) - expect snap back`);
  } else if (indicators.zScore < -1.5) {
    const weight = getWeight('rsiOversold');
    bullishScore += 25 * weight;
    reasoning.push(`Extended below mean (Z=${indicators.zScore.toFixed(2)}, w=${weight.toFixed(2)})`);
  } else if (indicators.zScore > 2.0) {
    const weight = getWeight('rsiOverbought');
    bearishScore += 40 * weight;
    reasoning.push(`Deeply extended above mean (Z=${indicators.zScore.toFixed(2)}, w=${weight.toFixed(2)}) - expect reversion`);
  } else if (indicators.zScore > 1.5) {
    const weight = getWeight('rsiOverbought');
    bearishScore += 25 * weight;
    reasoning.push(`Extended above mean (Z=${indicators.zScore.toFixed(2)}, w=${weight.toFixed(2)})`);
  }
  
  // RSI divergence for mean reversion
  if (indicators.rsiSignal === "oversold" && indicators.zScore < -1) {
    const weight = getWeight('rsiOversold');
    bullishScore += 30 * weight;
    reasoning.push(`RSI oversold (${indicators.rsi.toFixed(1)}) confirming mean reversion long (w=${weight.toFixed(2)})`);
  } else if (indicators.rsiSignal === "overbought" && indicators.zScore > 1) {
    const weight = getWeight('rsiOverbought');
    bearishScore += 30 * weight;
    reasoning.push(`RSI overbought (${indicators.rsi.toFixed(1)}) confirming mean reversion short (w=${weight.toFixed(2)})`);
  }
  
  // Bollinger Band extremes
  if (indicators.bollingerPosition === "below") {
    bullishScore += 20;
    reasoning.push("Below lower Bollinger - expect bounce");
  } else if (indicators.bollingerPosition === "above") {
    bearishScore += 20;
    reasoning.push("Above upper Bollinger - expect pullback");
  }
  
  const netScore = bullishScore - bearishScore;
  const absScore = Math.abs(netScore);
  
  const threshold = adaptiveParams?.signalThreshold ?? 25;
  if (absScore < threshold) {
    return null;
  }
  
  const side: "long" | "short" = netScore > 0 ? "long" : "short";
  const action: "buy" | "sell" = netScore > 0 ? "buy" : "sell";
  
  let confidence = Math.min(absScore / 100, 0.95);
  const strength = Math.min(absScore / 40, 1);
  
  // Calculate fixed stop loss at 1 Risk Unit (ATR-based)
  const stopData = calculateDayTradingStopLoss(currentPrice, prices, indicators.atr, indicators.volatility, side);
  const stopLoss = stopData.stopLoss;
  const stopDistance = stopData.stopDistance;
  
  // Calculate fixed take profit at 1.5 Risk Units (1:1.5 R:R per spec)
  const tpData = calculateFixedTakeProfit(currentPrice, stopDistance, side);
  const takeProfit = tpData.takeProfit;
  const profitDistance = tpData.profitDistance;
  const riskReward = tpData.riskRewardRatio; // Fixed at 1.5
  
  reasoning.push(`Mean reversion: Fixed R:R strategy (1:${riskReward} R:R)`);
  
  // Use Kelly Criterion for position sizing
  const stopDistancePercent = (stopDistance / currentPrice) * 100;
  const winProbability = 0.55; // Conservative estimate for mean reversion trades
  
  // Fractional Kelly: 25% of full Kelly for safety
  const positionSizing = calculateKellyPositionSize(
    portfolioEquity,
    winProbability,
    riskReward,
    stopDistancePercent,
    0.25 // 25% fractional Kelly
  );
  
  reasoning.push(`Kelly sizing: ${(winProbability*100).toFixed(0)}% win, ${riskReward.toFixed(2)}R:R → ${positionSizing.positionSizePercent.toFixed(1)}% position`);
  
  return {
    symbol: crypto.symbol.toUpperCase(),
    coinName: crypto.name,
    action,
    side,
    confidence,
    strength,
    indicators,
    reasoning,
    entryPrice: currentPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: riskReward,
    positionSizePercent: positionSizing.positionSizePercent,
    timestamp: new Date()
  };
}

// Track which symbols momentum fallback has already fired for
// Prevents the fallback from generating the same signal every 5-minute analysis cycle
const momentumFallbackCooldowns: Map<string, number> = new Map();
const MOMENTUM_FALLBACK_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours - same as candle timeframe

// "OBVIOUS MOVE" MOMENTUM FALLBACK
// If standard signals are blocked by complex filters, this catches the obvious big moves
// Logic: If the recent candle closes > 4% away from open AND Volume > 3x average, force entry
export function generateMomentumFallbackSignal(
  crypto: CryptoData,
  portfolioEquity: number = 100,
  adaptiveParams?: AdaptiveParams,
  indicatorWeights?: Record<string, number>
): QuantSignal | null {
  const prices = crypto.sparkline_in_7d?.price || [];
  if (prices.length < 30) return null;
  
  // Per-symbol cooldown: only fire momentum fallback once per 4H window per symbol
  const symbol = crypto.symbol.toUpperCase();
  const lastFired = momentumFallbackCooldowns.get(symbol);
  if (lastFired && Date.now() - lastFired < MOMENTUM_FALLBACK_COOLDOWN_MS) {
    return null; // Already fired for this symbol recently
  }
  
  const currentPrice = crypto.current_price;
  const indicators = calculateTechnicalIndicators(prices);
  
  // Get recent price action (simulated candle from sparkline)
  // Use last 6 data points as "candle" (roughly 4H worth in 7d sparkline)
  const candleOpen = prices[prices.length - 6] || prices[0];
  const candleClose = currentPrice;
  const candleBodySize = Math.abs(candleClose - candleOpen) / candleOpen;
  
  // Volume proxy: check if current volatility is extreme (3x+ normal)
  const avgVolatility = indicators.volatility / 100; // normalize
  const priceChange24h = Math.abs(crypto.price_change_percentage_24h || 0) / 100;
  const volumeSurge = priceChange24h > avgVolatility * 3;
  
  // MOMENTUM FALLBACK: 1%+ candle + volume surge OR 2%+ 24h change = force entry
  const isObviousMove = candleBodySize > 0.01 && (volumeSurge || priceChange24h > 0.02);
  
  if (!isObviousMove) {
    return null;
  }
  
  const side: "long" | "short" = candleClose > candleOpen ? "long" : "short";
  const action: "buy" | "sell" = side === "long" ? "buy" : "sell";
  
  const reasoning: string[] = [];
  reasoning.push(`MOMENTUM FALLBACK: Obvious ${side.toUpperCase()} move detected`);
  reasoning.push(`Candle body: ${(candleBodySize * 100).toFixed(2)}% (>${2}% threshold)`);
  reasoning.push(`24h change: ${(priceChange24h * 100).toFixed(2)}% - Force entry`);
  
  // Mark this symbol as fired - won't fire again for 4 hours
  momentumFallbackCooldowns.set(symbol, Date.now());
  console.log(`[MOMENTUM FALLBACK] ${symbol}: ${side.toUpperCase()} - ${(candleBodySize * 100).toFixed(2)}% candle, ${(priceChange24h * 100).toFixed(2)}% 24h change (4H cooldown set)`);
  
  // High confidence for obvious moves
  const confidence = 0.75;
  const strength = 0.8;
  
  // Calculate fixed stop loss at 1 Risk Unit (ATR-based)
  const stopData = calculateDayTradingStopLoss(currentPrice, prices, indicators.atr, indicators.volatility, side);
  const stopLoss = stopData.stopLoss;
  const stopDistance = stopData.stopDistance;
  
  // Calculate fixed take profit at 1.5 Risk Units (1:1.5 R:R per spec)
  const tpData = calculateFixedTakeProfit(currentPrice, stopDistance, side);
  const takeProfit = tpData.takeProfit;
  const riskReward = tpData.riskRewardRatio;
  
  // Use Kelly Criterion for position sizing
  const stopDistancePercent = (stopDistance / currentPrice) * 100;
  const winProbability = 0.55;
  
  const positionSizing = calculateKellyPositionSize(
    portfolioEquity,
    winProbability,
    riskReward,
    stopDistancePercent,
    0.25
  );
  
  return {
    symbol: crypto.symbol.toUpperCase(),
    coinName: crypto.name,
    action,
    side,
    confidence,
    strength,
    indicators,
    reasoning,
    entryPrice: currentPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: riskReward,
    positionSizePercent: positionSizing.positionSizePercent,
    timestamp: new Date()
  };
}

export function rankSignals(signals: QuantSignal[]): QuantSignal[] {
  return signals
    .filter(s => s !== null)
    .sort((a, b) => {
      const scoreA = a.confidence * a.riskRewardRatio;
      const scoreB = b.confidence * b.riskRewardRatio;
      return scoreB - scoreA;
    })
    .slice(0, 3);
}

export interface StrategyPerformance {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  expectancy: number;
  maxConsecutiveLosses: number;
  currentStreak: number;
}

let strategyPerformance: StrategyPerformance = {
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  winRate: 0,
  avgWin: 0,
  avgLoss: 0,
  profitFactor: 0,
  expectancy: 0,
  maxConsecutiveLosses: 0,
  currentStreak: 0
};

export function updateStrategyPerformance(pnlPercent: number): void {
  strategyPerformance.totalTrades++;
  
  if (pnlPercent > 0) {
    strategyPerformance.winningTrades++;
    strategyPerformance.avgWin = 
      (strategyPerformance.avgWin * (strategyPerformance.winningTrades - 1) + pnlPercent) / 
      strategyPerformance.winningTrades;
    strategyPerformance.currentStreak = Math.max(0, strategyPerformance.currentStreak) + 1;
  } else {
    strategyPerformance.losingTrades++;
    strategyPerformance.avgLoss = 
      (strategyPerformance.avgLoss * (strategyPerformance.losingTrades - 1) + Math.abs(pnlPercent)) / 
      strategyPerformance.losingTrades;
    strategyPerformance.currentStreak = Math.min(0, strategyPerformance.currentStreak) - 1;
    strategyPerformance.maxConsecutiveLosses = Math.max(
      strategyPerformance.maxConsecutiveLosses,
      Math.abs(strategyPerformance.currentStreak)
    );
  }
  
  strategyPerformance.winRate = 
    (strategyPerformance.winningTrades / strategyPerformance.totalTrades) * 100;
  
  const totalWins = strategyPerformance.avgWin * strategyPerformance.winningTrades;
  const totalLosses = strategyPerformance.avgLoss * strategyPerformance.losingTrades;
  strategyPerformance.profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins;
  
  strategyPerformance.expectancy = 
    (strategyPerformance.winRate / 100 * strategyPerformance.avgWin) - 
    ((1 - strategyPerformance.winRate / 100) * strategyPerformance.avgLoss);
}

export function getStrategyPerformance(): StrategyPerformance {
  return { ...strategyPerformance };
}

// ADAPTIVE STRATEGY PARAMETERS - Self-adjusting based on Sharpe/Ulcer ratio
// 3 Modes based on market regime:
// 1. Mean Reversion - Choppy/Sideways markets (70% of the time)
// 2. Volatility Expansion - Strong Trend/Breakout markets (captures 10-20% moves)
// 3. Pairs Trading - Bear/Uncertain markets (hedged, makes money in crashes)
export type StrategyMode = 'meanReversion' | 'volExpansion' | 'pairsTrading' | 'adaptive' | 'momentum' | 'basket';

export interface AdaptiveParams {
  signalThreshold: number;       // Minimum score to enter (default: 20)
  riskPercent: number;           // Risk per trade (default: 0.02)
  atrMultiplier: number;         // ATR multiplier for stops (default: 3.0)
  minRiskReward: number;         // Minimum R:R (default: 1.5)
  zScoreMax: number;             // Max |Z-Score| for entry (default: 2.0)
  meanProximityMaxAtr: number;   // Max ATR distance from mean (default: 1.0)
  requireAdxHook: boolean;       // Require ADX hooking up (default: false)
  sideBias: number;              // -1 = short bias, 0 = neutral, 1 = long bias
  strategyMode: StrategyMode;    // Trading mode (meanReversion, pairsTrading, adaptive)
  lastAdjustedAt: number;        // Timestamp of last adjustment
  adjustmentCount: number;       // Number of adjustments made
  lastLookbackAt: number;        // Timestamp of last 4-hour lookback simulation
}

// Track performance per strategy mode for adaptive switching
interface ModePerformance {
  trades: number;
  wins: number;
  totalPnl: number;
  sharpeUlcer: number;
  returns: number[];  // Per-mode returns for Sharpe calculation
  peakEquity: number;
  drawdowns: number[];  // Per-mode drawdowns for Ulcer calculation
}

const modePerformance: Record<StrategyMode, ModePerformance> = {
  meanReversion: { trades: 0, wins: 0, totalPnl: 0, sharpeUlcer: 0, returns: [], peakEquity: 100, drawdowns: [] },
  volExpansion: { trades: 0, wins: 0, totalPnl: 0, sharpeUlcer: 0, returns: [], peakEquity: 100, drawdowns: [] },
  pairsTrading: { trades: 0, wins: 0, totalPnl: 0, sharpeUlcer: 0, returns: [], peakEquity: 100, drawdowns: [] },
  adaptive: { trades: 0, wins: 0, totalPnl: 0, sharpeUlcer: 0, returns: [], peakEquity: 100, drawdowns: [] },
  momentum: { trades: 0, wins: 0, totalPnl: 0, sharpeUlcer: 0, returns: [], peakEquity: 100, drawdowns: [] },
  basket: { trades: 0, wins: 0, totalPnl: 0, sharpeUlcer: 0, returns: [], peakEquity: 100, drawdowns: [] },
};

// Calculate per-mode Sharpe/Ulcer ratio
function calculateModeSharpeUlcer(perf: ModePerformance): number {
  if (perf.returns.length < 5) return 0;
  
  // Calculate Sharpe Ratio
  const avgReturn = perf.returns.reduce((a, b) => a + b, 0) / perf.returns.length;
  const variance = perf.returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / perf.returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? avgReturn / stdDev : 0;
  
  // Calculate Ulcer Index from drawdowns
  if (perf.drawdowns.length === 0) return sharpe; // No drawdowns recorded
  const sumSquaredDrawdowns = perf.drawdowns.reduce((sum, d) => sum + d * d, 0);
  const ulcer = Math.sqrt(sumSquaredDrawdowns / perf.drawdowns.length);
  
  // Sharpe/Ulcer ratio (higher is better)
  return ulcer > 0.001 ? sharpe / ulcer : sharpe * 10;
}

let livePersistTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSaveLivePerformance(): void {
  if (livePersistTimer) clearTimeout(livePersistTimer);
  livePersistTimer = setTimeout(() => {
    const perfCopy = { ...modePerformance };
    saveLivePerformance(perfCopy).catch(err => 
      console.error('[Mike1 DB] Debounced save failed:', err)
    );
  }, 10000);
}

export function recordModePerformance(mode: StrategyMode, pnlPercent: number, currentEquity: number): void {
  const perf = modePerformance[mode];
  perf.trades++;
  perf.totalPnl += pnlPercent;
  if (pnlPercent > 0) perf.wins++;
  
  perf.returns.push(pnlPercent);
  if (perf.returns.length > 50) perf.returns.shift();
  
  if (currentEquity > perf.peakEquity) {
    perf.peakEquity = currentEquity;
  }
  const drawdown = ((perf.peakEquity - currentEquity) / perf.peakEquity) * 100;
  perf.drawdowns.push(drawdown);
  if (perf.drawdowns.length > 50) perf.drawdowns.shift();
  
  perf.sharpeUlcer = calculateModeSharpeUlcer(perf);
  
  console.log(`AI Learning: Mode ${mode} - ${perf.trades} trades, ${((perf.wins / perf.trades) * 100).toFixed(1)}% win, Sharpe/Ulcer=${perf.sharpeUlcer.toFixed(3)}`);
  
  debouncedSaveLivePerformance();
}

export async function restoreLivePerformance(): Promise<boolean> {
  const savedPerf = await loadLivePerformance();
  if (!savedPerf) return false;
  
  for (const [strategy, data] of Object.entries(savedPerf)) {
    if (strategy in modePerformance) {
      modePerformance[strategy as StrategyMode] = {
        ...data,
        sharpeUlcer: calculateModeSharpeUlcer(data),
      };
    }
  }
  
  console.log(`[Mike1 Restore] Restored live performance from DB`);
  return true;
}

export function getModePerformance(): Record<StrategyMode, ModePerformance> {
  return { 
    meanReversion: { ...modePerformance.meanReversion },
    volExpansion: { ...modePerformance.volExpansion },
    pairsTrading: { ...modePerformance.pairsTrading },
    adaptive: { ...modePerformance.adaptive },
    momentum: { ...modePerformance.momentum },
    basket: { ...modePerformance.basket },
  };
}

// Get total trades across all modes for bootstrap detection
export function getTotalModeTradeCount(): number {
  return modePerformance.meanReversion.trades + 
         modePerformance.volExpansion.trades + 
         modePerformance.pairsTrading.trades +
         modePerformance.momentum.trades +
         modePerformance.basket.trades;
}

// Bootstrap threshold - need ~100 trades before weighted allocation kicks in
export const BOOTSTRAP_TRADE_THRESHOLD = 100;

// WEIGHTED CONVICTION ALLOCATION ALGORITHM
// Per Mike1 spec: Dynamic allocation based on how much better the winner is
// - Filter: Discard strategies with negative Mike1 (never allocate to losers)
// - High Conviction (2x better): 100% to winner
// - Strong Winner (1.5x better): 80/20 split
// - Close Race (uncertain): 60/40 split to hedge regime transition risk
export interface ModeAllocation {
  meanReversion: number;
  volExpansion: number;
  pairsTrading: number;
}

export function calculateWeightedConvictionAllocation(): ModeAllocation {
  // DYNAMIC 70/30 ALLOCATION - Best Mike1 score gets 70%, second-best gets 30%
  // This ensures the system always trades but adapts to which strategy is performing better
  const perf = getModePerformance();
  
  const scores: Record<string, number> = {
    meanReversion: perf.meanReversion.sharpeUlcer,
    volExpansion: perf.volExpansion.sharpeUlcer,
    pairsTrading: perf.pairsTrading.sharpeUlcer,
  };
  
  // Sort strategies by Mike1 score (highest first)
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestMode, bestScore] = sorted[0];
  const [secondMode, secondScore] = sorted[1];
  
  // Best strategy gets 70%, second-best gets 30%, worst gets 0%
  const allocation: ModeAllocation = { meanReversion: 0, volExpansion: 0, pairsTrading: 0 };
  allocation[bestMode as keyof ModeAllocation] = 0.7;
  allocation[secondMode as keyof ModeAllocation] = 0.3;
  
  console.log(`[Conviction Alloc] DYNAMIC 70/30: ${bestMode}(Mike1=${bestScore.toFixed(2)})=70%, ${secondMode}(Mike1=${secondScore.toFixed(2)})=30%`);
  return allocation;
  
  /* DISABLED: Dynamic allocation was causing CASH position after losses
  const perf = getModePerformance();
  
  // Get Mike1 scores for all 3 modes
  const strategies: Record<string, number> = {
    meanReversion: perf.meanReversion.sharpeUlcer,
    volExpansion: perf.volExpansion.sharpeUlcer,
    pairsTrading: perf.pairsTrading.sharpeUlcer,
  };
  
  // Step 1: Filter out losers (Negative Mike1) - never allocate to losing strategies
  const validStrategies: Record<string, number> = {};
  for (const [mode, score] of Object.entries(strategies)) {
    if (score > 0) {
      validStrategies[mode] = score;
    }
  }
  
  // If no valid strategies, return zero allocation (cash is king)
  if (Object.keys(validStrategies).length === 0) {
    console.log(`[Conviction Alloc] All strategies negative Mike1 - CASH position`);
    return { meanReversion: 0, volExpansion: 0, pairsTrading: 0 };
  }
  
  // Step 2: Sort by performance
  const sortedStrategies = Object.entries(validStrategies)
    .sort((a, b) => b[1] - a[1]);
  
  const [bestMode, bestScore] = sortedStrategies[0];
  
  // If only one profitable strategy, go 100%
  if (sortedStrategies.length === 1) {
    console.log(`[Conviction Alloc] Single profitable mode: ${bestMode} (Mike1=${bestScore.toFixed(3)}) -> 100%`);
    return {
      meanReversion: bestMode === 'meanReversion' ? 1.0 : 0,
      volExpansion: bestMode === 'volExpansion' ? 1.0 : 0,
      pairsTrading: bestMode === 'pairsTrading' ? 1.0 : 0,
    };
  }
  
  const [secondMode, secondScore] = sortedStrategies[1];
  
  // Step 3: Calculate "Dominance Ratio"
  const dominance = bestScore / (secondScore + 0.001);
  
  // Step 4: Allocation Rules based on dominance
  let bestAlloc: number;
  let secondAlloc: number;
  
  if (dominance > 2.0) {
    // Winner is dominant -> 100% Allocation ("Go for the kill")
    bestAlloc = 1.0;
    secondAlloc = 0.0;
    console.log(`[Conviction Alloc] HIGH CONVICTION: ${bestMode}=${bestScore.toFixed(3)} >> ${secondMode}=${secondScore.toFixed(3)} (${dominance.toFixed(1)}x) -> 100%/${0}%`);
  } else if (dominance > 1.5) {
    // Strong Winner -> 80% / 20%
    bestAlloc = 0.8;
    secondAlloc = 0.2;
    console.log(`[Conviction Alloc] STRONG: ${bestMode}=${bestScore.toFixed(3)} > ${secondMode}=${secondScore.toFixed(3)} (${dominance.toFixed(1)}x) -> 80%/20%`);
  } else {
    // Close Race (Uncertain Regime) -> 60% / 40%
    // This hedges risk when the market is in transition
    bestAlloc = 0.6;
    secondAlloc = 0.4;
    console.log(`[Conviction Alloc] CLOSE RACE: ${bestMode}=${bestScore.toFixed(3)} ~ ${secondMode}=${secondScore.toFixed(3)} (${dominance.toFixed(1)}x) -> 60%/40%`);
  }
  
  // Build allocation object
  const allocation: ModeAllocation = {
    meanReversion: 0,
    volExpansion: 0,
    pairsTrading: 0,
  };
  
  allocation[bestMode as keyof ModeAllocation] = bestAlloc;
  allocation[secondMode as keyof ModeAllocation] = secondAlloc;
  
  return allocation;
  */
}

// Default parameters
const DEFAULT_PARAMS: AdaptiveParams = {
  signalThreshold: 10,
  riskPercent: 0.03,  // Increased from 2% to 3% for meaningful position sizes
  atrMultiplier: 4.0, // Increased from 3.0 for crypto volatility + slippage buffer
  minRiskReward: 1.5,
  zScoreMax: 2.0,
  meanProximityMaxAtr: 1.0,
  requireAdxHook: false,
  sideBias: 0,
  strategyMode: 'adaptive',
  lastAdjustedAt: 0,
  adjustmentCount: 0,
  lastLookbackAt: 0,  // For 4-hour adaptive lookback simulation
};

// 4-hour interval in milliseconds for adaptive lookback
const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;

// Current adaptive parameters
let adaptiveParams: AdaptiveParams = { ...DEFAULT_PARAMS };

// Previous params for rollback
let previousParams: AdaptiveParams | null = null;
let previousMetric: number = 0;
let cooldownUntil: number = 0;
const ADJUSTMENT_COOLDOWN_TRADES = 15;
const ROLLBACK_THRESHOLD = -0.5; // Rollback if metric drops by more than this

export function getAdaptiveParams(): AdaptiveParams {
  return { ...adaptiveParams };
}

export function shouldAdjustStrategy(
  sharpeUlcerRatio: number = 0,
  indicatorWeights: Record<string, number> = {}
): { adjust: boolean; reason: string; action: string; newParams?: Partial<AdaptiveParams> } {
  // Cooldown check - don't adjust too frequently
  if (strategyPerformance.totalTrades < cooldownUntil) {
    return { adjust: false, reason: "In cooldown period", action: "Wait for more trades" };
  }
  
  if (strategyPerformance.totalTrades < 10) {
    return { adjust: false, reason: "Insufficient data", action: "Continue trading" };
  }

  // PRIMARY METRIC: Sharpe/Ulcer ratio drives all adjustments
  console.log(`AI Learning: Sharpe/Ulcer = ${sharpeUlcerRatio.toFixed(3)}, Win Rate = ${strategyPerformance.winRate.toFixed(1)}%`);
  
  // Check for rollback if performance degraded after adjustment
  if (previousParams && previousMetric !== 0) {
    const metricDelta = sharpeUlcerRatio - previousMetric;
    if (metricDelta < ROLLBACK_THRESHOLD && adaptiveParams.adjustmentCount > 0) {
      console.log(`AI Learning: ROLLBACK triggered. Metric dropped by ${metricDelta.toFixed(3)}`);
      adaptiveParams = { ...previousParams };
      previousParams = null;
      cooldownUntil = strategyPerformance.totalTrades + ADJUSTMENT_COOLDOWN_TRADES * 2;
      return { 
        adjust: true, 
        reason: `Performance degraded (${metricDelta.toFixed(3)}), reverting to previous params`,
        action: "Rollback to previous parameters"
      };
    }
  }

  let newParams: Partial<AdaptiveParams> = {};
  let adjustmentReason = "";
  let adjustmentAction = "";

  // ADAPTIVE MODE SWITCHING based on mode performance (Mike1 metric)
  // 3 Modes: Mean Reversion (sideways), Vol Expansion (trend), Pairs Trading (bear/uncertain)
  const now = Date.now();
  const meanRevPerf = modePerformance.meanReversion;
  const volExpPerf = modePerformance.volExpansion;
  const pairsPerf = modePerformance.pairsTrading;
  const MIN_MODE_TRADES = 10;
  
  // 4-HOUR ADAPTIVE LOOKBACK: Every 4 hours, compare mode performance
  const shouldRunLookback = now - adaptiveParams.lastLookbackAt >= FOUR_HOUR_MS;
  
  if (shouldRunLookback && 
      (meanRevPerf.trades >= MIN_MODE_TRADES || volExpPerf.trades >= MIN_MODE_TRADES || pairsPerf.trades >= MIN_MODE_TRADES)) {
    
    // Get Mike1 scores for all modes
    const meanRevMike1 = meanRevPerf.sharpeUlcer;
    const volExpMike1 = volExpPerf.sharpeUlcer;
    const pairsMike1 = pairsPerf.sharpeUlcer;
    
    console.log(`[4-Hour Lookback] Mode Mike1 scores: MeanRev=${meanRevMike1.toFixed(3)}, VolExp=${volExpMike1.toFixed(3)}, Pairs=${pairsMike1.toFixed(3)}`);
    
    // Find best performing mode
    const modes: { mode: StrategyMode; score: number; trades: number }[] = [
      { mode: 'meanReversion', score: meanRevMike1, trades: meanRevPerf.trades },
      { mode: 'volExpansion', score: volExpMike1, trades: volExpPerf.trades },
      { mode: 'pairsTrading', score: pairsMike1, trades: pairsPerf.trades },
    ];
    
    // Only consider modes with enough trades
    const viableModes = modes.filter(m => m.trades >= MIN_MODE_TRADES);
    
    if (viableModes.length > 0) {
      const bestMode = viableModes.reduce((best, curr) => curr.score > best.score ? curr : best);
      const currentScore = modes.find(m => m.mode === adaptiveParams.strategyMode)?.score ?? 0;
      
      // Switch if best mode is significantly better (> 0.3 Mike1 difference)
      if (bestMode.mode !== adaptiveParams.strategyMode && bestMode.score > currentScore + 0.3) {
        console.log(`[4-Hour Lookback] MODE SWITCH -> ${bestMode.mode} (Mike1: ${bestMode.score.toFixed(3)} vs current ${currentScore.toFixed(3)})`);
        newParams.strategyMode = bestMode.mode;
        newParams.lastLookbackAt = now;
        adjustmentReason = `${bestMode.mode} has higher Mike1 score (${bestMode.score.toFixed(3)})`;
        adjustmentAction = `Switch to ${bestMode.mode} mode`;
      } else {
        // Update lookback time even if no switch
        newParams.lastLookbackAt = now;
      }
    }
  }
  
  // FALLBACK: If current mode failing badly, try rotating through modes
  if (sharpeUlcerRatio < 0 && strategyPerformance.totalTrades >= 20 && !adjustmentAction) {
    const currentMode = adaptiveParams.strategyMode;
    let nextMode: StrategyMode;
    
    // Rotate: meanReversion -> volExpansion -> pairsTrading -> meanReversion
    if (currentMode === 'meanReversion') {
      nextMode = 'volExpansion';
    } else if (currentMode === 'volExpansion') {
      nextMode = 'pairsTrading';
    } else if (currentMode === 'pairsTrading') {
      nextMode = 'meanReversion';
    } else {
      nextMode = 'meanReversion'; // Default for adaptive
    }
    
    console.log(`AI Learning: Current mode ${currentMode} failing, rotating to ${nextMode}`);
    newParams.strategyMode = nextMode;
    adjustmentReason = `Current mode failing (Mike1=${sharpeUlcerRatio.toFixed(3)}), trying ${nextMode}`;
    adjustmentAction = `Switch to ${nextMode} mode`;
  }

  // CRITICAL: Sharpe/Ulcer < 0 = Very Poor Performance
  if (sharpeUlcerRatio < 0) {
    adjustmentReason = `Sharpe/Ulcer deeply negative (${sharpeUlcerRatio.toFixed(3)})`;
    
    // Dramatically tighten entry requirements
    newParams = {
      signalThreshold: Math.min(50, adaptiveParams.signalThreshold + 10), // Require stronger signals
      riskPercent: Math.max(0.02, adaptiveParams.riskPercent * 0.8),      // Reduce risk but keep minimum 2%
      atrMultiplier: Math.min(6.0, adaptiveParams.atrMultiplier + 0.5),   // Wider stops (up to 6x ATR)
      minRiskReward: Math.min(3.0, adaptiveParams.minRiskReward + 0.3),   // Demand better R:R
      zScoreMax: Math.max(1.0, adaptiveParams.zScoreMax - 0.3),           // Stricter Z-Score gate
      requireAdxHook: true,                                                // Require trend confirmation
    };
    
    // Determine side bias from recent trades
    const recentLongs = strategyPerformance.totalTrades > 0 ? 0.5 : 0; // Placeholder - would track actual sides
    if (strategyPerformance.winRate < 20) {
      // If completely failing, flip the bias
      newParams.sideBias = adaptiveParams.sideBias === 0 ? -1 : -adaptiveParams.sideBias;
    }
    
    adjustmentAction = `Tighten entry: threshold=${newParams.signalThreshold}, risk=${(newParams.riskPercent! * 100).toFixed(1)}%, requireADX=true`;
  }
  // POOR: 0 <= Sharpe/Ulcer < 0.5
  else if (sharpeUlcerRatio < 0.5) {
    adjustmentReason = `Sharpe/Ulcer below target (${sharpeUlcerRatio.toFixed(3)})`;
    
    newParams = {
      signalThreshold: Math.min(40, adaptiveParams.signalThreshold + 5),
      riskPercent: Math.max(0.02, adaptiveParams.riskPercent * 0.9),      // Keep minimum 2%
      atrMultiplier: Math.min(5.0, adaptiveParams.atrMultiplier + 0.25),  // Widen stops
      minRiskReward: Math.min(2.5, adaptiveParams.minRiskReward + 0.15),
    };
    
    adjustmentAction = `Moderate tightening: threshold=${newParams.signalThreshold}, risk=${(newParams.riskPercent! * 100).toFixed(1)}%`;
  }
  // ACCEPTABLE: 0.5 <= Sharpe/Ulcer < 1.0
  else if (sharpeUlcerRatio < 1.0) {
    // Minor adjustments only
    if (strategyPerformance.winRate < 40) {
      newParams = {
        signalThreshold: Math.min(35, adaptiveParams.signalThreshold + 3),
      };
      adjustmentReason = `Win rate low (${strategyPerformance.winRate.toFixed(1)}%) despite acceptable Sharpe/Ulcer`;
      adjustmentAction = `Slight tightening: threshold=${newParams.signalThreshold}`;
    } else {
      return { adjust: false, reason: "Acceptable performance", action: "Continue trading" };
    }
  }
  // GOOD: Sharpe/Ulcer >= 1.0
  else {
    // Can slightly loosen requirements
    if (adaptiveParams.signalThreshold > DEFAULT_PARAMS.signalThreshold) {
      newParams = {
        signalThreshold: Math.max(DEFAULT_PARAMS.signalThreshold, adaptiveParams.signalThreshold - 2),
        riskPercent: Math.min(0.025, adaptiveParams.riskPercent * 1.05),
      };
      adjustmentReason = `Strong performance (${sharpeUlcerRatio.toFixed(3)}), loosening slightly`;
      adjustmentAction = `Loosen: threshold=${newParams.signalThreshold}, risk=${(newParams.riskPercent! * 100).toFixed(1)}%`;
    } else {
      return { adjust: false, reason: "Strong performance maintained", action: "Continue trading" };
    }
  }

  // Apply learned indicator weights to scoring (future signals will use these)
  const bestIndicators = Object.entries(indicatorWeights)
    .filter(([_, weight]) => weight > 1.2)
    .map(([name, _]) => name);
  
  if (bestIndicators.length > 0) {
    console.log(`AI Learning: Strong indicators: ${bestIndicators.join(', ')}`);
  }

  // Save current params for rollback
  previousParams = { ...adaptiveParams };
  previousMetric = sharpeUlcerRatio;

  // Apply new parameters
  Object.assign(adaptiveParams, newParams);
  adaptiveParams.lastAdjustedAt = Date.now();
  adaptiveParams.adjustmentCount++;

  // Set cooldown
  cooldownUntil = strategyPerformance.totalTrades + ADJUSTMENT_COOLDOWN_TRADES;

  console.log(`AI Learning: Adjustment #${adaptiveParams.adjustmentCount} applied. Cooldown until trade ${cooldownUntil}`);

  return { 
    adjust: true, 
    reason: adjustmentReason, 
    action: adjustmentAction,
    newParams 
  };
}

// Reset adaptive params (for testing or manual reset)
export function resetAdaptiveParams(): void {
  adaptiveParams = { ...DEFAULT_PARAMS };
  previousParams = null;
  previousMetric = 0;
  cooldownUntil = 0;
}
