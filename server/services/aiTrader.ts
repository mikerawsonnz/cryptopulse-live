import { GoogleGenerativeAI } from "@google/generative-ai";
import { AITradeSignal, CryptoData, PositionSide } from "@shared/schema";
import { getPortfolioState, canOpenPosition, getSharpeUlcerRatio } from "./paperTrading";
import { 
  calculateTechnicalIndicators, 
  generateQuantSignal, 
  generateMeanReversionSignal,
  generateMomentumFallbackSignal,
  detectMarketRegime,
  rankSignals,
  updateStrategyPerformance,
  getStrategyPerformance,
  shouldAdjustStrategy,
  getAdaptiveParams,
  recordModePerformance,
  getTotalModeTradeCount,
  BOOTSTRAP_TRADE_THRESHOLD,
  type QuantSignal,
  type TechnicalIndicators,
  type AdaptiveParams,
  type StrategyMode
} from "./quantStrategy";
import { 
  isWarmupComplete, 
  getBestStrategy, 
  getStrategyAllocation,
  generateAllLiveSignals,
  generateAllShadowSignals,
  type Live4HSignal
} from "./syntheticWarmup";
import { getSizeMultiplier } from "./modeManager";
import { processShadowSignal, updateShadowPrices, getShadowAllocation, isShadowReady } from "./shadowTrading";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const MAX_POSITION_PERCENT = 0.05;

interface MarketData {
  cryptos: CryptoData[];
  sentiment: { coin: string; score: number } | null;
  signals: {
    divergences: Array<{ coin: string; type: string; strength: number }>;
    whaleFlow: { netFlow: number; bullishness: number };
    correlations: Array<{ coin: string; correlationWithBTC: number; trend: string }>;
  } | null;
  onchain: {
    btc: { mvrvZScore: number; nupl: number } | null;
    eth: { mvrvZScore: number; nupl: number } | null;
    market: { overallSentiment: string };
  } | null;
  capitalFlow: {
    netFlowSignal?: { direction: string; strength: string; score: number };
  } | null;
  liquidations: Array<{ symbol: string; volatilityTrap: string }>;
}

let lastAnalysisTime = 0;
const ANALYSIS_COOLDOWN = 25000;

