import { db } from "../db";
import { mike1Snapshots, momentumHistory, allocationHistory } from "@shared/schema";
import { eq, and, desc, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { StrategyMode } from "./quantStrategy";

const STRATEGIES = ['meanReversion', 'volExpansion', 'pairsTrading', 'momentum'] as const;

interface ModePerformanceData {
  trades: number;
  wins: number;
  totalPnl: number;
  sharpeUlcer: number;
  returns: number[];
  peakEquity: number;
  drawdowns: number[];
}

interface Mike1FullSnapshot {
  snapshotType: 'backtest' | 'live';
  strategy: string;
  sharpeRatio: number;
  ulcerIndex: number;
  mike1Score: number;
  trades: number;
  wins: number;
  totalPnl: number;
  status: string;
  allocation: number;
  returns: number[];
  drawdowns: number[];
  peakEquity: number;
}

export async function saveMike1Snapshot(snapshots: Mike1FullSnapshot[]): Promise<void> {
  try {
    for (const snap of snapshots) {
      await db.delete(mike1Snapshots)
        .where(and(
          eq(mike1Snapshots.snapshotType, snap.snapshotType),
          eq(mike1Snapshots.strategy, snap.strategy)
        ));
    }
    
    if (snapshots.length > 0) {
      await db.insert(mike1Snapshots).values(snapshots);
    }
    
    console.log(`[Mike1 DB] Saved ${snapshots.length} snapshots`);
  } catch (error) {
    console.error('[Mike1 DB] Failed to save snapshots:', error);
  }
}

export async function saveBacktestScores(
  scores: Record<string, number>,
  detailedMetrics?: Record<string, { sharpe: number; ulcer: number; mike1: number; trades: number; wins: number }>
): Promise<void> {
  const snapshots: Mike1FullSnapshot[] = Object.entries(scores).map(([strategy, mike1Score]) => {
    const detail = detailedMetrics?.[strategy];
    return {
      snapshotType: 'backtest' as const,
      strategy,
      sharpeRatio: detail?.sharpe || 0,
      ulcerIndex: detail?.ulcer || 0,
      mike1Score,
      trades: detail?.trades || 0,
      wins: detail?.wins || 0,
      totalPnl: 0,
      status: 'backtest',
      allocation: 0,
      returns: [],
      drawdowns: [],
      peakEquity: 100,
    };
  });
  
  await saveMike1Snapshot(snapshots);
}

export async function saveLivePerformance(
  modePerf: Record<string, ModePerformanceData>,
  allocation?: { primary: string; primaryWeight: number; secondary: string | null; secondaryWeight: number; cashFloor: boolean }
): Promise<void> {
  const snapshots: Mike1FullSnapshot[] = [];
  
  for (const [strategy, perf] of Object.entries(modePerf)) {
    if (strategy === 'adaptive') continue;
    
    const avgReturn = perf.returns.length > 0 ? perf.returns.reduce((a, b) => a + b, 0) / perf.returns.length : 0;
    const variance = perf.returns.length > 1 ? perf.returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / perf.returns.length : 0;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0.001 ? avgReturn / stdDev : 0;
    const sumSqDD = perf.drawdowns.length > 0 ? perf.drawdowns.reduce((sum, d) => sum + d * d, 0) : 0;
    const ulcer = perf.drawdowns.length > 0 ? Math.sqrt(sumSqDD / perf.drawdowns.length) : 0;
    
    let status = 'inactive';
    let alloc = 0;
    if (allocation) {
      if (allocation.cashFloor) {
        status = 'cash_floor';
      } else if (allocation.primary === strategy) {
        status = 'active';
        alloc = allocation.primaryWeight;
      } else if (allocation.secondary === strategy) {
        status = 'runner_up';
        alloc = allocation.secondaryWeight;
      } else {
        status = 'blocked';
      }
    }
    
    snapshots.push({
      snapshotType: 'live',
      strategy,
      sharpeRatio: sharpe,
      ulcerIndex: ulcer,
      mike1Score: perf.sharpeUlcer,
      trades: perf.trades,
      wins: perf.wins,
      totalPnl: perf.totalPnl,
      status,
      allocation: alloc,
      returns: perf.returns,
      drawdowns: perf.drawdowns,
      peakEquity: perf.peakEquity,
    });
  }
  
  await saveMike1Snapshot(snapshots);
}

export interface BacktestSnapshot {
  mike1Score: number;
  sharpeRatio: number;
  ulcerIndex: number;
  trades: number;
  wins: number;
}

export async function loadBacktestScores(): Promise<Record<string, BacktestSnapshot> | null> {
  try {
    const rows = await db.select().from(mike1Snapshots)
      .where(eq(mike1Snapshots.snapshotType, 'backtest'));
    
    if (rows.length === 0) return null;
    
    const scores: Record<string, BacktestSnapshot> = {};
    for (const row of rows) {
      scores[row.strategy] = {
        mike1Score: row.mike1Score,
        sharpeRatio: row.sharpeRatio,
        ulcerIndex: row.ulcerIndex,
        trades: row.trades,
        wins: row.wins,
      };
    }
    
    console.log(`[Mike1 DB] Loaded backtest scores:`, Object.entries(scores).map(([k, v]) => `${k}=${v.mike1Score.toFixed(3)}`).join(', '));
    return scores;
  } catch (error) {
    console.error('[Mike1 DB] Failed to load backtest scores:', error);
    return null;
  }
}

export async function loadLivePerformance(): Promise<Record<string, ModePerformanceData> | null> {
  try {
    const rows = await db.select().from(mike1Snapshots)
      .where(eq(mike1Snapshots.snapshotType, 'live'));
    
    if (rows.length === 0) return null;
    
    const perf: Record<string, ModePerformanceData> = {};
    for (const row of rows) {
      perf[row.strategy] = {
        trades: row.trades,
        wins: row.wins,
        totalPnl: row.totalPnl,
        sharpeUlcer: row.mike1Score,
        returns: (row.returns as number[]) || [],
        peakEquity: row.peakEquity,
        drawdowns: (row.drawdowns as number[]) || [],
      };
    }
    
    console.log(`[Mike1 DB] Loaded live performance:`, Object.entries(perf).map(([k, v]) => `${k}: ${v.trades} trades, Mike1=${v.sharpeUlcer.toFixed(3)}`).join(', '));
    return perf;
  } catch (error) {
    console.error('[Mike1 DB] Failed to load live performance:', error);
    return null;
  }
}

export async function saveEmaState(emaState: Record<string, { emaScore: number; currentScore: number }>): Promise<void> {
  try {
    await db.delete(mike1Snapshots).where(eq(mike1Snapshots.snapshotType, 'ema_state'));
    
    const rows = Object.entries(emaState).map(([strategy, data]) => ({
      snapshotType: 'ema_state' as const,
      strategy,
      sharpeRatio: data.emaScore,
      ulcerIndex: 0,
      mike1Score: data.currentScore,
      trades: 0,
      wins: 0,
      totalPnl: 0,
      status: 'ema',
      allocation: 0,
      returns: [] as number[],
      drawdowns: [] as number[],
      peakEquity: 0,
    }));
    
    if (rows.length > 0) {
      await db.insert(mike1Snapshots).values(rows);
    }
    
    console.log(`[Mike1 DB] Saved EMA state for ${rows.length} modes`);
  } catch (error) {
    console.error('[Mike1 DB] Failed to save EMA state:', error);
  }
}

export async function loadEmaState(): Promise<Record<string, { emaScore: number; currentScore: number }> | null> {
  try {
    const rows = await db.select().from(mike1Snapshots)
      .where(eq(mike1Snapshots.snapshotType, 'ema_state'));
    
    if (rows.length === 0) return null;
    
    const state: Record<string, { emaScore: number; currentScore: number }> = {};
    for (const row of rows) {
      state[row.strategy] = {
        emaScore: row.sharpeRatio,
        currentScore: row.mike1Score,
      };
    }
    
    console.log(`[Mike1 DB] Loaded EMA state for ${rows.length} modes`);
    return state;
  } catch (error) {
    console.error('[Mike1 DB] Failed to load EMA state:', error);
    return null;
  }
}

export async function loadAllSnapshots(): Promise<{ backtest: any[]; live: any[] }> {
  try {
    const rows = await db.select().from(mike1Snapshots)
      .orderBy(desc(mike1Snapshots.createdAt));
    
    return {
      backtest: rows.filter(r => r.snapshotType === 'backtest'),
      live: rows.filter(r => r.snapshotType === 'live'),
    };
  } catch (error) {
    console.error('[Mike1 DB] Failed to load all snapshots:', error);
    return { backtest: [], live: [] };
  }
}

export interface MomentumSnapshot {
  strategy: string;
  mike1Score: number;
  emaScore: number;
  gap: number;
  momentumStatus: string;
  sizeMultiplier: number;
}

export async function saveMomentumHistory(snapshots: MomentumSnapshot[]): Promise<void> {
  try {
    if (snapshots.length === 0) return;
    
    await db.insert(momentumHistory).values(snapshots);
    
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.delete(momentumHistory).where(lt(momentumHistory.createdAt, cutoff));
  } catch (error) {
    console.error('[Mike1 DB] Failed to save momentum history:', error);
  }
}

export async function loadMomentumHistory(limit: number = 500): Promise<any[]> {
  try {
    const rows = await db.select().from(momentumHistory)
      .orderBy(desc(momentumHistory.createdAt))
      .limit(limit);
    return rows;
  } catch (error) {
    console.error('[Mike1 DB] Failed to load momentum history:', error);
    return [];
  }
}

export interface AllocationSnapshot {
  primaryStrategy: string;
  primaryWeight: number;
  secondaryStrategy: string | null;
  secondaryWeight: number;
  cashFloor: number;
  meanReversionMike1: number;
  volExpansionMike1: number;
  pairsTradingMike1: number;
  meanReversionMomentum: string;
  volExpansionMomentum: string;
  pairsTradingMomentum: string;
  meanReversionSizeMult: number;
  volExpansionSizeMult: number;
  pairsTradingSizeMult: number;
  regime: string;
}

export async function saveAllocationHistory(snapshot: AllocationSnapshot): Promise<void> {
  try {
    await db.insert(allocationHistory).values(snapshot);
    
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.delete(allocationHistory).where(lt(allocationHistory.createdAt, cutoff));
  } catch (error) {
    console.error('[Mike1 DB] Failed to save allocation history:', error);
  }
}

export async function loadAllocationHistory(limit: number = 500): Promise<any[]> {
  try {
    const rows = await db.select().from(allocationHistory)
      .orderBy(desc(allocationHistory.createdAt))
      .limit(limit);
    return rows;
  } catch (error) {
    console.error('[Mike1 DB] Failed to load allocation history:', error);
    return [];
  }
}

export async function saveEquityCurveEmaState(state: { emaValue: number; consecutiveNegativeSnapshots: number; metricHistory: number[] }): Promise<void> {
  try {
    await db.delete(mike1Snapshots).where(eq(mike1Snapshots.snapshotType, 'ec_state'));
    
    await db.insert(mike1Snapshots).values({
      snapshotType: 'ec_state',
      strategy: 'portfolio',
      sharpeRatio: state.emaValue,
      ulcerIndex: state.consecutiveNegativeSnapshots,
      mike1Score: 0,
      trades: state.metricHistory.length,
      wins: 0,
      totalPnl: 0,
      status: 'ec_state',
      allocation: 0,
      returns: state.metricHistory,
      drawdowns: [],
      peakEquity: 0,
    });
    
    console.log(`[Mike1 DB] Saved Equity Curve state: EMA=${state.emaValue.toFixed(3)}, neg_snapshots=${state.consecutiveNegativeSnapshots}, history=${state.metricHistory.length}`);
  } catch (error) {
    console.error('[Mike1 DB] Failed to save Equity Curve state:', error);
  }
}

export async function loadEquityCurveEmaState(): Promise<{ emaValue: number; consecutiveNegativeSnapshots: number; metricHistory: number[] } | null> {
  try {
    const rows = await db.select().from(mike1Snapshots)
      .where(eq(mike1Snapshots.snapshotType, 'ec_state'));
    
    if (rows.length === 0) return null;
    
    const row = rows[0];
    const state = {
      emaValue: row.sharpeRatio,
      consecutiveNegativeSnapshots: row.ulcerIndex,
      metricHistory: (row.returns as number[]) || [],
    };
    
    console.log(`[Mike1 DB] Loaded Equity Curve state: EMA=${state.emaValue.toFixed(3)}, neg_snapshots=${state.consecutiveNegativeSnapshots}, history=${state.metricHistory.length}`);
    return state;
  } catch (error) {
    console.error('[Mike1 DB] Failed to load Equity Curve state:', error);
    return null;
  }
}
