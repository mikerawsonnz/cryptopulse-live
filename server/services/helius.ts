import type { WhaleTransaction } from "@shared/schema";

const HELIUS_BASE_URL = "https://api.helius.xyz/v0";
const WHALE_THRESHOLD_USD = 100000;
const WHALE_THRESHOLD_SOL = 500;

let cachedTransactions: WhaleTransaction[] = [];
let lastFetch: number = 0;
const CACHE_DURATION = 15000;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const TOKEN_SYMBOLS: Record<string, string> = {
  [SOL_MINT]: "SOL",
  [USDC_MINT]: "USDC",
  [USDT_MINT]: "USDT",
};

export async function getWhaleTransactions(): Promise<WhaleTransaction[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  
  if (!apiKey) {
    console.log("[Helius] No API key configured, returning empty array");
    return cachedTransactions;
  }

  const now = Date.now();
  
  if (cachedTransactions.length > 0 && now - lastFetch < CACHE_DURATION) {
    console.log("[Helius] Returning cached transactions");
    return cachedTransactions;
  }

  try {
    console.log("[Helius] Fetching recent transactions...");
    
    const response = await fetch(
      `${HELIUS_BASE_URL}/addresses/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/transactions?api-key=${apiKey}&limit=50`,
      {
        headers: {
          "Accept": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Helius] API error:", response.status, errorText);
      
      if (response.status === 429 || response.status === 401) {
        console.log("[Helius] Rate limited or unauthorized, returning cached data");
        return cachedTransactions;
      }
      
      throw new Error(`Helius API error: ${response.status}`);
    }

    const transactions = await response.json();
    
    const whaleTransactions: WhaleTransaction[] = [];
    
    for (const tx of transactions) {
      if (!tx.nativeTransfers && !tx.tokenTransfers) continue;
      
      if (tx.nativeTransfers) {
        for (const transfer of tx.nativeTransfers) {
          const amountSol = transfer.amount / 1e9;
          
          if (amountSol >= WHALE_THRESHOLD_SOL) {
            whaleTransactions.push({
              signature: tx.signature,
              timestamp: tx.timestamp,
              type: "transfer",
              amount: amountSol,
              amountUsd: amountSol * 150,
              token: SOL_MINT,
              tokenSymbol: "SOL",
              from: transfer.fromUserAccount || "unknown",
              to: transfer.toUserAccount || "unknown",
              isWhale: true,
            });
          }
        }
      }
      
      if (tx.tokenTransfers) {
        for (const transfer of tx.tokenTransfers) {
          const decimals = transfer.tokenStandard === "Fungible" ? 6 : 0;
          const amount = transfer.tokenAmount / Math.pow(10, decimals);
          
          const isStablecoin = [USDC_MINT, USDT_MINT].includes(transfer.mint);
          
          if (isStablecoin && amount >= WHALE_THRESHOLD_USD) {
            whaleTransactions.push({
              signature: tx.signature,
              timestamp: tx.timestamp,
              type: determineTransactionType(tx),
              amount: amount,
              amountUsd: amount,
              token: transfer.mint,
              tokenSymbol: TOKEN_SYMBOLS[transfer.mint] || "TOKEN",
              from: transfer.fromUserAccount || "unknown",
              to: transfer.toUserAccount || "unknown",
              isWhale: true,
            });
          }
        }
      }
    }
    
    const uniqueWhales = whaleTransactions
      .filter((tx, index, self) => 
        index === self.findIndex((t) => t.signature === tx.signature)
      )
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20);
    
    cachedTransactions = uniqueWhales;
    lastFetch = now;
    
    console.log(`[Helius] Found ${uniqueWhales.length} whale transactions`);
    return uniqueWhales;
  } catch (error) {
    console.error("[Helius] Fetch error:", error);
    return cachedTransactions;
  }
}

function determineTransactionType(tx: any): "transfer" | "swap" | "mint" | "burn" | "unknown" {
  const type = tx.type?.toLowerCase() || "";
  
  if (type.includes("swap") || type.includes("exchange")) return "swap";
  if (type.includes("mint")) return "mint";
  if (type.includes("burn")) return "burn";
  if (type.includes("transfer")) return "transfer";
  
  return "transfer";
}

export function getCachedWhaleTransactions(): WhaleTransaction[] {
  return cachedTransactions;
}
