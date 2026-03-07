import { motion } from "framer-motion";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { CryptoData, CompositeSentiment } from "@shared/schema";
import { MiniSparkline } from "./MiniSparkline";

interface CryptoCardProps {
  crypto: CryptoData;
  sentiment?: CompositeSentiment;
  index: number;
}

export function CryptoCard({ crypto, sentiment, index }: CryptoCardProps) {
  const priceChange = crypto.price_change_percentage_24h ?? 0;
  const isPositive = priceChange > 0;
  const isNegative = priceChange < 0;

  const formatPrice = (price: number) => {
    if (price >= 1000) {
      return price.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
    }
    if (price >= 1) {
      return price.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    return price.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 4,
      maximumFractionDigits: 6,
    });
  };

  const formatMarketCap = (cap: number) => {
    if (cap >= 1e12) return `$${(cap / 1e12).toFixed(2)}T`;
    if (cap >= 1e9) return `$${(cap / 1e9).toFixed(2)}B`;
    if (cap >= 1e6) return `$${(cap / 1e6).toFixed(2)}M`;
    return `$${cap.toLocaleString()}`;
  };

  const getSentimentColor = (label?: string) => {
    switch (label) {
      case "bullish":
        return "text-neon-green";
      case "bearish":
        return "text-neon-red";
      default:
        return "text-neon-yellow";
    }
  };

  const getSentimentBg = (label?: string) => {
    switch (label) {
      case "bullish":
        return "bg-neon-green/10 border-neon-green/30";
      case "bearish":
        return "bg-neon-red/10 border-neon-red/30";
      default:
        return "bg-neon-yellow/10 border-neon-yellow/30";
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05 }}
    >
      <Card
        className="relative overflow-hidden border-border/50 bg-card/80 backdrop-blur-sm hover:border-primary/50 transition-all duration-300 group"
        data-testid={`card-crypto-${crypto.id}`}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        
        <div className="relative p-4">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <div className="relative">
                <img
                  src={crypto.image}
                  alt={crypto.name}
                  className="w-10 h-10 rounded-full ring-2 ring-border/50"
                  data-testid={`img-crypto-${crypto.id}`}
                />
                <div className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-card border border-border flex items-center justify-center">
                  <span className="text-[10px] font-bold text-muted-foreground">
                    #{crypto.market_cap_rank}
                  </span>
                </div>
              </div>
              <div>
                <h3 className="font-display font-semibold text-foreground tracking-wide" data-testid={`text-crypto-name-${crypto.id}`}>
                  {crypto.name}
                </h3>
                <span className="text-xs font-mono text-muted-foreground uppercase">
                  {crypto.symbol}
                </span>
              </div>
            </div>

            {sentiment && (
              <Badge
                variant="outline"
                className={`${getSentimentBg(sentiment.label)} ${getSentimentColor(sentiment.label)} font-mono text-[10px] uppercase tracking-wider`}
                data-testid={`badge-sentiment-${crypto.id}`}
              >
                {sentiment.label}
              </Badge>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-2xl font-display font-bold tracking-tight number-scroll" data-testid={`text-price-${crypto.id}`}>
                  {formatPrice(crypto.current_price)}
                </p>
                <div className="flex items-center gap-1 mt-1">
                  {isPositive ? (
                    <TrendingUp className="h-4 w-4 text-neon-green" />
                  ) : isNegative ? (
                    <TrendingDown className="h-4 w-4 text-neon-red" />
                  ) : (
                    <Minus className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span
                    className={`text-sm font-mono font-medium ${
                      isPositive ? "text-neon-green text-glow-green" : isNegative ? "text-neon-red text-glow-red" : "text-muted-foreground"
                    }`}
                    data-testid={`text-change-${crypto.id}`}
                  >
                    {priceChange >= 0 ? "+" : ""}
                    {priceChange.toFixed(2)}%
                  </span>
                </div>
              </div>

              {crypto.sparkline_in_7d && (
                <div className="w-24 h-12">
                  <MiniSparkline
                    data={crypto.sparkline_in_7d.price}
                    isPositive={isPositive}
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 pt-3 border-t border-border/30">
              <div>
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                  Market Cap
                </p>
                <p className="text-sm font-mono font-medium" data-testid={`text-mcap-${crypto.id}`}>
                  {formatMarketCap(crypto.market_cap)}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                  Volume 24h
                </p>
                <p className="text-sm font-mono font-medium" data-testid={`text-volume-${crypto.id}`}>
                  {formatMarketCap(crypto.total_volume)}
                </p>
              </div>
            </div>

            {sentiment && (
              <div className="pt-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                    Sentiment Score
                  </span>
                  <span className={`text-xs font-mono font-bold ${getSentimentColor(sentiment.label)}`}>
                    {((sentiment.compositeScore + 1) * 50).toFixed(0)}
                  </span>
                </div>
                <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${
                      sentiment.label === "bullish"
                        ? "bg-neon-green"
                        : sentiment.label === "bearish"
                        ? "bg-neon-red"
                        : "bg-neon-yellow"
                    }`}
                    style={{ width: `${((sentiment.compositeScore + 1) / 2) * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
