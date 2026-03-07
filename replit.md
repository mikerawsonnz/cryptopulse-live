# CryptoPulse Live - Predictive Signal Terminal

## Overview
CryptoPulse Live is a "Predictive Signal Terminal" designed for Twitch streaming overlays, offering real-time cryptocurrency data and advanced analytics. It displays live price data, sentiment analysis, whale transaction alerts, prediction market odds, liquidation data, AI market insights, and advanced signal detection for the top 15 cryptocurrencies by 24h trading volume. The project aims to provide comprehensive, actionable insights with a cyberpunk-themed visual design, leveraging multiple external APIs and AI-powered analysis to identify market opportunities and risks. It also includes an AI Paper Trading System that uses autonomous trading based on real price feeds and quantitative strategies.

## Version Rollback Reference
- **Production v1 STABLE** — Commit `a04c13f` — "Improve position synchronization and reconciliation with trading system"
  - Regime multipliers active (BULLISH: 1.2×/0.5×, NEUTRAL: 0.6×/0.6×, BEARISH: 0.5×/1.2×) + ATR vol overlay
  - HL mainnet candles for momentum/ATR/confirmation
  - Scale-in disabled in NEUTRAL regime
  - To rollback: restore Replit checkpoint at commit `a04c13f`, or revert `server/services/basketStrategy.ts` only
- **Production v2** — Commit `c3265d3` — "Align trading regime multipliers and scale-in behavior with production settings"
  - All regime multipliers flat 1.0× (matching paper-trade production)
  - Binance 5m candles for momentum/ATR/confirmation (matching paper-trade production)
  - Scale-in enabled for all regimes (NEUTRAL = both directions)

## User Preferences
Preferred communication style: Simple, everyday language.
Accounting integrity rule: After ANY code change to trading, positions, balance, equity, or P&L logic, always verify that the accounting reconciles correctly: totalPnl = realizedPnl + unrealizedPnl, realizedPnl = balance - INITIAL_BALANCE, totalPnl = equity - INITIAL_BALANCE. Never skip this check.
CRITICAL — Accounting must be 100% accurate at all times. No double-counting, no phantom PnL, no balance drift. On restart/reconciliation, NEVER re-add PnL that was already saved in the persisted balance. The DB reconciliation process must NOT add trade PnL to balance — the balance loaded from portfolio_state already reflects all prior operations.

## System Architecture

### Core Design Principles
The system prioritizes real-time data delivery, robust caching, and a modular architecture. Sentiment insights display "No Current Signal" if data is unavailable. A composite sentiment algorithm is used for non-BTC cryptocurrencies, incorporating price momentum, volume, and BTC sentiment as a market proxy.

### Frontend
- **Framework**: React 18 with TypeScript
- **State Management**: TanStack React Query for server state, React hooks for local state
- **Styling**: Tailwind CSS with a cyberpunk neon theme, utilizing shadcn/ui and Radix UI components
- **Animations**: Framer Motion
- **Build Tool**: Vite

### Backend
- **Runtime**: Node.js with Express 5 (TypeScript, ESM modules)
- **Real-time Communication**: Native WebSocket (`ws` library) for live data updates
- **API Pattern**: REST endpoints for initial data, WebSocket for continuous updates
- **Data Services**: Separate, cached modules for each external API to manage rate limits and optimize data fetching with configurable TTLs.

### Data Flow
Backend services fetch and cache data from external APIs, then broadcast updates to connected frontend clients via WebSocket. The frontend processes these updates reactively, including client-side composite sentiment calculation for non-BTC assets.

### Database
- **ORM**: Drizzle ORM configured for PostgreSQL
- **Schema**: Defined using Drizzle ORM and Zod for runtime validation.

