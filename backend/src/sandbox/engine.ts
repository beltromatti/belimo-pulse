import { BuildingBlueprint, DeviceDefinition, SpaceDefinition } from "../blueprint";
import { ProductDefinition } from "../catalog";
import { applyRuntimeControlInput } from "../control-state";
import {
  OUTDOOR_CO2_PPM,
  clamp,
  computeComfortScore,
  computeFilterLoading,
  computeMixedAirTemperature,
  computeMixedRelativeHumidity,
  computeOccupancyFraction,
  computeStaticPressurePa,
  computeZoneCo2Step,
  computeZoneRhStep,
  computeZoneTemperatureStep,
  createSeededRng,
  humidityRatioFromRh,
  lerp,
  relativeHumidityFromHumidityRatio,
  round,
  smoothStep,
  solarGainMultiplier,
} from "../physics";
import {
  RuntimeControlInput,
  RuntimeControlState,
  RuntimeFaultDescriptor,
  SandboxTickResult,
} from "../runtime-types";
import { SandboxTruth } from "../sandbox-truth";
import {
  MutableZoneTruth,
  SandboxActuatorState,
  SandboxAssistPlan,
  SandboxRuntimeFault,
  SandboxRuntimeState,
  SandboxSourceMode,
  SandboxZoneControlMemory,
} from "./model";
import {
  buildDeviceTelemetryRecord,
  computeZoneActuatorCommand,
  createInitialActuatorState,
  stepActuatorBehavior,
} from "./product-behaviors";
import { OpenMeteoWeatherService } from "./weather";

export class SandboxDataGenerationEngine {
  private readonly random: () => number;

  private readonly spaceById: Map<string, SpaceDefinition>;

  private readonly deviceById: Map<string, DeviceDefinition>;

  private readonly productById: Map<string, ProductDefinition>;

  private readonly runtimeState: SandboxRuntimeState;

  private readonly runtimeFaults: SandboxRuntimeFault[];

  private readonly controlState: RuntimeControlState;

  constructor(
    private readonly blueprint: BuildingBlueprint,
    private readonly sandboxTruth: SandboxTruth,
    private readonly products: ProductDefinition[],
    private readonly weatherService: OpenMeteoWeatherService,
  ) {
    this.random = createSeededRng(sandboxTruth.runtime.random_seed);
    this.spaceById = new Map(blueprint.spaces.map((space) => [space.id, space]));
    this.deviceById = new Map(blueprint.devices.map((device) => [device.id, device]));
    this.productById = new Map(products.map((product) => [product.id, product]));
    this.runtimeFaults = sandboxTruth.fault_profiles.map((fault) => ({
      id: fault.id,
      deviceId: fault.device_id,
      faultType: fault.fault_type,
      severity: fault.severity,
      active: false,
    }));
    this.controlState = this.createDefaultControlState();
    this.runtimeState = this.createInitialRuntimeState();
  }

  getTickSeconds() {
    return this.sandboxTruth.runtime.simulation_timestep_s;
  }

  getControlState() {
    return structuredClone(this.controlState);
  }

  getAssistPlan() {
    return this.runtimeState.assistPlan ? structuredClone(this.runtimeState.assistPlan) : null;
  }

  setAssistPlan(plan: SandboxAssistPlan | null) {
    this.runtimeState.assistPlan = plan ? structuredClone(plan) : null;
  }

  fork() {
    const forked = new SandboxDataGenerationEngine(
      this.blueprint,
      this.sandboxTruth,
      this.products,
      this.weatherService,
    );
    const mutableFork = forked as unknown as {
      runtimeState: SandboxRuntimeState;
      runtimeFaults: SandboxRuntimeFault[];
      controlState: RuntimeControlState;
    };

    mutableFork.runtimeState = structuredClone(this.runtimeState);
    mutableFork.runtimeFaults = structuredClone(this.runtimeFaults);
    mutableFork.controlState = structuredClone(this.controlState);

    return forked;
  }

  getAvailableFaults(): RuntimeFaultDescriptor[] {
    return this.sandboxTruth.fault_profiles.map(({ id, device_id, fault_type, severity }) => ({
      id,
      deviceId: device_id,
      faultType: fault_type,
      severity,
    }));
  }

  updateControls(input: RuntimeControlInput) {
    const next = applyRuntimeControlInput(this.controlState, input);

    this.controlState.sourceModePreference = next.sourceModePreference;
    this.controlState.zoneTemperatureOffsetsC = next.zoneTemperatureOffsetsC;
    this.controlState.zoneCo2SetpointsPpm = next.zoneCo2SetpointsPpm;
    this.controlState.supplyTemperatureTrimC = next.supplyTemperatureTrimC;
    this.controlState.ventilationBoostPct = next.ventilationBoostPct;
    this.controlState.occupancyBias = next.occupancyBias;
    this.controlState.windowOpenFractionByZone = next.windowOpenFractionByZone;
    this.controlState.weatherMode = next.weatherMode;
    this.controlState.weatherOverride = next.weatherOverride;
    this.controlState.timeMode = next.timeMode;
    this.controlState.timeSpeedMultiplier = next.timeSpeedMultiplier;
    this.controlState.solarGainBias = next.solarGainBias;
    this.controlState.plugLoadBias = next.plugLoadBias;
    this.controlState.faultOverrides = next.faultOverrides;

    return this.getControlState();
  }

