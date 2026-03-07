import { 
  Position, 
  TradeRecord, 
  PortfolioState, 
  TradingStats,
  AITradeSignal,
  BrokerConfig,
  PositionSide,
  OrderType 
} from "@shared/schema";
import { v4 as uuidv4 } from "uuid";
import { recordTradeResult, recordLearningSample } from "./aiTrader";
import { recordModePerformance, calculateScaleOutTakeProfits, getModePerformance, type StrategyMode, type ModeAllocation } from "./quantStrategy";
import { getStrategyAllocation } from "./syntheticWarmup";
import { isSymbolInTop15 } from "./binanceCandles";
import { saveTrade, savePosition, removePosition, savePortfolioState, loadAllTrades, loadOpenPositions, loadPortfolioState, cleanupClosedPositions, fullResetAllTradingData, startPeriodicSync } from "./tradePersistence";
import { getExecutionMode } from "./hyperliquid/config";
import { hlOpenPosition, hlClosePosition, hlPartialClose, isHLMode } from "./hyperliquid/adapter";
import { getAccountState, type HLAccountState } from "./hyperliquid/infoClient";
import { updateDrawdownProtection, isDrawdownProtectionActive, savePortfolioMetricSnapshot, getPortfolioMetricValue } from "./portfolioMetric";
import { getEquityCurveState, invertTradeDirection, shouldInvertSignal, shouldInvertNewSignals, shouldCloseWorstPositions, getReversalCloseThreshold, recordReversalClose, getReversalState, updateDailyProfitTarget, getDailyTargetSizeMultiplier, resetEquityCurveManager } from "./equityCurveManager";
import * as fs from 'fs';
import * as path from 'path';
import type { RegimeState } from './basketStrategy';

let _getMarketRegimeFn: (() => RegimeState) | null = null;

export function registerRegimeProvider(fn: () => RegimeState): void {
  _getMarketRegimeFn = fn;
}

// Minimum interval between dynamic order updates (10 minutes in ms)
const ORDER_UPDATE_COOLDOWN_MS = 10 * 60 * 1000;

// Per-symbol trade cooldown to prevent "machine gun" re-entry loops
const TRADE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes for normal entry attempts
const STOP_OUT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes after stop-out (prevents chasing losing trades)

// Orphan trades that need market prices to calculate proper P&L before closing
const pendingReconciliation: TradeRecord[] = [];

let consecutiveEmptyHLCount = 0;
let lastHLPositionCount = -1;
const HL_EMPTY_THRESHOLD = 3;

// FILE-BASED LOCK SYSTEM - prevents race conditions across async operations
// NOTE: Cooldowns are cleared on startup so restarts don't block trades
const LOCK_FILE = '/tmp/trade_cooldown_lock.json';

// In-memory cache for immediate machine-gun prevention (catches same-millisecond calls)
const cooldownCache: Map<string, number> = new Map();

// STARTUP CLEANUP: Clear stale cooldowns from previous process
// Restarts should NOT inherit cooldowns - they exist to prevent same-process machine-gun bugs
try {
  fs.writeFileSync(LOCK_FILE, JSON.stringify({}));
  console.log('[STARTUP] Cleared cooldown lock file - fresh start');
} catch (e) {
  console.log('[STARTUP] Could not clear cooldown file:', e);
}

// In-memory mutex to serialize file access and prevent race conditions
// This ensures only one operation can read/modify/write the file at a time
let fileLockMutex = false;
let pendingLockOperations: (() => void)[] = [];

function acquireFileLock(): Promise<void> {
  return new Promise((resolve) => {
    if (!fileLockMutex) {
      fileLockMutex = true;
      resolve();
    } else {
      pendingLockOperations.push(resolve);
    }
  });
}

function releaseFileLock(): void {
  if (pendingLockOperations.length > 0) {
    const next = pendingLockOperations.shift()!;
    next();
  } else {
    fileLockMutex = false;
  }
}

// File-based cooldown functions for reliability with mutex protection
function loadCooldownLocks(): Record<string, number> {
  try {
    if (!fs.existsSync(LOCK_FILE)) {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({}), { flag: 'wx' });
      return {};
    }
    const data = fs.readFileSync(LOCK_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Invalid lock file format');
    }
    return parsed;
  } catch (error) {
    console.log(`[LOCK FILE] Error loading locks, resetting file: ${error}`);
    // Reset the file to prevent repeated corrupted states
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({}));
    } catch (writeError) {
      console.error(`[LOCK FILE] CRITICAL: Could not reset corrupted lock file: ${writeError}`);
    }
    return {};
  }
}

function saveCooldownLocks(locks: Record<string, number>): void {
  try {
    // Atomic write: write to temp file then rename
    const tempFile = LOCK_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(locks));
    fs.renameSync(tempFile, LOCK_FILE);
  } catch (error) {
    console.error(`[LOCK FILE] Error saving locks: ${error}`);
  }
}

function setSymbolCooldown(symbol: string, durationMs: number = TRADE_COOLDOWN_MS): void {
  // Store the EXPIRY time (not start time) so different durations work correctly
  const expiresAt = Date.now() + durationMs;
  
  // Immediate in-memory cache to catch same-millisecond calls
  cooldownCache.set(symbol, expiresAt);
  
  // Also persist to file
  const locks = loadCooldownLocks();
  locks[symbol] = expiresAt;
  saveCooldownLocks(locks);
  const durationMin = Math.round(durationMs / 60000);
  console.log(`[LOCK FILE] ${symbol}: Cooldown set for ${durationMin}min (expires ${new Date(expiresAt).toISOString()})`);
}

function clearSymbolCooldown(symbol: string): void {
  // Clear from in-memory cache
  cooldownCache.delete(symbol);
  
  // Also clear from file
  const locks = loadCooldownLocks();
  delete locks[symbol];
  saveCooldownLocks(locks);
  console.log(`[LOCK FILE] ${symbol}: Cooldown cleared from file`);
}

function getSymbolCooldownTime(symbol: string): number {
  // Check in-memory cache first (catches same-millisecond calls)
  const cacheTime = cooldownCache.get(symbol);
  if (cacheTime) {
    return cacheTime;
  }
  
  // Fall back to file (catches restarts)
  const locks = loadCooldownLocks();
  return locks[symbol] || 0;
}

// Minimum profit target threshold (0.8%) - trades with smaller targets don't cover fees
const MIN_PROFIT_TARGET_PERCENT = 0.8;

// Learning sample captures trade context for AI adaptation
export interface LearningSample {
  pnlPercent: number;
  isWin: boolean;
  side: PositionSide;
  symbol: string;
  durationMs: number;
  indicators: {
    rsiOversold?: boolean;
    rsiOverbought?: boolean;
    macdBullish?: boolean;
    macdBearish?: boolean;
    volatilitySqueeze?: boolean;
    meanProximity?: boolean;
    adxHookingUp?: boolean;
    trendUp?: boolean;
    trendDown?: boolean;
    mvrvUndervalued?: boolean;
    mvrvOvervalued?: boolean;
    capitalInflow?: boolean;
    capitalOutflow?: boolean;
  };
  entryGates: {
    zScoreGate: boolean;
    meanProximityGate: boolean;
    adxGate: boolean;
    perfectSetup: boolean;
  };
  signalMode?: StrategyMode;
}

// Rolling metrics for Sharpe/Ulcer calculation
interface RollingMetrics {
  returns: number[];  // pnl% per trade
  equityHistory: number[];  // equity snapshots
  timestamps: number[];  // for time-based calculations
  maxSampleSize: number;
}

const rollingMetrics: RollingMetrics = {
  returns: [],
  equityHistory: [],
  timestamps: [],
  maxSampleSize: 200,
};

export interface EquityPoint {
  timestamp: number;
  equity: number;
  event?: 'open' | 'close' | 'stop';
  symbol?: string;
  pnl?: number;
}

const equityCurve: EquityPoint[] = [];
const EQUITY_CURVE_MAX = 2000;
let equitySnapshotCounter = 0;

export function recordEquitySnapshot(equity: number): void {
  equityCurve.push({ timestamp: Date.now(), equity });
  if (equityCurve.length > EQUITY_CURVE_MAX) equityCurve.shift();
}

let _batchEquityMode = false;

export function setBatchEquityMode(enabled: boolean): void {
  _batchEquityMode = enabled;
}

function getAuthoritativeEquity(): number {
  if (getExecutionMode() === "hyperliquid" && cachedHLAccountState) {
    return cachedHLAccountState.equity;
  }
  return tradingState.balance + tradingState.positions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
}

export function recordEquityEvent(equity: number, event: 'open' | 'close' | 'stop', symbol: string, pnl?: number): void {
  if (_batchEquityMode) return;
  const authEquity = getAuthoritativeEquity();
  equityCurve.push({ timestamp: Date.now(), equity: authEquity, event, symbol, pnl });
  if (equityCurve.length > EQUITY_CURVE_MAX) equityCurve.shift();
}

export function getEquityCurve(): EquityPoint[] {
  return [...equityCurve];
}

export function seedEquityCurve(points: EquityPoint[]): void {
  if (equityCurve.length > 0) return;
  for (const p of points) {
    equityCurve.push(p);
  }
  while (equityCurve.length > EQUITY_CURVE_MAX) equityCurve.shift();
  if (points.length > 0) {
    console.log(`[Equity Curve] Seeded with ${points.length} historical snapshots`);
  }
}

// Calculate Sharpe Ratio from rolling returns
function calculateSharpeRatio(): number {
  if (rollingMetrics.returns.length < 5) return 0;
  
  const returns = rollingMetrics.returns;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  
  if (returns.length < 2) return mean > 0 ? 1 : -1;
  
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  
  // Annualize assuming ~30 trades per day
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;
  return sharpe;
}

// Calculate Ulcer Index (measures downside volatility/pain)
function calculateUlcerIndex(): number {
  if (rollingMetrics.equityHistory.length < 3) return 0;
  
  const equity = rollingMetrics.equityHistory;
  let sumSquaredDrawdown = 0;
  let runningMax = equity[0];
  
  for (let i = 0; i < equity.length; i++) {
    runningMax = Math.max(runningMax, equity[i]);
    const drawdownPercent = ((runningMax - equity[i]) / runningMax) * 100;
    sumSquaredDrawdown += drawdownPercent * drawdownPercent;
  }
  
  return Math.sqrt(sumSquaredDrawdown / equity.length);
}

// PRIMARY METRIC: Mike1 = Sharpe / (Ulcer Index + 0.001)
// The +0.001 smoothing factor prevents divide-by-zero in perfect uptrends
// This is the "North Star" metric for strategy selection and regime switching
export function getSharpeUlcerRatio(): { sharpe: number; ulcer: number; primary: number } {
  const sharpe = calculateSharpeRatio();
  const ulcer = calculateUlcerIndex();
  
  // Mike1 metric: Sharpe / (Ulcer + 0.001) - proper smoothing per spec
  const SMOOTHING_FACTOR = 0.001;
  const primary = sharpe / (ulcer + SMOOTHING_FACTOR);
  
  return { sharpe, ulcer, primary };
}

// Update rolling metrics when a trade closes
export function updateRollingMetrics(pnlPercent: number, currentEquity: number): void {
  const now = Date.now();
  
  rollingMetrics.returns.push(pnlPercent);
  rollingMetrics.equityHistory.push(currentEquity);
  rollingMetrics.timestamps.push(now);
  
  // Keep only recent samples
  while (rollingMetrics.returns.length > rollingMetrics.maxSampleSize) {
    rollingMetrics.returns.shift();
    rollingMetrics.equityHistory.shift();
    rollingMetrics.timestamps.shift();
  }
}

// Extract indicator flags from trade reasoning for learning
function extractIndicatorFlags(trade: TradeRecord): LearningSample['indicators'] {
  const reasoning = trade.aiReasoning || '';
  return {
    rsiOversold: reasoning.includes('oversold'),
    rsiOverbought: reasoning.includes('overbought'),
    macdBullish: reasoning.includes('bullish crossover') || reasoning.includes('MACD bullish'),
    macdBearish: reasoning.includes('bearish crossover') || reasoning.includes('MACD bearish'),
    volatilitySqueeze: reasoning.includes('squeeze'),
    meanProximity: reasoning.includes('mean') || reasoning.includes('SMA100'),
    adxHookingUp: reasoning.includes('ADX hooking'),
    trendUp: reasoning.includes('uptrend'),
    trendDown: reasoning.includes('downtrend'),
    mvrvUndervalued: reasoning.includes('undervalued'),
    mvrvOvervalued: reasoning.includes('overvalued'),
    capitalInflow: reasoning.includes('inflow'),
    capitalOutflow: reasoning.includes('outflow'),
  };
}

