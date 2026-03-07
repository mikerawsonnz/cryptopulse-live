import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { 
  Activity, 
  TrendingUp, 
  TrendingDown,
  Target,
  Zap,
  Clock,
  Timer,
  Layers,
  ToggleLeft,
  ToggleRight
} from "lucide-react";

interface BasketRanking {
  symbol: string;
  coinName: string;
  price: number;
  momentum30m: number;
  confirmed: boolean;
  atrPercent: number;
  inLongBasket: boolean;
  inShortBasket: boolean;
}

interface ScaleInInfo {
  layers: number;
  maxLayers: number;
  nextLayerPct: number | null;
}

interface MetaStats {
  momMax: number;
  momMin: number;
  momAvg: number;
  momSum: number;
  momSumNormalized: number;
  atrMax: number;
  atrMin: number;
  atrAvg: number;
  atrSum: number;
  coinCount: number;
  updatedAt: string;
}

interface RegimeInfo {
  regime: string;
  momNorm: number;
  atrAvg: number;
  volRegime: string;
  longMultiplier: number;
  shortMultiplier: number;
  scaleInEnabled: boolean;
  scaleInDirection: string;
  portfolioStopPercent: number;
}

interface BasketStatsResponse {
  strategyMode: string;
  signalInversion: boolean;
  confirmationMode: '5m' | '1m';
  basket: {
    longSymbols: string[];
    shortSymbols: string[];
    pendingLongs: string[];
    pendingShorts: string[];
    totalExposure: number;
    maxBudget: number;
    exposurePercent: number;
    totalUnrealized: number;
    positionCount: number;
    lastRebalance: string | null;
    nextRebalanceMs: number;
    scaleIn: Record<string, ScaleInInfo>;
  };
  rankings: BasketRanking[];
  timers: {
    nextRebalanceMs: number;
    rebalanceIntervalMs: number;
    uptimeMs: number;
  };
  metaStats: MetaStats | null;
  regime?: RegimeInfo;
  lastUpdated: string;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "Now";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function LayerBar({ layers, maxLayers }: { layers: number; maxLayers: number }) {
  return (
    <div className="flex gap-px">
      {Array.from({ length: maxLayers }).map((_, i) => (
        <div
          key={i}
          className={`h-1.5 w-2 rounded-sm ${
            i < layers ? 'bg-emerald-400' : 'bg-slate-700'
          }`}
        />
      ))}
    </div>
  );
}

export function ModeStatsPanel() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery<BasketStatsResponse>({
    queryKey: ['/api/mode-stats'],
    refetchInterval: 10000,
  });

  const toggleModeMutation = useMutation({
    mutationFn: async () => {
      const newMode = data?.confirmationMode === '1m' ? '5m' : '1m';
      const res = await apiRequest('POST', '/api/basket-confirmation-mode', { mode: newMode });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/mode-stats'] });
    },
  });

  const [countdowns, setCountdowns] = useState<{ rebalance: string; uptime: string }>({
    rebalance: '--', uptime: '--'
  });

