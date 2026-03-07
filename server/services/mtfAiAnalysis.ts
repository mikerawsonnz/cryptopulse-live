import { db } from "../db";
import { mtfMike1Snapshots, mtfShadowTrades, mtfAiInsights, mtfAllocationDecisions } from "@shared/schema";
import { desc, sql } from "drizzle-orm";
import { getAllMike1Scores } from "./mtfShadowEngine";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

interface AiModifier {
  [comboKey: string]: number;
}

let lastAnalysisTime = 0;
let currentModifiers: AiModifier = {};
const ANALYSIS_INTERVAL_MS = 60 * 60 * 1000;

export function getAiModifiers(): AiModifier {
  return { ...currentModifiers };
}

export async function runHourlyAiAnalysis(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastAnalysisTime < ANALYSIS_INTERVAL_MS) return;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('[MTF AI] No Gemini API key, skipping analysis');
    return;
  }

  try {
    const recentSnapshots = await db.select().from(mtfMike1Snapshots)
      .orderBy(desc(mtfMike1Snapshots.createdAt))
      .limit(200);

    const recentTrades = await db.select({
      comboKey: mtfShadowTrades.comboKey,
      strategy: mtfShadowTrades.strategy,
      timeframe: mtfShadowTrades.timeframe,
      pnlPercent: mtfShadowTrades.pnlPercent,
      status: mtfShadowTrades.status,
      side: mtfShadowTrades.side,
      btcPrice: mtfShadowTrades.btcPrice,
    }).from(mtfShadowTrades)
      .orderBy(desc(mtfShadowTrades.createdAt))
      .limit(500);

    const recentDecisions = await db.select().from(mtfAllocationDecisions)
      .orderBy(desc(mtfAllocationDecisions.createdAt))
      .limit(50);

    if (recentSnapshots.length < 12) {
      console.log(`[MTF AI] Not enough data for analysis yet (${recentSnapshots.length} snapshots, need 12)`);
      return;
    }

    lastAnalysisTime = now;

    const currentScores = getAllMike1Scores();

    const snapshotSummary = summarizeSnapshots(recentSnapshots);
    const tradeSummary = summarizeTrades(recentTrades);
    const decisionSummary = summarizeDecisions(recentDecisions);

    const prompt = buildAnalysisPrompt(currentScores, snapshotSummary, tradeSummary, decisionSummary);

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
      }),
    });

    if (!response.ok) {
      console.error('[MTF AI] Gemini API error:', response.status);
      return;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return;

    const parsed = parseAiResponse(text, currentScores);
    currentModifiers = parsed.modifiers;

    await db.insert(mtfAiInsights).values({
      insightType: 'hourly_analysis',
      pattern: parsed.pattern,
      recommendation: parsed.recommendation,
      confidence: parsed.confidence,
      affectedCombos: parsed.affectedCombos,
      modifiers: parsed.modifiers,
      rawAnalysis: text,
    });

    console.log(`[MTF AI] Analysis complete: ${parsed.pattern} | Modifiers: ${JSON.stringify(parsed.modifiers)}`);
  } catch (e) {
    console.error('[MTF AI] Analysis failed:', e);
  }
}

function summarizeSnapshots(snapshots: any[]): string {
  const byCombo: Record<string, { scores: number[]; timestamps: string[] }> = {};
  for (const s of snapshots) {
    if (!byCombo[s.comboKey]) byCombo[s.comboKey] = { scores: [], timestamps: [] };
    byCombo[s.comboKey].scores.push(s.mike1Score);
    byCombo[s.comboKey].timestamps.push(new Date(s.createdAt).toISOString());
  }

  const lines: string[] = [];
  for (const [key, data] of Object.entries(byCombo)) {
    const latest = data.scores[0] || 0;
    const oldest = data.scores[data.scores.length - 1] || 0;
    const trend = latest > oldest ? 'improving' : latest < oldest ? 'declining' : 'stable';
    const avg = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
    lines.push(`${key}: current=${latest.toFixed(2)}, avg=${avg.toFixed(2)}, trend=${trend}, samples=${data.scores.length}`);
  }
  return lines.join('\n');
}

