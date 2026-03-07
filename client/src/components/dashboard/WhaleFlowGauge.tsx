import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Anchor, ArrowUpRight, ArrowDownRight, Activity } from "lucide-react";
import { WidgetTooltip, widgetDescriptions } from "./WidgetTooltip";

interface WhaleFlow {
  netFlow: number;
  bullishness: number;
  inflow: number;
  outflow: number;
  largestTransaction: any | null;
  volumeDelta?: number;
  interpretation?: string;
}

interface WhaleFlowGaugeProps {
  whaleFlow: WhaleFlow;
}

function formatUsd(value: number): string {
  if (Math.abs(value) >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function WhaleFlowGauge({ whaleFlow }: WhaleFlowGaugeProps) {
  const bullishPercent = whaleFlow.bullishness * 100;
  const isBullish = whaleFlow.bullishness > 0.55;
  const isBearish = whaleFlow.bullishness < 0.45;
  
  const needleRotation = (whaleFlow.bullishness - 0.5) * 180;
  
  const interpretation = whaleFlow.interpretation || 
    (isBullish ? "Accumulation pattern" : isBearish ? "Distribution pattern" : "Market neutral");
  
  return (
    <Card className="p-4 border-border/50 bg-card/30" data-testid="card-whale-flow">
      <div className="flex items-center gap-2 mb-3">
        <Anchor className="w-5 h-5 text-cyan-400" />
        <h3 className="font-display font-bold text-sm text-foreground">
          WHALE INTENSITY
        </h3>
        <WidgetTooltip {...widgetDescriptions.whaleFlow} />
        <Badge 
          variant="outline" 
          className={`ml-auto text-xs ${
            isBullish 
              ? "border-green-500/50 text-green-400" 
              : isBearish 
                ? "border-red-500/50 text-red-400"
                : "border-yellow-500/50 text-yellow-400"
          }`}
        >
          {isBullish ? "ACCUMULATING" : isBearish ? "DISTRIBUTING" : "NEUTRAL"}
        </Badge>
      </div>
      
      <div className="relative h-24 flex items-center justify-center mb-3">
        <svg viewBox="0 0 200 100" className="w-full h-full">
          <defs>
            <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#ff073a" />
              <stop offset="50%" stopColor="#fbbf24" />
              <stop offset="100%" stopColor="#39ff14" />
            </linearGradient>
          </defs>
          
          <path
            d="M 20 90 A 80 80 0 0 1 180 90"
            fill="none"
            stroke="url(#gaugeGradient)"
            strokeWidth="12"
            strokeLinecap="round"
            opacity="0.3"
          />
          
          <path
            d="M 20 90 A 80 80 0 0 1 180 90"
            fill="none"
            stroke="url(#gaugeGradient)"
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={`${bullishPercent * 2.5} 250`}
          />
          
          <line
            x1="100"
            y1="90"
            x2="100"
            y2="30"
            stroke="white"
            strokeWidth="3"
            strokeLinecap="round"
            transform={`rotate(${needleRotation}, 100, 90)`}
            style={{ filter: "drop-shadow(0 0 4px white)" }}
          />
          
          <circle cx="100" cy="90" r="6" fill="white" />
        </svg>
        
        <div className="absolute bottom-0 w-full flex justify-between px-2 text-xs text-muted-foreground">
          <span>BEARISH</span>
          <span>NEUTRAL</span>
          <span>BULLISH</span>
        </div>
      </div>
      
      <div className="p-2 rounded bg-background/50 border border-border/30 mb-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <span className="text-xs text-foreground">{interpretation}</span>
        </div>
      </div>
      
      <div className="grid grid-cols-2 gap-3">
        <div className="p-2 rounded bg-green-500/10 border border-green-500/30">
          <div className="flex items-center gap-1 text-xs text-green-400 mb-1">
            <ArrowUpRight className="w-3 h-3" />
            <span>Buy Pressure</span>
          </div>
          <span className="font-mono font-bold text-green-400">
            {(whaleFlow.bullishness * 100).toFixed(0)}%
          </span>
        </div>
        
        <div className="p-2 rounded bg-red-500/10 border border-red-500/30">
          <div className="flex items-center gap-1 text-xs text-red-400 mb-1">
            <ArrowDownRight className="w-3 h-3" />
            <span>Sell Pressure</span>
          </div>
          <span className="font-mono font-bold text-red-400">
            {((1 - whaleFlow.bullishness) * 100).toFixed(0)}%
          </span>
        </div>
      </div>
      
      <div className="mt-3 pt-3 border-t border-border/30">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Market Bias:</span>
          <span className={`font-mono font-bold ${whaleFlow.netFlow >= 0 ? "text-green-400" : "text-red-400"}`}>
            {whaleFlow.netFlow >= 0 ? "BULLISH" : "BEARISH"} ({bullishPercent.toFixed(0)}%)
          </span>
        </div>
      </div>
    </Card>
  );
}
