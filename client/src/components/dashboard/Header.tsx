import { Activity, Wifi, WifiOff, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface HeaderProps {
  isConnected: boolean;
  lastUpdated: string | null;
}

export function Header({ isConnected, lastUpdated }: HeaderProps) {
  const formatTime = (timestamp: string | null) => {
    if (!timestamp) return "—";
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  };

  return (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
      <div className="container mx-auto px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="h-10 w-10 rounded-md bg-gradient-to-br from-primary to-accent flex items-center justify-center glow-cyan">
                <Zap className="h-6 w-6 text-primary-foreground" />
              </div>
              <div className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-neon-green pulse-green" />
            </div>
            <div>
              <h1 className="font-display text-xl font-bold tracking-wider text-glow-cyan" data-testid="text-app-title">
                CRYPTOPULSE
              </h1>
              <p className="text-xs text-muted-foreground font-mono tracking-wide">
                LIVE SENTIMENT TRACKER
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md bg-card/50 border border-border/50">
              <Activity className="h-4 w-4 text-primary animate-glow-pulse" />
              <span className="text-xs font-mono text-muted-foreground">
                LAST UPDATE: <span className="text-foreground">{formatTime(lastUpdated)}</span>
              </span>
            </div>

            <Badge
              variant={isConnected ? "default" : "destructive"}
              className={`gap-1.5 font-mono text-xs ${
                isConnected ? "bg-neon-green/20 text-neon-green border-neon-green/50" : ""
              }`}
              data-testid="badge-connection-status"
            >
              {isConnected ? (
                <>
                  <Wifi className="h-3 w-3" />
                  LIVE
                </>
              ) : (
                <>
                  <WifiOff className="h-3 w-3" />
                  OFFLINE
                </>
              )}
            </Badge>
          </div>
        </div>
      </div>
    </header>
  );
}