  async tick(now = new Date()): Promise<SandboxTickResult> {
    const dtSeconds = this.sandboxTruth.runtime.simulation_timestep_s;
    const weather = await this.getWeather(now);

    this.runtimeState.runtimeSeconds += dtSeconds;
    this.pruneExpiredAssistPlan();
    this.updateFaultActivation();
    const occupancyByZone = this.computeOccupancy(now);
    const zoneDemand = this.computeZoneDemand(occupancyByZone);
    const controls = this.computeControls(zoneDemand, weather.temperatureC);
    this.applyActuatorDynamics(controls.damperCommands, dtSeconds);
    this.runtimeState.outdoorAirFraction = controls.outdoorAirFraction;
    this.runtimeState.sourceMode = controls.sourceMode;
    this.runtimeState.supplyFanSpeedPct = controls.supplyFanSpeedPct;
    this.runtimeState.filterLoadingFactor = computeFilterLoading(
      this.runtimeState.runtimeSeconds / 3600,
      this.getFaultSeverity("filter_loading"),
      this.sandboxTruth.equipment_truth.filter.natural_loading_hours_to_full_scale,
    );

    const returnTemperatureC = this.averageOfZones("temperatureC");
    const returnRhPct = this.averageOfZones("relativeHumidityPct");
    const returnCo2Ppm = this.averageOfZones("co2Ppm");
    this.runtimeState.mixedAirTemperatureC = computeMixedAirTemperature(
      weather.temperatureC,
      returnTemperatureC,
      this.runtimeState.outdoorAirFraction,
    );
    const mixedAirRhPct = computeMixedRelativeHumidity(
      weather.temperatureC,
      weather.relativeHumidityPct,
      returnTemperatureC,
      returnRhPct,
      this.runtimeState.mixedAirTemperatureC,
      this.runtimeState.outdoorAirFraction,
    );

    const designTotalAirflowM3H = this.getSourceDevice().design.design_supply_airflow_m3_h ?? 4000;
    const expectedTotalFlowM3H = designTotalAirflowM3H * clamp(this.runtimeState.supplyFanSpeedPct / 100, 0.2, 1.1);
    const achievableSupplyTemperatureC = this.computeAchievableSupplyTemperature(
      controls.sourceMode,
      controls.supplyTemperatureSetpointC,
      this.runtimeState.mixedAirTemperatureC,
      weather.temperatureC,
      expectedTotalFlowM3H,
    );

    this.runtimeState.supplyTemperatureC = smoothStep(
      this.runtimeState.supplyTemperatureC,
      achievableSupplyTemperatureC,
      dtSeconds * 0.16,
    );
    this.runtimeState.supplyRelativeHumidityPct = clamp(
      smoothStep(
        this.runtimeState.supplyRelativeHumidityPct,
        this.computeSupplyRelativeHumidityPct(
          controls.sourceMode,
          this.runtimeState.mixedAirTemperatureC,
          mixedAirRhPct,
          this.runtimeState.supplyTemperatureC,
        ),
        dtSeconds * 0.5,
      ),
      15,
      98,
    );
    this.runtimeState.supplyCo2Ppm = round(
      OUTDOOR_CO2_PPM * this.runtimeState.outdoorAirFraction + returnCo2Ppm * (1 - this.runtimeState.outdoorAirFraction),
    );

    const branchFlows = this.computeBranchAirflows();
    const sourceTruth = this.sandboxTruth.equipment_truth.source_equipment;
    const staticPressurePa = computeStaticPressurePa(
      this.runtimeState.supplyFanSpeedPct,
      Object.values(branchFlows).reduce((sum, flow) => sum + flow, 0),
      this.getSourceDevice().design.design_supply_airflow_m3_h ?? 4000,
      this.runtimeState.filterLoadingFactor,
    ) *
      (sourceTruth.fan_static_coeff_pa / 1100);
    this.updateZones(weather, occupancyByZone, branchFlows, staticPressurePa, dtSeconds, now);
    this.updateZoneControlMemory(occupancyByZone, dtSeconds);

    const zones = Array.from(this.runtimeState.zones.values()).map((zone) => ({
      ...zone,
      temperatureC: round(zone.temperatureC),
      relativeHumidityPct: round(zone.relativeHumidityPct),
      co2Ppm: round(zone.co2Ppm),
      supplyAirflowM3H: round(zone.supplyAirflowM3H),
      sensibleLoadW: round(zone.sensibleLoadW),
      comfortScore: round(zone.comfortScore),
    }));

    const observedAt = now.toISOString();
    const deviceReadings = this.buildDeviceReadings(observedAt, weather, branchFlows, staticPressurePa);

    return {
      buildingId: this.blueprint.blueprint_id,
      observedAt,
      weather,
      deviceReadings,
      operationalState: {
        runtimeSeconds: this.runtimeState.runtimeSeconds,
        activeFaults: this.runtimeFaults
          .filter((fault) => fault.active)
          .map(({ id, deviceId, faultType, severity }) => ({ id, deviceId, faultType, severity })),
      },
      truth: {
        zones,
        supplyTemperatureC: round(this.runtimeState.supplyTemperatureC),
        mixedAirTemperatureC: round(this.runtimeState.mixedAirTemperatureC),
        outdoorAirFraction: round(this.runtimeState.outdoorAirFraction, 3),
        supplyAirflowM3H: round(Object.values(branchFlows).reduce((sum, flow) => sum + flow, 0)),
        staticPressurePa: round(staticPressurePa),
      },
    };
  }

