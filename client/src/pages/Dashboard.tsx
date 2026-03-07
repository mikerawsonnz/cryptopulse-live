import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Header } from "@/components/dashboard/Header";
import { CryptoCard } from "@/components/dashboard/CryptoCard";
import { PriceTicker } from "@/components/dashboard/PriceTicker";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { DashboardSkeleton } from "@/components/dashboard/LoadingSkeleton";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { DivergenceAlerts } from "@/components/dashboard/DivergenceAlerts";
import { WhaleFlowGauge } from "@/components/dashboard/WhaleFlowGauge";
import { CorrelationTracker } from "@/components/dashboard/CorrelationTracker";
import { AIInsightPanel } from "@/components/dashboard/AIInsightPanel";
import { PolymarketPanel } from "@/components/dashboard/PolymarketPanel";
import { LiquidationPanel } from "@/components/dashboard/LiquidationPanel";
import { AIPredictionsPanel } from "@/components/dashboard/AIPredictionsPanel";
import { CapitalFlowTracker } from "@/components/dashboard/CapitalFlowTracker";
import { OnChainMetrics } from "@/components/dashboard/OnChainMetrics";
import { PortfolioPanel } from "@/components/dashboard/PortfolioPanel";
import { ModeStatsPanel } from "@/components/dashboard/ModeStatsPanel";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { 
  CryptoData, 
  SentimentData, 
  WhaleTransaction, 
  CompositeSentiment,
  DivergenceSignal,
  CorrelationData,
  WhaleFlow,
  PolymarketData,
  LiquidationCluster,
  AIInsight,
  AIPrediction,
  PredictionAccuracy
} from "@shared/schema";

function calculateCompositeSentiment(
  crypto: CryptoData,
  btcSentiment: SentimentData | null
): CompositeSentiment {
  const priceChange = crypto.price_change_percentage_24h ?? 0;
  const priceScore = Math.max(-1, Math.min(1, priceChange / 10));

  const avgVolume = crypto.market_cap * 0.05;
  const volumeRatio = crypto.total_volume / avgVolume;
  const volumeScore = Math.max(-1, Math.min(1, (volumeRatio - 1) * 0.5));

  const socialScore = btcSentiment?.score ?? 0;

  const compositeScore = priceScore * 0.4 + volumeScore * 0.2 + socialScore * 0.4;

  let label: "bullish" | "neutral" | "bearish" = "neutral";
  if (compositeScore > 0.15) label = "bullish";
  else if (compositeScore < -0.15) label = "bearish";

  return {
    coin: crypto.id,
    priceScore,
    volumeScore,
    socialScore,
    compositeScore,
    label,
    timestamp: new Date().toISOString(),
  };
}

