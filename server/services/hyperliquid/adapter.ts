import { SYMBOL_TO_HL, HL_TO_SYMBOL, getCoinMeta, loadCoinMeta, HL_WALLET_ADDRESS, getExecutionMode, HL_TESTNET, isCoinAvailableForExecution } from "./config";
import { getAccountState, getOpenPositions, getUserFills, getAllMids, type HLAccountState, type HLPosition, type HLFill } from "./infoClient";
import { placeOrder, closePosition as hlClosePos, cancelOrder, type OrderResult } from "./exchangeClient";
import type { AITradeSignal, Position, TradeRecord } from "@shared/schema";

let initialized = false;

const pendingCloses: Map<string, Promise<{ success: boolean; fillPrice?: number; closedPnl?: number; error?: string }>> = new Map();

export function hlPreflightCheck(symbol: string, notional: number, price: number): { ok: boolean; reason?: string } {
  if (getExecutionMode() !== "hyperliquid") return { ok: true };

  const hlSymbol = SYMBOL_TO_HL[symbol];
  if (!hlSymbol) return { ok: false, reason: `${symbol} not mapped to HL` };

  if (!isCoinAvailableForExecution(hlSymbol)) {
    return { ok: false, reason: `${symbol} not on ${HL_TESTNET ? "testnet" : "mainnet"}` };
  }

  const meta = getCoinMeta(hlSymbol);
  if (!meta) return { ok: true };

  const factor = Math.pow(10, meta.szDecimals);
  const size = Math.floor((notional / price) * factor) / factor;

  if (size <= 0) {
    const minSize = 1 / factor;
    const minNotional = minSize * price;
    return { ok: false, reason: `Min order $${minNotional.toFixed(0)} (szDec=${meta.szDecimals}), budget $${notional.toFixed(0)}` };
  }

  return { ok: true };
}