  private createInitialRuntimeState(): SandboxRuntimeState {
    const zones = new Map<string, MutableZoneTruth>();
    const zoneControlMemory = new Map<string, SandboxZoneControlMemory>();
    const actuators = new Map<string, SandboxActuatorState>();

    for (const space of this.blueprint.spaces) {
      const initialTemperatureC = 22.4;
      const initialCo2Ppm = 520;
      zones.set(space.id, {
        zoneId: space.id,
        temperatureC: initialTemperatureC,
        relativeHumidityPct: 44,
        co2Ppm: initialCo2Ppm,
        occupancyCount: 0,
        supplyAirflowM3H: 0,
        sensibleLoadW: 0,
        comfortScore: 100,
      });
      zoneControlMemory.set(space.id, {
        temperatureIntegralC: 0,
        co2IntegralPpm: 0,
        temperatureSlopeCPerMin: 0,
        co2SlopePpmPerMin: 0,
        lastTemperatureC: initialTemperatureC,
        lastCo2Ppm: initialCo2Ppm,
      });
    }

    for (const device of this.blueprint.devices.filter((candidate) => candidate.kind === "actuator")) {
      actuators.set(device.id, createInitialActuatorState(device));
    }

    return {
      runtimeSeconds: 0,
      zones,
      zoneControlMemory,
      actuators,
      filterLoadingFactor: this.sandboxTruth.equipment_truth.filter.baseline_loading_factor,
      sourceMode: "ventilation",
      supplyFanSpeedPct: 40,
      outdoorAirFraction: 0.22,
      mixedAirTemperatureC: 20,
      supplyTemperatureC: 18,
      supplyRelativeHumidityPct: 45,
      supplyCo2Ppm: OUTDOOR_CO2_PPM,
      assistPlan: null,
    };
  }

  private createDefaultControlState(): RuntimeControlState {
    return {
      sourceModePreference: "auto",
      zoneTemperatureOffsetsC: Object.fromEntries(this.blueprint.spaces.map((space) => [space.id, 0])),
      zoneCo2SetpointsPpm: Object.fromEntries(
        this.blueprint.spaces.map((space) => [space.id, space.comfort_targets.co2_limit_ppm]),
      ),
      supplyTemperatureTrimC: 0,
      ventilationBoostPct: 0,
      occupancyBias: 1,
      windowOpenFractionByZone: Object.fromEntries(this.blueprint.spaces.map((space) => [space.id, 0])),
      weatherMode: "live",
      weatherOverride: {
        temperatureC: this.sandboxTruth.weather.fallback_temperature_c,
        relativeHumidityPct: this.sandboxTruth.weather.fallback_relative_humidity_pct,
        windSpeedMps: 2,
        windDirectionDeg: 180,
        cloudCoverPct: 55,
      },
      timeMode: "live",
      timeSpeedMultiplier: 1,
      solarGainBias: 1,
      plugLoadBias: 1,
      faultOverrides: Object.fromEntries(this.sandboxTruth.fault_profiles.map((fault) => [fault.id, "auto"])),
    };
  }

  private computeOccupancy(now: Date) {
    const hour = now.getHours() + now.getMinutes() / 60;
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    const occupancyConfig = this.blueprint.control_profiles.occupancy_design;
    const baseFraction = computeOccupancyFraction(
      hour,
      occupancyConfig.weekday_start_hour,
      occupancyConfig.weekday_peak_hour,
      occupancyConfig.weekday_end_hour,
    );
    const occupancyByZone: Record<string, number> = {};

    for (const space of this.blueprint.spaces) {
      const truth = this.getZoneTruth(space.id);
      const peakFraction = isWeekend
        ? truth.occupancy_profile.weekend_peak_fraction
        : truth.occupancy_profile.weekday_peak_fraction;
      const variation = truth.occupancy_profile.stochastic_variation_pct;
      const randomness = 1 - variation + this.random() * variation * 2;
      occupancyByZone[space.id] = Math.round(
        space.occupancy_design.design_people *
          baseFraction *
          peakFraction *
          randomness *
          this.controlState.occupancyBias,
      );
    }

    return occupancyByZone;
  }

  private computeZoneDemand(occupancyByZone: Record<string, number>) {
    const demandByZone: Record<string, number> = {};

    for (const space of this.blueprint.spaces) {
      const truth = this.runtimeState.zones.get(space.id);

      if (!truth) {
        continue;
      }

      const occupied = occupancyByZone[space.id] > 0;
      const targetBand = occupied ? space.comfort_targets.occupied_temperature_band_c : space.comfort_targets.unoccupied_temperature_band_c;
      const targetMidpoint = (targetBand[0] + targetBand[1]) / 2 + this.getZoneTemperatureOffset(space.id);
      const tempError = truth.temperatureC - targetMidpoint;
      const co2Target = this.controlState.zoneCo2SetpointsPpm[space.id] ?? space.comfort_targets.co2_limit_ppm;
      const co2Demand = Math.max(0, (truth.co2Ppm - co2Target) / 170);
      const memory = this.getZoneControlMemory(space.id, truth);
      const temperatureWorseningRate = Math.max(0, Math.sign(tempError || 0) * memory.temperatureSlopeCPerMin);
      const projectedTempDemand = (Math.abs(tempError) + temperatureWorseningRate * 8) / 3.2;
      const projectedCo2Demand = Math.max(0, truth.co2Ppm + Math.max(memory.co2SlopePpmPerMin, 0) * 10 - co2Target) / 190;
      const occupancyFloor = occupied ? 0.28 : 0.12;
      const windowPenalty = (this.controlState.windowOpenFractionByZone[space.id] ?? 0) * 0.22;
      const temperatureIntegralDemand = Math.min(Math.abs(memory.temperatureIntegralC) / 7, 0.55);
      const co2IntegralDemand = Math.min(Math.max(memory.co2IntegralPpm, 0) / 650, 0.45);
      demandByZone[space.id] = clamp(
        occupancyFloor +
          Math.abs(tempError) * 0.18 +
          projectedTempDemand * 0.34 +
          temperatureIntegralDemand +
          co2Demand * 0.92 +
          projectedCo2Demand * 0.48 +
          co2IntegralDemand +
          windowPenalty,
        0.15,
        1.45,
      );
    }

    return demandByZone;
  }

