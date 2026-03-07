import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { TrendingUp, TrendingDown, DollarSign, Activity, BarChart3, Percent } from "lucide-react";
import type { CryptoData } from "@shared/schema";

interface StatsBarProps {
  cryptos: CryptoData[];
}

export function StatsBar({ cryptos }: StatsBarProps) {
  if (cryptos.length === 0) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="p-4 bg-card/50 border-border/30 animate-pulse">
            <div className="h-4 bg-muted rounded w-1/2 mb-2" />
            <div className="h-8 bg-muted rounded w-3/4" />
          </Card>
        ))}
      </div>
    );
  }

  const totalMarketCap = cryptos.reduce((sum, c) => sum + c.market_cap, 0);
  const totalVolume = cryptos.reduce((sum, c) => sum + c.total_volume, 0);
  const avgChange = cryptos.reduce((sum, c) => sum + (c.price_change_percentage_24h ?? 0), 0) / cryptos.length;
  const gainers = cryptos.filter((c) => (c.price_change_percentage_24h ?? 0) > 0).length;
  const losers = cryptos.filter((c) => (c.price_change_percentage_24h ?? 0) < 0).length;

  const formatLargeNumber = (num: number) => {
    if (num >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
    return `$${num.toLocaleString()}`;
  };

  const stats = [
    {
      label: "Total Market Cap",
      value: formatLargeNumber(totalMarketCap),
      icon: DollarSign,
      color: "text-primary",
      glow: "glow-cyan",
    },
    {
      label: "24h Volume",
      value: formatLargeNumber(totalVolume),
      icon: BarChart3,
      color: "text-accent",
      glow: "glow-magenta",
    },
    {
      label: "Avg Change 24h",
      value: `${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(2)}%`,
      icon: Percent,
      color: avgChange >= 0 ? "text-neon-green" : "text-neon-red",
      glow: avgChange >= 0 ? "glow-green" : "glow-red",
    },
    {
      label: "Gainers / Losers",
      value: `${gainers} / ${losers}`,
      icon: Activity,
      color: gainers > losers ? "text-neon-green" : "text-neon-red",
      glow: gainers > losers ? "glow-green" : "glow-red",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6" data-testid="stats-bar">
      {stats.map((stat, index) => (
        <motion.div
          key={stat.label}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: index * 0.1 }}
        >
          <Card className="relative overflow-hidden p-4 bg-card/50 border-border/30 hover:border-primary/30 transition-colors">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 opacity-50" />
            <div className="relative">
              <div className="flex items-center gap-2 mb-2">
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
                <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                  {stat.label}
                </span>
              </div>
              <p className={`text-xl font-display font-bold ${stat.color}`} data-testid={`stat-${stat.label.toLowerCase().replace(/\s+/g, "-")}`}>
                {stat.value}
              </p>
            </div>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}
