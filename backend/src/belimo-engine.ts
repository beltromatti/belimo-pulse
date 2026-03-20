import {
  BuildingBlueprint,
  DeviceDefinition,
  getConstructionById,
  getNominalInfiltrationAch,
  getNominalThermalCapacitanceKjPerK,
  getNominalUaForSpace,
} from "./blueprint";
import { ProductDefinition } from "./catalog";
import {
  AIR_DENSITY_KG_PER_M3,
  AIR_HEAT_CAPACITY_J_PER_KG_K,
  OUTDOOR_CO2_PPM,
  clamp,
  computeComfortScore,
  computeZoneCo2Step,
  computeZoneRhStep,
  computeZoneTemperatureStep,
  round,
  solarGainMultiplier,
} from "./physics";
import { DeviceDiagnosis, SandboxTickResult, TwinSnapshot, ZoneTwinState } from "./runtime-types";

type EstimatedZoneState = ZoneTwinState;

export class BelimoEngine {
  private readonly zoneState = new Map<string, EstimatedZoneState>();

  private readonly productById = new Map<string, ProductDefinition>();

  private readonly deviceById = new Map<string, DeviceDefinition>();

  private lastObservedAt: Date | null = null;

  constructor(private readonly blueprint: BuildingBlueprint, products: ProductDefinition[]) {
    for (const product of products) {
      this.productById.set(product.id, product);
    }

    for (const device of blueprint.devices) {
      this.deviceById.set(device.id, device);
    }

    for (const space of blueprint.spaces) {
      this.zoneState.set(space.id, {
        zoneId: space.id,
        temperatureC: 22,
        relativeHumidityPct: 45,
        co2Ppm: 550,
        occupancyCount: 0,
        supplyAirflowM3H: 0,
        sensibleLoadW: 0,
        comfortScore: 100,
      });
    }
  }

