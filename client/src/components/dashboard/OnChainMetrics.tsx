import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import { TrendingUp, TrendingDown, Activity, AlertTriangle, CheckCircle, Minus } from "lucide-react";
import { WidgetTooltip, widgetDescriptions } from "./WidgetTooltip";

interface OnChainMetric {
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

interface OnChainData {
  btc: OnChainMetric | null;
  eth: OnChainMetric | null;
  market: {
    totalMarketCap: number;
    avgMvrv: number;
    overallSentiment: string;
  } | null;
  lastUpdated: string;
}

const zoneColors: Record<string, string> = {
  capitulation: "text-red-500",
  hope: "text-yellow-500",
  optimism: "text-green-400",
  belief: "text-cyan-400",
  euphoria: "text-magenta-400",
};

const zoneBgColors: Record<string, string> = {
  capitulation: "bg-red-500/20 border-red-500/50",
  hope: "bg-yellow-500/20 border-yellow-500/50",
  optimism: "bg-green-500/20 border-green-500/50",
  belief: "bg-cyan-500/20 border-cyan-500/50",
  euphoria: "bg-magenta-500/20 border-magenta-500/50",
};

function MVRVGauge({ zScore }: { zScore: number }) {
  const normalizedScore = Math.max(-2, Math.min(8, zScore));
  const percentage = ((normalizedScore + 2) / 10) * 100;
  
  const getColor = () => {
    if (zScore > 4) return "#ff4466";
    if (zScore > 2) return "#ffaa00";
    if (zScore > 0) return "#88ff88";
    if (zScore > -1) return "#00ff88";
    return "#00ffff";
  };

  return (
    <div className="relative h-2 bg-background/50 rounded-full overflow-hidden">
      <div className="absolute inset-0 flex">
        <div className="w-1/5 bg-cyan-500/20" />
        <div className="w-1/5 bg-green-500/20" />
        <div className="w-1/5 bg-yellow-500/20" />
        <div className="w-1/5 bg-orange-500/20" />
        <div className="w-1/5 bg-red-500/20" />
      </div>
      <motion.div
        className="absolute top-0 h-full w-1 rounded-full"
        style={{ backgroundColor: getColor() }}
        initial={{ left: "50%" }}
        animate={{ left: `${percentage}%` }}
        transition={{ duration: 0.8, ease: "easeOut" }}
      />
    </div>
  );
}

function NUPLBar({ nupl, zone }: { nupl: number; zone: string }) {
  const percentage = Math.max(0, Math.min(100, (nupl + 0.5) * 100));
  
  return (
    <div className="relative h-3 bg-background/50 rounded-full overflow-hidden">
      <motion.div
        className={`h-full rounded-full ${zoneBgColors[zone]?.split(" ")[0] || "bg-cyan-500/30"}`}
        initial={{ width: 0 }}
        animate={{ width: `${percentage}%` }}
        transition={{ duration: 0.8, ease: "easeOut" }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[9px] font-mono text-foreground/70">
          {(nupl * 100).toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

function MetricCard({ metric }: { metric: OnChainMetric }) {
  const getMVRVIcon = () => {
    if (metric.mvrvZScore > 4) return <AlertTriangle className="w-4 h-4 text-red-400" />;
    if (metric.mvrvZScore > 2) return <TrendingUp className="w-4 h-4 text-yellow-400" />;
    if (metric.mvrvZScore < -1) return <CheckCircle className="w-4 h-4 text-green-400" />;
    return <Minus className="w-4 h-4 text-muted-foreground" />;
  };

  return (
    <div className="bg-background/30 rounded p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-display font-bold text-foreground">{metric.symbol}</span>
        <Badge 
          variant="outline" 
          className={`text-[10px] ${zoneBgColors[metric.nuplZone] || ""}`}
        >
          {(metric.nuplZone || "unknown").toUpperCase()}
        </Badge>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">MVRV Z-Score</span>
          <div className="flex items-center gap-1">
            {getMVRVIcon()}
            <span className={`text-sm font-mono font-bold ${
              metric.mvrvZScore > 4 ? "text-red-400" :
              metric.mvrvZScore > 2 ? "text-yellow-400" :
              metric.mvrvZScore < -1 ? "text-green-400" :
              "text-foreground"
            }`}>
              {metric.mvrvZScore > 0 ? "+" : ""}{metric.mvrvZScore.toFixed(2)}
            </span>
          </div>
        </div>
        <MVRVGauge zScore={metric.mvrvZScore} />
        <p className="text-[10px] text-muted-foreground mt-1">{metric.mvrvInterpretation}</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">NUPL</span>
          <span className={`text-sm font-mono font-bold ${zoneColors[metric.nuplZone] || "text-foreground"}`}>
            {(metric.nupl * 100).toFixed(1)}%
          </span>
        </div>
        <NUPLBar nupl={metric.nupl} zone={metric.nuplZone} />
        <p className="text-[10px] text-muted-foreground mt-1">{metric.nuplInterpretation}</p>
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Price vs 7d Avg</span>
        <span className={`font-mono ${
          metric.priceToAvg7d > 0 ? "text-green-400" : 
          metric.priceToAvg7d < 0 ? "text-red-400" : 
          "text-foreground"
        }`}>
          {metric.priceToAvg7d > 0 ? "+" : ""}{metric.priceToAvg7d.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}

export function OnChainMetrics() {
  const { data, isLoading } = useQuery<OnChainData>({
    queryKey: ["/api/onchain"],
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <Card className="p-4 bg-card/50 border-border/50">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold text-cyan-400">On-Chain Valuation</h3>
        </div>
        <div className="animate-pulse space-y-3">
          <div className="h-24 bg-muted/20 rounded" />
          <div className="h-24 bg-muted/20 rounded" />
        </div>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className="p-4 bg-card/50 border-border/50">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold text-cyan-400">On-Chain Valuation</h3>
        </div>
        <div className="text-center py-6 text-muted-foreground text-sm">
          Loading on-chain metrics...
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4 bg-card/50 border-border/50" data-testid="onchain-metrics">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-purple-400" />
          <h3 className="font-display text-lg font-bold text-cyan-400">On-Chain Valuation</h3>
        </div>
        <WidgetTooltip {...widgetDescriptions.onChainMetrics} />
      </div>

      <div className="bg-background/20 rounded p-2 mb-4 text-center">
        <div className="text-xs text-muted-foreground">Market Sentiment</div>
        <div className={`text-sm font-bold ${
          (data.market?.avgMvrv ?? 0) > 2 ? "text-yellow-400" :
          (data.market?.avgMvrv ?? 0) < 0 ? "text-green-400" :
          "text-foreground"
        }`}>
          {data.market?.overallSentiment ?? "Unavailable"}
        </div>
        <div className="text-[10px] text-muted-foreground">
          Avg MVRV: {(data.market?.avgMvrv ?? 0).toFixed(2)}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {data.btc && <MetricCard metric={data.btc} />}
        {data.eth && <MetricCard metric={data.eth} />}
      </div>

      <div className="mt-3 pt-3 border-t border-border/30 text-center">
        <p className="text-[10px] text-muted-foreground">
          MVRV & NUPL approximated using 7-day price history
        </p>
      </div>
    </Card>
  );
}
