import type { PolymarketData } from "@shared/schema";

const GAMMA_API_URL = "https://gamma-api.polymarket.com";

let cachedMarkets: PolymarketData[] = [];
let lastFetch: number = 0;
const CACHE_DURATION = 120000;

const CRYPTO_KEYWORDS = [
  "bitcoin", "btc", "ethereum", "eth", "solana", "sol", 
  "crypto", "cryptocurrency", "xrp", "dogecoin", "doge",
  "binance", "coinbase", "cardano", "ada", "ripple", "bnb", 
  "avalanche", "avax", "polygon", "matic", "chainlink", "link", 
  "uniswap", "uni", "stablecoin", "usdt", "usdc", "defi", "nft", 
  "web3", "altcoin", "memecoin", "shiba", "pepe", "floki",
  "tether", "litecoin", "ltc", "polkadot", "dot", "cosmos", "atom",
  "near", "fantom", "ftm", "arbitrum", "optimism", "layer 2",
  "blockchain", "token", "mining", "halving", "satoshi"
];

function isCryptoRelated(question: string, description: string): boolean {
  const text = `${question} ${description}`.toLowerCase();
  return CRYPTO_KEYWORDS.some(keyword => {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    return regex.test(text);
  });
}

export async function getCryptoMarkets(): Promise<PolymarketData[]> {
  const now = Date.now();
  
  if (cachedMarkets.length > 0 && now - lastFetch < CACHE_DURATION) {
    console.log("[Polymarket] Returning cached data");
    return cachedMarkets;
  }

  try {
    console.log("[Polymarket] Fetching crypto prediction markets...");
    
    const response = await fetch(
      `${GAMMA_API_URL}/markets?closed=false&limit=200&order=volume&ascending=false`,
      {
        headers: {
          "Accept": "application/json",
        },
      }
    );

    if (!response.ok) {
      console.error("[Polymarket] API error:", response.status);
      return cachedMarkets;
    }

    const allMarkets = await response.json();
    console.log(`[Polymarket] Received ${allMarkets.length} total markets`);
    
    const cryptoMarkets: PolymarketData[] = allMarkets
      .filter((market: any) => {
        const question = market.question || "";
        const description = market.description || "";
        const isCrypto = isCryptoRelated(question, description);
        if (isCrypto) {
          console.log(`[Polymarket] Matched: ${question.slice(0, 50)}...`);
        }
        return isCrypto;
      })
      .slice(0, 10)
      .map((market: any) => {
        let outcomes: string[] = [];
        if (typeof market.outcomes === "string") {
          try {
            outcomes = JSON.parse(market.outcomes);
          } catch {
            outcomes = ["Yes", "No"];
          }
        } else if (Array.isArray(market.outcomes)) {
          outcomes = market.outcomes;
        } else {
          outcomes = ["Yes", "No"];
        }
        
        let prices: number[] = [];
        if (typeof market.outcomePrices === "string") {
          try {
            prices = JSON.parse(market.outcomePrices).map((p: string) => parseFloat(p));
          } catch {
            prices = [0.5, 0.5];
          }
        } else if (Array.isArray(market.outcomePrices)) {
          prices = market.outcomePrices.map((p: any) => parseFloat(p));
        } else {
          prices = [0.5, 0.5];
        }
        
        return {
          id: market.id,
          question: market.question,
          description: market.description?.slice(0, 200) || "",
          outcomes: outcomes.map((outcome: string, idx: number) => ({
            name: outcome,
            price: prices[idx] || 0.5,
          })),
          volume: parseFloat(market.volume) || 0,
          liquidity: parseFloat(market.liquidity) || 0,
          endDate: market.endDate,
          category: "crypto",
        };
      });

    if (cryptoMarkets.length === 0) {
      console.log("[Polymarket] No crypto markets found in API response");
    }
    
    cachedMarkets = cryptoMarkets;
    lastFetch = now;
    
    console.log(`[Polymarket] Found ${cryptoMarkets.length} crypto prediction markets`);
    return cryptoMarkets;
  } catch (error) {
    console.error("[Polymarket] Fetch error:", error);
    return cachedMarkets;
  }
}

export function getCachedPolymarkets(): PolymarketData[] {
  return cachedMarkets;
}
