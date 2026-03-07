import { CryptoData } from "@shared/schema";

interface OnChainMetrics {
  symbol: string;
  name: string;
  marketCap: number;
  mvrvZScore: number;
  mvrvInterpretation: string;
  nupl: number;
  nuplInterpretation: string;
  nuplZone: "capitulation" | "hope" | "optimism" | "belief" | "euphoria";
  priceToAvg7d: number;
  timestamp: string;
}

interface AllOnChainMetrics {
  btc: OnChainMetrics | null;
  eth: OnChainMetrics | null;
  market: {
    totalMarketCap: number;
    avgMvrv: number;
    overallSentiment: string;
  };
  lastUpdated: string;
}

const CACHE_TTL = 60 * 1000;
let cache: { data: AllOnChainMetrics | null; timestamp: number } = {
  data: null,
  timestamp: 0,
};

function calculateMVRVZScore(
  currentMarketCap: number,
  sparklinePrices: number[],
  currentPrice: number
): { zScore: number; interpretation: string } {
  if (!sparklinePrices || sparklinePrices.length < 24) {
    return { zScore: 0, interpretation: "Insufficient data" };
  }

  const avgPrice = sparklinePrices.reduce((a, b) => a + b, 0) / sparklinePrices.length;
  const circulatingSupply = currentMarketCap / currentPrice;
  const realizedCapProxy = avgPrice * circulatingSupply;

  const priceVariance = sparklinePrices.reduce((sum, p) => {
    return sum + Math.pow(p - avgPrice, 2);
  }, 0) / sparklinePrices.length;
  const priceStdDev = Math.sqrt(priceVariance);
  const marketCapStdDev = priceStdDev * circulatingSupply;

  if (marketCapStdDev === 0) {
    return { zScore: 0, interpretation: "Stable market" };
  }

  const zScore = (currentMarketCap - realizedCapProxy) / marketCapStdDev;
  
  let interpretation: string;
  if (zScore > 7) {
    interpretation = "Extreme overvaluation - major correction likely";
  } else if (zScore > 4) {
    interpretation = "Significantly overvalued - caution advised";
  } else if (zScore > 2) {
    interpretation = "Moderately overvalued - take profits";
  } else if (zScore > 0) {
    interpretation = "Fair value to slightly overvalued";
  } else if (zScore > -1) {
    interpretation = "Undervalued - accumulation zone";
  } else {
    interpretation = "Deeply undervalued - strong buy signal";
  }

  return { zScore: Math.round(zScore * 100) / 100, interpretation };
}

function calculateNUPL(
  currentMarketCap: number,
  sparklinePrices: number[],
  currentPrice: number
): { nupl: number; interpretation: string; zone: OnChainMetrics["nuplZone"] } {
  if (!sparklinePrices || sparklinePrices.length < 24) {
    return { nupl: 0, interpretation: "Insufficient data", zone: "hope" };
  }

  const avgPrice = sparklinePrices.reduce((a, b) => a + b, 0) / sparklinePrices.length;
  const circulatingSupply = currentMarketCap / currentPrice;
  const realizedCapProxy = avgPrice * circulatingSupply;

  const nupl = (currentMarketCap - realizedCapProxy) / currentMarketCap;
  const nuplPercent = nupl * 100;

  let interpretation: string;
  let zone: OnChainMetrics["nuplZone"];

  if (nuplPercent > 75) {
    interpretation = "Euphoria - extreme greed, market top likely";
    zone = "euphoria";
  } else if (nuplPercent > 50) {
    interpretation = "Belief - strong profit taking, be cautious";
    zone = "belief";
  } else if (nuplPercent > 25) {
    interpretation = "Optimism - healthy bull market";
    zone = "optimism";
  } else if (nuplPercent > 0) {
    interpretation = "Hope - recovery phase, accumulate";
    zone = "hope";
  } else {
    interpretation = "Capitulation - maximum fear, best time to buy";
    zone = "capitulation";
  }

  return { 
    nupl: Math.round(nupl * 1000) / 1000, 
    interpretation, 
    zone 
  };
}

function calculatePriceToAvg(
  currentPrice: number,
  sparklinePrices: number[]
): number {
  if (!sparklinePrices || sparklinePrices.length === 0) return 0;
  const avgPrice = sparklinePrices.reduce((a, b) => a + b, 0) / sparklinePrices.length;
  return Math.round(((currentPrice / avgPrice) - 1) * 10000) / 100;
}

function calculateMetricsForCrypto(crypto: CryptoData): OnChainMetrics | null {
  const sparkline = crypto.sparkline_in_7d?.price;
  if (!sparkline || sparkline.length < 24) {
    return null;
  }

  const { zScore, interpretation: mvrvInterpretation } = calculateMVRVZScore(
    crypto.market_cap,
    sparkline,
    crypto.current_price
  );

  const { nupl, interpretation: nuplInterpretation, zone } = calculateNUPL(
    crypto.market_cap,
    sparkline,
    crypto.current_price
  );

  const priceToAvg7d = calculatePriceToAvg(crypto.current_price, sparkline);

  return {
    symbol: crypto.symbol.toUpperCase(),
    name: crypto.name,
    marketCap: crypto.market_cap,
    mvrvZScore: zScore,
    mvrvInterpretation,
    nupl,
    nuplInterpretation,
    nuplZone: zone,
    priceToAvg7d,
    timestamp: new Date().toISOString(),
  };
}

export function calculateOnChainMetrics(cryptos: CryptoData[]): AllOnChainMetrics {
  const now = Date.now();

  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  const btc = cryptos.find(c => c.symbol.toLowerCase() === "btc");
  const eth = cryptos.find(c => c.symbol.toLowerCase() === "eth");

  const btcMetrics = btc ? calculateMetricsForCrypto(btc) : null;
  const ethMetrics = eth ? calculateMetricsForCrypto(eth) : null;

  const totalMarketCap = cryptos.reduce((sum, c) => sum + c.market_cap, 0);

  const validMetrics = [btcMetrics, ethMetrics].filter(m => m !== null);
  const avgMvrv = validMetrics.length > 0
    ? validMetrics.reduce((sum, m) => sum + m!.mvrvZScore, 0) / validMetrics.length
    : 0;

  let overallSentiment: string;
  if (avgMvrv > 3) {
    overallSentiment = "Overheated - risk of correction";
  } else if (avgMvrv > 1) {
    overallSentiment = "Bullish - momentum positive";
  } else if (avgMvrv > -0.5) {
    overallSentiment = "Neutral - fair value range";
  } else {
    overallSentiment = "Undervalued - accumulation opportunity";
  }

  const metrics: AllOnChainMetrics = {
    btc: btcMetrics,
    eth: ethMetrics,
    market: {
      totalMarketCap,
      avgMvrv: Math.round(avgMvrv * 100) / 100,
      overallSentiment,
    },
    lastUpdated: new Date().toISOString(),
  };

  cache = { data: metrics, timestamp: now };
  return metrics;
}
