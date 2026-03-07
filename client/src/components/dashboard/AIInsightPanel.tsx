import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Brain, TrendingUp, TrendingDown, Minus, AlertTriangle, Sparkles, RefreshCw } from "lucide-react";
import type { AIInsight } from "@shared/schema";
import { WidgetTooltip, widgetDescriptions } from "./WidgetTooltip";

interface AIInsightPanelProps {
  insight: AIInsight | null;
  onRefresh?: () => void;
  isLoading?: boolean;
}

export function AIInsightPanel({ insight, onRefresh, isLoading }: AIInsightPanelProps) {
  const [showRefresh, setShowRefresh] = useState(false);
  
  useEffect(() => {
    if (insight) {
      const timer = setTimeout(() => setShowRefresh(true), 60000);
      return () => clearTimeout(timer);
    }
  }, [insight]);

  if (!insight) {
    return (
      <Card className="p-4 border-border/50 bg-gradient-to-br from-purple-500/10 to-cyan-500/10" data-testid="card-ai-insight-loading">
        <div className="flex items-center gap-2 mb-3">
          <Brain className="w-5 h-5 text-purple-400 animate-pulse" />
          <h3 className="font-display font-bold text-sm text-foreground">
            AI MARKET ANALYSIS
          </h3>
          <WidgetTooltip {...widgetDescriptions.aiInsight} />
        </div>
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-muted/30 rounded w-full" />
          <div className="h-4 bg-muted/30 rounded w-3/4" />
        </div>
      </Card>
    );
  }

  const TrendIcon = insight.trend === "bullish" 
    ? TrendingUp 
    : insight.trend === "bearish" 
      ? TrendingDown 
      : Minus;

  const trendColor = insight.trend === "bullish" 
    ? "text-green-400 border-green-500/50" 
    : insight.trend === "bearish" 
      ? "text-red-400 border-red-500/50"
      : "text-yellow-400 border-yellow-500/50";

  const riskColor = insight.riskLevel === "high"
    ? "text-red-400 border-red-500/50"
    : insight.riskLevel === "medium"
      ? "text-yellow-400 border-yellow-500/50"
      : "text-green-400 border-green-500/50";

  return (
    <Card className="p-4 border-border/50 bg-gradient-to-br from-purple-500/10 to-cyan-500/10" data-testid="card-ai-insight">
      <div className="flex items-center gap-2 mb-3">
        <Brain className="w-5 h-5 text-purple-400" />
        <h3 className="font-display font-bold text-sm text-foreground">
          AI MARKET ANALYSIS
        </h3>
        <WidgetTooltip {...widgetDescriptions.aiInsight} />
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="outline" className={`text-xs ${trendColor}`}>
            <TrendIcon className="w-3 h-3 mr-1" />
            {insight.trend.toUpperCase()}
          </Badge>
          {showRefresh && onRefresh && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={() => {
                setShowRefresh(false);
                onRefresh();
              }}
              disabled={isLoading}
            >
              <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          )}
        </div>
      </div>

      <p className="text-sm text-foreground mb-3">
        {insight.summary}
      </p>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="p-2 rounded bg-background/50 border border-border/30">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            <Sparkles className="w-3 h-3" />
            <span>Key Signal</span>
          </div>
          <p className="text-xs font-medium text-foreground">
            {insight.keySignal}
          </p>
        </div>
        
        <div className="p-2 rounded bg-background/50 border border-border/30">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            <AlertTriangle className="w-3 h-3" />
            <span>Risk Level</span>
          </div>
          <Badge variant="outline" className={`text-xs ${riskColor}`}>
            {insight.riskLevel.toUpperCase()}
          </Badge>
        </div>
      </div>

      {insight.topOpportunity && (
        <div className="p-2 rounded bg-green-500/10 border border-green-500/30 mb-2">
          <div className="flex items-center gap-1 text-xs text-green-400 mb-1">
            <TrendingUp className="w-3 h-3" />
            <span>Opportunity</span>
          </div>
          <p className="text-xs text-green-300">
            {insight.topOpportunity}
          </p>
        </div>
      )}

      {insight.warning && (
        <div className="p-2 rounded bg-red-500/10 border border-red-500/30">
          <div className="flex items-center gap-1 text-xs text-red-400 mb-1">
            <AlertTriangle className="w-3 h-3" />
            <span>Warning</span>
          </div>
          <p className="text-xs text-red-300">
            {insight.warning}
          </p>
        </div>
      )}

      <div className="mt-3 pt-2 border-t border-border/30 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">
          Confidence: {(insight.confidence * 100).toFixed(0)}%
        </span>
        <div className="w-20 h-1.5 bg-muted/30 rounded-full overflow-hidden">
          <div 
            className="h-full bg-purple-400 rounded-full"
            style={{ width: `${insight.confidence * 100}%` }}
          />
        </div>
      </div>
    </Card>
  );
}