  private computeControls(zoneDemand: Record<string, number>, outdoorTemperatureC: number) {
    const activeAssistPlan = this.getActiveAssistPlan();
    const averageDemand = Object.values(zoneDemand).reduce((sum, value) => sum + value, 0) / Object.keys(zoneDemand).length;
    const maxDemand = Math.max(...Object.values(zoneDemand));
    const occupiedZones = Array.from(this.runtimeState.zones.values()).filter((zone) => zone.occupancyCount > 0).length;
    const fanRange = this.blueprint.control_profiles.air_loop_design.supply_fan_speed_pct;
    const satRange = this.blueprint.control_profiles.air_loop_design.supply_air_temperature_reset_c;
    const activeObstructionPenalty = this.getFaultSeverity("mechanical_obstruction_inside_damper_or_actuator");
    const ventilationAssist = this.controlState.ventilationBoostPct;
    let maxAirflowShortageRatio = 0;
    let maxZoneDamperPositionPct = 0;
    const demandSignal = clamp(averageDemand * 0.48 + maxDemand * 0.28, 0, 1.05);
    const baseFanFloorPct = fanRange[0] + 2;
    const supplyFanSpeedPct = clamp(
      fanRange[0] +
        demandSignal * (fanRange[1] - fanRange[0]) +
        maxAirflowShortageRatio * 18 +
        ventilationAssist * 0.65 +
        activeObstructionPenalty * 8,
      baseFanFloorPct,
      activeObstructionPenalty > 0 ? fanRange[1] : fanRange[1] - 3,
    );
    const averageZoneTemp = this.averageOfZones("temperatureC");
    let maxWarmErrorC = 0;
    let maxColdErrorC = 0;
    let maxCo2ExcessPpm = 0;

    for (const space of this.blueprint.spaces) {
      const zone = this.runtimeState.zones.get(space.id);

      if (!zone) {
        continue;
      }

      const occupied = zone.occupancyCount > 0;
      const targetBand = occupied ? space.comfort_targets.occupied_temperature_band_c : space.comfort_targets.unoccupied_temperature_band_c;
      const targetMidpoint = (targetBand[0] + targetBand[1]) / 2 + this.getZoneTemperatureOffset(space.id);
      const co2Target = this.controlState.zoneCo2SetpointsPpm[space.id] ?? space.comfort_targets.co2_limit_ppm;
      const memory = this.getZoneControlMemory(space.id, zone);
      const projectedTemperatureC = zone.temperatureC + memory.temperatureSlopeCPerMin * 10;
      const designFlow = this.getPrimaryActuatorForZone(space.id)?.design.design_airflow_m3_h ?? 0;
      const minimumFlow = designFlow * clamp((occupied ? 0.56 : 0.18) + ventilationAssist / 100 * 0.12, 0.18, 0.76);
      const branchActuator = this.getPrimaryActuatorForZone(space.id);
      const branchFeedbackPct = branchActuator ? this.runtimeState.actuators.get(branchActuator.id)?.feedbackPct ?? 0 : 0;
      maxWarmErrorC = Math.max(maxWarmErrorC, zone.temperatureC - targetMidpoint, projectedTemperatureC - targetMidpoint);
      maxColdErrorC = Math.max(maxColdErrorC, targetMidpoint - zone.temperatureC, targetMidpoint - projectedTemperatureC);
      maxCo2ExcessPpm = Math.max(maxCo2ExcessPpm, zone.co2Ppm - co2Target, zone.co2Ppm + memory.co2SlopePpmPerMin * 10 - co2Target);
      maxAirflowShortageRatio = Math.max(
        maxAirflowShortageRatio,
        designFlow > 0 ? clamp((minimumFlow - zone.supplyAirflowM3H) / designFlow, 0, 0.55) : 0,
      );
      maxZoneDamperPositionPct = Math.max(maxZoneDamperPositionPct, branchFeedbackPct);
    }

    let sourceMode: SandboxSourceMode = "ventilation";
    let supplyTemperatureSetpointC = satRange[1];
    const trimC = this.controlState.supplyTemperatureTrimC;

    if (
      this.controlState.sourceModePreference === "cooling" ||
      maxWarmErrorC > 0.24 ||
      (maxWarmErrorC > 0.12 && averageZoneTemp > 23.1)
    ) {
      sourceMode = "cooling";
      supplyTemperatureSetpointC = clamp(
        lerp(satRange[1], satRange[0], clamp(maxWarmErrorC / 2.4, 0, 1)) + trimC + 1.1,
        13.2,
        20,
      );
    } else if (
      this.controlState.sourceModePreference === "heating" ||
      maxColdErrorC > 0.24 ||
      (outdoorTemperatureC < 12 && maxColdErrorC > 0.08)
    ) {
      sourceMode = "heating";
      supplyTemperatureSetpointC = clamp(lerp(23.5, 32.5, clamp(maxColdErrorC / 2.1, 0, 1)) + trimC, 21, 33.5);
    } else if (
      this.controlState.sourceModePreference === "economizer" ||
      (outdoorTemperatureC < this.blueprint.control_profiles.air_loop_design.economizer_lockout_temperature_c &&
        occupiedZones > 0 &&
        maxWarmErrorC > 0.12)
    ) {
      sourceMode = "economizer";
      supplyTemperatureSetpointC = clamp(16.5 + trimC, 14, 19);
    } else if (this.controlState.sourceModePreference === "ventilation") {
      sourceMode = "ventilation";
      supplyTemperatureSetpointC = clamp(satRange[1] + trimC, 17, 23);
    }

    const minOutdoor = this.getSourceDevice().design.minimum_outdoor_air_fraction ?? 0.18;
    const co2Assist = clamp(maxCo2ExcessPpm / 450, 0, 0.35);
    const boostAssist = ventilationAssist / 100;
    let outdoorAirFraction =
      sourceMode === "economizer"
        ? clamp(0.45 + averageDemand * 0.35 + co2Assist + boostAssist, minOutdoor, 0.95)
        : clamp(minOutdoor + co2Assist + boostAssist, minOutdoor, 0.65);
    let resolvedSupplyFanSpeedPct = clamp(
      supplyFanSpeedPct + maxAirflowShortageRatio * 20,
      baseFanFloorPct,
      activeObstructionPenalty > 0 ? fanRange[1] : fanRange[1],
    );

    if (activeAssistPlan) {
      if (this.controlState.sourceModePreference === "auto" && activeAssistPlan.modeBias !== "auto") {
        sourceMode = activeAssistPlan.modeBias;
      }

      supplyTemperatureSetpointC += activeAssistPlan.supplyTemperatureBiasC;
      resolvedSupplyFanSpeedPct += activeAssistPlan.fanSpeedBiasPct;
      outdoorAirFraction += activeAssistPlan.outdoorAirBias;
    }

    if (sourceMode === "heating") {
      const assistHeatingOutdoorFloor =
        activeAssistPlan && activeAssistPlan.outdoorAirBias < 0 ? Math.max(0.12, minOutdoor - 0.08) : minOutdoor;
      const dischargeLiftC = this.runtimeState.supplyTemperatureC - averageZoneTemp;
      const dischargeReadiness = clamp((dischargeLiftC - 1.4) / 4.8, 0, 1);
      const coldSeverity = clamp(maxColdErrorC / 2.6, 0, 1);
      const preheatLiftC = (1 - dischargeReadiness) * (1.6 + coldSeverity * 1.2);
      const readinessFanCapPct = lerp(baseFanFloorPct + 12 + coldSeverity * 8, fanRange[1], dischargeReadiness);
      supplyTemperatureSetpointC = clamp(
        supplyTemperatureSetpointC + preheatLiftC,
        20,
        activeAssistPlan ? 35.5 : 31,
      );
      outdoorAirFraction = clamp(outdoorAirFraction, assistHeatingOutdoorFloor, 0.4);
      if (maxCo2ExcessPpm < 80) {
        resolvedSupplyFanSpeedPct = Math.min(resolvedSupplyFanSpeedPct, readinessFanCapPct);
      }
    } else if (sourceMode === "cooling") {
      supplyTemperatureSetpointC = clamp(supplyTemperatureSetpointC, 13.2, 20);
      outdoorAirFraction = clamp(outdoorAirFraction, minOutdoor, 0.72);
    } else if (sourceMode === "economizer") {
      supplyTemperatureSetpointC = clamp(supplyTemperatureSetpointC, 14, 19);
      outdoorAirFraction = clamp(outdoorAirFraction, 0.35, 0.95);
    } else {
      supplyTemperatureSetpointC = clamp(supplyTemperatureSetpointC, 17, 23);
      outdoorAirFraction = clamp(outdoorAirFraction, minOutdoor, 0.7);
    }

    const staticResetTrimPct =
      maxAirflowShortageRatio >= 0.08 || maxZoneDamperPositionPct >= 93 || maxCo2ExcessPpm >= 80
        ? 0
        : clamp((90 - maxZoneDamperPositionPct) * 0.28, 0, 10);

    return {
      sourceMode,
      supplyTemperatureSetpointC,
      supplyFanSpeedPct: clamp(resolvedSupplyFanSpeedPct - staticResetTrimPct, baseFanFloorPct, fanRange[1]),
      outdoorAirFraction,
      damperCommands: this.computeDamperCommands(zoneDemand, activeAssistPlan, sourceMode),
    };
  }

