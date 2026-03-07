import type { SentimentData } from "@shared/schema";

const SENTICRYPT_URL = "https://api.senticrypt.com/v2/bitcoin.json";

let cachedSentiment: SentimentData | null = null;
let lastFetch: number = 0;
const CACHE_DURATION = 120000;

export async function getBitcoinSentiment(): Promise<SentimentData> {
  const now = Date.now();
  
  if (cachedSentiment && now - lastFetch < CACHE_DURATION) {
    console.log("[SentiCrypt] Returning cached data");
    return cachedSentiment;
  }

  try {
    console.log("[SentiCrypt] Fetching fresh sentiment...");
    
    const response = await fetch(SENTICRYPT_URL, {
      headers: {
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[SentiCrypt] API error:", response.status, errorText);
      
      if (cachedSentiment) {
        console.log("[SentiCrypt] Returning stale cached data");
        return cachedSentiment;
      }
      
      throw new Error(`SentiCrypt API error: ${response.status}`);
    }

    const data = await response.json();
    
    const score = typeof data.score === "number" ? data.score : parseFloat(data.score) || 0;
    const normalizedScore = Math.max(-1, Math.min(1, score));
    
    let label: "bullish" | "neutral" | "bearish" = "neutral";
    if (normalizedScore > 0.2) label = "bullish";
    else if (normalizedScore < -0.2) label = "bearish";

    const sentiment: SentimentData = {
      coin: "bitcoin",
      score: normalizedScore,
      label,
      timestamp: data.timestamp || new Date().toISOString(),
    };

    cachedSentiment = sentiment;
    lastFetch = now;
    
    console.log(`[SentiCrypt] BTC sentiment: ${sentiment.score.toFixed(3)} (${sentiment.label})`);
    return sentiment;
  } catch (error) {
    console.error("[SentiCrypt] Fetch error:", error);
    
    if (cachedSentiment) {
      console.log("[SentiCrypt] Returning stale cached data");
      return cachedSentiment;
    }
    
    return {
      coin: "bitcoin",
      score: 0,
      label: "neutral",
      timestamp: new Date().toISOString(),
    };
  }
}

export function getCachedSentiment(): SentimentData | null {
  return cachedSentiment;
}
