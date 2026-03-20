import http from "http";

import cors from "cors";
import express from "express";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { BelimoBrainAgent } from "./ai/agent";
import { BelimoEngine } from "./belimo-engine";
import { loadSandboxBlueprint, parseBlueprint } from "./blueprint";
import { loadProductsCatalog } from "./catalog";
import { allowedOrigins, env } from "./config";
import {
  closeDatabase,
  createHealthcheck,
  ensureDatabaseReady,
  getDatabaseHealth,
  listActiveOperatorPolicies,
  listRecentDeviceDiagnoses,
  listRecentDeviceObservations,
  listRecentRuntimeFrames,
  listRecentZoneTwinObservations,
} from "./db";
import { BelimoPlatform } from "./platform";
import { RuntimeSocketMessage } from "./runtime-types";
import { SandboxDataGenerationEngine } from "./sandbox/engine";
import { SandboxBuildingGateway } from "./sandbox/gateway";
import { loadDefaultSandboxTruth } from "./sandbox-truth";
import { OpenMeteoWeatherService } from "./sandbox/weather";

const pingSchema = z.object({
  source: z.string().min(1).default("unknown"),
  note: z.string().min(1).default("manual-test"),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const zoneHistoryQuerySchema = historyQuerySchema.extend({
  zoneId: z.string().min(1),
});

const deviceHistoryQuerySchema = historyQuerySchema.extend({
  deviceId: z.string().min(1),
});

const controlSchema = z.object({
  actor: z.string().min(1).default("frontend-ui"),
  sourceModePreference: z.enum(["auto", "ventilation", "cooling", "heating", "economizer"]).optional(),
  occupancyBias: z.number().min(0.4).max(1.6).optional(),
  zoneTemperatureOffsetsC: z.record(z.string(), z.number().min(-3).max(3)).optional(),
  faultOverrides: z
    .record(z.string(), z.enum(["auto", "forced_on", "forced_off"]))
    .optional(),
});

async function bootstrap() {
  await ensureDatabaseReady();

  const productsCatalog = loadProductsCatalog();
  const sandboxBlueprint = loadSandboxBlueprint();
  const sandboxTruth = loadDefaultSandboxTruth();
  const weatherService = new OpenMeteoWeatherService(env.OPEN_METEO_BASE_URL);
  const sandboxEngine = new SandboxDataGenerationEngine(sandboxBlueprint, sandboxTruth, productsCatalog.products, weatherService);
  const sandboxGateway = new SandboxBuildingGateway(sandboxBlueprint, productsCatalog.products, sandboxEngine);
  const belimoEngine = new BelimoEngine(sandboxBlueprint, productsCatalog.products);
  const platform = new BelimoPlatform(
    sandboxBlueprint,
    productsCatalog.products,
    sandboxGateway,
    belimoEngine,
    sandboxEngine.getTickSeconds() * 1000,
  );

  const brainAgent = new BelimoBrainAgent(
    platform,
    env.OPENAI_API_KEY,
    env.OPENAI_MODEL,
    env.OPENAI_REASONING_EFFORT,
    env.BELIMO_BRAIN_ANALYSIS_INTERVAL_TICKS,
  );

  await platform.hydrateFromDatabase();
  await brainAgent.hydrate();
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
    const activePolicies = await listActiveOperatorPolicies(sandboxBlueprint.blueprint_id, 24);

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
        belimoBrain: {
          status: "running",
          model: env.OPENAI_MODEL,
          reasoningEffort: env.OPENAI_REASONING_EFFORT,
          activeAlertCount: brainAgent.getActiveAlerts().length,
          activePolicyCount: activePolicies.length,
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

  app.get("/api/runtime/bootstrap", async (_request, response) => {
    const activePolicies = await listActiveOperatorPolicies(sandboxBlueprint.blueprint_id, 24);

    response.json({
      ok: true,
      payload: platform.getBootstrapPayload(),
      brainAlerts: brainAgent.getActiveAlerts(),
      brainPolicies: activePolicies,
      websocketPath: "/ws",
    });
  });

  app.get("/api/gateway/protocol", (_request, response) => {
    response.json({
      ok: true,
      gateway: platform.getGatewayDescriptor(),
      protocol: platform.getGatewayProtocolDescriptor(),
      latestSnapshot: platform.getLatestGatewaySnapshot(),
    });
  });

  app.post("/api/blueprints/validate", (request, response) => {
    try {
      const blueprint = parseBlueprint(request.body?.blueprint ?? request.body);
      response.status(200).json({
        ok: true,
        blueprint: {
          blueprintId: blueprint.blueprint_id,
          name: blueprint.building.name,
          sourceType: blueprint.source_type,
          floorCount: blueprint.floors.length,
          spaceCount: blueprint.spaces.length,
          deviceCount: blueprint.devices.length,
          airLoopCount: blueprint.systems.air_loops.length,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Blueprint validation failed.";
      response.status(400).json({
        ok: false,
        message,
      });
    }
  });

  app.post("/api/runtime/control", async (request, response) => {
    const payload = controlSchema.parse(request.body ?? {});
    const result = await platform.updateControls(
      {
        sourceModePreference: payload.sourceModePreference,
        occupancyBias: payload.occupancyBias,
        zoneTemperatureOffsetsC: payload.zoneTemperatureOffsetsC,
        faultOverrides: payload.faultOverrides,
      },
      payload.actor,
    );

    response.status(200).json({
      ok: true,
      controls: result.controls,
      manualControls: result.manualControls,
      controlResolution: result.controlResolution,
    });
  });

  app.get("/api/sandbox/status", (_request, response) => {
    response.json({
      ok: true,
      engine: "sandbox-data-generation-engine",
      latest: platform.getLatestSandboxBatch(),
      controls: platform.getControls(),
      manualControls: platform.getManualControls(),
      controlResolution: platform.getControlResolution(),
      availableFaults: platform.getAvailableFaults(),
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

  app.get("/api/runtime/history", async (request, response) => {
    const query = historyQuerySchema.parse(request.query);
    const frames = await listRecentRuntimeFrames(sandboxBlueprint.blueprint_id, query.limit);

    response.json({
      ok: true,
      frames,
      persistenceSummary: platform.getPersistenceSummary(),
    });
  });

  app.get("/api/twin/history/zones", async (request, response) => {
    const query = zoneHistoryQuerySchema.parse(request.query);
    const rows = await listRecentZoneTwinObservations(sandboxBlueprint.blueprint_id, query.zoneId, query.limit);

    response.json({
      ok: true,
      zoneId: query.zoneId,
      observations: rows,
    });
  });

  app.get("/api/twin/history/devices", async (request, response) => {
    const query = deviceHistoryQuerySchema.parse(request.query);
    const rows = await listRecentDeviceDiagnoses(sandboxBlueprint.blueprint_id, query.deviceId, query.limit);

    response.json({
      ok: true,
      deviceId: query.deviceId,
      diagnoses: rows,
    });
  });

  app.get("/api/twin/status", (_request, response) => {
    response.json({
      ok: true,
      engine: "belimo-engine",
      twin: platform.getLatestTwinState(),
      controls: platform.getControls(),
      manualControls: platform.getManualControls(),
      controlResolution: platform.getControlResolution(),
      error: platform.getLastError(),
    });
  });

  const chatSchema = z.object({
    message: z.string().min(1).max(4000),
    conversationId: z.string().nullish(),
  });

  app.post("/api/chat", async (request, response) => {
    try {
      const payload = chatSchema.parse(request.body ?? {});
      const result = await brainAgent.chat(payload.message, payload.conversationId ?? undefined);

      response.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI chat request failed.";
      console.error("Chat endpoint error:", message);

      response.status(500).json({
        ok: false,
        message,
      });
    }
  });

  const sendBrainAlerts = (_request: express.Request, response: express.Response) => {
    response.json({
      ok: true,
      alerts: brainAgent.getActiveAlerts(),
    });
  };

  app.get("/api/brain/alerts", sendBrainAlerts);
  app.get("/api/belimo-brain/alerts", sendBrainAlerts);

  const sendBrainPolicies = async (_request: express.Request, response: express.Response) => {
    response.json({
      ok: true,
      policies: await listActiveOperatorPolicies(sandboxBlueprint.blueprint_id, 24),
    });
  };

  app.get("/api/brain/policies", sendBrainPolicies);
  app.get("/api/belimo-brain/policies", sendBrainPolicies);

  const dismissBrainAlert = async (request: express.Request, response: express.Response) => {
    const alertId = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;

    if (!alertId) {
      response.status(400).json({
        ok: false,
        message: "Missing alert id.",
      });
      return;
    }

    await brainAgent.dismissAlert(alertId);

    response.json({
      ok: true,
    });
  };

  app.post("/api/brain/alerts/:id/dismiss", dismissBrainAlert);
  app.post("/api/belimo-brain/alerts/:id/dismiss", dismissBrainAlert);

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

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  function broadcastSocketMessage(message: RuntimeSocketMessage) {
    const serialized = JSON.stringify(message);

    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(serialized);
      }
    }
  }

  wss.on("connection", (socket, request) => {
    const origin = request.headers.origin;

    if (origin && !allowedOrigins.includes(origin)) {
      socket.send(
        JSON.stringify({
          type: "error",
          payload: {
            message: `Origin ${origin} is not allowed`,
          },
        } satisfies RuntimeSocketMessage),
      );
      socket.close();
      return;
    }

    socket.send(
      JSON.stringify({
        type: "hello",
        payload: platform.getBootstrapPayload(),
      } satisfies RuntimeSocketMessage),
    );

    socket.on("message", (rawMessage) => {
      const message = rawMessage.toString();

      if (message === "ping") {
        socket.send(
          JSON.stringify({
            type: "ack",
            payload: {
              generatedAt: new Date().toISOString(),
              controls: platform.getControls(),
              manualControls: platform.getManualControls(),
              controlResolution: platform.getControlResolution(),
            },
          } satisfies RuntimeSocketMessage),
        );
      }
    });
  });

  const unsubscribeBelimoBrainAlerts = brainAgent.onAlert((alert) => {
    broadcastSocketMessage({
      type: "brain_alert",
      payload: {
        id: alert.id,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        suggestedAction: alert.suggestedAction,
        timestamp: alert.timestamp,
      },
    });
  });

  const unsubscribe = platform.onTick((payload) => {
    broadcastSocketMessage({
      type: "tick",
      payload,
    });

    if (payload.twin) {
      brainAgent.handleTick(payload.twin, payload.controls);
    }
  });

  server.listen(env.PORT, env.HOST, () => {
    console.log(`Belimo Pulse backend listening on http://${env.HOST}:${env.PORT}`);
  });

  const shutdown = async () => {
    unsubscribe();
    unsubscribeBelimoBrainAlerts();
    wss.close();
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
