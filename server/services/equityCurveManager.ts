import { db } from "../db";
import { portfolioMetricSnapshots } from "@shared/schema";
import { desc } from "drizzle-orm";
import { getOverallRiskMetrics } from "./correlationStrategy";
import { getShadowDerivedAllocation, type ShadowDerivedAllocation } from "./shadowTrading";

export type PortfolioRegime = 'AGGRESSIVE' | 'NEUTRAL' | 'DEFENSIVE' | 'HIBERNATE';
export type LossDirection = 'SHORT_LOSSES' | 'LONG_LOSSES' | 'MIXED' | 'INSUFFICIENT_DATA';
export type ReversalLevel = 'NONE' | 'INVERT_NEW' | 'CLOSE_WORST' | 'FULL_REVERSAL';

const DAILY_PROFIT_TARGET_PCT = 0.005;

export interface DailyProfitTarget {
  targetPct: number;
  targetAmount: number;
  currentDailyPnl: number;
  currentDailyPct: number;
  progressPct: number;
  sizeMultiplier: number;
  dayStartEquity: number;
  dayStartTime: number;
  hoursElapsed: number;
  hoursRemaining: number;
  onTrack: boolean;
}

let dailyTargetState: DailyProfitTarget = {
  targetPct: DAILY_PROFIT_TARGET_PCT,
  targetAmount: 0,
  currentDailyPnl: 0,
  currentDailyPct: 0,
  progressPct: 0,
  sizeMultiplier: 1.0,
  dayStartEquity: 0,
  dayStartTime: 0,
  hoursElapsed: 0,
  hoursRemaining: 24,
  onTrack: false,
};

export interface ReversalState {
  level: ReversalLevel;
  negativeStartTime: number | null;
  negativeDurationMinutes: number;
  active: boolean;
  positionsClosed: number;
  lastEscalation: number;
  lastClose: number;
}

export interface EquityCurveState {
  rawMetric: number;
  normalizedMetric: number;
  zScore: number;
  emaValue: number;
  momentum: number;
  regime: PortfolioRegime;
  sizeMultiplier: number;
  lossDirection: LossDirection;
  lossDirectionRatio: number;
  recoveryModeActive: boolean;
  invertSignals: boolean;
  consecutiveNegativeSnapshots: number;
  totalClosedTrades: number;
  shortLosses: number;
  longLosses: number;
  lastUpdated: number;
}

const EMA_ALPHA = 0.2;
const MIN_TRADES_FOR_ACTIVATION = 20;
const MIN_SNAPSHOTS_FOR_ZSCORE = 10;
const CONSECUTIVE_NEGATIVE_FOR_RECOVERY = 3;
const LOSS_DIRECTION_DOMINANCE_THRESHOLD = 0.70;
const ROLLING_WINDOW_SIZE = 50;
const LOSS_DIRECTION_TRADE_WINDOW = 30;

const REGIME_BOUNDARY_HIGH = 0.5;
const REGIME_BOUNDARY_LOW = 0.2;
const HYSTERESIS_BAND = 0.05;

const REVERSAL_LEVEL_1_MINUTES = 20;
const REVERSAL_LEVEL_2_MINUTES = 40;
const REVERSAL_LEVEL_3_MINUTES = 60;
const REVERSAL_CLOSE_WORST_PNL_THRESHOLD = -0.3;
const REVERSAL_COOLDOWN_MS = 5 * 60 * 1000;

let reversalState: ReversalState = {
  level: 'NONE',
  negativeStartTime: null,
  negativeDurationMinutes: 0,
  active: false,
  positionsClosed: 0,
  lastEscalation: 0,
  lastClose: 0,
};

let state: EquityCurveState = {
  rawMetric: 0,
  normalizedMetric: 0,
  zScore: 0,
  emaValue: 0,
  momentum: 0,
  regime: 'NEUTRAL',
  sizeMultiplier: 0.75,
  lossDirection: 'INSUFFICIENT_DATA',
  lossDirectionRatio: 0,
  recoveryModeActive: false,
  invertSignals: false,
  consecutiveNegativeSnapshots: 0,
  totalClosedTrades: 0,
  shortLosses: 0,
  longLosses: 0,
  lastUpdated: 0,
};