  private computeDamperCommands(
    zoneDemand: Record<string, number>,
    activeAssistPlan: SandboxAssistPlan | null,
    sourceMode: SandboxSourceMode,
  ) {
    const commands: Record<string, number> = {
      "oa-damper-1": round(this.runtimeState.outdoorAirFraction * 100),
      "ra-damper-1": round((1 - this.runtimeState.outdoorAirFraction) * 100),
      "ea-damper-1": round(Math.max(18, this.runtimeState.outdoorAirFraction * 100)),
    };

    for (const device of this.blueprint.devices.filter((candidate) => candidate.kind === "actuator")) {
      const servedZoneId = device.served_space_ids[0];

      if (!servedZoneId || !(servedZoneId in zoneDemand)) {
        continue;
      }

      const zone = this.runtimeState.zones.get(servedZoneId);
      const space = this.spaceById.get(servedZoneId);
      const occupied = (zone?.occupancyCount ?? 0) > 0;
      const targetBand = occupied
        ? space?.comfort_targets.occupied_temperature_band_c
        : space?.comfort_targets.unoccupied_temperature_band_c;
      const targetMidpoint =
        targetBand && zone
          ? (targetBand[0] + targetBand[1]) / 2 + this.getZoneTemperatureOffset(servedZoneId)
          : 22;
      const zoneTempErrorC = zone ? zone.temperatureC - targetMidpoint : 0;
      const modeConflictTrimPct =
        sourceMode === "cooling" || sourceMode === "economizer"
          ? zoneTempErrorC < -0.18
            ? clamp(Math.abs(zoneTempErrorC) * 18 + 5, 5, 28)
            : 0
          : sourceMode === "heating"
            ? zoneTempErrorC > 0.18
              ? clamp(Math.abs(zoneTempErrorC) * 16 + 4, 4, 24)
              : 0
            : 0;
      const modeSupportBoostPct =
        sourceMode === "cooling" || sourceMode === "economizer"
          ? zoneTempErrorC > 0.22
            ? clamp(zoneTempErrorC * 5, 0, 8)
            : 0
          : sourceMode === "heating"
            ? zoneTempErrorC < -0.22
              ? clamp(Math.abs(zoneTempErrorC) * 5.5, 0, 9)
              : 0
            : 0;

      commands[device.id] = clamp(
        computeZoneActuatorCommand(device.product_id, zoneDemand[servedZoneId]) +
          modeSupportBoostPct -
          modeConflictTrimPct +
          (activeAssistPlan?.zoneDamperBiasPct[servedZoneId] ?? 0),
        5,
        100,
      );
    }

    return commands;
  }