export async function analyzeMarketForTrades(data: MarketData): Promise<AITradeSignal[]> {
  const now = Date.now();
  if (now - lastAnalysisTime < ANALYSIS_COOLDOWN) {
    return [];
  }
  lastAnalysisTime = now;

  const portfolio = getPortfolioState();
  
  // Get Sharpe/Ulcer ratio for adaptive learning
  const metrics = getSharpeUlcerRatio();
  const indicatorWeights = getIndicatorWeights();
  
  // Check if strategy needs adjustment based on PRIMARY METRIC (Sharpe/Ulcer)
  const strategyCheck = shouldAdjustStrategy(metrics.primary, indicatorWeights);
  if (strategyCheck.adjust) {
    console.log(`AI Trader: Strategy adjustment - ${strategyCheck.reason}. ${strategyCheck.action}`);
  }
  
  // Get current adaptive parameters (may have just been updated)
  const params = getAdaptiveParams();
  
  // Log current learning state
  console.log(`AI Trader: Primary Metric=${metrics.primary.toFixed(3)}, Threshold=${params.signalThreshold}, Risk=${(params.riskPercent * 100).toFixed(1)}%`);
  
  if (portfolio.currentDrawdown >= 20) {
    console.log("AI Trader: High drawdown (20%+), pausing trading");
    return [];
  }
  
  // Apply drawdown-based position size reduction
  let positionSizeMultiplier = 1.0;
  if (portfolio.currentDrawdown >= 15) {
    console.log("AI Trader: Elevated drawdown, reducing position sizes");
    positionSizeMultiplier = 0.5;
  }

  const signals: AITradeSignal[] = [];
  const quantSignals: QuantSignal[] = [];
  
  const stablecoins = ["usdt", "usdc", "dai", "busd", "tusd", "usdp", "fdusd"];
  const maxPositionValue = portfolio.equity * MAX_POSITION_PERCENT;
  const tradableCryptos = data.cryptos.filter(c => {
    const minTradeValue = c.current_price * 0.001;
    const isStablecoin = stablecoins.includes(c.symbol.toLowerCase());
    return !isStablecoin && minTradeValue <= maxPositionValue && (c.sparkline_in_7d?.price?.length || 0) > 30;
  });
  
  // Check if Synthetic Warm-Up is complete - this gives us pre-calculated Mike1 scores
  // from 90-day backtests so we're "smart from Day 1"
  const warmupComplete = isWarmupComplete();
  const allocation = getStrategyAllocation();
  const activeStrategy = getBestStrategy();
  
  // Check if we're in bootstrap phase (only if warmup failed or not complete)
  const totalModeTradeCount = getTotalModeTradeCount();
  const isBootstrapPhase = !warmupComplete && totalModeTradeCount < BOOTSTRAP_TRADE_THRESHOLD;
  
  if (warmupComplete) {
    console.log(`AI Trader: Using Warmup Mike1 - Primary: ${allocation.primary} (${(allocation.primaryWeight * 100).toFixed(0)}%)`);
    
    // USE 4H OHLC DATA FOR LIVE SIGNALS - MATCHES WARMUP LOGIC EXACTLY
    // This fixes the disconnect between warmup (4H OHLC) and live trading (sparkline)
    const cryptosForSignals = tradableCryptos.slice(0, 15).map(c => ({ id: c.id, current_price: c.current_price }));
    const live4HSignals = generateAllLiveSignals(cryptosForSignals);
    
    // Convert Live4HSignals to QuantSignals for the existing pipeline
    for (const liveSignal of live4HSignals) {
      const crypto = tradableCryptos.find(c => c.id === liveSignal.coinId);
      if (!crypto) continue;
      
      const prices = crypto.sparkline_in_7d?.price || [];
      const indicators = prices.length >= 30 ? calculateTechnicalIndicators(prices) : null;
      
      const stopDist = Math.abs(liveSignal.entryPrice - liveSignal.stopLoss);
      const tpDist = Math.abs(liveSignal.takeProfit - liveSignal.entryPrice);
      const computedRR = stopDist > 0 ? tpDist / stopDist : 1.5;
      
      const quantSignal: QuantSignal = {
        symbol: liveSignal.symbol,
        coinName: crypto.name,
        action: liveSignal.side === 'long' ? 'buy' : 'sell',
        side: liveSignal.side,
        confidence: liveSignal.confidence,
        strength: liveSignal.confidence,
        indicators: indicators || {} as TechnicalIndicators,
        reasoning: liveSignal.reasoning,
        entryPrice: liveSignal.entryPrice,
        stopLoss: liveSignal.stopLoss,
        takeProfit: liveSignal.takeProfit,
        riskRewardRatio: computedRR,
        positionSizePercent: 5.0,
        timestamp: new Date(),
      };
      
      (quantSignal as any).signalMode = liveSignal.strategy as StrategyMode;
      (quantSignal as any).coinId = liveSignal.coinId;
      quantSignals.push(quantSignal);
    }
    
    // SHADOW TRADING: Generate signals for ALL strategies (not just allocated) to feed shadow engine
    const shadowSignals = generateAllShadowSignals(cryptosForSignals);
    for (const shadowSig of shadowSignals) {
      const crypto = tradableCryptos.find(c => c.id === shadowSig.coinId);
      if (!crypto) continue;
      const shadowStrategy = shadowSig.strategy as StrategyMode;
      const sDist = Math.abs(shadowSig.entryPrice - shadowSig.stopLoss);
      const tDist = Math.abs(shadowSig.takeProfit - shadowSig.entryPrice);
      const shadowRR = sDist > 0 ? tDist / sDist : 1.5;
      
      processShadowSignal({
        symbol: shadowSig.symbol,
        coinName: crypto.name,
        action: shadowSig.side === 'long' ? 'buy' : 'sell',
        side: shadowSig.side,
        confidence: shadowSig.confidence,
        strength: shadowSig.confidence,
        indicators: {} as TechnicalIndicators,
        reasoning: shadowSig.reasoning,
        entryPrice: shadowSig.entryPrice,
        stopLoss: shadowSig.stopLoss,
        takeProfit: shadowSig.takeProfit,
        riskRewardRatio: shadowRR,
        positionSizePercent: 5.0,
        timestamp: new Date(),
      }, shadowStrategy);
    }
    
    // Skip the old sparkline-based signal generation when warmup is complete
    // The for loop below handles bootstrap/fallback cases
  } else if (isBootstrapPhase) {
    console.log(`AI Trader: BOOTSTRAP PHASE - ${totalModeTradeCount}/${BOOTSTRAP_TRADE_THRESHOLD} trades. Running ALL modes in parallel.`);
  } else {
    console.log(`AI Trader: Analyzing ${tradableCryptos.length} cryptos with adaptive parameters (mode: ${params.strategyMode})`);
  }
  
  const capitalFlowScore = data.capitalFlow?.netFlowSignal?.score || 0;
  
  // Only run sparkline-based signal generation if warmup is NOT complete
  // When warmup is complete, we use the 4H OHLC signals generated above
  if (!warmupComplete) {
    for (const crypto of tradableCryptos.slice(0, 15)) {
      const symbol = crypto.symbol.toUpperCase();
      const mvrvZScore = symbol === "BTC" 
        ? data.onchain?.btc?.mvrvZScore ?? null
        : symbol === "ETH" 
          ? data.onchain?.eth?.mvrvZScore ?? null
          : null;
      
      const prices = crypto.sparkline_in_7d?.price || [];
      const indicators = prices.length >= 30 ? calculateTechnicalIndicators(prices) : null;
    
      // BOOTSTRAP PHASE: Run ALL modes simultaneously to quickly collect performance data
      // Only used if warmup failed or is not complete
      if (isBootstrapPhase) {
      // Generate signals from BOTH Mean Reversion AND Vol Expansion with relaxed entry requirements
      const meanRevSignal = generateMeanReversionSignal(crypto, portfolio.equity, params, indicatorWeights, true);
      const volExpSignal = generateQuantSignal(crypto, mvrvZScore, capitalFlowScore, portfolio.equity, params, indicatorWeights, true);
      
      // Add mean reversion signal if valid
      if (meanRevSignal) {
        const sideBiasMatch = params.sideBias === 0 || 
          (params.sideBias > 0 && meanRevSignal.side === 'long') ||
          (params.sideBias < 0 && meanRevSignal.side === 'short');
        
        if (meanRevSignal.strength >= params.signalThreshold && sideBiasMatch) {
          meanRevSignal.reasoning.unshift(`[BOOTSTRAP] Mode: Mean Reversion`);
          (meanRevSignal as any).signalMode = 'meanReversion' as StrategyMode;
          quantSignals.push(meanRevSignal);
        }
      }
      
      // Add vol expansion signal if valid
      if (volExpSignal) {
        const sideBiasMatch = params.sideBias === 0 || 
          (params.sideBias > 0 && volExpSignal.side === 'long') ||
          (params.sideBias < 0 && volExpSignal.side === 'short');
        
        if (volExpSignal.strength >= params.signalThreshold && sideBiasMatch) {
          volExpSignal.reasoning.unshift(`[BOOTSTRAP] Mode: Vol Expansion`);
          (volExpSignal as any).signalMode = 'volExpansion' as StrategyMode;
          quantSignals.push(volExpSignal);
        }
      }
      
      // Note: Pairs Trading signals are generated by correlationStrategy separately
      continue; // Move to next crypto
    }
    
    // POST-BOOTSTRAP: Use weighted allocation based on Mike1 performance
    let quantSignal: QuantSignal | null = null;
    let signalMode: StrategyMode = 'volExpansion';
    
    // ADAPTIVE MODE SELECTION based on strategy mode and market regime
    if (params.strategyMode === 'adaptive' && indicators) {
      // In adaptive mode, choose signal type based on detected market regime
      const regime = detectMarketRegime(indicators);
      
      if (regime === 'ranging') {
        // Ranging market - prefer mean reversion
        quantSignal = generateMeanReversionSignal(crypto, portfolio.equity, params, indicatorWeights);
        signalMode = 'meanReversion';
        if (quantSignal) {
          quantSignal.reasoning.unshift(`Regime: Ranging (ADX=${indicators.adx.toFixed(1)}) - Mean Reversion`);
        }
      } else if (regime === 'trending') {
        // Trending market - prefer vol expansion
        quantSignal = generateQuantSignal(crypto, mvrvZScore, capitalFlowScore, portfolio.equity, params, indicatorWeights);
        signalMode = 'volExpansion';
        if (quantSignal) {
          quantSignal.reasoning.unshift(`Regime: Trending (ADX=${indicators.adx.toFixed(1)}) - Vol Expansion`);
        }
      } else {
        // Unknown regime - try both, take the stronger signal
        const volExpSignal = generateQuantSignal(crypto, mvrvZScore, capitalFlowScore, portfolio.equity, params, indicatorWeights);
        const meanRevSignal = generateMeanReversionSignal(crypto, portfolio.equity, params, indicatorWeights);
        
        if (volExpSignal && meanRevSignal) {
          // Take the one with higher confidence
          if (volExpSignal.confidence >= meanRevSignal.confidence) {
            quantSignal = volExpSignal;
            signalMode = 'volExpansion';
          } else {
            quantSignal = meanRevSignal;
            signalMode = 'meanReversion';
          }
        } else {
          quantSignal = volExpSignal || meanRevSignal;
          signalMode = volExpSignal ? 'volExpansion' : 'meanReversion';
        }
      }
    } else if (params.strategyMode === 'meanReversion') {
      // Fixed mean reversion mode
      quantSignal = generateMeanReversionSignal(crypto, portfolio.equity, params, indicatorWeights);
      signalMode = 'meanReversion';
    } else {
      // Default: vol expansion mode
      quantSignal = generateQuantSignal(crypto, mvrvZScore, capitalFlowScore, portfolio.equity, params, indicatorWeights);
      signalMode = 'volExpansion';
    }
    
    // Apply side bias filter
    if (quantSignal) {
      const sideBiasMatch = params.sideBias === 0 || 
        (params.sideBias > 0 && quantSignal.side === 'long') ||
        (params.sideBias < 0 && quantSignal.side === 'short');
      
      if (quantSignal.strength >= params.signalThreshold && sideBiasMatch) {
        // Tag signal with mode for performance tracking
        (quantSignal as any).signalMode = signalMode;
        quantSignals.push(quantSignal);
      }
    }
    }
  }
  
  // Always generate momentum signals - promoted to full strategy
  const momentumSignals: QuantSignal[] = [];
  for (const crypto of tradableCryptos.slice(0, 15)) {
    const momentumSignal = generateMomentumFallbackSignal(crypto, portfolio.equity, params, indicatorWeights);
    if (momentumSignal) {
      momentumSignal.reasoning.unshift(`[MOMENTUM] Obvious move detected`);
      (momentumSignal as any).signalMode = 'momentum' as StrategyMode;
      momentumSignals.push(momentumSignal);
      console.log(`AI Trader: MOMENTUM signal for ${crypto.symbol.toUpperCase()}`);
    }
  }
  
  const allSignals = [...quantSignals, ...momentumSignals];
  const finalSignals = rankSignals(allSignals);
  console.log(`AI Trader: ${finalSignals.length} total signals (${quantSignals.length} primary + ${momentumSignals.length} momentum)`);
  
  for (const qs of finalSignals) {
    const coinId = (qs as any).coinId;
    const crypto = data.cryptos.find(c => c.symbol.toUpperCase() === qs.symbol) 
      || (coinId ? data.cryptos.find(c => c.id === coinId) : null);
    if (!crypto) {
      console.log(`AI Trader: SKIP ${qs.symbol} - crypto not found in data.cryptos (available: ${data.cryptos.map(c => c.symbol).join(',')})`);
      continue;
    }
    
    const signal = convertQuantToTradeSignal(qs, crypto, data, portfolio, positionSizeMultiplier, params);
    if (signal) {
      const check = canOpenPosition(signal);
      if (check.allowed) {
        signals.push(signal);
      } else {
        console.log(`AI Trader: Position blocked for ${qs.symbol}: ${check.reason}`);
      }
    } else {
      console.log(`AI Trader: convertQuantToTradeSignal returned null for ${qs.symbol}`);
    }
  }

  // During bootstrap, allow more signals per cycle to quickly build trade history
  const maxSignals = isBootstrapPhase ? 4 : 2;
  return signals.slice(0, maxSignals);
}

