import { useMemo } from "react";

interface MiniSparklineProps {
  data: number[];
  isPositive: boolean;
}

export function MiniSparkline({ data, isPositive }: MiniSparklineProps) {
  const pathData = useMemo(() => {
    if (!data || data.length === 0) return "";

    const samples = data.length > 24 ? data.slice(-24) : data;
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const range = max - min || 1;

    const width = 96;
    const height = 48;
    const padding = 2;

    const points = samples.map((value, index) => {
      const x = padding + (index / (samples.length - 1)) * (width - padding * 2);
      const y = height - padding - ((value - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    });

    return `M${points.join(" L")}`;
  }, [data]);

  const gradientId = useMemo(() => `sparkline-${Math.random().toString(36).substr(2, 9)}`, []);
  const strokeColor = isPositive ? "hsl(120 100% 55%)" : "hsl(0 100% 55%)";
  const fillColor = isPositive ? "hsl(120 100% 55%)" : "hsl(0 100% 55%)";

  if (!data || data.length === 0) {
    return <div className="w-full h-full bg-muted/20 rounded animate-pulse" />;
  }

  return (
    <svg
      viewBox="0 0 96 48"
      className="w-full h-full"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={fillColor} stopOpacity="0.3" />
          <stop offset="100%" stopColor={fillColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={pathData}
        fill="none"
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="drop-shadow-sm"
        style={{
          filter: `drop-shadow(0 0 4px ${strokeColor})`,
        }}
      />
      <path
        d={`${pathData} L96,48 L0,48 Z`}
        fill={`url(#${gradientId})`}
      />
    </svg>
  );
}
