import {
  AutomaticRemediationState,
  decideAutomaticRemediation,
  deriveAutomaticIssueKey,
  shouldClearAutomaticRemediationState,
} from "./automatic-remediation";
import { createRuntimeControlResolution, resolveRuntimeControlResolution } from "./brain/policy-resolver";
import { BuildingBlueprint } from "./blueprint";
import { BelimoEngine } from "./belimo-engine";
import { ProductDefinition } from "./catalog";
import {
  assessRuntimeDrift,
  buildAssistPlanFromAssessment,
  refineAssistPlanFromOutcome,
  scoreTwinSnapshotAgainstControls,
} from "./control-intelligence";
import { applyRuntimeControlInput, cloneRuntimeControlState } from "./control-state";
import {
  cleanupHistoricalRuntimeData,
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
  RuntimeSimulationPreview,
  SandboxTickResult,
  TwinSnapshot,
} from "./runtime-types";
import { SandboxDataGenerationEngine } from "./sandbox/engine";
import { SandboxAssistPlan } from "./sandbox/model";

type TickListener = (payload: {
  generatedAt: string;
  twin: TwinSnapshot | null;
  sandbox: SandboxTickResult | null;
  controls: RuntimeControlState;
  manualControls: RuntimeControlState;
  controlResolution: RuntimeControlResolution;
  persistenceSummary: RuntimePersistenceSummary;
}) => void;

type SimulationPreviewListener = (preview: RuntimeSimulationPreview) => void;

type RecentRuntimeSnapshot = {
  observedAt: string;
  twin: TwinSnapshot;
  sandbox: SandboxTickResult;
};

export class BelimoPlatform {
  private schedulerHandle: NodeJS.Timeout | null = null;

  private databaseMaintenanceHandle: NodeJS.Timeout | null = null;

  private schedulerActive = false;

  private isTickRunning = false;

  private isDatabaseMaintenanceRunning = false;

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

  private readonly simulationPreviewListeners = new Set<SimulationPreviewListener>();

  private readonly defaultManualControls: RuntimeControlState;

  private manualControls: RuntimeControlState;

  private controlResolution: RuntimeControlResolution;

  private latestSimulationPreview: RuntimeSimulationPreview | null = null;

  private readonly automaticRemediationStates = new Map<string, AutomaticRemediationState>();

  private readonly recentSnapshots: RecentRuntimeSnapshot[] = [];

  private virtualClockMs: number | null = null;

  private lastDashboardInteractionAtMs: number | null = null;

  constructor(
    private readonly blueprint: BuildingBlueprint,
    private readonly products: ProductDefinition[],
    private readonly buildingGateway: BuildingGatewayAdapter,
    private readonly belimoEngine: {
      ingest(batch: SandboxTickResult): TwinSnapshot;
    },
    private readonly sandboxEngine: SandboxDataGenerationEngine,
    private readonly baseTickIntervalMs: number,
    private readonly databaseRetentionDays: number,
    private readonly databaseMaintenanceIntervalMs: number,
    private readonly dashboardIdleResetMs: number,
  ) {
    const initialControls = this.buildingGateway.getControlState();
    this.defaultManualControls = cloneRuntimeControlState(initialControls);
    this.manualControls = cloneRuntimeControlState(initialControls);
    this.controlResolution = createRuntimeControlResolution(initialControls);
  }

  async start() {
    this.schedulerActive = true;
    await upsertBlueprintRecord(this.blueprint);
    await upsertFacilityPreferences(this.blueprint.blueprint_id, this.manualControls);
    await this.refreshEffectiveControls(this.peekRuntimeNow(), "belimo-brain-scheduler");
    this.scheduleDatabaseMaintenance(30_000);
    await this.runTick();
  }

  async stop() {
    this.schedulerActive = false;
    if (this.schedulerHandle) {
      clearTimeout(this.schedulerHandle);
      this.schedulerHandle = null;
    }
    if (this.databaseMaintenanceHandle) {
      clearTimeout(this.databaseMaintenanceHandle);
      this.databaseMaintenanceHandle = null;
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
    return this.computeTickIntervalMs();
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
      latestSimulationPreview: this.latestSimulationPreview,
    };
  }