// Export function to check if we're in bootstrap phase (for routes.ts to pass to openPosition)
export function isInBootstrapPhase(): boolean {
  const totalModeTradeCount = getTotalModeTradeCount();
  return totalModeTradeCount < BOOTSTRAP_TRADE_THRESHOLD;
}

function convertQuantToTradeSignal(
  qs: QuantSignal,
  crypto: CryptoData,
  data: MarketData,
  portfolio: any,
  positionSizeMultiplier: number = 1.0,
  adaptiveParams?: AdaptiveParams
): AITradeSignal | null {
  if (qs.confidence < 0.50) {
    console.log(`[Quality Gate] REJECT ${qs.symbol}: confidence ${(qs.confidence*100).toFixed(0)}% < 50% minimum`);
    return null;
  }
  if (qs.riskRewardRatio < 1.0) {
    console.log(`[Quality Gate] REJECT ${qs.symbol}: R:R ${qs.riskRewardRatio.toFixed(2)} < 1.0 minimum`);
    return null;
  }
  
  const priceChange24h = crypto.price_change_percentage_24h || 0;
  
  const signalMode = (qs as any).signalMode as StrategyMode | undefined;
  const momentumMult = signalMode ? getSizeMultiplier(signalMode) : 1.0;
  
  let positionSize = portfolio.equity * qs.positionSizePercent * positionSizeMultiplier * momentumMult;
  const minPositionSize = Math.max(3, portfolio.equity * 0.03);
  positionSize = Math.max(positionSize, minPositionSize);
  positionSize = Math.min(positionSize, portfolio.equity * MAX_POSITION_PERCENT);
  
  const sentimentScore = data.sentiment?.score || 0;
  const whaleFlow = data.signals?.whaleFlow;
  const liquidationData = data.liquidations.find(l => l.symbol.includes(qs.symbol));
  
  const modeLabel = signalMode === 'volExpansion' ? 'Vol Expansion' 
    : signalMode === 'meanReversion' ? 'Mean Reversion'
    : signalMode === 'momentum' ? 'Momentum'
    : signalMode || 'Unknown';
  const openReason = `${modeLabel} | ${qs.side.toUpperCase()} | Conf: ${(qs.confidence * 100).toFixed(0)}% | R:R ${qs.riskRewardRatio.toFixed(1)} | ${qs.reasoning[0] || ''}`;

  return {
    symbol: qs.symbol,
    coinName: qs.coinName,
    action: "buy",
    side: qs.side,
    confidence: qs.confidence,
    targetEntry: qs.entryPrice,
    stopLoss: qs.stopLoss,
    takeProfit: qs.takeProfit,
    riskRewardRatio: qs.riskRewardRatio,
    positionSize,
    reasoning: qs.reasoning.join(". ") + ".",
    signalMode,
    openReason,
    signals: {
      sentiment: sentimentScore,
      whaleFlow: whaleFlow ? (whaleFlow.bullishness > 0.5 ? "accumulation" : "distribution") : undefined,
      capitalFlow: data.capitalFlow?.netFlowSignal?.direction || "neutral",
      priceChange24h,
      liquidationRisk: liquidationData?.volatilityTrap,
    },
    timestamp: new Date().toISOString(),
  };
}

