import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { appendFileSync } from "node:fs";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

const VERBOSE_ENDPOINTS = new Set([
  '/api/trade-history', '/api/predictions', '/api/portfolio',
  '/api/equity-curve', '/api/cryptos', '/api/signals'
]);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

function writeCrash(msg: string) {
  try { appendFileSync('/tmp/crash.log', msg + '\n'); } catch {}
  console.error(msg);
}

process.on('uncaughtException', (err) => {
  writeCrash(`[CRASH] uncaughtException at ${new Date().toISOString()}: ${err.stack || err.message || err}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
  writeCrash(`[CRASH] unhandledRejection at ${new Date().toISOString()}: ${reason?.stack || reason?.message || reason}`);
});

for (const sig of ['SIGTERM', 'SIGINT', 'SIGQUIT'] as const) {
  process.on(sig, () => {
    writeCrash(`[SHUTDOWN] Received ${sig} at ${new Date().toISOString()}`);
    process.exit(128);
  });
}

process.on('SIGHUP', () => {
  const mem = process.memoryUsage();
  console.log(`[SIGHUP] Ignoring at ${new Date().toISOString()} rss=${Math.round(mem.rss/1024/1024)}MB heap=${Math.round(mem.heapUsed/1024/1024)}/${Math.round(mem.heapTotal/1024/1024)}MB`);
});

process.on('exit', (code) => {
  const mem = process.memoryUsage();
  writeCrash(`[EXIT] code=${code} at ${new Date().toISOString()} rss=${Math.round(mem.rss/1024/1024)}MB heap=${Math.round(mem.heapUsed/1024/1024)}/${Math.round(mem.heapTotal/1024/1024)}MB`);
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
