import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { getTopCryptos, getCachedCryptos } from "./services/coingecko";
import { getBitcoinSentiment, getCachedSentiment } from "./services/senticrypt";
import { getWhaleTransactions, getCachedWhaleTransactions } from "./services/helius";
import { getCryptoMarkets, getCachedPolymarkets } from "./services/polymarket";
import { getLiquidations, calculateLiquidationClusters, calculateVolatilityZones, getCachedLiquidations } from "./services/liquidations";
import { generateMarketInsight, getCachedInsight } from "./services/aiAnalysis";
import { detectDivergences, calculateWhaleNetFlow, calculateCorrelations, computeDivergenceRegime, getDivergenceRegime } from "./services/signals";
import { generatePredictions, resolvePredictions, getAllPredictionData } from "./services/aiPredictions";
import { getFlowMetrics } from "./services/defillama";
import { calculateOnChainMetrics } from "./services/onchainMetrics";
import { 
  getPortfolioState, 
  getTrades, 
  getTradingStats, 
  updatePositionPrices,
  updateDynamicOrders,
  activeTradeManager,
  openPosition, 
  closePosition, 
  closePositionsBySymbol,
  closeAllPositions,
  resetPortfolio,
  fullResetPortfolio,
  getBrokerConfig,
  startTrading,
  stopTrading,
  isTradingEnabled,
  getEquityCurve,
  seedEquityCurve,
  restoreTradingState,
  syncHLAccountState,
  createSyntheticPosition,
  startHLPositionSync,
  getHLConnectionHealth
} from "./services/paperTrading";
import { analyzeMarketForTrades, getAITradeAdvice, getQuantStrategyStats, isInBootstrapPhase } from "./services/aiTrader";
import { restoreLivePerformance } from "./services/quantStrategy";
import { calculate4HATR } from "./services/syntheticWarmup";
import { getPortfolioMetricValue, isDrawdownProtectionActive, getPortfolioMetricHistory, loadEquityCurveFromHistory } from "./services/portfolioMetric";
import { getEquityCurveState, loadHistoryFromSnapshots, restoreState, updateReversalState, getReversalState, updateDailyProfitTarget, getDailyProfitTarget } from "./services/equityCurveManager";
import { get4HCandles, type OHLCCandle } from "./services/coingecko";
import { 
  analyzeCorrelationOpportunities, 
  getCorrelationStrategyMetrics, 
  getOverallRiskMetrics,
  getCorrelationMatrix,
  getActivePairs,
  enableCorrelationStrategy,
  disableCorrelationStrategy,
  isCorrelationStrategyEnabled,
  updatePriceHistory,
  getPriceHistoryMaps
} from "./services/correlationStrategy";
import { getBinanceTop15 } from "./services/binanceCandles";
import { getHLRealtimePrices } from "./services/hyperliquid/infoClient";
import { generateBasketSignals, getBasketState, getSymbolsToClose, shouldRebalance, scanMomentum, checkScaleInConfirmations, getScaleInState, resetBasketState, setConfirmationMode, getConfirmationMode, computeAndSaveMetaStats, getLatestMetaStats, loadLatestMetaStats, getMarketRegime, onEntryFailed, onEntrySucceeded, type ConfirmationMode } from "./services/basketStrategy";
import { registerRegimeProvider, setBatchEquityMode, recordEquityEvent } from "./services/paperTrading";

const clients = new Set<WebSocket>();

async function broadcastCryptoUpdate() {
  try {
    const cryptos = await getTopCryptos();
    
    updatePriceHistory(cryptos);
    
    const message = JSON.stringify({
      type: "crypto_update",
      data: cryptos,
    });
    
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  } catch (error) {
    console.error("[WS] Failed to broadcast crypto update:", error);
  }
}

async function broadcastSentimentUpdate() {
  try {
    const sentiment = await getBitcoinSentiment();
    const message = JSON.stringify({
      type: "sentiment_update",
      data: sentiment,
    });
    
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  } catch (error) {
    console.error("[WS] Failed to broadcast sentiment update:", error);
  }
}

async function broadcastWhaleAlerts() {
  try {
    const whales = await getWhaleTransactions();
    
    whales.forEach((whale) => {
      const message = JSON.stringify({
        type: "whale_alert",
        data: whale,
      });
      
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    });
  } catch (error) {
    console.error("[WS] Failed to broadcast whale alerts:", error);
  }
}

