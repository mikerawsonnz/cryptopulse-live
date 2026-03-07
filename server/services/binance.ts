export interface BinanceCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const BINANCE_BASE_URL = "https://data-api.binance.vision/api/v3";

const COIN_TO_BINANCE_SYMBOL: Record<string, string> = {
  bitcoin: "BTCUSDT",
  ethereum: "ETHUSDT",
  solana: "SOLUSDT",
  "binancecoin": "BNBUSDT",
  ripple: "XRPUSDT",
  dogecoin: "DOGEUSDT",
  cardano: "ADAUSDT",
  avalanche: "AVAXUSDT",
  polkadot: "DOTUSDT",
  chainlink: "LINKUSDT",
  tron: "TRXUSDT",
  toncoin: "TONUSDT",
  shiba: "SHIBUSDT",
  litecoin: "LTCUSDT",
  polygon: "MATICUSDT",
  uniswap: "UNIUSDT",
};

export async function get4HCandlesBinance(coinId: string, days: number = 90): Promise<BinanceCandle[]> {
  const symbol = COIN_TO_BINANCE_SYMBOL[coinId.toLowerCase()];
  
  if (!symbol) {
    console.log(`[Binance] No symbol mapping for ${coinId}`);
    return [];
  }
  
  try {
    const endTime = Date.now();
    const startTime = endTime - (days * 24 * 60 * 60 * 1000);
    
    const url = new URL(`${BINANCE_BASE_URL}/klines`);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "4h");
    url.searchParams.set("startTime", startTime.toString());
    url.searchParams.set("endTime", endTime.toString());
    url.searchParams.set("limit", "1000");
    
    console.log(`[Binance] Fetching 4H OHLC for ${symbol} (${days} days)...`);
    
    const response = await fetch(url.toString());
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Binance] API error for ${symbol}: ${response.status} ${errorText}`);
      return [];
    }
    
    const data = await response.json();
    
    const candles: BinanceCandle[] = data.map((kline: any[]) => ({
      timestamp: kline[0],
      open: parseFloat(kline[1]),
      high: parseFloat(kline[2]),
      low: parseFloat(kline[3]),
      close: parseFloat(kline[4]),
      volume: parseFloat(kline[5]),
    }));
    
    console.log(`[Binance] Got ${candles.length} candles for ${symbol}`);
    return candles;
  } catch (error) {
    console.error(`[Binance] Fetch error for ${coinId}:`, error);
    return [];
  }
}

const SYMBOL_TO_TICKER: Record<string, string> = {
  btc: "BTCUSDT",
  eth: "ETHUSDT",
  sol: "SOLUSDT",
  bnb: "BNBUSDT",
  xrp: "XRPUSDT",
  doge: "DOGEUSDT",
  ada: "ADAUSDT",
  avax: "AVAXUSDT",
  dot: "DOTUSDT",
  link: "LINKUSDT",
  trx: "TRXUSDT",
  ton: "TONUSDT",
  shib: "SHIBUSDT",
  ltc: "LTCUSDT",
  matic: "MATICUSDT",
  uni: "UNIUSDT",
  pepe: "PEPEUSDT",
  sui: "SUIUSDT",
  bch: "BCHUSDT",
  zec: "ZECUSDT",
  aave: "AAVEUSDT",
  inj: "INJUSDT",
  near: "NEARUSDT",
  apt: "APTUSDT",
  arb: "ARBUSDT",
  op: "OPUSDT",
  atom: "ATOMUSDT",
  xlm: "XLMUSDT",
  hbar: "HBARUSDT",
  fil: "FILUSDT",
  render: "RENDERUSDT",
  hype: "HYPEUSDT",
  enso: "ENSOUSDT",
  sahara: "SAHARAUSDT",
};

let lastBinancePrices: Map<string, number> = new Map();
let lastBinanceFetch = 0;

const tickerToSymbol = new Map<string, string>();
for (const [sym, ticker] of Object.entries(SYMBOL_TO_TICKER)) {
  tickerToSymbol.set(ticker, sym);
}

export async function getBinanceRealtimePrices(): Promise<Map<string, number>> {
  try {
    const url = `${BINANCE_BASE_URL}/ticker/price`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[Binance Ticker] API error: ${response.status}`);
      return lastBinancePrices;
    }
    
    const data: Array<{ symbol: string; price: string }> = await response.json();
    
    const priceMap = new Map<string, number>();
    for (const item of data) {
      const sym = tickerToSymbol.get(item.symbol);
      if (sym) {
        priceMap.set(sym, parseFloat(item.price));
      }
    }
    
    if (priceMap.size > 0) {
      lastBinancePrices = priceMap;
      lastBinanceFetch = Date.now();
    }
    return priceMap.size > 0 ? priceMap : lastBinancePrices;
  } catch (error) {
    console.error("[Binance Ticker] Fetch error:", error);
    return lastBinancePrices;
  }
}

export function getCachedBinancePrices(): Map<string, number> {
  return lastBinancePrices;
}

export async function getMultiple4HCandlesBinance(coinIds: string[], days: number = 90): Promise<Map<string, BinanceCandle[]>> {
  console.log(`[Binance] Fetching 4H OHLC for ${coinIds.length} coins...`);
  
  const results = new Map<string, BinanceCandle[]>();
  
  for (const coinId of coinIds) {
    try {
      const candles = await get4HCandlesBinance(coinId, days);
      results.set(coinId, candles);
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      console.error(`[Binance] Failed to fetch OHLC for ${coinId}:`, error);
      results.set(coinId, []);
    }
  }
  
  return results;
}