  private applyActuatorDynamics(commands: Record<string, number>, dtSeconds: number) {
    for (const [deviceId, actuator] of this.runtimeState.actuators.entries()) {
      const device = this.deviceById.get(deviceId);

      if (!device) {
        continue;
      }

      const target = commands[deviceId] ?? actuator.commandPct;
      const truth = this.getActuatorTruth(deviceId);
      const obstructionSeverity = this.isFaultActive(deviceId, "mechanical_obstruction_inside_damper_or_actuator")
        ? this.getFaultSeverity("mechanical_obstruction_inside_damper_or_actuator", deviceId)
        : 0;
      this.runtimeState.actuators.set(
        deviceId,
        stepActuatorBehavior({
          device,
          current: actuator,
          targetPct: target,
          dtSeconds,
          truth,
          obstructionSeverity,
        }),
      );
    }
  }

  private computeBranchAirflows() {
    const source = this.getSourceDevice();
    const designTotal = source.design.design_supply_airflow_m3_h ?? 4000;
    const totalFlow = designTotal * clamp(this.runtimeState.supplyFanSpeedPct / 100, 0.2, 1.1);
    const weights: Array<{ deviceId: string; weight: number; designFlow: number }> = [];

    for (const device of this.blueprint.devices.filter((candidate) => candidate.kind === "actuator")) {
      const servedZoneId = device.served_space_ids[0];
      const actuator = this.runtimeState.actuators.get(device.id);

      if (!servedZoneId || !actuator) {
        continue;
      }

      const designFlow = device.design.design_airflow_m3_h ?? 300;
      const openness = clamp(actuator.feedbackPct / 100, 0.05, 1);
      const flowWeight = this.getBranchFlowWeight(device.id);
      const weight = designFlow * openness * openness * flowWeight;
      weights.push({ deviceId: device.id, weight, designFlow });
    }

    const totalWeight = weights.reduce((sum, entry) => sum + entry.weight, 0);
    const branchFlows: Record<string, number> = {};

    for (const entry of weights) {
      branchFlows[entry.deviceId] =
        totalWeight <= 0 ? 0 : clamp((entry.weight / totalWeight) * totalFlow, 0, entry.designFlow * 1.15);
    }

    return branchFlows;
  }

  private updateZones(
    weather: { temperatureC: number; relativeHumidityPct: number; cloudCoverPct: number; windSpeedMps: number },
    occupancyByZone: Record<string, number>,
    branchFlows: Record<string, number>,
    staticPressurePa: number,
    dtSeconds: number,
    now: Date,
  ) {
    const hour = now.getHours() + now.getMinutes() / 60;

    for (const space of this.blueprint.spaces) {
      const zone = this.runtimeState.zones.get(space.id);
      const zoneTruth = this.getZoneTruth(space.id);

      if (!zone) {
        continue;
      }

      const branchDevice = this.getPrimaryActuatorForZone(space.id);
      const baseFlow = branchDevice ? branchFlows[branchDevice.id] ?? 0 : 0;
      const obstructionPenalty = branchDevice && this.isFaultActive(branchDevice.id, "mechanical_obstruction_inside_damper_or_actuator")
        ? 1 - this.getFaultSeverity("mechanical_obstruction_inside_damper_or_actuator", branchDevice.id) * 0.55
        : 1;
      const supplyAirflowM3H = baseFlow * obstructionPenalty * clamp(staticPressurePa / 320, 0.4, 1.15);
      const occupancyCount = occupancyByZone[space.id];
      const solarGainW =
        space.envelope.transparent_surfaces.reduce((sum, surface) => sum + surface.area_m2, 0) *
        110 *
        solarGainMultiplier(weather.cloudCoverPct, hour, zoneTruth.solar_gain_scale) *
        this.controlState.solarGainBias;
      const plugLoadW = space.internal_load_design.plug_w_per_m2 * space.geometry.area_m2 * this.controlState.plugLoadBias;
      const lightingLoadW = space.internal_load_design.lighting_w_per_m2 * space.geometry.area_m2;
      const occupancySensibleW = occupancyCount * space.occupancy_design.sensible_gain_w_per_person;
      const sensibleLoadW = solarGainW + plugLoadW + lightingLoadW + occupancySensibleW;
      const infiltrationAch =
        zoneTruth.effective_infiltration_ach *
        (1 + weather.windSpeedMps / 8) *
        (1 + (this.controlState.windowOpenFractionByZone[space.id] ?? 0) * 1.75);
      zone.temperatureC = computeZoneTemperatureStep({
        dtSeconds,
        zoneTemperatureC: zone.temperatureC,
        outdoorTemperatureC: weather.temperatureC,
        supplyTemperatureC: this.runtimeState.supplyTemperatureC,
        supplyAirflowM3H,
        zoneVolumeM3: space.geometry.volume_m3,
        uaWPerK: zoneTruth.effective_ua_w_per_k,
        thermalCapacitanceKjPerK: zoneTruth.effective_thermal_capacitance_kj_per_k,
        infiltrationAch,
        sensibleInternalLoadW: sensibleLoadW,
      });
      zone.co2Ppm = computeZoneCo2Step({
        dtSeconds,
        zoneVolumeM3: space.geometry.volume_m3,
        zoneCo2Ppm: zone.co2Ppm,
        outdoorCo2Ppm: OUTDOOR_CO2_PPM,
        supplyCo2Ppm: this.runtimeState.supplyCo2Ppm,
        supplyAirflowM3H,
        infiltrationAch,
        occupancyCount,
        co2GenerationLpsPerPerson: space.occupancy_design.co2_generation_lps_per_person,
      });
      zone.relativeHumidityPct = computeZoneRhStep({
        dtSeconds,
        zoneTemperatureC: zone.temperatureC,
        outdoorTemperatureC: weather.temperatureC,
        supplyTemperatureC: this.runtimeState.supplyTemperatureC,
        zoneRhPct: zone.relativeHumidityPct,
        outdoorRhPct: weather.relativeHumidityPct,
        supplyRhPct: this.runtimeState.supplyRelativeHumidityPct,
        supplyAirflowM3H,
        infiltrationAch,
        occupancyCount,
        latentGainWPerPerson: space.occupancy_design.latent_gain_w_per_person,
        zoneVolumeM3: space.geometry.volume_m3,
      });
      const occupied = occupancyCount > 0;
      const comfortBand = occupied ? space.comfort_targets.occupied_temperature_band_c : space.comfort_targets.unoccupied_temperature_band_c;
      zone.comfortScore = computeComfortScore(
        zone.temperatureC,
        zone.relativeHumidityPct,
        zone.co2Ppm,
        comfortBand,
        space.comfort_targets.humidity_band_pct,
        space.comfort_targets.co2_limit_ppm,
      );
      zone.occupancyCount = occupancyCount;
      zone.supplyAirflowM3H = supplyAirflowM3H;
      zone.sensibleLoadW = sensibleLoadW;
    }
  }

