import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Waves, ArrowRightLeft, Coins, Flame, Sparkles, ExternalLink } from "lucide-react";
import type { WhaleTransaction } from "@shared/schema";

interface WhaleTrackerProps {
  transactions: WhaleTransaction[];
  isLoading?: boolean;
}

export function WhaleTracker({ transactions, isLoading }: WhaleTrackerProps) {
  const getTypeIcon = (type: string) => {
    switch (type) {
      case "transfer":
        return <ArrowRightLeft className="h-4 w-4" />;
      case "swap":
        return <Coins className="h-4 w-4" />;
      case "burn":
        return <Flame className="h-4 w-4" />;
      case "mint":
        return <Sparkles className="h-4 w-4" />;
      default:
        return <Waves className="h-4 w-4" />;
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case "transfer":
        return "bg-primary/20 text-primary border-primary/30";
      case "swap":
        return "bg-neon-purple/20 text-neon-purple border-neon-purple/30";
      case "burn":
        return "bg-neon-red/20 text-neon-red border-neon-red/30";
      case "mint":
        return "bg-neon-green/20 text-neon-green border-neon-green/30";
      default:
        return "bg-muted text-muted-foreground border-muted";
    }
  };

  const formatAddress = (address: string) => {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const formatAmount = (amount: number, symbol?: string) => {
    if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}B ${symbol || ""}`;
    if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}M ${symbol || ""}`;
    if (amount >= 1e3) return `${(amount / 1e3).toFixed(2)}K ${symbol || ""}`;
    return `${amount.toFixed(2)} ${symbol || ""}`;
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diff = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return date.toLocaleDateString();
  };

  if (isLoading) {
    return (
      <Card className="p-6 border-border/50 bg-card/80 backdrop-blur-sm">
        <div className="animate-pulse space-y-4">
          <div className="h-5 bg-muted rounded w-1/3" />
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex gap-3">
              <div className="h-10 w-10 bg-muted rounded-md" />
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-muted rounded w-3/4" />
                <div className="h-3 bg-muted rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    );
  }

  return (
    <Card className="relative overflow-hidden border-border/50 bg-card/80 backdrop-blur-sm" data-testid="card-whale-tracker">
      <div className="absolute inset-0 bg-gradient-to-br from-accent/5 via-transparent to-primary/5" />

      <div className="relative p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-display font-semibold text-lg tracking-wide text-glow-magenta flex items-center gap-2">
              <Waves className="h-5 w-5 text-accent" />
              WHALE TRACKER
            </h3>
            <p className="text-xs font-mono text-muted-foreground">
              Solana via Helius
            </p>
          </div>
          <Badge
            variant="outline"
            className="bg-accent/10 text-accent border-accent/30 font-mono text-xs"
          >
            {transactions.length} ALERTS
          </Badge>
        </div>

        {transactions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-16 h-16 rounded-full bg-muted/20 flex items-center justify-center mb-4">
              <Waves className="h-8 w-8 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">
              No whale activity detected
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Waiting for large transactions...
            </p>
          </div>
        ) : (
          <ScrollArea className="h-[400px] pr-4">
            <AnimatePresence mode="popLayout">
              <div className="space-y-3">
                {transactions.map((tx, index) => (
                  <motion.div
                    key={tx.signature}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    transition={{ duration: 0.3, delay: index * 0.05 }}
                    className="relative"
                    data-testid={`whale-tx-${tx.signature.slice(0, 8)}`}
                  >
                    <div className="p-3 rounded-md bg-muted/20 border border-border/30 hover:border-accent/30 transition-colors group">
                      <div className="flex items-start gap-3">
                        <div className={`p-2 rounded-md ${getTypeColor(tx.type)}`}>
                          {getTypeIcon(tx.type)}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <Badge
                              variant="outline"
                              className={`${getTypeColor(tx.type)} text-[10px] uppercase`}
                            >
                              {tx.type}
                            </Badge>
                            <span className="text-[10px] font-mono text-muted-foreground">
                              {formatTime(tx.timestamp)}
                            </span>
                          </div>

                          <p className="text-lg font-display font-bold text-foreground">
                            {formatAmount(tx.amount, tx.tokenSymbol || tx.token)}
                          </p>

                          {tx.amountUsd && (
                            <p className="text-sm font-mono text-primary">
                              ≈ ${tx.amountUsd.toLocaleString()}
                            </p>
                          )}

                          <div className="flex items-center gap-2 mt-2 text-xs font-mono text-muted-foreground">
                            <span title={tx.from}>{formatAddress(tx.from)}</span>
                            <ArrowRightLeft className="h-3 w-3" />
                            <span title={tx.to}>{formatAddress(tx.to)}</span>
                          </div>
                        </div>

                        <a
                          href={`https://solscan.io/tx/${tx.signature}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-muted transition-all"
                          data-testid={`link-tx-${tx.signature.slice(0, 8)}`}
                        >
                          <ExternalLink className="h-4 w-4 text-muted-foreground" />
                        </a>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </AnimatePresence>
          </ScrollArea>
        )}
      </div>
    </Card>
  );
}