const metricHistory: number[] = [];

function computeZScore(current: number): number {
  if (metricHistory.length < MIN_SNAPSHOTS_FOR_ZSCORE) return 0;

  const sum = metricHistory.reduce((a, b) => a + b, 0);
  const mean = sum / metricHistory.length;
  const variance = metricHistory.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / metricHistory.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev < 0.0001) return 0;
  return (current - mean) / stdDev;
}

function deriveRegime(normalizedMetric: number, momentum: number, previousRegime: PortfolioRegime): { regime: PortfolioRegime; sizeMultiplier: number } {
  const score = (normalizedMetric + momentum) / 2;

  let regime: PortfolioRegime;

  if (previousRegime === 'AGGRESSIVE') {
    regime = score >= (REGIME_BOUNDARY_HIGH - HYSTERESIS_BAND) ? 'AGGRESSIVE'
           : score >= (REGIME_BOUNDARY_LOW - HYSTERESIS_BAND) ? 'NEUTRAL'
           : score >= -HYSTERESIS_BAND ? 'DEFENSIVE'
           : 'HIBERNATE';
  } else if (previousRegime === 'NEUTRAL') {
    regime = score >= (REGIME_BOUNDARY_HIGH + HYSTERESIS_BAND) ? 'AGGRESSIVE'
           : score >= (REGIME_BOUNDARY_LOW - HYSTERESIS_BAND) ? 'NEUTRAL'
           : score >= -HYSTERESIS_BAND ? 'DEFENSIVE'
           : 'HIBERNATE';
  } else if (previousRegime === 'DEFENSIVE') {
    regime = score >= (REGIME_BOUNDARY_HIGH + HYSTERESIS_BAND) ? 'AGGRESSIVE'
           : score >= (REGIME_BOUNDARY_LOW + HYSTERESIS_BAND) ? 'NEUTRAL'
           : score >= -HYSTERESIS_BAND ? 'DEFENSIVE'
           : 'HIBERNATE';
  } else {
    regime = score >= (REGIME_BOUNDARY_HIGH + HYSTERESIS_BAND) ? 'AGGRESSIVE'
           : score >= (REGIME_BOUNDARY_LOW + HYSTERESIS_BAND) ? 'NEUTRAL'
           : score >= HYSTERESIS_BAND ? 'DEFENSIVE'
           : 'HIBERNATE';
  }

  const sizeMultiplier = regime === 'AGGRESSIVE' ? 1.0
                       : regime === 'NEUTRAL' ? 0.75
                       : regime === 'DEFENSIVE' ? 0.5
                       : 0;

  return { regime, sizeMultiplier };
}

