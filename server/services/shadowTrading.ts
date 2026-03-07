import { v4 as uuidv4 } from "uuid";
import { db } from "../db";
import { shadowTrades, shadowPositions, shadowEquityState } from "@shared/schema";
import { eq as drizzleEq } from "drizzle-orm";
import type { QuantSignal, StrategyMode } from "./quantStrategy";

const SHADOW_EQUITY = 500;
const SHADOW_MAX_POSITION_PERCENT = 0.05;
const SHADOW_FEE_RATE = 0.0004;
const SHADOW_SLIPPAGE = 0.0005;
const MAX_SHADOW_POSITIONS_PER_STRATEGY = 5;

interface ShadowPosition {
  id: string;
  strategy: StrategyMode;
  symbol: string;
  coinName: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  openedAt: string;
}

interface ShadowEquity {
  equity: number;
  peakEquity: number;
  trades: number;
  wins: number;
  totalPnl: number;
  returns: number[];
  drawdowns: number[];
  mike1Score: number;
}

interface ShadowState {
  positions: Map<string, ShadowPosition[]>;
  equity: Map<string, ShadowEquity>;
}

const PRIMARY_STRATEGIES: StrategyMode[] = ["meanReversion", "volExpansion", "pairsTrading", "momentum"];

const state: ShadowState = {
  positions: new Map(),
  equity: new Map(),
};