function summarizeTrades(trades: any[]): string {
  const byCombo: Record<string, { wins: number; losses: number; totalPnl: number; sides: Record<string, number> }> = {};
  for (const t of trades) {
    if (!byCombo[t.comboKey]) byCombo[t.comboKey] = { wins: 0, losses: 0, totalPnl: 0, sides: { long: 0, short: 0 } };
    if ((t.pnlPercent || 0) > 0) byCombo[t.comboKey].wins++;
    else byCombo[t.comboKey].losses++;
    byCombo[t.comboKey].totalPnl += t.pnlPercent || 0;
    byCombo[t.comboKey].sides[t.side] = (byCombo[t.comboKey].sides[t.side] || 0) + 1;
  }

  const lines: string[] = [];
  for (const [key, data] of Object.entries(byCombo)) {
    const total = data.wins + data.losses;
    const wr = total > 0 ? (data.wins / total * 100).toFixed(0) : '0';
    lines.push(`${key}: ${total} trades, WR=${wr}%, PnL=${data.totalPnl.toFixed(2)}%, Long=${data.sides.long || 0}/Short=${data.sides.short || 0}`);
  }
  return lines.join('\n');
}

function summarizeDecisions(decisions: any[]): string {
  if (decisions.length === 0) return 'No decisions yet';
  const switches = decisions.filter(d => d.wasSwitch === 1);
  const unique = Array.from(new Set(decisions.map(d => d.primaryCombo)));
  return `${decisions.length} decisions, ${switches.length} switches, unique primaries: ${unique.join(', ')}`;
}

function buildAnalysisPrompt(
  currentScores: Record<string, number>,
  snapshotSummary: string,
  tradeSummary: string,
  decisionSummary: string
): string {
  return `You are an AI analyzing a multi-timeframe crypto trading system. The system runs 4 strategies (meanReversion, volExpansion, momentum, pairsTrading) across 3 timeframes (5m, 15m, 1h) = 12 combos. Each combo shadow-trades and has a Mike1 score (risk-adjusted return metric).

CURRENT MIKE1 SCORES:
${Object.entries(currentScores).map(([k, v]) => `${k}: ${v.toFixed(3)}`).join('\n')}

MIKE1 SCORE HISTORY (recent snapshots):
${snapshotSummary}

TRADE PERFORMANCE:
${tradeSummary}

ALLOCATION DECISIONS:
${decisionSummary}

YOUR TASK: Find non-obvious patterns that could improve allocation. Consider:
1. STRATEGY MEAN-REVERSION: Do poorly-performing combos tend to recover? Should we allocate MORE to the worst Mike1 combos?
2. CROSS-TIMEFRAME PATTERNS: Does momentum on 5m predict meanReversion success on 1h?
3. CYCLICAL PATTERNS: Do certain combos perform better at certain times?
4. DIRECTIONAL BIAS: Are long or short trades consistently better for certain combos?
5. CONTRARIAN SIGNALS: Should we invert the allocation (pick worst instead of best)?

RESPOND IN THIS EXACT FORMAT:
PATTERN: [one-line description of the strongest pattern found]
CONFIDENCE: [0.0 to 1.0]
RECOMMENDATION: [specific actionable recommendation]
MODIFIERS: [JSON object with combo keys as keys and modifier values (-0.15 to +0.15) as values, only include combos that should be adjusted]
AFFECTED_COMBOS: [comma-separated list of affected combo keys]`;
}

function parseAiResponse(text: string, currentScores: Record<string, number>): {
  pattern: string;
  recommendation: string;
  confidence: number;
  modifiers: AiModifier;
  affectedCombos: string[];
} {
  let pattern = 'No clear pattern detected';
  let recommendation = 'Continue with current allocation';
  let confidence = 0.3;
  let modifiers: AiModifier = {};
  let affectedCombos: string[] = [];

  const patternMatch = text.match(/PATTERN:\s*(.+)/i);
  if (patternMatch) pattern = patternMatch[1].trim();

  const confMatch = text.match(/CONFIDENCE:\s*([\d.]+)/i);
  if (confMatch) confidence = Math.min(1, Math.max(0, parseFloat(confMatch[1])));

  const recMatch = text.match(/RECOMMENDATION:\s*(.+)/i);
  if (recMatch) recommendation = recMatch[1].trim();

  const modMatch = text.match(/MODIFIERS:\s*(\{[^}]+\})/i);
  if (modMatch) {
    try {
      const parsed = JSON.parse(modMatch[1]);
      for (const [key, value] of Object.entries(parsed)) {
        if (key in currentScores && typeof value === 'number') {
          modifiers[key] = Math.max(-0.15, Math.min(0.15, value as number));
        }
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  const affectedMatch = text.match(/AFFECTED_COMBOS:\s*(.+)/i);
  if (affectedMatch) {
    affectedCombos = affectedMatch[1].split(',').map(s => s.trim()).filter(s => s in currentScores);
  }

  return { pattern, recommendation, confidence, modifiers, affectedCombos };
}

export async function getRecentInsights(limit: number = 10): Promise<any[]> {
  return db.select().from(mtfAiInsights)
    .orderBy(desc(mtfAiInsights.createdAt))
    .limit(limit);
}