export function updateEquityCurve(rawMetric: number, closedTrades: Array<{ side: string; pnl: number | null; status: string }>): EquityCurveState {
  const now = Date.now();

  metricHistory.push(rawMetric);
  if (metricHistory.length > ROLLING_WINDOW_SIZE) {
    metricHistory.shift();
  }

  const zScore = computeZScore(rawMetric);
  const normalizedMetric = Math.tanh(zScore);

  const previousEma = state.emaValue;
  const emaValue = previousEma === 0 && metricHistory.length <= 1
    ? normalizedMetric
    : (normalizedMetric * EMA_ALPHA) + (previousEma * (1 - EMA_ALPHA));

  const momentum = normalizedMetric - emaValue;

  const finishedTrades = closedTrades.filter(t =>
    (t.status === 'stopped_out' || t.status === 'closed') && t.pnl !== null
  );
  const totalClosedTrades = finishedTrades.length;

  const recentTrades = finishedTrades.slice(-LOSS_DIRECTION_TRADE_WINDOW);
  const recentLosers = recentTrades.filter(t => t.pnl !== null && t.pnl < 0);

  const shortLosses = recentLosers.filter(t => t.side === 'short').length;
  const longLosses = recentLosers.filter(t => t.side === 'long').length;
  const totalLosses = shortLosses + longLosses;

  let lossDirection: LossDirection = 'INSUFFICIENT_DATA';
  let lossDirectionRatio = 0;

  if (recentTrades.length >= 10 && totalLosses >= 5) {
    const shortRatio = shortLosses / totalLosses;
    const longRatio = longLosses / totalLosses;

    if (shortRatio >= LOSS_DIRECTION_DOMINANCE_THRESHOLD) {
      lossDirection = 'SHORT_LOSSES';
      lossDirectionRatio = shortRatio;
    } else if (longRatio >= LOSS_DIRECTION_DOMINANCE_THRESHOLD) {
      lossDirection = 'LONG_LOSSES';
      lossDirectionRatio = longRatio;
    } else {
      lossDirection = 'MIXED';
      lossDirectionRatio = Math.max(shortRatio, longRatio);
    }
  }

  let consecutiveNegativeSnapshots = state.consecutiveNegativeSnapshots;
  if (normalizedMetric < 0) {
    consecutiveNegativeSnapshots++;
  } else {
    consecutiveNegativeSnapshots = 0;
  }

  let { regime, sizeMultiplier } = deriveRegime(normalizedMetric, momentum, state.regime);

  const meetsTradeCount = totalClosedTrades >= MIN_TRADES_FOR_ACTIVATION;

  if (!meetsTradeCount) {
    if (rawMetric < 0) {
      regime = 'HIBERNATE';
      sizeMultiplier = 0;
    } else {
      regime = 'NEUTRAL';
      sizeMultiplier = 0.75;
    }
  }

  let recoveryModeActive = false;
  let invertSignals = false;

  if (
    meetsTradeCount &&
    consecutiveNegativeSnapshots >= CONSECUTIVE_NEGATIVE_FOR_RECOVERY &&
    (lossDirection === 'SHORT_LOSSES' || lossDirection === 'LONG_LOSSES')
  ) {
    recoveryModeActive = true;
    invertSignals = true;

    regime = 'HIBERNATE';
    sizeMultiplier = 0;

    console.log(`[EQUITY CURVE] RECOVERY MODE ACTIVATED:`);
    console.log(`  Consecutive negative snapshots: ${consecutiveNegativeSnapshots}`);
    console.log(`  Loss direction: ${lossDirection} (${(lossDirectionRatio * 100).toFixed(0)}% dominance)`);
    console.log(`  Signal inversion: ${lossDirection === 'SHORT_LOSSES' ? 'SELL->BUY' : 'BUY->SELL'}`);
    console.log(`  Regime forced to HIBERNATE, sizing at minimum broker volume`);
  }

  if (state.recoveryModeActive && !recoveryModeActive && normalizedMetric > 0) {
    console.log(`[EQUITY CURVE] Recovery mode DEACTIVATED - metric returned positive`);
  }

  state = {
    rawMetric,
    normalizedMetric,
    zScore,
    emaValue,
    momentum,
    regime,
    sizeMultiplier,
    lossDirection,
    lossDirectionRatio,
    recoveryModeActive,
    invertSignals,
    consecutiveNegativeSnapshots,
    totalClosedTrades,
    shortLosses,
    longLosses,
    lastUpdated: now,
  };

  console.log(`[EQUITY CURVE] Raw=${rawMetric.toFixed(4)} | Norm=${normalizedMetric.toFixed(3)} | Z=${zScore.toFixed(2)} | EMA=${emaValue.toFixed(3)} | Mom=${momentum.toFixed(3)} | Regime=${regime} | Size=${sizeMultiplier}x | Recovery=${recoveryModeActive}`);

  return { ...state };
}

export function getEquityCurveState(): EquityCurveState {
  return { ...state };
}

export function resetEquityCurveManager(): void {
  state = {
    rawMetric: 0,
    normalizedMetric: 0,
    zScore: 0,
    emaValue: 0,
    momentum: 0,
    regime: 'NEUTRAL',
    sizeMultiplier: 0.75,
    lossDirection: 'INSUFFICIENT_DATA',
    lossDirectionRatio: 0,
    recoveryModeActive: false,
    invertSignals: false,
    consecutiveNegativeSnapshots: 0,
    totalClosedTrades: 0,
    shortLosses: 0,
    longLosses: 0,
    lastUpdated: 0,
  };
  reversalState = {
    level: 'NONE',
    negativeStartTime: null,
    negativeDurationMinutes: 0,
    active: false,
    positionsClosed: 0,
    lastEscalation: 0,
    lastClose: 0,
  };
  metricHistory.length = 0;
  console.log('[EQUITY CURVE] Manager reset to initial state');
}