async function broadcastSignals() {
  try {
    const cryptos = getCachedCryptos();
    const sentiment = getCachedSentiment();
    const whales = getCachedWhaleTransactions();
    
    if (!cryptos) return;
    
    const divergences = detectDivergences(cryptos, sentiment);
    computeDivergenceRegime(divergences);
    const whaleFlow = calculateWhaleNetFlow(whales, cryptos);
    const correlations = calculateCorrelations(cryptos);
    
    const signalMessage = JSON.stringify({
      type: "signals_update",
      data: { divergences, whaleFlow, correlations },
    });
    
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(signalMessage);
      }
    });
  } catch (error) {
    console.error("[WS] Failed to broadcast signals:", error);
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", async (ws) => {
    console.log("[WS] Client connected");
    clients.add(ws);

    ws.send(JSON.stringify({
      type: "connection_status",
      data: { connected: true, message: "Connected to CryptoPulse Live" },
    }));

    const cachedCryptos = getCachedCryptos();
    if (cachedCryptos) {
      ws.send(JSON.stringify({
        type: "crypto_update",
        data: cachedCryptos,
      }));
      
      const sentiment = getCachedSentiment();
      const whales = getCachedWhaleTransactions();
      const divergences = detectDivergences(cachedCryptos, sentiment);
      computeDivergenceRegime(divergences);
      const whaleFlow = calculateWhaleNetFlow(whales, cachedCryptos);
      const correlations = calculateCorrelations(cachedCryptos);
      
      ws.send(JSON.stringify({
        type: "signals_update",
        data: { divergences, whaleFlow, correlations },
      }));
    }

    const cachedSentiment = getCachedSentiment();
    if (cachedSentiment) {
      ws.send(JSON.stringify({
        type: "sentiment_update",
        data: cachedSentiment,
      }));
    }

    const cachedWhales = getCachedWhaleTransactions();
    if (cachedWhales.length > 0) {
      cachedWhales.forEach((whale) => {
        ws.send(JSON.stringify({
          type: "whale_alert",
          data: whale,
        }));
      });
    }

    ws.on("close", () => {
      console.log("[WS] Client disconnected");
      clients.delete(ws);
    });

    ws.on("error", (error) => {
      console.error("[WS] Client error:", error);
      clients.delete(ws);
    });
  });

  let cryptoInterval: ReturnType<typeof setInterval>;
  let sentimentInterval: ReturnType<typeof setInterval>;
  let whaleInterval: ReturnType<typeof setInterval>;
  let signalsInterval: ReturnType<typeof setInterval>;
  setTimeout(() => {
    cryptoInterval = setInterval(broadcastCryptoUpdate, 30000);
    sentimentInterval = setInterval(broadcastSentimentUpdate, 120000);
    whaleInterval = setInterval(broadcastWhaleAlerts, 15000);
    signalsInterval = setInterval(broadcastSignals, 30000);
    console.log("[Init] Broadcast intervals started (delayed 30s)");
  }, 30000);
  
  const timerStartTimes = {
    serverStart: Date.now(),
  };

  const positionManagementInterval = setInterval(async () => {
    if (!isTradingEnabled()) return;
    
    const portfolio = getPortfolioState();
    
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[10m HUD] TRADE MANAGEMENT - ${new Date().toLocaleString()}`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`Portfolio: $${portfolio.equity.toFixed(2)} | PnL: ${portfolio.totalPnlPercent >= 0 ? '+' : ''}${portfolio.totalPnlPercent.toFixed(2)}%`);
    console.log(`Positions: ${portfolio.positions.length} | Drawdown: ${portfolio.currentDrawdown.toFixed(2)}%`);
    
    if (portfolio.positions.length === 0) {
      console.log(`\nNo open positions - Waiting for basket entry signals...`);
      console.log(`${'─'.repeat(60)}\n`);
      return;
    }
    
    for (const position of portfolio.positions) {
      try {
        const candles = await get4HCandles(position.symbol.toLowerCase(), 14);
        if (candles.length < 14) continue;
        
        const atr4H = calculate4HATR(candles, 14);
        const currentPrice = position.currentPrice;
        const entryPrice = position.entryPrice;
        const pnlPercent = ((currentPrice - entryPrice) / entryPrice * 100) * (position.side === 'long' ? 1 : -1);
        
        console.log(`\n   ${position.symbol} (${position.side.toUpperCase()}):`);
        console.log(`   Entry: $${entryPrice.toFixed(2)} -> Current: $${currentPrice.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`);
        console.log(`   Stop: $${position.stopLoss.toFixed(2)} | TP: $${position.takeProfit?.toFixed(2) ?? 'N/A'}`);
        
        const favorableMove = position.side === 'long' 
          ? currentPrice - entryPrice 
          : entryPrice - currentPrice;
        const favorableATRs = favorableMove / atr4H;
        
        if (favorableMove > 0.5 * atr4H) {
          const newStop = position.side === 'long'
            ? Math.max(position.stopLoss, currentPrice - atr4H)
            : Math.min(position.stopLoss, currentPrice + atr4H);
          
          const shouldUpdate = position.side === 'long' 
            ? newStop > position.stopLoss 
            : newStop < position.stopLoss;
          
          if (shouldUpdate) {
            console.log(`   Trailing stop: $${position.stopLoss.toFixed(2)} -> $${newStop.toFixed(2)} (${favorableATRs.toFixed(2)} ATRs)`);
            position.stopLoss = newStop;
          }
        }
      } catch (error) {
        console.error(`   ${position.symbol}: Error - ${error}`);
      }
    }
    
    console.log(`${'─'.repeat(60)}\n`);
  }, 10 * 60 * 1000);

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  (async () => {
    try {
      console.log("[Init] Stage 1/7: Fetching market data (sequential)...");
      await getTopCryptos().catch((e) => console.error("[Init] Failed to fetch cryptos:", e));
      await sleep(500);
      await getBitcoinSentiment().catch((e) => console.error("[Init] Failed to fetch sentiment:", e));
      await sleep(500);
      await getWhaleTransactions().catch((e) => console.error("[Init] Failed to fetch whales:", e));
      await sleep(500);
      await getCryptoMarkets().catch((e) => console.error("[Init] Failed to fetch polymarket:", e));
      await sleep(500);
      await getLiquidations().catch((e) => console.error("[Init] Failed to fetch liquidations:", e));
      console.log("[Init] Stage 1/7 complete: Market data fetched");

      await sleep(1000);

      console.log("[Init] Stage 2/7: Restoring trading state from database...");
      await restoreTradingState().catch(e => console.error("[Init] Trading state restore error:", e));
      console.log("[Init] Stage 2/7 complete: Trading state restored");

      await sleep(500);

      console.log("[Init] Stage 3/7: Seeding equity curve...");
      try {
        const historicalEquity = await loadEquityCurveFromHistory(2000);
        if (historicalEquity.length > 0) {
          seedEquityCurve(historicalEquity);
        } else {
          const portfolio = getPortfolioState();
          seedEquityCurve([{ timestamp: Date.now(), equity: portfolio.equity }]);
          console.log(`[Init] No historical equity data - seeded curve with current equity $${portfolio.equity.toFixed(2)}`);
        }
      } catch (e) {
        console.error("[Init] Equity curve seeding error:", e);
      }
      console.log("[Init] Stage 3/7 complete: Equity curve seeded");

      await sleep(500);

      console.log("[Init] Stage 4/7: Restoring live performance...");
      const liveRestored = await restoreLivePerformance().catch(() => false);
      if (liveRestored) console.log("[Init] Restored live performance data from DB");
      await sleep(300);
      const ecState = await loadHistoryFromSnapshots().catch(() => null);
      if (ecState) {
        restoreState(ecState);
        console.log("[Init] Restored Equity Curve state from DB");
      }
      console.log("[Init] Stage 4/7 complete: Performance data restored");

      await sleep(1000);

      console.log("[Init] Stage 5/7: Fetching Binance top 15 rankings...");
      const top15 = await getBinanceTop15().catch(() => []);
      if (top15.length > 0) {
        console.log(`[Init] Stage 5/7 complete: Top 15 rankings ready (${top15.length} coins, candles via HL)`);
      } else {
        console.log("[Init] Stage 5/7 skipped: No top 15 data from Binance");
      }

      await sleep(500);

      console.log("[Init] Stage 6/7: HL init and position adoption...");
      const { loadTestnetCoins, loadCoinMeta } = await import("./services/hyperliquid/config");
      await loadTestnetCoins();
      await loadCoinMeta();
      await loadLatestMetaStats();
      registerRegimeProvider(getMarketRegime);

      try {
        const { hlCancelAllOrders } = await import("./services/hyperliquid/adapter");
        const { getOpenPositions } = await import("./services/hyperliquid/infoClient");
        const { HL_TO_SYMBOL } = await import("./services/hyperliquid/config");
        await hlCancelAllOrders();
        const hlPositions = await getOpenPositions();
        console.log(`[HL Adopt] HL has ${hlPositions.length} open positions — adopting as system of record`);
        for (const hlPos of hlPositions) {
          const displaySymbol = HL_TO_SYMBOL[hlPos.coin] || hlPos.coin;
          createSyntheticPosition(displaySymbol, hlPos.side, hlPos.size, hlPos.entryPrice);
          console.log(`[HL Adopt] ${displaySymbol} ${hlPos.side} size=${hlPos.size} @ $${hlPos.entryPrice.toFixed(4)}`);
        }
      } catch (e) {
        console.error("[Init] HL position adoption error:", e);
      }
      console.log("[Init] Stage 6/7 complete: HL positions adopted");

      await sleep(500);

      console.log("[Init] Stage 7/7: Computing regime (no trades on startup)...");
      await computeAndSaveMetaStats();
      const initRegime = getMarketRegime();
      const portfolio = getPortfolioState();
      console.log(`[Init] Regime: ${initRegime.regime} (MOM=${initRegime.momNorm.toFixed(3)}, ${initRegime.volRegime})`);
      console.log(`[Init] Positions: ${portfolio.positions.length} adopted from HL, equity: $${portfolio.equity.toFixed(2)}`);
      console.log("[Init] Stage 7/7 complete: Startup finished — waiting for next 30min cycle to trade");
      startHLPositionSync();
    } catch (e) {
      console.error("[Init] Startup error:", e);
    }
  })();

  httpServer.on("close", () => {
    clearInterval(cryptoInterval);
    clearInterval(sentimentInterval);
    clearInterval(whaleInterval);
    clearInterval(signalsInterval);
    clearInterval(positionManagementInterval);
    wss.close();
  });

  app.get("/api/crypto", async (req, res) => {
    try {
      const cryptos = await getTopCryptos();
      res.json(cryptos);
    } catch (error) {
      console.error("[API] /api/crypto error:", error);
      res.status(500).json({ error: "Failed to fetch cryptocurrency data" });
    }
  });

  app.get("/api/sentiment", async (req, res) => {
    try {
      const sentiment = await getBitcoinSentiment();
      res.json(sentiment);
    } catch (error) {
      console.error("[API] /api/sentiment error:", error);
      res.status(500).json({ error: "Failed to fetch sentiment data" });
    }
  });

  app.get("/api/whales", async (req, res) => {
    try {
      const whales = await getWhaleTransactions();
      res.json(whales);
    } catch (error) {
      console.error("[API] /api/whales error:", error);
      res.status(500).json({ error: "Failed to fetch whale transactions" });
    }
  });

  app.get("/api/polymarket", async (req, res) => {
    try {
      const markets = await getCryptoMarkets();
      res.json(markets);
    } catch (error) {
      console.error("[API] /api/polymarket error:", error);
      res.status(500).json({ error: "Failed to fetch prediction markets" });
    }
  });

  app.get("/api/liquidations", async (req, res) => {
    try {
      const liquidations = await getLiquidations();
      const clusters = calculateLiquidationClusters(liquidations);
      const cryptos = getCachedCryptos() || [];
      const volatilityZones = calculateVolatilityZones(cryptos);
      res.json({ liquidations, clusters, volatilityZones });
    } catch (error) {
      console.error("[API] /api/liquidations error:", error);
      res.status(500).json({ error: "Failed to fetch liquidation data" });
    }
  });

  app.get("/api/signals", async (req, res) => {
    try {
      const cryptos = getCachedCryptos() || await getTopCryptos();
      const sentiment = getCachedSentiment();
      const whales = getCachedWhaleTransactions();
      
      const divergences = detectDivergences(cryptos, sentiment);
      const whaleFlow = calculateWhaleNetFlow(whales, cryptos);
      const correlations = calculateCorrelations(cryptos);
      
      res.json({ divergences, whaleFlow, correlations });
    } catch (error) {
      console.error("[API] /api/signals error:", error);
      res.status(500).json({ error: "Failed to calculate signals" });
    }
  });

  app.get("/api/ai-insight", async (req, res) => {
    try {
      const cryptos = getCachedCryptos() || await getTopCryptos();
      const sentiment = getCachedSentiment();
      const polymarket = getCachedPolymarkets();
      
      const insight = await generateMarketInsight(cryptos, sentiment, polymarket);
      res.json(insight);
    } catch (error) {
      console.error("[API] /api/ai-insight error:", error);
      res.status(500).json({ error: "Failed to generate AI insight" });
    }
  });

  app.get("/api/predictions", async (req, res) => {
    try {
      const cryptos = getCachedCryptos() || await getTopCryptos();
      const sentiment = getCachedSentiment();
      const sentimentScore = sentiment?.score ?? 0;
      
      await resolvePredictions(cryptos);
      await generatePredictions(cryptos, sentimentScore);
      
      const data = getAllPredictionData();
      res.json(data);
    } catch (error) {
      console.error("[API] /api/predictions error:", error);
      res.status(500).json({ error: "Failed to get predictions" });
    }
  });

  app.get("/api/flows", async (req, res) => {
    try {
      const flows = await getFlowMetrics();
      res.json(flows);
    } catch (error) {
      console.error("[API] /api/flows error:", error);
      res.status(500).json({ error: "Failed to fetch flow metrics" });
    }
  });

  app.get("/api/onchain", async (req, res) => {
    try {
      const cryptos = getCachedCryptos() || await getTopCryptos();
      const metrics = calculateOnChainMetrics(cryptos);
      res.json(metrics);
    } catch (error) {
      console.error("[API] /api/onchain error:", error);
      res.status(500).json({ error: "Failed to calculate on-chain metrics" });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      websocketClients: clients.size,
      cachedData: {
        cryptos: getCachedCryptos()?.length ?? 0,
        sentiment: getCachedSentiment() !== null,
        whales: getCachedWhaleTransactions().length,
        polymarket: getCachedPolymarkets().length,
        liquidations: getCachedLiquidations().length,
        aiInsight: getCachedInsight() !== null,
      },
    });
  });

  app.get("/api/portfolio", async (req, res) => {
    try {
      await syncHLAccountState();
      const hlPrices = await getHLRealtimePrices();
      if (hlPrices.size > 0) {
        await updatePositionPrices(hlPrices);
      }
      
      const portfolio = getPortfolioState();
      res.json(portfolio);
    } catch (error) {
      console.error("[API] /api/portfolio error:", error);
      res.status(500).json({ error: "Failed to get portfolio" });
    }
  });

  app.get("/api/trades", async (req, res) => {
    try {
      const trades = getTrades();
      res.json(trades);
    } catch (error) {
      console.error("[API] /api/trades error:", error);
      res.status(500).json({ error: "Failed to get trades" });
    }
  });

  app.get("/api/trading-stats", async (req, res) => {
    try {
      const stats = getTradingStats();
      res.json(stats);
    } catch (error) {
      console.error("[API] /api/trading-stats error:", error);
      res.status(500).json({ error: "Failed to get trading stats" });
    }
  });

  app.get("/api/quant-strategy", async (req, res) => {
    try {
      const stats = getQuantStrategyStats();
      res.json({
        ...stats,
        description: "Multi-factor quantitative strategy using RSI, MACD, Bollinger Bands, moving averages, MVRV, and capital flows",
        status: stats.totalTrades < 10 ? "Learning" : 
          stats.winRate >= 50 && stats.profitFactor >= 1.5 ? "Performing" :
          stats.winRate >= 40 && stats.profitFactor >= 1 ? "Stable" : "Adapting"
      });
    } catch (error) {
      console.error("[API] /api/quant-strategy error:", error);
      res.status(500).json({ error: "Failed to get quant strategy stats" });
    }
  });

  app.get("/api/trading-status", async (req, res) => {
    res.json({ 
      active: isTradingEnabled(),
      correlationEnabled: isCorrelationStrategyEnabled()
    });
  });

  app.get("/api/hl-status", async (req, res) => {
    try {
      const { getExecutionMode } = await import("./services/hyperliquid/config");
      const mode = getExecutionMode();
      if (mode !== "hyperliquid") {
        res.json({ enabled: false, mode: "internal" });
        return;
      }
      const { hlGetAccountSummary, hlGetPortfolio } = await import("./services/hyperliquid/adapter");
      const summary = await hlGetAccountSummary();
      const portfolio = await hlGetPortfolio();
      const health = getHLConnectionHealth();
      const positionDetails = portfolio.positions.map(p => ({
        coin: p.coin,
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealizedPnl: p.unrealizedPnl,
        leverage: p.leverage,
        marginUsed: p.marginUsed,
      }));
      res.json({ enabled: true, ...summary, positionDetails, connectionHealth: health });
    } catch (error) {
      console.error("[API] /api/hl-status error:", error);
      const health = getHLConnectionHealth();
      res.json({ enabled: false, mode: "internal", error: "Failed to get HL status", connectionHealth: health });
    }
  });
  
  // Mode stats endpoint - basket strategy status
  app.get("/api/mode-stats", async (req, res) => {
    try {
      const basket = getBasketState();
      const rankings = basket.rankings;
      const portfolio = getPortfolioState();
      
      const basketPositions = portfolio.positions;
      const totalExposure = basketPositions.reduce((sum, p) => sum + (p.quantity * p.currentPrice), 0);
      const totalUnrealized = basketPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
      const maxBudget = portfolio.equity * 0.25;
      
      const openSymbols = new Set(basketPositions.map(p => `${p.symbol.toUpperCase()}_${p.side}`));
      const activeLongs = basket.longBasket.filter(r => openSymbols.has(`${r.symbol}_long`)).map(r => r.symbol);
      const activeShorts = basket.shortBasket.filter(r => openSymbols.has(`${r.symbol}_short`)).map(r => r.symbol);
      const pendingLongs = [...basket.pendingLongs];
      const pendingShorts = [...basket.pendingShorts];
      
      const now = Date.now();
      const nextRebalanceMs = basket.lastRebalance > 0 ? Math.max(0, basket.nextRebalance - now) : 0;
      
      const scaleIn = getScaleInState();
      
      res.json({
        strategyMode: 'basket',
        signalInversion: false,
        confirmationMode: getConfirmationMode(),
        basket: {
          longSymbols: activeLongs,
          shortSymbols: activeShorts,
          pendingLongs,
          pendingShorts,
          totalExposure: Number(totalExposure.toFixed(2)),
          maxBudget: Number(maxBudget.toFixed(2)),
          exposurePercent: Number(((totalExposure / portfolio.equity) * 100).toFixed(1)),
          totalUnrealized: Number(totalUnrealized.toFixed(2)),
          positionCount: basketPositions.length,
          lastRebalance: basket.lastRebalance > 0 ? new Date(basket.lastRebalance).toISOString() : null,
          nextRebalanceMs,
          scaleIn,
        },
        rankings: rankings.map(r => ({
          symbol: r.symbol,
          coinName: r.coinName,
          price: r.price,
          momentum30m: Number(r.momentum30m.toFixed(4)),
          confirmed: r.confirmed,
          atrPercent: Number(r.atrPercent.toFixed(3)),
          inLongBasket: activeLongs.includes(r.symbol),
          inShortBasket: activeShorts.includes(r.symbol),
        })),
        timers: {
          nextRebalanceMs,
          rebalanceIntervalMs: 30 * 60 * 1000,
          uptimeMs: now - timerStartTimes.serverStart,
        },
        metaStats: (() => {
          const ms = getLatestMetaStats();
          if (!ms) return null;
          return {
            momMax: Number(ms.momMax.toFixed(4)),
            momMin: Number(ms.momMin.toFixed(4)),
            momAvg: Number(ms.momAvg.toFixed(4)),
            momSum: Number(ms.momSum.toFixed(4)),
            momSumNormalized: Number(ms.momSumNormalized.toFixed(4)),
            atrMax: Number(ms.atrMax.toFixed(4)),
            atrMin: Number(ms.atrMin.toFixed(4)),
            atrAvg: Number(ms.atrAvg.toFixed(4)),
            atrSum: Number(ms.atrSum.toFixed(4)),
            coinCount: ms.coinCount,
            updatedAt: ms.createdAt,
          };
        })(),
        regime: (() => {
          const r = getMarketRegime();
          return {
            regime: r.regime,
            momNorm: r.momNorm,
            atrAvg: r.atrAvg,
            volRegime: r.volRegime,
            longMultiplier: r.longMultiplier,
            shortMultiplier: r.shortMultiplier,
            scaleInEnabled: r.scaleInEnabled,
            scaleInDirection: r.scaleInDirection,
            portfolioStopPercent: r.portfolioStopPercent,
          };
        })(),
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[API] Error getting mode stats:", error);
      res.status(500).json({ error: "Failed to get mode stats" });
    }
  });

  app.post("/api/basket-confirmation-mode", (req, res) => {
    try {
      const { mode } = req.body;
      if (mode !== '5m' && mode !== '1m') {
        return res.status(400).json({ error: "Invalid mode. Must be '5m' or '1m'" });
      }
      setConfirmationMode(mode as ConfirmationMode);
      res.json({ confirmationMode: mode });
    } catch (error) {
      console.error("[API] Error setting confirmation mode:", error);
      res.status(500).json({ error: "Failed to set confirmation mode" });
    }
  });

  app.get("/api/equity-curve", (req, res) => {
    try {
      res.json(getEquityCurve());
    } catch (error) {
      console.error("[API] Error getting equity curve:", error);
      res.status(500).json({ error: "Failed to get equity curve" });
    }
  });

  app.post("/api/trade/start", async (req, res) => {
    startTrading();
    enableCorrelationStrategy();
    res.json({ success: true, active: true, message: "Trading started" });
  });

  app.post("/api/trade/stop", async (req, res) => {
    stopTrading();
    disableCorrelationStrategy();
    res.json({ success: true, active: false, message: "Trading stopped" });
  });

  app.get("/api/risk-metrics", async (req, res) => {
    try {
      const overallMetrics = getOverallRiskMetrics();
      const correlationMetrics = getCorrelationStrategyMetrics();
      const quantStats = getQuantStrategyStats();
      
      res.json({
        overall: overallMetrics,
        correlation: correlationMetrics,
        quant: {
          winRate: quantStats.winRate,
          profitFactor: quantStats.profitFactor,
          expectancy: quantStats.expectancy,
        },
        portfolioMetric: {
          name: "Portfolio Metric",
          value: overallMetrics.sharpeUlcerRatio,
          description: "Sharpe / Ulcer ratio - drawdown protection activates below 0",
          drawdownProtectionActive: isDrawdownProtectionActive(),
        },
        equityCurve: getEquityCurveState(),
        reversal: getReversalState(),
        dailyTarget: getDailyProfitTarget(),
      });
    } catch (error) {
      console.error("[API] /api/risk-metrics error:", error);
      res.status(500).json({ error: "Failed to get risk metrics" });
    }
  });

  app.get("/api/portfolio-metric-history", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const history = await getPortfolioMetricHistory(limit);
      res.json({
        current: {
          value: getPortfolioMetricValue(),
          drawdownProtectionActive: isDrawdownProtectionActive(),
        },
        history,
      });
    } catch (error) {
      console.error("[API] /api/portfolio-metric-history error:", error);
      res.status(500).json({ error: "Failed to get portfolio metric history" });
    }
  });

  app.get("/api/equity-curve-state", async (req, res) => {
    try {
      const ecState = getEquityCurveState();
      res.json({
        rawMetric: ecState.rawMetric,
        normalizedMetric: ecState.normalizedMetric,
        zScore: ecState.zScore,
        emaValue: ecState.emaValue,
        momentum: ecState.momentum,
        regime: ecState.regime,
        sizeMultiplier: ecState.sizeMultiplier,
        lossDirection: ecState.lossDirection,
        lossDirectionRatio: ecState.lossDirectionRatio,
        recoveryModeActive: ecState.recoveryModeActive,
        invertSignals: ecState.invertSignals,
        consecutiveNegativeSnapshots: ecState.consecutiveNegativeSnapshots,
        totalClosedTrades: ecState.totalClosedTrades,
        shortLosses: ecState.shortLosses,
        longLosses: ecState.longLosses,
        lastUpdated: ecState.lastUpdated,
      });
    } catch (error) {
      console.error("[API] /api/equity-curve error:", error);
      res.status(500).json({ error: "Failed to get equity curve state" });
    }
  });

  app.get("/api/correlation-pairs", async (req, res) => {
    try {
      const matrix = getCorrelationMatrix();
      const activePairs = getActivePairs();
      
      res.json({
        correlationMatrix: matrix,
        activePairs,
        enabled: isCorrelationStrategyEnabled()
      });
    } catch (error) {
      console.error("[API] /api/correlation-pairs error:", error);
      res.status(500).json({ error: "Failed to get correlation data" });
    }
  });

  app.post("/api/trade/analyze", async (req, res) => {
    try {
      if (!isTradingEnabled()) {
        res.json({ 
          signals: [], 
          executedTrades: [], 
          portfolio: getPortfolioState(),
          message: "Trading is stopped. Click Start to begin trading.",
          timestamp: new Date().toISOString() 
        });
        return;
      }

      const cryptos = getCachedCryptos() || await getTopCryptos();
      const sentiment = getCachedSentiment();
      const liquidations = getCachedLiquidations();
      
      const priceMap = new Map(cryptos.map(c => [c.symbol.toLowerCase(), c.current_price]));
      await updatePositionPrices(priceMap);
      
      const signalsData = {
        divergences: detectDivergences(cryptos, sentiment),
        whaleFlow: calculateWhaleNetFlow(getCachedWhaleTransactions(), cryptos),
        correlations: calculateCorrelations(cryptos),
      };
      
      let onchainData = null;
      let capitalFlowData = null;
      
      try {
        onchainData = calculateOnChainMetrics(cryptos);
      } catch (e) {
        console.log("Onchain metrics unavailable");
      }
      
      try {
        capitalFlowData = await getFlowMetrics();
      } catch (e) {
        console.log("Capital flow metrics unavailable");
      }
      
      const clusters = calculateLiquidationClusters(liquidations);
      
      const signals = await analyzeMarketForTrades({
        cryptos,
        sentiment,
        signals: signalsData,
        onchain: onchainData,
        capitalFlow: capitalFlowData,
        liquidations: clusters,
      });
      
      const executedTrades = [];
      for (const signal of signals) {
        if (signal.side) {
          const position = await openPosition(signal);
          if (position) {
            executedTrades.push({
              signal,
              position,
              status: "opened",
              strategy: "quant",
            });
          }
        }
      }
      
      const correlationResult = await analyzeCorrelationOpportunities(cryptos);
      
      for (const trade of correlationResult.executedTrades) {
        executedTrades.push({
          ...trade,
          strategy: "correlation",
        });
      }
      
      const riskMetrics = getOverallRiskMetrics();
      
      res.json({
        signals: [...signals, ...correlationResult.signals],
        executedTrades,
        portfolio: getPortfolioState(),
        riskMetrics: {
          sharpeRatio: riskMetrics.sharpeRatio,
          ulcerIndex: riskMetrics.ulcerIndex,
          sharpeUlcerRatio: riskMetrics.sharpeUlcerRatio,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[API] /api/trade/analyze error:", error);
      res.status(500).json({ error: "Failed to analyze trades" });
    }
  });

  app.post("/api/trade/close/:positionId", async (req, res) => {
    try {
      const { positionId } = req.params;
      const cryptos = getCachedCryptos();
      
      const portfolio = getPortfolioState();
      const position = portfolio.positions.find(p => p.id === positionId);
      
      if (!position) {
        return res.status(404).json({ error: "Position not found" });
      }
      
      const currentPrice = cryptos?.find(c => 
        c.symbol.toUpperCase() === position.symbol
      )?.current_price || position.currentPrice;
      
      const trade = await closePosition(positionId, currentPrice, "closed", "Manual Close via API");
      
      res.json({
        trade,
        portfolio: getPortfolioState(),
      });
    } catch (error) {
      console.error("[API] /api/trade/close error:", error);
      res.status(500).json({ error: "Failed to close position" });
    }
  });

  app.post("/api/trade/close-all", async (req, res) => {
    try {
      const cryptos = getCachedCryptos();
      const priceMap = new Map(cryptos?.map(c => [c.symbol.toLowerCase(), c.current_price]) || []);
      
      await closeAllPositions(priceMap);
      
      res.json({
        message: "All positions closed",
        portfolio: getPortfolioState(),
      });
    } catch (error) {
      console.error("[API] /api/trade/close-all error:", error);
      res.status(500).json({ error: "Failed to close all positions" });
    }
  });

  app.post("/api/portfolio/reset", async (req, res) => {
    try {
      resetPortfolio();
      res.json({
        message: "Portfolio reset to $100",
        portfolio: getPortfolioState(),
      });
    } catch (error) {
      console.error("[API] /api/portfolio/reset error:", error);
      res.status(500).json({ error: "Failed to reset portfolio" });
    }
  });

  app.post("/api/portfolio/full-reset", async (req, res) => {
    try {
      await fullResetPortfolio();
      resetBasketState();
      res.json({
        message: "Full reset complete. All trades, positions, and history wiped. Balance reset to $500.",
        portfolio: getPortfolioState(),
      });
    } catch (error) {
      console.error("[API] /api/portfolio/full-reset error:", error);
      res.status(500).json({ error: "Failed to perform full reset" });
    }
  });

  app.get("/api/broker-config", (req, res) => {
    res.json(getBrokerConfig());
  });

  app.get("/api/ai-advice", async (req, res) => {
    try {
      const cryptos = getCachedCryptos() || await getTopCryptos();
      const sentiment = getCachedSentiment();
      const portfolio = getPortfolioState();
      
      let onchainData = null;
      let capitalFlowData = null;
      let signalsData = null;
      
      try {
        signalsData = {
          divergences: detectDivergences(cryptos, sentiment),
          whaleFlow: calculateWhaleNetFlow(getCachedWhaleTransactions(), cryptos),
          correlations: calculateCorrelations(cryptos),
        };
      } catch (e) {}
      
      try {
        onchainData = calculateOnChainMetrics(cryptos);
      } catch (e) {}
      
      try {
        capitalFlowData = await getFlowMetrics();
      } catch (e) {}
      
      const advice = await getAITradeAdvice(
        {
          cryptos,
          sentiment,
          signals: signalsData,
          onchain: onchainData,
          capitalFlow: capitalFlowData,
          liquidations: [],
        },
        portfolio.positions.map(p => ({
          symbol: p.symbol,
          side: p.side,
          unrealizedPnlPercent: p.unrealizedPnlPercent,
        }))
      );
      
      res.json({ advice, timestamp: new Date().toISOString() });
    } catch (error) {
      console.error("[API] /api/ai-advice error:", error);
      res.status(500).json({ error: "Failed to get AI advice" });
    }
  });

  const positionUpdateInterval = setInterval(async () => {
    try {
      await syncHLAccountState();

      const hlPrices = await getHLRealtimePrices();
      if (hlPrices.size > 0) {
        await updatePositionPrices(hlPrices);
        
        updateReversalState(getPortfolioMetricValue());
        
        const portfolio = getPortfolioState();
        updateDailyProfitTarget(portfolio.equity);
        
        await activeTradeManager(hlPrices);
        
        const { priceHistory, atrMap, volatilityMap } = getPriceHistoryMaps();
        updateDynamicOrders(priceHistory, atrMap, volatilityMap);
      }
    } catch (error) {
      console.error("[Trading] Position update error:", error);
    }
  }, 5000);

  async function executeBasketSignals(signals: AITradeSignal[]): Promise<number> {
    let tradesExecuted = 0;
    for (const signal of signals) {
      if (signal.side) {
        const portfolio = getPortfolioState();
        const currentExposure = portfolio.positions.reduce((sum, p) => sum + (p.quantity * p.currentPrice), 0);
        const maxBudget = portfolio.equity * 0.25;
        const signalSize = signal.positionSize || 0;
        if (currentExposure + signalSize > maxBudget) {
          console.log(`[Basket] ${signal.symbol} ${signal.side}: 25% cap reached ($${currentExposure.toFixed(0)}+$${signalSize.toFixed(0)} > $${maxBudget.toFixed(0)}) — skipping`);
          continue;
        }
        const position = await openPosition(signal);
        if (position) {
          tradesExecuted++;
          onEntrySucceeded(signal.symbol);
          console.log(`[Basket] Opened ${signal.side} position: ${signal.symbol} @ $${position.entryPrice.toFixed(2)} ($${signalSize.toFixed(2)})`);
        } else {
          onEntryFailed(signal.symbol);
        }
      }
    }
    return tradesExecuted;
  }

  const REBALANCE_TIMEOUT_MS = 60_000;

  async function runRebalance(): Promise<void> {
    const startTime = Date.now();
    let status = "UNKNOWN";
    try {
      console.log("[Basket] Running 30-minute basket rebalance...");
      
      const top15 = await getBinanceTop15();
      if (top15.length === 0) {
        console.warn(`[Basket] Top 15 unavailable — proceeding with cached symbols`);
      }
      
      const signals = await generateBasketSignals();
      
      setBatchEquityMode(true);
      
      const symbolsToClose = getSymbolsToClose();
      let closeCount = 0;
      for (const { symbol, side } of symbolsToClose) {
        const portfolio = getPortfolioState();
        const pos = portfolio.positions.find(p => p.symbol.toUpperCase() === symbol && p.side === side);
        if (pos) {
          const trades = await closePositionsBySymbol(symbol, pos.currentPrice, "Basket rebalance — no longer in top/bottom 3");
          closeCount += trades.length;
          console.log(`[Basket] Closed ${symbol} ${side} (${trades.length} layers) — dropped from basket`);
        }
      }
      
      const tradesExecuted = await executeBasketSignals(signals);
      
      setBatchEquityMode(false);
      
      recordEquityEvent(0, 'close', `rebalance(${closeCount}c/${tradesExecuted}o)`);
      
      const portfolio = getPortfolioState();
      const elapsed = Date.now() - startTime;
      status = "OK";
      console.log(`[Basket] Rebalance complete: ${signals.length} signals, ${tradesExecuted} opened, ${closeCount} closed, equity: $${portfolio.equity.toFixed(2)} (${elapsed}ms)`);
      await computeAndSaveMetaStats();
    } catch (error) {
      status = "ERROR";
      setBatchEquityMode(false);
      console.error("[Basket] Rebalance error:", error instanceof Error ? error.message : error);
    } finally {
      setBatchEquityMode(false);
      if (status !== "OK") {
        const elapsed = Date.now() - startTime;
        console.error(`[Basket] Rebalance FINISHED with status=${status} (${elapsed}ms)`);
      }
    }
  }

  const analysisInterval = setInterval(async () => {
    try {
      if (!isTradingEnabled()) {
        return;
      }
      
      if (shouldRebalance()) {
        const timeoutPromise = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Rebalance timed out")), REBALANCE_TIMEOUT_MS)
        );
        try {
          await Promise.race([runRebalance(), timeoutPromise]);
        } catch (err) {
          console.error(`[Basket] Rebalance TIMED OUT after ${REBALANCE_TIMEOUT_MS / 1000}s — forced completion`);
        }
      } else {
        const scaleInSignals = await checkScaleInConfirmations();
        if (scaleInSignals.length > 0) {
          const tradesExecuted = await executeBasketSignals(scaleInSignals);
          if (tradesExecuted > 0) {
            const portfolio = getPortfolioState();
            console.log(`[Basket] Scale-in: ${tradesExecuted} new layers opened, equity: $${portfolio.equity.toFixed(2)}`);
          }
        }
      }
      
    } catch (error) {
      console.error("[Basket] Analysis interval error:", error instanceof Error ? error.message : error);
    }
  }, 30000);

  const candleRefreshInterval = setInterval(async () => {
    try {
      await getBinanceTop15().catch(() => []);
    } catch (error) {
      console.error("[Top15 Refresh] Error:", error);
    }
  }, 5 * 60_000);

  httpServer.on("close", () => {
    clearInterval(positionUpdateInterval);
    clearInterval(analysisInterval);
    clearInterval(candleRefreshInterval);
  });

  return httpServer;
}