  ingest(batch: SandboxTickResult) {
    const observedAt = new Date(batch.observedAt);
    const dtSeconds = this.lastObservedAt
      ? clamp((observedAt.getTime() - this.lastObservedAt.getTime()) / 1000, 1, 900)
      : 5;
    this.lastObservedAt = observedAt;

    const roomTelemetry = new Map(
      batch.deviceReadings
        .filter((reading) => reading.productId === "belimo_22rtm_5u00a_room_iaq_sensor")
        .map((reading) => [reading.deviceId, reading.telemetry]),
    );
    const actuatorTelemetry = new Map(
      batch.deviceReadings
        .filter((reading) => this.productById.get(reading.productId)?.category === "actuator")
        .map((reading) => [reading.deviceId, reading.telemetry]),
    );
    const telemetryByDeviceId = new Map(batch.deviceReadings.map((reading) => [reading.deviceId, reading.telemetry]));
    const sourceTelemetry = batch.deviceReadings.find(
      (reading) => reading.productId === "non_belimo_daikin_rebel_dps_rooftop_heat_pump",
    )?.telemetry;
    const staticPressureTelemetry = telemetryByDeviceId.get("duct-static-1");
    const mixedAirTelemetry = telemetryByDeviceId.get("mixed-air-temp-1");
    const supplyAirTempTelemetry = telemetryByDeviceId.get("supply-air-temp-1");
    const supplyAirHumidityTelemetry = telemetryByDeviceId.get("supply-air-humidity-1");

    const returnTemperatureC = Number(sourceTelemetry?.return_air_temperature_c ?? this.averageZoneState("temperatureC"));
    const returnCo2Ppm = this.averageRoomTelemetry(roomTelemetry, "room_co2_ppm", "co2Ppm");
    const mixedAirTemperatureC = Number(mixedAirTelemetry?.temperature_c ?? returnTemperatureC);
    const supplyTemperatureC = Number(
      supplyAirTempTelemetry?.temperature_c ?? sourceTelemetry?.supply_air_temperature_c ?? returnTemperatureC,
    );
    const supplyRhPct = Number(
      supplyAirHumidityTelemetry?.relative_humidity_pct ?? batch.weather.relativeHumidityPct,
    );
    const outdoorAirFraction = this.inferOutdoorAirFraction(
      batch.weather.temperatureC,
      returnTemperatureC,
      mixedAirTemperatureC,
      Number(sourceTelemetry?.outdoor_air_fraction ?? 0.22),
    );
    const supplyCo2Ppm = round(OUTDOOR_CO2_PPM * outdoorAirFraction + returnCo2Ppm * (1 - outdoorAirFraction));
    const totalSupplyAirflowM3H = Number(sourceTelemetry?.supply_airflow_m3_h ?? 0);
    const branchAirflows = this.estimateBranchAirflows(totalSupplyAirflowM3H, actuatorTelemetry, staticPressureTelemetry);
    const hourOfDay = observedAt.getHours() + observedAt.getMinutes() / 60;

    for (const space of this.blueprint.spaces) {
      const previous = this.zoneState.get(space.id);

      if (!previous) {
        continue;
      }

      const roomSensor = this.findRoomSensor(space.id);
      const branchDevice = this.findPrimaryActuator(space.id);
      const roomReading = roomSensor ? roomTelemetry.get(roomSensor.id) : null;
      const branchTelemetry = branchDevice ? actuatorTelemetry.get(branchDevice.id) : null;
      const supplyAirflowM3H =
        branchDevice && branchAirflows.has(branchDevice.id)
          ? branchAirflows.get(branchDevice.id) ?? 0
          : this.extractBranchAirflow(
              branchDevice?.product_id,
              branchTelemetry ?? undefined,
              branchDevice?.design.design_airflow_m3_h ?? 0,
            );
      const measuredTemperatureC = roomReading ? Number(roomReading.room_temperature_c) : previous.temperatureC;
      const measuredRhPct = roomReading ? Number(roomReading.room_relative_humidity_pct) : previous.relativeHumidityPct;
      const measuredCo2Ppm = roomReading ? Number(roomReading.room_co2_ppm) : previous.co2Ppm;
      const infiltrationAch = getNominalInfiltrationAch(space) * (1 + batch.weather.windSpeedMps / 8);
      const nominalUa = getNominalUaForSpace(this.blueprint, space.id);
      const nominalCapacitance = getNominalThermalCapacitanceKjPerK(this.blueprint, space.id);
      const inferredOccupancy = this.inferZoneOccupancy({
        space,
        previous,
        measuredCo2Ppm,
        supplyCo2Ppm,
        supplyAirflowM3H,
        infiltrationAch,
        dtSeconds,
      });
      const inferredSensibleLoadW = this.inferZoneSensibleLoadW({
        space,
        previous,
        measuredTemperatureC,
        outdoorTemperatureC: batch.weather.temperatureC,
        supplyTemperatureC,
        supplyAirflowM3H,
        infiltrationAch,
        dtSeconds,
        nominalUa,
        nominalCapacitance,
        inferredOccupancy,
        cloudCoverPct: batch.weather.cloudCoverPct,
        hourOfDay,
      });

      const predictedTemperatureC = computeZoneTemperatureStep({
        dtSeconds,
        zoneTemperatureC: previous.temperatureC,
        outdoorTemperatureC: batch.weather.temperatureC,
        supplyTemperatureC,
        supplyAirflowM3H,
        zoneVolumeM3: space.geometry.volume_m3,
        uaWPerK: nominalUa,
        thermalCapacitanceKjPerK: nominalCapacitance,
        infiltrationAch,
        sensibleInternalLoadW: inferredSensibleLoadW,
      });
      const predictedCo2Ppm = computeZoneCo2Step({
        dtSeconds,
        zoneVolumeM3: space.geometry.volume_m3,
        zoneCo2Ppm: previous.co2Ppm,
        outdoorCo2Ppm: OUTDOOR_CO2_PPM,
        supplyCo2Ppm,
        supplyAirflowM3H,
        infiltrationAch,
        occupancyCount: inferredOccupancy,
        co2GenerationLpsPerPerson: space.occupancy_design.co2_generation_lps_per_person,
      });
      const predictedRhPct = computeZoneRhStep({
        dtSeconds,
        zoneTemperatureC: previous.temperatureC,
        outdoorTemperatureC: batch.weather.temperatureC,
        supplyTemperatureC,
        zoneRhPct: previous.relativeHumidityPct,
        outdoorRhPct: batch.weather.relativeHumidityPct,
        supplyRhPct,
        supplyAirflowM3H,
        infiltrationAch,
        occupancyCount: inferredOccupancy,
        latentGainWPerPerson: space.occupancy_design.latent_gain_w_per_person,
        zoneVolumeM3: space.geometry.volume_m3,
      });

      const estimatedTemperatureC = predictedTemperatureC * 0.38 + measuredTemperatureC * 0.62;
      const estimatedRhPct = predictedRhPct * 0.42 + measuredRhPct * 0.58;
      const estimatedCo2Ppm = predictedCo2Ppm * 0.35 + measuredCo2Ppm * 0.65;
      const occupied = inferredOccupancy > 0;
      const temperatureBand = occupied ? space.comfort_targets.occupied_temperature_band_c : space.comfort_targets.unoccupied_temperature_band_c;
      const comfortScore = computeComfortScore(
        estimatedTemperatureC,
        estimatedRhPct,
        estimatedCo2Ppm,
        temperatureBand,
        space.comfort_targets.humidity_band_pct,
        space.comfort_targets.co2_limit_ppm,
      );

      this.zoneState.set(space.id, {
        zoneId: space.id,
        temperatureC: round(estimatedTemperatureC),
        relativeHumidityPct: round(estimatedRhPct),
        co2Ppm: round(estimatedCo2Ppm),
        occupancyCount: inferredOccupancy,
        supplyAirflowM3H: round(supplyAirflowM3H),
        sensibleLoadW: round(inferredSensibleLoadW),
        comfortScore: round(comfortScore),
      });
    }

    const zones = Array.from(this.zoneState.values());
    const staticPressurePa = Number(staticPressureTelemetry?.differential_pressure_pa ?? 0);
    const deviceDiagnoses = this.computeDeviceDiagnoses(batch, zones, staticPressurePa);
    const averageComfortScore = zones.reduce((sum, zone) => sum + zone.comfortScore, 0) / zones.length;
    const worstZone = zones.reduce((worst, zone) => (zone.comfortScore < worst.comfortScore ? zone : worst), zones[0]);
    const buildingCoolingDemandKw = round(
      zones.reduce((sum, zone) => sum + Math.max(0, zone.sensibleLoadW) / 1000, 0),
      2,
    );
    const buildingHeatingDemandKw = round(
      zones.reduce((sum, zone) => sum + Math.max(0, -zone.sensibleLoadW) / 1000, 0),
      2,
    );
    const worstVentilationRatio = zones.reduce((worst, zone) => {
      const zoneLimit = this.getSpace(zone.zoneId).comfort_targets.co2_limit_ppm;
      const ratio = (zone.co2Ppm - supplyCo2Ppm) / Math.max(zoneLimit - supplyCo2Ppm, 50);
      return Math.max(worst, ratio);
    }, 0);

    return {
      buildingId: this.blueprint.blueprint_id,
      observedAt: observedAt.toISOString(),
      sourceKind: this.blueprint.source_type,
      summary: {
        averageComfortScore: round(averageComfortScore),
        worstZoneId: worstZone.zoneId,
        activeAlertCount: deviceDiagnoses.reduce((sum, diagnosis) => sum + diagnosis.alerts.length, 0),
        outdoorTemperatureC: round(batch.weather.temperatureC),
        supplyTemperatureC: round(supplyTemperatureC),
      },
      weather: batch.weather,
      zones,
      devices: deviceDiagnoses,
      derived: {
        buildingCoolingDemandKw,
        buildingHeatingDemandKw,
        ventilationEffectivenessPct: round(clamp(100 - Math.max(0, worstVentilationRatio - 1) * 34, 45, 100)),
        staticPressurePa: round(staticPressurePa),
      },
    };
  }