// Extract entry gate information from trade reasoning
function extractEntryGates(trade: TradeRecord): LearningSample['entryGates'] {
  const reasoning = trade.aiReasoning || '';
  return {
    zScoreGate: true, // Always passed if trade opened
    meanProximityGate: reasoning.includes('mean') || reasoning.includes('SMA100'),
    adxGate: reasoning.includes('ADX hooking') || reasoning.includes('ADX trending'),
    perfectSetup: reasoning.includes('squeeze') && (reasoning.includes('mean') || reasoning.includes('SMA100')),
  };
}

// Extract signal mode from trade record (uses stored value first, then fallback to parsing)
function extractSignalMode(trade: TradeRecord): StrategyMode | undefined {
  // Prefer the explicitly stored signalMode if available
  if (trade.signalMode) {
    return trade.signalMode as StrategyMode;
  }
  
  // Fallback to parsing reasoning for backward compatibility
  const reasoning = trade.aiReasoning || '';
  if (reasoning.includes('Mean Reversion') || reasoning.includes('meanReversion')) {
    return 'meanReversion';
  } else if (reasoning.includes('Vol Expansion') || reasoning.includes('volExpansion')) {
    return 'volExpansion';
  }
  return 'adaptive'; // Default if not specified
}

let INITIAL_BALANCE = 1000;
const MAX_POSITION_PERCENT = 0.10; // 10% per position to allow scale-out with minimum lots
const MAX_CRYPTO_EXPOSURE = 0.25;
const MAX_DRAWDOWN_PERCENT = 0.25;

const BROKER: BrokerConfig = {
  name: "Simulated Binance Futures",
  minLotSize: 0.001,
  maxLeverage: 10,
  makerFee: 0.0002,
  takerFee: 0.0004,
  avgSlippage: 0.0005,
  maxSlippage: 0.002,
};

// Minimum notional value for a trade (Binance Futures minimum is typically $5-10)
const MIN_NOTIONAL_VALUE = 10.0;

interface TradingState {
  balance: number;
  equity: number;
  positions: Position[];
  trades: TradeRecord[];
  peakEquity: number;
  maxDrawdown: number;
  startedAt: string;
}

let tradingState: TradingState = {
  balance: INITIAL_BALANCE,
  equity: INITIAL_BALANCE,
  positions: [],
  trades: [],
  peakEquity: INITIAL_BALANCE,
  maxDrawdown: 0,
  startedAt: new Date().toISOString(),
};

let isTradingActive = true;

let cachedHLAccountState: HLAccountState | null = null;
let hlAccountLastFetch = 0;
const HL_ACCOUNT_CACHE_MS = 10_000;
let hlConsecutiveFailures = 0;
let hlLastSuccessTime = 0;
const HL_MAX_RETRIES = 3;
const HL_RETRY_DELAY_MS = 2000;

export function getHLConnectionHealth(): { connected: boolean; consecutiveFailures: number; lastSuccess: number; lastSuccessAgo: number } {
  const now = Date.now();
  return {
    connected: hlConsecutiveFailures < 3 && (hlLastSuccessTime > 0 && now - hlLastSuccessTime < 60_000),
    consecutiveFailures: hlConsecutiveFailures,
    lastSuccess: hlLastSuccessTime,
    lastSuccessAgo: hlLastSuccessTime > 0 ? Math.round((now - hlLastSuccessTime) / 1000) : -1,
  };
}