function initStrategy(strategy: StrategyMode): void {
  if (!state.positions.has(strategy)) {
    state.positions.set(strategy, []);
  }
  if (!state.equity.has(strategy)) {
    state.equity.set(strategy, {
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

for (const s of PRIMARY_STRATEGIES) {
  initStrategy(s);
}

function calculateMike1(eq: ShadowEquity): number {
  if (eq.returns.length < 5) return 0;

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

export function processShadowSignal(signal: QuantSignal, strategy: StrategyMode): void {
  initStrategy(strategy);

  const positions = state.positions.get(strategy)!;
  const eq = state.equity.get(strategy)!;

  if (positions.length >= MAX_SHADOW_POSITIONS_PER_STRATEGY) return;

  const existing = positions.find(p => p.symbol === signal.symbol);
  if (existing) return;

  const positionValue = eq.equity * SHADOW_MAX_POSITION_PERCENT;
  const slippage = signal.entryPrice * SHADOW_SLIPPAGE;
  const executedPrice = signal.side === "long"
    ? signal.entryPrice + slippage
    : signal.entryPrice - slippage;
  const quantity = positionValue / executedPrice;
  const fees = positionValue * SHADOW_FEE_RATE;

  eq.equity -= fees;

  const pos: ShadowPosition = {
    id: uuidv4(),
    strategy,
    symbol: signal.symbol,
    coinName: signal.coinName,
    side: signal.side,
    quantity,
    entryPrice: executedPrice,
    currentPrice: executedPrice,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    openedAt: new Date().toISOString(),
  };

  positions.push(pos);
  console.log(`[Shadow] ${strategy} OPEN ${signal.side.toUpperCase()} ${signal.symbol} @ $${executedPrice.toFixed(2)} (equity: $${eq.equity.toFixed(2)})`);

  persistShadowPosition(pos).catch(e => console.error("[Shadow DB] Save position error:", e));
}

export function updateShadowPrices(prices: Map<string, number>): void {
  for (const strategy of PRIMARY_STRATEGIES) {
    initStrategy(strategy);
    const positions = state.positions.get(strategy)!;
    const eq = state.equity.get(strategy)!;
    const toClose: string[] = [];

    for (const pos of positions) {
      const currentPrice = prices.get(pos.symbol.toLowerCase());
      if (!currentPrice) continue;

      pos.currentPrice = currentPrice;
      pos.unrealizedPnl = pos.side === "long"
        ? (currentPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - currentPrice) * pos.quantity;

      const margin = pos.entryPrice * pos.quantity;
      pos.unrealizedPnlPercent = margin > 0 ? (pos.unrealizedPnl / margin) * 100 : 0;

      const stopHit = pos.side === "long"
        ? currentPrice <= pos.stopLoss
        : currentPrice >= pos.stopLoss;

      const tpHit = pos.takeProfit && (pos.side === "long"
        ? currentPrice >= pos.takeProfit
        : currentPrice <= pos.takeProfit);

      if (stopHit || tpHit) {
        toClose.push(pos.id);
      }
    }

    for (const id of toClose) {
      closeShadowPosition(strategy, id);
    }

    const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const totalEquity = eq.equity + unrealizedPnl;
    if (totalEquity > eq.peakEquity) {
      eq.peakEquity = totalEquity;
    }
    const dd = eq.peakEquity > 0
      ? ((eq.peakEquity - totalEquity) / eq.peakEquity) * 100
      : 0;
    eq.drawdowns.push(Math.max(0, dd));
    if (eq.drawdowns.length > 100) eq.drawdowns.shift();
  }
}

function closeShadowPosition(strategy: StrategyMode, positionId: string): void {
  const positions = state.positions.get(strategy);
  const eq = state.equity.get(strategy);
  if (!positions || !eq) return;

  const idx = positions.findIndex(p => p.id === positionId);
  if (idx === -1) return;

  const pos = positions[idx];

  const slippage = pos.currentPrice * SHADOW_SLIPPAGE;
  const exitPrice = pos.side === "long"
    ? pos.currentPrice - slippage
    : pos.currentPrice + slippage;

  let pnl: number;
  if (pos.side === "long") {
    pnl = (exitPrice - pos.entryPrice) * pos.quantity;
  } else {
    pnl = (pos.entryPrice - exitPrice) * pos.quantity;
  }

  const exitFees = (pos.quantity * exitPrice) * SHADOW_FEE_RATE;
  pnl -= exitFees;

  const margin = pos.entryPrice * pos.quantity;
  const pnlPercent = margin > 0 ? (pnl / margin) * 100 : 0;

  eq.equity += pnl;
  eq.trades++;
  eq.totalPnl += pnl;
  if (pnl > 0) eq.wins++;

  eq.returns.push(pnlPercent);
  if (eq.returns.length > 100) eq.returns.shift();

  eq.mike1Score = calculateMike1(eq);

  const stoppedOut = pos.side === "long"
    ? pos.currentPrice <= pos.stopLoss
    : pos.currentPrice >= pos.stopLoss;
  const status = stoppedOut ? "stopped_out" : "closed";

  console.log(`[Shadow] ${strategy} CLOSE ${pos.symbol} ${status}: P&L $${pnl.toFixed(4)} (${pnlPercent.toFixed(2)}%) | Mike1: ${eq.mike1Score.toFixed(3)} | Equity: $${eq.equity.toFixed(2)}`);

  positions.splice(idx, 1);

  persistShadowTrade(pos, exitPrice, pnl, pnlPercent, status).catch(e =>
    console.error("[Shadow DB] Save trade error:", e)
  );
  removeShadowPositionFromDB(pos.id).catch(e =>
    console.error("[Shadow DB] Remove position error:", e)
  );

  debouncedPersistEquity();
}

export interface ShadowAllocation {
  primary: StrategyMode;
  primaryWeight: number;
  secondary: StrategyMode;
  secondaryWeight: number;
  scores: Record<string, number>;
}

export function getShadowAllocation(): ShadowAllocation {
  const scores: Record<string, number> = {};
  for (const s of PRIMARY_STRATEGIES) {
    const eq = state.equity.get(s);
    scores[s] = eq?.mike1Score ?? 0;
  }

  const sorted = Object.entries(scores)
    .filter(([k]) => PRIMARY_STRATEGIES.includes(k as StrategyMode))
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) {
    return {
      primary: 'meanReversion' as StrategyMode,
      primaryWeight: 0.7,
      secondary: 'volExpansion' as StrategyMode,
      secondaryWeight: 0.3,
      scores,
    };
  }

  const [primary] = sorted[0];
  const secondary = sorted.length > 1 ? sorted[1][0] : (primary === 'meanReversion' ? 'volExpansion' : 'meanReversion');

  return {
    primary: primary as StrategyMode,
    primaryWeight: 0.7,
    secondary: secondary as StrategyMode,
    secondaryWeight: 0.3,
    scores,
  };
}

export function getShadowMike1Scores(): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const s of PRIMARY_STRATEGIES) {
    const eq = state.equity.get(s);
    scores[s] = eq?.mike1Score ?? 0;
  }
  return scores;
}

export function getShadowEquityStates(): Record<string, ShadowEquity> {
  const result: Record<string, ShadowEquity> = {};
  for (const s of PRIMARY_STRATEGIES) {
    const eq = state.equity.get(s);
    if (eq) result[s] = { ...eq };
  }
  return result;
}

export function getShadowPositions(): Record<string, ShadowPosition[]> {
  const result: Record<string, ShadowPosition[]> = {};
  for (const s of PRIMARY_STRATEGIES) {
    result[s] = [...(state.positions.get(s) || [])];
  }
  return result;
}

export function getShadowTradeCount(): number {
  let total = 0;
  for (const s of PRIMARY_STRATEGIES) {
    total += state.equity.get(s)?.trades ?? 0;
  }
  return total;
}

interface ShadowEquitySnapshot {
  timestamp: number;
  equities: Record<string, number>;
}

const SNAPSHOT_INTERVAL_MS = 20 * 60 * 1000;
const MAX_SNAPSHOTS = 50;
const LOOKBACK_PERIODS = 6;
let shadowSnapshots: ShadowEquitySnapshot[] = [];
let lastSnapshotTime = 0;

export function takeShadowEquitySnapshot(): void {
  const now = Date.now();
  if (now - lastSnapshotTime < SNAPSHOT_INTERVAL_MS) return;
  
  const equities: Record<string, number> = {};
  for (const s of PRIMARY_STRATEGIES) {
    const eq = state.equity.get(s);
    equities[s] = eq?.equity ?? SHADOW_EQUITY;
  }
  
  shadowSnapshots.push({ timestamp: now, equities });
  if (shadowSnapshots.length > MAX_SNAPSHOTS) {
    shadowSnapshots.shift();
  }
  lastSnapshotTime = now;
  
  console.log(`[Shadow Snapshot] ${PRIMARY_STRATEGIES.map(s => `${s}=$${equities[s].toFixed(2)}`).join(', ')}`);
}

export interface ShadowDerivedAllocation {
  primary: string;
  primaryWeight: number;
  secondary: string | null;
  secondaryWeight: number;
  shadowPnls: Record<string, number>;
  lookbackMinutes: number;
  confident: boolean;
}

export function getShadowDerivedAllocation(): ShadowDerivedAllocation | null {
  if (shadowSnapshots.length < 2) return null;
  
  const lookback = Math.min(LOOKBACK_PERIODS, shadowSnapshots.length - 1);
  const recentSnapshot = shadowSnapshots[shadowSnapshots.length - 1];
  const pastSnapshot = shadowSnapshots[shadowSnapshots.length - 1 - lookback];
  
  const pnls: Record<string, number> = {};
  for (const s of PRIMARY_STRATEGIES) {
    pnls[s] = (recentSnapshot.equities[s] ?? SHADOW_EQUITY) - (pastSnapshot.equities[s] ?? SHADOW_EQUITY);
  }
  
  const lookbackMinutes = (recentSnapshot.timestamp - pastSnapshot.timestamp) / (1000 * 60);
  
  const sorted = Object.entries(pnls).sort((a, b) => b[1] - a[1]);
  const bestStrategy = sorted[0];
  const secondStrategy = sorted.length > 1 ? sorted[1] : null;
  
  const anyPositive = sorted.some(([, pnl]) => pnl > 0);
  if (!anyPositive) {
    return {
      primary: sorted[0][0],
      primaryWeight: 0.7,
      secondary: sorted.length > 1 ? sorted[1][0] : null,
      secondaryWeight: 0.3,
      shadowPnls: pnls,
      lookbackMinutes,
      confident: false,
    };
  }
  
  let primaryWeight = 0.7;
  let secondaryWeight = 0.3;
  let secondary = secondStrategy ? secondStrategy[0] : null;
  
  if (secondStrategy && secondStrategy[1] <= 0) {
    primaryWeight = 1.0;
    secondary = null;
    secondaryWeight = 0;
  }
  
  return {
    primary: bestStrategy[0],
    primaryWeight,
    secondary,
    secondaryWeight,
    shadowPnls: pnls,
    lookbackMinutes,
    confident: anyPositive && lookback >= 3,
  };
}

export function getShadowSnapshotCount(): number {
  return shadowSnapshots.length;
}

export function isShadowReady(): boolean {
  const minTrades = 10;
  for (const s of PRIMARY_STRATEGIES) {
    const eq = state.equity.get(s);
    if (!eq || eq.trades < minTrades) return false;
  }
  return true;
}

async function persistShadowPosition(pos: ShadowPosition): Promise<void> {
  await db.insert(shadowPositions).values({
    id: pos.id,
    strategy: pos.strategy,
    symbol: pos.symbol,
    coinName: pos.coinName,
    side: pos.side,
    quantity: pos.quantity,
    entryPrice: pos.entryPrice,
    currentPrice: pos.currentPrice,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    unrealizedPnl: pos.unrealizedPnl,
    unrealizedPnlPercent: pos.unrealizedPnlPercent,
    openedAt: pos.openedAt,
    status: "open",
  }).onConflictDoUpdate({
    target: shadowPositions.id,
    set: {
      currentPrice: pos.currentPrice,
      unrealizedPnl: pos.unrealizedPnl,
      unrealizedPnlPercent: pos.unrealizedPnlPercent,
    },
  });
}

async function persistShadowTrade(
  pos: ShadowPosition,
  exitPrice: number,
  pnl: number,
  pnlPercent: number,
  status: string
): Promise<void> {
  const tradeId = `shadow-${pos.id}`;
  await db.insert(shadowTrades).values({
    id: tradeId,
    strategy: pos.strategy,
    symbol: pos.symbol,
    coinName: pos.coinName,
    side: pos.side,
    quantity: pos.quantity,
    entryPrice: pos.entryPrice,
    exitPrice,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    pnl,
    pnlPercent,
    fees: (pos.quantity * pos.entryPrice + pos.quantity * exitPrice) * SHADOW_FEE_RATE,
    status,
    openedAt: pos.openedAt,
    closedAt: new Date().toISOString(),
    reasoning: `Shadow trade for ${pos.strategy}`,
  }).onConflictDoNothing();
}

async function removeShadowPositionFromDB(positionId: string): Promise<void> {
  await db.delete(shadowPositions).where(drizzleEq(shadowPositions.id, positionId));
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedPersistEquity(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistAllEquityStates().catch(e =>
      console.error("[Shadow DB] Persist equity error:", e)
    );
  }, 15000);
}

async function persistAllEquityStates(): Promise<void> {
  for (const strategy of PRIMARY_STRATEGIES) {
    const eqData = state.equity.get(strategy);
    if (!eqData) continue;

    const existing = await db.select()
      .from(shadowEquityState)
      .where(drizzleEq(shadowEquityState.strategy, strategy))
      .limit(1);

    if (existing.length > 0) {
      await db.update(shadowEquityState)
        .set({
          equity: eqData.equity,
          peakEquity: eqData.peakEquity,
          trades: eqData.trades,
          wins: eqData.wins,
          totalPnl: eqData.totalPnl,
          returns: eqData.returns,
          drawdowns: eqData.drawdowns,
          mike1Score: eqData.mike1Score,
        })
        .where(drizzleEq(shadowEquityState.strategy, strategy));
    } else {
      await db.insert(shadowEquityState).values({
        strategy,
        equity: eqData.equity,
        peakEquity: eqData.peakEquity,
        trades: eqData.trades,
        wins: eqData.wins,
        totalPnl: eqData.totalPnl,
        returns: eqData.returns,
        drawdowns: eqData.drawdowns,
        mike1Score: eqData.mike1Score,
      });
    }
  }
}

export async function restoreShadowState(): Promise<void> {
  try {
    const savedEquity = await db.select().from(shadowEquityState);
    for (const row of savedEquity) {
      const s = row.strategy as StrategyMode;
      if (!PRIMARY_STRATEGIES.includes(s)) continue;

      state.equity.set(s, {
        equity: row.equity,
        peakEquity: row.peakEquity,
        trades: row.trades,
        wins: row.wins,
        totalPnl: row.totalPnl,
        returns: (row.returns as number[]) || [],
        drawdowns: (row.drawdowns as number[]) || [],
        mike1Score: row.mike1Score,
      });
      console.log(`[Shadow Restore] ${s}: equity=$${row.equity.toFixed(2)}, trades=${row.trades}, mike1=${row.mike1Score.toFixed(3)}`);
    }

    const savedPositions = await db.select()
      .from(shadowPositions)
      .where(drizzleEq(shadowPositions.status, "open"));

    for (const row of savedPositions) {
      const s = row.strategy as StrategyMode;
      if (!PRIMARY_STRATEGIES.includes(s)) continue;
      initStrategy(s);

      const positions = state.positions.get(s)!;
      positions.push({
        id: row.id,
        strategy: s,
        symbol: row.symbol,
        coinName: row.coinName,
        side: row.side as "long" | "short",
        quantity: row.quantity,
        entryPrice: row.entryPrice,
        currentPrice: row.currentPrice,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        unrealizedPnl: row.unrealizedPnl,
        unrealizedPnlPercent: row.unrealizedPnlPercent,
        openedAt: row.openedAt,
      });
    }

    const totalPositions = Array.from(state.positions.values()).reduce((sum, arr) => sum + arr.length, 0);
    if (savedEquity.length > 0 || totalPositions > 0) {
      console.log(`[Shadow Restore] Restored ${savedEquity.length} equity states, ${totalPositions} open positions`);
    }
  } catch (error) {
    console.error("[Shadow Restore] Error:", error);
  }
}
