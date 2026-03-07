import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Target, TrendingUp, TrendingDown, Minus, Clock, CheckCircle, XCircle, Activity } from "lucide-react";
import type { AIPrediction, PredictionAccuracy } from "@shared/schema";
import { WidgetTooltip, widgetDescriptions } from "./WidgetTooltip";

interface AIPredictionsPanelProps {
  predictions: AIPrediction[];
  resolved: AIPrediction[];
  accuracy: PredictionAccuracy[];
  isLoading?: boolean;
}

const TIMEFRAME_OPTIONS = [
  { value: "10m", label: "10 Minutes" },
  { value: "30m", label: "30 Minutes" },
  { value: "60m", label: "1 Hour" },
  { value: "4h", label: "4 Hours" },
  { value: "24h", label: "24 Hours" },
  { value: "all", label: "All Timeframes" },
];

function formatTimeRemaining(targetTime: string): string {
  const target = new Date(targetTime).getTime();
  const now = Date.now();
  const diff = target - now;
  
  if (diff <= 0) return "Resolving...";
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function formatPrice(value: number): string {
  if (value >= 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

export function AIPredictionsPanel({ predictions = [], resolved = [], accuracy = [], isLoading }: AIPredictionsPanelProps) {
  const [selectedTimeframe, setSelectedTimeframe] = useState("10m");
  
  // Defensive: ensure arrays are always arrays
  const safePredictions = Array.isArray(predictions) ? predictions : [];
  const safeResolved = Array.isArray(resolved) ? resolved : [];
  
  const filteredPredictions = selectedTimeframe === "all" 
    ? safePredictions 
    : safePredictions.filter((p) => p?.timeframe === selectedTimeframe);
  
  const filteredResolved = selectedTimeframe === "all"
    ? safeResolved
    : safeResolved.filter((p) => p?.timeframe === selectedTimeframe);
  
  if (safePredictions.length === 0 && safeResolved.length === 0 && !isLoading) {
    return (
      <Card className="p-4 border-border/50 bg-gradient-to-br from-cyan-500/10 to-purple-500/10" data-testid="card-predictions-empty">
        <div className="flex items-center gap-2 mb-3">
          <Target className="w-5 h-5 text-cyan-400 animate-pulse" />
          <h3 className="font-display font-bold text-sm text-foreground">
            AI PRICE PREDICTIONS
          </h3>
          <WidgetTooltip {...widgetDescriptions.aiPredictions} />
        </div>
        <p className="text-muted-foreground text-xs">
          Generating predictions...
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4 border-border/50 bg-gradient-to-br from-cyan-500/10 to-purple-500/10" data-testid="card-predictions">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Target className="w-5 h-5 text-cyan-400" />
        <h3 className="font-display font-bold text-sm text-foreground">
          AI PRICE PREDICTIONS
        </h3>
        <WidgetTooltip {...widgetDescriptions.aiPredictions} />
        
        <div className="ml-auto flex items-center gap-2">
          <Select value={selectedTimeframe} onValueChange={setSelectedTimeframe}>
            <SelectTrigger 
              className="h-7 w-[130px] text-xs bg-background/50 border-cyan-500/30"
              data-testid="select-timeframe"
            >
              <SelectValue placeholder="Timeframe" />
            </SelectTrigger>
            <SelectContent>
              {TIMEFRAME_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} data-testid={`option-${opt.value}`}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          <Badge variant="outline" className="text-xs border-cyan-500/50 text-cyan-400">
            {filteredPredictions.length} ACTIVE
          </Badge>
        </div>
      </div>

      {Array.isArray(accuracy) && accuracy.length > 0 && (
        <div className="mb-3 p-2 rounded bg-background/50 border border-border/30">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4 text-purple-400" />
            <span className="text-xs font-medium text-foreground">Accuracy Tracking</span>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {["10m", "30m", "60m", "4h", "24h"].map((tf) => {
              const acc = accuracy.find((a) => a.timeframe === tf);
              const rate = acc?.directionAccuracy || 0;
              const total = acc?.totalPredictions || 0;
              const isSelected = selectedTimeframe === tf || selectedTimeframe === "all";
              return (
                <div 
                  key={tf} 
                  className={`text-center p-1 rounded cursor-pointer transition-colors ${
                    isSelected ? "bg-cyan-500/20 border border-cyan-500/30" : "hover:bg-background/30"
                  }`}
                  onClick={() => setSelectedTimeframe(tf)}
                >
                  <div className="text-[10px] text-foreground/80 mb-1 font-medium">{tf}</div>
                  <div className={`text-xs font-mono font-bold ${
                    rate >= 60 ? "text-green-400" : rate >= 40 ? "text-yellow-400" : total > 0 ? "text-red-400" : "text-foreground/50"
                  }`}>
                    {total > 0 ? `${rate.toFixed(0)}%` : "-"}
                  </div>
                  <div className="text-[9px] text-foreground/60">{total} total</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2 max-h-[280px] overflow-y-auto scrollbar-thin">
        {filteredPredictions.length > 0 ? (
          <div className="space-y-1.5">
            {filteredPredictions.map((pred) => (
              <PredictionRow key={pred.id} prediction={pred} />
            ))}
          </div>
        ) : (
          <div className="text-center py-4 text-foreground/60 text-xs">
            No predictions for {TIMEFRAME_OPTIONS.find(o => o.value === selectedTimeframe)?.label}
          </div>
        )}

        {filteredResolved.length > 0 && (
          <div className="pt-2 border-t border-border/30">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="w-3 h-3 text-foreground/60" />
              <span className="text-[10px] text-foreground/70 uppercase tracking-wider font-medium">Recent Results</span>
            </div>
            <div className="space-y-1">
              {filteredResolved.slice(0, 4).map((pred) => (
                <ResolvedRow key={pred.id} prediction={pred} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function PredictionRow({ prediction }: { prediction: AIPrediction }) {
  if (!prediction) return null;
  
  const DirectionIcon = prediction.direction === "up" 
    ? TrendingUp 
    : prediction.direction === "down" 
      ? TrendingDown 
      : Minus;
  
  const predictedChange = prediction.predictedChange ?? 0;
  const confidence = prediction.confidence ?? 0;
  
  const isUp = prediction.direction === "up" || predictedChange > 0.1;
  const isDown = prediction.direction === "down" || predictedChange < -0.1;
  
  const bgColor = isUp
    ? "bg-green-500/15 border-green-500/30 hover:bg-green-500/20"
    : isDown
      ? "bg-red-500/15 border-red-500/30 hover:bg-red-500/20"
      : "bg-background/30 border-border/20 hover:bg-background/50";
  
  const textColor = isUp
    ? "text-green-400"
    : isDown
      ? "text-red-400"
      : "text-yellow-400";

  return (
    <div 
      className={`flex items-center gap-2 p-2 rounded border transition-colors ${bgColor}`}
      data-testid={`prediction-${prediction.id}`}
    >
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        <span className="font-mono text-xs font-bold text-foreground">
          {prediction.symbol}
        </span>
        <Badge variant="outline" className="text-[10px] px-1 py-0 border-foreground/30 text-foreground/80">
          {prediction.timeframe}
        </Badge>
      </div>
      
      <div className="flex items-center gap-1">
        <DirectionIcon className={`w-3 h-3 ${textColor}`} />
        <span className={`font-mono text-xs font-bold ${textColor}`}>
          {predictedChange >= 0 ? "+" : ""}{predictedChange.toFixed(2)}%
        </span>
      </div>
      
      <div className="flex items-center gap-1 text-[10px] text-foreground/70">
        <Clock className="w-3 h-3" />
        <span>{formatTimeRemaining(prediction.targetTime || new Date().toISOString())}</span>
      </div>
      
      <div className="w-12">
        <div className="h-1 bg-muted/30 rounded-full overflow-hidden">
          <div 
            className={`h-full rounded-full ${isUp ? "bg-green-400" : isDown ? "bg-red-400" : "bg-cyan-400"}`}
            style={{ width: `${confidence * 100}%` }}
          />
        </div>
        <div className="text-[9px] text-foreground/60 text-center mt-0.5">
          {(confidence * 100).toFixed(0)}%
        </div>
      </div>
    </div>
  );
}

function ResolvedRow({ prediction }: { prediction: AIPrediction }) {
  if (!prediction) return null;
  
  const wasCorrect = prediction.wasCorrect;
  const actualChange = prediction.actualChange ?? 0;
  const predictedChange = prediction.predictedChange ?? 0;
  
  return (
    <div 
      className={`flex items-center gap-2 p-1.5 rounded text-[10px] ${
        wasCorrect 
          ? "bg-green-500/15 border border-green-500/25" 
          : "bg-red-500/15 border border-red-500/25"
      }`}
      data-testid={`resolved-${prediction.id}`}
    >
      {wasCorrect ? (
        <CheckCircle className="w-3 h-3 text-green-400" />
      ) : (
        <XCircle className="w-3 h-3 text-red-400" />
      )}
      
      <span className="font-mono font-bold text-foreground">{prediction.symbol ?? 'N/A'}</span>
      <Badge variant="outline" className="text-[9px] px-1 py-0 border-foreground/30 text-foreground/80">{prediction.timeframe ?? ''}</Badge>
      
      <span className="text-foreground/70">
        Pred: <span className={predictedChange >= 0 ? "text-green-400" : "text-red-400"}>
          {predictedChange >= 0 ? "+" : ""}{predictedChange.toFixed(1)}%
        </span>
      </span>
      
      <span className="text-foreground/70">
        Actual: <span className={actualChange >= 0 ? "text-green-400" : "text-red-400"}>
          {actualChange >= 0 ? "+" : ""}{actualChange.toFixed(1)}%
        </span>
      </span>
    </div>
  );
}
