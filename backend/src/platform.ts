import { createRuntimeControlResolution, resolveRuntimeControlResolution } from "./brain/policy-resolver";
import { BuildingBlueprint } from "./blueprint";
import { ProductDefinition } from "./catalog";
import { applyRuntimeControlInput, cloneRuntimeControlState } from "./control-state";
import {
  getFacilityPreferences,
  getLatestTwinSnapshot,
  getRuntimePersistenceSummary,
  insertControlEvent,
  insertRuntimeArtifacts,
  listActiveOperatorPolicies,
  upsertBlueprintRecord,
  upsertEffectiveControlState,
  upsertFacilityPreferences,
} from "./db";
import { BuildingGatewayAdapter, GatewayDescriptor, GatewayProtocolDescriptor, GatewaySnapshotEnvelope } from "./gateway-protocol";
import {
  RuntimeBootstrapPayload,
  RuntimeControlInput,
  RuntimeControlResolution,
  RuntimeControlState,
  RuntimeFaultDescriptor,
  RuntimePersistenceSummary,
  SandboxTickResult,
  TwinSnapshot,
} from "./runtime-types";

type TickListener = (payload: {
  generatedAt: string;
  twin: TwinSnapshot | null;
  sandbox: SandboxTickResult | null;
  controls: RuntimeControlState;
  manualControls: RuntimeControlState;
  controlResolution: RuntimeControlResolution;
  persistenceSummary: RuntimePersistenceSummary;
}) => void;

export class BelimoPlatform {
  private intervalHandle: NodeJS.Timeout | null = null;

  private isTickRunning = false;

  private latestSandboxBatch: SandboxTickResult | null = null;

  private latestTwinSnapshot: TwinSnapshot | null = null;

  private latestGatewaySnapshot: GatewaySnapshotEnvelope | null = null;

  private lastError: string | null = null;

  private persistenceSummary: RuntimePersistenceSummary = {
    rawWeatherSamples: 0,
    rawDeviceSamples: 0,
    twinSnapshots: 0,
    runtimeFrames: 0,
    zoneTwinSamples: 0,
    deviceDiagnosisSamples: 0,
    lastPersistedObservedAt: null,
  };

  private readonly listeners = new Set<TickListener>();

  private manualControls: RuntimeControlState;

  private controlResolution: RuntimeControlResolution;

  constructor(
    private readonly blueprint: BuildingBlueprint,
    private readonly products: ProductDefinition[],
    private readonly buildingGateway: BuildingGatewayAdapter,
    private readonly belimoEngine: {
      ingest(batch: SandboxTickResult): TwinSnapshot;
    },
    private readonly tickIntervalMs: number,
  ) {
    const initialControls = this.buildingGateway.getControlState();
    this.manualControls = cloneRuntimeControlState(initialControls);
    this.controlResolution = createRuntimeControlResolution(initialControls);
  }

  async start() {
    await upsertBlueprintRecord(this.blueprint);
    await upsertFacilityPreferences(this.blueprint.blueprint_id, this.manualControls);
    await this.refreshEffectiveControls(new Date(), "belimo-brain-scheduler");
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
    return cloneRuntimeControlState(this.controlResolution.effectiveControls);
  }

  getManualControls() {
    return cloneRuntimeControlState(this.manualControls);
  }

  getControlResolution() {
    return {
      ...this.controlResolution,
      manualControls: cloneRuntimeControlState(this.controlResolution.manualControls),
      effectiveControls: cloneRuntimeControlState(this.controlResolution.effectiveControls),
      activePolicies: this.controlResolution.activePolicies.map((policy) => ({
        ...policy,
        appliedControlPaths: [...policy.appliedControlPaths],
      })),
    } satisfies RuntimeControlResolution;
  }

  getAvailableFaults(): RuntimeFaultDescriptor[] {
    return this.buildingGateway.getAvailableFaults();
  }

  getPersistenceSummary() {
    return this.persistenceSummary;
  }

  getGatewayDescriptor(): GatewayDescriptor {
    return this.buildingGateway.getDescriptor();
  }

