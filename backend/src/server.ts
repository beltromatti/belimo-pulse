import cors from "cors";
import express from "express";
import { z } from "zod";

import { BelimoEngine } from "./belimo-engine";
import { loadSandboxBlueprint } from "./blueprint";
import { loadProductsCatalog } from "./catalog";
import { allowedOrigins, env } from "./config";
import {
  closeDatabase,
  createHealthcheck,
  ensureDatabaseReady,
  getDatabaseHealth,
  listRecentDeviceObservations,
} from "./db";
import { BelimoPlatform } from "./platform";
import { SandboxDataGenerationEngine } from "./sandbox/engine";
import { loadDefaultSandboxTruth } from "./sandbox-truth";
import { OpenMeteoWeatherService } from "./sandbox/weather";

const pingSchema = z.object({
  source: z.string().min(1).default("unknown"),
  note: z.string().min(1).default("manual-test"),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

async function bootstrap() {
  await ensureDatabaseReady();

  const productsCatalog = loadProductsCatalog();
  const sandboxBlueprint = loadSandboxBlueprint();
  const sandboxTruth = loadDefaultSandboxTruth();
  const weatherService = new OpenMeteoWeatherService(env.OPEN_METEO_BASE_URL);
  const sandboxEngine = new SandboxDataGenerationEngine(sandboxBlueprint, sandboxTruth, productsCatalog.products, weatherService);
  const belimoEngine = new BelimoEngine(sandboxBlueprint, productsCatalog.products);
  const platform = new BelimoPlatform(
    sandboxBlueprint,
    productsCatalog.products,
    sandboxEngine,
    belimoEngine,
    sandboxEngine.getTickSeconds() * 1000,
  );

  await platform.hydrateFromDatabase();
  await platform.start();

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
    const sandbox = platform.getLatestSandboxBatch();
    const twin = platform.getLatestTwinState();

    response.json({
      ok: true,
      service: "belimo-pulse-backend",
      environment: env.NODE_ENV,
      database,
      engines: {
        sandboxDataGenerationEngine: {
          status: sandbox ? "running" : "starting",
          tickSeconds: platform.getTickIntervalMs() / 1000,
          lastObservedAt: sandbox?.observedAt ?? null,
        },
        belimoEngine: {
          status: twin ? "running" : "starting",
          lastObservedAt: twin?.observedAt ?? null,
          lastError: platform.getLastError(),
        },
      },
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

  app.get("/api/catalog/products", (_request, response) => {
    response.json({
      ok: true,
      catalogVersion: productsCatalog.catalog_version,
      products: platform.getProducts(),
    });
  });

  app.get("/api/blueprints/sandbox", (_request, response) => {
    response.json({
      ok: true,
      blueprint: platform.getBlueprint(),
    });
  });

  app.get("/api/sandbox/status", (_request, response) => {
    response.json({
      ok: true,
      engine: "sandbox-data-generation-engine",
      latest: platform.getLatestSandboxBatch(),
      error: platform.getLastError(),
    });
  });

  app.get("/api/sandbox/telemetry", async (request, response) => {
    const query = historyQuerySchema.parse(request.query);
    const rows = await listRecentDeviceObservations(sandboxBlueprint.blueprint_id, query.limit);

    response.json({
      ok: true,
      observations: rows,
    });
  });

  app.get("/api/twin/status", (_request, response) => {
    response.json({
      ok: true,
      engine: "belimo-engine",
      twin: platform.getLatestTwinState(),
      error: platform.getLastError(),
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
    await platform.stop();
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
