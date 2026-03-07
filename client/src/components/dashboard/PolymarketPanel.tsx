import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Target, Users } from "lucide-react";
import type { PolymarketData } from "@shared/schema";
import { WidgetTooltip, widgetDescriptions } from "./WidgetTooltip";

interface PolymarketPanelProps {
  markets: PolymarketData[];
}

function formatVolume(value: number): string {
  if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function PolymarketPanel({ markets }: PolymarketPanelProps) {
  if (markets.length === 0) {
    return (
      <Card className="p-4 border-border/50 bg-card/30" data-testid="card-polymarket-empty">
        <div className="flex items-center gap-2 mb-3">
          <Target className="w-5 h-5 text-blue-400" />
          <h3 className="font-display font-bold text-sm text-foreground">
            PREDICTION MARKETS
          </h3>
          <WidgetTooltip {...widgetDescriptions.polymarket} />
        </div>
        <p className="text-muted-foreground text-xs">
          No crypto-related prediction markets available at this time.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4 border-border/50 bg-card/30" data-testid="card-polymarket">
      <div className="flex items-center gap-2 mb-3">
        <Target className="w-5 h-5 text-blue-400" />
        <h3 className="font-display font-bold text-sm text-foreground">
          PREDICTION MARKETS
        </h3>
        <WidgetTooltip {...widgetDescriptions.polymarket} />
        <Badge variant="outline" className="ml-auto text-xs border-blue-500/50 text-blue-400">
          POLYMARKET
        </Badge>
      </div>
      
      <div className="space-y-3">
        {markets.slice(0, 4).map((market) => {
          const topOutcome = market.outcomes[0];
          const probability = topOutcome ? topOutcome.price * 100 : 50;
          const isHighConfidence = probability > 70 || probability < 30;
          
          return (
            <div 
              key={market.id}
              className="p-3 rounded-md bg-background/50 border border-border/30"
              data-testid={`polymarket-${market.id}`}
            >
              <p className="text-xs font-medium text-foreground mb-2 line-clamp-2">
                {market.question}
              </p>
              
              <div className="flex items-center gap-2 mb-2">
                {market.outcomes.slice(0, 2).map((outcome, idx) => (
                  <div key={idx} className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] text-muted-foreground truncate">
                        {outcome.name}
                      </span>
                      <span className={`text-xs font-mono font-bold ${
                        outcome.price > 0.5 ? "text-green-400" : "text-muted-foreground"
                      }`}>
                        {(outcome.price * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-1 bg-muted/30 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full ${
                          idx === 0 ? "bg-green-400" : "bg-red-400"
                        }`}
                        style={{ width: `${outcome.price * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Users className="w-3 h-3" />
                  <span>Vol: {formatVolume(market.volume)}</span>
                </div>
                {isHighConfidence && (
                  <Badge variant="outline" className="text-[10px] px-1 py-0 border-yellow-500/50 text-yellow-400">
                    HIGH CONVICTION
                  </Badge>
                )}
              </div>
            </div>
          );
        })}
      </div>
      
      <div className="mt-3 pt-2 border-t border-border/30">
        <p className="text-[10px] text-muted-foreground text-center">
          Live odds from Polymarket prediction markets
        </p>
      </div>
    </Card>
  );
}