  private computeDeviceDiagnoses(
    batch: SandboxTickResult,
    zones: ZoneTwinState[],
    staticPressurePa: number,
  ): DeviceDiagnosis[] {
    const diagnoses: DeviceDiagnosis[] = [];
    const zoneById = new Map(zones.map((zone) => [zone.zoneId, zone]));

    for (const reading of batch.deviceReadings) {
      const product = this.productById.get(reading.productId);

      if (!product) {
        continue;
      }

      const alerts: string[] = [];
      const metrics: Record<string, number | string | boolean | null> = {};
      let healthScore = 96;

      if (reading.productId === "belimo_lm_series_sample_air_damper_actuator") {
        const setpoint = Number(reading.telemetry["setpoint_position_%"] ?? 0);
        const feedback = Number(reading.telemetry["feedback_position_%"] ?? 0);
        const torqueNmm = Number(reading.telemetry.motor_torque_Nmm ?? 0);
        const powerW = Number(reading.telemetry.power_W ?? 0);
        const servedZoneId = this.deviceById.get(reading.deviceId)?.served_space_ids[0];
        const servedZone = servedZoneId ? zoneById.get(servedZoneId) : null;
        const trackingError = Math.abs(setpoint - feedback);
        const highEffortRisk = clamp(
          Math.max(0, torqueNmm - 1.2) * 26 +
            Math.max(0, powerW - 0.4) * 42 +
            Math.max(0, trackingError - 6) * 2.1,
          0,
          100,
        );
        metrics.tracking_error_pct = round(trackingError);
        metrics.motor_torque_nmm = round(torqueNmm, 2);
        metrics.motor_power_w = round(powerW, 3);
        metrics.obstruction_risk_pct = round(highEffortRisk);
        const stalledAgainstCommand =
          trackingError > 12 &&
          setpoint >= 90 &&
          feedback <= setpoint - 10 &&
          powerW <= 0.12;

        if (highEffortRisk > 58 || stalledAgainstCommand) {
          alerts.push("Mechanical obstruction suspected");
          healthScore -= 40;
        } else if (trackingError > 10 && powerW > 0.3) {
          alerts.push("Actuator response slower than expected");
          healthScore -= 18;
        }

        if (servedZone && servedZone.comfortScore < 76 && feedback > 72) {
          alerts.push("Zone under-conditioned despite open damper");
          healthScore -= 16;
        }
      } else if (reading.productId === "belimo_nm24a_mod_air_damper_actuator") {
        const setpoint = Number(reading.telemetry.commanded_position_pct ?? 0);
        const feedback = Number(reading.telemetry.feedback_position_pct ?? 0);
        const bodyTemperatureC = Number(reading.telemetry.actuator_body_temperature_c ?? 0);
        const rotationDirection = String(reading.telemetry.rotation_direction ?? "idle");
        const trackingError = Math.abs(setpoint - feedback);
        metrics.tracking_error_pct = round(trackingError);
        metrics.actuator_body_temperature_c = round(bodyTemperatureC);
        if (trackingError > 18 && rotationDirection === "idle") {
          alerts.push("Economizer damper tracking drift");
          healthScore -= 20;
        }
        if (bodyTemperatureC > 42) {
          alerts.push("Actuator body temperature above normal envelope");
          healthScore -= 12;
        }
      } else if (reading.productId === "belimo_22adp_154k_differential_pressure_sensor") {
        metrics.static_pressure_pa = round(staticPressurePa);
        const airflowM3H = Number(reading.telemetry.estimated_airflow_m3_h ?? 0);
        const alarmState = String(reading.telemetry.alarm_state ?? "normal");
        if (staticPressurePa < 180) {
          alerts.push("Supply duct static pressure below design envelope");
          healthScore -= 24;
        }
        if (alarmState === "high_filter_drop" || (staticPressurePa > 420 && airflowM3H < 2800)) {
          alerts.push("Filter loading or fan-path restriction inferred");
          healthScore -= 28;
        }
      } else if (reading.productId === "belimo_22rtm_5u00a_room_iaq_sensor") {
        const zoneId = this.deviceById.get(reading.deviceId)?.served_space_ids[0];
        const zone = zoneId ? zoneById.get(zoneId) : null;
        metrics.zone_comfort_score = zone ? round(zone.comfortScore) : null;
        metrics.zone_occupancy_count = zone?.occupancyCount ?? null;
        if (zone && zone.co2Ppm > this.getSpace(zone.zoneId).comfort_targets.co2_limit_ppm) {
          alerts.push("Ventilation quality below target");
          healthScore -= 20;
        }
      } else if (reading.productId === "non_belimo_daikin_rebel_dps_rooftop_heat_pump") {
        const supplyTempC = Number(reading.telemetry.supply_air_temperature_c ?? 0);
        const returnTempC = Number(reading.telemetry.return_air_temperature_c ?? 0);
        const electricalPowerKw = Number(reading.telemetry.electrical_power_kw ?? 0);
        const runtimeSeconds = batch.operationalState.runtimeSeconds;
        const startupGraceActive = runtimeSeconds < 300;
        metrics.delta_t_c = round(returnTempC - supplyTempC);
        metrics.electrical_power_kw = round(electricalPowerKw, 2);
        if (
          !startupGraceActive &&
          electricalPowerKw > 1.5 &&
          String(reading.telemetry.operating_mode ?? "ventilation") === "cooling" &&
          returnTempC - supplyTempC < 5
        ) {
          alerts.push("Cooling section under-performing versus return air");
          healthScore -= 18;
        }
        if (
          !startupGraceActive &&
          electricalPowerKw > 1.5 &&
          String(reading.telemetry.operating_mode ?? "ventilation") === "heating" &&
          supplyTempC - returnTempC < 5
        ) {
          alerts.push("Heating section under-performing versus return air");
          healthScore -= 18;
        }
      }

      diagnoses.push({
        deviceId: reading.deviceId,
        productId: reading.productId,
        healthScore: clamp(round(healthScore), 0, 100),
        alerts,
        metrics,
      });
    }

    return diagnoses;
  }

