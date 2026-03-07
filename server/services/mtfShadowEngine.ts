import { db } from "../db";
import {
  mtfShadowTrades, mtfMike1Snapshots, mtfComboEquity, mtfAllocationDecisions,
  type InsertMtfShadowTrade, type InsertMtfMike1Snapshot,
  type InsertMtfComboEquity, type InsertMtfAllocationDecision,
} from "@shared/schema";
import { eq as drizzleEq, and, desc } from "drizzle-orm";
import { getCachedCandles, type TimeframeKey } from "./binanceCandles";
import {
  generateAllMtfSignals, backtestOnCandles, makeComboKey,
  type MtfSignal, type StrategyMode,
} from "./mtfSignals";

const STRATEGIES: StrategyMode[] = ['meanReversion', 'volExpansion', 'momentum', 'pairsTrading'];
const TIMEFRAMES: TimeframeKey[] = ['5m', '15m', '1h'];
const SHADOW_EQUITY = 500;
const FEE_RATE = 0.0004;
const SLIPPAGE = 0.0005;
const MAX_POSITIONS_PER_COMBO = 3;
const MIN_TENURE_MS = 60 * 60 * 1000;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

interface ShadowPosition {
  id: number;
  comboKey: string;
  symbol: string;
  coinId: string;
  side: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  atr: number;
  openedAt: number;
}

interface ComboEquityState {
  equity: number;
  peakEquity: number;
  trades: number;
  wins: number;
  totalPnl: number;
  returns: number[];
  drawdowns: number[];
  mike1Score: number;
}

interface AllocationState {
  primaryCombo: string;
  secondaryCombo: string | null;
  primaryWeight: number;
  secondaryWeight: number;
  tenureStart: number;
  lastDecisionTime: number;
}

const comboPositions: Map<string, ShadowPosition[]> = new Map();
const comboEquity: Map<string, ComboEquityState> = new Map();
let allocationState: AllocationState = {
  primaryCombo: '',
  secondaryCombo: null,
  primaryWeight: 0.7,
  secondaryWeight: 0.3,
  tenureStart: 0,
  lastDecisionTime: 0,
};
let lastSnapshotTime = 0;
let engineInitialized = false;
let nextPositionId = 1;

function getAllComboKeys(): string[] {
  const keys: string[] = [];
  for (const s of STRATEGIES) {
    for (const tf of TIMEFRAMES) {
      keys.push(makeComboKey(s, tf));
    }
  }
  return keys;
}

function initCombo(key: string): void {
  if (!comboPositions.has(key)) comboPositions.set(key, []);
  if (!comboEquity.has(key)) {
    comboEquity.set(key, {
      equity: SHADOW_EQUITY,
      peakEquity: SHADOW_EQUITY,
      trades: 0,
      wins: 0,
      totalPnl: 0,
      returns: [],
      drawdowns: [],
      mike1Score: 0,
    });
  }
}

function calculateMike1(eq: ComboEquityState): number {
  if (eq.returns.length < 3) return 0;
  const returns = eq.returns;
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? avg / stdDev : 0;
  if (eq.drawdowns.length === 0) return sharpe;
  const sumSqDD = eq.drawdowns.reduce((sum, d) => sum + d * d, 0);
  const ulcer = Math.sqrt(sumSqDD / eq.drawdowns.length);
  return ulcer > 0.001 ? sharpe / ulcer : sharpe * 10;
}

