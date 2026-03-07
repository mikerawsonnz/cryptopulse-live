import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { motion } from "framer-motion";
import { ArrowUpRight, ArrowDownRight, Minus, TrendingUp, TrendingDown, ArrowLeftRight, DollarSign } from "lucide-react";
import { WidgetTooltip, widgetDescriptions } from "./WidgetTooltip";

interface FlowMetrics {
  stablecoinSupply: {
    current: number;
    previous24h: number;
    delta24h: number;
    deltaPercent: number;
    interpretation: string;
  };
  bridgeActivity: {
    totalVolume24h: number;
    totalVolumePrevDay: number;
    delta24h: number;
    deltaPercent: number;
    topBridges: Array<{
      name: string;
      volume24h: number;
      volumeChange: number;
    }>;
    interpretation: string;
  };
  netFlowSignal: {
    score: number;
    direction: "inflow" | "outflow" | "neutral";
    strength: "strong" | "moderate" | "weak";
    description: string;
  };
  lastUpdated: string;
}

function formatLargeNumber(num: number): string {
  const abs = Math.abs(num);
  if (abs >= 1e12) return (num / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (num / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (num / 1e3).toFixed(1) + "K";
  return num.toFixed(2);
}

function FlowGauge({ score, direction, strength }: { score: number; direction: string; strength: string }) {
  const normalizedScore = (score + 1) / 2;
  const rotation = -90 + normalizedScore * 180;
  
  const getColor = () => {
    if (direction === "inflow") return "#00ff88";
    if (direction === "outflow") return "#ff4466";
    return "#ffaa00";
  };

  return (
    <div className="relative w-32 h-16 mx-auto">
      <svg viewBox="0 0 100 50" className="w-full h-full">
        <defs>
          <linearGradient id="flowGaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#ff4466" />
            <stop offset="50%" stopColor="#ffaa00" />
            <stop offset="100%" stopColor="#00ff88" />
          </linearGradient>
        </defs>
        <path
          d="M 10 50 A 40 40 0 0 1 90 50"
          fill="none"
          stroke="rgba(255,255,255,0.1)"
          strokeWidth="6"
        />
        <path
          d="M 10 50 A 40 40 0 0 1 90 50"
          fill="none"
          stroke="url(#flowGaugeGrad)"
          strokeWidth="6"
          strokeLinecap="round"
          opacity="0.3"
        />
        <motion.g
          initial={{ rotate: -90 }}
          animate={{ rotate: rotation }}
          transition={{ duration: 1, ease: "easeOut" }}
          style={{ transformOrigin: "50px 50px" }}
        >
          <line
            x1="50"
            y1="50"
            x2="50"
            y2="18"
            stroke={getColor()}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="50" cy="50" r="4" fill={getColor()} />
        </motion.g>
      </svg>
      <div className="absolute bottom-0 left-0 right-0 text-center">
        <span 
          className="text-xs font-bold uppercase"
          style={{ color: getColor() }}
        >
          {direction} ({strength})
        </span>
      </div>
    </div>
  );
}

export function CapitalFlowTracker() {
  const { data: flows, isLoading } = useQuery<FlowMetrics>({
    queryKey: ["/api/flows"],
    refetchInterval: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <Card className="p-4 bg-card/50 border-border/50">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold text-cyan-400">Capital Flow Delta</h3>
        </div>
        <div className="animate-pulse space-y-3">
          <div className="h-16 bg-muted/20 rounded" />
          <div className="h-20 bg-muted/20 rounded" />
        </div>
      </Card>
    );
  }

  if (!flows) {
    return (
      <Card className="p-4 bg-card/50 border-border/50">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-bold text-cyan-400">Capital Flow Delta</h3>
        </div>
        <div className="text-center py-6 text-muted-foreground text-sm">
          Loading capital flow data...
        </div>
      </Card>
    );
  }

  const { stablecoinSupply, bridgeActivity, netFlowSignal } = flows;

  return (
    <Card className="p-4 bg-card/50 border-border/50" data-testid="capital-flow-tracker">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-green-400" />
          <h3 className="font-display text-lg font-bold text-cyan-400">Capital Flow Delta</h3>
        </div>
        <WidgetTooltip {...widgetDescriptions.capitalFlows} />
      </div>

      <FlowGauge 
        score={netFlowSignal.score} 
        direction={netFlowSignal.direction} 
        strength={netFlowSignal.strength}
      />

      <div className="mt-4 text-center text-sm text-muted-foreground mb-4">
        {netFlowSignal.description}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-background/30 rounded p-3">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            <TrendingUp className="w-3 h-3" />
            Stablecoin Supply
          </div>
          <div className="text-lg font-mono font-bold text-foreground">
            ${formatLargeNumber(stablecoinSupply.current)}
          </div>
          <div className="flex items-center gap-1 mt-1">
            {stablecoinSupply.deltaPercent > 0 ? (
              <ArrowUpRight className="w-3 h-3 text-green-400" />
            ) : stablecoinSupply.deltaPercent < 0 ? (
              <ArrowDownRight className="w-3 h-3 text-red-400" />
            ) : (
              <Minus className="w-3 h-3 text-yellow-400" />
            )}
            <span 
              className={`text-xs font-mono ${
                stablecoinSupply.deltaPercent > 0 
                  ? "text-green-400" 
                  : stablecoinSupply.deltaPercent < 0 
                    ? "text-red-400" 
                    : "text-yellow-400"
              }`}
            >
              {stablecoinSupply.deltaPercent > 0 ? "+" : ""}
              {stablecoinSupply.deltaPercent.toFixed(3)}%
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            {stablecoinSupply.interpretation}
          </div>
        </div>

        <div className="bg-background/30 rounded p-3">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            <ArrowLeftRight className="w-3 h-3" />
            Bridge Volume
          </div>
          <div className="text-lg font-mono font-bold text-foreground">
            ${formatLargeNumber(bridgeActivity.totalVolume24h)}
          </div>
          <div className="flex items-center gap-1 mt-1">
            {bridgeActivity.deltaPercent > 0 ? (
              <ArrowUpRight className="w-3 h-3 text-green-400" />
            ) : bridgeActivity.deltaPercent < 0 ? (
              <ArrowDownRight className="w-3 h-3 text-red-400" />
            ) : (
              <Minus className="w-3 h-3 text-yellow-400" />
            )}
            <span 
              className={`text-xs font-mono ${
                bridgeActivity.deltaPercent > 0 
                  ? "text-green-400" 
                  : bridgeActivity.deltaPercent < 0 
                    ? "text-red-400" 
                    : "text-yellow-400"
              }`}
            >
              {bridgeActivity.deltaPercent > 0 ? "+" : ""}
              {bridgeActivity.deltaPercent.toFixed(1)}%
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            {bridgeActivity.interpretation}
          </div>
        </div>
      </div>

      {bridgeActivity.topBridges.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border/30">
          <div className="text-xs text-muted-foreground mb-2">Top Bridges (24h)</div>
          <div className="space-y-1">
            {bridgeActivity.topBridges.slice(0, 3).map((bridge, i) => (
              <div 
                key={bridge.name}
                className="flex items-center justify-between text-xs"
              >
                <span className="text-muted-foreground">
                  {i + 1}. {bridge.name}
                </span>
                <span className="font-mono text-foreground">
                  ${formatLargeNumber(bridge.volume24h)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
