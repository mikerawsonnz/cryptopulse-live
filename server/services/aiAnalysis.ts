import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CryptoData, SentimentData, AIInsight } from "@shared/schema";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

let cachedInsight: AIInsight | null = null;
let lastAnalysis: number = 0;
const ANALYSIS_COOLDOWN = 300000;

export async function generateMarketInsight(
  cryptos: CryptoData[],
  sentiment: SentimentData | null,
  polymarketData: any[]
): Promise<AIInsight> {
  const now = Date.now();
  
  if (cachedInsight && now - lastAnalysis < ANALYSIS_COOLDOWN) {
    console.log("[AI] Returning cached insight");
    return cachedInsight;
  }

  try {
    console.log("[AI] Generating market insight with Gemini...");
    
    const marketSummary = cryptos.slice(0, 5).map((c) => ({
      name: c.name,
      symbol: c.symbol.toUpperCase(),
      price: c.current_price,
      change24h: c.price_change_percentage_24h?.toFixed(2) + "%",
      change7d: c.price_change_percentage_7d_in_currency?.toFixed(2) + "%",
    }));
    
    const polymarketSummary = polymarketData.slice(0, 3).map((m) => ({
      question: m.question,
      topOutcome: m.outcomes?.[0]?.name || "Unknown",
      probability: ((m.outcomes?.[0]?.price || 0.5) * 100).toFixed(0) + "%",
    }));

    const prompt = `You are a crypto market analyst. Analyze this real-time data and provide a brief, actionable insight.

CURRENT MARKET DATA:
${JSON.stringify(marketSummary, null, 2)}

BTC SENTIMENT: ${sentiment?.label || "neutral"} (score: ${sentiment?.score?.toFixed(2) || "0"})

PREDICTION MARKETS:
${JSON.stringify(polymarketSummary, null, 2)}

Provide a JSON response with:
{
  "summary": "One sentence market overview",
  "trend": "bullish" | "bearish" | "neutral",
  "confidence": 0.0-1.0,
  "keySignal": "The most important signal right now",
  "riskLevel": "low" | "medium" | "high",
  "topOpportunity": "Best opportunity if any",
  "warning": "Key risk to watch"
}

Be concise and data-driven. Base analysis ONLY on the provided data. Respond with ONLY valid JSON, no markdown.`;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const content = response.text();
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : "{}";
    const parsed = JSON.parse(jsonStr);
    
    const insight: AIInsight = {
      summary: parsed.summary || "Market analysis unavailable",
      trend: parsed.trend || "neutral",
      confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
      keySignal: parsed.keySignal || "No clear signal",
      riskLevel: parsed.riskLevel || "medium",
      topOpportunity: parsed.topOpportunity || null,
      warning: parsed.warning || null,
      timestamp: new Date().toISOString(),
    };
    
    cachedInsight = insight;
    lastAnalysis = now;
    
    console.log("[AI] Generated insight:", insight.trend, insight.confidence);
    return insight;
  } catch (error) {
    console.error("[AI] Analysis error:", error);
    
    return {
      summary: "Unable to generate AI insight at this time",
      trend: "neutral",
      confidence: 0,
      keySignal: "Analysis unavailable",
      riskLevel: "medium",
      topOpportunity: null,
      warning: "AI analysis temporarily unavailable",
      timestamp: new Date().toISOString(),
    };
  }
}

export function getCachedInsight(): AIInsight | null {
  return cachedInsight;
}
