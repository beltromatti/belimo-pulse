import { BuildingBlueprint } from "./blueprint";
import { ProductDefinition } from "./catalog";
import {
  getLatestTwinSnapshot,
  insertDeviceObservations,
  insertTwinSnapshot,
  insertWeatherObservation,
  upsertBlueprintRecord,
} from "./db";
import { SandboxTickResult, TwinSnapshot } from "./runtime-types";
import { SandboxDataGenerationEngine } from "./sandbox/engine";

export class BelimoPlatform {
  private intervalHandle: NodeJS.Timeout | null = null;

  private isTickRunning = false;

  private latestSandboxBatch: SandboxTickResult | null = null;

  private latestTwinSnapshot: TwinSnapshot | null = null;

  private lastError: string | null = null;

  constructor(
    private readonly blueprint: BuildingBlueprint,
    private readonly products: ProductDefinition[],
    private readonly sandboxEngine: SandboxDataGenerationEngine,
    private readonly belimoEngine: {
      ingest(batch: SandboxTickResult): TwinSnapshot;
    },
    private readonly tickIntervalMs: number,
  ) {}

  async start() {
    await upsertBlueprintRecord(this.blueprint);
    await this.runTick();
    this.intervalHandle = setInterval(() => void this.runTick(), this.tickIntervalMs);
  }

  async stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  getProducts() {
    return this.products;
  }

  getBlueprint() {
    return this.blueprint;
  }

  getLatestSandboxBatch() {
    return this.latestSandboxBatch;
  }

  getLatestTwinState() {
    return this.latestTwinSnapshot;
  }

  getLastError() {
    return this.lastError;
  }

  getTickIntervalMs() {
    return this.tickIntervalMs;
  }

  async hydrateFromDatabase() {
    this.latestTwinSnapshot = await getLatestTwinSnapshot(this.blueprint.blueprint_id);
  }

  private async runTick() {
    if (this.isTickRunning) {
      return;
    }

    this.isTickRunning = true;

    try {
      const batch = await this.sandboxEngine.tick();
      const snapshot = this.belimoEngine.ingest(batch);

      await insertWeatherObservation(batch.buildingId, batch.observedAt, batch.weather);
      await insertDeviceObservations(batch.buildingId, batch.observedAt, "sandbox", batch.deviceReadings);
      await insertTwinSnapshot(snapshot);

      this.latestSandboxBatch = batch;
      this.latestTwinSnapshot = snapshot;
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Unknown sandbox runtime error";
      console.error("Belimo platform tick failed", error);
    } finally {
      this.isTickRunning = false;
    }
  }
}
