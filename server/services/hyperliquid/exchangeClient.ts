import { ethers } from "ethers";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { HL_BASE_URL, HL_PRIVATE_KEY, HL_WALLET_ADDRESS, getCoinMeta, loadCoinMeta, HL_TESTNET } from "./config";

const FETCH_TIMEOUT_MS = 15_000;

function getWallet(): ethers.Wallet {
  if (!HL_PRIVATE_KEY) throw new Error("HYPERLIQUID_PRIVATE_KEY not set");
  return new ethers.Wallet(HL_PRIVATE_KEY);
}

function floatToWire(x: number, decimals: number): string {
  const fixed = x.toFixed(decimals);
  return normalizeNumber(fixed);
}

function normalizeNumber(s: string): string {
  if (s.includes('.')) {
    s = s.replace(/0+$/, '');
    s = s.replace(/\.$/, '');
  }
  if (s === '-0') s = '0';
  return s;
}

function priceToWire(price: number, szDecimals: number = 0): string {
  const sig = parseFloat(price.toPrecision(5));
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const tickRounded = parseFloat(sig.toFixed(maxDecimals));
  if (tickRounded === Math.floor(tickRounded)) return String(Math.floor(tickRounded));
  const s = tickRounded.toFixed(maxDecimals);
  return normalizeNumber(s);
}

function orderTypeToWire(orderType: string): { limit: { tif: string } } {
  if (orderType === "market") {
    return { limit: { tif: "Ioc" } };
  }
  return { limit: { tif: "Gtc" } };
}

interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: string } };
  c?: string;
}

function buildOrderWire(
  coinIndex: number,
  isBuy: boolean,
  size: string,
  price: string,
  orderType: string,
  reduceOnly: boolean,
  cloid?: string
): OrderWire {
  const wire: OrderWire = {
    a: coinIndex,
    b: isBuy,
    p: price,
    s: size,
    r: reduceOnly,
    t: orderTypeToWire(orderType),
  };
  if (cloid) wire.c = cloid;
  return wire;
}

function actionHash(action: any, nonce: number, vaultAddress: string | null = null): string {
  const packed = Buffer.from(msgpackEncode(action));
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64BE(BigInt(nonce));

  const parts: Buffer[] = [packed, nonceBytes];

  if (vaultAddress == null) {
    parts.push(Buffer.from([0x00]));
  } else {
    parts.push(Buffer.from([0x01]));
    parts.push(Buffer.from(vaultAddress.replace("0x", ""), "hex"));
  }

  const combined = Buffer.concat(parts);
  return ethers.keccak256(combined);
}

const PHANTOM_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
};

const PHANTOM_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

async function signL1Action(action: any, nonce: number, vaultAddress: string | null = null): Promise<{ r: string; s: string; v: number }> {
  const wallet = getWallet();
  const connectionId = actionHash(action, nonce, vaultAddress);
  const source = HL_TESTNET ? "b" : "a";

  const signature = await wallet.signTypedData(PHANTOM_DOMAIN, PHANTOM_TYPES, {
    source,
    connectionId,
  });
  const { r, s, v } = ethers.Signature.from(signature);
  return { r, s, v };
}

async function hlExchangePost(action: any, signature: { r: string; s: string; v: number }, nonce: number): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${HL_BASE_URL}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature,
        vaultAddress: null,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const data = await response.json();

    if (data.status === "err") {
      throw new Error(`HL Exchange error: ${data.response || JSON.stringify(data)}`);
    }

    return data;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

let lastNonce = 0;
function getNonce(): number {
  let nonce = Date.now();
  if (nonce <= lastNonce) {
    nonce = lastNonce + 1;
  }
  lastNonce = nonce;
  return nonce;
}

export interface OrderResult {
  success: boolean;
  orderId?: number;
  status?: string;
  filled?: { size: number; price: number };
  error?: string;
  raw?: any;
}