  private inferZoneOccupancy(input: {
    space: BuildingBlueprint["spaces"][number];
    previous: EstimatedZoneState;
    measuredCo2Ppm: number;
    supplyCo2Ppm: number;
    supplyAirflowM3H: number;
    infiltrationAch: number;
    dtSeconds: number;
  }) {
    const zoneVolumeM3 = Math.max(input.space.geometry.volume_m3, 1);
    const ventilationM3PerS = input.supplyAirflowM3H / 3600;
    const infiltrationM3PerS = (zoneVolumeM3 * input.infiltrationAch) / 3600;
    const co2SlopePpmPerS = (input.measuredCo2Ppm - input.previous.co2Ppm) / Math.max(input.dtSeconds, 1);
    const requiredGenerationPpmPerS =
      co2SlopePpmPerS -
      (ventilationM3PerS / zoneVolumeM3) * (input.supplyCo2Ppm - input.previous.co2Ppm) -
      (infiltrationM3PerS / zoneVolumeM3) * (OUTDOOR_CO2_PPM - input.previous.co2Ppm);
    const generationM3PerS = Math.max(0, requiredGenerationPpmPerS) * zoneVolumeM3 / 1_000_000;
    const massBalanceOccupancy =
      generationM3PerS / Math.max(input.space.occupancy_design.co2_generation_lps_per_person / 1000, 0.000001);
    const excessCo2Occupancy = Math.max(0, (input.measuredCo2Ppm - input.supplyCo2Ppm) / 65);
    const blendedOccupancy = input.previous.occupancyCount * 0.35 + massBalanceOccupancy * 0.45 + excessCo2Occupancy * 0.2;
    return Math.round(clamp(blendedOccupancy, 0, input.space.occupancy_design.design_people));
  }