export default function Dashboard() {
  const {
    cryptos: wsCryptos,
    btcSentiment: wsSentiment,
    whaleTransactions: wsWhales,
    signals: wsSignals,
    isConnected,
    lastUpdated,
    error: wsError,
    reconnect,
  } = useWebSocket();

  const {
    data: initialCryptos,
    isLoading: cryptosLoading,
    error: cryptosError,
    refetch: refetchCryptos,
  } = useQuery<CryptoData[]>({
    queryKey: ["/api/crypto"],
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const {
    data: initialSentiment,
    isLoading: sentimentLoading,
  } = useQuery<SentimentData>({
    queryKey: ["/api/sentiment"],
    refetchInterval: 120000,
    staleTime: 60000,
  });

  const {
    data: initialWhales,
    isLoading: whalesLoading,
  } = useQuery<WhaleTransaction[]>({
    queryKey: ["/api/whales"],
    refetchInterval: 30000,
    staleTime: 15000,
  });

  const {
    data: polymarketData,
    isLoading: polymarketLoading,
  } = useQuery<PolymarketData[]>({
    queryKey: ["/api/polymarket"],
    refetchInterval: 120000,
    staleTime: 60000,
  });

  const {
    data: liquidationData,
    isLoading: liquidationLoading,
  } = useQuery<{ liquidations: any[]; clusters: LiquidationCluster[]; volatilityZones?: any[] }>({
    queryKey: ["/api/liquidations"],
    refetchInterval: 30000,
    staleTime: 10000,
  });

  const {
    data: signalsData,
    isLoading: signalsLoading,
  } = useQuery<{ divergences: DivergenceSignal[]; whaleFlow: WhaleFlow; correlations: CorrelationData[] }>({
    queryKey: ["/api/signals"],
    refetchInterval: 30000,
    staleTime: 15000,
  });

  const cryptos = wsCryptos.length > 0 ? wsCryptos : (initialCryptos ?? []);
  
  const {
    data: aiInsight,
    isLoading: aiLoading,
    refetch: refetchAiInsight,
  } = useQuery<AIInsight>({
    queryKey: ["/api/ai-insight"],
    refetchInterval: 300000,
    staleTime: 300000,
    enabled: cryptos.length > 0,
  });

  const {
    data: predictionsData,
    isLoading: predictionsLoading,
  } = useQuery<{ active: AIPrediction[]; resolved: AIPrediction[]; accuracy: PredictionAccuracy[] }>({
    queryKey: ["/api/predictions"],
    refetchInterval: 60000,
    staleTime: 30000,
    enabled: cryptos.length > 0,
  });

  const btcSentiment = wsSentiment ?? initialSentiment ?? null;
  const whaleTransactions = wsWhales.length > 0 ? wsWhales : (initialWhales ?? []);

  const divergences = wsSignals?.divergences ?? signalsData?.divergences ?? [];
  const whaleFlow = wsSignals?.whaleFlow ?? signalsData?.whaleFlow ?? {
    netFlow: 0,
    bullishness: 0.5,
    inflow: 0,
    outflow: 0,
    largestTransaction: null,
  };
  const correlations = wsSignals?.correlations ?? signalsData?.correlations ?? [];
  const polymarkets = polymarketData ?? [];
  const liquidationClusters = liquidationData?.clusters ?? [];
  const volatilityZones = liquidationData?.volatilityZones ?? [];

  const sentiments = useMemo(() => {
    return cryptos.map((crypto) => calculateCompositeSentiment(crypto, btcSentiment));
  }, [cryptos, btcSentiment]);

  const isLoading = cryptosLoading && cryptos.length === 0;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background cyber-grid">
        <Header isConnected={false} lastUpdated={null} />
        <main className="container mx-auto px-4 py-6">
          <DashboardSkeleton />
        </main>
      </div>
    );
  }

  if (cryptosError && cryptos.length === 0) {
    return (
      <div className="min-h-screen bg-background cyber-grid">
        <Header isConnected={isConnected} lastUpdated={lastUpdated} />
        <main className="container mx-auto px-4 py-6">
          <ErrorState
            title="Failed to load crypto data"
            message="Unable to fetch cryptocurrency data. Please check your connection and try again."
            onRetry={() => {
              refetchCryptos();
              reconnect();
            }}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background cyber-grid scanlines" data-testid="dashboard">
      <Header isConnected={isConnected} lastUpdated={lastUpdated} />

      <PriceTicker cryptos={cryptos} />

      <main className="container mx-auto px-4 py-6">
        <StatsBar cryptos={cryptos} />

        <h2 className="font-display font-semibold text-xl tracking-wide mb-4 text-glow-magenta">
          PREDICTIVE SIGNAL TERMINAL
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <AIInsightPanel 
            insight={aiInsight ?? null} 
            onRefresh={() => refetchAiInsight()}
            isLoading={aiLoading}
          />
          <AIPredictionsPanel
            predictions={predictionsData?.active ?? []}
            resolved={predictionsData?.resolved ?? []}
            accuracy={predictionsData?.accuracy ?? []}
            isLoading={predictionsLoading}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
          <DivergenceAlerts divergences={divergences} />
          <CapitalFlowTracker />
          <CorrelationTracker correlations={correlations} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
          <PolymarketPanel markets={polymarkets} />
          <LiquidationPanel clusters={liquidationClusters} volatilityZones={volatilityZones} />
          <WhaleFlowGauge whaleFlow={whaleFlow} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <OnChainMetrics />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-6">
          <div className="lg:col-span-3">
            <h2 className="font-display font-semibold text-xl tracking-wide mb-4 text-glow-cyan">
              TOP CRYPTOCURRENCIES
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {cryptos.slice(0, 10).map((crypto, index) => (
                <CryptoCard
                  key={crypto.id}
                  crypto={crypto}
                  sentiment={sentiments.find((s) => s.coin === crypto.id)}
                  index={index}
                />
              ))}
            </div>
          </div>

        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <div className="lg:col-span-1">
            <ModeStatsPanel />
          </div>
          <div className="lg:col-span-2">
            <PortfolioPanel />
          </div>
        </div>

        <footer className="text-center py-8 border-t border-border/30">
          <p className="text-xs font-mono text-muted-foreground">
            Data from{" "}
            <span className="text-primary">CoinGecko</span>,{" "}
            <span className="text-accent">SentiCrypt</span>,{" "}
            <span className="text-secondary">Helius</span>,{" "}
            <span className="text-purple-400">Polymarket</span>,{" "}
            <span className="text-orange-400">Binance</span>,{" "}
            <span className="text-green-400">DeFiLlama</span> &{" "}
            <span className="text-cyan-400">OpenAI</span>
          </p>
          <p className="text-[10px] font-mono text-muted-foreground mt-1">
            Updates every 30-60 seconds | Whale threshold: $100K+ | AI analysis: 5min cooldown
          </p>
        </footer>
      </main>
    </div>
  );
}
