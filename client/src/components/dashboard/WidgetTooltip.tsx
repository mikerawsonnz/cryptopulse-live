import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HelpCircle } from "lucide-react";

interface WidgetTooltipProps {
  title: string;
  description: string;
  methodology?: string;
}

export function WidgetTooltip({ title, description, methodology }: WidgetTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button 
          className="p-1 rounded hover-elevate text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-widget-info"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent 
        side="top" 
        className="max-w-xs p-3 bg-popover border border-border"
      >
        <div className="space-y-2">
          <h4 className="font-display font-bold text-sm text-foreground">{title}</h4>
          <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
          {methodology && (
            <p className="text-[10px] text-cyan-400 border-t border-border/50 pt-2 mt-2">
              <span className="font-bold">Method:</span> {methodology}
            </p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export const widgetDescriptions = {
  divergenceAlerts: {
    title: "Divergence Detector",
    description: "Identifies when a coin's 24h price action diverges significantly from its 7-day average performance. Large divergences can signal potential reversals or breakout opportunities.",
    methodology: "Compares 24h % change against 7d daily average, signals when deviation exceeds 1.5%"
  },
  whaleFlow: {
    title: "Whale Intensity Gauge",
    description: "Measures large transaction patterns to detect whale accumulation (buying) or distribution (selling) phases. Helps identify smart money movements before they impact price.",
    methodology: "Analyzes Solana whale transactions + volume momentum to calculate buy/sell pressure"
  },
  correlations: {
    title: "BTC Correlation Delta",
    description: "Shows how each altcoin's correlation with Bitcoin has changed over the last 24 hours. Positive delta = moving more in sync with BTC; negative delta = decoupling from BTC.",
    methodology: "Compares last 24h Pearson correlation vs previous 24h period"
  },
  polymarket: {
    title: "Prediction Markets",
    description: "Real-time odds from Polymarket for crypto-related events. These represent the crowd's probability estimates based on actual money at stake.",
    methodology: "Filtered from Polymarket Gamma API by crypto keywords, sorted by volume"
  },
  liquidation: {
    title: "Volatility Zones",
    description: "Identifies price levels where large liquidations may occur (when available) or shows support/resistance based on 24h price action as a volatility guide.",
    methodology: "Support = 24h low - (range × 0.1), Resistance = 24h high + (range × 0.1)"
  },
  aiInsight: {
    title: "AI Market Analysis",
    description: "AI-powered market commentary analyzing current prices, sentiment divergences, and prediction market data to provide actionable insights.",
    methodology: "Google Gemini 2.0 Flash analyzing live market data every 5 minutes"
  },
  aiPredictions: {
    title: "AI Price Predictions",
    description: "Multi-timeframe price predictions using technical analysis patterns, momentum indicators, and market sentiment. Accuracy is tracked over time to show prediction reliability.",
    methodology: "RSI, MACD concepts, volatility bands, sentiment scoring with historical accuracy tracking"
  },
  cryptoCard: {
    title: "Crypto Asset Card",
    description: "Real-time price data with 24h change percentage and 7-day price sparkline. Color coding indicates bullish (green) or bearish (red) momentum.",
    methodology: "Live data from CoinGecko API, updated every 30 seconds"
  },
  sentiment: {
    title: "BTC Fear & Greed Index",
    description: "Composite sentiment score for Bitcoin based on social media, trading volume, and market momentum. Extreme values often precede reversals.",
    methodology: "SentiCrypt API aggregating multiple sentiment sources (0-100 scale)"
  },
  whaleAlerts: {
    title: "Whale Transaction Alerts",
    description: "Real-time alerts for large Solana transactions (>$100K). Tracks wallet movements to/from exchanges to identify potential buying or selling pressure.",
    methodology: "Helius API monitoring Solana blockchain for large value transfers"
  },
  capitalFlows: {
    title: "Capital Flow Delta",
    description: "Tracks money flowing in/out of crypto markets via stablecoin supply changes and cross-chain bridge activity. Stablecoin minting = fiat entering crypto; burning = fiat exiting.",
    methodology: "DeFiLlama API tracking stablecoin supply delta + bridge volume changes"
  },
  onChainMetrics: {
    title: "On-Chain Valuation",
    description: "MVRV Z-Score measures if assets are over/undervalued vs historical average. NUPL shows unrealized profit/loss across holders. Both help identify market cycle phases.",
    methodology: "Approximated using 7-day price data as proxy for realized value"
  }
};
