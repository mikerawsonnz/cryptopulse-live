import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ title = "Something went wrong", message, onRetry }: ErrorStateProps) {
  return (
    <Card className="p-8 border-destructive/30 bg-destructive/5">
      <div className="flex flex-col items-center text-center">
        <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>
        <h3 className="font-display font-semibold text-lg text-destructive mb-2">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground max-w-md mb-4">
          {message}
        </p>
        {onRetry && (
          <Button onClick={onRetry} variant="outline" className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Try Again
          </Button>
        )}
      </div>
    </Card>
  );
}