// Learning sample type for tracking trade context
interface LearningSample {
  pnlPercent: number;
  isWin: boolean;
  side: string;
  symbol: string;
  durationMs: number;
  indicators: Record<string, boolean | undefined>;
  entryGates?: {
    zScoreGate: boolean;
    meanProximityGate: boolean;
    adxGate: boolean;
    perfectSetup: boolean;
  };
  signalMode?: StrategyMode;
}

// Store learning samples for indicator attribution
const learningSamples: LearningSample[] = [];
const MAX_SAMPLES = 200;

// Track indicator win rates for adaptive weighting
interface IndicatorAttribution {
  trades: number;
  wins: number;
  totalPnl: number;
  weight: number;
}

const indicatorAttribution: Record<string, IndicatorAttribution> = {
  rsiOversold: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  rsiOverbought: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  macdBullish: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  macdBearish: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  volatilitySqueeze: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  meanProximity: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  adxHookingUp: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  trendUp: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  trendDown: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  mvrvUndervalued: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  mvrvOvervalued: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  capitalInflow: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
  capitalOutflow: { trades: 0, wins: 0, totalPnl: 0, weight: 1.0 },
};

// Track entry gate performance for learning
interface GatePerformance {
  trades: number;
  wins: number;
  avgPnl: number;
}