export async function initMtfShadowEngine(coinIds: string[]): Promise<void> {
  console.log('[MTF Shadow] Initializing multi-timeframe shadow engine...');

  for (const key of getAllComboKeys()) {
    initCombo(key);
  }

  try {
    const savedEquity = await db.select().from(mtfComboEquity);
    for (const row of savedEquity) {
      const key = row.comboKey;
      if (comboEquity.has(key)) {
        comboEquity.set(key, {
          equity: row.equity,
          peakEquity: row.peakEquity,
          trades: row.trades,
          wins: row.wins,
          totalPnl: row.totalPnl,
          returns: (row.returns as number[]) || [],
          drawdowns: (row.drawdowns as number[]) || [],
          mike1Score: row.mike1Score,
        });
      }
    }
    console.log(`[MTF Shadow] Loaded ${savedEquity.length} saved combo equity states`);
  } catch (e) {
    console.log('[MTF Shadow] No saved equity states found, starting fresh');
  }

  console.log('[MTF Shadow] Running backtest warmup on historical candles...');
  let totalBacktestTrades = 0;

  for (const tf of TIMEFRAMES) {
    for (const strategy of STRATEGIES) {
      if (strategy === 'pairsTrading') continue;

      const key = makeComboKey(strategy, tf);
      const eq = comboEquity.get(key)!;

      if (eq.trades >= 10) {
        console.log(`[MTF Shadow] ${key} already has ${eq.trades} trades, skipping backtest`);
        continue;
      }

      for (const coinId of coinIds) {
        const candles = getCachedCandles(coinId, tf);
        if (candles.length < 40) continue;

        const result = backtestOnCandles(candles, strategy, tf);
        for (const t of result.trades) {
          const pnlDollars = (t.pnlPercent / 100) * eq.equity * 0.05;
          eq.equity += pnlDollars;
          eq.totalPnl += pnlDollars;
          eq.trades++;
          if (t.pnlPercent > 0) eq.wins++;
          eq.returns.push(t.pnlPercent);
          if (eq.equity > eq.peakEquity) eq.peakEquity = eq.equity;
          const dd = eq.peakEquity > 0 ? (eq.peakEquity - eq.equity) / eq.peakEquity * 100 : 0;
          eq.drawdowns.push(dd);
          totalBacktestTrades++;
        }
      }

      if (eq.returns.length > 100) {
        eq.returns = eq.returns.slice(-100);
        eq.drawdowns = eq.drawdowns.slice(-100);
      }

      eq.mike1Score = calculateMike1(eq);
    }
  }

  console.log(`[MTF Shadow] Backtest warmup complete: ${totalBacktestTrades} trades across all combos`);

  for (const key of getAllComboKeys()) {
    const eq = comboEquity.get(key)!;
    if (eq.trades > 0) {
      console.log(`[MTF Shadow] ${key}: ${eq.trades}t, ${eq.wins}W, PnL=$${eq.totalPnl.toFixed(2)}, Mike1=${eq.mike1Score.toFixed(2)}`);
    }
  }

  await saveAllEquityStates();
  await takeSnapshot(0, 0);

  const scores = getAllMike1Scores();
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (sorted.length >= 2) {
    allocationState = {
      primaryCombo: sorted[0][0],
      secondaryCombo: sorted[1][0],
      primaryWeight: 0.7,
      secondaryWeight: 0.3,
      tenureStart: Date.now(),
      lastDecisionTime: Date.now(),
    };
    console.log(`[MTF Shadow] Initial allocation: ${allocationState.primaryCombo}(70%) + ${allocationState.secondaryCombo}(30%)`);
  }

  engineInitialized = true;
  console.log('[MTF Shadow] Engine initialized and ready');
}

export function processMtfSignals(
  cryptos: { id: string; current_price: number }[],
  btcPrice: number,
  marketVolatility: number
): void {
  if (!engineInitialized) return;

  for (const tf of TIMEFRAMES) {
    const candlesByCoins: Map<string, any[]> = new Map();
    for (const crypto of cryptos) {
      const candles = getCachedCandles(crypto.id, tf);
      if (candles.length > 0) candlesByCoins.set(crypto.id, candles);
    }

    if (candlesByCoins.size === 0) continue;

    const signals = generateAllMtfSignals(cryptos, candlesByCoins, tf);

    for (const signal of signals) {
      openShadowPosition(signal, btcPrice, marketVolatility);
    }
  }

  updateShadowPositions(cryptos, btcPrice, marketVolatility);

  const now = Date.now();
  if (now - lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
    takeSnapshot(btcPrice, marketVolatility);
    evaluateAllocation(btcPrice, marketVolatility);
    lastSnapshotTime = now;
  }
}

