// Using native fetch (Node.js 18+)

interface StablecoinData {
  date: string;
  totalCirculating: { peggedUSD: number };
  totalCirculatingUSD: { peggedUSD: number };
}

interface BridgeData {
  id: number;
  name: string;
  displayName: string;
  volumePrevDay: number;
  volumePrev2Day: number;
  last24hVolume: number;
  weeklyVolume: number;
  monthlyVolume: number;
}

interface FlowMetrics {
  stablecoinSupply: {
    current: number;
    previous24h: number;
    delta24h: number;
    deltaPercent: number;
    interpretation: string;
  };
  bridgeActivity: {
    totalVolume24h: number;
    totalVolumePrevDay: number;
    delta24h: number;
    deltaPercent: number;
    topBridges: Array<{
      name: string;
      volume24h: number;
      volumeChange: number;
    }>;
    interpretation: string;
  };
  netFlowSignal: {
    score: number;
    direction: "inflow" | "outflow" | "neutral";
    strength: "strong" | "moderate" | "weak";
    description: string;
  };
  lastUpdated: string;
}

const CACHE_TTL = 5 * 60 * 1000;
let cache: { data: FlowMetrics | null; timestamp: number } = {
  data: null,
  timestamp: 0,
};

async function fetchStablecoinData(): Promise<StablecoinData[]> {
  try {
    const response = await fetch(
      "https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=1",
      {
        headers: { Accept: "application/json" },
        timeout: 10000,
      } as any
    );

    if (!response.ok) {
      throw new Error(`Stablecoin API error: ${response.status}`);
    }

    const data = (await response.json()) as StablecoinData[];
    return data.slice(-7);
  } catch (error) {
    console.error("Failed to fetch stablecoin data:", error);
    return [];
  }
}

async function fetchBridgeData(): Promise<BridgeData[]> {
  try {
    const response = await fetch("https://bridges.llama.fi/bridges", {
      headers: { Accept: "application/json" },
      timeout: 10000,
    } as any);

    if (!response.ok) {
      throw new Error(`Bridge API error: ${response.status}`);
    }

    const data = (await response.json()) as { bridges: BridgeData[] };
    return data.bridges || [];
  } catch (error) {
    console.error("Failed to fetch bridge data:", error);
    return [];
  }
}

function interpretStablecoinFlow(deltaPercent: number): string {
  if (deltaPercent > 0.5) return "Strong fiat inflows - bullish signal";
  if (deltaPercent > 0.1) return "Moderate fiat inflows - positive";
  if (deltaPercent < -0.5) return "Strong fiat outflows - bearish signal";
  if (deltaPercent < -0.1) return "Moderate fiat outflows - caution";
  return "Stable supply - neutral market";
}

function interpretBridgeActivity(deltaPercent: number): string {
  if (deltaPercent > 50) return "Surge in cross-chain activity - high interest";
  if (deltaPercent > 20) return "Increased bridge usage - growing activity";
  if (deltaPercent < -30) return "Declining cross-chain transfers - lower activity";
  if (deltaPercent < -10) return "Slightly reduced bridge volume";
  return "Normal cross-chain activity levels";
}

function calculateNetFlowSignal(
  stableDelta: number,
  bridgeDelta: number
): FlowMetrics["netFlowSignal"] {
  const stableScore = Math.max(-1, Math.min(1, stableDelta / 0.5));
  const bridgeScore = Math.max(-1, Math.min(1, bridgeDelta / 50));
  const combinedScore = stableScore * 0.7 + bridgeScore * 0.3;

  let direction: "inflow" | "outflow" | "neutral" = "neutral";
  let strength: "strong" | "moderate" | "weak" = "weak";
  let description = "";

  if (combinedScore > 0.3) {
    direction = "inflow";
    strength = combinedScore > 0.6 ? "strong" : "moderate";
    description = "Capital flowing into crypto markets";
  } else if (combinedScore < -0.3) {
    direction = "outflow";
    strength = combinedScore < -0.6 ? "strong" : "moderate";
    description = "Capital flowing out of crypto markets";
  } else {
    direction = "neutral";
    strength = "weak";
    description = "Balanced capital flows";
  }

  return {
    score: Math.round(combinedScore * 100) / 100,
    direction,
    strength,
    description,
  };
}

export async function getFlowMetrics(): Promise<FlowMetrics | null> {
  const now = Date.now();

  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  try {
    const [stablecoinData, bridgeData] = await Promise.all([
      fetchStablecoinData(),
      fetchBridgeData(),
    ]);

    if (stablecoinData.length < 2) {
      console.error("Insufficient stablecoin data");
      return cache.data;
    }

    const latestStable = stablecoinData[stablecoinData.length - 1];
    const prevStable = stablecoinData[stablecoinData.length - 2];

    const currentSupply = latestStable.totalCirculatingUSD?.peggedUSD || 0;
    const prevSupply = prevStable.totalCirculatingUSD?.peggedUSD || 0;
    const supplyDelta = currentSupply - prevSupply;
    const supplyDeltaPercent =
      prevSupply > 0 ? (supplyDelta / prevSupply) * 100 : 0;

    const topBridges = bridgeData
      .filter((b) => b.last24hVolume > 0)
      .sort((a, b) => b.last24hVolume - a.last24hVolume)
      .slice(0, 5)
      .map((b) => ({
        name: b.displayName || b.name,
        volume24h: b.last24hVolume,
        volumeChange:
          b.volumePrev2Day > 0
            ? ((b.volumePrevDay - b.volumePrev2Day) / b.volumePrev2Day) * 100
            : 0,
      }));

    const totalVolume24h = bridgeData.reduce(
      (sum, b) => sum + (b.last24hVolume || 0),
      0
    );
    const totalVolumePrevDay = bridgeData.reduce(
      (sum, b) => sum + (b.volumePrev2Day || 0),
      0
    );
    const bridgeDelta = totalVolume24h - totalVolumePrevDay;
    const bridgeDeltaPercent =
      totalVolumePrevDay > 0 ? (bridgeDelta / totalVolumePrevDay) * 100 : 0;

    const metrics: FlowMetrics = {
      stablecoinSupply: {
        current: currentSupply,
        previous24h: prevSupply,
        delta24h: supplyDelta,
        deltaPercent: Math.round(supplyDeltaPercent * 1000) / 1000,
        interpretation: interpretStablecoinFlow(supplyDeltaPercent),
      },
      bridgeActivity: {
        totalVolume24h,
        totalVolumePrevDay,
        delta24h: bridgeDelta,
        deltaPercent: Math.round(bridgeDeltaPercent * 100) / 100,
        topBridges,
        interpretation: interpretBridgeActivity(bridgeDeltaPercent),
      },
      netFlowSignal: calculateNetFlowSignal(
        supplyDeltaPercent,
        bridgeDeltaPercent
      ),
      lastUpdated: new Date().toISOString(),
    };

    cache = { data: metrics, timestamp: now };
    return metrics;
  } catch (error) {
    console.error("Failed to calculate flow metrics:", error);
    return cache.data;
  }
}
