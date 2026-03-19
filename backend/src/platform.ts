import { BuildingBlueprint } from "./blueprint";
import { ProductDefinition } from "./catalog";
import {
  getLatestTwinSnapshot,
  insertControlEvent,
  insertDeviceObservations,
  insertTwinSnapshot,
  insertWeatherObservation,
  upsertBlueprintRecord,
  upsertFacilityPreferences,
} from "./db";
import {
  RuntimeBootstrapPayload,
  RuntimeControlInput,
  RuntimeControlState,
  RuntimeFaultDescriptor,
  SandboxTickResult,
  TwinSnapshot,
} from "./runtime-types";
import { SandboxDataGenerationEngine } from "./sandbox/engine";

type TickListener = (payload: {
  generatedAt: string;
  twin: TwinSnapshot | null;
  sandbox: SandboxTickResult | null;
  controls: RuntimeControlState;
}) => void;

export class BelimoPlatform {
  private intervalHandle: NodeJS.Timeout | null = null;

  private isTickRunning = false;

  private latestSandboxBatch: SandboxTickResult | null = null;

  private latestTwinSnapshot: TwinSnapshot | null = null;

  private lastError: string | null = null;

  private readonly listeners = new Set<TickListener>();

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
    await upsertFacilityPreferences(this.blueprint.blueprint_id, this.sandboxEngine.getControlState());
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

  getControls() {
    return this.sandboxEngine.getControlState();
  }

  getAvailableFaults(): RuntimeFaultDescriptor[] {
    return this.sandboxEngine.getAvailableFaults();
  }

  getBootstrapPayload(): RuntimeBootstrapPayload {
    return {
      buildingId: this.blueprint.blueprint_id,
      generatedAt: new Date().toISOString(),
      blueprint: this.blueprint,
      products: this.products,
      latestSandboxBatch: this.latestSandboxBatch,
      latestTwinSnapshot: this.latestTwinSnapshot,
      controls: this.getControls(),
      availableFaults: this.getAvailableFaults(),
    };
  }

  onTick(listener: TickListener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async updateControls(input: RuntimeControlInput, actor: string) {
    const controls = this.sandboxEngine.updateControls(input);
    await upsertFacilityPreferences(this.blueprint.blueprint_id, controls);
    await insertControlEvent(this.blueprint.blueprint_id, actor, "control_update", {
      input,
      resultingControls: controls,
    });

    this.emitTick();
    return controls;
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
      this.emitTick();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Unknown sandbox runtime error";
      console.error("Belimo platform tick failed", error);
      this.emitTick();
    } finally {
      this.isTickRunning = false;
    }
  }

  private emitTick() {
    const payload = {
      generatedAt: new Date().toISOString(),
      twin: this.latestTwinSnapshot,
      sandbox: this.latestSandboxBatch,
      controls: this.getControls(),
    };

    for (const listener of this.listeners) {
      listener(payload);
    }
  }
}