### Key Features
- **Predictive Signal Terminal**: Includes Divergence Detector, Whale Net Flow Gauge, BTC Correlation Delta Tracker, AI Market Analysis (using Google Gemini 2.0 Flash), AI Price Predictions, Prediction Markets, Liquidation Walls, Capital Flow Delta, and On-Chain Valuation.
- **AI Paper Trading System**: Autonomous trading system with real price feeds and momentum basket strategy.
- **Momentum Basket Strategy** (`server/services/basketStrategy.ts`): Scans top 15 by volume every 30 minutes using 5-minute Binance candles. Ranks by 30-minute momentum (6-candle % change), longs top 3 strongest coins and shorts bottom 3 weakest. Requires confirmation (last candle must continue in momentum direction). ATR-inverse position sizing within each side. Total basket capped at 40% of portfolio equity.
- **No Signal Inversion**: Signals execute as generated — buys strength, sells weakness directly.
- **30-Minute Rolling Rebalance**: Every 30 minutes, rescans momentum, closes positions that dropped out of the basket, opens new positions for coins that entered.
- **ATR-Based Dynamic Stops**: 3x ATR for stop-loss, 4.5x ATR for take-profit (enforced in `openPosition` for basket signals).
- **Breakeven Stops**: Not yet implemented in activeTradeManager — planned feature to move stop-loss to entry price once 50%+ toward TP1.
- **Two-Candle 1m Confirmation (ALL entries)**: Every single entry (L1 and scale-in) requires 2 consecutive 1-minute candles confirming direction. Long = 2 green 1m bars. Short = 2 red 1m bars. No other entry path exists. At rebalance, candidates go to pending — no immediate entries. `checkScaleInConfirmations()` is the single gate that checks 2×1m candles before any position opens.
- **Confirmation Timeframe**: Locked to 1m. Cannot be changed.
- **Portfolio-Level Stop/TP**: Regime-adaptive. NEUTRAL regime tightens to -1.0%, BULLISH/BEARISH use -1.5%. Take-profit stays at +1%.
- **symbolLayers Sync**: `getScaleInState()` re-counts actual open positions from portfolio to prevent stale layer counts after stop-outs.
- **Strict Top 15 Enforcement**: Top 15 sourced from Binance `/ticker/24hr` endpoint (rolling 24h volume — not CoinGecko, not HL `dayNtlVlm` which resets at midnight UTC). CoinGecko is display-only (sparklines, logos, market cap).
- **Market Regime Meta Stats**: Every 30 minutes at rebalance, computes aggregate stats across all 15 ranked coins — max/min/avg/sum for both momentum and ATR%. MOM sum is normalized to 0–1 (0.5 = neutral). Stored in `basket_meta_stats` table for historical analysis and future use as a trading filter.
- **Market Regime Filter** (`getMarketRegime()` in `basketStrategy.ts`): Uses `basket_meta_stats` MOM norm and ATR avg to classify market into BULLISH (≥0.70), NEUTRAL (0.40-0.70), or BEARISH (≤0.40). All position sizing multipliers neutralized to 1.0× (matching production). Scale-in enabled for all regimes (BULLISH=longs only, BEARISH=shorts only, NEUTRAL=both). Portfolio stop adapts: NEUTRAL -1.0%, others -1.5%. Regime classification kept as metadata for logging and analysis. Cached 30s, logs transitions.
- **Correlation Guard**: Limits positions to a maximum of 3 in the same direction to prevent correlated losses.
- **Active Trade Manager (ATM)**: Dynamic position management every 5 seconds with trailing stops (activate at 1.0%, trail 1.5%), breakeven stops, minimum profit enforcement, portfolio-aware stop tightening, time decay exits, and aggressive profit protection.
- **Trade Execution Optimizations**: Per-symbol trade cooldowns, market orders for entries on testnet (immediate fills, no RESTING), market orders for stop-outs (taker fee 0.04%).
- **symbolLayers Signal-Time Locking**: `symbolLayers` is set at signal generation time (not post-fill) to prevent duplicate signals during the same check cycle. On entry failure, `onEntryFailed()` decrements the layer count to free the slot. On success, `onEntrySucceeded()` is a no-op (layer already set). The 25s execution cooldown in `openPosition` provides natural spacing between layers.
- **HL-First Execution Order**: All trade operations (open/close/partial close) execute the HL order BEFORE modifying internal state. For opens: if HL fails, no internal position is created (zero ghost positions). For closes/partial closes: HL fires first, internal state updates proceed regardless (with `[HL MISMATCH]` warning logged on failure) to prevent zombie positions. All three functions (`openPosition`, `closePosition`, `executePartialClose`) are async, and all callers properly await them. When HL returns a fill price, internal entry/SL/TP/fees/margin are recomputed from the actual fill (preserving R-multiple distances via ratio-based adjustment).
- **Continuous HL Position Sync** (`syncPositionsWithHL()` in `paperTrading.ts`): Every 30 seconds, compares internal positions against HL clearinghouse. Removes phantoms (internal positions with no HL match), adopts orphans (HL positions with no internal match), and fixes size/side mismatches by rebuilding from HL data. Guarded by `tradingStateLocked` flag to prevent races with active open/close operations. Started after Stage 7/7 startup completes. **Stability guards**: Requires 3 consecutive empty HL responses (90s) before purging phantoms when internal has positions. Skips purge if HL count drops >50% suddenly (partial data protection). When removing phantoms or rebuilding positions, also closes orphan trade records with $0 PnL via `closeOrphanTradeRecords()` to prevent orphan accumulation.
- **Startup Reconciliation (HL mode)**: On restart, orphan open trades are closed with $0 PnL and reason "System restart - reconciled (HL is system of record)". NO fake P&L is calculated from market prices — HL's accounting is authoritative.
- **Strategy Stats Filtering**: `getTradingStats()` excludes reconciliation/sync/restart trades from win/loss/performance calculations via `isReconciliationTrade()`. A separate `reconciliationTrades` count is included in stats for transparency.
- **HL-First Startup (System of Record)**: On restart in HL mode, DB positions are NOT restored — they are discarded. Instead, Stage 6 queries HL for its current open positions and adopts them directly via `createSyntheticPosition()`. Stage 7 does NOT run an immediate basket rebalance — it only computes the regime and logs status. The first real trading happens at the next regular 30-min basket cycle. This eliminates phantom positions, double entries, and startup conflicts between DB state and HL state.
- **Trading State Lock**: `tradingStateLocked` flag prevents concurrent mutations between HL position sync and active trade operations (openPosition, closePosition). Sync skips its cycle if the lock is held. Close operations re-find position index after HL call to prevent stale-index splice bugs.
- **Robust Trade Management**: Comprehensive PnL/fee accounting with dual-layer lock system.
- **Trade Persistence**: All DB writes (`saveTrade`, `savePosition`, `savePortfolioState`) use 3-retry with exponential backoff. Failed writes are queued and retried. A periodic sync (every 60s) reconciles in-memory trades against the DB, saving any missing trades. This ensures no trades are lost on restart.
- **HL Preflight Check** (`hlPreflightCheck()` in `adapter.ts`): Validates symbol availability and minimum notional before signal generation. Prevents ghost internal positions for coins not on testnet or with insufficient budget for minimum lot size (e.g., ZEC needs $219 min on testnet). Checked at all entry points: initial long/short and scale-in L1/Ln.
- **Hyperliquid Integration** (`server/services/hyperliquid/`): Primary data and execution layer. Controlled by `EXECUTION_MODE=hyperliquid` env var. Data sources: `getHLRealtimePrices()` for position mark-to-market and ATM (every 5s via `allMids` from mainnet), `getAccountState()` for authoritative accounting (equity, balance, unrealizedPnl synced every 10s). When enabled, `openPosition`, `closePosition`, and `executePartialClose` fire HL orders alongside internal state updates. Files: `config.ts` (dynamic symbol mapping from HL meta, kilo-coin handling, testnet guard), `infoClient.ts` (read-only API: account state, positions, fills, candles, prices), `exchangeClient.ts` (EIP-712 order signing/placement), `adapter.ts` (bridge functions). Dashboard shows HL connection status badge. API endpoint: `/api/hl-status`.
- **Data Source Architecture**: Top 15 ranking = Binance rolling 24h volume (stable); Candles (momentum/ATR/confirmation) = Binance 5m candles (matching production); Real-time prices = HL mainnet `allMids`; Accounting = HL clearinghouse (when EXECUTION_MODE=hyperliquid); Display = CoinGecko (sparklines, logos, market cap only).

## External Dependencies

### APIs
- **CoinGecko API**: Dashboard display data (sparklines, logos, market cap). Not used for trading decisions.
- **SentiCrypt API**: Bitcoin sentiment analysis.
- **Helius API**: Solana blockchain whale transaction tracking.
- **Polymarket Gamma API**: Prediction market data.
- **Binance Futures API**: Liquidation data.
- **DeFiLlama API**: Stablecoin supply and bridge volume data.
- **OpenAI API**: AI market analysis (via Replit AI Integrations).
- **Google Gemini API**: AI market analysis.
- **Hyperliquid API**: Primary data source for candles, prices, and accounting. Also handles real order execution (testnet: `api.hyperliquid-testnet.xyz`, mainnet: `api.hyperliquid.xyz`). EIP-712 signed orders via ethers.js.

### Database
- **PostgreSQL**: Used with Drizzle ORM.

### Key NPM Packages
- `drizzle-orm`, `drizzle-zod`: ORM and schema validation.
- `ws`: WebSocket server.
- `@tanstack/react-query`: Server state management.
- `framer-motion`: Animations.