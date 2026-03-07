import type { CryptoData, SentimentData, WhaleTransaction, DivergenceSignal, CorrelationData } from "@shared/schema";

export function detectDivergences(
  cryptos: CryptoData[],
  btcSentiment: SentimentData | null
): DivergenceSignal[] {
  const signals: DivergenceSignal[] = [];
  const sentimentScore = btcSentiment?.score || 0;
  
  for (const crypto of cryptos) {
    const change24h = crypto.price_change_percentage_24h || 0;
    const change7d = crypto.price_change_percentage_7d_in_currency || 0;
    
    const momentum24h = change24h > 0 ? 1 : change24h < 0 ? -1 : 0;
    const momentum7d = change7d > 0 ? 1 : change7d < 0 ? -1 : 0;
    
    const dailyAvg7d = change7d / 7;
    const deviation = change24h - dailyAvg7d;
    
    let signal: DivergenceSignal | null = null;
    
    if (change24h <= -3 && change7d > 0) {
      signal = {
        coin: crypto.symbol.toUpperCase(),
        coinName: crypto.name,
        type: "bullish",
        priceChange24h: change24h,
        sentimentScore: sentimentScore,
        strength: Math.min(1, Math.abs(change24h) / 8),
        description: `24h dip (${change24h.toFixed(1)}%) vs 7d gain (${change7d.toFixed(1)}%) - potential bounce`,
        timestamp: new Date().toISOString(),
      };
    }
    else if (change24h >= 3 && change7d < -2) {
      signal = {
        coin: crypto.symbol.toUpperCase(),
        coinName: crypto.name,
        type: "bearish",
        priceChange24h: change24h,
        sentimentScore: sentimentScore,
        strength: Math.min(1, Math.abs(change24h) / 8),
        description: `24h pump (${change24h.toFixed(1)}%) vs 7d loss (${change7d.toFixed(1)}%) - dead cat bounce?`,
        timestamp: new Date().toISOString(),
      };
    }
    else if (Math.abs(deviation) > 2) {
      const isOutperforming = deviation > 0;
      signal = {
        coin: crypto.symbol.toUpperCase(),
        coinName: crypto.name,
        type: isOutperforming ? "bullish" : "bearish",
        priceChange24h: change24h,
        sentimentScore: sentimentScore,
        strength: Math.min(1, Math.abs(deviation) / 5),
        description: isOutperforming
          ? `Outperforming 7d avg by ${deviation.toFixed(1)}% today`
          : `Underperforming 7d avg by ${Math.abs(deviation).toFixed(1)}% today`,
        timestamp: new Date().toISOString(),
      };
    }
    else if (momentum24h !== momentum7d && Math.abs(change24h) >= 1.5) {
      const isBullish = momentum24h > momentum7d;
      signal = {
        coin: crypto.symbol.toUpperCase(),
        coinName: crypto.name,
        type: isBullish ? "bullish" : "bearish",
        priceChange24h: change24h,
        sentimentScore: sentimentScore,
        strength: Math.min(1, Math.abs(change24h) / 6),
        description: isBullish
          ? `Momentum shift: recovering from 7d downtrend`
          : `Momentum shift: weakening after 7d uptrend`,
        timestamp: new Date().toISOString(),
      };
    }
    
    if (signal) {
      signals.push(signal);
    }
  }
  
  if (signals.length === 0 && cryptos.length > 0) {
    const volatile = [...cryptos]
      .sort((a, b) => Math.abs(b.price_change_percentage_24h || 0) - Math.abs(a.price_change_percentage_24h || 0))
      .slice(0, 2);
    
    for (const crypto of volatile) {
      const change = crypto.price_change_percentage_24h || 0;
      if (Math.abs(change) >= 0.5) {
        signals.push({
          coin: crypto.symbol.toUpperCase(),
          coinName: crypto.name,
          type: change > 0 ? "bullish" : "bearish",
          priceChange24h: change,
          sentimentScore: sentimentScore,
          strength: Math.min(1, Math.abs(change) / 5),
          description: `24h: ${change > 0 ? '+' : ''}${change.toFixed(1)}% | 7d: ${(crypto.price_change_percentage_7d_in_currency || 0).toFixed(1)}%`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
  
  return signals.sort((a, b) => b.strength - a.strength).slice(0, 5);
}

export function calculateWhaleNetFlow(
  transactions: WhaleTransaction[],
  cryptos: CryptoData[] = []
): {
  netFlow: number;
  bullishness: number;
  inflow: number;
  outflow: number;
  largestTransaction: WhaleTransaction | null;
  volumeDelta: number;
  interpretation: string;
} {
  if (transactions.length > 0) {
    let inflow = 0;
    let outflow = 0;
    let largest: WhaleTransaction | null = null;
    
    for (const tx of transactions) {
      const isExchange = tx.to.includes("exchange") || 
                         tx.to.length < 20 ||
                         tx.type === "swap";
      
      if (isExchange) {
        outflow += tx.amountUsd || 0;
      } else {
        inflow += tx.amountUsd || 0;
      }
      
      if (!largest || (tx.amountUsd || 0) > (largest.amountUsd || 0)) {
        largest = tx;
      }
    }
    
    const netFlow = inflow - outflow;
    const total = inflow + outflow;
    const bullishness = total > 0 ? 0.5 + (netFlow / total) * 0.5 : 0.5;
    
    return {
      netFlow,
      bullishness: Math.max(0, Math.min(1, bullishness)),
      inflow,
      outflow,
      largestTransaction: largest,
      volumeDelta: 0,
      interpretation: netFlow > 0 ? "Accumulation detected" : "Distribution detected",
    };
  }
  
  if (cryptos.length > 0) {
    const btc = cryptos.find(c => c.symbol === "btc");
    const eth = cryptos.find(c => c.symbol === "eth");
    const sol = cryptos.find(c => c.symbol === "sol");
    
    let volumeScore = 0;
    let priceScore = 0;
    let count = 0;
    
    for (const crypto of [btc, eth, sol].filter(Boolean)) {
      if (!crypto) continue;
      
      const avgDailyVol = crypto.market_cap * 0.03;
      const volRatio = crypto.total_volume / avgDailyVol;
      volumeScore += volRatio > 1.2 ? 1 : volRatio < 0.8 ? -1 : 0;
      
      const priceChange = crypto.price_change_percentage_24h || 0;
      priceScore += priceChange > 2 ? 1 : priceChange < -2 ? -1 : 0;
      count++;
    }
    
    if (count > 0) {
      volumeScore /= count;
      priceScore /= count;
    }
    
    const combinedScore = (volumeScore + priceScore) / 2;
    const bullishness = 0.5 + combinedScore * 0.3;
    
    let interpretation = "Market neutral";
    if (combinedScore > 0.3) interpretation = "High volume + rising prices: Smart money buying";
    else if (combinedScore < -0.3) interpretation = "High volume + falling prices: Distribution likely";
    else if (volumeScore > 0.5) interpretation = "Volume spike detected - watch for breakout";
    else if (volumeScore < -0.5) interpretation = "Low volume - consolidation phase";
    
    const volumeDelta = ((volumeScore - 1) * 100);
    
    return {
      netFlow: combinedScore * 1000000,
      bullishness: Math.max(0.1, Math.min(0.9, bullishness)),
      inflow: Math.max(0, combinedScore) * 500000,
      outflow: Math.max(0, -combinedScore) * 500000,
      largestTransaction: null,
      volumeDelta,
      interpretation,
    };
  }
  
  return {
    netFlow: 0,
    bullishness: 0.5,
    inflow: 0,
    outflow: 0,
    largestTransaction: null,
    volumeDelta: 0,
    interpretation: "No data available",
  };
}

export function calculateCorrelations(
  cryptos: CryptoData[]
): CorrelationData[] {
  const correlations: CorrelationData[] = [];
  
  const btc = cryptos.find((c) => c.symbol === "btc");
  if (!btc || !btc.sparkline_in_7d?.price) return correlations;
  
  const btcPrices = btc.sparkline_in_7d.price;
  
  for (const crypto of cryptos) {
    if (crypto.symbol === "btc") continue;
    if (!crypto.sparkline_in_7d?.price) continue;
    
    const prices = crypto.sparkline_in_7d.price;
    const minLen = Math.min(btcPrices.length, prices.length);
    
    if (minLen < 10) continue;
    
    const btcReturns: number[] = [];
    const coinReturns: number[] = [];
    
    for (let i = 1; i < minLen; i++) {
      btcReturns.push((btcPrices[i] - btcPrices[i - 1]) / btcPrices[i - 1]);
      coinReturns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
    
    const correlation = pearsonCorrelation(btcReturns, coinReturns);
    
    let trend: "strengthening" | "weakening" | "stable" = "stable";
    let correlation24h = correlation;
    let correlationDelta24h = 0;
    
    // Calculate 24h correlation and delta
    // Sparkline has ~168 data points (hourly for 7 days)
    // Last 24 points = last 24 hours
    if (minLen >= 48) {
      // Recent 24h correlation
      const recent24hBtc = btcReturns.slice(-24);
      const recent24hCoin = coinReturns.slice(-24);
      correlation24h = pearsonCorrelation(recent24hBtc, recent24hCoin);
      
      // Previous 24h correlation (24-48 hours ago)
      const prev24hBtc = btcReturns.slice(-48, -24);
      const prev24hCoin = coinReturns.slice(-48, -24);
      const prevCorrelation = pearsonCorrelation(prev24hBtc, prev24hCoin);
      
      // Delta = change in correlation over 24 hours
      correlationDelta24h = correlation24h - prevCorrelation;
      
      // Trend based on correlation change
      if (correlationDelta24h > 0.1) trend = "strengthening";
      else if (correlationDelta24h < -0.1) trend = "weakening";
    }
    
    correlations.push({
      coin: crypto.symbol.toUpperCase(),
      coinName: crypto.name,
      correlationWithBTC: correlation,
      correlation24h,
      correlationDelta24h,
      trend,
      strength: Math.abs(correlation) > 0.7 ? "strong" : Math.abs(correlation) > 0.4 ? "moderate" : "weak",
    });
  }
  
  return correlations.sort((a, b) => Math.abs(b.correlationWithBTC) - Math.abs(a.correlationWithBTC));
}

export type DivergenceRegime = {
  regime: 'mean_reversion' | 'breakout' | 'pairs' | 'neutral';
  confidence: number;
  modifiers: {
    meanReversion: number;
    volExpansion: number;
    pairsTrading: number;
  };
  summary: string;
  bullishCount: number;
  bearishCount: number;
  avgStrength: number;
  spreadScore: number;
};

let cachedDivergenceRegime: DivergenceRegime | null = null;

export function getDivergenceRegime(): DivergenceRegime | null {
  return cachedDivergenceRegime;
}

export function computeDivergenceRegime(divergences: DivergenceSignal[]): DivergenceRegime {
  if (!divergences || divergences.length === 0) {
    const neutral: DivergenceRegime = {
      regime: 'neutral',
      confidence: 0,
      modifiers: { meanReversion: 0, volExpansion: 0, pairsTrading: 0 },
      summary: 'No divergences detected',
      bullishCount: 0,
      bearishCount: 0,
      avgStrength: 0,
      spreadScore: 0,
    };
    cachedDivergenceRegime = neutral;
    return neutral;
  }

  const bullish = divergences.filter(d => d.type === 'bullish');
  const bearish = divergences.filter(d => d.type === 'bearish');
  const bullishCount = bullish.length;
  const bearishCount = bearish.length;
  const totalCount = divergences.length;
  const avgStrength = divergences.reduce((s, d) => s + d.strength, 0) / totalCount;

  const bullishStrength = bullish.reduce((s, d) => s + d.strength, 0);
  const bearishStrength = bearish.reduce((s, d) => s + d.strength, 0);

  const directionBalance = totalCount > 0 ? Math.abs(bullishCount - bearishCount) / totalCount : 0;
  const spreadScore = 1 - directionBalance;

  let mrMod = 0;
  let veMod = 0;
  let ptMod = 0;
  let regime: DivergenceRegime['regime'] = 'neutral';
  let summary = '';

  const strongDivergences = divergences.filter(d => d.strength >= 0.6);
  const extremePrice = divergences.filter(d => Math.abs(d.priceChange24h) >= 5);

  if (spreadScore >= 0.5 && totalCount >= 3) {
    regime = 'pairs';
    ptMod = Math.min(0.15, spreadScore * avgStrength * 0.3);
    mrMod = ptMod * 0.3;
    veMod = -ptMod * 0.2;
    summary = `Mixed divergences (${bullishCount}B/${bearishCount}S) - pairs opportunities`;
  } else if (bullishCount > bearishCount && bullishStrength > bearishStrength * 1.5) {
    if (strongDivergences.length >= 2 || extremePrice.length >= 1) {
      regime = 'breakout';
      veMod = Math.min(0.15, avgStrength * 0.2);
      mrMod = -veMod * 0.3;
      ptMod = 0;
      summary = `Strong bullish divergences (${bullishCount}) with high strength - breakout likely`;
    } else {
      regime = 'mean_reversion';
      mrMod = Math.min(0.15, avgStrength * 0.25);
      veMod = -mrMod * 0.2;
      ptMod = 0;
      summary = `Bullish divergences (${bullishCount}) - mean reversion setups forming`;
    }
  } else if (bearishCount > bullishCount && bearishStrength > bullishStrength * 1.5) {
    if (strongDivergences.length >= 2 || extremePrice.length >= 1) {
      regime = 'breakout';
      veMod = Math.min(0.15, avgStrength * 0.2);
      mrMod = -veMod * 0.3;
      ptMod = 0;
      summary = `Strong bearish divergences (${bearishCount}) with high strength - breakdown likely`;
    } else {
      regime = 'mean_reversion';
      mrMod = Math.min(0.15, avgStrength * 0.25);
      veMod = -mrMod * 0.2;
      ptMod = 0;
      summary = `Bearish divergences (${bearishCount}) - mean reversion setups forming`;
    }
  } else {
    regime = 'neutral';
    summary = `Balanced divergences (${bullishCount}B/${bearishCount}S) - no strong regime signal`;
  }

  const confidence = Math.min(1, avgStrength * (totalCount / 5));

  const result: DivergenceRegime = {
    regime,
    confidence,
    modifiers: {
      meanReversion: mrMod,
      volExpansion: veMod,
      pairsTrading: ptMod,
    },
    summary,
    bullishCount,
    bearishCount,
    avgStrength,
    spreadScore,
  };

  cachedDivergenceRegime = result;
  return result;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return 0;
  
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
  const sumX2 = x.reduce((a, b) => a + b * b, 0);
  const sumY2 = y.reduce((a, b) => a + b * b, 0);
  
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  
  if (denominator === 0) return 0;
  return numerator / denominator;
}