function openShadowPosition(signal: MtfSignal, btcPrice: number, marketVol: number): void {
  const key = signal.comboKey;
  initCombo(key);

  const positions = comboPositions.get(key)!;
  if (positions.length >= MAX_POSITIONS_PER_COMBO) return;

  const existing = positions.find(p => p.coinId === signal.coinId);
  if (existing) return;

  const eq = comboEquity.get(key)!;
  const posSize = eq.equity * 0.05;
  if (posSize < 1) return;

  const entrySlippage = signal.entryPrice * SLIPPAGE;
  const adjustedEntry = signal.side === 'long'
    ? signal.entryPrice + entrySlippage
    : signal.entryPrice - entrySlippage;

  const pos: ShadowPosition = {
    id: nextPositionId++,
    comboKey: key,
    symbol: signal.symbol,
    coinId: signal.coinId,
    side: signal.side,
    entryPrice: adjustedEntry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    atr: signal.atr,
    openedAt: Date.now(),
  };

  positions.push(pos);

  const parts = key.split('_');
  const strategy = parts.slice(0, -1).join('_');
  const timeframe = parts[parts.length - 1];

  db.insert(mtfShadowTrades).values({
    comboKey: key,
    strategy,
    timeframe,
    symbol: signal.symbol,
    coinId: signal.coinId,
    side: signal.side,
    entryPrice: adjustedEntry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    status: 'open',
    atr: signal.atr,
    confidence: signal.confidence,
    reasoning: signal.reasoning.join(' | '),
    btcPrice,
    marketVolatility: marketVol,
  }).catch(e => console.error(`[MTF Shadow] Failed to save trade:`, e));
}

function updateShadowPositions(
  cryptos: { id: string; current_price: number }[],
  btcPrice: number,
  marketVol: number
): void {
  const priceMap = new Map(cryptos.map(c => [c.id, c.current_price]));

  for (const key of Array.from(comboPositions.keys())) {
    const positions = comboPositions.get(key)!;
    const eq = comboEquity.get(key)!;
    const closedIndices: number[] = [];

    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const currentPrice = priceMap.get(pos.coinId);
      if (!currentPrice) continue;

      let exitPrice: number | null = null;
      let closeReason = '';

      if (pos.side === 'long') {
        if (currentPrice <= pos.stopLoss) { exitPrice = pos.stopLoss; closeReason = 'stop_loss'; }
        else if (currentPrice >= pos.takeProfit) { exitPrice = pos.takeProfit; closeReason = 'take_profit'; }
      } else {
        if (currentPrice >= pos.stopLoss) { exitPrice = pos.stopLoss; closeReason = 'stop_loss'; }
        else if (currentPrice <= pos.takeProfit) { exitPrice = pos.takeProfit; closeReason = 'take_profit'; }
      }

      const holdTimeMs = Date.now() - pos.openedAt;
      if (!exitPrice && holdTimeMs > 12 * 60 * 60 * 1000) {
        exitPrice = currentPrice;
        closeReason = 'time_decay';
      }

      if (exitPrice) {
        const rawPnl = pos.side === 'long'
          ? (exitPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - exitPrice) / pos.entryPrice;
        const netPnl = rawPnl - (FEE_RATE * 2);
        const pnlDollars = netPnl * eq.equity * 0.05;

        eq.equity += pnlDollars;
        eq.totalPnl += pnlDollars;
        eq.trades++;
        if (netPnl > 0) eq.wins++;
        eq.returns.push(netPnl * 100);
        if (eq.equity > eq.peakEquity) eq.peakEquity = eq.equity;
        const dd = eq.peakEquity > 0 ? (eq.peakEquity - eq.equity) / eq.peakEquity * 100 : 0;
        eq.drawdowns.push(dd);

        if (eq.returns.length > 200) {
          eq.returns = eq.returns.slice(-200);
          eq.drawdowns = eq.drawdowns.slice(-200);
        }

        eq.mike1Score = calculateMike1(eq);

        closedIndices.push(i);

        const parts = key.split('_');
        const strategy = parts.slice(0, -1).join('_');
        const timeframe = parts[parts.length - 1];

        db.insert(mtfShadowTrades).values({
          comboKey: key,
          strategy,
          timeframe,
          symbol: pos.symbol,
          coinId: pos.coinId,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          pnlPercent: netPnl * 100,
          pnlDollars,
          fees: FEE_RATE * 2 * eq.equity * 0.05,
          status: closeReason === 'take_profit' ? 'won' : closeReason === 'stop_loss' ? 'lost' : 'closed',
          atr: pos.atr,
          btcPrice,
          marketVolatility: marketVol,
          reasoning: closeReason,
          closedAt: new Date(),
        }).catch(e => console.error(`[MTF Shadow] Failed to save closed trade:`, e));
      }
    }

    for (let i = closedIndices.length - 1; i >= 0; i--) {
      positions.splice(closedIndices[i], 1);
    }
  }
}

