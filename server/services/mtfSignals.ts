import type { BinanceCandle, TimeframeKey } from "./binanceCandles";

export type StrategyMode = 'meanReversion' | 'volExpansion' | 'momentum' | 'pairsTrading';

export interface MtfSignal {
  coinId: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  strategy: StrategyMode;
  timeframe: TimeframeKey;
  comboKey: string;
  reasoning: string[];
  confidence: number;
  atr: number;
}

function calculateATR(candles: BinanceCandle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  const recent = candles.slice(-period - 1);
  let sumTR = 0;
  for (let i = 1; i < recent.length; i++) {
    const high = recent[i].high;
    const low = recent[i].low;
    const prevClose = recent[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    sumTR += tr;
  }
  return sumTR / period;
}

function calculateBollingerBands(candles: BinanceCandle[], period: number = 20, stdDevMultiplier: number = 2) {
  if (candles.length < period) return null;
  const closes = candles.slice(-period).map(c => c.close);
  const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
  const variance = closes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / closes.length;
  const stdDev = Math.sqrt(variance);
  const currentPrice = closes[closes.length - 1];
  const zScore = stdDev > 0 ? (currentPrice - mean) / stdDev : 0;
  return { mean, upper: mean + stdDev * stdDevMultiplier, lower: mean - stdDev * stdDevMultiplier, stdDev, zScore };
}

function calculateKeltnerChannel(candles: BinanceCandle[], emaPeriod: number = 20, atrPeriod: number = 10, multiplier: number = 2) {
  if (candles.length < Math.max(emaPeriod, atrPeriod + 1)) return null;
  const closes = candles.slice(-emaPeriod).map(c => c.close);
  const ema = closes.reduce((s, v) => s + v, 0) / closes.length;
  const atr = calculateATR(candles, atrPeriod);
  return { middle: ema, upper: ema + atr * multiplier, lower: ema - atr * multiplier };
}

const COIN_SYMBOLS: Record<string, string> = {
  bitcoin: "BTC", ethereum: "ETH", solana: "SOL", binancecoin: "BNB",
  ripple: "XRP", dogecoin: "DOGE", cardano: "ADA", "avalanche-2": "AVAX",
  avalanche: "AVAX", chainlink: "LINK", tron: "TRX", litecoin: "LTC",
  uniswap: "UNI", sui: "SUI", "bitcoin-cash": "BCH", near: "NEAR",
  aptos: "APT", arbitrum: "ARB", optimism: "OP", polkadot: "DOT",
  cosmos: "ATOM", stellar: "XLM", hedera: "HBAR", filecoin: "FIL",
  pepe: "PEPE", aave: "AAVE", injective: "INJ", render: "RNDR",
  hyperliquid: "HYPE", zcash: "ZEC",
};

function getSymbol(coinId: string): string {
  return COIN_SYMBOLS[coinId] || coinId.toUpperCase().slice(0, 6);
}

export function makeComboKey(strategy: StrategyMode, timeframe: TimeframeKey): string {
  return `${strategy}_${timeframe}`;
}

export function generateMeanReversionSignal(
  coinId: string, currentPrice: number, candles: BinanceCandle[], timeframe: TimeframeKey
): MtfSignal | null {
  if (candles.length < 25) return null;

  const bb = calculateBollingerBands(candles, 20, 2);
  if (!bb) return null;

  const atr = calculateATR(candles, 14);
  if (atr <= 0) return null;

  const absZ = Math.abs(bb.zScore);
  if (absZ < 0.4) return null;

  const side: 'long' | 'short' = bb.zScore < -0.4 ? 'long' : 'short';
  const stopDist = Math.max(atr * 2, currentPrice * 0.01);
  const tpDist = stopDist * 1.5;

  return {
    coinId,
    symbol: getSymbol(coinId),
    side,
    entryPrice: currentPrice,
    stopLoss: side === 'long' ? currentPrice - stopDist : currentPrice + stopDist,
    takeProfit: side === 'long' ? currentPrice + tpDist : currentPrice - tpDist,
    strategy: 'meanReversion',
    timeframe,
    comboKey: makeComboKey('meanReversion', timeframe),
    reasoning: [`MR ${side.toUpperCase()} Z=${bb.zScore.toFixed(2)} ATR=$${atr.toFixed(2)} [${timeframe}]`],
    confidence: Math.min(0.9, 0.5 + absZ * 0.1),
    atr,
  };
}

export function generateVolExpansionSignal(
  coinId: string, currentPrice: number, candles: BinanceCandle[], timeframe: TimeframeKey
): MtfSignal | null {
  if (candles.length < 25) return null;

  const keltner = calculateKeltnerChannel(candles, 20, 10, 2);
  if (!keltner) return null;

  const atr = calculateATR(candles, 14);
  if (atr <= 0) return null;

  const nearThreshold = atr * 0.5;
  const isAboveUpper = currentPrice > keltner.upper;
  const isNearUpper = !isAboveUpper && currentPrice > (keltner.upper - nearThreshold) && currentPrice > keltner.middle;
  const isBelowLower = currentPrice < keltner.lower;
  const isNearLower = !isBelowLower && currentPrice < (keltner.lower + nearThreshold) && currentPrice < keltner.middle;

  let side: 'long' | 'short';
  let confidence: number;

  if (isAboveUpper || isNearUpper) {
    side = 'long';
    confidence = isAboveUpper ? 0.7 : 0.6;
  } else if (isBelowLower || isNearLower) {
    side = 'short';
    confidence = isBelowLower ? 0.7 : 0.6;
  } else {
    return null;
  }

  const stopDist = Math.max(atr * 2, currentPrice * 0.01);
  const tpDist = stopDist * 1.5;

  return {
    coinId,
    symbol: getSymbol(coinId),
    side,
    entryPrice: currentPrice,
    stopLoss: side === 'long' ? currentPrice - stopDist : currentPrice + stopDist,
    takeProfit: side === 'long' ? currentPrice + tpDist : currentPrice - tpDist,
    strategy: 'volExpansion',
    timeframe,
    comboKey: makeComboKey('volExpansion', timeframe),
    reasoning: [`VE ${side.toUpperCase()} Keltner ${isAboveUpper || isBelowLower ? 'breakout' : 'near'} ATR=$${atr.toFixed(2)} [${timeframe}]`],
    confidence,
    atr,
  };
}

export function generateMomentumSignal(
  coinId: string, currentPrice: number, candles: BinanceCandle[], timeframe: TimeframeKey
): MtfSignal | null {
  if (candles.length < 10) return null;

  const recent = candles.slice(-3);
  const prev = candles.slice(-10, -3);
  if (prev.length === 0) return null;

  const latestCandle = recent[recent.length - 1];
  const candleBody = Math.abs(latestCandle.close - latestCandle.open);
  const candleBodyPct = candleBody / latestCandle.open;
  const avgBodySize = prev.reduce((sum, c) => sum + Math.abs(c.close - c.open) / c.open, 0) / prev.length;
  const bodySurge = avgBodySize > 0 ? candleBodyPct / avgBodySize : 0;
  const priceChange3 = (recent[recent.length - 1].close - recent[0].open) / recent[0].open;
  const absChange = Math.abs(priceChange3);

  if (candleBodyPct < 0.002 || bodySurge < 1.0 || absChange < 0.003) return null;

  const side: 'long' | 'short' = priceChange3 > 0 ? 'long' : 'short';
  const atr = calculateATR(candles, 14);
  const stopDist = Math.max(atr * 1.5, currentPrice * 0.01);
  const tpDist = stopDist * 1.5;

  return {
    coinId,
    symbol: getSymbol(coinId),
    side,
    entryPrice: currentPrice,
    stopLoss: side === 'long' ? currentPrice - stopDist : currentPrice + stopDist,
    takeProfit: side === 'long' ? currentPrice + tpDist : currentPrice - tpDist,
    strategy: 'momentum',
    timeframe,
    comboKey: makeComboKey('momentum', timeframe),
    reasoning: [`Mom ${side.toUpperCase()} body=${(candleBodyPct * 100).toFixed(1)}% surge=${bodySurge.toFixed(1)}x [${timeframe}]`],
    confidence: Math.min(0.9, 0.55 + candleBodyPct * 5 + (bodySurge - 2) * 0.05),
    atr,
  };
}

export function generatePairsSignals(
  cryptos: { id: string; current_price: number }[],
  candlesByCoins: Map<string, BinanceCandle[]>,
  timeframe: TimeframeKey
): MtfSignal[] {
  const signals: MtfSignal[] = [];
  const btcCandles = candlesByCoins.get('bitcoin');
  if (!btcCandles || btcCandles.length < 25) return signals;

  const pairCandidates = ['ethereum', 'solana', 'binancecoin', 'ripple', 'dogecoin', 'sui', 'cardano', 'litecoin', 'chainlink', 'tron'];
  const LOOKBACK = 20;

  for (const altId of pairCandidates) {
    const altCandles = candlesByCoins.get(altId);
    if (!altCandles || altCandles.length < LOOKBACK + 1) continue;

    const altCrypto = cryptos.find(c => c.id === altId);
    const btcCrypto = cryptos.find(c => c.id === 'bitcoin');
    if (!altCrypto || !btcCrypto || btcCrypto.current_price <= 0) continue;

    const minLen = Math.min(btcCandles.length, altCandles.length);
    if (minLen < LOOKBACK + 1) continue;

    const window: number[] = [];
    for (let j = minLen - LOOKBACK - 1; j < minLen; j++) {
      window.push(altCandles[j].close / btcCandles[j].close);
    }

    const currentSpread = altCrypto.current_price / btcCrypto.current_price;
    window[window.length - 1] = currentSpread;

    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const std = Math.sqrt(window.map(v => Math.pow(v - mean, 2)).reduce((s, v) => s + v, 0) / window.length);
    if (std <= 0) continue;
    const zScore = (currentSpread - mean) / std;

    if (Math.abs(zScore) > 0.8) {
      const side: 'long' | 'short' = zScore < -0.8 ? 'long' : 'short';
      const atr = calculateATR(altCandles, 14);
      const stopDist = Math.max(atr * 2, altCrypto.current_price * 0.01);
      const tpDist = stopDist * 1.5;

      signals.push({
        coinId: altId,
        symbol: getSymbol(altId),
        side,
        entryPrice: altCrypto.current_price,
        stopLoss: side === 'long' ? altCrypto.current_price - stopDist : altCrypto.current_price + stopDist,
        takeProfit: side === 'long' ? altCrypto.current_price + tpDist : altCrypto.current_price - tpDist,
        strategy: 'pairsTrading',
        timeframe,
        comboKey: makeComboKey('pairsTrading', timeframe),
        reasoning: [`Pairs Z=${zScore.toFixed(2)} ${getSymbol(altId)}/BTC [${timeframe}]`],
        confidence: Math.min(0.95, 0.5 + Math.abs(zScore) * 0.1),
        atr,
      });
    }
  }

  return signals;
}

export function generateAllMtfSignals(
  cryptos: { id: string; current_price: number }[],
  candlesByCoins: Map<string, BinanceCandle[]>,
  timeframe: TimeframeKey
): MtfSignal[] {
  const signals: MtfSignal[] = [];

  for (const crypto of cryptos) {
    const candles = candlesByCoins.get(crypto.id);
    if (!candles || candles.length < 10) continue;

    const mr = generateMeanReversionSignal(crypto.id, crypto.current_price, candles, timeframe);
    if (mr) signals.push(mr);

    const ve = generateVolExpansionSignal(crypto.id, crypto.current_price, candles, timeframe);
    if (ve) signals.push(ve);

    const mom = generateMomentumSignal(crypto.id, crypto.current_price, candles, timeframe);
    if (mom) signals.push(mom);
  }

  const pairs = generatePairsSignals(cryptos, candlesByCoins, timeframe);
  signals.push(...pairs);

  return signals;
}

export function backtestOnCandles(
  candles: BinanceCandle[],
  strategy: StrategyMode,
  timeframe: TimeframeKey
): { trades: { pnlPercent: number; side: string }[]; } {
  const trades: { pnlPercent: number; side: string }[] = [];
  if (candles.length < 30) return { trades };

  const FEE_RATE = 0.0004;

  for (let i = 30; i < candles.length - 5; i++) {
    const windowCandles = candles.slice(Math.max(0, i - 25), i + 1);
    const entryPrice = candles[i].close;
    const atr = calculateATR(windowCandles, 14);
    if (atr <= 0) continue;

    let signal: { side: 'long' | 'short'; stopDist: number; tpDist: number } | null = null;

    if (strategy === 'meanReversion') {
      const bb = calculateBollingerBands(windowCandles, 20, 2);
      if (bb && Math.abs(bb.zScore) > 0.4) {
        const side: 'long' | 'short' = bb.zScore < -0.4 ? 'long' : 'short';
        signal = { side, stopDist: Math.max(atr * 2, entryPrice * 0.01), tpDist: Math.max(atr * 2, entryPrice * 0.01) * 1.5 };
      }
    } else if (strategy === 'volExpansion') {
      const keltner = calculateKeltnerChannel(windowCandles, 20, 10, 2);
      if (keltner) {
        if (entryPrice > keltner.upper) {
          signal = { side: 'long', stopDist: Math.max(atr * 2, entryPrice * 0.01), tpDist: Math.max(atr * 2, entryPrice * 0.01) * 1.5 };
        } else if (entryPrice < keltner.lower) {
          signal = { side: 'short', stopDist: Math.max(atr * 2, entryPrice * 0.01), tpDist: Math.max(atr * 2, entryPrice * 0.01) * 1.5 };
        }
      }
    } else if (strategy === 'momentum') {
      if (i >= 3) {
        const recent3 = candles.slice(i - 2, i + 1);
        const prev7 = candles.slice(Math.max(0, i - 9), i - 2);
        if (prev7.length > 0) {
          const bodyPct = Math.abs(recent3[2].close - recent3[2].open) / recent3[2].open;
          const avgBody = prev7.reduce((s, c) => s + Math.abs(c.close - c.open) / c.open, 0) / prev7.length;
          const surge = avgBody > 0 ? bodyPct / avgBody : 0;
          const change3 = (recent3[2].close - recent3[0].open) / recent3[0].open;
          if (bodyPct >= 0.002 && surge >= 1.0 && Math.abs(change3) >= 0.003) {
            const side: 'long' | 'short' = change3 > 0 ? 'long' : 'short';
            signal = { side, stopDist: Math.max(atr * 1.5, entryPrice * 0.01), tpDist: Math.max(atr * 1.5, entryPrice * 0.01) * 1.5 };
          }
        }
      }
    }

    if (!signal) continue;

    const sl = signal.side === 'long' ? entryPrice - signal.stopDist : entryPrice + signal.stopDist;
    const tp = signal.side === 'long' ? entryPrice + signal.tpDist : entryPrice - signal.tpDist;

    for (let j = i + 1; j < Math.min(i + 20, candles.length); j++) {
      const c = candles[j];
      let exitPrice: number | null = null;

      if (signal.side === 'long') {
        if (c.low <= sl) exitPrice = sl;
        else if (c.high >= tp) exitPrice = tp;
      } else {
        if (c.high >= sl) exitPrice = sl;
        else if (c.low <= tp) exitPrice = tp;
      }

      if (exitPrice !== null) {
        const rawPnl = signal.side === 'long'
          ? (exitPrice - entryPrice) / entryPrice
          : (entryPrice - exitPrice) / entryPrice;
        const netPnl = rawPnl - (FEE_RATE * 2);
        trades.push({ pnlPercent: netPnl * 100, side: signal.side });
        i = j;
        break;
      }

      if (j === Math.min(i + 19, candles.length - 1)) {
        const rawPnl = signal.side === 'long'
          ? (c.close - entryPrice) / entryPrice
          : (entryPrice - c.close) / entryPrice;
        const netPnl = rawPnl - (FEE_RATE * 2);
        trades.push({ pnlPercent: netPnl * 100, side: signal.side });
        i = j;
      }
    }
  }

  return { trades };
}
