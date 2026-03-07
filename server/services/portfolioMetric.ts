import { db } from "../db";
import { portfolioMetricSnapshots, type InsertPortfolioMetricSnapshot } from "@shared/schema";
import { getOverallRiskMetrics } from "./correlationStrategy";
import { desc } from "drizzle-orm";
import { 
  updateEquityCurve, 
  getEquityCurveState, 
  getEquitySizeMultiplier,
  shouldInvertSignal,
  getPortfolioRegime,
  type EquityCurveState 
} from "./equityCurveManager";

let drawdownProtectionActive = false;

export function getPortfolioMetricValue(): number {
  const metrics = getOverallRiskMetrics();
  return metrics.sharpeUlcerRatio;
}

export function isDrawdownProtectionActive(): boolean {
  const ecState = getEquityCurveState();
  if (ecState.lastUpdated > 0) {
    return ecState.regime === 'HIBERNATE' || ecState.rawMetric < 0;
  }
  const metric = getPortfolioMetricValue();
  drawdownProtectionActive = metric < 0;
  return drawdownProtectionActive;
}

export function updateDrawdownProtection(): void {
  const metric = getPortfolioMetricValue();
  const wasActive = drawdownProtectionActive;
  drawdownProtectionActive = metric < 0;

  if (drawdownProtectionActive && !wasActive) {
    console.log(`[Portfolio Metric] DRAWDOWN PROTECTION ACTIVATED - metric: ${metric.toFixed(4)} (< 0)`);
  } else if (!drawdownProtectionActive && wasActive) {
    console.log(`[Portfolio Metric] Drawdown protection lifted - metric: ${metric.toFixed(4)} (>= 0)`);
  }
}

export function updateEquityCurveWithTrades(closedTrades: Array<{ side: string; pnl: number | null; status: string }>): EquityCurveState {
  const rawMetric = getPortfolioMetricValue();
  return updateEquityCurve(rawMetric, closedTrades);
}

export async function savePortfolioMetricSnapshot(
  snapshotType: "periodic" | "trade_close" = "periodic",
  portfolioData?: { equity: number; openPositions: number }
): Promise<void> {
  try {
    const metrics = getOverallRiskMetrics();

    const snapshot: InsertPortfolioMetricSnapshot = {
      sharpeRatio: metrics.sharpeRatio,
      ulcerIndex: metrics.ulcerIndex,
      portfolioMetric: metrics.sharpeUlcerRatio,
      equity: portfolioData?.equity ?? 0,
      tradeCount: metrics.totalTrades,
      openPositions: portfolioData?.openPositions ?? 0,
      drawdownProtectionActive: drawdownProtectionActive ? 1 : 0,
      snapshotType,
    };

    await db.insert(portfolioMetricSnapshots).values(snapshot);
    console.log(`[Portfolio Metric] Snapshot saved (${snapshotType}): metric=${metrics.sharpeUlcerRatio.toFixed(4)}, equity=$${(portfolioData?.equity ?? 0).toFixed(2)}, protection=${drawdownProtectionActive ? 'ON' : 'OFF'}`);
  } catch (error) {
    console.error("[Portfolio Metric] Failed to save snapshot:", error);
  }
}

export async function getPortfolioMetricHistory(limit: number = 100): Promise<any[]> {
  try {
    return await db
      .select()
      .from(portfolioMetricSnapshots)
      .orderBy(desc(portfolioMetricSnapshots.createdAt))
      .limit(limit);
  } catch (error) {
    console.error("[Portfolio Metric] Failed to fetch history:", error);
    return [];
  }
}

export async function loadEquityCurveFromHistory(limit: number = 2000): Promise<Array<{ timestamp: number; equity: number }>> {
  try {
    const rows = await db
      .select({
        equity: portfolioMetricSnapshots.equity,
        createdAt: portfolioMetricSnapshots.createdAt,
      })
      .from(portfolioMetricSnapshots)
      .orderBy(desc(portfolioMetricSnapshots.createdAt))
      .limit(limit);
    
    return rows
      .filter(r => r.equity != null)
      .reverse()
      .map(r => ({
        timestamp: new Date(r.createdAt!).getTime(),
        equity: r.equity!,
      }));
  } catch (error) {
    console.error("[Portfolio Metric] Failed to load equity curve history:", error);
    return [];
  }
}