async function takeSnapshot(btcPrice: number, marketVol: number): Promise<void> {
  const snapshots: InsertMtfMike1Snapshot[] = [];

  for (const key of getAllComboKeys()) {
    const eq = comboEquity.get(key);
    if (!eq) continue;

    const parts = key.split('_');
    const timeframe = parts[parts.length - 1];
    const strategy = parts.slice(0, -1).join('_');
    const winRate = eq.trades > 0 ? eq.wins / eq.trades : 0;
    const avgPnl = eq.returns.length > 0 ? eq.returns.reduce((a, b) => a + b, 0) / eq.returns.length : 0;
    const maxDD = eq.drawdowns.length > 0 ? Math.max(...eq.drawdowns) : 0;

    const sharpe = (() => {
      if (eq.returns.length < 3) return 0;
      const avg = eq.returns.reduce((a, b) => a + b, 0) / eq.returns.length;
      const v = eq.returns.reduce((s, r) => s + Math.pow(r - avg, 2), 0) / eq.returns.length;
      return Math.sqrt(v) > 0 ? avg / Math.sqrt(v) : 0;
    })();

    const ulcer = (() => {
      if (eq.drawdowns.length === 0) return 0;
      const sumSq = eq.drawdowns.reduce((s, d) => s + d * d, 0);
      return Math.sqrt(sumSq / eq.drawdowns.length);
    })();

    snapshots.push({
      comboKey: key,
      strategy,
      timeframe,
      mike1Score: eq.mike1Score,
      sharpeRatio: sharpe,
      ulcerIndex: ulcer,
      equity: eq.equity,
      trades: eq.trades,
      wins: eq.wins,
      winRate,
      totalPnl: eq.totalPnl,
      avgPnl,
      maxDrawdown: maxDD,
      btcPrice,
      marketVolatility: marketVol,
    });
  }

  if (snapshots.length > 0) {
    try {
      await db.insert(mtfMike1Snapshots).values(snapshots);
    } catch (e) {
      console.error('[MTF Shadow] Failed to save snapshots:', e);
    }
  }

  lastSnapshotTime = Date.now();
}

async function evaluateAllocation(btcPrice: number, marketVol: number): Promise<void> {
  const scores = getAllMike1Scores();
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (sorted.length < 2) return;

  const bestCombo = sorted[0][0];
  const bestScore = sorted[0][1];
  const secondCombo = sorted[1][0];
  const secondScore = sorted[1][1];

  const now = Date.now();
  const tenureElapsed = now - allocationState.tenureStart;
  const canSwitch = tenureElapsed >= MIN_TENURE_MS;

  const needsSwitch = bestCombo !== allocationState.primaryCombo && canSwitch;
  const wasSwitch = needsSwitch ? 1 : 0;

  let reason: string;
  if (needsSwitch) {
    allocationState.primaryCombo = bestCombo;
    allocationState.secondaryCombo = secondCombo;
    allocationState.tenureStart = now;
    reason = `Switched: ${bestCombo}(${bestScore.toFixed(2)}) > prev ${allocationState.primaryCombo}. Tenure elapsed: ${(tenureElapsed / 60000).toFixed(0)}min`;
    console.log(`[MTF Alloc] SWITCH: ${bestCombo}(70%) + ${secondCombo}(30%) | Mike1: ${bestScore.toFixed(2)} / ${secondScore.toFixed(2)}`);
  } else if (!canSwitch && bestCombo !== allocationState.primaryCombo) {
    reason = `Hold: ${allocationState.primaryCombo} (tenure ${(tenureElapsed / 60000).toFixed(0)}/${MIN_TENURE_MS / 60000}min). Best=${bestCombo}(${bestScore.toFixed(2)}) waiting.`;
  } else {
    allocationState.secondaryCombo = secondCombo;
    reason = `Confirm: ${bestCombo}(${bestScore.toFixed(2)}) still best. 2nd=${secondCombo}(${secondScore.toFixed(2)})`;
  }

  allocationState.lastDecisionTime = now;

  try {
    await db.insert(mtfAllocationDecisions).values({
      primaryCombo: allocationState.primaryCombo,
      primaryWeight: 0.7,
      primaryMike1: scores[allocationState.primaryCombo] || 0,
      secondaryCombo: allocationState.secondaryCombo,
      secondaryWeight: 0.3,
      secondaryMike1: allocationState.secondaryCombo ? (scores[allocationState.secondaryCombo] || 0) : 0,
      allScores: scores,
      reason,
      tenureStart: new Date(allocationState.tenureStart),
      wasSwitch,
      btcPrice,
      marketVolatility: marketVol,
    });
  } catch (e) {
    console.error('[MTF Shadow] Failed to save allocation decision:', e);
  }
}