export async function initHyperliquid(): Promise<boolean> {
  if (initialized) return true;

  try {
    const meta = await loadCoinMeta();
    if (meta.size === 0) {
      console.error("[HL Adapter] Failed to load coin metadata");
      return false;
    }

    const account = await getAccountState();
    console.log(`[HL Adapter] Connected to Hyperliquid ${HL_TESTNET ? "TESTNET" : "MAINNET"}`);
    console.log(`[HL Adapter] Account: equity=$${account.equity.toFixed(2)}, margin=$${account.marginUsed.toFixed(2)}, withdrawable=$${account.withdrawable.toFixed(2)}`);

    initialized = true;
    return true;
  } catch (error) {
    console.error("[HL Adapter] Initialization failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

async function ensureInitialized(): Promise<boolean> {
  if (!initialized) {
    const ok = await initHyperliquid();
    if (!ok) return false;
  }
  return true;
}

export async function hlOpenPosition(signal: AITradeSignal): Promise<{ success: boolean; orderId?: number; fillPrice?: number; fillSize?: number; error?: string }> {
  if (!await ensureInitialized()) {
    return { success: false, error: "Hyperliquid not initialized" };
  }

  const hlSymbol = SYMBOL_TO_HL[signal.symbol];
  if (!hlSymbol) {
    return { success: false, error: `Symbol ${signal.symbol} not mapped to Hyperliquid` };
  }

  if (!isCoinAvailableForExecution(hlSymbol)) {
    return { success: false, error: `${hlSymbol} not available on ${HL_TESTNET ? "testnet" : "mainnet"}` };
  }

  const meta = getCoinMeta(hlSymbol);
  if (!meta) {
    return { success: false, error: `No metadata for ${hlSymbol}` };
  }

  const isBuy = signal.side === "long";
  const price = signal.targetEntry;
  if (!price || price <= 0) {
    return { success: false, error: `Invalid price for ${signal.symbol}: ${price}` };
  }
  const notional = signal.positionSize || 25;
  let size = notional / price;

  const factor = Math.pow(10, meta.szDecimals);
  size = Math.floor(size * factor) / factor;

  if (size <= 0) {
    const minSize = 1 / factor;
    const minNotional = minSize * price;
    return { success: false, error: `Size too small for ${hlSymbol}: need $${minNotional.toFixed(0)} min, have $${notional.toFixed(0)} (szDecimals=${meta.szDecimals})` };
  }

  const actualNotional = size * price;
  console.log(`[HL Adapter] Opening ${signal.side} ${hlSymbol}: size=${size} @ $${price.toFixed(4)} (notional: $${actualNotional.toFixed(2)})`);

  const result = await placeOrder(hlSymbol, isBuy, size, price, "market", false);

  if (!result.success) {
    console.error(`[HL Adapter] Failed to open ${hlSymbol} ${signal.side}: ${result.error}`);
    return { success: false, error: result.error };
  }

  if (result.status === "resting") {
    const prePositions = await getOpenPositions();
    const preSizeAbs = (() => {
      const p = prePositions.find(p => p.coin === hlSymbol);
      return p ? p.size : 0;
    })();

    console.log(`[HL Adapter] Order RESTING for ${hlSymbol}: orderId=${result.orderId} (pre-size=${preSizeAbs}) — waiting up to 30s for fill...`);
    const POLL_INTERVAL = 3000;
    const MAX_WAIT = 30000;
    const startWait = Date.now();
    let filled = false;
    let fillPrice: number | undefined;
    let fillSize: number | undefined;

    while (Date.now() - startWait < MAX_WAIT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      try {
        const positions = await getOpenPositions();
        const hlPos = positions.find(p => p.coin === hlSymbol);
        const currentSizeAbs = hlPos ? hlPos.size : 0;
        if (currentSizeAbs > preSizeAbs + 0.0001) {
          filled = true;
          fillPrice = hlPos ? hlPos.entryPrice : undefined;
          fillSize = currentSizeAbs;
          console.log(`[HL Adapter] Resting order FILLED for ${hlSymbol}: size ${preSizeAbs} → ${fillSize} @ $${fillPrice}`);
          break;
        }
      } catch (e) {
        console.error(`[HL Adapter] Error polling resting order for ${hlSymbol}:`, e instanceof Error ? e.message : e);
      }
    }

    if (!filled) {
      console.log(`[HL Adapter] Resting order UNFILLED after ${MAX_WAIT / 1000}s — cancelling order ${result.orderId} for ${hlSymbol}`);
      try {
        if (result.orderId) await cancelOrder(hlSymbol, result.orderId);
      } catch (e) {
        console.error(`[HL Adapter] Error cancelling unfilled order for ${hlSymbol}:`, e instanceof Error ? e.message : e);
      }
      return { success: false, error: `Limit order unfilled after ${MAX_WAIT / 1000}s — cancelled` };
    }

    return { success: true, orderId: result.orderId, fillPrice, fillSize };
  }

  console.log(`[HL Adapter] Order placed for ${hlSymbol}: orderId=${result.orderId}, status=${result.status}`);

  if (result.filled) {
    return {
      success: true,
      orderId: result.orderId,
      fillPrice: result.filled.price,
      fillSize: result.filled.size,
    };
  }

  return {
    success: true,
    orderId: result.orderId,
  };
}

export async function hlClosePosition(coin: string, currentPrice: number, side: "long" | "short", reason: string): Promise<{ success: boolean; fillPrice?: number; closedPnl?: number; error?: string }> {
  if (!await ensureInitialized()) {
    return { success: false, error: "Hyperliquid not initialized" };
  }
  const hlSymbol = SYMBOL_TO_HL[coin] || coin;

  if (!isCoinAvailableForExecution(hlSymbol)) {
    return { success: false, error: `${hlSymbol} not available for execution` };
  }

  const existing = pendingCloses.get(hlSymbol);
  if (existing) {
    console.log(`[HL Adapter] Close already in-flight for ${hlSymbol}, awaiting existing close`);
    return existing;
  }

  const closePromise = (async () => {
    try {
      console.log(`[HL Adapter] Closing ${side} ${hlSymbol} @ ~$${currentPrice.toFixed(4)} — ${reason}`);

      const result = await hlClosePos(hlSymbol, currentPrice, side);

      if (!result.success) {
        if (result.error?.includes("No open position")) {
          console.log(`[HL Adapter] No HL position for ${hlSymbol} — already closed on exchange`);
          return { success: true, fillPrice: currentPrice };
        }
        console.error(`[HL Adapter] Failed to close ${hlSymbol}: ${result.error}`);
        return { success: false, error: result.error };
      }

      if (result.filled) {
        return { success: true, fillPrice: result.filled.price };
      }

      return { success: true };
    } finally {
      pendingCloses.delete(hlSymbol);
    }
  })();

  pendingCloses.set(hlSymbol, closePromise);
  return closePromise;
}

export async function hlPartialClose(coin: string, quantityToClose: number, currentPrice: number, side: "long" | "short", reason: string): Promise<{ success: boolean; fillPrice?: number; error?: string }> {
  if (!await ensureInitialized()) {
    return { success: false, error: "Hyperliquid not initialized" };
  }
  const hlSymbol = SYMBOL_TO_HL[coin] || coin;
  const meta = getCoinMeta(hlSymbol);
  if (!meta) {
    return { success: false, error: `No metadata for ${hlSymbol}` };
  }

  const isBuy = side === "short";

  const factor = Math.pow(10, meta.szDecimals);
  const size = Math.floor(quantityToClose * factor) / factor;

  if (size <= 0) {
    return { success: false, error: `Partial close size too small for ${hlSymbol}: ${size}` };
  }

  console.log(`[HL Adapter] Partial close ${side} ${hlSymbol}: ${size} units @ ~$${currentPrice.toFixed(4)} — ${reason}`);

  const result = await placeOrder(hlSymbol, isBuy, size, currentPrice, "market", true);

  if (!result.success) {
    if (result.error?.includes("Reduce only order would increase position")) {
      console.log(`[HL Adapter] No HL position left for ${hlSymbol} — partial close skipped`);
      return { success: true, fillPrice: currentPrice };
    }
    console.error(`[HL Adapter] Partial close FAILED for ${hlSymbol}: ${result.error}`);
    return { success: false, error: result.error };
  }

  return {
    success: true,
    fillPrice: result.filled?.price,
  };
}

export async function hlGetPortfolio(): Promise<{
  balance: number;
  equity: number;
  marginUsed: number;
  unrealizedPnl: number;
  withdrawable: number;
  positions: HLPosition[];
}> {
  const [account, positions] = await Promise.all([
    getAccountState(),
    getOpenPositions(),
  ]);

  return {
    balance: account.balance,
    equity: account.equity,
    marginUsed: account.marginUsed,
    unrealizedPnl: account.unrealizedPnl,
    withdrawable: account.withdrawable,
    positions,
  };
}

export async function hlGetTrades(since?: number): Promise<HLFill[]> {
  return getUserFills(HL_WALLET_ADDRESS, since);
}

export async function hlGetPrices(): Promise<Record<string, number>> {
  return getAllMids();
}

export async function hlSyncPositions(): Promise<{
  hlPositions: HLPosition[];
  synced: boolean;
}> {
  const positions = await getOpenPositions();

  if (positions.length > 0) {
    console.log(`[HL Adapter] Synced ${positions.length} positions from Hyperliquid:`);
    for (const p of positions) {
      console.log(`  ${p.side.toUpperCase()} ${p.coin}: ${p.size} @ $${p.entryPrice.toFixed(4)} (PnL: $${p.unrealizedPnl.toFixed(4)})`);
    }
  }

  return { hlPositions: positions, synced: true };
}

export function isHLMode(): boolean {
  return getExecutionMode() === "hyperliquid";
}

export async function hlCancelAllOrders(): Promise<number> {
  const { getOpenOrders } = await import("./infoClient");
  const orders = await getOpenOrders();
  let cancelled = 0;

  for (const order of orders) {
    const coin = order.coin;
    const oid = order.oid;
    const result = await cancelOrder(SYMBOL_TO_HL[coin] || coin, oid);
    if (result.success) cancelled++;
  }

  if (cancelled > 0) {
    console.log(`[HL Adapter] Cancelled ${cancelled} open orders`);
  }

  return cancelled;
}

export async function hlReconcilePositions(internalPositions: Position[]): Promise<{
  orphansClosed: string[];
  phantomsRemoved: string[];
  sizeMismatches: string[];
  positionsToCreate: { coin: string; symbol: string; side: "long" | "short"; size: number; entryPrice: number }[];
}> {
  const result = { orphansClosed: [] as string[], phantomsRemoved: [] as string[], sizeMismatches: [] as string[], positionsToCreate: [] as { coin: string; symbol: string; side: "long" | "short"; size: number; entryPrice: number }[] };

  if (getExecutionMode() !== "hyperliquid") return result;
  if (!await ensureInitialized()) {
    console.warn("[HL Reconcile] Cannot reconcile — HL not initialized");
    return result;
  }

  console.log("[HL Reconcile] Starting position reconciliation...");

  const [hlPositions, currentPrices] = await Promise.all([
    getOpenPositions(),
    getAllMids(),
  ]);

  const internalByCoin = new Map<string, { totalSize: number; side: "long" | "short"; positionIds: string[]; positions: Position[] }>();
  for (const p of internalPositions) {
    const hlSymbol = SYMBOL_TO_HL[p.symbol] || p.symbol;
    const existing = internalByCoin.get(hlSymbol);
    if (existing) {
      existing.totalSize += p.quantity;
      existing.positionIds.push(p.id);
      existing.positions.push(p);
    } else {
      internalByCoin.set(hlSymbol, {
        totalSize: p.quantity,
        side: p.side as "long" | "short",
        positionIds: [p.id],
        positions: [p],
      });
    }
  }

  console.log(`[HL Reconcile] HL has ${hlPositions.length} positions, internal tracks ${internalByCoin.size} coins (${internalPositions.length} layers)`);

  for (const hlPos of hlPositions) {
    const internal = internalByCoin.get(hlPos.coin);
    if (!internal) {
      const displaySymbol = HL_TO_SYMBOL[hlPos.coin] || hlPos.coin;
      console.log(`[HL Reconcile] ORPHAN on HL: ${hlPos.coin} ${hlPos.side} size=${hlPos.size} @ entry=$${hlPos.entryPrice.toFixed(6)} — adopting into internal state`);
      result.positionsToCreate.push({
        coin: hlPos.coin,
        symbol: displaySymbol,
        side: hlPos.side,
        size: hlPos.size,
        entryPrice: hlPos.entryPrice,
      });
    } else {
      const sizeDiff = Math.abs(internal.totalSize - hlPos.size);
      const sizeRatio = hlPos.size > 0 ? sizeDiff / hlPos.size : 0;
      if (sizeRatio > 0.05 || internal.side !== hlPos.side) {
        const reason = internal.side !== hlPos.side ? 'SIDE MISMATCH' : 'SIZE MISMATCH';
        console.log(`[HL Reconcile] ${reason}: ${hlPos.coin} — HL=${hlPos.size} (${hlPos.side}), internal=${internal.totalSize.toFixed(6)} (${internal.side}) — removing ALL internal layers and rebuilding from HL`);
        result.sizeMismatches.push(`${hlPos.coin}:removed_${internal.positionIds.length}_layers`);
        result.phantomsRemoved.push(...internal.positionIds.map(id => `${hlPos.coin}:${id}`));
        const displaySymbol = HL_TO_SYMBOL[hlPos.coin] || hlPos.coin;
        result.positionsToCreate.push({
          coin: hlPos.coin,
          symbol: displaySymbol,
          side: hlPos.side,
          size: hlPos.size,
          entryPrice: hlPos.entryPrice,
        });
      }
    }
  }

  const hlCoins = new Set(hlPositions.map(p => p.coin));
  for (const [coin, internal] of internalByCoin) {
    if (!hlCoins.has(coin)) {
      console.log(`[HL Reconcile] PHANTOM internal: ${coin} ${internal.side} size=${internal.totalSize.toFixed(6)} — no HL position exists, flagging ${internal.positionIds.length} positions for removal`);
      result.phantomsRemoved.push(...internal.positionIds);
    }
  }

  const totalIssues = result.positionsToCreate.length + result.phantomsRemoved.length + result.sizeMismatches.length;
  if (totalIssues === 0) {
    console.log("[HL Reconcile] All positions in sync ✓");
  } else {
    console.log(`[HL Reconcile] Found ${totalIssues} issues: ${result.positionsToCreate.length} to adopt/rebuild, ${result.phantomsRemoved.length} phantoms to remove, ${result.sizeMismatches.length} size mismatches`);
  }

  return result;
}

export async function hlGetAccountSummary(): Promise<{
  mode: string;
  connected: boolean;
  equity: number;
  balance: number;
  unrealizedPnl: number;
  openPositions: number;
  marginUsed: number;
  withdrawable: number;
}> {
  try {
    const portfolio = await hlGetPortfolio();
    return {
      mode: HL_TESTNET ? "testnet" : "mainnet",
      connected: true,
      equity: portfolio.equity,
      balance: portfolio.balance,
      unrealizedPnl: portfolio.unrealizedPnl,
      openPositions: portfolio.positions.length,
      marginUsed: portfolio.marginUsed,
      withdrawable: portfolio.withdrawable,
    };
  } catch {
    return {
      mode: HL_TESTNET ? "testnet" : "mainnet",
      connected: false,
      equity: 0,
      balance: 0,
      unrealizedPnl: 0,
      openPositions: 0,
      marginUsed: 0,
      withdrawable: 0,
    };
  }
}
