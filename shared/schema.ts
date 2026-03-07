import { z } from "zod";
import { pgTable, serial, text, real, integer, timestamp, jsonb, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

export const momentumHistory = pgTable("momentum_history", {
  id: serial("id").primaryKey(),
  strategy: text("strategy").notNull(),
  mike1Score: real("mike1_score").notNull(),
  emaScore: real("ema_score").notNull(),
  gap: real("gap").notNull(),
  momentumStatus: text("momentum_status").notNull(),
  sizeMultiplier: real("size_multiplier").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertMomentumHistorySchema = createInsertSchema(momentumHistory).omit({
  id: true,
  createdAt: true,
});

export type MomentumHistory = typeof momentumHistory.$inferSelect;
export type InsertMomentumHistory = z.infer<typeof insertMomentumHistorySchema>;

export const allocationHistory = pgTable("allocation_history", {
  id: serial("id").primaryKey(),
  primaryStrategy: text("primary_strategy").notNull(),
  primaryWeight: real("primary_weight").notNull(),
  secondaryStrategy: text("secondary_strategy"),
  secondaryWeight: real("secondary_weight").notNull().default(0),
  cashFloor: integer("cash_floor").notNull().default(0),
  meanReversionMike1: real("mean_reversion_mike1").notNull().default(0),
  volExpansionMike1: real("vol_expansion_mike1").notNull().default(0),
  pairsTradingMike1: real("pairs_trading_mike1").notNull().default(0),
  meanReversionMomentum: text("mean_reversion_momentum").notNull().default("NEUTRAL"),
  volExpansionMomentum: text("vol_expansion_momentum").notNull().default("NEUTRAL"),
  pairsTradingMomentum: text("pairs_trading_momentum").notNull().default("NEUTRAL"),
  meanReversionSizeMult: real("mean_reversion_size_mult").notNull().default(1),
  volExpansionSizeMult: real("vol_expansion_size_mult").notNull().default(1),
  pairsTradingSizeMult: real("pairs_trading_size_mult").notNull().default(1),
  regime: text("regime").notNull().default("unknown"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertAllocationHistorySchema = createInsertSchema(allocationHistory).omit({
  id: true,
  createdAt: true,
});

export type AllocationHistory = typeof allocationHistory.$inferSelect;
export type InsertAllocationHistory = z.infer<typeof insertAllocationHistorySchema>;

export const mike1Snapshots = pgTable("mike1_snapshots", {
  id: serial("id").primaryKey(),
  snapshotType: text("snapshot_type").notNull(),
  strategy: text("strategy").notNull(),
  sharpeRatio: real("sharpe_ratio").notNull().default(0),
  ulcerIndex: real("ulcer_index").notNull().default(0),
  mike1Score: real("mike1_score").notNull().default(0),
  trades: integer("trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  totalPnl: real("total_pnl").notNull().default(0),
  status: text("status").notNull().default("inactive"),
  allocation: real("allocation").notNull().default(0),
  returns: jsonb("returns").$type<number[]>().default([]),
  drawdowns: jsonb("drawdowns").$type<number[]>().default([]),
  peakEquity: real("peak_equity").notNull().default(100),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertMike1SnapshotSchema = createInsertSchema(mike1Snapshots).omit({
  id: true,
  createdAt: true,
});

export type Mike1Snapshot = typeof mike1Snapshots.$inferSelect;
export type InsertMike1Snapshot = z.infer<typeof insertMike1SnapshotSchema>;

export const portfolioMetricSnapshots = pgTable("portfolio_metric_snapshots", {
  id: serial("id").primaryKey(),
  sharpeRatio: real("sharpe_ratio").notNull().default(0),
  ulcerIndex: real("ulcer_index").notNull().default(0),
  portfolioMetric: real("portfolio_metric").notNull().default(0),
  equity: real("equity").notNull().default(0),
  tradeCount: integer("trade_count").notNull().default(0),
  openPositions: integer("open_positions").notNull().default(0),
  drawdownProtectionActive: integer("drawdown_protection_active").notNull().default(0),
  snapshotType: text("snapshot_type").notNull().default("periodic"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertPortfolioMetricSnapshotSchema = createInsertSchema(portfolioMetricSnapshots).omit({
  id: true,
  createdAt: true,
});

export type PortfolioMetricSnapshot = typeof portfolioMetricSnapshots.$inferSelect;
export type InsertPortfolioMetricSnapshot = z.infer<typeof insertPortfolioMetricSnapshotSchema>;

export const paperTrades = pgTable("paper_trades", {
  id: varchar("id", { length: 64 }).primaryKey(),
  symbol: text("symbol").notNull(),
  coinName: text("coin_name").notNull(),
  side: text("side").notNull(),
  orderType: text("order_type").notNull(),
  quantity: real("quantity").notNull(),
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price"),
  stopLoss: real("stop_loss"),
  takeProfit: real("take_profit"),
  pnl: real("pnl"),
  pnlPercent: real("pnl_percent"),
  fees: real("fees").notNull().default(0),
  entryFees: real("entry_fees").notNull().default(0),
  slippage: real("slippage").notNull().default(0),
  status: text("status").notNull(),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
  aiReasoning: text("ai_reasoning").notNull().default(""),
  signalMode: text("signal_mode"),
  openReason: text("open_reason"),
  closeReason: text("close_reason"),
  signals: jsonb("signals").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertPaperTradeSchema = createInsertSchema(paperTrades).omit({
  createdAt: true,
});
export type PaperTrade = typeof paperTrades.$inferSelect;
export type InsertPaperTrade = z.infer<typeof insertPaperTradeSchema>;

export const paperPositions = pgTable("paper_positions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  symbol: text("symbol").notNull(),
  coinName: text("coin_name").notNull(),
  side: text("side").notNull(),
  quantity: real("quantity").notNull(),
  initialQuantity: real("initial_quantity").notNull(),
  entryPrice: real("entry_price").notNull(),
  currentPrice: real("current_price").notNull().default(0),
  stopLoss: real("stop_loss").notNull(),
  takeProfit: real("take_profit"),
  takeProfitLevels: jsonb("take_profit_levels").$type<Array<{price: number; quantityPercent: number; hitProbability: number; triggered: boolean; atrMultiplier: number}>>(),
  unrealizedPnl: real("unrealized_pnl").notNull().default(0),
  unrealizedPnlPercent: real("unrealized_pnl_percent").notNull().default(0),
  marginUsed: real("margin_used").notNull().default(0),
  leverage: real("leverage").notNull().default(1),
  openedAt: text("opened_at").notNull(),
  aiReasoning: text("ai_reasoning").notNull().default(""),
  lastOrderUpdate: text("last_order_update"),
  pairId: text("pair_id"),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertPaperPositionSchema = createInsertSchema(paperPositions).omit({
  createdAt: true,
});
export type PaperPosition = typeof paperPositions.$inferSelect;
export type InsertPaperPosition = z.infer<typeof insertPaperPositionSchema>;

export const shadowTrades = pgTable("shadow_trades", {
  id: varchar("id", { length: 64 }).primaryKey(),
  strategy: text("strategy").notNull(),
  symbol: text("symbol").notNull(),
  coinName: text("coin_name").notNull(),
  side: text("side").notNull(),
  quantity: real("quantity").notNull(),
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price"),
  stopLoss: real("stop_loss"),
  takeProfit: real("take_profit"),
  pnl: real("pnl"),
  pnlPercent: real("pnl_percent"),
  fees: real("fees").notNull().default(0),
  status: text("status").notNull(),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
  reasoning: text("reasoning").notNull().default(""),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertShadowTradeSchema = createInsertSchema(shadowTrades).omit({
  createdAt: true,
});
export type ShadowTrade = typeof shadowTrades.$inferSelect;
export type InsertShadowTrade = z.infer<typeof insertShadowTradeSchema>;

export const shadowPositions = pgTable("shadow_positions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  strategy: text("strategy").notNull(),
  symbol: text("symbol").notNull(),
  coinName: text("coin_name").notNull(),
  side: text("side").notNull(),
  quantity: real("quantity").notNull(),
  entryPrice: real("entry_price").notNull(),
  currentPrice: real("current_price").notNull().default(0),
  stopLoss: real("stop_loss").notNull(),
  takeProfit: real("take_profit"),
  unrealizedPnl: real("unrealized_pnl").notNull().default(0),
  unrealizedPnlPercent: real("unrealized_pnl_percent").notNull().default(0),
  openedAt: text("opened_at").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertShadowPositionSchema = createInsertSchema(shadowPositions).omit({
  createdAt: true,
});
export type ShadowPosition = typeof shadowPositions.$inferSelect;
export type InsertShadowPosition = z.infer<typeof insertShadowPositionSchema>;

export const shadowEquityState = pgTable("shadow_equity_state", {
  id: serial("id").primaryKey(),
  strategy: text("strategy").notNull(),
  equity: real("equity").notNull().default(1000),
  peakEquity: real("peak_equity").notNull().default(1000),
  trades: integer("trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  totalPnl: real("total_pnl").notNull().default(0),
  returns: jsonb("returns").$type<number[]>().default([]),
  drawdowns: jsonb("drawdowns").$type<number[]>().default([]),
  mike1Score: real("mike1_score").notNull().default(0),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertShadowEquityStateSchema = createInsertSchema(shadowEquityState).omit({
  id: true,
  updatedAt: true,
});
export type ShadowEquityState = typeof shadowEquityState.$inferSelect;
export type InsertShadowEquityState = z.infer<typeof insertShadowEquityStateSchema>;

export const mtfShadowTrades = pgTable("mtf_shadow_trades", {
  id: serial("id").primaryKey(),
  comboKey: text("combo_key").notNull(),
  strategy: text("strategy").notNull(),
  timeframe: text("timeframe").notNull(),
  symbol: text("symbol").notNull(),
  coinId: text("coin_id").notNull(),
  side: text("side").notNull(),
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price"),
  stopLoss: real("stop_loss").notNull(),
  takeProfit: real("take_profit").notNull(),
  pnlPercent: real("pnl_percent"),
  pnlDollars: real("pnl_dollars"),
  fees: real("fees").notNull().default(0),
  status: text("status").notNull().default("open"),
  atr: real("atr"),
  confidence: real("confidence"),
  reasoning: text("reasoning"),
  btcPrice: real("btc_price"),
  marketVolatility: real("market_volatility"),
  openedAt: timestamp("opened_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertMtfShadowTradeSchema = createInsertSchema(mtfShadowTrades).omit({
  id: true,
  createdAt: true,
});
export type MtfShadowTrade = typeof mtfShadowTrades.$inferSelect;
export type InsertMtfShadowTrade = z.infer<typeof insertMtfShadowTradeSchema>;

export const mtfMike1Snapshots = pgTable("mtf_mike1_snapshots", {
  id: serial("id").primaryKey(),
  comboKey: text("combo_key").notNull(),
  strategy: text("strategy").notNull(),
  timeframe: text("timeframe").notNull(),
  mike1Score: real("mike1_score").notNull().default(0),
  sharpeRatio: real("sharpe_ratio").notNull().default(0),
  ulcerIndex: real("ulcer_index").notNull().default(0),
  equity: real("equity").notNull().default(500),
  trades: integer("trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  totalPnl: real("total_pnl").notNull().default(0),
  avgPnl: real("avg_pnl").notNull().default(0),
  maxDrawdown: real("max_drawdown").notNull().default(0),
  btcPrice: real("btc_price"),
  marketVolatility: real("market_volatility"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertMtfMike1SnapshotSchema = createInsertSchema(mtfMike1Snapshots).omit({
  id: true,
  createdAt: true,
});
export type MtfMike1Snapshot = typeof mtfMike1Snapshots.$inferSelect;
export type InsertMtfMike1Snapshot = z.infer<typeof insertMtfMike1SnapshotSchema>;

export const mtfAllocationDecisions = pgTable("mtf_allocation_decisions", {
  id: serial("id").primaryKey(),
  primaryCombo: text("primary_combo").notNull(),
  primaryWeight: real("primary_weight").notNull().default(0.7),
  primaryMike1: real("primary_mike1").notNull(),
  secondaryCombo: text("secondary_combo"),
  secondaryWeight: real("secondary_weight").notNull().default(0.3),
  secondaryMike1: real("secondary_mike1"),
  allScores: jsonb("all_scores").$type<Record<string, number>>().notNull(),
  reason: text("reason").notNull(),
  tenureStart: timestamp("tenure_start"),
  wasSwitch: integer("was_switch").notNull().default(0),
  btcPrice: real("btc_price"),
  marketVolatility: real("market_volatility"),
  aiModifier: jsonb("ai_modifier").$type<Record<string, number>>(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertMtfAllocationDecisionSchema = createInsertSchema(mtfAllocationDecisions).omit({
  id: true,
  createdAt: true,
});
export type MtfAllocationDecision = typeof mtfAllocationDecisions.$inferSelect;
export type InsertMtfAllocationDecision = z.infer<typeof insertMtfAllocationDecisionSchema>;

export const mtfAiInsights = pgTable("mtf_ai_insights", {
  id: serial("id").primaryKey(),
  insightType: text("insight_type").notNull(),
  pattern: text("pattern").notNull(),
  recommendation: text("recommendation").notNull(),
  confidence: real("confidence").notNull(),
  affectedCombos: jsonb("affected_combos").$type<string[]>(),
  modifiers: jsonb("modifiers").$type<Record<string, number>>(),
  rawAnalysis: text("raw_analysis"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertMtfAiInsightSchema = createInsertSchema(mtfAiInsights).omit({
  id: true,
  createdAt: true,
});
export type MtfAiInsight = typeof mtfAiInsights.$inferSelect;
export type InsertMtfAiInsight = z.infer<typeof insertMtfAiInsightSchema>;

export const mtfComboEquity = pgTable("mtf_combo_equity", {
  id: serial("id").primaryKey(),
  comboKey: text("combo_key").notNull(),
  strategy: text("strategy").notNull(),
  timeframe: text("timeframe").notNull(),
  equity: real("equity").notNull().default(500),
  peakEquity: real("peak_equity").notNull().default(500),
  trades: integer("trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  totalPnl: real("total_pnl").notNull().default(0),
  returns: jsonb("returns").$type<number[]>().default([]),
  drawdowns: jsonb("drawdowns").$type<number[]>().default([]),
  mike1Score: real("mike1_score").notNull().default(0),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertMtfComboEquitySchema = createInsertSchema(mtfComboEquity).omit({
  id: true,
  updatedAt: true,
});
export type MtfComboEquity = typeof mtfComboEquity.$inferSelect;
export type InsertMtfComboEquity = z.infer<typeof insertMtfComboEquitySchema>;

export const paperPortfolioState = pgTable("paper_portfolio_state", {
  id: serial("id").primaryKey(),
  balance: real("balance").notNull(),
  equity: real("equity").notNull(),
  peakEquity: real("peak_equity").notNull(),
  maxDrawdown: real("max_drawdown").notNull().default(0),
  realizedPnl: real("realized_pnl").notNull().default(0),
  initialBalance: real("initial_balance"),
  startedAt: text("started_at").notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertPaperPortfolioStateSchema = createInsertSchema(paperPortfolioState).omit({
  id: true,
  updatedAt: true,
});
export type PaperPortfolioStateRow = typeof paperPortfolioState.$inferSelect;
export type InsertPaperPortfolioState = z.infer<typeof insertPaperPortfolioStateSchema>;

// Cryptocurrency data from CoinGecko
export const cryptoDataSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  image: z.string(),
  current_price: z.number(),
  market_cap: z.number(),
  market_cap_rank: z.number(),
  total_volume: z.number(),
  price_change_percentage_24h: z.number().nullable(),
  price_change_percentage_7d_in_currency: z.number().nullable().optional(),
  sparkline_in_7d: z.object({
    price: z.array(z.number())
  }).optional(),
  last_updated: z.string()
});

export type CryptoData = z.infer<typeof cryptoDataSchema>;

// Sentiment data from SentiCrypt
export const sentimentDataSchema = z.object({
  coin: z.string(),
  score: z.number(), // -1 to 1
  label: z.enum(["bearish", "neutral", "bullish"]),
  timestamp: z.string()
});

export type SentimentData = z.infer<typeof sentimentDataSchema>;

// Composite sentiment (calculated for non-BTC coins)
export const compositeSentimentSchema = z.object({
  coin: z.string(),
  priceScore: z.number(), // 40% weight
  volumeScore: z.number(), // 20% weight
  socialScore: z.number(), // 40% weight (BTC sentiment as proxy)
  compositeScore: z.number(), // -1 to 1
  label: z.enum(["bearish", "neutral", "bullish"]),
  timestamp: z.string()
});

export type CompositeSentiment = z.infer<typeof compositeSentimentSchema>;

// Whale transaction from Helius (Solana)
export const whaleTransactionSchema = z.object({
  signature: z.string(),
  timestamp: z.number(),
  type: z.enum(["transfer", "swap", "mint", "burn", "unknown"]),
  amount: z.number(),
  amountUsd: z.number().optional(),
  token: z.string(),
  tokenSymbol: z.string().optional(),
  from: z.string(),
  to: z.string(),
  isWhale: z.boolean()
});

export type WhaleTransaction = z.infer<typeof whaleTransactionSchema>;

// Dashboard state
export const dashboardStateSchema = z.object({
  cryptos: z.array(cryptoDataSchema),
  btcSentiment: sentimentDataSchema.nullable(),
  sentiments: z.array(compositeSentimentSchema),
  whaleTransactions: z.array(whaleTransactionSchema),
  lastUpdated: z.string(),
  isConnected: z.boolean()
});

export type DashboardState = z.infer<typeof dashboardStateSchema>;

// Signals data for WebSocket
export const signalsDataSchema = z.object({
  divergences: z.array(z.object({
    coin: z.string(),
    coinName: z.string(),
    type: z.enum(["bullish", "bearish"]),
    priceChange24h: z.number(),
    sentimentScore: z.number(),
    strength: z.number(),
    description: z.string(),
    timestamp: z.string(),
  })),
  whaleFlow: z.object({
    netFlow: z.number(),
    bullishness: z.number(),
    inflow: z.number(),
    outflow: z.number(),
    largestTransaction: whaleTransactionSchema.nullable(),
    volumeDelta: z.number().optional(),
    interpretation: z.string().optional(),
  }),
  correlations: z.array(z.object({
    coin: z.string(),
    coinName: z.string(),
    correlationWithBTC: z.number(),
    trend: z.enum(["strengthening", "weakening", "stable"]),
    strength: z.enum(["strong", "moderate", "weak"]),
  })),
});

export type SignalsData = z.infer<typeof signalsDataSchema>;

// WebSocket message types
export const wsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("crypto_update"),
    data: z.array(cryptoDataSchema)
  }),
  z.object({
    type: z.literal("sentiment_update"),
    data: sentimentDataSchema
  }),
  z.object({
    type: z.literal("whale_alert"),
    data: whaleTransactionSchema
  }),
  z.object({
    type: z.literal("signals_update"),
    data: signalsDataSchema
  }),
  z.object({
    type: z.literal("connection_status"),
    data: z.object({
      connected: z.boolean(),
      message: z.string()
    })
  })
]);

export type WSMessage = z.infer<typeof wsMessageSchema>;

// Polymarket prediction market data
export const polymarketDataSchema = z.object({
  id: z.string(),
  question: z.string(),
  description: z.string(),
  outcomes: z.array(z.object({
    name: z.string(),
    price: z.number()
  })),
  volume: z.number(),
  liquidity: z.number(),
  endDate: z.string().optional(),
  category: z.string()
});

export type PolymarketData = z.infer<typeof polymarketDataSchema>;

// Binance liquidation data
export const liquidationDataSchema = z.object({
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  price: z.number(),
  quantity: z.number(),
  usdValue: z.number(),
  time: z.number(),
  type: z.enum(["long", "short"])
});

export type LiquidationData = z.infer<typeof liquidationDataSchema>;

// AI market insight
export const aiInsightSchema = z.object({
  summary: z.string(),
  trend: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.number(),
  keySignal: z.string(),
  riskLevel: z.enum(["low", "medium", "high"]),
  topOpportunity: z.string().nullable(),
  warning: z.string().nullable(),
  timestamp: z.string()
});

export type AIInsight = z.infer<typeof aiInsightSchema>;

// Divergence signal
export const divergenceSignalSchema = z.object({
  coin: z.string(),
  coinName: z.string(),
  type: z.enum(["bullish", "bearish"]),
  priceChange24h: z.number(),
  sentimentScore: z.number(),
  strength: z.number(),
  description: z.string(),
  timestamp: z.string()
});

export type DivergenceSignal = z.infer<typeof divergenceSignalSchema>;

// Correlation data
export const correlationDataSchema = z.object({
  coin: z.string(),
  coinName: z.string(),
  correlationWithBTC: z.number(),
  correlation24h: z.number().optional(),
  correlationDelta24h: z.number().optional(),
  trend: z.enum(["strengthening", "weakening", "stable"]),
  strength: z.enum(["strong", "moderate", "weak"])
});

export type CorrelationData = z.infer<typeof correlationDataSchema>;

// Whale flow analysis
export const whaleFlowSchema = z.object({
  netFlow: z.number(),
  bullishness: z.number(),
  inflow: z.number(),
  outflow: z.number(),
  largestTransaction: whaleTransactionSchema.nullable()
});

export type WhaleFlow = z.infer<typeof whaleFlowSchema>;

// Liquidation cluster
export const liquidationClusterSchema = z.object({
  symbol: z.string(),
  longLiquidationLevel: z.number(),
  shortLiquidationLevel: z.number(),
  totalLongLiquidated: z.number(),
  totalShortLiquidated: z.number(),
  volatilityTrap: z.enum(["high", "medium", "low"])
});

export type LiquidationCluster = z.infer<typeof liquidationClusterSchema>;

// AI Price Prediction
export const aiPredictionSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  coinName: z.string(),
  timeframe: z.enum(["10m", "30m", "60m", "4h", "24h"]),
  createdAt: z.string(),
  targetTime: z.string(),
  priceAtPrediction: z.number(),
  predictedPrice: z.number(),
  predictedChange: z.number(),
  direction: z.enum(["up", "down", "neutral"]),
  confidence: z.number(),
  methodology: z.string(),
  indicators: z.object({
    rsi: z.number().optional(),
    momentum: z.number().optional(),
    volatility: z.number().optional(),
    sentimentScore: z.number().optional(),
  }),
  resolved: z.boolean(),
  actualPrice: z.number().nullable(),
  actualChange: z.number().nullable(),
  accuracyScore: z.number().nullable(),
  wasCorrect: z.boolean().nullable(),
});

export type AIPrediction = z.infer<typeof aiPredictionSchema>;

// Prediction accuracy tracking
export const predictionAccuracySchema = z.object({
  timeframe: z.enum(["10m", "30m", "60m", "4h", "24h"]),
  totalPredictions: z.number(),
  correctPredictions: z.number(),
  accuracyRate: z.number(),
  averageError: z.number(),
  directionAccuracy: z.number(),
  lastUpdated: z.string(),
});

export type PredictionAccuracy = z.infer<typeof predictionAccuracySchema>;

// API response wrapper
export const apiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.boolean(),
    data: dataSchema.optional(),
    error: z.string().optional(),
    timestamp: z.string()
  });

// Paper Trading Types

// Order types supported
export const orderTypeSchema = z.enum(["market", "limit", "stop", "stop_limit"]);
export type OrderType = z.infer<typeof orderTypeSchema>;

// Position side
export const positionSideSchema = z.enum(["long", "short"]);
export type PositionSide = z.infer<typeof positionSideSchema>;

// Order status
export const orderStatusSchema = z.enum(["pending", "filled", "cancelled", "rejected"]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

// Trade record (executed order)
export const tradeRecordSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  coinName: z.string(),
  side: positionSideSchema,
  orderType: orderTypeSchema,
  quantity: z.number(),
  entryPrice: z.number(),
  exitPrice: z.number().nullable(),
  stopLoss: z.number().nullable(),
  takeProfit: z.number().nullable(),
  pnl: z.number().nullable(),
  pnlPercent: z.number().nullable(),
  fees: z.number(),           // Total fees (entry + all exit fees)
  entryFees: z.number(),      // Entry fees only (for net PnL calculation)
  slippage: z.number(),
  status: z.enum(["open", "closed", "stopped_out"]),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  aiReasoning: z.string(),
  signalMode: z.enum(["volExpansion", "meanReversion", "pairsTrading", "adaptive", "momentum"]).optional(),
  openReason: z.string().optional(),
  closeReason: z.string().optional(),
  signals: z.object({
    sentiment: z.number().optional(),
    divergence: z.string().optional(),
    whaleFlow: z.string().optional(),
    correlation: z.number().optional(),
    mvrvZScore: z.number().optional(),
    capitalFlow: z.string().optional(),
  }).optional(),
});

export type TradeRecord = z.infer<typeof tradeRecordSchema>;

// Open position
export const positionSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  coinName: z.string(),
  side: positionSideSchema,
  quantity: z.number(),
  initialQuantity: z.number(), // Original quantity before scale-outs
  entryPrice: z.number(),
  currentPrice: z.number(),
  stopLoss: z.number(),
  takeProfit: z.number().nullable(),
  takeProfitLevels: z.array(z.object({
    price: z.number(),
    quantityPercent: z.number(), // % of initial position to close at this level
    hitProbability: z.number(),  // estimated probability of hitting this level
    triggered: z.boolean(),       // whether this level has been hit
    atrMultiplier: z.number(),   // ATR multiplier used (for reference)
  })).optional(),
  unrealizedPnl: z.number(),
  unrealizedPnlPercent: z.number(),
  marginUsed: z.number(),
  leverage: z.number(),
  openedAt: z.string(),
  aiReasoning: z.string(),
  lastOrderUpdate: z.string().optional(), // ISO timestamp of last TP/SL update (max every 10 min)
  pairId: z.string().optional(), // Links two legs of a correlation pair trade
});

export type Position = z.infer<typeof positionSchema>;

// Portfolio state
export const portfolioStateSchema = z.object({
  balance: z.number(),
  equity: z.number(),
  availableMargin: z.number(),
  usedMargin: z.number(),
  unrealizedPnl: z.number(),
  realizedPnl: z.number(),
  totalPnl: z.number(),
  totalPnlPercent: z.number(),
  positions: z.array(positionSchema),
  maxDrawdown: z.number(),
  currentDrawdown: z.number(),
  peakEquity: z.number(),
  lastUpdated: z.string(),
});

export type PortfolioState = z.infer<typeof portfolioStateSchema>;

// Trading statistics
export const tradingStatsSchema = z.object({
  totalTrades: z.number(),
  reconciliationTrades: z.number().optional(),
  winningTrades: z.number(),
  losingTrades: z.number(),
  winRate: z.number(),
  avgWin: z.number(),
  avgLoss: z.number(),
  profitFactor: z.number(),
  sharpeRatio: z.number().nullable(),
  maxDrawdown: z.number(),
  avgDrawdown: z.number(),
  bestTrade: z.number(),
  worstTrade: z.number(),
  avgHoldingTime: z.string(),
  totalFees: z.number(),
  totalSlippage: z.number(),
  monthlyReturns: z.array(z.object({
    month: z.string(),
    return: z.number(),
    trades: z.number(),
  })),
  cryptoExposure: z.array(z.object({
    symbol: z.string(),
    exposure: z.number(),
    exposurePercent: z.number(),
  })),
});

export type TradingStats = z.infer<typeof tradingStatsSchema>;

// Strategy mode for adaptive trading
export const strategyModeSchema = z.enum(["volExpansion", "meanReversion", "pairsTrading", "adaptive", "momentum"]);
export type StrategyModeType = z.infer<typeof strategyModeSchema>;

// AI trade signal
export const aiTradeSignalSchema = z.object({
  symbol: z.string(),
  coinName: z.string(),
  action: z.enum(["buy", "sell", "close", "hold"]),
  side: positionSideSchema.optional(),
  confidence: z.number(),
  targetEntry: z.number(),
  stopLoss: z.number(),
  takeProfit: z.number().nullable(),
  riskRewardRatio: z.number(),
  positionSize: z.number(),
  reasoning: z.string(),
  signalMode: strategyModeSchema.optional(),  // Track which strategy mode generated this signal
  signals: z.object({
    sentiment: z.number().optional(),
    divergence: z.string().optional(),
    whaleFlow: z.string().optional(),
    correlation: z.number().optional(),
    mvrvZScore: z.number().optional(),
    capitalFlow: z.string().optional(),
    priceChange24h: z.number().optional(),
    liquidationRisk: z.string().optional(),
    atr: z.number().optional(),
    regime: z.string().optional(),
    volRegime: z.string().optional(),
    momNorm: z.number().optional(),
    regimeMultiplier: z.number().optional(),
  }),
  timestamp: z.string(),
  pairId: z.string().optional(),
  openReason: z.string().optional(),
});

export type AITradeSignal = z.infer<typeof aiTradeSignalSchema>;

// Broker simulation config
export const brokerConfigSchema = z.object({
  name: z.string(),
  minLotSize: z.number(),
  maxLeverage: z.number(),
  makerFee: z.number(),
  takerFee: z.number(),
  avgSlippage: z.number(),
  maxSlippage: z.number(),
});

export type BrokerConfig = z.infer<typeof brokerConfigSchema>;

export const basketMetaStats = pgTable("basket_meta_stats", {
  id: serial("id").primaryKey(),
  momMax: real("mom_max").notNull(),
  momMin: real("mom_min").notNull(),
  momAvg: real("mom_avg").notNull(),
  momSum: real("mom_sum").notNull(),
  momSumNormalized: real("mom_sum_normalized").notNull(),
  atrMax: real("atr_max").notNull(),
  atrMin: real("atr_min").notNull(),
  atrAvg: real("atr_avg").notNull(),
  atrSum: real("atr_sum").notNull(),
  coinCount: integer("coin_count").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertBasketMetaStatsSchema = createInsertSchema(basketMetaStats).omit({
  id: true,
  createdAt: true,
});

export type BasketMetaStats = typeof basketMetaStats.$inferSelect;
export type InsertBasketMetaStats = z.infer<typeof insertBasketMetaStatsSchema>;
