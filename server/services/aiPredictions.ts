import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CryptoData, AIPrediction, PredictionAccuracy } from "@shared/schema";
import { v4 as uuidv4 } from "uuid";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

type Timeframe = "10m" | "30m" | "60m" | "4h" | "24h";

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "10m": 10 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "60m": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

const predictions: Map<string, AIPrediction> = new Map();
const accuracyStats: Map<Timeframe, PredictionAccuracy> = new Map();

let lastPredictionTime = 0;
const PREDICTION_COOLDOWN = 60000;

function calculateRSI(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMomentum(prices: number[], period = 10): number {
  if (prices.length < period) return 0;
  const current = prices[prices.length - 1];
  const past = prices[prices.length - period];
  return ((current - past) / past) * 100;
}

function calculateVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

function calculateBollingerPosition(prices: number[], period = 20): number {
  if (prices.length < period) return 0.5;
  
  const recentPrices = prices.slice(-period);
  const sma = recentPrices.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(
    recentPrices.reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period
  );
  
  const current = prices[prices.length - 1];
  const upperBand = sma + 2 * stdDev;
  const lowerBand = sma - 2 * stdDev;
  
  if (upperBand === lowerBand) return 0.5;
  return (current - lowerBand) / (upperBand - lowerBand);
}

function calculateMACD(prices: number[]): { macd: number; signal: number; histogram: number } {
  if (prices.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macd = ema12 - ema26;
  
  const macdHistory: number[] = [];
  for (let i = 26; i < prices.length; i++) {
    const shortEma = calculateEMA(prices.slice(0, i + 1), 12);
    const longEma = calculateEMA(prices.slice(0, i + 1), 26);
    macdHistory.push(shortEma - longEma);
  }
  
  const signal = macdHistory.length >= 9 ? calculateEMA(macdHistory, 9) : macd;
  
  return { macd, signal, histogram: macd - signal };
}

function calculateEMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

function generateQuantPrediction(
  crypto: CryptoData,
  timeframe: Timeframe,
  sentimentScore: number
): Omit<AIPrediction, "id" | "createdAt" | "targetTime" | "resolved" | "actualPrice" | "actualChange" | "accuracyScore" | "wasCorrect"> {
  const prices = crypto.sparkline_in_7d?.price || [];
  const currentPrice = crypto.current_price;
  
  const rsi = calculateRSI(prices);
  const momentum = calculateMomentum(prices);
  const volatility = calculateVolatility(prices);
  const bollingerPos = calculateBollingerPosition(prices);
  const macd = calculateMACD(prices);
  
  let technicalScore = 0;
  let signals: string[] = [];
  
  if (rsi < 30) {
    technicalScore += 0.3;
    signals.push("RSI oversold");
  } else if (rsi > 70) {
    technicalScore -= 0.3;
    signals.push("RSI overbought");
  } else {
    technicalScore += (rsi - 50) / 100;
  }
  
  if (momentum > 5) {
    technicalScore += 0.25;
    signals.push("Strong momentum");
  } else if (momentum < -5) {
    technicalScore -= 0.25;
    signals.push("Weak momentum");
  }
  
  if (bollingerPos < 0.2) {
    technicalScore += 0.2;
    signals.push("Near lower Bollinger");
  } else if (bollingerPos > 0.8) {
    technicalScore -= 0.2;
    signals.push("Near upper Bollinger");
  }
  
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    technicalScore += 0.15;
    signals.push("MACD bullish");
  } else if (macd.histogram < 0 && macd.macd < macd.signal) {
    technicalScore -= 0.15;
    signals.push("MACD bearish");
  }
  
  const sentimentWeight = 0.2;
  const combinedScore = (technicalScore * (1 - sentimentWeight)) + (sentimentScore * sentimentWeight);
  
  const timeframeMultiplier: Record<Timeframe, number> = {
    "10m": 0.15,
    "30m": 0.3,
    "60m": 0.5,
    "4h": 1.5,
    "24h": 3,
  };
  
  const volatilityFactor = Math.max(0.5, Math.min(2, volatility / 2));
  const baseChange = combinedScore * timeframeMultiplier[timeframe] * volatilityFactor;
  const predictedChange = Math.max(-20, Math.min(20, baseChange));
  
  const predictedPrice = currentPrice * (1 + predictedChange / 100);
  
  const baseConfidence = 0.5 + Math.abs(combinedScore) * 0.3;
  const volatilityPenalty = Math.min(0.2, volatility / 50);
  const confidence = Math.max(0.3, Math.min(0.9, baseConfidence - volatilityPenalty));
  
  const direction: "up" | "down" | "neutral" = 
    predictedChange > 0.5 ? "up" : predictedChange < -0.5 ? "down" : "neutral";
  
  return {
    symbol: crypto.symbol.toUpperCase(),
    coinName: crypto.name,
    timeframe,
    priceAtPrediction: currentPrice,
    predictedPrice,
    predictedChange,
    direction,
    confidence,
    methodology: signals.slice(0, 3).join(", ") || "Technical analysis",
    indicators: {
      rsi,
      momentum,
      volatility,
      sentimentScore,
    },
  };
}

export async function generatePredictions(
  cryptos: CryptoData[],
  sentimentScore: number = 0
): Promise<AIPrediction[]> {
  const now = Date.now();
  
  if (now - lastPredictionTime < PREDICTION_COOLDOWN) {
    return getActivePredictions();
  }
  
  lastPredictionTime = now;
  const newPredictions: AIPrediction[] = [];
  const topCryptos = cryptos.slice(0, 5);
  const shortTimeframes: Timeframe[] = ["10m", "30m", "60m"];
  const longTimeframes: Timeframe[] = ["4h", "24h"];
  
  for (const crypto of topCryptos) {
    for (const tf of shortTimeframes) {
      const predBase = generateQuantPrediction(crypto, tf, sentimentScore);
      const prediction: AIPrediction = {
        id: uuidv4(),
        ...predBase,
        createdAt: new Date().toISOString(),
        targetTime: new Date(now + TIMEFRAME_MS[tf]).toISOString(),
        resolved: false,
        actualPrice: null,
        actualChange: null,
        accuracyScore: null,
        wasCorrect: null,
      };
      predictions.set(prediction.id, prediction);
      newPredictions.push(prediction);
    }
  }
  
  const btc = cryptos.find((c) => c.symbol.toLowerCase() === "btc");
  if (btc) {
    for (const tf of longTimeframes) {
      const predBase = generateQuantPrediction(btc, tf, sentimentScore);
      const prediction: AIPrediction = {
        id: uuidv4(),
        ...predBase,
        createdAt: new Date().toISOString(),
        targetTime: new Date(now + TIMEFRAME_MS[tf]).toISOString(),
        resolved: false,
        actualPrice: null,
        actualChange: null,
        accuracyScore: null,
        wasCorrect: null,
      };
      predictions.set(prediction.id, prediction);
      newPredictions.push(prediction);
    }
  }
  
  cleanupOldPredictions();
  
  return newPredictions;
}

export async function resolvePredictions(cryptos: CryptoData[]): Promise<void> {
  const now = Date.now();
  const priceMap = new Map(cryptos.map((c) => [c.symbol.toUpperCase(), c.current_price]));
  
  for (const [id, pred] of Array.from(predictions.entries())) {
    if (pred.resolved) continue;
    
    const targetTime = new Date(pred.targetTime).getTime();
    if (now >= targetTime) {
      const actualPrice = priceMap.get(pred.symbol);
      if (actualPrice !== undefined) {
        const actualChange = ((actualPrice - pred.priceAtPrediction) / pred.priceAtPrediction) * 100;
        const predictionError = Math.abs(pred.predictedChange - actualChange);
        const maxError = Math.max(Math.abs(pred.predictedChange), Math.abs(actualChange), 1);
        const accuracyScore = Math.max(0, 1 - predictionError / maxError);
        
        const actualDirection = actualChange > 0.5 ? "up" : actualChange < -0.5 ? "down" : "neutral";
        const wasCorrect = pred.direction === actualDirection || 
          (pred.direction === "neutral" && Math.abs(actualChange) < 1);
        
        pred.resolved = true;
        pred.actualPrice = actualPrice;
        pred.actualChange = actualChange;
        pred.accuracyScore = accuracyScore;
        pred.wasCorrect = wasCorrect;
        
        predictions.set(id, pred);
        updateAccuracyStats(pred);
      }
    }
  }
}

function updateAccuracyStats(pred: AIPrediction): void {
  const tf = pred.timeframe;
  const existing = accuracyStats.get(tf) || {
    timeframe: tf,
    totalPredictions: 0,
    correctPredictions: 0,
    accuracyRate: 0,
    averageError: 0,
    directionAccuracy: 0,
    lastUpdated: new Date().toISOString(),
  };
  
  existing.totalPredictions += 1;
  if (pred.wasCorrect) {
    existing.correctPredictions += 1;
  }
  existing.directionAccuracy = (existing.correctPredictions / existing.totalPredictions) * 100;
  
  const predictionError = Math.abs((pred.predictedChange || 0) - (pred.actualChange || 0));
  existing.averageError = (existing.averageError * (existing.totalPredictions - 1) + predictionError) / existing.totalPredictions;
  existing.accuracyRate = Math.max(0, 100 - existing.averageError * 10);
  existing.lastUpdated = new Date().toISOString();
  
  accuracyStats.set(tf, existing);
}

function cleanupOldPredictions(): void {
  const maxAge = 48 * 60 * 60 * 1000;
  const now = Date.now();
  
  for (const [id, pred] of Array.from(predictions.entries())) {
    const createdAt = new Date(pred.createdAt).getTime();
    if (now - createdAt > maxAge) {
      predictions.delete(id);
    }
  }
}

export function getActivePredictions(limit = 50): AIPrediction[] {
  const now = Date.now();
  return Array.from(predictions.values())
    .filter((p) => !p.resolved && new Date(p.targetTime).getTime() > now)
    .sort((a, b) => new Date(a.targetTime).getTime() - new Date(b.targetTime).getTime())
    .slice(0, limit);
}

export function getResolvedPredictions(limit = 20): AIPrediction[] {
  return Array.from(predictions.values())
    .filter((p) => p.resolved)
    .sort((a, b) => new Date(b.targetTime).getTime() - new Date(a.targetTime).getTime())
    .slice(0, limit);
}

export function getAccuracyStats(): PredictionAccuracy[] {
  return Array.from(accuracyStats.values());
}

export function getAllPredictionData(): {
  active: AIPrediction[];
  resolved: AIPrediction[];
  accuracy: PredictionAccuracy[];
} {
  return {
    active: getActivePredictions(),
    resolved: getResolvedPredictions(),
    accuracy: getAccuracyStats(),
  };
}
