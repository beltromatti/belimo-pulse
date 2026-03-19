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
  gaussianNoise,
  lerp,
  round,
  smoothStep,
  solarGainMultiplier,
} from "../physics";
import { DeviceTelemetryRecord, SandboxTickResult, ZoneTwinState } from "../runtime-types";
import { SandboxTruth } from "../sandbox-truth";
import { OpenMeteoWeatherService } from "./weather";

type MutableZoneTruth = ZoneTwinState;

type ActuatorTruth = {
  commandPct: number;
  feedbackPct: number;
  rotationDirection: 0 | 1 | 2;
  torqueNmm: number;
  powerW: number;
  bodyTemperatureC: number;
};

type RuntimeFault = {
  id: string;
  deviceId: string;
  faultType: string;
  severity: number;
  active: boolean;
};

type RuntimeState = {
  runtimeSeconds: number;
  zones: Map<string, MutableZoneTruth>;
  actuators: Map<string, ActuatorTruth>;
  filterLoadingFactor: number;
  sourceMode: "off" | "ventilation" | "cooling" | "heating" | "economizer";
  supplyFanSpeedPct: number;
  outdoorAirFraction: number;
  mixedAirTemperatureC: number;
  supplyTemperatureC: number;
  supplyRelativeHumidityPct: number;
};

export class SandboxDataGenerationEngine {
  private readonly random: () => number;

  private readonly spaceById: Map<string, SpaceDefinition>;

  private readonly deviceById: Map<string, DeviceDefinition>;

  private readonly productById: Map<string, ProductDefinition>;

  private readonly runtimeState: RuntimeState;

