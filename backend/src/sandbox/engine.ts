import { BuildingBlueprint, DeviceDefinition, SpaceDefinition } from "../blueprint";
import { ProductDefinition } from "../catalog";
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
  SandboxRuntimeFault,
  SandboxRuntimeState,
  SandboxSourceMode,
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
    products: ProductDefinition[],
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
    this.controlState = {
      sourceModePreference: "auto",
      zoneTemperatureOffsetsC: Object.fromEntries(blueprint.spaces.map((space) => [space.id, 0])),
      occupancyBias: 1,
      faultOverrides: Object.fromEntries(sandboxTruth.fault_profiles.map((fault) => [fault.id, "auto"])),
    };
    this.runtimeState = this.createInitialRuntimeState();
  }

  getTickSeconds() {
    return this.sandboxTruth.runtime.simulation_timestep_s;
  }

  getControlState() {
    return structuredClone(this.controlState);
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
    if (input.sourceModePreference) {
      this.controlState.sourceModePreference = input.sourceModePreference;
    }

    if (typeof input.occupancyBias === "number") {
      this.controlState.occupancyBias = clamp(input.occupancyBias, 0.4, 1.6);
    }

    if (input.zoneTemperatureOffsetsC) {
      for (const [zoneId, offset] of Object.entries(input.zoneTemperatureOffsetsC)) {
        if (zoneId in this.controlState.zoneTemperatureOffsetsC) {
          this.controlState.zoneTemperatureOffsetsC[zoneId] = clamp(offset, -3, 3);
        }
      }
    }

    if (input.faultOverrides) {
      for (const [faultId, mode] of Object.entries(input.faultOverrides)) {
        if (faultId in this.controlState.faultOverrides) {
          this.controlState.faultOverrides[faultId] = mode;
        }
      }
    }

    return this.getControlState();
  }

  async tick(now = new Date()): Promise<SandboxTickResult> {
    const dtSeconds = this.sandboxTruth.runtime.simulation_timestep_s;
    const weather = await this.getWeather(now);

    this.runtimeState.runtimeSeconds += dtSeconds;
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
    const actuators = new Map<string, SandboxActuatorState>();

    for (const space of this.blueprint.spaces) {
      zones.set(space.id, {
        zoneId: space.id,
        temperatureC: 22.4,
        relativeHumidityPct: 44,
        co2Ppm: 520,
        occupancyCount: 0,
        supplyAirflowM3H: 0,
        sensibleLoadW: 0,
        comfortScore: 100,
      });
    }

    for (const device of this.blueprint.devices.filter((candidate) => candidate.kind === "actuator")) {
      actuators.set(device.id, createInitialActuatorState(device));
    }

    return {
      runtimeSeconds: 0,
      zones,
      actuators,
      filterLoadingFactor: this.sandboxTruth.equipment_truth.filter.baseline_loading_factor,
      sourceMode: "ventilation",
      supplyFanSpeedPct: 40,
      outdoorAirFraction: 0.22,
      mixedAirTemperatureC: 20,
      supplyTemperatureC: 18,
      supplyRelativeHumidityPct: 45,
      supplyCo2Ppm: OUTDOOR_CO2_PPM,
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
      const co2Demand = Math.max(0, (truth.co2Ppm - space.comfort_targets.co2_limit_ppm) / 200);
      const occupancyFloor = occupied ? 0.28 : 0.12;
      demandByZone[space.id] = clamp(occupancyFloor + Math.abs(tempError) * 0.22 + co2Demand, 0.15, 1.15);
    }

    return demandByZone;
  }

  private computeControls(zoneDemand: Record<string, number>, outdoorTemperatureC: number) {
    const averageDemand = Object.values(zoneDemand).reduce((sum, value) => sum + value, 0) / Object.keys(zoneDemand).length;
    const maxDemand = Math.max(...Object.values(zoneDemand));
    const occupiedZones = Array.from(this.runtimeState.zones.values()).filter((zone) => zone.occupancyCount > 0).length;
    const fanRange = this.blueprint.control_profiles.air_loop_design.supply_fan_speed_pct;
    const satRange = this.blueprint.control_profiles.air_loop_design.supply_air_temperature_reset_c;
    const supplyFanSpeedPct = clamp(fanRange[0] + maxDemand * (fanRange[1] - fanRange[0]), fanRange[0], fanRange[1]);
    const averageZoneTemp = this.averageOfZones("temperatureC");
    let maxWarmErrorC = 0;
    let maxColdErrorC = 0;

    for (const space of this.blueprint.spaces) {
      const zone = this.runtimeState.zones.get(space.id);

      if (!zone) {
        continue;
      }

      const occupied = zone.occupancyCount > 0;
      const targetBand = occupied ? space.comfort_targets.occupied_temperature_band_c : space.comfort_targets.unoccupied_temperature_band_c;
      const targetMidpoint = (targetBand[0] + targetBand[1]) / 2 + this.getZoneTemperatureOffset(space.id);
      maxWarmErrorC = Math.max(maxWarmErrorC, zone.temperatureC - targetMidpoint);
      maxColdErrorC = Math.max(maxColdErrorC, targetMidpoint - zone.temperatureC);
    }

    let sourceMode: SandboxSourceMode = "ventilation";
    let supplyTemperatureSetpointC = satRange[1];

    if (this.controlState.sourceModePreference === "cooling" || maxWarmErrorC > 0.45 || averageZoneTemp > 23.4) {
      sourceMode = "cooling";
      supplyTemperatureSetpointC = lerp(satRange[1], satRange[0], clamp(maxWarmErrorC / 3, 0, 1));
    } else if (this.controlState.sourceModePreference === "heating" || maxColdErrorC > 0.35 || outdoorTemperatureC < 8) {
      sourceMode = "heating";
      supplyTemperatureSetpointC = lerp(22, 31, clamp(maxColdErrorC / 4, 0, 1));
    } else if (
      this.controlState.sourceModePreference === "economizer" ||
      (outdoorTemperatureC < this.blueprint.control_profiles.air_loop_design.economizer_lockout_temperature_c &&
        occupiedZones > 0 &&
        maxWarmErrorC > 0.2)
    ) {
      sourceMode = "economizer";
      supplyTemperatureSetpointC = 16.5;
    } else if (this.controlState.sourceModePreference === "ventilation") {
      sourceMode = "ventilation";
      supplyTemperatureSetpointC = satRange[1];
    }

    const minOutdoor = this.getSourceDevice().design.minimum_outdoor_air_fraction ?? 0.18;
    const outdoorAirFraction =
      sourceMode === "economizer" ? clamp(0.45 + averageDemand * 0.35, minOutdoor, 0.95) : minOutdoor;

    return {
      sourceMode,
      supplyTemperatureSetpointC,
      supplyFanSpeedPct,
      outdoorAirFraction,
      damperCommands: this.computeDamperCommands(zoneDemand),
    };
  }

  private computeDamperCommands(zoneDemand: Record<string, number>) {
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

      commands[device.id] = computeZoneActuatorCommand(device.product_id, zoneDemand[servedZoneId]);
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
        solarGainMultiplier(weather.cloudCoverPct, hour, zoneTruth.solar_gain_scale);
      const plugLoadW = space.internal_load_design.plug_w_per_m2 * space.geometry.area_m2;
      const lightingLoadW = space.internal_load_design.lighting_w_per_m2 * space.geometry.area_m2;
      const occupancySensibleW = occupancyCount * space.occupancy_design.sensible_gain_w_per_person;
      const sensibleLoadW = solarGainW + plugLoadW + lightingLoadW + occupancySensibleW;
      const infiltrationAch = zoneTruth.effective_infiltration_ach * (1 + weather.windSpeedMps / 8);
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

  private async getWeather(now: Date) {
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