  private inferZoneSensibleLoadW(input: {
    space: BuildingBlueprint["spaces"][number];
    previous: EstimatedZoneState;
    measuredTemperatureC: number;
    outdoorTemperatureC: number;
    supplyTemperatureC: number;
    supplyAirflowM3H: number;
    infiltrationAch: number;
    dtSeconds: number;
    nominalUa: number;
    nominalCapacitance: number;
    inferredOccupancy: number;
    cloudCoverPct: number;
    hourOfDay: number;
  }) {
    const dt = Math.max(input.dtSeconds, 1);
    const capacitanceJPerK = input.nominalCapacitance * 1000;
    const mDotSupplyKgPerS = (input.supplyAirflowM3H / 3600) * AIR_DENSITY_KG_PER_M3;
    const mDotInfiltrationKgPerS =
      ((input.space.geometry.volume_m3 * input.infiltrationAch) / 3600) * AIR_DENSITY_KG_PER_M3;
    const storageW = (capacitanceJPerK * (input.measuredTemperatureC - input.previous.temperatureC)) / dt;
    const envelopeW = input.nominalUa * (input.outdoorTemperatureC - input.previous.temperatureC);
    const supplyW = mDotSupplyKgPerS * AIR_HEAT_CAPACITY_J_PER_KG_K * (input.supplyTemperatureC - input.previous.temperatureC);
    const infiltrationW =
      mDotInfiltrationKgPerS * AIR_HEAT_CAPACITY_J_PER_KG_K * (input.outdoorTemperatureC - input.previous.temperatureC);
    const occupancyBaseW = input.inferredOccupancy * input.space.occupancy_design.sensible_gain_w_per_person;
    const plugAndLightingW =
      input.space.geometry.area_m2 * (input.space.internal_load_design.plug_w_per_m2 + input.space.internal_load_design.lighting_w_per_m2);
    const nominalSolarGainW = this.estimateNominalSolarGainW(input.space, input.cloudCoverPct, input.hourOfDay);
    const inferredInternalW = storageW - envelopeW - supplyW - infiltrationW;
    const nominalInternalW = plugAndLightingW + occupancyBaseW + nominalSolarGainW;
    const boundedInternalW = clamp(
      inferredInternalW * 0.7 + nominalInternalW * 0.3,
      -0.35 * plugAndLightingW,
      Math.max(nominalInternalW * 1.85, 250),
    );
    return round(boundedInternalW);
  }

