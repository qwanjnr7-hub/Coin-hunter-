import express, { type Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { setupTelegramBot } from "./telegram";
import { runAutoSignalGenerator } from "./signals-worker";
import { registerChatRoutes } from "./replit_integrations/chat";
import { registerImageRoutes } from "./replit_integrations/image";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

export function log(message: string, source: string = "express") {
  const time = new Date().toLocaleTimeString('en-US', { 
    hour12: true, 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
  console.log(`${time} [${source}] ${message}`);
}

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

if (!process.env.SKIP_SERVER_START) {
  (async () => {
    registerChatRoutes(app);
    registerImageRoutes(app);

    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      res.status(status).json({ message: err.message || "Internal Server Error" });
    });

    app.listen(5000, "0.0.0.0", async () => {
      log("serving on port 5000");
      try {
        await db.execute(sql`SELECT 1`);
        log("Database connection successful", "db");
      } catch (e) {
        log(`Database connection failed: ${e}`, "db");
      }
      setupTelegramBot();
      runAutoSignalGenerator();
    });
  })();
} else {
  // When SKIP_SERVER_START is set, export routes but do not start the HTTP server
  registerChatRoutes(app);
  registerImageRoutes(app);
}