  private buildDeviceReadings(
    observedAt: string,
    weather: { temperatureC: number; relativeHumidityPct: number },
    branchFlows: Record<string, number>,
    staticPressurePa: number,
  ) {
    const readings = [];
    const activeFaults = this.runtimeFaults.filter((fault) => fault.active);
    const telemetryContext = {
      observedAt,
      weather,
      random: this.random,
      sensorNoise: this.sandboxTruth.sensor_noise,
      runtimeState: this.runtimeState,
      zones: this.runtimeState.zones,
      branchFlows,
      staticPressurePa,
      activeFaults,
      sourceTruth: this.sandboxTruth.equipment_truth.source_equipment,
      sourceDevice: this.getSourceDevice(),
    };

    for (const device of this.blueprint.devices) {
      const product = this.productById.get(device.product_id);

      if (!product) {
        throw new Error(`Missing product ${device.product_id} for device ${device.id}`);
      }

      readings.push(
        buildDeviceTelemetryRecord({
          device,
          product,
          actuator: this.runtimeState.actuators.get(device.id) ?? null,
          context: telemetryContext,
        }),
      );
    }

    return readings;
  }

  private averageOfZones(key: keyof MutableZoneTruth) {
    const zones = Array.from(this.runtimeState.zones.values());
    return zones.reduce((sum, zone) => sum + Number(zone[key]), 0) / zones.length;
  }

  private getSourceDevice() {
    const source = this.blueprint.devices.find((device) => device.kind === "source_equipment");

    if (!source) {
      throw new Error("Sandbox blueprint does not define source equipment");
    }

    return source;
  }

  private getPrimaryActuatorForZone(zoneId: string) {
    return this.blueprint.devices.find((device) => device.kind === "actuator" && device.served_space_ids.includes(zoneId)) ?? null;
  }

  private updateFaultActivation() {
    for (const runtimeFault of this.runtimeFaults) {
      const profile = this.sandboxTruth.fault_profiles.find((fault) => fault.id === runtimeFault.id);

      if (!profile) {
        continue;
      }

      const override = this.controlState.faultOverrides[runtimeFault.id] ?? "auto";
      runtimeFault.active =
        override === "forced_on"
          ? true
          : override === "forced_off"
            ? false
            : this.runtimeState.runtimeSeconds >= profile.activation_runtime_s;
    }
  }

  private isFaultActive(deviceId: string, faultType: string) {
    return this.runtimeFaults.some((fault) => fault.active && fault.deviceId === deviceId && fault.faultType === faultType);
  }

  private getFaultSeverity(faultType: string, deviceId?: string) {
    return this.runtimeFaults
      .filter((fault) => fault.active && fault.faultType === faultType && (!deviceId || fault.deviceId === deviceId))
      .reduce((max, fault) => Math.max(max, fault.severity), 0);
  }

  private getZoneTruth(zoneId: string) {
    const truth = this.sandboxTruth.zone_truth.find((candidate) => candidate.zone_id === zoneId);

    if (!truth) {
      throw new Error(`Missing sandbox truth for zone ${zoneId}`);
    }

    return truth;
  }

  private getActuatorTruth(deviceId: string) {
    const truth = this.sandboxTruth.equipment_truth.actuator_truth.find((candidate) => candidate.device_id === deviceId);

    if (!truth) {
      throw new Error(`Missing sandbox actuator truth for device ${deviceId}`);
    }

    return truth;
  }

  private getBranchFlowWeight(deviceId: string) {
    return (
      this.sandboxTruth.equipment_truth.branch_flow_coefficients.find((candidate) => candidate.device_id === deviceId)?.flow_weight ??
      1
    );
  }

  private getZoneTemperatureOffset(zoneId: string) {
    return this.controlState.zoneTemperatureOffsetsC[zoneId] ?? 0;
  }

  private getZoneControlMemory(zoneId: string, zone: MutableZoneTruth) {
    const current = this.runtimeState.zoneControlMemory.get(zoneId);

    if (current) {
      return current;
    }

    const initialized = {
      temperatureIntegralC: 0,
      co2IntegralPpm: 0,
      temperatureSlopeCPerMin: 0,
      co2SlopePpmPerMin: 0,
      lastTemperatureC: zone.temperatureC,
      lastCo2Ppm: zone.co2Ppm,
    } satisfies SandboxZoneControlMemory;

    this.runtimeState.zoneControlMemory.set(zoneId, initialized);
    return initialized;
  }