async function saveAllEquityStates(): Promise<void> {
  for (const key of getAllComboKeys()) {
    const eq = comboEquity.get(key);
    if (!eq) continue;

    const parts = key.split('_');
    const timeframe = parts[parts.length - 1];
    const strategy = parts.slice(0, -1).join('_');

    try {
      const existing = await db.select().from(mtfComboEquity).where(drizzleEq(mtfComboEquity.comboKey, key));
      if (existing.length > 0) {
        await db.update(mtfComboEquity).set({
          equity: eq.equity,
          peakEquity: eq.peakEquity,
          trades: eq.trades,
          wins: eq.wins,
          totalPnl: eq.totalPnl,
          returns: eq.returns.slice(-200),
          drawdowns: eq.drawdowns.slice(-200),
          mike1Score: eq.mike1Score,
          updatedAt: new Date(),
        }).where(drizzleEq(mtfComboEquity.comboKey, key));
      } else {
        await db.insert(mtfComboEquity).values({
          comboKey: key,
          strategy,
          timeframe,
          equity: eq.equity,
          peakEquity: eq.peakEquity,
          trades: eq.trades,
          wins: eq.wins,
          totalPnl: eq.totalPnl,
          returns: eq.returns.slice(-200),
          drawdowns: eq.drawdowns.slice(-200),
          mike1Score: eq.mike1Score,
        });
      }
    } catch (e) {
      console.error(`[MTF Shadow] Failed to save equity for ${key}:`, e);
    }
  }
}

export function getAllMike1Scores(): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const key of getAllComboKeys()) {
    const eq = comboEquity.get(key);
    scores[key] = eq?.mike1Score || 0;
  }
  return scores;
}

export function getMtfAllocation(): AllocationState {
  return { ...allocationState };
}

export function getMtfComboStats(): Array<{
  comboKey: string; strategy: string; timeframe: string;
  mike1Score: number; trades: number; wins: number; equity: number;
  totalPnl: number; openPositions: number;
}> {
  const stats: Array<any> = [];
  for (const key of getAllComboKeys()) {
    const eq = comboEquity.get(key);
    const positions = comboPositions.get(key) || [];
    if (!eq) continue;

    const parts = key.split('_');
    const timeframe = parts[parts.length - 1];
    const strategy = parts.slice(0, -1).join('_');

    stats.push({
      comboKey: key,
      strategy,
      timeframe,
      mike1Score: eq.mike1Score,
      trades: eq.trades,
      wins: eq.wins,
      equity: eq.equity,
      totalPnl: eq.totalPnl,
      openPositions: positions.length,
    });
  }
  return stats.sort((a, b) => b.mike1Score - a.mike1Score);
}

export function getMtfLiveAllocationForTrading(): { primary: string; secondary: string | null; primaryWeight: number; secondaryWeight: number; cashFloor: boolean } {
  const scores = getAllMike1Scores();
  const allNegative = Object.values(scores).every(s => s <= 0);

  return {
    primary: allocationState.primaryCombo,
    secondary: allocationState.secondaryCombo,
    primaryWeight: allocationState.primaryWeight,
    secondaryWeight: allocationState.secondaryWeight,
    cashFloor: allNegative,
  };
}

export function isEngineReady(): boolean {
  return engineInitialized;
}

export async function periodicEquitySave(): Promise<void> {
  if (!engineInitialized) return;
  await saveAllEquityStates();
}
