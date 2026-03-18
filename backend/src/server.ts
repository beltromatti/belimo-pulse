import cors from "cors";
import express from "express";
import { z } from "zod";

import { allowedOrigins, env } from "./config";
import { closeDatabase, createHealthcheck, ensureDatabaseReady, getDatabaseHealth } from "./db";

const pingSchema = z.object({
  source: z.string().min(1).default("unknown"),
  note: z.string().min(1).default("manual-test"),
});

async function bootstrap() {
  await ensureDatabaseReady();

  const app = express();

  app.use(express.json());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`Origin ${origin} is not allowed`));
      },
    }),
  );

  app.get("/health", async (_request, response) => {
    const database = await getDatabaseHealth();

    response.json({
      ok: true,
      service: "belimo-pulse-backend",
      environment: env.NODE_ENV,
      database,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/ping", (_request, response) => {
    response.json({
      ok: true,
      message: "Belimo Pulse backend is online.",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/db/health", async (_request, response) => {
    const database = await getDatabaseHealth();

    response.json({
      ok: true,
      database,
    });
  });

  app.post("/api/db/ping", async (request, response) => {
    const payload = pingSchema.parse(request.body ?? {});
    const created = await createHealthcheck(payload.source, payload.note);

    response.status(201).json({
      ok: true,
      created,
    });
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({
        ok: false,
        message: "Invalid request payload.",
        issues: error.flatten(),
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Unexpected server error.";
    response.status(500).json({
      ok: false,
      message,
    });
  });

  const server = app.listen(env.PORT, env.HOST, () => {
    console.log(`Belimo Pulse backend listening on http://${env.HOST}:${env.PORT}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch((error) => {
  console.error("Failed to start backend", error);
  process.exit(1);
});