  private updateZoneControlMemory(occupancyByZone: Record<string, number>, dtSeconds: number) {
    const dtMinutes = dtSeconds / 60;

    for (const space of this.blueprint.spaces) {
      const zone = this.runtimeState.zones.get(space.id);

      if (!zone) {
        continue;
      }

      const memory = this.getZoneControlMemory(space.id, zone);
      const occupied = occupancyByZone[space.id] > 0;
      const targetBand = occupied ? space.comfort_targets.occupied_temperature_band_c : space.comfort_targets.unoccupied_temperature_band_c;
      const targetMidpoint = (targetBand[0] + targetBand[1]) / 2 + this.getZoneTemperatureOffset(space.id);
      const co2Target = this.controlState.zoneCo2SetpointsPpm[space.id] ?? space.comfort_targets.co2_limit_ppm;
      const rawTemperatureSlope = (zone.temperatureC - memory.lastTemperatureC) / Math.max(dtMinutes, 0.0833);
      const rawCo2Slope = (zone.co2Ppm - memory.lastCo2Ppm) / Math.max(dtMinutes, 0.0833);

      memory.temperatureSlopeCPerMin = round(memory.temperatureSlopeCPerMin * 0.52 + rawTemperatureSlope * 0.48, 3);
      memory.co2SlopePpmPerMin = round(memory.co2SlopePpmPerMin * 0.58 + rawCo2Slope * 0.42, 2);
      memory.temperatureIntegralC = round(
        clamp(memory.temperatureIntegralC * 0.9 + (zone.temperatureC - targetMidpoint) * dtMinutes, -14, 14),
        3,
      );
      memory.co2IntegralPpm = round(
        clamp(memory.co2IntegralPpm * 0.92 + Math.max(0, zone.co2Ppm - co2Target) * dtMinutes, 0, 12_000),
        1,
      );
      memory.lastTemperatureC = zone.temperatureC;
      memory.lastCo2Ppm = zone.co2Ppm;
    }
  }

  private getActiveAssistPlan() {
    if (!this.runtimeState.assistPlan) {
      return null;
    }

    if (this.runtimeState.runtimeSeconds >= this.runtimeState.assistPlan.expiresAtRuntimeSeconds) {
      this.runtimeState.assistPlan = null;
      return null;
    }

    return this.runtimeState.assistPlan;
  }

  private pruneExpiredAssistPlan() {
    if (this.runtimeState.assistPlan && this.runtimeState.runtimeSeconds >= this.runtimeState.assistPlan.expiresAtRuntimeSeconds) {
      this.runtimeState.assistPlan = null;
    }
  }

  private async getWeather(now: Date) {
    if (this.controlState.weatherMode === "manual") {
      return {
        source: "open-meteo" as const,
        observedAt: now.toISOString(),
        temperatureC: this.controlState.weatherOverride.temperatureC,
        relativeHumidityPct: this.controlState.weatherOverride.relativeHumidityPct,
        windSpeedMps: this.controlState.weatherOverride.windSpeedMps,
        windDirectionDeg: this.controlState.weatherOverride.windDirectionDeg,
        cloudCoverPct: this.controlState.weatherOverride.cloudCoverPct,
        isStale: false,
      };
    }

    try {
      return await this.weatherService.getWeather(
        this.blueprint.building.location.latitude,
        this.blueprint.building.location.longitude,
        this.blueprint.building.timezone,
        now,
      );
    } catch {
      return {
        source: "open-meteo" as const,
        observedAt: now.toISOString(),
        temperatureC: this.sandboxTruth.weather.fallback_temperature_c,
        relativeHumidityPct: this.sandboxTruth.weather.fallback_relative_humidity_pct,
        windSpeedMps: 2,
        windDirectionDeg: 180,
        cloudCoverPct: 55,
        isStale: true,
      };
    }
  }

  private computeAchievableSupplyTemperature(
    sourceMode: SandboxSourceMode,
    requestedSupplyTemperatureC: number,
    mixedAirTemperatureC: number,
    outdoorTemperatureC: number,
    totalSupplyAirflowM3H: number,
  ) {
    const sourceTruth = this.sandboxTruth.equipment_truth.source_equipment;
    const mDotSupplyKgPerS = (Math.max(totalSupplyAirflowM3H, 200) / 3600) * 1.2;
    const capacityToDeltaTC = (capacityKw: number) => (capacityKw * 1000) / Math.max(mDotSupplyKgPerS * 1005, 1);

    if (sourceMode === "cooling") {
      const minimumAchievableSupplyTemperatureC = mixedAirTemperatureC - capacityToDeltaTC(sourceTruth.cooling_capacity_kw);
      return Math.max(requestedSupplyTemperatureC, minimumAchievableSupplyTemperatureC);
    }

    if (sourceMode === "heating") {
      const maximumAchievableSupplyTemperatureC = mixedAirTemperatureC + capacityToDeltaTC(sourceTruth.heating_capacity_kw);
      return Math.min(requestedSupplyTemperatureC, maximumAchievableSupplyTemperatureC);
    }

    if (sourceMode === "economizer") {
      const economizedSupplyTemperatureC =
        mixedAirTemperatureC -
        Math.max(0, mixedAirTemperatureC - outdoorTemperatureC) * sourceTruth.economizer_effectiveness;
      return Math.min(requestedSupplyTemperatureC, economizedSupplyTemperatureC);
    }

    return mixedAirTemperatureC;
  }

  private computeSupplyRelativeHumidityPct(
    sourceMode: SandboxSourceMode,
    mixedAirTemperatureC: number,
    mixedAirRhPct: number,
    supplyTemperatureC: number,
  ) {
    const mixedHumidityRatio = humidityRatioFromRh(mixedAirTemperatureC, mixedAirRhPct);

    if (sourceMode === "cooling") {
      const nearSaturatedLeavingHumidityRatio = humidityRatioFromRh(supplyTemperatureC, 92);
      return relativeHumidityFromHumidityRatio(
        supplyTemperatureC,
        Math.min(mixedHumidityRatio, nearSaturatedLeavingHumidityRatio),
      );
    }

    return relativeHumidityFromHumidityRatio(supplyTemperatureC, mixedHumidityRatio);
  }
}
