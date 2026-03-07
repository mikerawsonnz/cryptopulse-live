import { motion } from "framer-motion";
import type { CryptoData } from "@shared/schema";

interface PriceTickerProps {
  cryptos: CryptoData[];
}

export function PriceTicker({ cryptos }: PriceTickerProps) {
  if (cryptos.length === 0) return null;

  const tickerItems = [...cryptos, ...cryptos];

  return (
    <div className="w-full overflow-hidden bg-card/50 border-y border-border/30 py-2">
      <motion.div
        className="flex gap-8 whitespace-nowrap"
        animate={{ x: ["0%", "-50%"] }}
        transition={{
          duration: 30,
          ease: "linear",
          repeat: Infinity,
        }}
      >
        {tickerItems.map((crypto, index) => {
          const priceChange = crypto.price_change_percentage_24h ?? 0;
          const isPositive = priceChange > 0;

          return (
            <div
              key={`${crypto.id}-${index}`}
              className="flex items-center gap-3 px-4"
            >
              <img
                src={crypto.image}
                alt={crypto.symbol}
                className="w-5 h-5 rounded-full"
              />
              <span className="font-mono text-sm font-medium uppercase text-foreground">
                {crypto.symbol}
              </span>
              <span className="font-mono text-sm text-muted-foreground">
                ${crypto.current_price.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: crypto.current_price < 1 ? 6 : 2,
                })}
              </span>
              <span
                className={`font-mono text-xs font-medium ${
                  isPositive ? "text-neon-green" : "text-neon-red"
                }`}
              >
                {isPositive ? "+" : ""}
                {priceChange.toFixed(2)}%
              </span>
            </div>
          );
        })}
      </motion.div>
    </div>
  );
}