export function shouldInvertSignal(): boolean {
  return state.invertSignals;
}

export function getEquitySizeMultiplier(): number {
  return state.sizeMultiplier;
}

export function getPortfolioRegime(): PortfolioRegime {
  return state.regime;
}

export function invertTradeDirection(originalSide: 'long' | 'short'): 'long' | 'short' {
  if (!state.invertSignals) return originalSide;

  if (state.lossDirection === 'SHORT_LOSSES') {
    return originalSide === 'short' ? 'long' : originalSide;
  }
  if (state.lossDirection === 'LONG_LOSSES') {
    return originalSide === 'long' ? 'short' : originalSide;
  }

  return originalSide;
}

export interface SerializedEquityCurveState {
  emaValue: number;
  consecutiveNegativeSnapshots: number;
  metricHistory: number[];
  regime?: PortfolioRegime;
}

export function getStateForPersistence(): SerializedEquityCurveState {
  return {
    emaValue: state.emaValue,
    consecutiveNegativeSnapshots: state.consecutiveNegativeSnapshots,
    metricHistory: [...metricHistory],
    regime: state.regime,
  };
}

export function restoreState(saved: SerializedEquityCurveState): void {
  state.emaValue = saved.emaValue;
  state.consecutiveNegativeSnapshots = saved.consecutiveNegativeSnapshots;
  if (saved.regime) {
    state.regime = saved.regime;
  }

  metricHistory.length = 0;
  for (const val of saved.metricHistory) {
    metricHistory.push(val);
  }

  console.log(`[EQUITY CURVE] Restored state: EMA=${saved.emaValue.toFixed(3)}, regime=${state.regime}, consecutive_neg=${saved.consecutiveNegativeSnapshots}, history_len=${saved.metricHistory.length}`);
}

// ============================================================================
// GRADUATED REVERSAL SYSTEM
// Tracks how long the portfolio metric stays negative and escalates response:
// Level 1 (20min): Invert new trade signals only
// Level 2 (40min): Close worst underwater positions
// Level 3 (60min): Full signal inversion + close worst positions
// Resets when metric returns positive
// ============================================================================

export function updateReversalState(rawMetric: number): ReversalState {
  const now = Date.now();

  if (rawMetric >= 0) {
    if (reversalState.active) {
      console.log(`[REVERSAL] DEACTIVATED - metric returned positive (${rawMetric.toFixed(2)}), was negative for ${reversalState.negativeDurationMinutes.toFixed(0)}min`);
    }
    reversalState = {
      level: 'NONE',
      negativeStartTime: null,
      negativeDurationMinutes: 0,
      active: false,
      positionsClosed: 0,
      lastEscalation: 0,
      lastClose: 0,
    };
    return { ...reversalState };
  }

  if (reversalState.negativeStartTime === null) {
    reversalState.negativeStartTime = now;
    console.log(`[REVERSAL] Metric went negative (${rawMetric.toFixed(2)}), starting duration timer`);
  }

  const durationMs = now - reversalState.negativeStartTime;
  reversalState.negativeDurationMinutes = durationMs / (1000 * 60);

  const previousLevel = reversalState.level;

  if (reversalState.negativeDurationMinutes >= REVERSAL_LEVEL_3_MINUTES) {
    reversalState.level = 'FULL_REVERSAL';
  } else if (reversalState.negativeDurationMinutes >= REVERSAL_LEVEL_2_MINUTES) {
    reversalState.level = 'CLOSE_WORST';
  } else if (reversalState.negativeDurationMinutes >= REVERSAL_LEVEL_1_MINUTES) {
    reversalState.level = 'INVERT_NEW';
  } else {
    reversalState.level = 'NONE';
  }

  reversalState.active = reversalState.level !== 'NONE';

  if (reversalState.level !== previousLevel && reversalState.level !== 'NONE') {
    reversalState.lastEscalation = now;
    console.log(`[REVERSAL] ESCALATED to ${reversalState.level} (negative for ${reversalState.negativeDurationMinutes.toFixed(0)}min, metric: ${rawMetric.toFixed(2)})`);
  }

  return { ...reversalState };
}

export function getReversalState(): ReversalState {
  return { ...reversalState };
}

