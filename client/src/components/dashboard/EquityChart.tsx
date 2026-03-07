import { useQuery } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
} from "recharts";
import { Activity, TrendingUp } from "lucide-react";

interface EquityPoint {
  timestamp: number;
  equity: number;
  event?: 'open' | 'close' | 'stop';
  symbol?: string;
  pnl?: number;
}

interface ChartPoint {
  time: number;
  equity: number;
  event?: 'open' | 'close' | 'stop';
  symbol?: string;
  pnl?: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function formatCurrency(v: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  return (
    <div className="bg-slate-900/95 border border-cyan-500/30 rounded-lg p-2.5 text-xs shadow-lg" data-testid="equity-tooltip">
      <div className="text-muted-foreground mb-1">{formatTime(point.time)}</div>
      <div className="font-mono text-sm text-cyan-400" data-testid="text-tooltip-equity">{formatCurrency(point.equity)}</div>
      {point.event && (
        <div className="mt-1 flex items-center gap-1.5">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              point.event === 'open' ? 'bg-blue-400' : point.event === 'close' ? 'bg-green-400' : 'bg-red-400'
            }`}
          />
          <span className="text-muted-foreground">
            {point.event === 'open' ? 'Opened' : point.event === 'close' ? 'Closed' : 'Stopped Out'}{' '}
            <span className="text-foreground font-medium">{point.symbol}</span>
          </span>
          {point.pnl != null && (
            <span className={`font-mono ${point.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {point.pnl >= 0 ? '+' : ''}{formatCurrency(point.pnl)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function EquityChart() {
  const { data: rawData, isLoading } = useQuery<EquityPoint[]>({
    queryKey: ["/api/equity-curve"],
    refetchInterval: 15000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground" data-testid="equity-chart-loading">
        <Activity className="w-5 h-5 animate-pulse mr-2" />
        <span className="text-xs">Loading equity data...</span>
      </div>
    );
  }

  if (!rawData || rawData.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2" data-testid="equity-chart-empty">
        <TrendingUp className="w-6 h-6 opacity-40" />
        <p className="text-xs">Equity chart will appear after trading begins</p>
        <p className="text-[10px]">Snapshots recorded every ~30 seconds</p>
      </div>
    );
  }

  const chartData: ChartPoint[] = rawData.map((p) => ({
    time: p.timestamp,
    equity: p.equity,
    event: p.event,
    symbol: p.symbol,
    pnl: p.pnl,
  }));

  const openEvents = chartData.filter((p) => p.event === 'open');
  const closeEvents = chartData.filter((p) => p.event === 'close');
  const stopEvents = chartData.filter((p) => p.event === 'stop');

  const minEquity = Math.min(...chartData.map((p) => p.equity));
  const maxEquity = Math.max(...chartData.map((p) => p.equity));
  const range = maxEquity - minEquity;
  const padding = range > 0 ? range * 0.1 : 5;
  const yMin = minEquity - padding;
  const yMax = maxEquity + padding;

  const startEquity = chartData[0].equity;
  const endEquity = chartData[chartData.length - 1].equity;
  const isUp = endEquity >= startEquity;

  return (
    <div className="w-full" data-testid="equity-chart">
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="text-equity-title">
          <TrendingUp className="w-3.5 h-3.5" />
          Equity Curve
        </div>
        <div className="flex items-center gap-3 text-[10px]" data-testid="legend-equity-chart">
          <span className="flex items-center gap-1" data-testid="legend-open">
            <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
            Open
          </span>
          <span className="flex items-center gap-1" data-testid="legend-close">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
            Close
          </span>
          <span className="flex items-center gap-1" data-testid="legend-stop">
            <span className="inline-block w-2 h-2 rounded-full bg-red-400" />
            Stop
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          <defs>
            <linearGradient id="equityLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={isUp ? "#22c55e" : "#ef4444"} />
              <stop offset="100%" stopColor={isUp ? "#06b6d4" : "#f97316"} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v: number) => formatTime(v)}
            tick={{ fontSize: 9, fill: '#6b7280' }}
            tickLine={false}
            axisLine={{ stroke: '#374151', strokeWidth: 1 }}
            minTickGap={50}
          />
          <YAxis
            domain={[yMin, yMax]}
            tick={{ fontSize: 9, fill: '#6b7280' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`}
            width={48}
          />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey="equity"
            stroke="url(#equityLine)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: '#06b6d4', stroke: '#0e7490', strokeWidth: 1 }}
          />
          {openEvents.map((pt, i) => (
            <ReferenceDot
              key={`open-${i}`}
              x={pt.time}
              y={pt.equity}
              r={4}
              fill="#3b82f6"
              stroke="#1e40af"
              strokeWidth={1.5}
            />
          ))}
          {closeEvents.map((pt, i) => (
            <ReferenceDot
              key={`close-${i}`}
              x={pt.time}
              y={pt.equity}
              r={4}
              fill="#22c55e"
              stroke="#15803d"
              strokeWidth={1.5}
            />
          ))}
          {stopEvents.map((pt, i) => (
            <ReferenceDot
              key={`stop-${i}`}
              x={pt.time}
              y={pt.equity}
              r={5}
              fill="#ef4444"
              stroke="#b91c1c"
              strokeWidth={1.5}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