export async function syncHLAccountState(): Promise<void> {
  if (getExecutionMode() !== "hyperliquid") return;
  const now = Date.now();
  if (cachedHLAccountState && now - hlAccountLastFetch < HL_ACCOUNT_CACHE_MS) return;

  for (let attempt = 1; attempt <= HL_MAX_RETRIES; attempt++) {
    try {
      cachedHLAccountState = await getAccountState();
      hlAccountLastFetch = Date.now();
      hlConsecutiveFailures = 0;
      hlLastSuccessTime = Date.now();
      tradingState.balance = cachedHLAccountState.balance;
      tradingState.equity = cachedHLAccountState.equity;
      if (cachedHLAccountState.equity > tradingState.peakEquity) {
        tradingState.peakEquity = cachedHLAccountState.equity;
      }
      return;
    } catch (error) {
      if (attempt < HL_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, HL_RETRY_DELAY_MS * attempt));
        continue;
      }
      hlConsecutiveFailures++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[HL ACCOUNTING] Failed to sync (${hlConsecutiveFailures} consecutive failures): ${msg}`);
      if (hlConsecutiveFailures >= 3) {
        console.error(`[HL ACCOUNTING] ⚠️ CONNECTION DEGRADED — ${hlConsecutiveFailures} consecutive failures, last success ${hlLastSuccessTime > 0 ? Math.round((Date.now() - hlLastSuccessTime) / 1000) + 's ago' : 'NEVER'}`);
      }
    }
  }
}

export function getHLAccountStateCache(): HLAccountState | null {
  return cachedHLAccountState;
}

function persistPortfolioState(): void {
  savePortfolioState({
    balance: tradingState.balance,
    equity: tradingState.equity,
    peakEquity: tradingState.peakEquity,
    maxDrawdown: tradingState.maxDrawdown,
    realizedPnl: tradingState.balance - INITIAL_BALANCE,
    initialBalance: INITIAL_BALANCE,
    startedAt: tradingState.startedAt,
  }).catch(e => console.error('[DB] Save portfolio state error:', e));
}

export async function restoreTradingState(): Promise<void> {
  try {
    const [savedTrades, savedPositions, savedPortfolio] = await Promise.all([
      loadAllTrades(),
      loadOpenPositions(),
      loadPortfolioState(),
    ]);

    if (savedPortfolio) {
      tradingState.balance = savedPortfolio.balance;
      tradingState.equity = savedPortfolio.equity;
      tradingState.peakEquity = savedPortfolio.peakEquity;
      tradingState.maxDrawdown = savedPortfolio.maxDrawdown;
      tradingState.startedAt = savedPortfolio.startedAt;
      console.log(`[DB RESTORE] Portfolio: balance=$${savedPortfolio.balance.toFixed(2)}, peak=$${savedPortfolio.peakEquity.toFixed(2)}`);
    }

    if (getExecutionMode() === "hyperliquid") {
      try {
        await syncHLAccountState();
        if (cachedHLAccountState) {
          const hlEquity = cachedHLAccountState.equity;
          let hlUPnl = cachedHLAccountState.unrealizedPnl;
          if (Math.abs(hlUPnl) < 0.001) {
            const { getOpenPositions } = await import("./hyperliquid/infoClient");
            const hlPositions = await getOpenPositions();
            if (hlPositions.length > 0) {
              hlUPnl = hlPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
              console.log(`[HL ACCOUNTING] uPnl was $0 but ${hlPositions.length} positions open — using position-level uPnl: $${hlUPnl.toFixed(4)}`);
            }
          }
          const hlBalance = hlEquity - hlUPnl;

          if (savedPortfolio?.initialBalance != null && savedPortfolio.initialBalance > 0) {
            INITIAL_BALANCE = savedPortfolio.initialBalance;
            console.log(`[HL ACCOUNTING] INITIAL_BALANCE restored from DB: $${INITIAL_BALANCE.toFixed(2)}`);
          } else {
            INITIAL_BALANCE = hlEquity;
            console.log(`[HL ACCOUNTING] INITIAL_BALANCE set to HL equity (first run): $${INITIAL_BALANCE.toFixed(2)}`);
            savePortfolioState({
              balance: hlBalance,
              equity: hlEquity,
              peakEquity: Math.max(hlEquity, tradingState.peakEquity),
              maxDrawdown: tradingState.maxDrawdown,
              realizedPnl: hlBalance - INITIAL_BALANCE,
              initialBalance: INITIAL_BALANCE,
              startedAt: tradingState.startedAt,
            }).catch(e => console.error('[DB] Save initial balance error:', e));
          }

          tradingState.balance = hlBalance;
          tradingState.equity = hlEquity;
          tradingState.peakEquity = Math.max(hlEquity, tradingState.peakEquity > hlEquity * 5 ? hlEquity : tradingState.peakEquity);
          tradingState.maxDrawdown = 0;
          console.log(`[HL ACCOUNTING] Current HL: equity=$${hlEquity.toFixed(2)}, balance=$${hlBalance.toFixed(2)}, uPnl=$${hlUPnl.toFixed(2)}, realizedPnl=$${(hlBalance - INITIAL_BALANCE).toFixed(2)}`);
        }
      } catch (e) {
        console.error("[HL ACCOUNTING] Failed to sync on restore:", e instanceof Error ? e.message : e);
      }
    }

    if (savedTrades.length > 0) {
      tradingState.trades = savedTrades;
      console.log(`[DB RESTORE] Loaded ${savedTrades.length} trades from database`);
      
      let fixedCount = 0;
      for (const t of savedTrades) {
        if (t.status !== 'open' && (t.exitPrice == null || t.pnl == null)) {
          if (t.exitPrice == null) {
            t.exitPrice = t.entryPrice;
            console.log(`[DB REPAIR] Trade ${t.id} ${t.symbol} ${t.side}: null exitPrice -> set to entryPrice $${t.entryPrice} (P&L will be ~0, conservative fallback)`);
          }
          if (t.pnl == null) {
            const rawPnl = t.side === 'long' 
              ? (t.exitPrice - t.entryPrice) * t.quantity
              : (t.entryPrice - t.exitPrice) * t.quantity;
            t.pnl = rawPnl - (t.fees ?? 0);
            const margin = t.entryPrice * t.quantity;
            t.pnlPercent = margin > 0 ? (t.pnl / margin) * 100 : 0;
            console.log(`[DB REPAIR] Trade ${t.id} ${t.symbol}: null pnl -> calculated $${t.pnl.toFixed(4)} from exitPrice`);
          }
          saveTrade(t).catch(e => console.error('[DB] Fix bad trade error:', e));
          fixedCount++;
        }
      }
      if (fixedCount > 0) {
        console.log(`[DB REPAIR] Fixed ${fixedCount} trades with null exit_price or pnl`);
      }
      
      const badTrades = savedTrades.filter(t => t.status !== 'open' && (t.exitPrice == null || t.pnl == null));
      if (badTrades.length > 0) {
        console.error(`[DB INTEGRITY FAIL] ${badTrades.length} closed trades still have null exit_price or pnl after repair!`);
      } else {
        console.log(`[DB INTEGRITY OK] All closed trades have valid exit_price and pnl`);
      }
      
      const closedTrades = savedTrades.filter(t => t.status !== 'open' && t.pnlPercent != null);
      for (const t of closedTrades) {
        rollingMetrics.returns.push(t.pnlPercent!);
      }
      while (rollingMetrics.returns.length > rollingMetrics.maxSampleSize) {
        rollingMetrics.returns.shift();
      }
    }

    if (getExecutionMode() === "hyperliquid") {
      console.log(`[DB RESTORE] HL mode — skipping DB position restore (HL is system of record)`);
      tradingState.positions = [];
      for (const p of savedPositions) {
        removePosition(p.id).catch(e => console.error('[DB] Remove stale position error:', e));
      }
      for (const t of tradingState.trades) {
        if (t.status === 'open') {
          pendingReconciliation.push(t);
        }
      }
    } else {
      const validPositions: Position[] = [];
      let orphanCount = 0;
      
      for (const p of savedPositions) {
        const matchingTrade = tradingState.trades.find(t => t.id === p.id);
        
        if (matchingTrade && matchingTrade.status !== 'open') {
          console.log(`[DB RECONCILE] Position ${p.symbol} ${p.side} has trade status='${matchingTrade.status}' - removing orphan from DB`);
          removePosition(p.id).catch(e => console.error('[DB] Remove orphan position error:', e));
          orphanCount++;
          continue;
        }
        
        if (!matchingTrade) {
          console.log(`[DB RECONCILE] Position ${p.symbol} ${p.side} has NO matching trade record - removing orphan from DB`);
          removePosition(p.id).catch(e => console.error('[DB] Remove orphan position error:', e));
          orphanCount++;
          continue;
        }
        
        validPositions.push(p);
      }
      
      const validPositionIds = new Set(validPositions.map(p => p.id));
      for (const t of tradingState.trades) {
        if (t.status === 'open' && !validPositionIds.has(t.id)) {
          console.log(`[DB RECONCILE] Trade ${t.symbol} ${t.side} is 'open' but has no valid position - deferring close until prices available`);
          pendingReconciliation.push(t);
          orphanCount++;
        }
      }
      
      tradingState.positions = validPositions;
      if (orphanCount > 0 || validPositions.length > 0) {
        console.log(`[DB RECONCILE] ${validPositions.length} valid positions, ${orphanCount} orphans cleaned`);
      }
    }
    
    cleanupClosedPositions().then(() => {
      console.log(`[DB CLEANUP] Purged stale closed positions from paper_positions table`);
    }).catch(e => console.error('[DB CLEANUP] Error:', e));

    if (savedTrades.length > 0 || savedPositions.length > 0) {
      console.log(`[DB RESTORE] State restored successfully - ${savedTrades.length} trades, ${savedPositions.length} open positions`);
    } else {
      console.log(`[DB RESTORE] No previous trading state found, starting fresh`);
    }

    startPeriodicSync(() => tradingState.trades);
  } catch (error) {
    console.error('[DB RESTORE] Error restoring trading state:', error);
  }
}

export function startTrading(): void {
  isTradingActive = true;
  console.log("[Paper Trading] Trading started");
}

export function stopTrading(): void {
  isTradingActive = false;
  console.log("[Paper Trading] Trading stopped");
}

export function isTradingEnabled(): boolean {
  return isTradingActive;
}

export function estimatePositionValue(price: number, positionSizeUsd: number): number {
  const executedPrice = price + (price * 0.0005);
  let quantity = roundToLotSize(positionSizeUsd / executedPrice);
  const minScaleoutQuantity = BROKER.minLotSize * 3;
  if (quantity < minScaleoutQuantity) quantity = minScaleoutQuantity;
  let notional = quantity * executedPrice;
  if (notional < MIN_NOTIONAL_VALUE) {
    quantity = Math.ceil((MIN_NOTIONAL_VALUE / executedPrice) / BROKER.minLotSize) * BROKER.minLotSize;
    notional = quantity * executedPrice;
  }
  return notional;
}

export function getMaxPositionValue(): number {
  const portfolio = getPortfolioState();
  return portfolio.equity * MAX_POSITION_PERCENT;
}

function calculateSlippage(price: number, side: PositionSide, orderType: OrderType): number {
  if (orderType === "limit") return 0;
  
  const slippagePercent = BROKER.avgSlippage + (Math.random() * (BROKER.maxSlippage - BROKER.avgSlippage));
  return side === "long" ? price * slippagePercent : -price * slippagePercent;
}

function calculateFees(notionalValue: number, orderType: OrderType): number {
  const feeRate = orderType === "limit" ? BROKER.makerFee : BROKER.takerFee;
  return notionalValue * feeRate;
}

function roundToLotSize(quantity: number): number {
  return Math.floor(quantity / BROKER.minLotSize) * BROKER.minLotSize;
}

export function getPortfolioState(): PortfolioState {
  const usedMargin = tradingState.positions.reduce((sum, p) => sum + p.marginUsed, 0);

  if (getExecutionMode() === "hyperliquid" && cachedHLAccountState) {
    const equity = cachedHLAccountState.equity;
    const positionUnrealizedPnl = tradingState.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const balance = equity - positionUnrealizedPnl;
    const totalPnl = equity - INITIAL_BALANCE;
    const realizedPnl = balance - INITIAL_BALANCE;

    if (equity > tradingState.peakEquity) {
      tradingState.peakEquity = equity;
    }
    const currentDrawdown = tradingState.peakEquity > 0
      ? ((tradingState.peakEquity - equity) / tradingState.peakEquity) * 100
      : 0;

    return {
      balance,
      equity,
      availableMargin: balance - usedMargin,
      usedMargin,
      unrealizedPnl: positionUnrealizedPnl,
      realizedPnl,
      totalPnl,
      totalPnlPercent: INITIAL_BALANCE > 0 ? (totalPnl / INITIAL_BALANCE) * 100 : 0,
      positions: tradingState.positions,
      maxDrawdown: tradingState.maxDrawdown,
      currentDrawdown: Math.max(0, currentDrawdown),
      peakEquity: tradingState.peakEquity,
      lastUpdated: new Date().toISOString(),
    };
  }

  const unrealizedPnl = tradingState.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const equity = tradingState.balance + unrealizedPnl;
  const balance = tradingState.balance;
  const realizedPnl = balance - INITIAL_BALANCE;
  const totalPnl = equity - INITIAL_BALANCE;

  const currentDrawdown = tradingState.peakEquity > 0 
    ? ((tradingState.peakEquity - equity) / tradingState.peakEquity) * 100
    : 0;

  return {
    balance,
    equity,
    availableMargin: balance - usedMargin,
    usedMargin,
    unrealizedPnl,
    realizedPnl,
    totalPnl,
    totalPnlPercent: INITIAL_BALANCE > 0 ? (totalPnl / INITIAL_BALANCE) * 100 : 0,
    positions: tradingState.positions,
    maxDrawdown: tradingState.maxDrawdown,
    currentDrawdown: Math.max(0, currentDrawdown),
    peakEquity: tradingState.peakEquity,
    lastUpdated: new Date().toISOString(),
  };
}

export function removePhantomPositions(positionIds: string[]): number {
  if (positionIds.length === 0) return 0;
  const idSet = new Set(positionIds);
  const before = tradingState.positions.length;
  tradingState.positions = tradingState.positions.filter(p => !idSet.has(p.id));
  const removed = before - tradingState.positions.length;
  if (removed > 0) {
    console.log(`[Reconcile] Removed ${removed} phantom internal positions: [${positionIds.join(', ')}]`);
    persistPortfolioState();
  }
  return removed;
}

export function createSyntheticPosition(symbol: string, side: "long" | "short", size: number, entryPrice: number): Position {
  const position: Position = {
    id: uuidv4(),
    symbol,
    coinName: symbol,
    side,
    quantity: size,
    initialQuantity: size,
    entryPrice,
    currentPrice: entryPrice,
    stopLoss: side === 'long' ? entryPrice * 0.95 : entryPrice * 1.05,
    takeProfit: side === 'long' ? entryPrice * 1.05 : entryPrice * 0.95,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    marginUsed: size * entryPrice,
    leverage: 1,
    openedAt: new Date().toISOString(),
    aiReasoning: `Synced from HL — ${side} ${symbol} ${size} @ $${entryPrice.toFixed(4)}`,
  };
  tradingState.positions.push(position);
  savePosition(position).catch(e => console.error('[DB] Save synthetic position error:', e));
  return position;
}

let hlSyncInterval: ReturnType<typeof setInterval> | null = null;
let hlSyncRunning = false;
let tradingStateLocked = false;

export function acquireTradingLock(): boolean {
  if (tradingStateLocked) return false;
  tradingStateLocked = true;
  return true;
}

export function releaseTradingLock(): void {
  tradingStateLocked = false;
}

export function startHLPositionSync(): void {
  if (getExecutionMode() !== "hyperliquid") return;
  if (hlSyncInterval) return;

  hlSyncInterval = setInterval(async () => {
    if (hlSyncRunning) return;
    hlSyncRunning = true;
    try {
      await syncPositionsWithHL();
    } catch (e) {
      console.error("[HL SYNC] Error:", e instanceof Error ? e.message : e);
    } finally {
      hlSyncRunning = false;
    }
  }, 30_000);

  console.log("[HL SYNC] Position sync started (every 30s)");
}

function closeOrphanTradeRecords(positionIds: string[], closeReason: string): void {
  const now = new Date().toISOString();
  for (const id of positionIds) {
    const trade = tradingState.trades.find(t => t.id === id && t.status === 'open');
    if (trade) {
      trade.status = 'closed';
      trade.closedAt = now;
      trade.closeReason = closeReason;
      trade.exitPrice = trade.entryPrice;
      trade.pnl = 0;
      trade.pnlPercent = 0;
      saveTrade(trade).catch(e => console.error('[DB] Save orphan trade closure error:', e));
    }
  }
}

async function syncPositionsWithHL(): Promise<void> {
  if (tradingStateLocked) {
    return;
  }
  const { getOpenPositions } = await import("./hyperliquid/infoClient");
  const { SYMBOL_TO_HL, HL_TO_SYMBOL } = await import("./hyperliquid/config");

  const hlPositions = await getOpenPositions();

  const internalByCoin = new Map<string, { totalSize: number; side: "long" | "short"; ids: string[] }>();
  for (const p of tradingState.positions) {
    const hlSymbol = SYMBOL_TO_HL[p.symbol] || p.symbol;
    const existing = internalByCoin.get(hlSymbol);
    if (existing) {
      existing.totalSize += p.quantity;
      existing.ids.push(p.id);
    } else {
      internalByCoin.set(hlSymbol, { totalSize: p.quantity, side: p.side as "long" | "short", ids: [p.id] });
    }
  }

  const internalCoinCount = internalByCoin.size;
  const hlCoinCount = hlPositions.length;

  if (internalCoinCount > 0 && hlCoinCount === 0) {
    consecutiveEmptyHLCount++;
    if (consecutiveEmptyHLCount < HL_EMPTY_THRESHOLD) {
      console.log(`[HL SYNC] HL returned 0 positions but internal has ${internalCoinCount} coins — skipping phantom purge (${consecutiveEmptyHLCount}/${HL_EMPTY_THRESHOLD})`);
      return;
    }
    console.log(`[HL SYNC] HL confirmed empty ${consecutiveEmptyHLCount}× — proceeding with phantom removal`);
  } else if (internalCoinCount > 0 && hlCoinCount > 0 && lastHLPositionCount > 0
    && hlCoinCount < lastHLPositionCount * 0.5 && hlCoinCount < internalCoinCount * 0.5) {
    console.log(`[HL SYNC] HL position count dropped sharply (${lastHLPositionCount} → ${hlCoinCount}, internal=${internalCoinCount}) — skipping phantom purge (possible partial data)`);
    return;
  } else {
    consecutiveEmptyHLCount = 0;
  }

  lastHLPositionCount = hlCoinCount;

  const hlByCoin = new Map(hlPositions.map(p => [p.coin, p]));
  let corrections = 0;

  for (const [coin, internal] of internalByCoin) {
    const hlPos = hlByCoin.get(coin);
    if (!hlPos) {
      const displaySymbol = HL_TO_SYMBOL[coin] || coin;
      console.log(`[HL SYNC] Removed phantom ${displaySymbol} (${internal.ids.length} layers) — no HL position`);
      tradingState.positions = tradingState.positions.filter(p => !internal.ids.includes(p.id));
      for (const id of internal.ids) {
        removePosition(id).catch(() => {});
      }
      closeOrphanTradeRecords(internal.ids, 'HL sync - position closed on exchange');
      corrections++;
    } else {
      const sizeDiff = Math.abs(internal.totalSize - hlPos.size);
      const sizeRatio = hlPos.size > 0 ? sizeDiff / hlPos.size : 0;
      if (sizeRatio > 0.05 || internal.side !== hlPos.side) {
        const displaySymbol = HL_TO_SYMBOL[coin] || coin;
        console.log(`[HL SYNC] Fixing ${displaySymbol}: internal=${internal.totalSize.toFixed(4)} ${internal.side} → HL=${hlPos.size} ${hlPos.side}`);
        tradingState.positions = tradingState.positions.filter(p => !internal.ids.includes(p.id));
        for (const id of internal.ids) {
          removePosition(id).catch(() => {});
        }
        closeOrphanTradeRecords(internal.ids, 'HL sync - position rebuilt from exchange');
        createSyntheticPosition(displaySymbol, hlPos.side, hlPos.size, hlPos.entryPrice);
        corrections++;
      } else {
        for (const id of internal.ids) {
          const pos = tradingState.positions.find(p => p.id === id);
          if (pos) {
            pos.currentPrice = hlPos.markPrice;
            pos.unrealizedPnl = hlPos.unrealizedPnl * (pos.quantity / internal.totalSize);
            const margin = pos.quantity * pos.entryPrice;
            pos.unrealizedPnlPercent = margin > 0 ? (pos.unrealizedPnl / margin) * 100 : 0;
          }
        }
      }
    }
  }

  for (const hlPos of hlPositions) {
    if (!internalByCoin.has(hlPos.coin)) {
      const displaySymbol = HL_TO_SYMBOL[hlPos.coin] || hlPos.coin;
      console.log(`[HL SYNC] Adopted HL position: ${displaySymbol} ${hlPos.side} size=${hlPos.size} @ $${hlPos.entryPrice.toFixed(4)}`);
      createSyntheticPosition(displaySymbol, hlPos.side, hlPos.size, hlPos.entryPrice);
      corrections++;
    }
  }

  if (corrections > 0) {
    persistPortfolioState();
    console.log(`[HL SYNC] Applied ${corrections} corrections — internal now matches HL (${hlPositions.length} positions)`);
  }
}

export function getTrades(): TradeRecord[] {
  return [...tradingState.trades].reverse();
}

function isReconciliationTrade(closeReason: string | undefined): boolean {
  if (!closeReason) return false;
  return closeReason.includes('Reconciliation')
    || closeReason.includes('HL sync')
    || closeReason.includes('System restart');
}

export function getTradingStats(): TradingStats {
  const allClosedTrades = tradingState.trades.filter(t => t.status !== "open");
  const reconCount = allClosedTrades.filter(t => isReconciliationTrade(t.closeReason)).length;
  const closedTrades = allClosedTrades.filter(t => !isReconciliationTrade(t.closeReason));
  const winningTrades = closedTrades.filter(t => (t.pnl || 0) > 0);
  const losingTrades = closedTrades.filter(t => (t.pnl || 0) < 0);
  
  const totalWins = winningTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + (t.pnl || 0), 0));
  
  const avgWin = winningTrades.length > 0 ? totalWins / winningTrades.length : 0;
  const avgLoss = losingTrades.length > 0 ? totalLosses / losingTrades.length : 0;
  
  const cryptoExposure = new Map<string, number>();
  tradingState.positions.forEach(p => {
    const current = cryptoExposure.get(p.symbol) || 0;
    cryptoExposure.set(p.symbol, current + p.marginUsed);
  });

  const exposureArray = Array.from(cryptoExposure.entries()).map(([symbol, exposure]) => ({
    symbol,
    exposure,
    exposurePercent: (exposure / tradingState.equity) * 100,
  }));

  const monthlyReturns: { month: string; return: number; trades: number; }[] = [];
  const tradesByMonth = new Map<string, TradeRecord[]>();
  
  closedTrades.forEach(trade => {
    if (trade.closedAt) {
      const month = trade.closedAt.substring(0, 7);
      const existing = tradesByMonth.get(month) || [];
      existing.push(trade);
      tradesByMonth.set(month, existing);
    }
  });

  tradesByMonth.forEach((trades, month) => {
    const monthReturn = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    monthlyReturns.push({
      month,
      return: (monthReturn / INITIAL_BALANCE) * 100,
      trades: trades.length,
    });
  });

  return {
    totalTrades: closedTrades.length,
    reconciliationTrades: reconCount,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate: closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : 0,
    avgWin,
    avgLoss,
    profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
    sharpeRatio: null,
    maxDrawdown: tradingState.maxDrawdown,
    avgDrawdown: tradingState.maxDrawdown / 2,
    bestTrade: closedTrades.length > 0 ? Math.max(...closedTrades.map(t => t.pnl || 0)) : 0,
    worstTrade: closedTrades.length > 0 ? Math.min(...closedTrades.map(t => t.pnl || 0)) : 0,
    avgHoldingTime: "N/A",
    totalFees: tradingState.trades.reduce((sum, t) => sum + t.fees, 0),
    totalSlippage: tradingState.trades.reduce((sum, t) => sum + (t.slippage * t.quantity), 0),
    monthlyReturns,
    cryptoExposure: exposureArray,
  };
}

function processPendingReconciliation(prices: Map<string, number>): void {
  const toProcess = [...pendingReconciliation];
  pendingReconciliation.length = 0;
  
  const isHL = getExecutionMode() === 'hyperliquid';
  let processedCount = 0;
  for (const t of toProcess) {
    if (isHL) {
      t.exitPrice = t.entryPrice;
      t.pnl = 0;
      t.pnlPercent = 0;
      t.status = 'closed';
      t.closeReason = 'System restart - reconciled (HL is system of record)';
      t.closedAt = new Date().toISOString();
      console.log(`[DB RECONCILE] Closing orphan ${t.symbol} ${t.side} with $0 PnL (HL is system of record)`);
      saveTrade(t).catch(e => console.error('[DB] Save reconciled trade error:', e));
      processedCount++;
      continue;
    }

    const currentPrice = prices.get(t.symbol.toLowerCase());
    if (!currentPrice) {
      pendingReconciliation.push(t);
      continue;
    }
    
    t.exitPrice = currentPrice;
    const rawPnl = t.side === 'long' 
      ? (currentPrice - t.entryPrice) * t.quantity
      : (t.entryPrice - currentPrice) * t.quantity;
    t.pnl = rawPnl - t.fees;
    const margin = t.entryPrice * t.quantity;
    t.pnlPercent = margin > 0 ? (t.pnl / margin) * 100 : 0;
    console.log(`[DB RECONCILE] Closing orphan ${t.symbol} ${t.side} with market price $${currentPrice.toFixed(4)} -> P&L: $${t.pnl.toFixed(4)} (NOT added to balance - already persisted)`);
    
    t.status = 'closed';
    t.closeReason = 'DB Reconciliation - No matching open position';
    t.closedAt = new Date().toISOString();
    
    saveTrade(t).catch(e => console.error('[DB] Save reconciled trade error:', e));
    processedCount++;
  }
  
  if (processedCount > 0) {
    console.log(`[DB RECONCILE] Processed ${processedCount} orphan trades${isHL ? ' (all $0 PnL — HL is system of record)' : ' (balance unchanged - loaded from portfolio_state)'}`);
  }
  if (pendingReconciliation.length > 0) {
    console.log(`[DB RECONCILE] ${pendingReconciliation.length} trades still waiting for market prices`);
  }
}

export async function updatePositionPrices(prices: Map<string, number>): Promise<void> {
  if (pendingReconciliation.length > 0) {
    processPendingReconciliation(prices);
  }
  
  let positionsToClose: string[] = [];
  
  for (const position of tradingState.positions) {
    const currentPrice = prices.get(position.symbol.toLowerCase());
    if (!currentPrice) continue;
    
    position.currentPrice = currentPrice;
    
    if (position.side === "long") {
      position.unrealizedPnl = (currentPrice - position.entryPrice) * position.quantity;
    } else {
      position.unrealizedPnl = (position.entryPrice - currentPrice) * position.quantity;
    }
    
    const currentPositionMargin = position.quantity * position.entryPrice;
    position.unrealizedPnlPercent = currentPositionMargin > 0 
      ? (position.unrealizedPnl / currentPositionMargin) * 100 
      : 0;
    
    const stopHit = position.side === "long" 
      ? currentPrice <= position.stopLoss
      : currentPrice >= position.stopLoss;
    
    if (position.takeProfitLevels && position.takeProfitLevels.length > 0 && !stopHit) {
      await checkScaleOutTakeProfits(position, currentPrice);
    }
    
    const allTPsTriggered = position.takeProfitLevels?.every(tp => tp.triggered) ?? false;
    const legacyTPHit = !position.takeProfitLevels && position.takeProfit && (
      position.side === "long" 
        ? currentPrice >= position.takeProfit
        : currentPrice <= position.takeProfit
    );
    
    if (stopHit || legacyTPHit || (allTPsTriggered && position.quantity <= BROKER.minLotSize)) {
      positionsToClose.push(position.id);
    }
  }

  const closedPairIds = new Set<string>();
  for (const id of positionsToClose) {
    const position = tradingState.positions.find(p => p.id === id);
    if (!position) continue;
    if (position.pairId && closedPairIds.has(position.pairId)) continue;

    const stoppedOut = position.side === "long"
      ? position.currentPrice <= position.stopLoss
      : position.currentPrice >= position.stopLoss;
    
    let reason: string;
    if (stoppedOut) {
      reason = `Stop Loss Hit @ $${position.currentPrice.toFixed(2)}`;
    } else {
      const allTPsTriggered = position.takeProfitLevels?.every(tp => tp.triggered);
      if (allTPsTriggered) {
        reason = `All TPs Triggered - Final Close`;
      } else if (!position.takeProfitLevels && position.takeProfit) {
        reason = `Legacy TP Hit @ $${position.currentPrice.toFixed(2)}`;
      } else {
        reason = `Take Profit / Manual Close`;
      }
    }
    await closePosition(id, position.currentPrice, stoppedOut ? "stopped_out" : "closed", reason);

    if (position.pairId) {
      closedPairIds.add(position.pairId);
      const orphan = tradingState.positions.find(
        p => p.pairId === position.pairId && p.id !== id
      );
      if (orphan) {
        console.log(`[PAIR ORPHAN] Closing ${orphan.symbol} (${orphan.side}) - partner ${position.symbol} was ${stoppedOut ? 'stopped out' : 'closed'}`);
        await closePosition(orphan.id, orphan.currentPrice, "closed", `Pair Orphan - Partner ${position.symbol} ${stoppedOut ? 'stopped out' : 'closed'}`);
      }
    }
  }

  const unrealizedPnl = tradingState.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  tradingState.equity = tradingState.balance + unrealizedPnl;

  let equityForPeak = tradingState.equity;
  if (getExecutionMode() === "hyperliquid" && cachedHLAccountState) {
    equityForPeak = cachedHLAccountState.equity;
    tradingState.equity = equityForPeak;
  }
  
  if (equityForPeak > tradingState.peakEquity) {
    tradingState.peakEquity = equityForPeak;
  }
  
  const currentDrawdown = ((tradingState.peakEquity - equityForPeak) / tradingState.peakEquity) * 100;
  if (currentDrawdown > tradingState.maxDrawdown) {
    tradingState.maxDrawdown = currentDrawdown;
  }

  equitySnapshotCounter++;
  if (equitySnapshotCounter >= 6) {
    recordEquitySnapshot(tradingState.equity);
    equitySnapshotCounter = 0;
  }
}

// Check and execute scale-out take profit levels
async function checkScaleOutTakeProfits(position: Position, currentPrice: number): Promise<void> {
  if (!position.takeProfitLevels) return;
  
  for (let i = 0; i < position.takeProfitLevels.length; i++) {
    const tpLevel = position.takeProfitLevels[i];
    if (tpLevel.triggered) continue; // Already hit this level
    
    const tpHit = position.side === "long"
      ? currentPrice >= tpLevel.price
      : currentPrice <= tpLevel.price;
    
    if (tpHit) {
      // Calculate quantity to close at this level
      const quantityToClose = roundToLotSize((tpLevel.quantityPercent / 100) * position.initialQuantity);
      
      if (quantityToClose >= BROKER.minLotSize && position.quantity > BROKER.minLotSize) {
        // Execute partial close
        const actualClose = Math.min(quantityToClose, position.quantity - BROKER.minLotSize);
        if (actualClose >= BROKER.minLotSize) {
          await executePartialClose(position, actualClose, currentPrice, i + 1);
        }
      }
      
      // Mark this level as triggered
      tpLevel.triggered = true;
      
      console.log(`[Scale-Out] ${position.symbol} TP${i+1} HIT @ $${currentPrice.toFixed(2)} ` +
        `(target: $${tpLevel.price.toFixed(2)}), closed ${tpLevel.quantityPercent}% ` +
        `(${(tpLevel.hitProbability*100).toFixed(0)}% probability)`);
    }
  }
}

// Execute a partial position close (scale-out)
// Take-profit exits use LIMIT orders (maker fee) to reduce costs
async function executePartialClose(position: Position, quantityToClose: number, exitPrice: number, tpLevel: number): Promise<void> {
  let executedPrice = exitPrice;
  let fees = 0;

  if (isHLMode()) {
    try {
      const result = await hlPartialClose(position.symbol, quantityToClose, exitPrice, position.side, `TP${tpLevel} partial close`);
      if (result.success) {
        if (result.fillPrice && result.fillPrice > 0) {
          executedPrice = result.fillPrice;
        }
        console.log(`[HL] Partial close ${position.symbol} TP${tpLevel}: fill=$${executedPrice.toFixed(4)}`);
      } else {
        console.error(`[HL MISMATCH] Partial close FAILED for ${position.symbol}: ${result.error} — proceeding with internal`);
      }
    } catch (e) {
      console.error(`[HL MISMATCH] Partial close error for ${position.symbol}: ${e} — proceeding with internal`);
    }
  } else {
    const notionalValue = quantityToClose * executedPrice;
    fees = calculateFees(notionalValue, "limit");
  }
  
  let pnl: number;
  if (position.side === "long") {
    pnl = (executedPrice - position.entryPrice) * quantityToClose;
  } else {
    pnl = (position.entryPrice - executedPrice) * quantityToClose;
  }
  pnl -= fees;
  
  tradingState.balance += pnl;
  
  // Reduce position quantity and margin
  const portionClosed = quantityToClose / position.quantity;
  position.quantity -= quantityToClose;
  position.quantity = roundToLotSize(position.quantity);
  position.marginUsed *= (1 - portionClosed);
  
  const tradeIndex = tradingState.trades.findIndex(t => t.id === position.id);
  let cumulativePnlPercent = 0;
  
  if (tradeIndex !== -1) {
    const trade = tradingState.trades[tradeIndex];
    const existingPnl = trade.pnl || 0;
    const existingFees = trade.fees || 0;
    const existingSlippage = trade.slippage || 0;
    const newCumulativePnl = existingPnl + pnl;
    
    const originalMargin = trade.quantity * trade.entryPrice;
    cumulativePnlPercent = originalMargin > 0 ? (newCumulativePnl / originalMargin) * 100 : 0;
    
    tradingState.trades[tradeIndex] = {
      ...trade,
      pnl: newCumulativePnl,
      pnlPercent: cumulativePnlPercent,
      fees: existingFees + fees,
      slippage: existingSlippage,
    };
  }
  
  const chunkMargin = quantityToClose * position.entryPrice;
  const chunkPnlPercent = chunkMargin > 0 ? (pnl / chunkMargin) * 100 : 0;
  
  console.log(`[Partial Close] ${position.symbol} TP${tpLevel}: closed ${quantityToClose.toFixed(4)} units ` +
    `@ $${executedPrice.toFixed(2)}, Chunk P&L: $${pnl.toFixed(4)} (${chunkPnlPercent.toFixed(2)}%), ` +
    `Cumulative: ${cumulativePnlPercent.toFixed(2)}%, remaining: ${position.quantity.toFixed(4)} units`);
  
  const partialTrade = tradingState.trades[tradeIndex];
  if (partialTrade) {
    saveTrade(partialTrade).catch(e => console.error('[DB] Save partial trade error:', e));
  }
  savePosition(position).catch(e => console.error('[DB] Save position after partial close:', e));
  persistPortfolioState();
  
  recordTradeResult(chunkPnlPercent);
  
  // Update rolling metrics with chunk pnlPercent
  rollingMetrics.returns.push(chunkPnlPercent);
  if (rollingMetrics.returns.length > rollingMetrics.maxSampleSize) {
    rollingMetrics.returns.shift();
  }
}

// Dynamic order update - recalculate ONLY take profits (stop loss is FIXED at entry)
// Maximum update frequency: every 10 minutes
export function updateDynamicOrders(
  priceHistory: Map<string, number[]>, // symbol -> recent prices array
  atrMap: Map<string, number>,         // symbol -> current ATR
  volatilityMap: Map<string, number>   // symbol -> current volatility
): void {
  const now = Date.now();
  
  tradingState.positions.forEach(position => {
    // Check cooldown - only update if 10 minutes have passed
    const lastUpdate = position.lastOrderUpdate 
      ? new Date(position.lastOrderUpdate).getTime() 
      : 0;
    
    if (now - lastUpdate < ORDER_UPDATE_COOLDOWN_MS) {
      return; // Skip - too soon since last update
    }
    
    const atr = atrMap.get(position.symbol.toLowerCase());
    const volatility = volatilityMap.get(position.symbol.toLowerCase());
    
    if (!atr) {
      return; // Not enough data
    }
    
    const currentPrice = position.currentPrice;
    
    // STOP LOSS IS FIXED - No trailing, no updates after entry
    // TPs are based on entry price + R:R multiples of stop distance
    // Dynamic updates only WIDEN TPs (never tighten them)
    
    const stopDistance = Math.abs(position.entryPrice - position.stopLoss);
    const minTPDistance = position.entryPrice * 0.015; // 1.5% minimum
    
    const TP1_RR = 1.5;
    const TP2_RR = 2.5;
    
    const tp1Distance = Math.max(stopDistance * TP1_RR, minTPDistance);
    const tp2Distance = Math.max(stopDistance * TP2_RR, minTPDistance * 1.67);
    
    let newTP1: number, newTP2: number;
    if (position.side === "long") {
      newTP1 = position.entryPrice + tp1Distance;
      newTP2 = position.entryPrice + tp2Distance;
    } else {
      newTP1 = position.entryPrice - tp1Distance;
      newTP2 = position.entryPrice - tp2Distance;
    }
    
    if (position.takeProfitLevels && position.takeProfitLevels.length > 0) {
      const updatedLevels = position.takeProfitLevels.map((level, index) => {
        if (level.triggered) return level;
        
        const newPrice = index === 0 ? newTP1 : newTP2;
        
        const isBetter = position.side === "long"
          ? newPrice >= level.price
          : newPrice <= level.price;
        
        return isBetter ? { ...level, price: newPrice } : level;
      });
      
      position.takeProfitLevels = updatedLevels;
      
      const lastTP = updatedLevels[updatedLevels.length - 1];
      if (lastTP && !lastTP.triggered) {
        position.takeProfit = lastTP.price;
      }
      
      position.lastOrderUpdate = new Date().toISOString();
      
      console.log(`[Dynamic TP] ${position.symbol}: TP1=$${newTP1.toFixed(6)}, TP2=$${newTP2.toFixed(6)} (SL=$${position.stopLoss.toFixed(6)}, stopDist=${(stopDistance/position.entryPrice*100).toFixed(2)}%)`);
    }
  });
}

// ============================================================================
// ACTIVE TRADE MANAGER — AI-powered dynamic position management
// Runs every 5 seconds alongside price updates. Manages:
// 1. Trailing stops — lock in profits as price moves favorably
// 2. Minimum profit enforcement — never close a winner for dust
// 3. Portfolio-aware tightening — cut losers faster when metric is negative
// 4. Time decay exits — close stale positions that go nowhere
// 5. Portfolio-level basket stop (-1.5%) and profit take (+1%)
// ============================================================================

const TRAILING_STOP_ACTIVATION_PERCENT = 1.0;   // Trail starts when unrealized P&L >= 1.0% of entry
const TRAILING_STOP_DISTANCE_PERCENT = 1.5;     // Trail distance: 1.5% behind current price
const MIN_PROFIT_FLOOR_PERCENT = 0.10;          // Minimum profit floor: 0.10% of position value
const STALE_POSITION_HOURS = 12;                // Close positions that go nowhere for 12+ hours
const STALE_POSITION_DRIFT_PERCENT = 0.3;       // Consider "going nowhere" if < 0.3% from entry
const PORTFOLIO_STRESS_STOP_TIGHTEN = 0.5;      // When under stress, tighten underwater stops by 50%
const ACTIVE_MANAGER_LOG_COOLDOWN_MS = 5 * 60 * 1000; // Log actions at most every 5 min per position

const activeManagerLogTimes: Map<string, number> = new Map();

export async function activeTradeManager(prices: Map<string, number>): Promise<void> {
  if (tradingState.positions.length === 0) return;

  const portfolioMetricValue = getPortfolioMetricValue();
  const isPortfolioStressed = portfolioMetricValue < 0;
  const now = Date.now();
  const positionsToClose: { id: string; price: number; reason: string }[] = [];

  // --- PORTFOLIO-LEVEL BASKET STOP & PROFIT TAKE (regime-adaptive) ---
  const totalUnrealized = tradingState.positions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
  let portfolioStopPct = 0.015;
  let regimeLabel = '';
  if (_getMarketRegimeFn) {
    try {
      const regime = _getMarketRegimeFn();
      portfolioStopPct = regime.portfolioStopPercent;
      regimeLabel = regime.regime;
    } catch {}
  }
  const portfolioStopThreshold = -tradingState.balance * portfolioStopPct;
  const portfolioProfitTakeThreshold = tradingState.balance * 0.01;

  if (totalUnrealized <= portfolioStopThreshold) {
    console.log(`[BASKET STOP] Portfolio unrealized $${totalUnrealized.toFixed(2)} hit -${(portfolioStopPct * 100).toFixed(1)}% threshold ($${portfolioStopThreshold.toFixed(2)}) [${regimeLabel}] — closing ALL positions`);
    for (const pos of [...tradingState.positions]) {
      positionsToClose.push({ id: pos.id, price: pos.currentPrice, reason: `Basket portfolio stop (-${(portfolioStopPct * 100).toFixed(1)}% ${regimeLabel})` });
    }
  } else if (totalUnrealized >= portfolioProfitTakeThreshold) {
    console.log(`[BASKET PROFIT TAKE] Portfolio unrealized $${totalUnrealized.toFixed(2)} hit +1% threshold ($${portfolioProfitTakeThreshold.toFixed(2)}) — closing ALL positions`);
    for (const pos of [...tradingState.positions]) {
      positionsToClose.push({ id: pos.id, price: pos.currentPrice, reason: 'Basket profit take (+1%)' });
    }
  }

  // --- GRADUATED REVERSAL: Close worst underwater positions when escalated ---
  if (shouldCloseWorstPositions()) {
    const threshold = getReversalCloseThreshold();
    const revState = getReversalState();
    const worstPositions = [...tradingState.positions]
      .filter(p => (p.unrealizedPnlPercent || 0) < threshold)
      .sort((a, b) => (a.unrealizedPnlPercent || 0) - (b.unrealizedPnlPercent || 0));

    if (worstPositions.length > 0) {
      const worst = worstPositions[0];
      const closePrice = prices.get(worst.symbol.toLowerCase());
      if (closePrice) {
        console.log(`[REVERSAL ${revState.level}] Closing worst position: ${worst.symbol} ${worst.side} (P&L: ${(worst.unrealizedPnlPercent || 0).toFixed(2)}%, negative for ${revState.negativeDurationMinutes.toFixed(0)}min)`);
        positionsToClose.push({
          id: worst.id,
          price: closePrice,
          reason: `Reversal ${revState.level} - worst underwater position (${(worst.unrealizedPnlPercent || 0).toFixed(2)}%)`
        });
        recordReversalClose();
      }
    }
  }

  const positionSnapshot = [...tradingState.positions];
  positionSnapshot.forEach(position => {
    const currentPrice = prices.get(position.symbol.toLowerCase());
    if (!currentPrice) return;

    const entryPrice = position.entryPrice;
    const positionValue = position.quantity * entryPrice;
    if (positionValue <= 0) return;

    const pnlPercent = position.unrealizedPnlPercent || 0;
    const isLong = position.side === "long";
    const openedAt = new Date(position.openedAt).getTime();
    const hoursOpen = (now - openedAt) / (1000 * 60 * 60);

    const shouldLog = !activeManagerLogTimes.has(position.id) ||
      (now - (activeManagerLogTimes.get(position.id) || 0)) > ACTIVE_MANAGER_LOG_COOLDOWN_MS;

    // --- 1. TRAILING STOP LOSS ---
    // When position is profitable enough, trail the stop behind price
    if (pnlPercent >= TRAILING_STOP_ACTIVATION_PERCENT) {
      const trailDistance = currentPrice * (TRAILING_STOP_DISTANCE_PERCENT / 100);
      let newStop: number;

      if (isLong) {
        newStop = currentPrice - trailDistance;
        if (newStop > position.stopLoss) {
          const oldStop = position.stopLoss;
          position.stopLoss = newStop;
          if (shouldLog) {
            console.log(`[ATM Trail] ${position.symbol} LONG: SL moved ${oldStop.toFixed(6)} → ${newStop.toFixed(6)} (price: ${currentPrice.toFixed(6)}, P&L: ${pnlPercent.toFixed(2)}%)`);
            activeManagerLogTimes.set(position.id, now);
          }
        }
      } else {
        newStop = currentPrice + trailDistance;
        if (newStop < position.stopLoss) {
          const oldStop = position.stopLoss;
          position.stopLoss = newStop;
          if (shouldLog) {
            console.log(`[ATM Trail] ${position.symbol} SHORT: SL moved ${oldStop.toFixed(6)} → ${newStop.toFixed(6)} (price: ${currentPrice.toFixed(6)}, P&L: ${pnlPercent.toFixed(2)}%)`);
            activeManagerLogTimes.set(position.id, now);
          }
        }
      }
    }

    // --- 2. MINIMUM PROFIT ENFORCEMENT ---
    // If first TP level is about to trigger, ensure the profit is meaningful
    if (position.takeProfitLevels && position.takeProfitLevels.length > 0) {
      const tp1 = position.takeProfitLevels[0];
      if (!tp1.triggered) {
        const minProfitDistance = entryPrice * (MIN_PROFIT_FLOOR_PERCENT / 100);
        const currentTP1Distance = isLong
          ? tp1.price - entryPrice
          : entryPrice - tp1.price;

        if (currentTP1Distance < minProfitDistance) {
          const newTP1 = isLong
            ? entryPrice + minProfitDistance
            : entryPrice - minProfitDistance;
          position.takeProfitLevels[0] = { ...tp1, price: newTP1 };
          if (shouldLog) {
            console.log(`[ATM MinProfit] ${position.symbol}: TP1 enforced minimum ${newTP1.toFixed(6)} (was ${tp1.price.toFixed(6)}, floor: ${MIN_PROFIT_FLOOR_PERCENT}%)`);
            activeManagerLogTimes.set(position.id, now);
          }
        }
      }
    }

    // --- 4. PORTFOLIO-AWARE STOP TIGHTENING ---
    // When Portfolio Metric is negative and position is underwater, tighten the stop
    if (isPortfolioStressed && pnlPercent < -0.1) {
      const originalStopDistance = Math.abs(entryPrice - position.stopLoss);
      const tightenedDistance = originalStopDistance * PORTFOLIO_STRESS_STOP_TIGHTEN;
      let tightenedStop: number;

      if (isLong) {
        tightenedStop = entryPrice - tightenedDistance;
        if (tightenedStop > position.stopLoss) {
          const oldStop = position.stopLoss;
          position.stopLoss = tightenedStop;
          if (shouldLog) {
            console.log(`[ATM Stress] ${position.symbol}: Tightened SL ${oldStop.toFixed(6)} → ${tightenedStop.toFixed(6)} (portfolio metric: ${portfolioMetricValue.toFixed(2)}, P&L: ${pnlPercent.toFixed(2)}%)`);
            activeManagerLogTimes.set(position.id, now);
          }
        }
      } else {
        tightenedStop = entryPrice + tightenedDistance;
        if (tightenedStop < position.stopLoss) {
          const oldStop = position.stopLoss;
          position.stopLoss = tightenedStop;
          if (shouldLog) {
            console.log(`[ATM Stress] ${position.symbol}: Tightened SL ${oldStop.toFixed(6)} → ${tightenedStop.toFixed(6)} (portfolio metric: ${portfolioMetricValue.toFixed(2)}, P&L: ${pnlPercent.toFixed(2)}%)`);
            activeManagerLogTimes.set(position.id, now);
          }
        }
      }
    }

    // --- 5. TIME DECAY EXIT ---
    // Close positions that have been open too long without meaningful movement
    if (hoursOpen >= STALE_POSITION_HOURS) {
      const driftFromEntry = Math.abs(pnlPercent);
      if (driftFromEntry < STALE_POSITION_DRIFT_PERCENT) {
        console.log(`[ATM TimeDecay] ${position.symbol}: Queuing stale close (${hoursOpen.toFixed(1)}h open, P&L: ${pnlPercent.toFixed(2)}%, drift: ${driftFromEntry.toFixed(2)}%)`);
        positionsToClose.push({
          id: position.id,
          price: currentPrice,
          reason: `ATM Time Decay - ${hoursOpen.toFixed(0)}h stale, P&L: ${pnlPercent.toFixed(2)}%`
        });
        return; // Don't process further
      }
    }

    // --- 6. AGGRESSIVE PROFIT PROTECTION when portfolio is stressed ---
    // If portfolio metric is very negative and position has ANY profit, lock it in with tight trail
    if (isPortfolioStressed && portfolioMetricValue < -10 && pnlPercent > 0.05) {
      const tightTrailDistance = currentPrice * 0.002; // Very tight 0.2% trail
      let profitProtectionStop: number;

      if (isLong) {
        profitProtectionStop = currentPrice - tightTrailDistance;
        if (profitProtectionStop > position.stopLoss) {
          position.stopLoss = profitProtectionStop;
          if (shouldLog) {
            console.log(`[ATM ProfitGuard] ${position.symbol}: Tight trail @ ${profitProtectionStop.toFixed(6)} (metric: ${portfolioMetricValue.toFixed(1)}, P&L: +${pnlPercent.toFixed(2)}%)`);
            activeManagerLogTimes.set(position.id, now);
          }
        }
      } else {
        profitProtectionStop = currentPrice + tightTrailDistance;
        if (profitProtectionStop < position.stopLoss) {
          position.stopLoss = profitProtectionStop;
          if (shouldLog) {
            console.log(`[ATM ProfitGuard] ${position.symbol}: Tight trail @ ${profitProtectionStop.toFixed(6)} (metric: ${portfolioMetricValue.toFixed(1)}, P&L: +${pnlPercent.toFixed(2)}%)`);
            activeManagerLogTimes.set(position.id, now);
          }
        }
      }
    }
  });

  if (positionsToClose.length > 1) {
    _batchEquityMode = true;
  }
  for (const { id, price, reason } of positionsToClose) {
    await closePosition(id, price, "closed", reason);
  }
  if (positionsToClose.length > 1) {
    _batchEquityMode = false;
    recordEquityEvent(0, 'close', `batch-close(${positionsToClose.length})`);
  }
}

// Check if symbol is on cooldown (prevents machine-gun re-entry)
// Uses FILE-BASED LOCK for reliability across async operations and restarts
export function isSymbolOnCooldown(symbol: string): { onCooldown: boolean; remainingMs: number } {
  const expiresAt = getSymbolCooldownTime(symbol);
  if (!expiresAt) {
    return { onCooldown: false, remainingMs: 0 };
  }
  
  const now = Date.now();
  const remaining = expiresAt - now;
  
  if (remaining > 0) {
    return { onCooldown: true, remainingMs: remaining };
  }
  
  // Cooldown expired, clean up
  clearSymbolCooldown(symbol);
  return { onCooldown: false, remainingMs: 0 };
}

// Note: setSymbolCooldown and clearSymbolCooldown are now file-based functions defined at top of file

export function canOpenPosition(signal: AITradeSignal): { allowed: boolean; reason?: string } {
  const portfolio = getPortfolioState();
  
  // DUPLICATE DIRECTION PREVENTION: Only 1 direction per symbol (no long+short same symbol)
  const existingOpposite = tradingState.positions.find(
    p => p.symbol.toUpperCase() === signal.symbol.toUpperCase() && p.side !== signal.side
  );
  if (existingOpposite) {
    console.log(`[DIRECTION BLOCK] ${signal.symbol}: Already have open ${existingOpposite.side} position. Cannot open opposite side.`);
    return { allowed: false, reason: `Already have open ${existingOpposite.side} position on ${signal.symbol}` };
  }
  
  // Check minimum profit target (must be >= 0.8% to cover fees)
  // CRITICAL: This gate MUST run to prevent taking crumb trades that lose money to fees
  if (signal.takeProfit && signal.targetEntry) {
    const targetDistance = Math.abs(signal.takeProfit - signal.targetEntry) / signal.targetEntry * 100;
    if (targetDistance < MIN_PROFIT_TARGET_PERCENT) {
      console.log(`[0.8% GATE] REJECTED ${signal.symbol}: Target ${targetDistance.toFixed(3)}% < ${MIN_PROFIT_TARGET_PERCENT}% min`);
      return { allowed: false, reason: `Target ${targetDistance.toFixed(2)}% < ${MIN_PROFIT_TARGET_PERCENT}% min (fees would eat profit)` };
    }
    console.log(`[0.8% GATE] PASSED ${signal.symbol}: Target ${targetDistance.toFixed(3)}% >= ${MIN_PROFIT_TARGET_PERCENT}%`);
  } else {
    // If no TP or entry, log warning and reject - we need TP to calculate target distance
    console.log(`[0.8% GATE] REJECTED ${signal.symbol}: Missing takeProfit or targetEntry - cannot validate profitability`);
    return { allowed: false, reason: `Missing takeProfit or targetEntry - cannot validate profitability gate` };
  }
  
  if (portfolio.currentDrawdown >= MAX_DRAWDOWN_PERCENT * 100) {
    return { allowed: false, reason: "Maximum drawdown reached (25%)" };
  }
  
  const positionValue = signal.positionSize;
  if (positionValue > portfolio.equity * MAX_POSITION_PERCENT) {
    return { allowed: false, reason: `Position exceeds 5% max (${((positionValue / portfolio.equity) * 100).toFixed(1)}%)` };
  }
  
  const currentCryptoExposure = tradingState.positions
    .filter(p => p.symbol === signal.symbol)
    .reduce((sum, p) => sum + p.marginUsed, 0);
  
  if (currentCryptoExposure + positionValue > portfolio.equity * MAX_CRYPTO_EXPOSURE) {
    return { allowed: false, reason: `Would exceed 25% max exposure for ${signal.symbol}` };
  }
  
  if (positionValue > portfolio.availableMargin) {
    return { allowed: false, reason: "Insufficient margin available" };
  }
  
  return { allowed: true };
}

export async function openPosition(signal: AITradeSignal, bootstrapOverride: boolean = false): Promise<Position | null> {
  // Detect scale-in: does this symbol already have a position in the same direction?
  const isScaleInTrade = signal.side && tradingState.positions.some(
    p => p.symbol.toUpperCase() === signal.symbol.toUpperCase() && p.side === signal.side
  );

  // COOLDOWN: Skip for scale-in layers (they are intentional adds, not machine-gun bugs)
  if (!isScaleInTrade) {
    const existingCooldown = isSymbolOnCooldown(signal.symbol);
    if (existingCooldown.onCooldown) {
      const remainingSec = Math.ceil(existingCooldown.remainingMs / 1000);
      console.log(`[COOLDOWN BLOCK] ${signal.symbol}: Rejected - ${remainingSec}s remaining (machine-gun prevention)`);
      return null;
    }
  }
  
  // STRICT TOP 15 ENFORCEMENT: Reject trades on symbols not in current dynamic top 15
  if (!isSymbolInTop15(signal.symbol)) {
    console.log(`[TOP 15 REJECT] ${signal.symbol}: Not in current top 15 by volume. Trade blocked.`);
    return null;
  }
  
  // CORRELATION GUARD: Max 3 unique symbols in same direction (scale-in layers don't count as separate)
  if (signal.side) {
    const currentPortfolio = getPortfolioState();
    const uniqueSymbols = new Set(
      currentPortfolio.positions.filter(p => p.side === signal.side).map(p => p.symbol.toUpperCase())
    );
    if (!isScaleInTrade && uniqueSymbols.size >= 3) {
      console.log(`[CORRELATION GUARD] ${signal.symbol} ${signal.side}: Blocked - already ${uniqueSymbols.size} unique ${signal.side} symbols open (max 3)`);
      return null;
    }
  }
  
  // Set cooldown IMMEDIATELY - before any async operations or checks
  // For scale-in, use a short 30-second cooldown instead of 5 minutes
  setSymbolCooldown(signal.symbol, isScaleInTrade ? 25000 : TRADE_COOLDOWN_MS);
  console.log(`[COOLDOWN SET] ${signal.symbol}: ${isScaleInTrade ? 'Scale-in 25s' : '5min'} cooldown activated`);
  
  const check = canOpenPosition(signal);
  if (!check.allowed) {
    console.log(`Cannot open position: ${check.reason}`);
    clearSymbolCooldown(signal.symbol);
    console.log(`[COOLDOWN CLEAR] ${signal.symbol}: Cleared due to validation failure`);
    return null;
  }
  
  
  const executedPrice = signal.targetEntry;

  // BASKET SIGNAL: Enforce 3× ATR stop and 4.5× ATR take-profit using raw ATR stored in signal
  if (signal.signalMode === 'basket' && signal.signals && (signal.signals as any).atr) {
    const rawATR = (signal.signals as any).atr as number;
    if (signal.side === 'long') {
      signal.stopLoss = executedPrice - rawATR * 3;
      signal.takeProfit = executedPrice + rawATR * 4.5;
    } else {
      signal.stopLoss = executedPrice + rawATR * 3;
      signal.takeProfit = executedPrice - rawATR * 4.5;
    }
    const slPct = (rawATR * 3 / executedPrice * 100).toFixed(2);
    const tpPct = (rawATR * 4.5 / executedPrice * 100).toFixed(2);
    console.log(`[Basket SL/TP] ${signal.symbol} ${signal.side}: ATR=$${rawATR.toFixed(6)} → SL=${slPct}% away, TP=${tpPct}% away`);
  }

  let scaledPositionSize = signal.positionSize;
  console.log(`[Basket Alloc] ${signal.symbol} ${signal.side}: $${scaledPositionSize.toFixed(2)}`);
  
  const MIN_SCALEOUT_LOTS = 3;
  const minScaleoutQuantity = BROKER.minLotSize * MIN_SCALEOUT_LOTS;
  
  // Calculate quantity from scaled position size in dollars
  let quantity = scaledPositionSize / executedPrice;
  quantity = roundToLotSize(quantity);
  
  // For scale-out (profit ladder) to work, we need at least 3x minimum lot size
  // This allows 70% close (2 units) + 30% runner (1 unit)
  
  // Ensure minimum quantity for scale-out
  if (quantity < minScaleoutQuantity) {
    quantity = minScaleoutQuantity;
    console.log(`[Position Size] Bumped to ${MIN_SCALEOUT_LOTS}x min lot (${minScaleoutQuantity}) for scale-out capability`);
  }
  
  // Calculate actual notional value after lot rounding
  let notionalValue = quantity * executedPrice;
  
  // Round up to minimum notional value if below broker requirement
  if (notionalValue < MIN_NOTIONAL_VALUE) {
    const requiredQuantity = MIN_NOTIONAL_VALUE / executedPrice;
    quantity = Math.ceil(requiredQuantity / BROKER.minLotSize) * BROKER.minLotSize;
    const newNotional = quantity * executedPrice;
    console.log(`[MIN NOTIONAL] ROUNDED UP ${signal.symbol}: $${notionalValue.toFixed(2)} -> $${newNotional.toFixed(2)} (qty ${quantity})`);
    notionalValue = newNotional;
  } else {
    console.log(`[MIN NOTIONAL] PASSED ${signal.symbol}: $${notionalValue.toFixed(2)} >= $${MIN_NOTIONAL_VALUE}`);
  }
  
  // Get current portfolio state for validation
  const portfolio = getPortfolioState();
  
  // Strict validation: reject if actual position exceeds max position size
  if (notionalValue > portfolio.equity * MAX_POSITION_PERCENT) {
    console.log(`Position value $${notionalValue.toFixed(2)} exceeds max ${(MAX_POSITION_PERCENT * 100).toFixed(0)}% of equity`);
    clearSymbolCooldown(signal.symbol);
    console.log(`[COOLDOWN CLEAR] ${signal.symbol}: Cleared due to max position size`);
    return null;
  }
  
  // Reject if not enough available margin
  if (notionalValue > portfolio.availableMargin) {
    console.log(`Position value $${notionalValue.toFixed(2)} exceeds available margin $${portfolio.availableMargin.toFixed(2)}`);
    clearSymbolCooldown(signal.symbol);
    console.log(`[COOLDOWN CLEAR] ${signal.symbol}: Cleared due to insufficient margin`);
    return null;
  }
  
  // Check max crypto exposure (20%) - must use actual notional after rounding
  const currentCryptoExposure = tradingState.positions
    .filter(p => p.symbol === signal.symbol)
    .reduce((sum, p) => sum + p.marginUsed, 0);
  
  if (currentCryptoExposure + notionalValue > portfolio.equity * MAX_CRYPTO_EXPOSURE) {
    console.log(`Would exceed 25% max exposure for ${signal.symbol} (current: $${currentCryptoExposure.toFixed(2)}, adding: $${notionalValue.toFixed(2)})`);
    clearSymbolCooldown(signal.symbol);
    console.log(`[COOLDOWN CLEAR] ${signal.symbol}: Cleared due to max crypto exposure`);
    return null;
  }
  
  const fees = isHLMode() ? 0 : calculateFees(notionalValue, "limit");
  const marginUsed = notionalValue;
  
  // Calculate scale-out take profit levels if we have ATR info
  // For now, use signal.takeProfit as TP1 reference and calculate TP2, TP3
  let takeProfitLevels: Position['takeProfitLevels'] = undefined;
  if (signal.takeProfit && signal.stopLoss) {
    const stopDistance = Math.abs(executedPrice - signal.stopLoss);
    const estimatedATR = stopDistance; // Stop = 1.0 ATR (risk unit)
    const tpDistance = Math.abs(signal.takeProfit - executedPrice);
    const estimatedVolatility = tpDistance / executedPrice;
    
    // Use the imported function for scale-out take profit calculation
    takeProfitLevels = calculateScaleOutTakeProfits(
      executedPrice,
      estimatedATR,
      estimatedVolatility,
      signal.side!
    );
  }
  
  const position: Position = {
    id: uuidv4(),
    symbol: signal.symbol,
    coinName: signal.coinName,
    side: signal.side!,
    quantity,
    initialQuantity: quantity, // Track original size for scale-out calculations
    entryPrice: executedPrice,
    currentPrice: executedPrice,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    takeProfitLevels, // Scale-out TP levels
    unrealizedPnl: 0,  // Start at 0, fees already deducted from balance
    unrealizedPnlPercent: 0,
    marginUsed,
    leverage: 1,
    openedAt: new Date().toISOString(),
    aiReasoning: signal.reasoning,
    ...(signal.pairId ? { pairId: signal.pairId } : {}),
  };
  
  const trade: TradeRecord = {
    id: position.id,
    symbol: signal.symbol,
    coinName: signal.coinName,
    side: signal.side!,
    orderType: "limit",
    quantity,
    entryPrice: executedPrice,
    exitPrice: null,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    pnl: null,
    pnlPercent: null,
    fees,
    entryFees: fees,
    slippage: 0,
    status: "open",
    openedAt: position.openedAt,
    closedAt: null,
    aiReasoning: signal.reasoning,
    signalMode: signal.signalMode,
    openReason: signal.openReason || `${signal.signalMode || 'unknown'} | ${signal.side?.toUpperCase()} ${signal.symbol}`,
    signals: signal.signals,
  };
  
  if (isHLMode()) {
    tradingStateLocked = true;
    signal.targetEntry = executedPrice;
    try {
      const result = await hlOpenPosition(signal);
      if (!result.success) {
        console.error(`[HL] Order FAILED for ${signal.symbol}: ${result.error} — aborting internal position`);
        clearSymbolCooldown(signal.symbol);
        tradingStateLocked = false;
        return null;
      }
      if (result.fillPrice && result.fillPrice > 0) {
        const fillPrice = result.fillPrice;
        const oldEntry = position.entryPrice;
        position.entryPrice = fillPrice;
        position.currentPrice = fillPrice;
        trade.entryPrice = fillPrice;
        const newNotional = quantity * fillPrice;
        trade.fees = 0;
        trade.entryFees = 0;
        position.marginUsed = newNotional;
        if (signal.stopLoss && oldEntry > 0) {
          const slDistance = Math.abs(oldEntry - signal.stopLoss);
          const slRatio = slDistance / oldEntry;
          position.stopLoss = signal.side === 'long' ? fillPrice * (1 - slRatio) : fillPrice * (1 + slRatio);
          trade.stopLoss = position.stopLoss;
        }
        if (signal.takeProfit && oldEntry > 0) {
          const tpDistance = Math.abs(signal.takeProfit - oldEntry);
          const tpRatio = tpDistance / oldEntry;
          position.takeProfit = signal.side === 'long' ? fillPrice * (1 + tpRatio) : fillPrice * (1 - tpRatio);
          trade.takeProfit = position.takeProfit;
        }
        if (position.takeProfitLevels && oldEntry > 0) {
          position.takeProfitLevels = position.takeProfitLevels.map(level => {
            const lvlDistance = Math.abs(level.price - oldEntry);
            const lvlRatio = lvlDistance / oldEntry;
            const newPrice = signal.side === 'long' ? fillPrice * (1 + lvlRatio) : fillPrice * (1 - lvlRatio);
            return { ...level, price: newPrice };
          });
        }
      }
      console.log(`[HL] Order placed for ${signal.symbol}: orderId=${result.orderId}, fill=${result.fillPrice || 'pending'}`);

      const { getOpenPositions } = await import("./hyperliquid/infoClient");
      const { SYMBOL_TO_HL, HL_TO_SYMBOL } = await import("./hyperliquid/config");
      const hlPositions = await getOpenPositions();
      const hlCoin = SYMBOL_TO_HL[signal.symbol] || signal.symbol;
      const hlPos = hlPositions.find(p => p.coin === hlCoin);

      if (hlPos) {
        const existingIdx = tradingState.positions.findIndex(p => p.symbol.toUpperCase() === signal.symbol.toUpperCase() && p.side === hlPos.side);
        if (existingIdx >= 0) {
          const existing = tradingState.positions[existingIdx];
          existing.quantity = hlPos.size;
          existing.initialQuantity = hlPos.size;
          existing.entryPrice = hlPos.entryPrice;
          existing.currentPrice = hlPos.markPrice;
          existing.unrealizedPnl = hlPos.unrealizedPnl;
          existing.unrealizedPnlPercent = hlPos.returnOnEquity * 100;
          existing.marginUsed = hlPos.marginUsed;
          savePosition(existing).catch(e => console.error('[DB] Update position error:', e));
          console.log(`[HL SYNC] Updated existing ${signal.symbol} position from HL: size=${hlPos.size}, entry=$${hlPos.entryPrice.toFixed(4)}`);
        } else {
          position.quantity = hlPos.size;
          position.initialQuantity = hlPos.size;
          position.entryPrice = hlPos.entryPrice;
          position.currentPrice = hlPos.markPrice;
          position.unrealizedPnl = hlPos.unrealizedPnl;
          position.unrealizedPnlPercent = hlPos.returnOnEquity * 100;
          position.marginUsed = hlPos.marginUsed;
          tradingState.positions.push(position);
          savePosition(position).catch(e => console.error('[DB] Save position error:', e));
        }
      } else {
        tradingState.positions.push(position);
        savePosition(position).catch(e => console.error('[DB] Save position error:', e));
        console.warn(`[HL SYNC] Could not find HL position for ${signal.symbol} after order — using signal data`);
      }

      tradingState.trades.push(trade);
      saveTrade(trade).catch(e => console.error('[DB] Save trade error:', e));
      persistPortfolioState();
      recordEquityEvent(0, 'open', signal.symbol);
      tradingStateLocked = false;

      const stopPercent = Math.abs(signal.stopLoss - position.entryPrice) / position.entryPrice * 100;
      const regimeTag = signal.signals?.regime ? ` in ${signal.signals.regime} regime (${signal.signals.regimeMultiplier?.toFixed(2) || '?'}x)` : '';
      console.log(`[TRADE] Opened ${signal.side?.toUpperCase()} ${signal.symbol}${regimeTag}:`);
      console.log(`  Entry: $${position.entryPrice.toFixed(2)} | Qty: ${position.quantity.toFixed(6)} | Value: $${(position.quantity * position.entryPrice).toFixed(2)}`);
      console.log(`  Stop: $${(position.stopLoss || 0).toFixed(2)} (${stopPercent.toFixed(2)}% away) | TP: $${position.takeProfit?.toFixed(2) || 'N/A'}`);

      return position;
    } catch (e) {
      console.error(`[HL] Order error for ${signal.symbol}: ${e} — aborting internal position`);
      clearSymbolCooldown(signal.symbol);
      tradingStateLocked = false;
      return null;
    }
  }

  tradingState.balance -= fees;
  tradingState.positions.push(position);
  tradingState.trades.push(trade);
  
  recordEquityEvent(0, 'open', signal.symbol);
  
  tradingStateLocked = false;
  
  if (!signal.pairId) {
    saveTrade(trade).catch(e => console.error('[DB] Save trade error:', e));
    savePosition(position).catch(e => console.error('[DB] Save position error:', e));
    persistPortfolioState();
  }
  
  const stopPercent = Math.abs(signal.stopLoss - executedPrice) / executedPrice * 100;
  const regimeTag = signal.signals?.regime ? ` in ${signal.signals.regime} regime (${signal.signals.regimeMultiplier?.toFixed(2) || '?'}x)` : '';
  console.log(`[TRADE] Opened ${signal.side?.toUpperCase()} ${signal.symbol}${regimeTag}:`);
  console.log(`  Entry: $${executedPrice.toFixed(2)} | Qty: ${quantity.toFixed(6)} | Value: $${notionalValue.toFixed(2)}`);
  console.log(`  Stop: $${signal.stopLoss.toFixed(2)} (${stopPercent.toFixed(2)}% away) | TP: $${signal.takeProfit?.toFixed(2) || 'N/A'}`);
  console.log(`  Signal posSize: $${signal.positionSize.toFixed(2)} | Margin: $${marginUsed.toFixed(2)}`);
  
  return position;
}

export function persistPairPositions(pairId: string): void {
  const pairPositions = tradingState.positions.filter(p => p.pairId === pairId);
  const pairTrades = tradingState.trades.filter(t => t.id && pairPositions.some(p => p.id === t.id) && t.status === 'open');
  
  if (pairPositions.length !== 2 || pairTrades.length !== 2) {
    console.error(`[DB PAIR] ABORT persist for ${pairId}: expected 2 positions + 2 trades, got ${pairPositions.length} positions + ${pairTrades.length} trades`);
    return;
  }
  
  for (const pos of pairPositions) {
    savePosition(pos).catch(e => console.error(`[DB] Save pair position ${pos.id} error:`, e));
  }
  for (const trade of pairTrades) {
    saveTrade(trade).catch(e => console.error(`[DB] Save pair trade ${trade.id} error:`, e));
  }
  persistPortfolioState();
  console.log(`[DB PAIR] Persisted ${pairPositions.length} positions + ${pairTrades.length} trades for pair ${pairId}`);
}

export async function closePosition(positionId: string, exitPrice: number, status: "closed" | "stopped_out" = "closed", closeReason?: string): Promise<TradeRecord | null> {
  const positionIndex = tradingState.positions.findIndex(p => p.id === positionId);
  if (positionIndex === -1) return null;
  
  const position = tradingState.positions[positionIndex];
  
  const isStopOut = status === "stopped_out";
  let executedPrice = exitPrice;
  let fees = 0;

  tradingStateLocked = true;
  if (isHLMode()) {
    const reason = closeReason || (isStopOut ? 'Stop Loss' : 'Take Profit');
    try {
      const result = await hlClosePosition(position.symbol, exitPrice, position.side, reason);
      if (result.success) {
        if (result.fillPrice && result.fillPrice > 0) {
          executedPrice = result.fillPrice;
        }
        console.log(`[HL] Closed ${position.symbol} ${position.side}: fill=$${executedPrice.toFixed(4)}`);

        const { getOpenPositions } = await import("./hyperliquid/infoClient");
        const { SYMBOL_TO_HL } = await import("./hyperliquid/config");
        const hlPositions = await getOpenPositions();
        const hlCoin = SYMBOL_TO_HL[position.symbol.toUpperCase()] || position.symbol.toUpperCase();
        const stillOpen = hlPositions.find(p => p.coin === hlCoin);
        if (stillOpen) {
          console.warn(`[HL VERIFY] ${position.symbol} still open on HL after close (size=${stillOpen.size}) — sync will correct`);
        }
      } else {
        console.error(`[HL MISMATCH] Close FAILED for ${position.symbol}: ${result.error} — proceeding with internal close`);
      }
    } catch (e) {
      console.error(`[HL MISMATCH] Close error for ${position.symbol}: ${e} — proceeding with internal close`);
    }
  } else {
    const orderType: OrderType = isStopOut ? "market" : "limit";
    const slippage = isStopOut 
      ? calculateSlippage(exitPrice, position.side === "long" ? "short" : "long", "market")
      : 0;
    executedPrice = exitPrice + slippage;
    const notionalValue = position.quantity * executedPrice;
    fees = calculateFees(notionalValue, orderType);
  }
  
  let pnl: number;
  if (position.side === "long") {
    pnl = (executedPrice - position.entryPrice) * position.quantity;
  } else {
    pnl = (position.entryPrice - executedPrice) * position.quantity;
  }
  pnl -= fees;
  
  const remainingMargin = position.quantity * position.entryPrice;
  const pnlPercent = remainingMargin > 0 ? (pnl / remainingMargin) * 100 : 0;
  
  tradingState.balance += pnl;
  
  const freshIndex = tradingState.positions.findIndex(p => p.id === positionId);
  if (freshIndex === -1) {
    tradingStateLocked = false;
    return null;
  }
  tradingState.positions.splice(freshIndex, 1);
  tradingStateLocked = false;
  
  const tradeIndex = tradingState.trades.findIndex(t => t.id === positionId);
  let totalPnl = pnl;
  let totalPnlPercent = pnlPercent;
  
  if (tradeIndex !== -1) {
    const trade = tradingState.trades[tradeIndex];
    const accumulatedPnl = trade.pnl || 0;
    const grossPnl = accumulatedPnl + pnl;
    
    const entryFees = trade.entryFees || 0;
    totalPnl = grossPnl - entryFees;
    
    const originalMargin = trade.quantity * trade.entryPrice;
    totalPnlPercent = originalMargin > 0 ? (totalPnl / originalMargin) * 100 : 0;
    
    const finalCloseReason = closeReason || (isStopOut ? 'Stop Loss Hit' : 'Take Profit / Manual Close');
    tradingState.trades[tradeIndex] = {
      ...trade,
      exitPrice: executedPrice,
      pnl: totalPnl,
      pnlPercent: totalPnlPercent,
      fees: trade.fees + fees,
      slippage: trade.slippage || 0,
      status,
      closeReason: finalCloseReason,
      closedAt: new Date().toISOString(),
    };
  }
  
  console.log(`Closed position: ${position.symbol} @ $${executedPrice.toFixed(2)}, Final PnL: $${totalPnl.toFixed(4)} (${totalPnlPercent.toFixed(2)}%)`);
  
  recordEquityEvent(0, isStopOut ? 'stop' : 'close', position.symbol, totalPnl);
  
  const tradeToSave = tradingState.trades[tradeIndex];
  if (tradeToSave) {
    saveTrade(tradeToSave).catch(e => console.error('[DB] Save closed trade error:', e));
  }
  removePosition(positionId).catch(e => console.error('[DB] Remove position error:', e));
  persistPortfolioState();
  
  const chunkMargin = position.quantity * position.entryPrice;
  const chunkPnlPercent = chunkMargin > 0 ? (pnl / chunkMargin) * 100 : 0;
  
  // Record trade result for strategy performance (use chunk pnlPercent - each close is a datapoint)
  recordTradeResult(chunkPnlPercent);
  
  // Update rolling metrics for Sharpe/Ulcer calculation (use chunk pnlPercent)
  const currentEquity = tradingState.balance + tradingState.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  updateRollingMetrics(chunkPnlPercent, currentEquity);
  
  updateDrawdownProtection();
  const portfolioData = { equity: currentEquity, openPositions: tradingState.positions.length };
  savePortfolioMetricSnapshot("trade_close", portfolioData).catch(e => console.error('[Portfolio Metric] Snapshot on trade close error:', e));
  
  // Record learning sample for AI adaptation
  const closedTrade = tradingState.trades[tradeIndex];
  if (closedTrade) {
    const durationMs = closedTrade.closedAt && closedTrade.openedAt 
      ? new Date(closedTrade.closedAt).getTime() - new Date(closedTrade.openedAt).getTime()
      : 0;
    
    const signalMode = extractSignalMode(closedTrade);
    
    // Use TOTAL values for learning sample (whole trade performance)
    recordLearningSample({
      pnlPercent: totalPnlPercent, // Use total trade pnlPercent
      isWin: totalPnl > 0,         // Use total trade pnl for win/loss
      side: position.side,
      symbol: position.symbol,
      durationMs,
      indicators: extractIndicatorFlags(closedTrade),
      entryGates: extractEntryGates(closedTrade),
      signalMode,
    });
    
    // Track mode performance for adaptive switching (use chunk pnlPercent for rolling metrics)
    if (signalMode) {
      recordModePerformance(signalMode, chunkPnlPercent, currentEquity);
    }
  }
  
  // Set cooldown for this symbol to prevent machine-gun re-entry
  // STOP-OUTS get a LONGER 30-minute cooldown to prevent chasing losing trades
  // Normal closes (take-profit) get the standard 5-minute cooldown
  const cooldownDuration = isStopOut ? STOP_OUT_COOLDOWN_MS : TRADE_COOLDOWN_MS;
  setSymbolCooldown(position.symbol, cooldownDuration);
  console.log(`[CLOSE COOLDOWN] ${position.symbol}: ${isStopOut ? '30min (stop-out)' : '5min (take-profit)'} cooldown set`);
  
  return closedTrade || null;
}

export async function closePositionsBySymbol(symbol: string, exitPrice: number, closeReason: string): Promise<TradeRecord[]> {
  const symbolUpper = symbol.toUpperCase();
  const positions = tradingState.positions.filter(p => p.symbol.toUpperCase() === symbolUpper);
  if (positions.length === 0) return [];

  const side = positions[0].side;
  let executedPrice = exitPrice;

  tradingStateLocked = true;
  if (isHLMode()) {
    try {
      const result = await hlClosePosition(symbolUpper, exitPrice, side, closeReason);
      if (result.success) {
        if (result.fillPrice && result.fillPrice > 0) {
          executedPrice = result.fillPrice;
        }
        console.log(`[HL] Closed ${symbolUpper} ${side}: fill=$${executedPrice.toFixed(4)}`);

        const { getOpenPositions } = await import("./hyperliquid/infoClient");
        const { SYMBOL_TO_HL } = await import("./hyperliquid/config");
        const hlPositions = await getOpenPositions();
        const hlCoin = SYMBOL_TO_HL[symbolUpper] || symbolUpper;
        const stillOpen = hlPositions.find(p => p.coin === hlCoin);
        if (stillOpen) {
          console.warn(`[HL VERIFY] ${symbolUpper} still open on HL after close (size=${stillOpen.size}) — sync will correct`);
        }
      } else {
        console.error(`[HL MISMATCH] Close FAILED for ${symbolUpper}: ${result.error} — proceeding with internal close`);
      }
    } catch (e) {
      console.error(`[HL MISMATCH] Close error for ${symbolUpper}: ${e} — proceeding with internal close`);
    }
  }
  tradingStateLocked = false;

  const closedTrades: TradeRecord[] = [];
  for (const pos of positions) {
    const trade = await closePositionInternal(pos.id, executedPrice, "closed", closeReason);
    if (trade) closedTrades.push(trade);
  }
  return closedTrades;
}

async function closePositionInternal(positionId: string, executedPrice: number, status: "closed" | "stopped_out", closeReason: string): Promise<TradeRecord | null> {
  const positionIndex = tradingState.positions.findIndex(p => p.id === positionId);
  if (positionIndex === -1) return null;

  const position = tradingState.positions[positionIndex];
  const isStopOut = status === "stopped_out";
  const fees = 0;

  let pnl: number;
  if (position.side === "long") {
    pnl = (executedPrice - position.entryPrice) * position.quantity;
  } else {
    pnl = (position.entryPrice - executedPrice) * position.quantity;
  }
  pnl -= fees;

  const remainingMargin = position.quantity * position.entryPrice;
  const pnlPercent = remainingMargin > 0 ? (pnl / remainingMargin) * 100 : 0;

  tradingState.balance += pnl;

  const freshIndex = tradingState.positions.findIndex(p => p.id === positionId);
  if (freshIndex === -1) return null;
  tradingState.positions.splice(freshIndex, 1);

  const tradeIndex = tradingState.trades.findIndex(t => t.id === positionId);
  let totalPnl = pnl;
  let totalPnlPercent = pnlPercent;

  if (tradeIndex !== -1) {
    const trade = tradingState.trades[tradeIndex];
    const accumulatedPnl = trade.pnl || 0;
    const grossPnl = accumulatedPnl + pnl;
    const entryFees = trade.entryFees || 0;
    totalPnl = grossPnl - entryFees;
    const originalMargin = trade.quantity * trade.entryPrice;
    totalPnlPercent = originalMargin > 0 ? (totalPnl / originalMargin) * 100 : 0;

    tradingState.trades[tradeIndex] = {
      ...trade,
      exitPrice: executedPrice,
      pnl: totalPnl,
      pnlPercent: totalPnlPercent,
      fees: trade.fees + fees,
      slippage: trade.slippage || 0,
      status,
      closeReason,
      closedAt: new Date().toISOString(),
    };
  }

  console.log(`  Layer ${position.symbol}: entry=$${position.entryPrice.toFixed(4)}, exit=$${executedPrice.toFixed(4)}, PnL: $${totalPnl.toFixed(4)} (${totalPnlPercent.toFixed(2)}%)`);

  recordEquityEvent(0, isStopOut ? 'stop' : 'close', position.symbol, totalPnl);

  const tradeToSave = tradingState.trades[tradeIndex];
  if (tradeToSave) {
    saveTrade(tradeToSave).catch(e => console.error('[DB] Save closed trade error:', e));
  }
  removePosition(positionId).catch(e => console.error('[DB] Remove position error:', e));
  persistPortfolioState();

  const chunkMargin = position.quantity * position.entryPrice;
  const chunkPnlPercent = chunkMargin > 0 ? (pnl / chunkMargin) * 100 : 0;
  recordTradeResult(chunkPnlPercent);
  const currentEquity = tradingState.balance + tradingState.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  updateRollingMetrics(chunkPnlPercent, currentEquity);
  updateDrawdownProtection();
  const portfolioData = { equity: currentEquity, openPositions: tradingState.positions.length };
  savePortfolioMetricSnapshot("trade_close", portfolioData).catch(e => console.error('[Portfolio Metric] Snapshot on trade close error:', e));

  const closedTrade = tradingState.trades[tradeIndex];
  if (closedTrade) {
    const durationMs = closedTrade.closedAt && closedTrade.openedAt
      ? new Date(closedTrade.closedAt).getTime() - new Date(closedTrade.openedAt).getTime()
      : 0;
    const signalMode = extractSignalMode(closedTrade);
    recordLearningSample({
      pnlPercent: totalPnlPercent,
      isWin: totalPnl > 0,
      side: position.side,
      symbol: position.symbol,
      durationMs,
      indicators: extractIndicatorFlags(closedTrade),
      entryGates: extractEntryGates(closedTrade),
      signalMode,
    });
    if (signalMode) {
      recordModePerformance(signalMode, chunkPnlPercent, currentEquity);
    }
  }

  setSymbolCooldown(position.symbol, TRADE_COOLDOWN_MS);

  return closedTrade || null;
}

export async function closeAllPositions(prices: Map<string, number>): Promise<void> {
  const positionIds = tradingState.positions.map(p => p.id);
  
  for (const id of positionIds) {
    const position = tradingState.positions.find(p => p.id === id);
    if (position) {
      const price = prices.get(position.symbol.toLowerCase()) || position.currentPrice;
      await closePosition(id, price, "closed", "Manual Close All Positions");
    }
  }
}

export function resetPortfolio(): void {
  tradingState = {
    balance: INITIAL_BALANCE,
    equity: INITIAL_BALANCE,
    positions: [],
    trades: [],
    peakEquity: INITIAL_BALANCE,
    maxDrawdown: 0,
    startedAt: new Date().toISOString(),
  };
}

export async function fullResetPortfolio(): Promise<void> {
  pendingReconciliation.length = 0;
  
  tradingState = {
    balance: INITIAL_BALANCE,
    equity: INITIAL_BALANCE,
    positions: [],
    trades: [],
    peakEquity: INITIAL_BALANCE,
    maxDrawdown: 0,
    startedAt: new Date().toISOString(),
  };
  
  equityCurve.length = 0;
  equityCurve.push({ timestamp: Date.now(), equity: INITIAL_BALANCE });
  
  cooldownCache.clear();
  
  rollingMetrics.returns.length = 0;
  rollingMetrics.equityHistory.length = 0;
  rollingMetrics.timestamps.length = 0;
  
  resetEquityCurveManager();
  
  await fullResetAllTradingData();
  
  persistPortfolioState();
  
  console.log(`[FULL RESET] All trading data wiped. Balance reset to $${INITIAL_BALANCE}. Fresh start.`);
}

export function getBrokerConfig(): BrokerConfig {
  return BROKER;
}