const gatePerformance: Record<string, GatePerformance> = {
  meanProximityGate: { trades: 0, wins: 0, avgPnl: 0 },
  adxGate: { trades: 0, wins: 0, avgPnl: 0 },
  perfectSetup: { trades: 0, wins: 0, avgPnl: 0 },
};

// Get gate performance stats for adaptive gate requirements
export function getGatePerformance(): Record<string, { winRate: number; avgPnl: number }> {
  const result: Record<string, { winRate: number; avgPnl: number }> = {};
  for (const [key, perf] of Object.entries(gatePerformance)) {
    if (perf.trades > 0) {
      result[key] = {
        winRate: (perf.wins / perf.trades) * 100,
        avgPnl: perf.avgPnl,
      };
    }
  }
  return result;
}

export function recordLearningSample(sample: LearningSample): void {
  learningSamples.push(sample);
  
  // Trim to max samples
  while (learningSamples.length > MAX_SAMPLES) {
    learningSamples.shift();
  }
  
  // Update indicator attribution
  for (const [key, value] of Object.entries(sample.indicators)) {
    if (value && indicatorAttribution[key]) {
      const attr = indicatorAttribution[key];
      attr.trades++;
      attr.totalPnl += sample.pnlPercent;
      if (sample.isWin) attr.wins++;
      
      // Recalculate weight based on performance
      if (attr.trades >= 5) {
        const winRate = attr.wins / attr.trades;
        const avgPnl = attr.totalPnl / attr.trades;
        // Weight = combination of win rate and avg pnl
        attr.weight = Math.max(0.1, Math.min(2.0, 0.5 + winRate + (avgPnl / 10)));
      }
    }
  }
  
  // Update entry gate performance for learning
  if (sample.entryGates) {
    for (const [key, passed] of Object.entries(sample.entryGates)) {
      if (passed && gatePerformance[key]) {
        const perf = gatePerformance[key];
        perf.trades++;
        if (sample.isWin) perf.wins++;
        perf.avgPnl = (perf.avgPnl * (perf.trades - 1) + sample.pnlPercent) / perf.trades;
      }
    }
    
    // Log gate performance if enough data
    const gateStats = getGatePerformance();
    if (Object.keys(gateStats).length > 0) {
      console.log(`AI Learning: Gate performance - ${Object.entries(gateStats)
        .map(([k, v]) => `${k}: ${v.winRate.toFixed(0)}% win, ${v.avgPnl.toFixed(2)}% pnl`)
        .join(', ')}`);
    }
  }
  
  console.log(`AI Learning: Sample recorded. Total samples: ${learningSamples.length}`);
}

