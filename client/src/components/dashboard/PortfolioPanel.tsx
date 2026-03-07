import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  TrendingUp, 
  TrendingDown, 
  Wallet, 
  Activity, 
  BarChart3,
  Play,
  Square,
  RotateCcw,
  Trash2,
  Bot,
  XCircle,
  Clock,
  Target,
  AlertTriangle,
  Zap,
  Shield,
  ShieldAlert,
  ShieldOff,
  ArrowDownUp,
  Timer,
  Gauge,
  CircleDot,
  ChevronRight
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { PortfolioState, TradeRecord, TradingStats, Position } from "@shared/schema";
import { EquityChart } from "./EquityChart";

interface HLStatus {
  enabled: boolean;
  mode?: string;
  connected?: boolean;
  equity?: number;
  balance?: number;
  unrealizedPnl?: number;
  openPositions?: number;
  marginUsed?: number;
  withdrawable?: number;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPrice(value: number): string {
  const abs = Math.abs(value);
  let decimals: number;
  if (abs >= 1000) decimals = 2;
  else if (abs >= 1) decimals = 4;
  else if (abs >= 0.01) decimals = 4;
  else if (abs >= 0.0001) decimals = 6;
  else decimals = 8;
  return "$" + value.toFixed(decimals);
}

function formatPnl(value: number): string {
  const absValue = Math.abs(value);
  if (absValue < 1 && absValue > 0) {
    const sign = value >= 0 ? "" : "-";
    return `${sign}$${absValue.toFixed(4)}`;
  }
  return formatCurrency(value);
}

function formatVolume(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

export function PortfolioPanel() {
  const [activeTab, setActiveTab] = useState("overview");
  const queryClient = useQueryClient();

  const { data: portfolio, isLoading: portfolioLoading } = useQuery<PortfolioState>({
    queryKey: ["/api/portfolio"],
    refetchInterval: 5000,
  });

  const { data: trades } = useQuery<TradeRecord[]>({
    queryKey: ["/api/trades"],
    refetchInterval: 10000,
  });

  const { data: stats } = useQuery<TradingStats>({
    queryKey: ["/api/trading-stats"],
    refetchInterval: 10000,
  });

  const { data: riskMetrics } = useQuery<{
    overall: {
      sharpeRatio: number;
      ulcerIndex: number;
      sharpeUlcerRatio: number;
      totalReturn: number;
      maxDrawdown: number;
      winRate: number;
      totalTrades: number;
    };
    correlation: {
      sharpeRatio: number;
      ulcerIndex: number;
      sharpeUlcerRatio: number;
      totalTrades: number;
    };
    portfolioMetric: {
      name: string;
      value: number;
      description: string;
      drawdownProtectionActive: boolean;
    };
    equityCurve?: {
      rawMetric: number;
      normalizedMetric: number;
      zScore: number;
      emaValue: number;
      momentum: number;
      regime: string;
      sizeMultiplier: number;
      lossDirection: string;
      lossDirectionRatio: number;
      recoveryModeActive: boolean;
      invertSignals: boolean;
      consecutiveNegativeSnapshots: number;
      totalClosedTrades: number;
      shortLosses: number;
      longLosses: number;
      lastUpdated: number;
    };
    reversal?: {
      level: string;
      negativeStartTime: number | null;
      negativeDurationMinutes: number;
      active: boolean;
      positionsClosed: number;
      lastEscalation: number;
      lastClose: number;
    };
  }>({
    queryKey: ["/api/risk-metrics"],
    refetchInterval: 10000,
  });

  const { data: tradingStatus } = useQuery<{ active: boolean; correlationEnabled: boolean }>({
    queryKey: ["/api/trading-status"],
    refetchInterval: 3000,
  });

  const { data: hlStatus } = useQuery<HLStatus>({
    queryKey: ["/api/hl-status"],
    refetchInterval: 30000,
  });

  const { data: strategyStatus } = useQuery<{
    strategyMode: string;
    signalInversion: boolean;
    basket: {
      longSymbols: string[];
      shortSymbols: string[];
      totalExposure: number;
      maxBudget: number;
      exposurePercent: number;
      totalUnrealized: number;
      positionCount: number;
      lastRebalance: string | null;
      nextRebalanceMs: number;
    };
    rankings: {
      symbol: string;
      coinName: string;
      price: number;
      momentum30m: number;
      confirmed: boolean;
      atrPercent: number;
      inLongBasket: boolean;
      inShortBasket: boolean;
    }[];
    regime?: {
      regime: string;
      momNorm: number;
      atrAvg: number;
      volRegime: string;
      longMultiplier: number;
      shortMultiplier: number;
      scaleInEnabled: boolean;
      scaleInDirection: string;
      portfolioStopPercent: number;
    };
  }>({
    queryKey: ["/api/mode-stats"],
    refetchInterval: 10000,
  });

  const startTradingMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/trade/start"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trading-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/risk-metrics"] });
    },
  });

  const stopTradingMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/trade/stop"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trading-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/risk-metrics"] });
    },
  });

  const isTradingActive = tradingStatus?.active ?? false;

  const analyzeMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/trade/analyze"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trading-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/risk-metrics"] });
    },
  });

  const closePositionMutation = useMutation({
    mutationFn: (positionId: string) => 
      apiRequest("POST", `/api/trade/close/${positionId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trading-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/risk-metrics"] });
    },
  });

  const closeAllMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/trade/close-all"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trading-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/risk-metrics"] });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/portfolio/reset"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trading-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/risk-metrics"] });
    },
  });

  const fullResetMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/portfolio/full-reset"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trading-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/risk-metrics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/equity-curve"] });
      queryClient.invalidateQueries({ queryKey: ["/api/mode-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio-metric-history"] });
    },
  });

  if (portfolioLoading || !portfolio) {
    return (
      <Card className="border-cyan-500/30 bg-gradient-to-br from-slate-900/80 to-slate-800/60">
        <CardContent className="p-6 flex items-center justify-center h-64">
          <Activity className="w-8 h-8 animate-pulse text-cyan-400" />
        </CardContent>
      </Card>
    );
  }

  const isProfit = portfolio.totalPnl >= 0;
  const drawdownDanger = portfolio.currentDrawdown >= 20;

  return (
    <Card className="border-cyan-500/30 bg-gradient-to-br from-slate-900/80 to-slate-800/60" data-testid="portfolio-panel">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="font-display text-lg tracking-wide flex items-center gap-2 text-cyan-400">
            <Bot className="w-5 h-5" />
            AI PAPER TRADING
            <Badge 
              variant={isTradingActive ? "default" : "secondary"}
              data-testid="badge-trading-status"
            >
              {isTradingActive ? "ACTIVE" : "STOPPED"}
            </Badge>
            {hlStatus?.enabled && (
              <Badge 
                variant={hlStatus.connected ? "default" : "destructive"}
                className={hlStatus.connected ? "bg-purple-600 hover:bg-purple-700 text-white" : ""}
                data-testid="badge-hl-status"
              >
                {hlStatus.connected ? `HL ${hlStatus.mode?.toUpperCase()}` : "HL OFFLINE"}
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            {isTradingActive ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => stopTradingMutation.mutate()}
                disabled={stopTradingMutation.isPending}
                data-testid="button-stop-trading"
              >
                {stopTradingMutation.isPending ? (
                  <Activity className="w-4 h-4 animate-spin mr-1" />
                ) : (
                  <Square className="w-4 h-4 mr-1" />
                )}
                Stop Trading
              </Button>
            ) : (
              <Button
                size="sm"
                variant="default"
                onClick={() => startTradingMutation.mutate()}
                disabled={startTradingMutation.isPending}
                data-testid="button-start-trading"
              >
                {startTradingMutation.isPending ? (
                  <Activity className="w-4 h-4 animate-spin mr-1" />
                ) : (
                  <Play className="w-4 h-4 mr-1" />
                )}
                Start Trading
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => analyzeMutation.mutate()}
              disabled={analyzeMutation.isPending || !isTradingActive}
              data-testid="button-analyze"
            >
              {analyzeMutation.isPending ? (
                <Activity className="w-4 h-4 animate-spin mr-1" />
              ) : (
                <Zap className="w-4 h-4 mr-1" />
              )}
              Analyze Now
            </Button>
            {portfolio.positions.length > 0 && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => closeAllMutation.mutate()}
                disabled={closeAllMutation.isPending}
                data-testid="button-close-all"
              >
                <Square className="w-4 h-4 mr-1" />
                Close All
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                if (window.confirm("FULL RESET: This will permanently delete ALL trades, positions, and history. Balance resets to $500. This cannot be undone. Continue?")) {
                  fullResetMutation.mutate();
                }
              }}
              disabled={fullResetMutation.isPending}
              data-testid="button-full-reset"
            >
              <Trash2 className="w-4 h-4 mr-1" />
              {fullResetMutation.isPending ? "Resetting..." : "Full Reset"}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => resetMutation.mutate()}
              disabled={resetMutation.isPending}
              data-testid="button-reset"
            >
              <RotateCcw className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-slate-800/50 rounded-lg p-4 border border-cyan-500/20">
            <div className="text-sm text-white mb-1 flex items-center gap-1">
              <Wallet className="w-4 h-4" />
              EQUITY
            </div>
            <div className="font-mono text-xl font-semibold text-cyan-400">
              {formatCurrency(portfolio.equity)}
            </div>
          </div>
          
          <div className="bg-slate-800/50 rounded-lg p-4 border border-cyan-500/20">
            <div className="text-sm text-white mb-1 flex items-center gap-1">
              {isProfit ? <TrendingUp className="w-4 h-4 text-green-400" /> : <TrendingDown className="w-4 h-4 text-red-400" />}
              TOTAL P&L
            </div>
            <div className={`font-mono text-xl font-semibold ${isProfit ? "text-green-400" : "text-red-400"}`}>
              {formatPnl(portfolio.totalPnl)} ({formatPercent(portfolio.totalPnlPercent)})
            </div>
          </div>
          
          <div className="bg-slate-800/50 rounded-lg p-4 border border-cyan-500/20">
            <div className="text-sm text-white mb-1 flex items-center gap-1">
              {portfolio.unrealizedPnl >= 0 ? <TrendingUp className="w-4 h-4 text-green-400" /> : <TrendingDown className="w-4 h-4 text-red-400" />}
              OPEN P&L
            </div>
            <div className={`font-mono text-xl font-semibold ${portfolio.unrealizedPnl >= 0 ? "text-green-400" : "text-red-400"}`} data-testid="text-open-pnl">
              {formatPnl(portfolio.unrealizedPnl)}
            </div>
            <div className="text-xs text-gray-500 mt-0.5 font-mono" data-testid="text-open-positions-count">
              {new Set(portfolio.positions.map((p: Position) => p.symbol)).size} positions ({portfolio.positions.length} layers)
            </div>
          </div>
          
          <div className={`bg-slate-800/50 rounded-lg p-4 border ${drawdownDanger ? "border-red-500/50" : "border-cyan-500/20"}`}>
            <div className="text-sm text-white mb-1 flex items-center gap-1">
              {drawdownDanger && <AlertTriangle className="w-4 h-4 text-red-400" />}
              DRAWDOWN
            </div>
            <div className={`font-mono text-xl font-semibold ${drawdownDanger ? "text-red-400" : (portfolio.currentDrawdown || 0) > 10 ? "text-yellow-400" : "text-white"}`}>
              {(portfolio.currentDrawdown ?? 0).toFixed(1)}% / {(portfolio.maxDrawdown ?? 0).toFixed(1)}%
            </div>
          </div>
        </div>

        <div className="bg-slate-800/30 rounded-lg p-3 border border-cyan-500/10">
          <EquityChart />
        </div>

        {/* ── VERBOSE RISK MANAGEMENT STATUS ── */}
        {riskMetrics && (
          <div className="bg-gradient-to-br from-slate-900/90 to-slate-800/70 rounded-lg border border-cyan-500/20 overflow-hidden" data-testid="risk-management-panel">
            <div className="px-4 py-2.5 bg-cyan-950/40 border-b border-cyan-500/20 flex items-center gap-2">
              <Shield className="w-4 h-4 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-300 tracking-wide">RISK MANAGEMENT STATUS</span>
              <span className="text-xs text-gray-500 ml-auto font-mono">Live — updated every 5s</span>
            </div>
            <div className="p-4 space-y-3 text-sm">

              {/* Row 1: Portfolio Metric & Drawdown Protection */}
              <div className="flex items-start gap-3">
                <Gauge className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-gray-300 font-medium">Portfolio Metric (Sharpe/Ulcer):</span>
                    <span className={`font-mono font-bold ${(riskMetrics.portfolioMetric?.value ?? 0) < 0 ? 'text-red-400' : (riskMetrics.portfolioMetric?.value ?? 0) === 0 ? 'text-yellow-400' : 'text-green-400'}`} data-testid="text-pm-value">
                      {(riskMetrics.portfolioMetric?.value ?? 0).toFixed(3)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5" data-testid="text-pm-description">
                    {riskMetrics.portfolioMetric?.drawdownProtectionActive
                      ? "Negative — drawdown protection is ACTIVE. All new trades use minimum broker volume to limit risk."
                      : (riskMetrics.portfolioMetric?.value ?? 0) > 0
                      ? "Positive — normal position sizing in effect. No drawdown protection needed."
                      : "Non-negative — normal operation. Drawdown protection arms automatically when metric drops below zero."}
                  </p>
                  {riskMetrics.portfolioMetric?.drawdownProtectionActive && (
                    <div className="mt-1 flex items-center gap-1.5">
                      <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                      <span className="text-xs text-red-400 font-semibold">DRAWDOWN PROTECTION ON — minimum position sizes enforced</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Row 2: Equity Curve Regime */}
              {riskMetrics.equityCurve && (
                <div className="flex items-start gap-3">
                  <Activity className="w-4 h-4 text-cyan-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-gray-300 font-medium">Equity Curve Regime:</span>
                      <Badge variant="outline" className={`text-xs font-mono ${
                        riskMetrics.equityCurve.regime === 'AGGRESSIVE' ? 'border-green-500 text-green-400' :
                        riskMetrics.equityCurve.regime === 'NEUTRAL' ? 'border-yellow-500 text-yellow-400' :
                        riskMetrics.equityCurve.regime === 'DEFENSIVE' ? 'border-orange-500 text-orange-400' :
                        'border-red-500 text-red-400'
                      }`} data-testid="badge-ec-regime">
                        {riskMetrics.equityCurve.regime}
                      </Badge>
                      <span className="text-xs text-gray-500 font-mono">
                        Size multiplier: {(riskMetrics.equityCurve.sizeMultiplier * 100).toFixed(0)}%
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5" data-testid="text-ec-description">
                      {riskMetrics.equityCurve.regime === 'AGGRESSIVE'
                        ? "Equity curve trending up — full position sizes allowed. Trading conditions are favorable."
                        : riskMetrics.equityCurve.regime === 'NEUTRAL'
                        ? `Equity curve flat — 75% position sizes. ${(riskMetrics.equityCurve.totalClosedTrades || 0) < 20 ? 'Bootstrap phase: fewer than 20 closed trades, regime locked to NEUTRAL until enough data.' : 'Waiting to confirm trend direction.'}`
                        : riskMetrics.equityCurve.regime === 'DEFENSIVE'
                        ? "Equity curve declining — 50% position sizes. Reducing exposure to limit further drawdown."
                        : `Equity curve in deep drawdown — positions paused (0% sizing). ${riskMetrics.equityCurve.recoveryModeActive ? 'Recovery mode forced HIBERNATE due to one-sided losses.' : (riskMetrics.equityCurve.totalClosedTrades || 0) < 20 ? 'Bootstrap override: fewer than 20 trades and metric negative forces HIBERNATE.' : 'Waiting for recovery before re-entering.'}`}
                    </p>
                    <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
                      <div className="flex items-center gap-1">
                        <ChevronRight className="w-3 h-3 text-gray-600" />
                        <span className="text-gray-500">Normalized:</span>
                        <span className={`font-mono ${riskMetrics.equityCurve.normalizedMetric >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {riskMetrics.equityCurve.normalizedMetric.toFixed(3)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <ChevronRight className="w-3 h-3 text-gray-600" />
                        <span className="text-gray-500">Momentum:</span>
                        <span className={`font-mono ${riskMetrics.equityCurve.momentum >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {riskMetrics.equityCurve.momentum >= 0 ? '+' : ''}{riskMetrics.equityCurve.momentum.toFixed(3)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <ChevronRight className="w-3 h-3 text-gray-600" />
                        <span className="text-gray-500">Z-Score:</span>
                        <span className="font-mono text-cyan-400">{riskMetrics.equityCurve.zScore.toFixed(2)}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <ChevronRight className="w-3 h-3 text-gray-600" />
                        <span className="text-gray-500">Neg Snaps:</span>
                        <span className="font-mono text-yellow-400">{riskMetrics.equityCurve.consecutiveNegativeSnapshots}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Row 3: Recovery Mode (Directional Bias) */}
              {riskMetrics.equityCurve && (
                <div className="flex items-start gap-3">
                  <ArrowDownUp className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-gray-300 font-medium">Recovery Mode (Directional Bias):</span>
                      <Badge variant="outline" className={`text-xs font-mono ${riskMetrics.equityCurve.recoveryModeActive ? 'border-amber-500 text-amber-400' : 'border-gray-600 text-gray-500'}`} data-testid="badge-recovery-status">
                        {riskMetrics.equityCurve.recoveryModeActive ? 'ACTIVE — INVERTING' : 'INACTIVE'}
                      </Badge>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5" data-testid="text-recovery-description">
                      {riskMetrics.equityCurve.recoveryModeActive
                        ? `Losses are heavily one-sided (${riskMetrics.equityCurve.lossDirection === 'SHORT_LOSSES' ? 'shorts losing' : 'longs losing'}) — flipping new trade signals to the opposite direction and forcing HIBERNATE (0% sizing on new entries).`
                        : riskMetrics.equityCurve.lossDirection === 'INSUFFICIENT_DATA'
                        ? "Not enough closed trades to analyze loss direction. Requires 20+ closed trades with 5+ losses and 3+ negative snapshots."
                        : `Loss distribution: ${riskMetrics.equityCurve.shortLosses}S / ${riskMetrics.equityCurve.longLosses}L (${riskMetrics.equityCurve.lossDirection === 'MIXED' ? 'balanced, no bias detected' : riskMetrics.equityCurve.lossDirection === 'SHORT_LOSSES' ? 'leaning short — not yet 70% threshold' : 'leaning long — not yet 70% threshold'}). Dominance: ${(riskMetrics.equityCurve.lossDirectionRatio * 100).toFixed(0)}% — activates at 70%.`}
                    </p>
                  </div>
                </div>
              )}

              {/* Row 4: Graduated Reversal System */}
              <div className="flex items-start gap-3">
                {riskMetrics.reversal?.active ? (
                  <ShieldOff className="w-4 h-4 text-red-400 mt-0.5 shrink-0 animate-pulse" />
                ) : (
                  <Shield className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
                )}
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-gray-300 font-medium">Graduated Reversal System:</span>
                    {riskMetrics.reversal?.active ? (
                      <Badge variant="outline" className={`text-xs font-mono ${
                        riskMetrics.reversal.level === 'INVERT_NEW' ? 'border-yellow-500 text-yellow-400' :
                        riskMetrics.reversal.level === 'CLOSE_WORST' ? 'border-orange-500 text-orange-400' :
                        'border-red-500 text-red-400'
                      }`} data-testid="badge-reversal-level">
                        LEVEL {riskMetrics.reversal.level === 'INVERT_NEW' ? '1 — INVERT NEW' : riskMetrics.reversal.level === 'CLOSE_WORST' ? '2 — CLOSE WORST' : '3 — FULL REVERSAL'}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs font-mono border-gray-600 text-gray-500" data-testid="badge-reversal-level">
                        INACTIVE
                      </Badge>
                    )}
                  </div>

                  {riskMetrics.reversal?.active ? (
                    <>
                      <div className="mt-1.5 bg-slate-800/60 rounded p-2.5 border border-red-500/20">
                        <div className="flex items-center gap-2 mb-1.5">
                          <Timer className="w-3.5 h-3.5 text-red-400" />
                          <span className="text-xs text-red-300 font-semibold" data-testid="text-reversal-duration">
                            Metric negative for {riskMetrics.reversal.negativeDurationMinutes.toFixed(0)} minutes
                          </span>
                        </div>
                        <div className="space-y-1 text-xs">
                          <div className="flex items-center gap-2" data-testid="reversal-level-1">
                            <CircleDot className={`w-3 h-3 ${riskMetrics.reversal.negativeDurationMinutes >= 20 ? 'text-yellow-400' : 'text-gray-600'}`} />
                            <span className={riskMetrics.reversal.negativeDurationMinutes >= 20 ? 'text-yellow-300' : 'text-gray-600'}>
                              Level 1 (20min): Invert new signals only — {riskMetrics.reversal.negativeDurationMinutes >= 20 ? 'ACTIVE — flipping buy/sell on new entries (no closing costs)' : `in ${Math.max(0, 20 - riskMetrics.reversal.negativeDurationMinutes).toFixed(0)}min`}
                            </span>
                          </div>
                          <div className="flex items-center gap-2" data-testid="reversal-level-2">
                            <CircleDot className={`w-3 h-3 ${riskMetrics.reversal.negativeDurationMinutes >= 40 ? 'text-orange-400' : 'text-gray-600'}`} />
                            <span className={riskMetrics.reversal.negativeDurationMinutes >= 40 ? 'text-orange-300' : 'text-gray-600'}>
                              Level 2 (40min): + Close worst underwater (below -0.3% P&L, 5min cooldown) — {riskMetrics.reversal.negativeDurationMinutes >= 40 ? `ACTIVE — ${riskMetrics.reversal.positionsClosed} closed so far` : `in ${Math.max(0, 40 - riskMetrics.reversal.negativeDurationMinutes).toFixed(0)}min`}
                            </span>
                          </div>
                          <div className="flex items-center gap-2" data-testid="reversal-level-3">
                            <CircleDot className={`w-3 h-3 ${riskMetrics.reversal.negativeDurationMinutes >= 60 ? 'text-red-400' : 'text-gray-600'}`} />
                            <span className={riskMetrics.reversal.negativeDurationMinutes >= 60 ? 'text-red-300' : 'text-gray-600'}>
                              Level 3 (60min): Full reversal — inversion + aggressive close worst — {riskMetrics.reversal.negativeDurationMinutes >= 60 ? 'ACTIVE — maximum defensive response' : `in ${Math.max(0, 60 - riskMetrics.reversal.negativeDurationMinutes).toFixed(0)}min`}
                            </span>
                          </div>
                        </div>
                      </div>
                      {riskMetrics.reversal.positionsClosed > 0 && (
                        <p className="text-xs text-orange-400 mt-1" data-testid="text-reversal-closed">
                          Reversal has force-closed {riskMetrics.reversal.positionsClosed} underwater position(s) to stem losses.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {(riskMetrics.portfolioMetric?.value ?? 0) >= 0
                        ? "Portfolio metric is non-negative — no reversal needed. System arms automatically if metric stays negative for 20+ minutes."
                        : `Portfolio metric just went negative. Timer running — Level 1 (signal inversion) activates after 20 continuous minutes below zero. Currently at ${(riskMetrics.reversal?.negativeDurationMinutes ?? 0).toFixed(0)}min.`}
                    </p>
                  )}
                </div>
              </div>

              {/* Row 5: Active Trade Manager summary */}
              <div className="flex items-start gap-3">
                <Bot className="w-4 h-4 text-cyan-400 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-gray-300 font-medium">Active Trade Manager (ATM):</span>
                    <Badge variant="outline" className="text-xs font-mono border-cyan-600 text-cyan-400" data-testid="badge-atm-status">
                      RUNNING (5s interval)
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    6 protection layers active on every position: trailing stops (0.4% activation, 0.6% trail), breakeven stops (40% of TP1), minimum profit enforcement (0.10%), portfolio-aware tightening{(riskMetrics.portfolioMetric?.value ?? 0) < 0 ? ' (ENGAGED — halving stop distance on losers)' : ''}, time decay exits (12h stale), aggressive profit protection{(riskMetrics.portfolioMetric?.value ?? 0) < -10 ? ' (ENGAGED — tight 0.2% trail on profitable positions)' : ''}.
                  </p>
                </div>
              </div>

            </div>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-slate-800/50 border border-cyan-500/20">
            <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
            <TabsTrigger value="positions" data-testid="tab-positions">
              Positions ({new Set(portfolio.positions.map((p: Position) => p.symbol)).size})
            </TabsTrigger>
            <TabsTrigger value="trades" data-testid="tab-trades">
              History ({trades?.filter(t => t.status !== "open").length || 0})
            </TabsTrigger>
            <TabsTrigger value="stats" data-testid="tab-stats">Stats</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-3">
            {/* Basket Strategy Display */}
            {strategyStatus && strategyStatus.basket && (
              <div className="bg-gradient-to-r from-emerald-900/30 to-cyan-900/30 rounded-lg p-3 mb-3 border border-emerald-500/30">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm text-white">Basket Mode</span>
                    <Badge 
                      variant="outline" 
                      className="font-mono text-sm border-emerald-500 text-emerald-400"
                      data-testid="badge-trading-mode"
                    >
                      MOMENTUM BASKET
                    </Badge>
                    {strategyStatus.regime && (
                      <Badge
                        variant="outline"
                        className={`font-mono text-xs ${
                          strategyStatus.regime.regime === 'BULLISH' ? 'border-green-500 text-green-400' :
                          strategyStatus.regime.regime === 'BEARISH' ? 'border-red-500 text-red-400' :
                          'border-yellow-500 text-yellow-400'
                        }`}
                        data-testid="badge-market-regime"
                      >
                        {strategyStatus.regime.regime} {strategyStatus.regime.volRegime === 'HIGH_VOL' ? '🔥' : strategyStatus.regime.volRegime === 'LOW_VOL' ? '❄️' : ''}
                      </Badge>
                    )}
                    <span className="text-xs text-gray-500">
                      (25% cap)
                    </span>
                  </div>
                  <div className="flex gap-3 text-xs">
                    <div>
                      <span className="text-gray-500">Exposure: </span>
                      <span className={`font-mono ${strategyStatus.basket.exposurePercent > 20 ? 'text-yellow-400' : 'text-green-400'}`}>
                        ${strategyStatus.basket.totalExposure} ({strategyStatus.basket.exposurePercent}%)
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500">P&L: </span>
                      <span className={`font-mono ${strategyStatus.basket.totalUnrealized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${strategyStatus.basket.totalUnrealized.toFixed(2)}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500">Next: </span>
                      <span className="font-mono text-cyan-400">
                        {strategyStatus.basket.nextRebalanceMs > 0 ? `${Math.ceil(strategyStatus.basket.nextRebalanceMs / 60000)}m` : 'now'}
                      </span>
                    </div>
                  </div>
                </div>
                {strategyStatus.regime && (
                  <div className="flex gap-3 text-xs mb-2 flex-wrap" data-testid="regime-details">
                    <div>
                      <span className="text-gray-500">MOM: </span>
                      <span className="font-mono text-cyan-400">{strategyStatus.regime.momNorm.toFixed(3)}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">L×: </span>
                      <span className="font-mono text-green-400">{strategyStatus.regime.longMultiplier}×</span>
                    </div>
                    <div>
                      <span className="text-gray-500">S×: </span>
                      <span className="font-mono text-red-400">{strategyStatus.regime.shortMultiplier}×</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Scale-in: </span>
                      <span className={`font-mono ${strategyStatus.regime.scaleInEnabled ? 'text-cyan-400' : 'text-gray-600'}`}>
                        {strategyStatus.regime.scaleInEnabled ? strategyStatus.regime.scaleInDirection : 'OFF'}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500">P-Stop: </span>
                      <span className="font-mono text-yellow-400">-{(strategyStatus.regime.portfolioStopPercent * 100).toFixed(1)}%</span>
                    </div>
                  </div>
                )}
                <div className="flex gap-4 text-xs">
                  <div className="flex items-center gap-1">
                    <TrendingUp className="w-3 h-3 text-green-400" />
                    <span className="text-gray-500">Long:</span>
                    <span className="font-mono text-green-400">
                      {strategyStatus.basket.longSymbols.length > 0 ? strategyStatus.basket.longSymbols.join(', ') : '—'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <TrendingDown className="w-3 h-3 text-red-400" />
                    <span className="text-gray-500">Short:</span>
                    <span className="font-mono text-red-400">
                      {strategyStatus.basket.shortSymbols.length > 0 ? strategyStatus.basket.shortSymbols.join(', ') : '—'}
                    </span>
                  </div>
                </div>
              </div>
            )}
            
            {riskMetrics && (
              <div className="bg-gradient-to-r from-purple-900/30 to-cyan-900/30 rounded-lg p-3 mb-3 border border-purple-500/30">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <Target className="w-4 h-4 text-purple-400" />
                    <span className="text-sm text-white">Portfolio Metric:</span>
                    <span className={`font-mono text-lg font-bold ${(riskMetrics.portfolioMetric?.value ?? 0) < 0 ? 'text-red-400' : 'text-purple-400'}`} data-testid="text-portfolio-metric">
                      {(riskMetrics.portfolioMetric?.value ?? 0).toFixed(3)}
                    </span>
                    {riskMetrics.portfolioMetric?.drawdownProtectionActive && (
                      <span className="text-xs text-red-400 font-semibold px-1.5 py-0.5 bg-red-900/30 rounded border border-red-500/30">MIN VOL</span>
                    )}
                    <span className="text-xs text-gray-500">(Sharpe / Ulcer)</span>
                  </div>
                  <div className="flex gap-4 text-xs">
                    <div>
                      <span className="text-gray-500">Sharpe: </span>
                      <span className="font-mono text-cyan-400">{(riskMetrics.overall?.sharpeRatio ?? 0).toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Ulcer: </span>
                      <span className="font-mono text-yellow-400">{(riskMetrics.overall?.ulcerIndex ?? 0).toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Corr Trades: </span>
                      <span className="font-mono text-green-400">{riskMetrics.correlation?.totalTrades ?? 0}</span>
                    </div>
                  </div>
                </div>
                {riskMetrics.equityCurve && riskMetrics.equityCurve.lastUpdated > 0 && (
                  <div className="mt-2 pt-2 border-t border-purple-500/20">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <Activity className="w-3 h-3 text-cyan-400" />
                        <span className="text-xs text-gray-400">Equity Curve:</span>
                        <span className={`font-mono text-sm font-bold ${
                          riskMetrics.equityCurve.regime === 'AGGRESSIVE' ? 'text-green-400' :
                          riskMetrics.equityCurve.regime === 'NEUTRAL' ? 'text-yellow-400' :
                          riskMetrics.equityCurve.regime === 'DEFENSIVE' ? 'text-orange-400' :
                          'text-red-400'
                        }`} data-testid="text-equity-regime">
                          {riskMetrics.equityCurve.regime}
                        </span>
                        <span className="text-xs text-gray-500 font-mono" data-testid="text-equity-size">
                          ({(riskMetrics.equityCurve.sizeMultiplier * 100).toFixed(0)}% size)
                        </span>
                        {riskMetrics.equityCurve.recoveryModeActive && (
                          <span className="text-xs text-amber-400 font-semibold px-1.5 py-0.5 bg-amber-900/30 rounded border border-amber-500/30" data-testid="badge-recovery-mode">
                            RECOVERY
                          </span>
                        )}
                      </div>
                      <div className="flex gap-3 text-xs flex-wrap">
                        <div>
                          <span className="text-gray-500">Norm: </span>
                          <span className={`font-mono ${riskMetrics.equityCurve.normalizedMetric >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {riskMetrics.equityCurve.normalizedMetric.toFixed(3)}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">Mom: </span>
                          <span className={`font-mono ${riskMetrics.equityCurve.momentum >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {riskMetrics.equityCurve.momentum >= 0 ? '+' : ''}{riskMetrics.equityCurve.momentum.toFixed(3)}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">Z: </span>
                          <span className="font-mono text-cyan-400">{riskMetrics.equityCurve.zScore.toFixed(2)}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Losses: </span>
                          <span className="font-mono text-red-400">S{riskMetrics.equityCurve.shortLosses}</span>
                          <span className="text-gray-600">/</span>
                          <span className="font-mono text-orange-400">L{riskMetrics.equityCurve.longLosses}</span>
                          {riskMetrics.equityCurve.lossDirection !== 'INSUFFICIENT_DATA' && riskMetrics.equityCurve.lossDirection !== 'MIXED' && (
                            <span className={`ml-1 text-xs ${riskMetrics.equityCurve.lossDirection === 'SHORT_LOSSES' ? 'text-red-300' : 'text-orange-300'}`}>
                              ({riskMetrics.equityCurve.lossDirection === 'SHORT_LOSSES' ? 'Shorts Losing' : 'Longs Losing'})
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            
            {/* Momentum Rankings */}
            {strategyStatus?.rankings && strategyStatus.rankings.length > 0 && (
              <div className="bg-gradient-to-r from-cyan-900/30 to-blue-900/30 rounded-lg p-3 mb-3 border border-cyan-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <Activity className="w-4 h-4 text-cyan-400" />
                  <span className="text-sm text-white">Momentum Rankings (30min):</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {strategyStatus.rankings.map((coin, index) => (
                    <Badge 
                      key={coin.symbol} 
                      variant="outline" 
                      className={`text-xs font-mono ${
                        coin.inLongBasket ? 'border-green-500/70 text-green-400 bg-green-500/10' :
                        coin.inShortBasket ? 'border-red-500/70 text-red-400 bg-red-500/10' :
                        'border-cyan-500/30 text-gray-400'
                      }`}
                      title={`${coin.coinName} | Mom: ${coin.momentum30m.toFixed(4)}% | ATR: ${coin.atrPercent}% | ${coin.confirmed ? 'Confirmed' : 'Unconfirmed'}`}
                      data-testid={`badge-ranking-${coin.symbol}`}
                    >
                      #{index + 1} {coin.symbol} {coin.momentum30m >= 0 ? '+' : ''}{coin.momentum30m.toFixed(3)}%
                      {coin.inLongBasket && ' ▲'}
                      {coin.inShortBasket && ' ▼'}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-base">
              <div className="bg-slate-800/30 rounded p-3">
                <div className="text-white text-sm">Balance</div>
                <div className="font-mono text-lg text-cyan-400">{formatCurrency(portfolio.balance)}</div>
              </div>
              <div className="bg-slate-800/30 rounded p-3">
                <div className="text-white text-sm">Available Margin</div>
                <div className="font-mono text-lg text-white">{formatCurrency(portfolio.availableMargin)}</div>
              </div>
              <div className="bg-slate-800/30 rounded p-3">
                <div className="text-white text-sm">Used Margin</div>
                <div className="font-mono text-lg text-yellow-400">{formatCurrency(portfolio.usedMargin)}</div>
              </div>
              <div className="bg-slate-800/30 rounded p-3">
                <div className="text-white text-sm">Unrealized P&L</div>
                <div className={`font-mono text-lg ${portfolio.unrealizedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {formatPnl(portfolio.unrealizedPnl)}
                </div>
              </div>
            </div>

            {stats && (
              <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mt-3 text-base">
                <div className="bg-slate-800/30 rounded p-3 text-center">
                  <div className="text-white text-sm">Win Rate</div>
                  <div className={`font-mono text-lg ${(stats.winRate ?? 0) >= 50 ? "text-green-400" : "text-red-400"}`}>
                    {(stats.winRate ?? 0).toFixed(1)}%
                  </div>
                </div>
                <div className="bg-slate-800/30 rounded p-3 text-center">
                  <div className="text-white text-sm">Profit Factor</div>
                  <div className={`font-mono text-lg ${(stats.profitFactor ?? 0) >= 1 ? "text-green-400" : "text-red-400"}`}>
                    {stats.profitFactor === Infinity ? "∞" : (stats.profitFactor ?? 0).toFixed(2)}
                  </div>
                </div>
                <div className="bg-slate-800/30 rounded p-3 text-center">
                  <div className="text-white text-sm">Total Trades</div>
                  <div className="font-mono text-lg text-white">{stats.totalTrades}</div>
                </div>
                <div className="bg-slate-800/30 rounded p-3 text-center">
                  <div className="text-white text-sm">Wins</div>
                  <div className="font-mono text-lg text-green-400">{stats.winningTrades}</div>
                </div>
                <div className="bg-slate-800/30 rounded p-3 text-center">
                  <div className="text-white text-sm">Losses</div>
                  <div className="font-mono text-lg text-red-400">{stats.losingTrades}</div>
                </div>
                <div className="bg-slate-800/30 rounded p-3 text-center">
                  <div className="text-white text-sm">Fees Paid</div>
                  <div className="font-mono text-lg text-white">{formatCurrency(stats.totalFees)}</div>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="positions" className="mt-3">
            {portfolio.positions.length === 0 ? (
              <div className="text-center py-6 text-gray-500">
                <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>No open positions</p>
                <p className="text-xs mt-1">Click "Analyze" to let AI find trading opportunities</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-72 overflow-y-auto">
                {(() => {
                  const grouped: Record<string, Position[]> = {};
                  portfolio.positions.forEach((p: Position) => {
                    const key = `${p.symbol}_${p.side}`;
                    if (!grouped[key]) grouped[key] = [];
                    grouped[key].push(p);
                  });
                  return Object.entries(grouped).map(([key, layers]) => {
                    const first = layers[0];
                    const totalQty = layers.reduce((s, l) => s + l.quantity, 0);
                    const totalPnl = layers.reduce((s, l) => s + l.unrealizedPnl, 0);
                    const avgEntry = layers.reduce((s, l) => s + l.entryPrice * l.quantity, 0) / totalQty;
                    const totalValue = layers.reduce((s, l) => s + l.entryPrice * l.quantity, 0);
                    const totalPnlPct = totalValue > 0 ? (totalPnl / totalValue) * 100 : 0;
                    return (
                      <div
                        key={key}
                        className="bg-slate-800/50 rounded-lg p-4 border border-cyan-500/10"
                        data-testid={`position-group-${key}`}
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <Badge variant={first.side === "long" ? "default" : "destructive"} className="text-sm">
                              {first.side.toUpperCase()}
                            </Badge>
                            <span className="font-semibold text-lg text-white">{first.symbol}</span>
                            <span className="text-sm text-white">{first.coinName}</span>
                            {layers.length > 1 && (
                              <span className="text-xs text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded">
                                {layers.length} layers
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-5 gap-3 mt-3 text-sm">
                          <div>
                            <div className="text-white">Total Size</div>
                            <div className="font-mono text-base text-purple-400">{totalQty.toFixed(4)}</div>
                          </div>
                          <div>
                            <div className="text-white">Avg Entry</div>
                            <div className="font-mono text-base text-white">{formatPrice(avgEntry)}</div>
                          </div>
                          <div>
                            <div className="text-white">Current</div>
                            <div className="font-mono text-base text-cyan-400">{formatPrice(first.currentPrice)}</div>
                          </div>
                          <div>
                            <div className="text-white">Stop Loss</div>
                            <div className="font-mono text-base text-red-400">{formatPrice(first.stopLoss)}</div>
                          </div>
                          <div>
                            <div className="text-white">P&L</div>
                            <div className={`font-mono text-base ${totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                              {formatPnl(totalPnl)} ({totalPnlPct >= 0 ? "+" : ""}{totalPnlPct.toFixed(2)}%)
                            </div>
                          </div>
                        </div>
                        {layers.length > 1 && (
                          <div className="mt-2 space-y-1 border-t border-cyan-500/10 pt-2">
                            {layers.map((layer, i) => (
                              <div key={layer.id} className="flex justify-between text-xs text-gray-400 font-mono" data-testid={`layer-${layer.id}`}>
                                <span>L{i + 1}: {layer.quantity.toFixed(4)} @ {formatPrice(layer.entryPrice)}</span>
                                <span className={layer.unrealizedPnl >= 0 ? "text-green-400/70" : "text-red-400/70"}>
                                  {formatPnl(layer.unrealizedPnl)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </TabsContent>

          <TabsContent value="trades" className="mt-3">
            {!trades || trades.filter(t => t.status !== "open").length === 0 ? (
              <div className="text-center py-6 text-gray-500">
                <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>No trade history yet</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {trades.filter(t => t.status !== "open").map((trade: TradeRecord) => (
                  <div
                    key={trade.id}
                    className="bg-slate-800/50 rounded-lg p-3 border border-cyan-500/10"
                    data-testid={`trade-${trade.id}`}
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <Badge variant={trade.side === "long" ? "default" : "destructive"} className="text-sm">
                          {trade.side.toUpperCase()}
                        </Badge>
                        <span className="font-semibold text-lg text-white">{trade.symbol}</span>
                        {trade.signalMode && (
                          <Badge 
                            variant="outline" 
                            className={`text-xs ${
                              trade.signalMode === 'volExpansion' 
                                ? 'border-orange-500 text-orange-400' 
                                : trade.signalMode === 'meanReversion'
                                ? 'border-blue-500 text-blue-400'
                                : trade.signalMode === 'momentum'
                                ? 'border-yellow-500 text-yellow-400'
                                : 'border-purple-500 text-purple-400'
                            }`}
                          >
                            {trade.signalMode === 'volExpansion' ? 'VE' : trade.signalMode === 'meanReversion' ? 'MR' : trade.signalMode === 'momentum' ? 'MO' : 'PT'}
                          </Badge>
                        )}
                        <Badge variant={trade.status === "stopped_out" ? "destructive" : "secondary"} className="text-sm">
                          {trade.status === "stopped_out" ? "STOPPED" : "CLOSED"}
                        </Badge>
                      </div>
                      <div className={`font-mono text-base ${(trade.pnl || 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {formatPnl(trade.pnl || 0)} ({formatPercent(trade.pnlPercent || 0)})
                      </div>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-2 text-sm text-white">
                      <div>
                        <span className="text-gray-400">Qty:</span>
                        <span className="font-mono text-purple-400 ml-1">{trade.quantity.toFixed(4)}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Entry:</span>
                        <span className="font-mono ml-1">{formatPrice(trade.entryPrice)}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Exit:</span>
                        <span className="font-mono text-cyan-400 ml-1">{trade.exitPrice ? formatPrice(trade.exitPrice) : "N/A"}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Fees:</span>
                        <span className="font-mono text-yellow-400 ml-1">${(trade.fees || 0).toFixed(4)}</span>
                      </div>
                      <div>
                        <span className="text-gray-400">Slip:</span>
                        <span className="font-mono text-red-300 ml-1">${((trade.slippage || 0) * trade.quantity).toFixed(4)}</span>
                      </div>
                    </div>
                    {trade.openReason && (
                      <div className="text-xs text-emerald-400/70 mt-1" data-testid={`text-open-reason-${trade.id}`}>
                        <span className="text-gray-500">Open:</span> {trade.openReason}
                      </div>
                    )}
                    {trade.closeReason && (
                      <div className="text-xs text-amber-400/70 mt-0.5" data-testid={`text-close-reason-${trade.id}`}>
                        <span className="text-gray-500">Close:</span> {trade.closeReason}
                      </div>
                    )}
                    {trade.closedAt && (
                      <div className="text-xs text-gray-500 mt-1">{formatTime(trade.closedAt)}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="stats" className="mt-3">
            {!stats || stats.totalTrades === 0 ? (
              <div className="text-center py-6 text-gray-500">
                <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>Complete some trades to see statistics</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-base">
                <div className="bg-slate-800/30 rounded p-3">
                  <div className="text-white text-sm flex items-center gap-1">
                    <Target className="w-4 h-4" />
                    Avg Win
                  </div>
                  <div className="font-mono text-lg text-green-400">{formatPnl(stats.avgWin)}</div>
                </div>
                <div className="bg-slate-800/30 rounded p-3">
                  <div className="text-white text-sm">Avg Loss</div>
                  <div className="font-mono text-lg text-red-400">{formatPnl(stats.avgLoss)}</div>
                </div>
                <div className="bg-slate-800/30 rounded p-3">
                  <div className="text-white text-sm">Best Trade</div>
                  <div className="font-mono text-lg text-green-400">{formatPnl(stats.bestTrade)}</div>
                </div>
                <div className="bg-slate-800/30 rounded p-3">
                  <div className="text-white text-sm">Worst Trade</div>
                  <div className="font-mono text-lg text-red-400">{formatPnl(stats.worstTrade)}</div>
                </div>
                <div className="bg-slate-800/30 rounded p-3">
                  <div className="text-white text-sm">Max Drawdown</div>
                  <div className="font-mono text-lg text-yellow-400">{(stats.maxDrawdown ?? 0).toFixed(2)}%</div>
                </div>
                <div className="bg-slate-800/30 rounded p-3">
                  <div className="text-white text-sm">Total Slippage</div>
                  <div className="font-mono text-lg text-white">{formatCurrency(stats.totalSlippage)}</div>
                </div>
                {stats.cryptoExposure?.length > 0 && (
                  <div className="bg-slate-800/30 rounded p-3 col-span-2">
                    <div className="text-white text-sm mb-1">Current Exposure</div>
                    <div className="flex flex-wrap gap-2">
                      {stats.cryptoExposure?.map(exp => (
                        <Badge key={exp.symbol} variant="outline" className="text-sm">
                          {exp.symbol}: {(exp.exposurePercent ?? 0).toFixed(1)}%
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