export async function placeOrder(
  coin: string,
  isBuy: boolean,
  size: number,
  price: number,
  orderType: "limit" | "market" = "limit",
  reduceOnly: boolean = false,
  cloid?: string
): Promise<OrderResult> {
  await loadCoinMeta();
  const meta = getCoinMeta(coin);
  if (!meta) {
    return { success: false, error: `Unknown coin: ${coin}` };
  }

  const sizeStr = floatToWire(size, meta.szDecimals);
  const nonce = getNonce();

  let adjustedPrice = price;
  if (orderType === "market") {
    adjustedPrice = isBuy ? price * 1.02 : price * 0.98;
  }
  const adjustedPriceStr = priceToWire(adjustedPrice, meta.szDecimals);

  const orderWire = buildOrderWire(meta.index, isBuy, sizeStr, adjustedPriceStr, orderType, reduceOnly, cloid);

  const action = {
    type: "order",
    orders: [orderWire],
    grouping: "na",
  };

  try {
    const signature = await signL1Action(action, nonce);
    const result = await hlExchangePost(action, signature, nonce);

    console.log(`[HL Exchange] Order placed: ${isBuy ? "BUY" : "SELL"} ${sizeStr} ${coin} @ ${adjustedPriceStr} (${orderType})`, JSON.stringify(result?.response?.data?.statuses || ""));

    const statuses = result?.response?.data?.statuses;
    if (statuses && statuses.length > 0) {
      const s = statuses[0];
      if (s.filled) {
        return {
          success: true,
          orderId: s.filled.oid,
          status: "filled",
          filled: { size: parseFloat(s.filled.totalSz), price: parseFloat(s.filled.avgPx) },
          raw: result,
        };
      }
      if (s.resting) {
        return {
          success: true,
          orderId: s.resting.oid,
          status: "resting",
          raw: result,
        };
      }
      if (s.error) {
        return { success: false, error: s.error, raw: result };
      }
    }

    return { success: true, status: "unknown", raw: result };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[HL Exchange] Order failed: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function cancelOrder(coin: string, oid: number): Promise<OrderResult> {
  await loadCoinMeta();
  const meta = getCoinMeta(coin);
  if (!meta) return { success: false, error: `Unknown coin: ${coin}` };

  const nonce = getNonce();
  const action = {
    type: "cancel",
    cancels: [{ a: meta.index, o: oid }],
  };

  try {
    const signature = await signL1Action(action, nonce);
    const result = await hlExchangePost(action, signature, nonce);
    console.log(`[HL Exchange] Cancelled order ${oid} for ${coin}`);
    return { success: true, raw: result };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[HL Exchange] Cancel failed: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function closePosition(coin: string, currentPrice: number, side: "long" | "short"): Promise<OrderResult> {
  const { getOpenPositions } = await import("./infoClient");
  const positions = await getOpenPositions();
  const pos = positions.find(p => p.coin === coin);

  if (!pos) {
    console.warn(`[HL Exchange] No position found for ${coin} to close`);
    return { success: false, error: `No open position for ${coin}` };
  }

  const isBuy = pos.side === "short";

  console.log(`[HL Exchange] Closing ${pos.side} ${pos.size} ${coin} @ ~${currentPrice.toFixed(2)} (market)`);
  return placeOrder(coin, isBuy, pos.size, currentPrice, "market", true);
}

export async function updateLeverage(coin: string, leverage: number, isCross: boolean = true): Promise<boolean> {
  await loadCoinMeta();
  const meta = getCoinMeta(coin);
  if (!meta) return false;

  const nonce = getNonce();
  const action = {
    type: "updateLeverage",
    asset: meta.index,
    isCross,
    leverage,
  };

  try {
    const signature = await signL1Action(action, nonce);
    await hlExchangePost(action, signature, nonce);
    console.log(`[HL Exchange] Set leverage for ${coin}: ${leverage}x (${isCross ? "cross" : "isolated"})`);
    return true;
  } catch (error) {
    console.error(`[HL Exchange] Leverage update failed for ${coin}:`, error instanceof Error ? error.message : error);
    return false;
  }
}
