export const HL_TESTNET = process.env.HYPERLIQUID_TESTNET === "true";
export const HL_BASE_URL = HL_TESTNET
  ? "https://api.hyperliquid-testnet.xyz"
  : "https://api.hyperliquid.xyz";
export const HL_MAINNET_URL = "https://api.hyperliquid.xyz";

export const HL_WALLET_ADDRESS = process.env.HYPERLIQUID_WALLET_ADDRESS || "";
export const HL_PRIVATE_KEY = process.env.HYPERLIQUID_PRIVATE_KEY || "";

const KILO_PREFIX = "k";

function hlNameToDisplaySymbol(hlName: string): string {
  if (hlName.startsWith(KILO_PREFIX) && hlName.length > 1 && hlName[1] === hlName[1].toUpperCase()) {
    return hlName.slice(1);
  }
  return hlName;
}

function displaySymbolToHlName(symbol: string, hlUniverse: Set<string>): string {
  if (hlUniverse.has(symbol)) return symbol;
  const kiloName = KILO_PREFIX + symbol;
  if (hlUniverse.has(kiloName)) return kiloName;
  return symbol;
}

export const SYMBOL_TO_HL: Record<string, string> = {
  BTC: "BTC",
  ETH: "ETH",
  SOL: "SOL",
  XRP: "XRP",
  DOGE: "DOGE",
  BNB: "BNB",
  SUI: "SUI",
  PEPE: "kPEPE",
  ADA: "ADA",
  LINK: "LINK",
  AVAX: "AVAX",
  TRX: "TRX",
  DOT: "DOT",
  NEAR: "NEAR",
  ZEC: "ZEC",
  ENSO: "ENSO",
  SAHARA: "SAHARA",
};

export const HL_TO_SYMBOL: Record<string, string> = {};
for (const [k, v] of Object.entries(SYMBOL_TO_HL)) {
  HL_TO_SYMBOL[v] = k;
}

let testnetCoins: Set<string> = new Set();
let testnetCoinsLoaded = false;

export interface CoinMeta {
  name: string;
  index: number;
  szDecimals: number;
  maxLeverage: number;
}

let coinMetaCache: Map<string, CoinMeta> = new Map();
let metaLoaded = false;

function rebuildMappings(hlNames: string[]): void {
  const hlUniverse = new Set(hlNames);

  for (const hlName of hlNames) {
    const display = hlNameToDisplaySymbol(hlName);
    if (!SYMBOL_TO_HL[display]) {
      SYMBOL_TO_HL[display] = hlName;
    }
    if (!HL_TO_SYMBOL[hlName]) {
      HL_TO_SYMBOL[hlName] = display;
    }
  }

  for (const [display, hlName] of Object.entries(SYMBOL_TO_HL)) {
    if (!hlUniverse.has(hlName)) {
      const resolved = displaySymbolToHlName(display, hlUniverse);
      if (resolved !== hlName && hlUniverse.has(resolved)) {
        SYMBOL_TO_HL[display] = resolved;
        delete HL_TO_SYMBOL[hlName];
        HL_TO_SYMBOL[resolved] = display;
      }
    }
  }
}

export async function loadTestnetCoins(): Promise<void> {
  if (testnetCoinsLoaded) return;
  if (!HL_TESTNET) {
    testnetCoinsLoaded = true;
    return;
  }

  try {
    const response = await fetch(`${HL_BASE_URL}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    });
    if (!response.ok) throw new Error(`Testnet meta fetch failed: ${response.status}`);
    const data = await response.json();
    const universe = data.universe || [];
    testnetCoins = new Set(universe.map((c: any) => c.name));
    testnetCoinsLoaded = true;
    console.log(`[HL Config] Testnet has ${testnetCoins.size} tradeable coins`);
  } catch (error) {
    console.error("[HL Config] Failed to load testnet coin list:", error instanceof Error ? error.message : error);
  }
}

export function isCoinAvailableForExecution(hlCoinName: string): boolean {
  if (!HL_TESTNET) return true;
  if (!testnetCoinsLoaded || testnetCoins.size === 0) return true;
  return testnetCoins.has(hlCoinName);
}

export async function loadCoinMeta(): Promise<Map<string, CoinMeta>> {
  if (metaLoaded && coinMetaCache.size > 0) return coinMetaCache;

  const metaUrl = HL_TESTNET ? HL_BASE_URL : HL_MAINNET_URL;
  const label = HL_TESTNET ? "TESTNET" : "MAINNET";

  try {
    const response = await fetch(`${metaUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    });

    if (!response.ok) throw new Error(`Meta fetch failed: ${response.status}`);

    const data = await response.json();
    const universe = data.universe || [];
    coinMetaCache = new Map();
    const hlNames: string[] = [];

    for (let i = 0; i < universe.length; i++) {
      const coin = universe[i];
      coinMetaCache.set(coin.name, {
        name: coin.name,
        index: i,
        szDecimals: coin.szDecimals,
        maxLeverage: coin.maxLeverage,
      });
      hlNames.push(coin.name);
    }

    rebuildMappings(hlNames);

    metaLoaded = true;
    console.log(`[HL Config] Loaded metadata for ${coinMetaCache.size} coins from ${label}, mapped ${Object.keys(SYMBOL_TO_HL).length} symbols`);

    if (HL_TESTNET) {
      await loadTestnetCoins();
    }

    return coinMetaCache;
  } catch (error) {
    console.error("[HL Config] Failed to load coin metadata:", error instanceof Error ? error.message : error);
    return coinMetaCache;
  }
}

export function getCoinMeta(hlSymbol: string): CoinMeta | undefined {
  return coinMetaCache.get(hlSymbol);
}

export function isHyperliquidEnabled(): boolean {
  return !!HL_WALLET_ADDRESS && !!HL_PRIVATE_KEY;
}

export function getExecutionMode(): "internal" | "hyperliquid" {
  const mode = process.env.EXECUTION_MODE || "internal";
  if (mode === "hyperliquid" && isHyperliquidEnabled()) return "hyperliquid";
  return "internal";
}