export function shouldInvertNewSignals(): boolean {
  return reversalState.active && (reversalState.level === 'INVERT_NEW' || reversalState.level === 'CLOSE_WORST' || reversalState.level === 'FULL_REVERSAL');
}

export function shouldCloseWorstPositions(): boolean {
  const now = Date.now();
  if (!reversalState.active) return false;
  if (reversalState.level !== 'CLOSE_WORST' && reversalState.level !== 'FULL_REVERSAL') return false;
  // Use lastClose for cooldown — allows immediate close on first escalation to Level 2/3
  if (reversalState.lastClose > 0 && now - reversalState.lastClose < REVERSAL_COOLDOWN_MS) return false;
  return true;
}

export function getReversalCloseThreshold(): number {
  return REVERSAL_CLOSE_WORST_PNL_THRESHOLD;
}

export function recordReversalClose(): void {
  reversalState.positionsClosed++;
  reversalState.lastClose = Date.now();
}

export interface ShadowAllocationOverride {
  active: boolean;
  primary: string;
  primaryWeight: number;
  secondary: string | null;
  secondaryWeight: number;
  activatedAt: number;
  shadowPnls: Record<string, number>;
  lookbackMinutes: number;
  portfolioMetricAtActivation: number;
}

let shadowOverride: ShadowAllocationOverride = {
  active: false,
  primary: '',
  primaryWeight: 0,
  secondary: null,
  secondaryWeight: 0,
  activatedAt: 0,
  shadowPnls: {},
  lookbackMinutes: 0,
  portfolioMetricAtActivation: 0,
};

export function evaluateShadowOverride(rawMetric: number): void {
  if (!shadowOverride.active && rawMetric < 0) {
    const shadowAlloc = getShadowDerivedAllocation();
    if (shadowAlloc && shadowAlloc.confident) {
      shadowOverride = {
        active: true,
        primary: shadowAlloc.primary,
        primaryWeight: shadowAlloc.primaryWeight,
        secondary: shadowAlloc.secondary,
        secondaryWeight: shadowAlloc.secondaryWeight,
        activatedAt: Date.now(),
        shadowPnls: shadowAlloc.shadowPnls,
        lookbackMinutes: shadowAlloc.lookbackMinutes,
        portfolioMetricAtActivation: rawMetric,
      };
      console.log(`[SHADOW OVERRIDE] ACTIVATED: portfolio metric=${rawMetric.toFixed(3)} negative`);
      console.log(`[SHADOW OVERRIDE] Switching to shadow-derived allocation: ${shadowOverride.primary}(${(shadowOverride.primaryWeight * 100).toFixed(0)}%)${shadowOverride.secondary ? ` + ${shadowOverride.secondary}(${(shadowOverride.secondaryWeight * 100).toFixed(0)}%)` : ''}`);
      console.log(`[SHADOW OVERRIDE] Shadow PnLs: ${Object.entries(shadowAlloc.shadowPnls).map(([k, v]) => `${k}=$${v.toFixed(2)}`).join(', ')} over ${shadowAlloc.lookbackMinutes.toFixed(0)}min`);
    }
  } else if (shadowOverride.active) {
    const overrideDurationMs = Date.now() - shadowOverride.activatedAt;
    const MAX_OVERRIDE_DURATION_MS = 6 * 60 * 60 * 1000;
    
    const shouldDeactivate = 
      (rawMetric > 0 && rawMetric > shadowOverride.portfolioMetricAtActivation) ||
      (rawMetric > 0 && overrideDurationMs > MAX_OVERRIDE_DURATION_MS);
    
    if (shouldDeactivate) {
      const reason = rawMetric > shadowOverride.portfolioMetricAtActivation
        ? `metric=${rawMetric.toFixed(3)} better than activation=${shadowOverride.portfolioMetricAtActivation.toFixed(3)}`
        : `positive for too long (${(overrideDurationMs / 3600000).toFixed(1)}h), time-based release`;
      console.log(`[SHADOW OVERRIDE] DEACTIVATED: ${reason}`);
      shadowOverride = {
        active: false,
        primary: '',
        primaryWeight: 0,
        secondary: null,
        secondaryWeight: 0,
        activatedAt: 0,
        shadowPnls: {},
        lookbackMinutes: 0,
        portfolioMetricAtActivation: 0,
      };
    } else {
      const shadowAlloc = getShadowDerivedAllocation();
      if (shadowAlloc && shadowAlloc.confident) {
        shadowOverride.primary = shadowAlloc.primary;
        shadowOverride.primaryWeight = shadowAlloc.primaryWeight;
        shadowOverride.secondary = shadowAlloc.secondary;
        shadowOverride.secondaryWeight = shadowAlloc.secondaryWeight;
        shadowOverride.shadowPnls = shadowAlloc.shadowPnls;
        shadowOverride.lookbackMinutes = shadowAlloc.lookbackMinutes;
      }
    }
  }
}

