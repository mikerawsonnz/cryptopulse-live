import { Card } from "@/components/ui/card";

export function CryptoCardSkeleton() {
  return (
    <Card className="p-4 border-border/50 bg-card/50 animate-pulse">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-full bg-muted" />
        <div className="flex-1">
          <div className="h-5 bg-muted rounded w-24 mb-1" />
          <div className="h-3 bg-muted rounded w-12" />
        </div>
        <div className="h-5 w-16 bg-muted rounded-full" />
      </div>
      <div className="space-y-3">
        <div className="flex justify-between items-end">
          <div>
            <div className="h-8 bg-muted rounded w-28 mb-1" />
            <div className="h-4 bg-muted rounded w-16" />
          </div>
          <div className="h-12 w-24 bg-muted rounded" />
        </div>
        <div className="grid grid-cols-2 gap-2 pt-3 border-t border-border/30">
          <div>
            <div className="h-3 bg-muted rounded w-16 mb-1" />
            <div className="h-4 bg-muted rounded w-20" />
          </div>
          <div>
            <div className="h-3 bg-muted rounded w-16 mb-1" />
            <div className="h-4 bg-muted rounded w-20" />
          </div>
        </div>
        <div className="pt-2">
          <div className="flex justify-between mb-1">
            <div className="h-3 bg-muted rounded w-20" />
            <div className="h-3 bg-muted rounded w-8" />
          </div>
          <div className="h-1.5 bg-muted rounded-full" />
        </div>
      </div>
    </Card>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="p-4 bg-card/50 border-border/30 animate-pulse">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-4 w-4 bg-muted rounded" />
              <div className="h-3 bg-muted rounded w-20" />
            </div>
            <div className="h-6 bg-muted rounded w-24" />
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
          <CryptoCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
