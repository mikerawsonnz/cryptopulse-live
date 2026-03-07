import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Activity } from "lucide-react";
import type { SentimentData } from "@shared/schema";

interface SentimentGaugeProps {
  sentiment: SentimentData | null;
  isLoading?: boolean;
}

export function SentimentGauge({ sentiment, isLoading }: SentimentGaugeProps) {
  const score = sentiment?.score ?? 0;
  const normalizedScore = ((score + 1) / 2) * 100;
  const rotation = (normalizedScore / 100) * 180 - 90;

  const getColor = () => {
    if (score > 0.2) return { text: "text-neon-green", glow: "text-glow-green", bg: "bg-neon-green" };
    if (score < -0.2) return { text: "text-neon-red", glow: "text-glow-red", bg: "bg-neon-red" };
    return { text: "text-neon-yellow", glow: "", bg: "bg-neon-yellow" };
  };

  const colors = getColor();

  const getLabel = () => {
    if (!sentiment) return "LOADING...";
    return sentiment.label.toUpperCase();
  };

  const getIcon = () => {
    if (score > 0.2) return <TrendingUp className="h-6 w-6" />;
    if (score < -0.2) return <TrendingDown className="h-6 w-6" />;
    return <Activity className="h-6 w-6" />;
  };

  if (isLoading) {
    return (
      <Card className="p-6 border-border/50 bg-card/80 backdrop-blur-sm">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-muted rounded w-1/2" />
          <div className="h-32 bg-muted rounded-full w-32 mx-auto" />
          <div className="h-6 bg-muted rounded w-1/3 mx-auto" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="relative overflow-hidden border-border/50 bg-card/80 backdrop-blur-sm" data-testid="card-btc-sentiment">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5" />

      <div className="relative p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-display font-semibold text-lg tracking-wide text-glow-cyan">
              BTC SENTIMENT
            </h3>
            <p className="text-xs font-mono text-muted-foreground">
              Real-time from SentiCrypt
            </p>
          </div>
          <div className={`p-2 rounded-md ${colors.bg}/20`}>
            <span className={colors.text}>{getIcon()}</span>
          </div>
        </div>

        <div className="flex flex-col items-center py-4">
          <div className="relative w-48 h-24 mb-4">
            <svg viewBox="0 0 200 100" className="w-full h-full">
              <defs>
                <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="hsl(0 100% 55%)" />
                  <stop offset="50%" stopColor="hsl(45 100% 55%)" />
                  <stop offset="100%" stopColor="hsl(120 100% 55%)" />
                </linearGradient>
              </defs>

              <path
                d="M 20 90 A 80 80 0 0 1 180 90"
                fill="none"
                stroke="hsl(230 40% 15%)"
                strokeWidth="12"
                strokeLinecap="round"
              />

              <path
                d="M 20 90 A 80 80 0 0 1 180 90"
                fill="none"
                stroke="url(#gaugeGradient)"
                strokeWidth="12"
                strokeLinecap="round"
                strokeDasharray="251.2"
                strokeDashoffset={251.2 - (normalizedScore / 100) * 251.2}
                style={{
                  filter: "drop-shadow(0 0 8px hsl(185 100% 50% / 0.5))",
                  transition: "stroke-dashoffset 0.5s ease-out",
                }}
              />

              <motion.g
                initial={{ rotate: -90 }}
                animate={{ rotate: rotation }}
                transition={{ type: "spring", stiffness: 60, damping: 15 }}
                style={{ transformOrigin: "100px 90px" }}
              >
                <line
                  x1="100"
                  y1="90"
                  x2="100"
                  y2="30"
                  stroke="hsl(185 100% 95%)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  style={{
                    filter: "drop-shadow(0 0 4px hsl(185 100% 50% / 0.8))",
                  }}
                />
                <circle
                  cx="100"
                  cy="90"
                  r="8"
                  fill="hsl(185 100% 50%)"
                  style={{
                    filter: "drop-shadow(0 0 8px hsl(185 100% 50%))",
                  }}
                />
              </motion.g>

              <text x="25" y="98" className="text-[10px] fill-muted-foreground font-mono">
                BEAR
              </text>
              <text x="155" y="98" className="text-[10px] fill-muted-foreground font-mono">
                BULL
              </text>
            </svg>
          </div>

          <motion.div
            key={sentiment?.score}
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-center"
          >
            <p
              className={`text-4xl font-display font-bold ${colors.text} ${colors.glow}`}
              data-testid="text-btc-sentiment-score"
            >
              {normalizedScore.toFixed(0)}
            </p>
            <p
              className={`text-sm font-mono font-medium uppercase tracking-wider ${colors.text}`}
              data-testid="text-btc-sentiment-label"
            >
              {getLabel()}
            </p>
          </motion.div>
        </div>

        {sentiment && (
          <div className="flex justify-center gap-6 pt-4 border-t border-border/30">
            <div className="text-center">
              <p className="text-[10px] font-mono text-muted-foreground uppercase">Raw Score</p>
              <p className="text-sm font-mono font-medium">{score.toFixed(3)}</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] font-mono text-muted-foreground uppercase">Updated</p>
              <p className="text-sm font-mono font-medium">
                {new Date(sentiment.timestamp).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </p>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