  useEffect(() => {
    if (!data?.timers) return;

    const fetchTime = Date.now();
    const update = () => {
      const elapsed = Date.now() - fetchTime;
      setCountdowns({
        rebalance: formatCountdown(data.timers.nextRebalanceMs - elapsed),
        uptime: formatUptime(data.timers.uptimeMs + elapsed),
      });
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [data?.timers]);

  if (isLoading) {
    return (
      <Card className="bg-card/50 backdrop-blur border-primary/20">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Momentum Basket
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-2">
            <div className="h-4 bg-muted rounded w-3/4"></div>
            <div className="h-4 bg-muted rounded w-1/2"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card className="bg-card/50 backdrop-blur border-primary/20">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Momentum Basket
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-xs">Failed to load basket stats</p>
        </CardContent>
      </Card>
    );
  }

  const scaleIn = data.basket.scaleIn || {};

  return (
    <Card className="bg-card/50 backdrop-blur border-primary/20" data-testid="mode-stats-panel">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-emerald-400" />
            Scale-In Basket
          </div>
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-normal">
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] gap-1 hover:bg-primary/10"
              onClick={() => toggleModeMutation.mutate()}
              disabled={toggleModeMutation.isPending}
              data-testid="button-toggle-confirmation-mode"
            >
              {data?.confirmationMode === '1m' ? (
                <ToggleRight className="h-3 w-3 text-cyan-400" />
              ) : (
                <ToggleLeft className="h-3 w-3 text-muted-foreground" />
              )}
              <span className={data?.confirmationMode === '1m' ? 'text-cyan-400' : ''}>
                {data?.confirmationMode === '1m' ? '1m Confirm' : '5m Confirm'}
              </span>
            </Button>
            <span className="flex items-center gap-1" data-testid="text-uptime">
              <Clock className="h-3 w-3" />
              Up {countdowns.uptime}
            </span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-slate-800/40 rounded-lg p-2.5 border border-emerald-500/15" data-testid="timer-rebalance">
            <div className="flex items-center gap-1.5 mb-1">
              <Timer className="h-3 w-3 text-emerald-400" />
              <span className="text-[10px] text-muted-foreground">Next Rebalance</span>
            </div>
            <div className="font-mono text-sm text-emerald-400">{countdowns.rebalance}</div>
            <div className="text-[9px] text-muted-foreground">every 30m</div>
          </div>
          <div className="bg-slate-800/40 rounded-lg p-2.5 border border-cyan-500/15" data-testid="basket-exposure">
            <div className="flex items-center gap-1.5 mb-1">
              <Target className="h-3 w-3 text-cyan-400" />
              <span className="text-[10px] text-muted-foreground">Basket Exposure</span>
            </div>
            <div className="font-mono text-sm text-cyan-400">${data.basket.totalExposure.toFixed(0)}</div>
            <div className="text-[9px] text-muted-foreground">{data.basket.exposurePercent}% of equity (25% cap)</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="bg-green-500/10 rounded-lg p-2 border border-green-500/20">
            <div className="flex items-center gap-1.5 mb-1">
              <TrendingUp className="h-3 w-3 text-green-400" />
              <span className="text-[10px] text-green-400 font-medium">LONG BASKET</span>
            </div>
            <div className="space-y-1">
              {data.basket.longSymbols.length > 0 ? data.basket.longSymbols.map(sym => {
                const r = data.rankings.find(rr => rr.symbol === sym);
                const si = scaleIn[sym];
                return (
                  <div key={sym} data-testid={`basket-long-${sym}`}>
                    <div className="flex justify-between text-xs">
                      <span className="font-mono text-green-400">{sym}</span>
                      <span className="font-mono text-green-300 text-[10px]">
                        {si ? `L${si.layers}/${si.maxLayers}` : ''}
                      </span>
                    </div>
                    {si && <LayerBar layers={si.layers} maxLayers={si.maxLayers} />}
                  </div>
                );
              }) : (
                <span className="text-[10px] text-muted-foreground">No confirmed signals</span>
              )}
              {data.basket.pendingLongs?.length > 0 && data.basket.pendingLongs.map(sym => (
                <div key={`pending-${sym}`} className="flex justify-between text-xs opacity-60" data-testid={`basket-pending-long-${sym}`}>
                  <span className="font-mono text-yellow-400">{sym} <span className="text-[8px]">PENDING</span></span>
                  <span className="font-mono text-yellow-300 text-[10px]">L0/5</span>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-red-500/10 rounded-lg p-2 border border-red-500/20">
            <div className="flex items-center gap-1.5 mb-1">
              <TrendingDown className="h-3 w-3 text-red-400" />
              <span className="text-[10px] text-red-400 font-medium">SHORT BASKET</span>
            </div>
            <div className="space-y-1">
              {data.basket.shortSymbols.length > 0 ? data.basket.shortSymbols.map(sym => {
                const r = data.rankings.find(rr => rr.symbol === sym);
                const si = scaleIn[sym];
                return (
                  <div key={sym} data-testid={`basket-short-${sym}`}>
                    <div className="flex justify-between text-xs">
                      <span className="font-mono text-red-400">{sym}</span>
                      <span className="font-mono text-red-300 text-[10px]">
                        {si ? `L${si.layers}/${si.maxLayers}` : ''}
                      </span>
                    </div>
                    {si && <LayerBar layers={si.layers} maxLayers={si.maxLayers} />}
                  </div>
                );
              }) : (
                <span className="text-[10px] text-muted-foreground">No confirmed signals</span>
              )}
              {data.basket.pendingShorts?.length > 0 && data.basket.pendingShorts.map(sym => (
                <div key={`pending-${sym}`} className="flex justify-between text-xs opacity-60" data-testid={`basket-pending-short-${sym}`}>
                  <span className="font-mono text-yellow-400">{sym} <span className="text-[8px]">PENDING</span></span>
                  <span className="font-mono text-yellow-300 text-[10px]">L0/5</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {data.rankings.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-primary/10">
                  <th className="text-left py-1 pr-2">#</th>
                  <th className="text-left py-1 px-1">Symbol</th>
                  <th className="text-right py-1 px-1">Mom 30m</th>
                  <th className="text-right py-1 px-1">ATR%</th>
                  <th className="text-center py-1 pl-1">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.rankings.map((coin, index) => {
                  const si = scaleIn[coin.symbol];
                  return (
                    <tr 
                      key={coin.symbol} 
                      className={`border-b border-primary/5 ${
                        coin.inLongBasket ? 'bg-green-500/5' : 
                        coin.inShortBasket ? 'bg-red-500/5' : ''
                      }`}
                      data-testid={`ranking-row-${coin.symbol}`}
                    >
                      <td className="py-1.5 pr-2 font-mono text-muted-foreground">{index + 1}</td>
                      <td className="py-1.5 px-1 font-medium">{coin.symbol}</td>
                      <td className={`text-right py-1.5 px-1 font-mono ${coin.momentum30m >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {coin.momentum30m >= 0 ? '+' : ''}{coin.momentum30m.toFixed(4)}%
                      </td>
                      <td className="text-right py-1.5 px-1 font-mono text-muted-foreground">
                        {coin.atrPercent.toFixed(2)}%
                      </td>
                      <td className="text-center py-1.5 pl-1">
                        {coin.inLongBasket && si && (
                          <Badge variant="outline" className="text-[9px] bg-green-500/20 text-green-400 border-green-500/30">L{si.layers}/{si.maxLayers}</Badge>
                        )}
                        {coin.inLongBasket && !si && (
                          <Badge variant="outline" className="text-[9px] bg-green-500/20 text-green-400 border-green-500/30">LONG</Badge>
                        )}
                        {coin.inShortBasket && si && (
                          <Badge variant="outline" className="text-[9px] bg-red-500/20 text-red-400 border-red-500/30">S{si.layers}/{si.maxLayers}</Badge>
                        )}
                        {coin.inShortBasket && !si && (
                          <Badge variant="outline" className="text-[9px] bg-red-500/20 text-red-400 border-red-500/30">SHORT</Badge>
                        )}
                        {!coin.inLongBasket && !coin.inShortBasket && data.basket.pendingLongs?.includes(coin.symbol) && (
                          <Badge variant="outline" className="text-[9px] bg-yellow-500/20 text-yellow-400 border-yellow-500/30">PEND L</Badge>
                        )}
                        {!coin.inLongBasket && !coin.inShortBasket && data.basket.pendingShorts?.includes(coin.symbol) && (
                          <Badge variant="outline" className="text-[9px] bg-yellow-500/20 text-yellow-400 border-yellow-500/30">PEND S</Badge>
                        )}
                        {!coin.inLongBasket && !coin.inShortBasket && !data.basket.pendingLongs?.includes(coin.symbol) && !data.basket.pendingShorts?.includes(coin.symbol) && (
                          <span className="text-[9px] text-muted-foreground">{coin.confirmed ? '✓' : '—'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {data.regime && (
          <div className="pt-2 border-t border-primary/10" data-testid="section-regime">
            <div className="flex items-start gap-2 mb-2">
              <Zap className="h-3.5 w-3.5 text-cyan-400 mt-0.5 flex-shrink-0" />
              <div className="text-xs w-full">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-muted-foreground">Regime</span>
                  <Badge
                    data-testid="badge-regime"
                    className={`text-[10px] px-1.5 py-0 font-mono ${
                      data.regime.regime === 'BULLISH'
                        ? 'bg-green-500/20 text-green-400 border-green-500/30'
                        : data.regime.regime === 'BEARISH'
                        ? 'bg-red-500/20 text-red-400 border-red-500/30'
                        : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
                    }`}
                    variant="outline"
                  >
                    {data.regime.regime}
                  </Badge>
                  <Badge
                    data-testid="badge-vol-regime"
                    className="text-[10px] px-1.5 py-0 font-mono bg-slate-500/20 text-slate-300 border-slate-500/30"
                    variant="outline"
                  >
                    {data.regime.volRegime}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] font-mono mb-1">
                  <div>
                    <span className="text-muted-foreground">Long </span>
                    <span className={data.regime.longMultiplier >= 1 ? 'text-green-400' : 'text-red-400'} data-testid="text-long-mult">
                      {data.regime.longMultiplier.toFixed(2)}x
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Short </span>
                    <span className={data.regime.shortMultiplier >= 1 ? 'text-green-400' : 'text-red-400'} data-testid="text-short-mult">
                      {data.regime.shortMultiplier.toFixed(2)}x
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Scale-in </span>
                    <span className={data.regime.scaleInEnabled ? 'text-green-400' : 'text-yellow-400'} data-testid="text-scalein">
                      {data.regime.scaleInEnabled ? data.regime.scaleInDirection : 'OFF'}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Stop </span>
                    <span className="text-orange-400" data-testid="text-portfolio-stop">
                      -{(data.regime.portfolioStopPercent * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {data.metaStats && (
          <div className="pt-2 border-t border-primary/10" data-testid="section-meta-stats">
            <div className="flex items-start gap-2 mb-2">
              <Activity className="h-3.5 w-3.5 text-cyan-400 mt-0.5 flex-shrink-0" />
              <div className="text-xs w-full">
                <div className="text-muted-foreground mb-1">Market Regime ({data.metaStats.coinCount} coins)</div>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10px] text-muted-foreground w-14">MOM Σn</span>
                  <div className="flex-1 h-3 bg-slate-800 rounded-full overflow-hidden relative">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${(data.metaStats.momSumNormalized * 100).toFixed(1)}%`,
                        background: data.metaStats.momSumNormalized > 0.6
                          ? 'linear-gradient(90deg, #22c55e, #4ade80)'
                          : data.metaStats.momSumNormalized < 0.4
                          ? 'linear-gradient(90deg, #ef4444, #f87171)'
                          : 'linear-gradient(90deg, #eab308, #facc15)',
                      }}
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-[9px] font-mono font-bold text-white drop-shadow-md" data-testid="text-mom-normalized">
                        {data.metaStats.momSumNormalized.toFixed(3)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-x-2 gap-y-0.5 text-[9px] font-mono">
                  <div className="text-muted-foreground">MOM</div>
                  <div>Σ <span className={data.metaStats.momSum >= 0 ? 'text-green-400' : 'text-red-400'}>{data.metaStats.momSum.toFixed(2)}%</span></div>
                  <div>μ <span className={data.metaStats.momAvg >= 0 ? 'text-green-400' : 'text-red-400'}>{data.metaStats.momAvg.toFixed(3)}%</span></div>
                  <div><span className="text-green-400">↑{data.metaStats.momMax.toFixed(2)}</span> <span className="text-red-400">↓{data.metaStats.momMin.toFixed(2)}</span></div>
                  <div className="text-muted-foreground">ATR%</div>
                  <div>Σ <span className="text-cyan-400">{data.metaStats.atrSum.toFixed(2)}</span></div>
                  <div>μ <span className="text-cyan-400">{data.metaStats.atrAvg.toFixed(3)}</span></div>
                  <div><span className="text-cyan-300">↑{data.metaStats.atrMax.toFixed(2)}</span> <span className="text-cyan-600">↓{data.metaStats.atrMin.toFixed(2)}</span></div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="pt-2 border-t border-primary/10">
          <div className="flex items-start gap-2">
            <Layers className="h-3.5 w-3.5 text-primary mt-0.5 flex-shrink-0" />
            <div className="text-xs">
              <div className="text-muted-foreground">Basket P&L (TP +1% / SL -1.5%):</div>
              <div className={`font-mono ${data.basket.totalUnrealized >= 0 ? 'text-green-400' : 'text-red-400'}`} data-testid="text-basket-pnl">
                ${data.basket.totalUnrealized.toFixed(2)} ({data.basket.positionCount} positions)
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
