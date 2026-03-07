import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, AlertTriangle } from "lucide-react";
import type { DivergenceSignal } from "@shared/schema";
import { motion, AnimatePresence } from "framer-motion";
import { WidgetTooltip, widgetDescriptions } from "./WidgetTooltip";

interface DivergenceAlertsProps {
  divergences: DivergenceSignal[];
}

export function DivergenceAlerts({ divergences }: DivergenceAlertsProps) {
  if (divergences.length === 0) {
    return (
      <Card className="p-4 border-border/50 bg-card/30" data-testid="card-divergence-empty">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="w-5 h-5 text-yellow-400" />
          <h3 className="font-display font-bold text-sm text-foreground">
            DIVERGENCE DETECTOR
          </h3>
          <WidgetTooltip {...widgetDescriptions.divergenceAlerts} />
        </div>
        <p className="text-muted-foreground text-xs">
          No significant divergences detected. Market sentiment aligns with price action.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4 border-border/50 bg-card/30 overflow-hidden" data-testid="card-divergence-alerts">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-5 h-5 text-yellow-400 animate-pulse" />
        <h3 className="font-display font-bold text-sm text-foreground">
          DIVERGENCE DETECTOR
        </h3>
        <WidgetTooltip {...widgetDescriptions.divergenceAlerts} />
        <Badge variant="outline" className="ml-auto text-xs border-yellow-400/50 text-yellow-400">
          {divergences.length} SIGNAL{divergences.length > 1 ? "S" : ""}
        </Badge>
      </div>
      
      <div className="space-y-2">
        <AnimatePresence mode="popLayout">
          {divergences.map((signal, idx) => (
            <motion.div
              key={`${signal.coin}-${idx}`}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ delay: idx * 0.1 }}
              className={`p-3 rounded-md border ${
                signal.type === "bullish"
                  ? "bg-green-500/10 border-green-500/30"
                  : "bg-red-500/10 border-red-500/30"
              }`}
              data-testid={`divergence-signal-${signal.coin}`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  {signal.type === "bullish" ? (
                    <TrendingUp className="w-4 h-4 text-green-400" />
                  ) : (
                    <TrendingDown className="w-4 h-4 text-red-400" />
                  )}
                  <span className="font-display font-bold text-sm">
                    {signal.coin}
                  </span>
                  <Badge 
                    variant="outline" 
                    className={`text-xs ${
                      signal.type === "bullish" 
                        ? "border-green-500/50 text-green-400" 
                        : "border-red-500/50 text-red-400"
                    }`}
                  >
                    {signal.type.toUpperCase()} DIVERGENCE
                  </Badge>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">Strength:</span>
                  <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full ${
                        signal.type === "bullish" ? "bg-green-400" : "bg-red-400"
                      }`}
                      style={{ width: `${signal.strength * 100}%` }}
                    />
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {signal.description}
              </p>
              <div className="flex gap-4 mt-1 text-xs">
                <span className={signal.priceChange24h >= 0 ? "text-green-400" : "text-red-400"}>
                  Price: {signal.priceChange24h >= 0 ? "+" : ""}{signal.priceChange24h.toFixed(1)}%
                </span>
                <span className={signal.sentimentScore >= 0 ? "text-green-400" : "text-red-400"}>
                  Sentiment: {signal.sentimentScore >= 0 ? "+" : ""}{(signal.sentimentScore * 100).toFixed(0)}%
                </span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Card>
  );
}