export function getIndicatorWeights(): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const [key, attr] of Object.entries(indicatorAttribution)) {
    weights[key] = attr.weight;
  }
  return weights;
}

export function getLearningSummary(): { sampleCount: number; indicatorStats: Record<string, { trades: number; winRate: number; avgPnl: number; weight: number }> } {
  const indicatorStats: Record<string, { trades: number; winRate: number; avgPnl: number; weight: number }> = {};
  
  for (const [key, attr] of Object.entries(indicatorAttribution)) {
    if (attr.trades > 0) {
      indicatorStats[key] = {
        trades: attr.trades,
        winRate: (attr.wins / attr.trades) * 100,
        avgPnl: attr.totalPnl / attr.trades,
        weight: attr.weight,
      };
    }
  }
  
  return { sampleCount: learningSamples.length, indicatorStats };
}

export function recordTradeResult(pnlPercent: number): void {
  updateStrategyPerformance(pnlPercent);
  
  const perf = getStrategyPerformance();
  console.log(`AI Trader: Trade recorded (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%). ` +
    `Win rate: ${perf.winRate.toFixed(1)}%, Expectancy: ${perf.expectancy.toFixed(2)}%`);
}

export function getQuantStrategyStats() {
  return getStrategyPerformance();
}

export async function getAITradeAdvice(
  data: MarketData,
  currentPositions: Array<{ symbol: string; side: string; unrealizedPnlPercent: number }>
): Promise<string> {
  const prompt = `You are a professional crypto trader managing a $100 paper trading portfolio.

Current Market Data:
- BTC Price: $${data.cryptos.find(c => c.symbol === "btc")?.current_price || "N/A"}
- BTC Sentiment: ${data.sentiment?.score ? (data.sentiment.score * 100).toFixed(0) + "%" : "N/A"}
- MVRV Z-Score: ${data.onchain?.btc?.mvrvZScore?.toFixed(2) || "N/A"}
- Whale Flow: ${data.signals?.whaleFlow?.bullishness ? (data.signals.whaleFlow.bullishness > 0.5 ? "Accumulation" : "Distribution") : "N/A"}
- Capital Flow: ${data.capitalFlow?.netFlowSignal?.direction || "N/A"}
- Active Divergences: ${data.signals?.divergences?.length || 0}

Current Positions: ${currentPositions.length > 0 
  ? currentPositions.map(p => `${p.side} ${p.symbol} (${p.unrealizedPnlPercent.toFixed(1)}%)`).join(", ")
  : "None"}

Based on the data, provide a brief 2-3 sentence trading outlook. Focus on actionable insights.`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const response = result.response;
    return response.text() || "Unable to generate advice.";
  } catch (error) {
    console.error("AI Advice error:", error);
    return "Market analysis temporarily unavailable.";
  }
}
