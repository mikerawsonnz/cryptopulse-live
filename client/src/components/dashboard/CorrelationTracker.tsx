import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { CorrelationData } from "@shared/schema";
import { WidgetTooltip, widgetDescriptions } from "./WidgetTooltip";

interface CorrelationTrackerProps {
  correlations: CorrelationData[];
}

export function CorrelationTracker({ correlations }: CorrelationTrackerProps) {
  if (correlations.length === 0) {
    return (
      <Card className="p-4 border-border/50 bg-card/30" data-testid="card-correlation-empty">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-5 h-5 text-purple-400" />
          <h3 className="font-display font-bold text-sm text-foreground">
            BTC CORRELATION DELTA
          </h3>
          <WidgetTooltip {...widgetDescriptions.correlations} />
        </div>
        <p className="text-muted-foreground text-xs">
          Loading correlation data...
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4 border-border/50 bg-card/30" data-testid="card-correlation-tracker">
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-5 h-5 text-purple-400" />
        <h3 className="font-display font-bold text-sm text-foreground">
          BTC CORRELATION DELTA
        </h3>
        <WidgetTooltip {...widgetDescriptions.correlations} />
        <Badge variant="outline" className="ml-auto text-[10px] border-purple-500/50 text-purple-400">
          24H CHANGE
        </Badge>
      </div>
      
      <div className="space-y-2">
        {correlations.slice(0, 6).map((corr) => {
          const delta = (corr.correlationDelta24h || 0) * 100;
          const correlation24h = (corr.correlation24h || corr.correlationWithBTC) * 100;
          const isPositiveDelta = delta >= 0;
          const absDelta = Math.abs(delta);
          
          return (
            <div 
              key={corr.coin}
              className={`flex items-center gap-3 p-2 rounded border transition-colors ${
                absDelta > 10 
                  ? isPositiveDelta 
                    ? "bg-green-500/10 border-green-500/30" 
                    : "bg-red-500/10 border-red-500/30"
                  : "bg-background/30 border-border/20"
              }`}
              data-testid={`correlation-${corr.coin}`}
            >
              <span className="font-mono text-xs w-10 text-foreground font-bold">
                {corr.coin}
              </span>
              
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] text-muted-foreground">24h Corr:</span>
                  <span className={`font-mono text-xs font-bold ${
                    correlation24h > 0 ? "text-cyan-400" : "text-magenta-400"
                  }`}>
                    {correlation24h > 0 ? "+" : ""}{correlation24h.toFixed(0)}%
                  </span>
                </div>
                
                <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
                  <div 
                    className={`h-full rounded-full transition-all ${
                      isPositiveDelta ? "bg-green-400" : "bg-red-400"
                    }`}
                    style={{ 
                      width: `${Math.min(100, absDelta * 5)}%`,
                    }}
                  />
                </div>
              </div>
              
              <div className="flex items-center gap-1 min-w-[60px] justify-end">
                {isPositiveDelta ? (
                  <TrendingUp className="w-3 h-3 text-green-400" />
                ) : (
                  <TrendingDown className="w-3 h-3 text-red-400" />
                )}
                <span className={`font-mono text-xs font-bold ${
                  isPositiveDelta ? "text-green-400" : "text-red-400"
                }`}>
                  {isPositiveDelta ? "+" : ""}{delta.toFixed(1)}%
                </span>
              </div>
              
              <Badge 
                variant="outline" 
                className={`text-[10px] px-1.5 py-0 ${
                  corr.strength === "strong" 
                    ? "border-purple-500/50 text-purple-400"
                    : corr.strength === "moderate"
                      ? "border-blue-500/50 text-blue-400"
                      : "border-foreground/30 text-foreground/70"
                }`}
              >
                {corr.strength.charAt(0).toUpperCase()}
              </Badge>
            </div>
          );
        })}
      </div>
      
      <div className="mt-3 pt-2 border-t border-border/30 grid grid-cols-3 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <TrendingDown className="w-3 h-3 text-red-400" />
          <span>Weakening</span>
        </div>
        <div className="text-center">
          <span>24h Change</span>
        </div>
        <div className="flex items-center gap-1 justify-end">
          <span>Strengthening</span>
          <TrendingUp className="w-3 h-3 text-green-400" />
        </div>
      </div>
    </Card>
  );
}