  onTick(listener: TickListener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  onSimulationPreview(listener: SimulationPreviewListener) {
    this.simulationPreviewListeners.add(listener);

    return () => {
      this.simulationPreviewListeners.delete(listener);
    };
  }

  async updateControls(
    input: RuntimeControlInput,
    actor: string,
    options?: {
      triggerSimulationPreview?: boolean;
    },
  ) {
    const previousManualControls = this.manualControls;
    this.manualControls = applyRuntimeControlInput(this.manualControls, input);
    this.lastDashboardInteractionAtMs = Date.now();
    this.syncRuntimeClockMode(previousManualControls, this.manualControls);
    if (options?.triggerSimulationPreview !== false) {
      this.automaticRemediationStates.clear();
    }
    await upsertFacilityPreferences(this.blueprint.blueprint_id, this.manualControls);
    await this.refreshEffectiveControls(this.peekRuntimeNow(), actor);
    this.scheduleNextTick();
    await insertControlEvent(this.blueprint.blueprint_id, actor, "control_update", {
      input,
      manualControls: this.getManualControls(),
      effectiveControls: this.getControls(),
      activePolicies: this.getControlResolution().activePolicies,
    });
    const simulationPreview =
      options?.triggerSimulationPreview === false
        ? null
        : await this.generateSimulationPreview("facility_manual_change", this.peekRuntimeNow());

    this.emitTick();
    return {
      controls: this.getControls(),
      manualControls: this.getManualControls(),
      controlResolution: this.getControlResolution(),
      simulationPreview,
    };
  }

  async hydrateFromDatabase() {
    this.latestTwinSnapshot = await getLatestTwinSnapshot(this.blueprint.blueprint_id);
    this.persistenceSummary = await getRuntimePersistenceSummary(this.blueprint.blueprint_id);
    const storedPreferences = await getFacilityPreferences(this.blueprint.blueprint_id, this.defaultManualControls);

    if (storedPreferences) {
      const previousManualControls = this.manualControls;
      this.manualControls = storedPreferences.preferences;
      this.controlResolution = createRuntimeControlResolution(storedPreferences.preferences);
      this.syncRuntimeClockMode(previousManualControls, this.manualControls);
      const updatedAtMs = Date.parse(storedPreferences.updatedAt);
      this.lastDashboardInteractionAtMs = Number.isNaN(updatedAtMs) ? null : updatedAtMs;
    }

    if (this.shouldResetDashboardToDefaults(Date.now())) {
      this.applyDefaultManualControls();
      this.lastDashboardInteractionAtMs = Date.now();
    }

    if (this.latestTwinSnapshot?.observedAt) {
      this.virtualClockMs = new Date(this.latestTwinSnapshot.observedAt).getTime();
    }
  }

  private async runTick() {
    if (this.isTickRunning) {
      return;
    }

    this.isTickRunning = true;

    try {
      const now = this.getRuntimeNow();
      await this.maybeResetDashboardToDefaults(now);
      await this.refreshEffectiveControls(now, "belimo-brain-scheduler");
      const gatewayPoll = await this.buildingGateway.pollSnapshot(now);
      const batch = gatewayPoll.batch;
      const snapshot = this.belimoEngine.ingest(batch);
      const controls = this.getControls();

      await insertRuntimeArtifacts({ batch, snapshot, controls });

      this.latestSandboxBatch = batch;
      this.latestTwinSnapshot = snapshot;
      this.latestGatewaySnapshot = gatewayPoll.envelope;
      this.recentSnapshots.push({
        observedAt: snapshot.observedAt,
        twin: snapshot,
        sandbox: batch,
      });
      this.pruneRecentSnapshots();
      this.persistenceSummary = await getRuntimePersistenceSummary(this.blueprint.blueprint_id);
      await this.maybeGenerateAutomaticPreview(now);
      this.lastError = null;
      this.emitTick();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Unknown sandbox runtime error";
      console.error("Belimo platform tick failed", error);
      this.emitTick();
    } finally {
      this.isTickRunning = false;
      this.scheduleNextTick();
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

  private computeTickIntervalMs() {
    if (this.manualControls.timeMode !== "virtual") {
      return this.baseTickIntervalMs;
    }

    return Math.max(250, Math.round(this.baseTickIntervalMs / this.manualControls.timeSpeedMultiplier));
  }

  private controlStateSignature(state: RuntimeControlState) {
    return JSON.stringify(state);
  }

  private isManualControlsAtDefaults() {
    return this.controlStateSignature(this.manualControls) === this.controlStateSignature(this.defaultManualControls);
  }

  private shouldResetDashboardToDefaults(nowMs: number) {
    return (
      !this.isManualControlsAtDefaults() &&
      this.lastDashboardInteractionAtMs !== null &&
      nowMs - this.lastDashboardInteractionAtMs >= this.dashboardIdleResetMs
    );
  }

  private applyDefaultManualControls() {
    const previousManualControls = this.manualControls;
    this.manualControls = cloneRuntimeControlState(this.defaultManualControls);
    this.controlResolution = createRuntimeControlResolution(this.manualControls);
    this.syncRuntimeClockMode(previousManualControls, this.manualControls);
    this.latestSimulationPreview = null;
    this.automaticRemediationStates.clear();
  }

  private async maybeResetDashboardToDefaults(now: Date) {
    const nowMs = now.getTime();

    if (!this.shouldResetDashboardToDefaults(nowMs)) {
      return false;
    }

    const previousManualControls = this.getManualControls();
    const idleMinutes = this.lastDashboardInteractionAtMs
      ? Math.max(1, Math.round((nowMs - this.lastDashboardInteractionAtMs) / 60_000))
      : null;

    this.applyDefaultManualControls();
    this.lastDashboardInteractionAtMs = nowMs;
    await upsertFacilityPreferences(this.blueprint.blueprint_id, this.manualControls);
    await insertControlEvent(this.blueprint.blueprint_id, "dashboard-idle-reset", "dashboard_idle_reset", {
      idleMinutes,
      previousManualControls,
      resetManualControls: this.getManualControls(),
    });

    return true;
  }

  private scheduleNextTick() {
    if (!this.schedulerActive) {
      return;
    }

    if (this.schedulerHandle) {
      clearTimeout(this.schedulerHandle);
      this.schedulerHandle = null;
    }

    this.schedulerHandle = setTimeout(() => void this.runTick(), this.computeTickIntervalMs());
  }

  private scheduleDatabaseMaintenance(delayMs = this.databaseMaintenanceIntervalMs) {
    if (!this.schedulerActive) {
      return;
    }

    if (this.databaseMaintenanceHandle) {
      clearTimeout(this.databaseMaintenanceHandle);
      this.databaseMaintenanceHandle = null;
    }

    this.databaseMaintenanceHandle = setTimeout(() => void this.runDatabaseMaintenance(), delayMs);
  }

  private async runDatabaseMaintenance() {
    if (!this.schedulerActive || this.isDatabaseMaintenanceRunning) {
      return;
    }

    this.isDatabaseMaintenanceRunning = true;

    try {
      const result = await cleanupHistoricalRuntimeData(this.databaseRetentionDays);

      if (result.totalDeleted > 0) {
        console.info(
          `Belimo platform database retention removed ${result.totalDeleted} rows older than ${result.retentionDays} days.`,
          result.deleted,
        );
      }
    } catch (error) {
      console.error("Belimo platform database retention cleanup failed", error);
    } finally {
      this.isDatabaseMaintenanceRunning = false;
      this.scheduleDatabaseMaintenance();
    }
  }

  private getRuntimeNow() {
    if (this.manualControls.timeMode !== "virtual") {
      const liveNow = new Date();
      this.virtualClockMs = liveNow.getTime();
      return liveNow;
    }

    if (this.virtualClockMs === null) {
      this.virtualClockMs = this.latestTwinSnapshot?.observedAt
        ? new Date(this.latestTwinSnapshot.observedAt).getTime()
        : Date.now();
    }

    const runtimeNow = new Date(this.virtualClockMs);
    this.virtualClockMs += this.sandboxEngine.getTickSeconds() * 1000;
    return runtimeNow;
  }

  private peekRuntimeNow() {
    if (this.manualControls.timeMode !== "virtual") {
      return new Date();
    }

    if (this.virtualClockMs === null) {
      this.virtualClockMs = this.latestTwinSnapshot?.observedAt
        ? new Date(this.latestTwinSnapshot.observedAt).getTime()
        : Date.now();
    }

    return new Date(this.virtualClockMs);
  }

  private syncRuntimeClockMode(previous: RuntimeControlState, next: RuntimeControlState) {
    if (previous.timeMode === next.timeMode && previous.timeSpeedMultiplier === next.timeSpeedMultiplier) {
      return;
    }

    if (next.timeMode === "live") {
      this.virtualClockMs = Date.now();
      return;
    }

    this.virtualClockMs = this.latestTwinSnapshot?.observedAt
      ? new Date(this.latestTwinSnapshot.observedAt).getTime()
      : Date.now();
  }

  private emitSimulationPreview(preview: RuntimeSimulationPreview) {
    for (const listener of this.simulationPreviewListeners) {
      listener(preview);
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

  private async maybeGenerateAutomaticPreview(now: Date) {
    if (!this.latestTwinSnapshot || !this.latestSandboxBatch) {
      return;
    }

    const runtimeSeconds = this.latestSandboxBatch.operationalState.runtimeSeconds;
    const activeFaultIds = this.latestSandboxBatch.operationalState.activeFaults.map((fault) => fault.id).sort();
    const assessment = assessRuntimeDrift({
      blueprint: this.blueprint,
      controls: this.getControls(),
      currentSnapshot: this.latestTwinSnapshot,
      recentSnapshots: this.recentSnapshots.map((snapshot) => ({
        observedAt: snapshot.observedAt,
        zones: snapshot.twin.zones,
      })),
      activeFaultIds,
    });
    this.pruneAutomaticRemediationStates(runtimeSeconds, assessment, activeFaultIds);

    if (!assessment.trigger) {
      return;
    }

    const issueKey = deriveAutomaticIssueKey(assessment, activeFaultIds);
    const decision = decideAutomaticRemediation({
      assessment,
      runtimeSeconds,
      activeFaultIds,
      existing: this.automaticRemediationStates.get(issueKey) ?? null,
    });

    if (decision.action !== "apply") {
      return;
    }

    const preview = await this.generateSimulationPreview(assessment.trigger, now, assessment);

    if (!preview) {
      return;
    }

    if (assessment.trigger === "comfort_drift") {
      for (const key of this.automaticRemediationStates.keys()) {
        if (key.startsWith("comfort:") && key !== issueKey) {
          this.automaticRemediationStates.delete(key);
        }
      }
    }

    this.automaticRemediationStates.set(issueKey, decision.nextState);
  }

  private async generateSimulationPreview(
    trigger: "facility_manual_change" | "fault_detected" | "comfort_drift",
    now: Date,
    precomputedAssessment = this.latestTwinSnapshot
      ? assessRuntimeDrift({
          blueprint: this.blueprint,
          controls: this.getControls(),
          currentSnapshot: this.latestTwinSnapshot,
          recentSnapshots: this.recentSnapshots.map((snapshot) => ({
            observedAt: snapshot.observedAt,
            zones: snapshot.twin.zones,
          })),
          activeFaultIds: this.latestSandboxBatch?.operationalState.activeFaults.map((fault) => fault.id).sort() ?? [],
        })
      : null,
  ) {
    if (!this.latestSandboxBatch || !this.latestTwinSnapshot) {
      return null;
    }

    const assessment =
      precomputedAssessment ??
      assessRuntimeDrift({
        blueprint: this.blueprint,
        controls: this.getControls(),
        currentSnapshot: this.latestTwinSnapshot,
        recentSnapshots: this.recentSnapshots.map((snapshot) => ({
          observedAt: snapshot.observedAt,
          zones: snapshot.twin.zones,
        })),
        activeFaultIds: this.latestSandboxBatch.operationalState.activeFaults.map((fault) => fault.id).sort(),
      });
    const horizonMinutes =
      trigger === "facility_manual_change"
        ? Math.max(20, Math.min(30, assessment.horizonMinutes))
        : Math.max(trigger === "fault_detected" ? 30 : 15, assessment.horizonMinutes);
    const accelerationFactor = 100;
    const playbackDurationMs = Math.round((horizonMinutes * 60 * 1000) / accelerationFactor);
    const runtimeSeconds = this.latestSandboxBatch.operationalState.runtimeSeconds;
    const basePlan = buildAssistPlanFromAssessment({
      assessment,
      currentSnapshot: this.latestTwinSnapshot,
      runtimeSeconds,
      horizonMinutes,
    });
    const candidatePlans = this.buildCandidatePlans(basePlan, trigger);
    const evaluations = [];

    for (const candidatePlan of candidatePlans) {
      evaluations.push(await this.simulateAssistPlan(candidatePlan, now, horizonMinutes));
    }

    let bestEvaluation = evaluations.reduce((best, current) =>
      current.score.totalScore < best.score.totalScore ? current : best,
    );

    if (bestEvaluation.score.worstZoneScore > 0.72 && bestEvaluation.plan) {
      for (let iteration = 0; iteration < 2; iteration += 1) {
        const previousPlan = bestEvaluation.plan!;
        const refinedPlan = refineAssistPlanFromOutcome({
          blueprint: this.blueprint,
          controls: this.getControls(),
          currentSnapshot: this.latestTwinSnapshot,
          outcomeSnapshot: bestEvaluation.finalTwin,
          previousPlan,
          runtimeSeconds,
          horizonMinutes,
        });
        const refinedEvaluation = await this.simulateAssistPlan(refinedPlan, now, horizonMinutes);

        if (refinedEvaluation.score.totalScore >= bestEvaluation.score.totalScore) {
          break;
        }

        bestEvaluation = refinedEvaluation;
      }
    }

    this.sandboxEngine.setAssistPlan(bestEvaluation.plan);
    const frames = [
      {
        simulatedMinute: 0,
        twin: this.latestTwinSnapshot,
        sandbox: this.latestSandboxBatch,
      },
      ...bestEvaluation.frames,
    ];
    const lastBatch = bestEvaluation.finalBatch;
    const lastTwin = bestEvaluation.finalTwin;

    const sourceTelemetry = lastBatch.deviceReadings.find((reading) => reading.deviceId === "rtu-1")?.telemetry ?? {};
    const plan = {
      sourceMode: String(sourceTelemetry.operating_mode ?? "ventilation") as RuntimeSimulationPreview["plan"]["sourceMode"],
      supplyTemperatureSetpointC: Number(sourceTelemetry.supply_air_temperature_c ?? lastTwin.summary.supplyTemperatureC),
      supplyFanSpeedPct: Math.round(
        ((Number(sourceTelemetry.supply_airflow_m3_h ?? 0) /
          Math.max(Number(sourceTelemetry.design_supply_airflow_m3_h ?? 1), 1)) *
          100) || 0,
      ),
      outdoorAirFraction: Number(sourceTelemetry.outdoor_air_fraction ?? 0.2),
      zoneDamperTargetsPct: Object.fromEntries(
        lastBatch.deviceReadings
          .filter((reading) => reading.category === "actuator")
          .map((reading) => [
            reading.deviceId,
            Number(
              reading.telemetry["setpoint_position_%"] ??
                reading.telemetry.commanded_position_pct ??
                reading.telemetry.damper_position_pct ??
                0,
            ),
          ]),
      ),
    };
    const preview: RuntimeSimulationPreview = {
      id: `${trigger}-${now.getTime()}`,
      generatedAt: now.toISOString(),
      trigger,
      summary:
        trigger === "facility_manual_change"
          ? "Previewing the next stabilized response before committing the operator request to the live sandbox."
          : trigger === "fault_detected"
            ? "Previewing the control recovery path around the detected equipment fault."
            : "Previewing the corrective response to the current comfort drift.",
      accelerationFactor,
      horizonMinutes,
      playbackDurationMs,
      plan,
      frames,
    };

    this.latestSimulationPreview = preview;
    this.emitSimulationPreview(preview);
    return preview;
  }

  private buildCandidatePlans(basePlan: SandboxAssistPlan, trigger: RuntimeSimulationPreview["trigger"]) {
    const scales = trigger === "fault_detected" ? [0.9, 1, 1.25, 1.45] : [0.75, 1, 1.2];
    const scaledPlans = scales.map((scale) => this.scaleAssistPlan(basePlan, scale));
    const fanEmphasisPlan = {
      ...basePlan,
      fanSpeedBiasPct: Math.min(35, basePlan.fanSpeedBiasPct + 6),
      zoneDamperBiasPct: Object.fromEntries(
        Object.entries(basePlan.zoneDamperBiasPct).map(([zoneId, bias]) => [zoneId, Math.min(24, bias + 4)]),
      ),
    } satisfies SandboxAssistPlan;
    const ventilationRecoveryPlan = {
      ...basePlan,
      modeBias:
        basePlan.modeBias === "heating" || basePlan.modeBias === "cooling"
          ? basePlan.modeBias
          : "economizer",
      outdoorAirBias: Math.min(0.4, basePlan.outdoorAirBias + 0.08),
      fanSpeedBiasPct: Math.min(35, basePlan.fanSpeedBiasPct + 4),
    } satisfies SandboxAssistPlan;

    return this.deduplicatePlans([null, this.sandboxEngine.getAssistPlan(), ...scaledPlans, fanEmphasisPlan, ventilationRecoveryPlan]);
  }

  private scaleAssistPlan(plan: SandboxAssistPlan, factor: number) {
    return {
      ...plan,
      supplyTemperatureBiasC: Number((plan.supplyTemperatureBiasC * factor).toFixed(2)),
      fanSpeedBiasPct: Number((plan.fanSpeedBiasPct * factor).toFixed(1)),
      outdoorAirBias: Number((plan.outdoorAirBias * factor).toFixed(3)),
      zoneDamperBiasPct: Object.fromEntries(
        Object.entries(plan.zoneDamperBiasPct).map(([zoneId, bias]) => [zoneId, Math.round(bias * factor)]),
      ),
    } satisfies SandboxAssistPlan;
  }

  private deduplicatePlans(plans: Array<SandboxAssistPlan | null>) {
    const seen = new Set<string>();
    const deduped: Array<SandboxAssistPlan | null> = [];

    for (const plan of plans) {
      const key = JSON.stringify(plan);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(plan);
    }

    return deduped;
  }

  private async simulateAssistPlan(plan: SandboxAssistPlan | null, now: Date, horizonMinutes: number) {
    const fork = this.sandboxEngine.fork();
    fork.setAssistPlan(plan);
    const previewTwinEngine = new BelimoEngine(this.blueprint, this.products);
    previewTwinEngine.ingest(this.latestSandboxBatch as SandboxTickResult);
    const tickSeconds = fork.getTickSeconds();
    const totalTicks = Math.max(1, Math.round((horizonMinutes * 60) / tickSeconds));
    const captureEveryTicks = Math.max(1, Math.floor(totalTicks / 12));
    const frames: RuntimeSimulationPreview["frames"] = [];
    let lastBatch = this.latestSandboxBatch as SandboxTickResult;
    let lastTwin = this.latestTwinSnapshot as TwinSnapshot;

    for (let tick = 1; tick <= totalTicks; tick += 1) {
      const simulatedNow = new Date(now.getTime() + tick * tickSeconds * 1000);
      lastBatch = await fork.tick(simulatedNow);
      lastTwin = previewTwinEngine.ingest(lastBatch);

      if (tick === totalTicks || tick % captureEveryTicks === 0) {
        frames.push({
          simulatedMinute: Math.round((tick * tickSeconds) / 60),
          twin: lastTwin,
          sandbox: lastBatch,
        });
      }
    }

    return {
      plan,
      frames,
      finalBatch: lastBatch,
      finalTwin: lastTwin,
      score: scoreTwinSnapshotAgainstControls({
        blueprint: this.blueprint,
        controls: this.getControls(),
        snapshot: lastTwin,
      }),
    };
  }

  private pruneRecentSnapshots() {
    const latest = this.recentSnapshots[this.recentSnapshots.length - 1];

    if (!latest) {
      return;
    }

    const latestMs = new Date(latest.observedAt).getTime();

    while (this.recentSnapshots.length > 0) {
      const oldest = this.recentSnapshots[0];
      const ageMs = latestMs - new Date(oldest.observedAt).getTime();

      if (ageMs <= 12 * 60_000 && this.recentSnapshots.length <= 180) {
        break;
      }

      this.recentSnapshots.shift();
    }
  }

  private pruneAutomaticRemediationStates(
    runtimeSeconds: number,
    assessment: ReturnType<typeof assessRuntimeDrift>,
    activeFaultIds: string[],
  ) {
    const currentIssueKey = deriveAutomaticIssueKey(assessment, activeFaultIds);

    for (const [issueKey, state] of this.automaticRemediationStates.entries()) {
      if (runtimeSeconds - state.appliedAtRuntimeSeconds > 90 * 60) {
        this.automaticRemediationStates.delete(issueKey);
        continue;
      }

      if (issueKey !== currentIssueKey) {
        continue;
      }

      if (shouldClearAutomaticRemediationState(assessment, state)) {
        this.automaticRemediationStates.delete(issueKey);
      }
    }
  }
}