  private inferOutdoorAirFraction(
    outdoorTemperatureC: number,
    returnTemperatureC: number,
    mixedAirTemperatureC: number,
    fallback: number,
  ) {
    const denominator = outdoorTemperatureC - returnTemperatureC;

    if (Math.abs(denominator) < 0.4) {
      return clamp(fallback, 0.12, 0.95);
    }

    return clamp((mixedAirTemperatureC - returnTemperatureC) / denominator, 0.12, 0.95);
  }

  private averageRoomTelemetry(
    roomTelemetry: Map<string, Record<string, unknown>>,
    key: "room_temperature_c" | "room_relative_humidity_pct" | "room_co2_ppm",
    fallbackKey: keyof EstimatedZoneState,
  ) {
    if (roomTelemetry.size === 0) {
      return this.averageZoneState(fallbackKey);
    }

    const values = Array.from(roomTelemetry.values()).map((telemetry) => Number(telemetry[key] ?? 0));
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private estimateBranchAirflows(
    totalSupplyAirflowM3H: number,
    actuatorTelemetry: Map<string, Record<string, unknown>>,
    staticPressureTelemetry: Record<string, unknown> | undefined,
  ) {
    const knownFlows = new Map<string, number>();
    const weightedBranches: Array<{ deviceId: string; weight: number; maxFlowM3H: number }> = [];
    const staticPressurePa = Number(staticPressureTelemetry?.differential_pressure_pa ?? 320);
    const pressureFactor = clamp(Math.sqrt(Math.max(staticPressurePa, 25) / 320), 0.45, 1.2);

    for (const device of this.blueprint.devices.filter((candidate) => candidate.kind === "actuator")) {
      const telemetry = actuatorTelemetry.get(device.id);
      const designAirflowM3H = device.design.design_airflow_m3_h ?? 0;

      if (!telemetry || designAirflowM3H <= 0 || device.served_space_ids.length === 0) {
        continue;
      }

      if (device.product_id === "belimo_nmv_d3_mp_vav_compact") {
        knownFlows.set(device.id, Number(telemetry.airflow_measured_m3_h ?? 0));
        continue;
      }

      const feedbackPct =
        device.product_id === "belimo_nm24a_mod_air_damper_actuator"
          ? Number(telemetry.feedback_position_pct ?? 0)
          : Number(telemetry["feedback_position_%"] ?? 0);
      weightedBranches.push({
        deviceId: device.id,
        weight: designAirflowM3H * Math.pow(clamp(feedbackPct / 100, 0.05, 1), 2),
        maxFlowM3H: designAirflowM3H * 1.15 * pressureFactor,
      });
    }

    const inferred = new Map<string, number>(knownFlows);
    const remainingAirflowM3H = Math.max(0, totalSupplyAirflowM3H - Array.from(knownFlows.values()).reduce((sum, value) => sum + value, 0));
    const totalWeight = weightedBranches.reduce((sum, branch) => sum + branch.weight, 0);

    for (const branch of weightedBranches) {
      const proportionalFlow = totalWeight > 0 ? (branch.weight / totalWeight) * remainingAirflowM3H : 0;
      inferred.set(branch.deviceId, clamp(proportionalFlow, 0, branch.maxFlowM3H));
    }

    return inferred;
  }

  private estimateNominalSolarGainW(
    space: BuildingBlueprint["spaces"][number],
    cloudCoverPct: number,
    hourOfDay: number,
  ) {
    return space.envelope.transparent_surfaces.reduce((sum, surface) => {
      const construction = getConstructionById(this.blueprint, surface.construction_id);
      const gainFactor = construction.solar_heat_gain_coefficient ?? 0.32;
      return sum + surface.area_m2 * 155 * solarGainMultiplier(cloudCoverPct, hourOfDay, gainFactor);
    }, 0);
  }

  private averageZoneState(key: keyof EstimatedZoneState) {
    const zones = Array.from(this.zoneState.values());
    return zones.reduce((sum, zone) => sum + Number(zone[key]), 0) / Math.max(zones.length, 1);
  }

  private findRoomSensor(spaceId: string) {
    return this.blueprint.devices.find(
      (device) => device.product_id === "belimo_22rtm_5u00a_room_iaq_sensor" && device.served_space_ids.includes(spaceId),
    );
  }

  private findPrimaryActuator(spaceId: string) {
    return this.blueprint.devices.find((device) => device.kind === "actuator" && device.served_space_ids.includes(spaceId));
  }

  private extractBranchAirflow(productId: string | undefined, telemetry: Record<string, unknown> | undefined, designAirflowM3H: number) {
    if (!productId || !telemetry) {
      return 0;
    }

    if (productId === "belimo_nmv_d3_mp_vav_compact") {
      return Number(telemetry.airflow_measured_m3_h ?? 0);
    }

    if (productId === "belimo_lm_series_sample_air_damper_actuator") {
      return designAirflowM3H * (Number(telemetry["feedback_position_%"] ?? 0) / 100);
    }

    if (productId === "belimo_nm24a_mod_air_damper_actuator") {
      return designAirflowM3H * (Number(telemetry.feedback_position_pct ?? 0) / 100);
    }

    return 0;
  }

  private getSpace(spaceId: string) {
    const space = this.blueprint.spaces.find((candidate) => candidate.id === spaceId);

    if (!space) {
      throw new Error(`Unknown space ${spaceId}`);
    }

    return space;
  }
}
