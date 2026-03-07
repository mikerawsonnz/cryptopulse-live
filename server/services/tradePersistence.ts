import { db } from "../db";
import { paperTrades, paperPositions, paperPortfolioState, portfolioMetricSnapshots, mike1Snapshots, shadowTrades, shadowPositions, shadowEquityState, momentumHistory, allocationHistory, mtfShadowTrades, mtfMike1Snapshots, mtfAllocationDecisions, mtfAiInsights, mtfComboEquity } from "@shared/schema";
import { eq, ne, inArray } from "drizzle-orm";
import type { TradeRecord, Position } from "@shared/schema";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const SYNC_INTERVAL_MS = 60_000;

const failedTradeQueue: Map<string, TradeRecord> = new Map();
const failedPositionQueue: Map<string, { action: "save" | "remove"; position?: Position }> = new Map();
let syncIntervalHandle: ReturnType<typeof setInterval> | null = null;

async function withRetry<T>(label: string, fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt < retries) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[TradePersistence] ${label} attempt ${attempt}/${retries} failed: ${msg} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[TradePersistence] ${label} FAILED after ${retries} attempts: ${msg}`);
        throw error;
      }
    }
  }
  throw new Error("unreachable");
}

export async function saveTrade(trade: TradeRecord): Promise<void> {
  try {
    await withRetry(`saveTrade(${trade.id.slice(0, 8)})`, async () => {
      await db.insert(paperTrades).values({
        id: trade.id,
        symbol: trade.symbol,
        coinName: trade.coinName,
        side: trade.side,
        orderType: trade.orderType,
        quantity: trade.quantity,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        pnl: trade.pnl,
        pnlPercent: trade.pnlPercent,
        fees: trade.fees,
        entryFees: trade.entryFees,
        slippage: trade.slippage,
        status: trade.status,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        aiReasoning: trade.aiReasoning,
        signalMode: trade.signalMode,
        openReason: trade.openReason,
        closeReason: trade.closeReason,
        signals: trade.signals as Record<string, unknown> | undefined,
      }).onConflictDoUpdate({
        target: paperTrades.id,
        set: {
          exitPrice: trade.exitPrice,
          pnl: trade.pnl,
          pnlPercent: trade.pnlPercent,
          fees: trade.fees,
          status: trade.status,
          closedAt: trade.closedAt,
          closeReason: trade.closeReason,
        },
      });
    });
    failedTradeQueue.delete(trade.id);
  } catch (error) {
    failedTradeQueue.set(trade.id, trade);
    console.error(`[TradePersistence] Trade ${trade.id.slice(0, 8)} queued for retry (queue size: ${failedTradeQueue.size})`);
  }
}

export async function savePosition(position: Position): Promise<void> {
  try {
    await withRetry(`savePosition(${position.id.slice(0, 8)})`, async () => {
      await db.insert(paperPositions).values({
        id: position.id,
        symbol: position.symbol,
        coinName: position.coinName,
        side: position.side,
        quantity: position.quantity,
        initialQuantity: position.initialQuantity,
        entryPrice: position.entryPrice,
        currentPrice: position.currentPrice,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        takeProfitLevels: position.takeProfitLevels,
        unrealizedPnl: position.unrealizedPnl,
        unrealizedPnlPercent: position.unrealizedPnlPercent,
        marginUsed: position.marginUsed,
        leverage: position.leverage,
        openedAt: position.openedAt,
        aiReasoning: position.aiReasoning,
        lastOrderUpdate: position.lastOrderUpdate,
        pairId: position.pairId,
        status: "open",
      }).onConflictDoUpdate({
        target: paperPositions.id,
        set: {
          quantity: position.quantity,
          currentPrice: position.currentPrice,
          stopLoss: position.stopLoss,
          takeProfit: position.takeProfit,
          takeProfitLevels: position.takeProfitLevels,
          unrealizedPnl: position.unrealizedPnl,
          unrealizedPnlPercent: position.unrealizedPnlPercent,
          marginUsed: position.marginUsed,
          lastOrderUpdate: position.lastOrderUpdate,
        },
      });
    });
    failedPositionQueue.delete(position.id);
  } catch (error) {
    failedPositionQueue.set(position.id, { action: "save", position });
    console.error(`[TradePersistence] Position ${position.id.slice(0, 8)} queued for retry (queue size: ${failedPositionQueue.size})`);
  }
}

export async function removePosition(positionId: string): Promise<void> {
  try {
    await withRetry(`removePosition(${positionId.slice(0, 8)})`, async () => {
      await db.delete(paperPositions).where(eq(paperPositions.id, positionId));
    });
    failedPositionQueue.delete(positionId);
  } catch (error) {
    failedPositionQueue.set(positionId, { action: "remove" });
    console.error(`[TradePersistence] Position removal ${positionId.slice(0, 8)} queued for retry`);
  }
}

export async function savePortfolioState(state: {
  balance: number;
  equity: number;
  peakEquity: number;
  maxDrawdown: number;
  realizedPnl: number;
  initialBalance?: number;
  startedAt: string;
}): Promise<void> {
  try {
    await withRetry("savePortfolioState", async () => {
      const existing = await db.select().from(paperPortfolioState).limit(1);
      if (existing.length > 0) {
        const updateData: Record<string, unknown> = {
          balance: state.balance,
          equity: state.equity,
          peakEquity: state.peakEquity,
          maxDrawdown: state.maxDrawdown,
          realizedPnl: state.realizedPnl,
          startedAt: state.startedAt,
        };
        if (state.initialBalance !== undefined) {
          updateData.initialBalance = state.initialBalance;
        }
        await db.update(paperPortfolioState).set(updateData).where(eq(paperPortfolioState.id, existing[0].id));
      } else {
        await db.insert(paperPortfolioState).values(state);
      }
    });
  } catch (error) {
    console.error(`[TradePersistence] Portfolio state save FAILED after retries — CRITICAL`);
  }
}

export async function loadAllTrades(): Promise<TradeRecord[]> {
  try {
    const rows = await db.select().from(paperTrades);
    return rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      coinName: r.coinName,
      side: r.side as "long" | "short",
      orderType: r.orderType as "market" | "limit" | "stop" | "stop_limit",
      quantity: r.quantity,
      entryPrice: r.entryPrice,
      exitPrice: r.exitPrice,
      stopLoss: r.stopLoss,
      takeProfit: r.takeProfit,
      pnl: r.pnl,
      pnlPercent: r.pnlPercent,
      fees: r.fees,
      entryFees: r.entryFees,
      slippage: r.slippage,
      status: r.status as "open" | "closed" | "stopped_out",
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      aiReasoning: r.aiReasoning,
      signalMode: r.signalMode as TradeRecord["signalMode"],
      openReason: r.openReason ?? undefined,
      closeReason: r.closeReason ?? undefined,
      signals: r.signals as TradeRecord["signals"],
    }));
  } catch (error) {
    console.error("[TradePersistence] Error loading trades:", error);
    return [];
  }
}

export async function loadOpenPositions(): Promise<Position[]> {
  try {
    const rows = await db.select().from(paperPositions).where(eq(paperPositions.status, "open"));
    return rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      coinName: r.coinName,
      side: r.side as "long" | "short",
      quantity: r.quantity,
      initialQuantity: r.initialQuantity,
      entryPrice: r.entryPrice,
      currentPrice: r.currentPrice,
      stopLoss: r.stopLoss,
      takeProfit: r.takeProfit,
      takeProfitLevels: r.takeProfitLevels ?? undefined,
      unrealizedPnl: r.unrealizedPnl,
      unrealizedPnlPercent: r.unrealizedPnlPercent,
      marginUsed: r.marginUsed,
      leverage: r.leverage,
      openedAt: r.openedAt,
      aiReasoning: r.aiReasoning,
      lastOrderUpdate: r.lastOrderUpdate ?? undefined,
      pairId: r.pairId ?? undefined,
    }));
  } catch (error) {
    console.error("[TradePersistence] Error loading positions:", error);
    return [];
  }
}

export async function loadPortfolioState(): Promise<{
  balance: number;
  equity: number;
  peakEquity: number;
  maxDrawdown: number;
  realizedPnl: number;
  initialBalance: number | null;
  startedAt: string;
} | null> {
  try {
    const rows = await db.select().from(paperPortfolioState).limit(1);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      balance: r.balance,
      equity: r.equity,
      peakEquity: r.peakEquity,
      maxDrawdown: r.maxDrawdown,
      realizedPnl: r.realizedPnl,
      initialBalance: r.initialBalance,
      startedAt: r.startedAt,
    };
  } catch (error) {
    console.error("[TradePersistence] Error loading portfolio state:", error);
    return null;
  }
}

export async function cleanupClosedPositions(): Promise<number> {
  try {
    const result = await db.delete(paperPositions).where(ne(paperPositions.status, "open"));
    return 0;
  } catch (error) {
    console.error("[TradePersistence] Error cleaning up closed positions:", error);
    return 0;
  }
}

export async function fullResetAllTradingData(): Promise<void> {
  try {
    await db.delete(paperTrades);
    await db.delete(paperPositions);
    await db.delete(paperPortfolioState);
    await db.delete(portfolioMetricSnapshots);
    await db.delete(mike1Snapshots);
    await db.delete(shadowTrades);
    await db.delete(shadowPositions);
    await db.delete(shadowEquityState);
    await db.delete(momentumHistory);
    await db.delete(allocationHistory);
    await db.delete(mtfShadowTrades);
    await db.delete(mtfMike1Snapshots);
    await db.delete(mtfAllocationDecisions);
    await db.delete(mtfAiInsights);
    await db.delete(mtfComboEquity);
    console.log("[TradePersistence] Full reset complete - all trading data cleared from DB");
  } catch (error) {
    console.error("[TradePersistence] Error during full reset:", error);
    throw error;
  }
}

async function drainFailedQueues(): Promise<void> {
  if (failedTradeQueue.size === 0 && failedPositionQueue.size === 0) return;

  console.log(`[TradePersistence] Draining failed queues: ${failedTradeQueue.size} trades, ${failedPositionQueue.size} positions`);

  for (const [id, trade] of failedTradeQueue) {
    try {
      await withRetry(`drainTrade(${id.slice(0, 8)})`, async () => {
        await db.insert(paperTrades).values({
          id: trade.id,
          symbol: trade.symbol,
          coinName: trade.coinName,
          side: trade.side,
          orderType: trade.orderType,
          quantity: trade.quantity,
          entryPrice: trade.entryPrice,
          exitPrice: trade.exitPrice,
          stopLoss: trade.stopLoss,
          takeProfit: trade.takeProfit,
          pnl: trade.pnl,
          pnlPercent: trade.pnlPercent,
          fees: trade.fees,
          entryFees: trade.entryFees,
          slippage: trade.slippage,
          status: trade.status,
          openedAt: trade.openedAt,
          closedAt: trade.closedAt,
          aiReasoning: trade.aiReasoning,
          signalMode: trade.signalMode,
          openReason: trade.openReason,
          closeReason: trade.closeReason,
          signals: trade.signals as Record<string, unknown> | undefined,
        }).onConflictDoUpdate({
          target: paperTrades.id,
          set: {
            exitPrice: trade.exitPrice,
            pnl: trade.pnl,
            pnlPercent: trade.pnlPercent,
            fees: trade.fees,
            status: trade.status,
            closedAt: trade.closedAt,
            closeReason: trade.closeReason,
          },
        });
      }, 2);
      failedTradeQueue.delete(id);
    } catch {
    }
  }

  for (const [id, entry] of failedPositionQueue) {
    try {
      if (entry.action === "remove") {
        await withRetry(`drainRemovePos(${id.slice(0, 8)})`, async () => {
          await db.delete(paperPositions).where(eq(paperPositions.id, id));
        }, 2);
      } else if (entry.position) {
        await withRetry(`drainSavePos(${id.slice(0, 8)})`, async () => {
          await db.insert(paperPositions).values({
            id: entry.position!.id,
            symbol: entry.position!.symbol,
            coinName: entry.position!.coinName,
            side: entry.position!.side,
            quantity: entry.position!.quantity,
            initialQuantity: entry.position!.initialQuantity,
            entryPrice: entry.position!.entryPrice,
            currentPrice: entry.position!.currentPrice,
            stopLoss: entry.position!.stopLoss,
            takeProfit: entry.position!.takeProfit,
            takeProfitLevels: entry.position!.takeProfitLevels,
            unrealizedPnl: entry.position!.unrealizedPnl,
            unrealizedPnlPercent: entry.position!.unrealizedPnlPercent,
            marginUsed: entry.position!.marginUsed,
            leverage: entry.position!.leverage,
            openedAt: entry.position!.openedAt,
            aiReasoning: entry.position!.aiReasoning,
            lastOrderUpdate: entry.position!.lastOrderUpdate,
            pairId: entry.position!.pairId,
            status: "open",
          }).onConflictDoUpdate({
            target: paperPositions.id,
            set: {
              quantity: entry.position!.quantity,
              currentPrice: entry.position!.currentPrice,
              stopLoss: entry.position!.stopLoss,
              takeProfit: entry.position!.takeProfit,
              unrealizedPnl: entry.position!.unrealizedPnl,
              unrealizedPnlPercent: entry.position!.unrealizedPnlPercent,
              marginUsed: entry.position!.marginUsed,
            },
          });
        }, 2);
      }
      failedPositionQueue.delete(id);
    } catch {
    }
  }

  if (failedTradeQueue.size > 0 || failedPositionQueue.size > 0) {
    console.warn(`[TradePersistence] Queue drain incomplete: ${failedTradeQueue.size} trades, ${failedPositionQueue.size} positions still pending`);
  }
}

export async function syncTradesToDb(inMemoryTrades: TradeRecord[]): Promise<void> {
  if (inMemoryTrades.length === 0) return;

  try {
    const dbTradeIds = new Set<string>();
    const rows = await db.select({ id: paperTrades.id }).from(paperTrades);
    for (const r of rows) dbTradeIds.add(r.id);

    const missingTrades = inMemoryTrades.filter(t => !dbTradeIds.has(t.id));
    const staleUpdates = inMemoryTrades.filter(t => {
      if (!dbTradeIds.has(t.id)) return false;
      return t.status === "closed" || t.status === "stopped_out";
    });

    let savedCount = 0;
    let updatedCount = 0;

    for (const trade of missingTrades) {
      try {
        await db.insert(paperTrades).values({
          id: trade.id,
          symbol: trade.symbol,
          coinName: trade.coinName,
          side: trade.side,
          orderType: trade.orderType,
          quantity: trade.quantity,
          entryPrice: trade.entryPrice,
          exitPrice: trade.exitPrice,
          stopLoss: trade.stopLoss,
          takeProfit: trade.takeProfit,
          pnl: trade.pnl,
          pnlPercent: trade.pnlPercent,
          fees: trade.fees,
          entryFees: trade.entryFees,
          slippage: trade.slippage,
          status: trade.status,
          openedAt: trade.openedAt,
          closedAt: trade.closedAt,
          aiReasoning: trade.aiReasoning,
          signalMode: trade.signalMode,
          openReason: trade.openReason,
          closeReason: trade.closeReason,
          signals: trade.signals as Record<string, unknown> | undefined,
        }).onConflictDoNothing();
        savedCount++;
      } catch (e) {
        console.error(`[TradePersistence] Sync failed for trade ${trade.id.slice(0, 8)}:`, e instanceof Error ? e.message : e);
      }
    }

    for (const trade of staleUpdates) {
      try {
        await db.update(paperTrades).set({
          exitPrice: trade.exitPrice,
          pnl: trade.pnl,
          pnlPercent: trade.pnlPercent,
          fees: trade.fees,
          status: trade.status,
          closedAt: trade.closedAt,
          closeReason: trade.closeReason,
        }).where(eq(paperTrades.id, trade.id));
        updatedCount++;
      } catch (e) {
        console.error(`[TradePersistence] Sync update failed for trade ${trade.id.slice(0, 8)}:`, e instanceof Error ? e.message : e);
      }
    }

    if (savedCount > 0 || updatedCount > 0) {
      console.log(`[TradePersistence] Sync complete: ${savedCount} new trades saved, ${updatedCount} trades updated (${inMemoryTrades.length} in memory, ${dbTradeIds.size} were in DB)`);
    }
  } catch (error) {
    console.error("[TradePersistence] Full sync failed:", error instanceof Error ? error.message : error);
  }
}

export function startPeriodicSync(getTradesFromMemory: () => TradeRecord[]): void {
  if (syncIntervalHandle) return;

  syncIntervalHandle = setInterval(async () => {
    try {
      await drainFailedQueues();

      const trades = getTradesFromMemory();
      await syncTradesToDb(trades);
    } catch (error) {
      console.error("[TradePersistence] Periodic sync error:", error instanceof Error ? error.message : error);
    }
  }, SYNC_INTERVAL_MS);

  console.log(`[TradePersistence] Periodic sync started (every ${SYNC_INTERVAL_MS / 1000}s)`);
}

export function stopPeriodicSync(): void {
  if (syncIntervalHandle) {
    clearInterval(syncIntervalHandle);
    syncIntervalHandle = null;
  }
}

export function getFailedQueueStats(): { trades: number; positions: number } {
  return { trades: failedTradeQueue.size, positions: failedPositionQueue.size };
}