export function getShadowOverride(): ShadowAllocationOverride {
  return { ...shadowOverride };
}

export function isShadowOverrideActive(): boolean {
  return shadowOverride.active;
}

export function updateDailyProfitTarget(currentEquity: number): DailyProfitTarget {
  const now = Date.now();

  if (dailyTargetState.dayStartTime === 0 || now - dailyTargetState.dayStartTime >= 24 * 60 * 60 * 1000) {
    dailyTargetState.dayStartEquity = currentEquity;
    dailyTargetState.dayStartTime = now;
    console.log(`[DAILY TARGET] New day started. Start equity: $${currentEquity.toFixed(2)}, target: +${(DAILY_PROFIT_TARGET_PCT * 100).toFixed(1)}% ($${(currentEquity * DAILY_PROFIT_TARGET_PCT).toFixed(2)})`);
  }

  const startEquity = dailyTargetState.dayStartEquity;
  const targetAmount = startEquity * DAILY_PROFIT_TARGET_PCT;
  const currentDailyPnl = currentEquity - startEquity;
  const currentDailyPct = startEquity > 0 ? currentDailyPnl / startEquity : 0;
  const progressPct = targetAmount > 0 ? (currentDailyPnl / targetAmount) * 100 : 0;

  const hoursElapsed = (now - dailyTargetState.dayStartTime) / (1000 * 60 * 60);
  const hoursRemaining = Math.max(0, 24 - hoursElapsed);

  const expectedProgressPct = (hoursElapsed / 24) * 100;
  const onTrack = progressPct >= expectedProgressPct * 0.5;

  let sizeMultiplier = 1.0;

  if (progressPct >= 150) {
    sizeMultiplier = 0.5;
  } else if (progressPct >= 100) {
    sizeMultiplier = 0.75;
  } else if (progressPct >= 50) {
    sizeMultiplier = 1.0;
  } else if (progressPct >= 0) {
    sizeMultiplier = 1.25;
  } else {
    sizeMultiplier = 1.5;
  }

  if (hoursRemaining < 6 && progressPct < 50) {
    sizeMultiplier = Math.min(sizeMultiplier * 1.2, 2.0);
  }

  dailyTargetState = {
    targetPct: DAILY_PROFIT_TARGET_PCT,
    targetAmount,
    currentDailyPnl,
    currentDailyPct,
    progressPct,
    sizeMultiplier,
    dayStartEquity: startEquity,
    dayStartTime: dailyTargetState.dayStartTime,
    hoursElapsed,
    hoursRemaining,
    onTrack,
  };

  return { ...dailyTargetState };
}

export function getDailyProfitTarget(): DailyProfitTarget {
  return { ...dailyTargetState };
}

export function getDailyTargetSizeMultiplier(): number {
  return dailyTargetState.sizeMultiplier;
}

export async function loadHistoryFromSnapshots(): Promise<void> {
  try {
    const snapshots = await db
      .select()
      .from(portfolioMetricSnapshots)
      .orderBy(desc(portfolioMetricSnapshots.createdAt))
      .limit(ROLLING_WINDOW_SIZE);

    if (snapshots.length === 0) return;

    metricHistory.length = 0;
    const ordered = snapshots.reverse();
    for (const snap of ordered) {
      metricHistory.push(snap.portfolioMetric);
    }

    console.log(`[EQUITY CURVE] Loaded ${metricHistory.length} historical metric values from DB`);
  } catch (error) {
    console.error('[EQUITY CURVE] Failed to load history from snapshots:', error);
  }
}