  private readonly runtimeFaults: RuntimeFault[];

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
    this.runtimeState = this.createInitialRuntimeState();
  }

  getTickSeconds() {
    return this.sandboxTruth.runtime.simulation_timestep_s;
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
    );

    const returnTemperatureC = this.averageOfZones("temperatureC");
    const returnRhPct = this.averageOfZones("relativeHumidityPct");
    this.runtimeState.mixedAirTemperatureC = computeMixedAirTemperature(
      weather.temperatureC,
      returnTemperatureC,
      this.runtimeState.outdoorAirFraction,
    );
    const mixedAirRhPct = computeMixedRelativeHumidity(
      weather.relativeHumidityPct,
      returnRhPct,
      this.runtimeState.outdoorAirFraction,
    );

    this.runtimeState.supplyTemperatureC = smoothStep(
      this.runtimeState.supplyTemperatureC,
      controls.supplyTemperatureSetpointC,
      dtSeconds * 0.16,
    );
    this.runtimeState.supplyRelativeHumidityPct = clamp(
      smoothStep(
        this.runtimeState.supplyRelativeHumidityPct,
        controls.sourceMode === "cooling" ? Math.min(mixedAirRhPct, 52) : mixedAirRhPct,
        dtSeconds * 0.5,
      ),
      20,
      80,
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
    const deviceReadings = this.buildDeviceReadings(
      observedAt,
      weather,
      branchFlows,
      staticPressurePa,
      mixedAirRhPct,
    );

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

  private createInitialRuntimeState(): RuntimeState {
    const zones = new Map<string, MutableZoneTruth>();
    const actuators = new Map<string, ActuatorTruth>();

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
      const truth = this.getActuatorTruth(device.id);
      actuators.set(device.id, {
        commandPct: 42,
        feedbackPct: 42,
        rotationDirection: 0,
        torqueNmm: truth.baseline_torque_nmm,
        powerW: device.product_id === "belimo_lm_series_sample_air_damper_actuator" ? 0.003 : 0.18,
        bodyTemperatureC: 29,
      });
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
      occupancyByZone[space.id] = Math.round(space.occupancy_design.design_people * baseFraction * peakFraction * randomness);
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
      const targetMidpoint = (targetBand[0] + targetBand[1]) / 2;
      const tempError = truth.temperatureC - targetMidpoint;
      const co2Demand = Math.max(0, (truth.co2Ppm - space.comfort_targets.co2_limit_ppm) / 200);
      demandByZone[space.id] = clamp(0.5 + tempError * 0.18 + co2Demand, 0.15, 1.15);
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

    let sourceMode: RuntimeState["sourceMode"] = "ventilation";
    let supplyTemperatureSetpointC = satRange[1];

    if (averageZoneTemp > 23.4) {
      sourceMode = "cooling";
      supplyTemperatureSetpointC = lerp(satRange[1], satRange[0], clamp((averageZoneTemp - 23.4) / 3, 0, 1));
    } else if (averageZoneTemp < 21.2 || outdoorTemperatureC < 8) {
      sourceMode = "heating";
      supplyTemperatureSetpointC = lerp(19, 31, clamp((21.2 - averageZoneTemp) / 4, 0, 1));
    } else if (outdoorTemperatureC < this.blueprint.control_profiles.air_loop_design.economizer_lockout_temperature_c && occupiedZones > 0) {
      sourceMode = "economizer";
      supplyTemperatureSetpointC = 16.5;
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

      if (device.product_id === "belimo_nmv_d3_mp_vav_compact") {
        commands[device.id] = clamp(28 + zoneDemand[servedZoneId] * 62, 20, 95);
        continue;
      }

      commands[device.id] = clamp(24 + zoneDemand[servedZoneId] * 68, 18, 98);
    }

    return commands;
  }

  private applyActuatorDynamics(commands: Record<string, number>, dtSeconds: number) {
    for (const [deviceId, actuator] of this.runtimeState.actuators.entries()) {
      const target = commands[deviceId] ?? actuator.commandPct;
      const truth = this.getActuatorTruth(deviceId);
      actuator.commandPct = target;
      let movementLimit = truth.max_rate_pct_per_s * dtSeconds;

      if (this.isFaultActive(deviceId, "mechanical_obstruction_inside_damper_or_actuator")) {
        movementLimit *= 0.28;
      }

      const biasedTarget = target + truth.baseline_tracking_bias_pct;
      const nextFeedback = smoothStep(actuator.feedbackPct, biasedTarget, movementLimit);
      actuator.rotationDirection = nextFeedback === actuator.feedbackPct ? 0 : nextFeedback > actuator.feedbackPct ? 1 : 2;
      actuator.feedbackPct = nextFeedback;

      const branchLoadFactor = clamp(Math.abs(target - nextFeedback) / 30, 0, 1);
      const obstruction = this.isFaultActive(deviceId, "mechanical_obstruction_inside_damper_or_actuator")
        ? this.getFaultSeverity("mechanical_obstruction_inside_damper_or_actuator", deviceId) * 3.2
        : 0;
      const isSampleLike = this.deviceById.get(deviceId)?.product_id === "belimo_lm_series_sample_air_damper_actuator";
      actuator.torqueNmm = isSampleLike
        ? round(truth.baseline_torque_nmm + branchLoadFactor * 0.9 + obstruction * 2.2, 2)
        : round(truth.baseline_torque_nmm + branchLoadFactor * 190 + obstruction * 180, 1);
      actuator.powerW = isSampleLike
        ? round(0.002 + branchLoadFactor * 0.04 + obstruction * 0.02, 3)
        : round(0.18 + branchLoadFactor * 0.16 + obstruction * 0.08, 3);
      actuator.bodyTemperatureC = round(lerp(actuator.bodyTemperatureC, 29 + actuator.powerW * 18, 0.16));
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
        supplyAirflowM3H,
        infiltrationAch,
        occupancyCount,
        co2GenerationLpsPerPerson: space.occupancy_design.co2_generation_lps_per_person,
      });
      zone.relativeHumidityPct = computeZoneRhStep({
        dtSeconds,
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
    mixedAirRhPct: number,
  ): DeviceTelemetryRecord[] {
    const readings: DeviceTelemetryRecord[] = [];
    const noise = this.sandboxTruth.sensor_noise;
    const activeFaults = this.runtimeFaults.filter((fault) => fault.active);

    for (const device of this.blueprint.devices) {
      const product = this.productById.get(device.product_id);

      if (!product) {
        throw new Error(`Missing product ${device.product_id} for device ${device.id}`);
      }

      if (device.kind === "source_equipment") {
        readings.push({
          deviceId: device.id,
          productId: device.product_id,
          category: product.category,
          observedAt,
          telemetry: {
            operating_mode: this.runtimeState.sourceMode,
            supply_air_temperature_c: round(this.runtimeState.supplyTemperatureC),
            return_air_temperature_c: round(this.averageOfZones("temperatureC")),
            outdoor_air_temperature_c: round(weather.temperatureC),
            supply_airflow_m3_h: round(Object.values(branchFlows).reduce((sum, flow) => sum + flow, 0)),
            electrical_power_kw: round(
              4.6 * (this.runtimeState.supplyFanSpeedPct / 100) +
                (this.runtimeState.sourceMode === "cooling" ? 7.2 : this.runtimeState.sourceMode === "heating" ? 6.8 : 1.1),
              2,
            ),
            fault_state: activeFaults.some((fault) => fault.faultType === "controller_fault") ? "controller_fault" : "none",
          },
        });
        continue;
      }

      if (product.category === "actuator") {
        const actuator = this.runtimeState.actuators.get(device.id);

        if (!actuator) {
          continue;
        }

        if (product.id === "belimo_nmv_d3_mp_vav_compact") {
          readings.push({
            deviceId: device.id,
            productId: product.id,
            category: product.category,
            observedAt,
            telemetry: {
              airflow_setpoint_m3_h: round((device.design.design_airflow_m3_h ?? 900) * (actuator.commandPct / 100)),
              airflow_measured_m3_h: round(branchFlows[device.id] + gaussianNoise(this.random, noise.airflow_m3_h_sigma)),
              damper_position_pct: round(actuator.feedbackPct),
              dynamic_pressure_pa: round(staticPressurePa * 0.42 + gaussianNoise(this.random, noise.pressure_pa_sigma)),
              zone_mode: "vav",
            },
          });
          continue;
        }

        if (product.id === "belimo_nm24a_mod_air_damper_actuator") {
          readings.push({
            deviceId: device.id,
            productId: product.id,
            category: product.category,
            observedAt,
            telemetry: {
              commanded_position_pct: round(actuator.commandPct),
              feedback_position_pct: round(actuator.feedbackPct),
              rotation_direction:
                actuator.rotationDirection === 0 ? "idle" : actuator.rotationDirection === 1 ? "opening" : "closing",
              estimated_torque_nm: round(actuator.torqueNmm / 1000, 3),
              actuator_body_temperature_c: round(actuator.bodyTemperatureC),
            },
          });
        } else {
          readings.push({
            deviceId: device.id,
            productId: product.id,
            category: product.category,
            observedAt,
            telemetry: {
              "setpoint_position_%": round(actuator.commandPct),
              "feedback_position_%": round(actuator.feedbackPct),
              rotation_direction: actuator.rotationDirection,
              motor_torque_Nmm: round(actuator.torqueNmm, 2),
              power_W: round(actuator.powerW, 3),
              internal_temperature_deg_C: round(actuator.bodyTemperatureC),
              test_number: -1,
            },
          });
        }
        continue;
      }

      const servedZone = device.served_space_ids[0] ? this.runtimeState.zones.get(device.served_space_ids[0]) : null;

      if (product.id === "belimo_22dt_12r_duct_temperature_sensor") {
        const reading = device.id === "mixed-air-temp-1" ? this.runtimeState.mixedAirTemperatureC : this.runtimeState.supplyTemperatureC;
        readings.push({
          deviceId: device.id,
          productId: product.id,
          category: product.category,
          observedAt,
          telemetry: {
            temperature_c: round(reading + gaussianNoise(this.random, noise.temperature_c_sigma)),
          },
        });
        continue;
      }

      if (product.id === "belimo_22dth_15m_duct_humidity_temperature_sensor") {
        readings.push({
          deviceId: device.id,
          productId: product.id,
          category: product.category,
          observedAt,
          telemetry: {
            temperature_c: round(this.runtimeState.supplyTemperatureC + gaussianNoise(this.random, noise.temperature_c_sigma)),
            relative_humidity_pct: round(this.runtimeState.supplyRelativeHumidityPct + gaussianNoise(this.random, noise.humidity_pct_sigma)),
            dew_point_c: round(this.runtimeState.supplyTemperatureC - (100 - this.runtimeState.supplyRelativeHumidityPct) / 5),
          },
        });
        continue;
      }

      if (product.id === "belimo_22adp_154k_differential_pressure_sensor") {
        const alarmState = this.runtimeState.filterLoadingFactor > 0.35 ? "high_filter_drop" : staticPressurePa < 180 ? "low_static" : "normal";
        readings.push({
          deviceId: device.id,
          productId: product.id,
          category: product.category,
          observedAt,
          telemetry: {
            differential_pressure_pa: round(staticPressurePa + gaussianNoise(this.random, noise.pressure_pa_sigma)),
            estimated_airflow_m3_h: round(
              Object.values(branchFlows).reduce((sum, flow) => sum + flow, 0) + gaussianNoise(this.random, noise.airflow_m3_h_sigma),
            ),
            alarm_state: alarmState,
          },
        });
        continue;
      }

      if (product.id === "belimo_22rtm_5u00a_room_iaq_sensor" && servedZone) {
        readings.push({
          deviceId: device.id,
          productId: product.id,
          category: product.category,
          observedAt,
          telemetry: {
            room_temperature_c: round(servedZone.temperatureC + gaussianNoise(this.random, noise.temperature_c_sigma)),
            room_relative_humidity_pct: round(servedZone.relativeHumidityPct + gaussianNoise(this.random, noise.humidity_pct_sigma)),
            room_co2_ppm: round(servedZone.co2Ppm + gaussianNoise(this.random, noise.co2_ppm_sigma)),
          },
        });
      }
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

      runtimeFault.active = this.runtimeState.runtimeSeconds >= profile.activation_runtime_s;
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
}
