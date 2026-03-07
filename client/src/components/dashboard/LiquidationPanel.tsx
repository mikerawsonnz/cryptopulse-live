import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flame, TrendingUp, TrendingDown, Activity } from "lucide-react";
import { WidgetTooltip, widgetDescriptions } from "./WidgetTooltip";

interface VolatilityZone {
  symbol: string;
  currentPrice: number;
  support: number;
  resistance: number;
  volatility24h: number;
  riskLevel: "high" | "medium" | "low";
  priceRange: string;
}

interface LiquidationCluster {
  symbol: string;
  longLiquidationLevel: number;
  shortLiquidationLevel: number;
  totalLongLiquidated: number;
  totalShortLiquidated: number;
  volatilityTrap: "high" | "medium" | "low";
}

interface LiquidationPanelProps {
  clusters: LiquidationCluster[];
  volatilityZones?: VolatilityZone[];
}

function formatPrice(value: number): string {
  if (value >= 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${value.toFixed(2)}`;
}

export function LiquidationPanel({ clusters, volatilityZones = [] }: LiquidationPanelProps) {
  if (clusters.length === 0 && volatilityZones.length === 0) {
    return (
      <Card className="p-4 border-border/50 bg-card/30" data-testid="card-liquidation-empty">
        <div className="flex items-center gap-2 mb-3">
          <Flame className="w-5 h-5 text-orange-400" />
          <h3 className="font-display font-bold text-sm text-foreground">
            VOLATILITY ZONES
          </h3>
          <WidgetTooltip {...widgetDescriptions.liquidation} />
        </div>
        <p className="text-muted-foreground text-xs">
          Loading volatility data...
        </p>
      </Card>
    );
  }

  if (clusters.length === 0 && volatilityZones.length > 0) {
    return (
      <Card className="p-4 border-border/50 bg-card/30" data-testid="card-volatility-zones">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-5 h-5 text-orange-400" />
          <h3 className="font-display font-bold text-sm text-foreground">
            VOLATILITY ZONES
          </h3>
          <WidgetTooltip {...widgetDescriptions.liquidation} />
          <Badge variant="outline" className="ml-auto text-xs border-orange-500/50 text-orange-400">
            24H RANGE
          </Badge>
        </div>
        
        <div className="space-y-2">
          {volatilityZones.slice(0, 5).map((zone, index) => (
            <div 
              key={`${zone.symbol}-${index}`}
              className={`p-2 rounded-md border ${
                zone.riskLevel === "high"
                  ? "bg-red-500/10 border-red-500/30"
                  : zone.riskLevel === "medium"
                    ? "bg-yellow-500/10 border-yellow-500/30"
                    : "bg-background/50 border-border/30"
              }`}
              data-testid={`volatility-${zone.symbol}`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-display font-bold text-xs">
                  {zone.symbol}
                </span>
                <Badge 
                  variant="outline" 
                  className={`text-[10px] px-1 py-0 ${
                    zone.riskLevel === "high"
                      ? "border-red-500/50 text-red-400"
                      : zone.riskLevel === "medium"
                        ? "border-yellow-500/50 text-yellow-400"
                        : "border-green-500/50 text-green-400"
                  }`}
                >
                  {zone.volatility24h.toFixed(1)}% VOL
                </Badge>
              </div>
              
              <div className="flex items-center justify-between text-[10px]">
                <div className="flex items-center gap-1 text-green-400">
                  <TrendingDown className="w-3 h-3" />
                  <span>S: {formatPrice(zone.support)}</span>
                </div>
                <span className="text-muted-foreground font-mono">
                  {formatPrice(zone.currentPrice)}
                </span>
                <div className="flex items-center gap-1 text-red-400">
                  <TrendingUp className="w-3 h-3" />
                  <span>R: {formatPrice(zone.resistance)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        
        <div className="mt-3 pt-2 border-t border-border/30">
          <p className="text-[10px] text-muted-foreground text-center">
            Support/Resistance from 24h price action
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4 border-border/50 bg-card/30" data-testid="card-liquidation">
      <div className="flex items-center gap-2 mb-3">
        <Flame className="w-5 h-5 text-orange-400" />
        <h3 className="font-display font-bold text-sm text-foreground">
          LIQUIDATION WALLS
        </h3>
        <WidgetTooltip {...widgetDescriptions.liquidation} />
        <Badge variant="outline" className="ml-auto text-xs border-orange-500/50 text-orange-400">
          VOLATILITY TRAPS
        </Badge>
      </div>
      
      <div className="space-y-3">
        {clusters.map((cluster) => (
          <div 
            key={cluster.symbol}
            className={`p-3 rounded-md border ${
              cluster.volatilityTrap === "high"
                ? "bg-red-500/10 border-red-500/30"
                : cluster.volatilityTrap === "medium"
                  ? "bg-yellow-500/10 border-yellow-500/30"
                  : "bg-background/50 border-border/30"
            }`}
            data-testid={`liquidation-${cluster.symbol}`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-display font-bold text-sm">
                {cluster.symbol}
              </span>
              <Badge 
                variant="outline" 
                className={`text-xs ${
                  cluster.volatilityTrap === "high"
                    ? "border-red-500/50 text-red-400"
                    : cluster.volatilityTrap === "medium"
                      ? "border-yellow-500/50 text-yellow-400"
                      : "border-muted-foreground/50 text-muted-foreground"
                }`}
              >
                {cluster.volatilityTrap.toUpperCase()} RISK
              </Badge>
            </div>
            
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2 rounded bg-green-500/10 border border-green-500/20">
                <div className="flex items-center gap-1 text-[10px] text-green-400 mb-1">
                  <TrendingUp className="w-3 h-3" />
                  <span>Long Liq Level</span>
                </div>
                <span className="font-mono text-xs text-green-300">
                  {cluster.longLiquidationLevel > 0 ? formatPrice(cluster.longLiquidationLevel) : "N/A"}
                </span>
              </div>
              
              <div className="p-2 rounded bg-red-500/10 border border-red-500/20">
                <div className="flex items-center gap-1 text-[10px] text-red-400 mb-1">
                  <TrendingDown className="w-3 h-3" />
                  <span>Short Liq Level</span>
                </div>
                <span className="font-mono text-xs text-red-300">
                  {cluster.shortLiquidationLevel > 0 ? formatPrice(cluster.shortLiquidationLevel) : "N/A"}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      
      <div className="mt-3 pt-2 border-t border-border/30">
        <p className="text-[10px] text-muted-foreground text-center">
          Real-time liquidation data from Binance Futures
        </p>
      </div>
    </Card>
  );
}