  getGatewayProtocolDescriptor(): GatewayProtocolDescriptor {
    return this.buildingGateway.getProtocolDescriptor();
  }

  getLatestGatewaySnapshot() {
    return this.latestGatewaySnapshot;
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
      manualControls: this.getManualControls(),
      controlResolution: this.getControlResolution(),
      availableFaults: this.getAvailableFaults(),
      persistenceSummary: this.getPersistenceSummary(),
    };
  }

  onTick(listener: TickListener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async updateControls(input: RuntimeControlInput, actor: string) {
    this.manualControls = applyRuntimeControlInput(this.manualControls, input);
    await upsertFacilityPreferences(this.blueprint.blueprint_id, this.manualControls);
    await this.refreshEffectiveControls(new Date(), actor);
    await insertControlEvent(this.blueprint.blueprint_id, actor, "control_update", {
      input,
      manualControls: this.getManualControls(),
      effectiveControls: this.getControls(),
      activePolicies: this.getControlResolution().activePolicies,
    });

    this.emitTick();
    return {
      controls: this.getControls(),
      manualControls: this.getManualControls(),
      controlResolution: this.getControlResolution(),
    };
  }

  async hydrateFromDatabase() {
    this.latestTwinSnapshot = await getLatestTwinSnapshot(this.blueprint.blueprint_id);
    this.persistenceSummary = await getRuntimePersistenceSummary(this.blueprint.blueprint_id);
    const storedPreferences = await getFacilityPreferences(this.blueprint.blueprint_id, this.manualControls);

    if (storedPreferences) {
      this.manualControls = storedPreferences;
      this.controlResolution = createRuntimeControlResolution(storedPreferences);
    }
  }

  private async runTick() {
    if (this.isTickRunning) {
      return;
    }

    this.isTickRunning = true;

    try {
      const now = new Date();
      await this.refreshEffectiveControls(now, "belimo-brain-scheduler");
      const gatewayPoll = await this.buildingGateway.pollSnapshot(now);
      const batch = gatewayPoll.batch;
      const snapshot = this.belimoEngine.ingest(batch);
      const controls = this.getControls();

      await insertRuntimeArtifacts({ batch, snapshot, controls });

      this.latestSandboxBatch = batch;
      this.latestTwinSnapshot = snapshot;
      this.latestGatewaySnapshot = gatewayPoll.envelope;
      this.persistenceSummary = await getRuntimePersistenceSummary(this.blueprint.blueprint_id);
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
      manualControls: this.getManualControls(),
      controlResolution: this.getControlResolution(),
      persistenceSummary: this.getPersistenceSummary(),
    };

    for (const listener of this.listeners) {
      listener(payload);
    }
  }

  private async refreshEffectiveControls(now: Date, actor: string) {
    const policies = await listActiveOperatorPolicies(this.blueprint.blueprint_id, 64);
    const nextResolution = resolveRuntimeControlResolution({
      blueprint: this.blueprint,
      manualControls: this.manualControls,
      policies,
      now,
    });
    const previousResolution = this.controlResolution;
    const previousSignature = JSON.stringify({
      effectiveControls: previousResolution.effectiveControls,
      activePolicies: previousResolution.activePolicies,
    });
    const nextSignature = JSON.stringify({
      effectiveControls: nextResolution.effectiveControls,
      activePolicies: nextResolution.activePolicies,
    });

    this.controlResolution = nextResolution;
    await this.buildingGateway.applyControl(nextResolution.effectiveControls, actor);
    await upsertEffectiveControlState(this.blueprint.blueprint_id, nextResolution);

    if (previousSignature !== nextSignature) {
      await insertControlEvent(this.blueprint.blueprint_id, actor, "policy_control_resolution", {
        generatedAt: nextResolution.generatedAt,
        manualControls: nextResolution.manualControls,
        effectiveControls: nextResolution.effectiveControls,
        activePolicies: nextResolution.activePolicies,
      });
    }

    return nextResolution;
  }
}
