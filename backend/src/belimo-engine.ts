import {
  BuildingBlueprint,
  getNominalInfiltrationAch,
  getNominalThermalCapacitanceKjPerK,
  getNominalUaForSpace,
} from "./blueprint";
import { ProductDefinition } from "./catalog";
import {
  OUTDOOR_CO2_PPM,
  clamp,
  computeComfortScore,
  computeZoneCo2Step,
  computeZoneRhStep,
  computeZoneTemperatureStep,
  round,
} from "./physics";
import { DeviceDiagnosis, SandboxTickResult, TwinSnapshot, ZoneTwinState } from "./runtime-types";

type EstimatedZoneState = ZoneTwinState;

export class BelimoEngine {
  private readonly zoneState = new Map<string, EstimatedZoneState>();

  private readonly productById = new Map<string, ProductDefinition>();

  private lastObservedAt: Date | null = null;

  constructor(private readonly blueprint: BuildingBlueprint, products: ProductDefinition[]) {
    for (const product of products) {
      this.productById.set(product.id, product);
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
    const staticPressureTelemetry = batch.deviceReadings.find(
      (reading) => reading.productId === "belimo_22adp_154k_differential_pressure_sensor",
    )?.telemetry;
    const sourceTelemetry = batch.deviceReadings.find(
      (reading) => reading.productId === "non_belimo_daikin_rebel_dps_rooftop_heat_pump",
    )?.telemetry;

    for (const space of this.blueprint.spaces) {
      const previous = this.zoneState.get(space.id);

      if (!previous) {
        continue;
      }

      const roomSensor = this.blueprint.devices.find(
        (device) => device.product_id === "belimo_22rtm_5u00a_room_iaq_sensor" && device.served_space_ids.includes(space.id),
      );
      const branchDevice = this.blueprint.devices.find(
        (device) => device.kind === "actuator" && device.served_space_ids.includes(space.id),
      );
      const roomReading = roomSensor ? roomTelemetry.get(roomSensor.id) : null;
      const branchTelemetry = branchDevice ? actuatorTelemetry.get(branchDevice.id) : null;
      const supplyAirflowM3H = this.extractBranchAirflow(
        branchDevice?.product_id,
        branchTelemetry ?? undefined,
        branchDevice?.design.design_airflow_m3_h ?? 0,
      );
      const inferredOccupancy = roomReading
        ? Math.round(Math.max(0, (Number(roomReading.room_co2_ppm ?? OUTDOOR_CO2_PPM) - OUTDOOR_CO2_PPM) / 55))
        : previous.occupancyCount;
      const sourceSupplyTemperatureC = Number(sourceTelemetry?.supply_air_temperature_c ?? previous.temperatureC);
      const sensibleLoadW =
        inferredOccupancy * space.occupancy_design.sensible_gain_w_per_person +
        space.geometry.area_m2 * (space.internal_load_design.plug_w_per_m2 + space.internal_load_design.lighting_w_per_m2);
      const infiltrationAch = getNominalInfiltrationAch(space) * (1 + batch.weather.windSpeedMps / 8);
      const nominalUa = getNominalUaForSpace(this.blueprint, space.id);
      const nominalCapacitance = getNominalThermalCapacitanceKjPerK(this.blueprint, space.id);

      const predictedTemperatureC = computeZoneTemperatureStep({
        dtSeconds,
        zoneTemperatureC: previous.temperatureC,
        outdoorTemperatureC: batch.weather.temperatureC,
        supplyTemperatureC: sourceSupplyTemperatureC,
        supplyAirflowM3H,
        zoneVolumeM3: space.geometry.volume_m3,
        uaWPerK: nominalUa,
        thermalCapacitanceKjPerK: nominalCapacitance,
        infiltrationAch,
        sensibleInternalLoadW: sensibleLoadW,
      });
      const predictedCo2Ppm = computeZoneCo2Step({
        dtSeconds,
        zoneVolumeM3: space.geometry.volume_m3,
        zoneCo2Ppm: previous.co2Ppm,
        outdoorCo2Ppm: OUTDOOR_CO2_PPM,
        supplyAirflowM3H,
        infiltrationAch,
        occupancyCount: inferredOccupancy,
        co2GenerationLpsPerPerson: space.occupancy_design.co2_generation_lps_per_person,
      });
      const predictedRhPct = computeZoneRhStep({
        dtSeconds,
        zoneRhPct: previous.relativeHumidityPct,
        outdoorRhPct: batch.weather.relativeHumidityPct,
        supplyRhPct: batch.weather.relativeHumidityPct,
        supplyAirflowM3H,
        infiltrationAch,
        occupancyCount: inferredOccupancy,
        latentGainWPerPerson: space.occupancy_design.latent_gain_w_per_person,
        zoneVolumeM3: space.geometry.volume_m3,
      });

      const measuredTemperatureC = roomReading ? Number(roomReading.room_temperature_c) : predictedTemperatureC;
      const measuredRhPct = roomReading ? Number(roomReading.room_relative_humidity_pct) : predictedRhPct;
      const measuredCo2Ppm = roomReading ? Number(roomReading.room_co2_ppm) : predictedCo2Ppm;
      const estimatedTemperatureC = predictedTemperatureC * 0.45 + measuredTemperatureC * 0.55;
      const estimatedRhPct = predictedRhPct * 0.45 + measuredRhPct * 0.55;
      const estimatedCo2Ppm = predictedCo2Ppm * 0.4 + measuredCo2Ppm * 0.6;
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
        sensibleLoadW: round(sensibleLoadW),
        comfortScore: round(comfortScore),
      });
    }

    const zones = Array.from(this.zoneState.values());
    const deviceDiagnoses = this.computeDeviceDiagnoses(batch, zones);
    const averageComfortScore = zones.reduce((sum, zone) => sum + zone.comfortScore, 0) / zones.length;
    const worstZone = zones.reduce((worst, zone) => (zone.comfortScore < worst.comfortScore ? zone : worst), zones[0]);
    const staticPressurePa = Number(staticPressureTelemetry?.differential_pressure_pa ?? 0);
    const buildingCoolingDemandKw = round(
      zones
        .filter((zone) => zone.temperatureC > 23)
        .reduce((sum, zone) => sum + Math.max(0, zone.sensibleLoadW) / 1000, 0),
      2,
    );
    const buildingHeatingDemandKw = round(
      zones
        .filter((zone) => zone.temperatureC < 21)
        .reduce((sum, zone) => sum + Math.max(0, zone.sensibleLoadW) / 1200, 0),
      2,
    );

    const snapshot: TwinSnapshot = {
      buildingId: this.blueprint.blueprint_id,
      observedAt: observedAt.toISOString(),
      sourceKind: this.blueprint.source_type,
      summary: {
        averageComfortScore: round(averageComfortScore),
        worstZoneId: worstZone.zoneId,
        activeAlertCount: deviceDiagnoses.reduce((sum, diagnosis) => sum + diagnosis.alerts.length, 0),
        outdoorTemperatureC: round(batch.weather.temperatureC),
        supplyTemperatureC: Number(sourceTelemetry?.supply_air_temperature_c ?? 0),
      },
      weather: batch.weather,
      zones,
      devices: deviceDiagnoses,
      derived: {
        buildingCoolingDemandKw,
        buildingHeatingDemandKw,
        ventilationEffectivenessPct: round(
          clamp(
            100 -
              zones.reduce((sum, zone) => sum + Math.max(0, zone.co2Ppm - this.getSpace(zone.zoneId).comfort_targets.co2_limit_ppm) / 18, 0),
            45,
            100,
          ),
        ),
        staticPressurePa: round(staticPressurePa),
      },
    };

    return snapshot;
  }

  private computeDeviceDiagnoses(batch: SandboxTickResult, zones: ZoneTwinState[]): DeviceDiagnosis[] {
    const diagnoses: DeviceDiagnosis[] = [];
    const zoneById = new Map(zones.map((zone) => [zone.zoneId, zone]));
    const staticPressureReading = batch.deviceReadings.find(
      (reading) => reading.productId === "belimo_22adp_154k_differential_pressure_sensor",
    )?.telemetry;
    const staticPressurePa = Number(staticPressureReading?.differential_pressure_pa ?? 0);

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
        const servedZoneId = this.blueprint.devices.find((device) => device.id === reading.deviceId)?.served_space_ids[0];
        const servedZone = servedZoneId ? zoneById.get(servedZoneId) : null;
        const trackingError = Math.abs(setpoint - feedback);
        const obstructionRisk = clamp((trackingError / 18) * 45 + Math.max(0, torqueNmm - 1.3) * 20, 0, 100);
        metrics.tracking_error_pct = round(trackingError);
        metrics.obstruction_risk_pct = round(obstructionRisk);

        if (obstructionRisk > 55) {
          alerts.push("Mechanical obstruction suspected");
          healthScore -= 38;
        }

        if (servedZone && servedZone.comfortScore < 76 && setpoint > 70) {
          alerts.push("Zone under-conditioned despite high damper command");
          healthScore -= 18;
        }
      } else if (reading.productId === "belimo_nm24a_mod_air_damper_actuator") {
        const setpoint = Number(reading.telemetry.commanded_position_pct ?? 0);
        const feedback = Number(reading.telemetry.feedback_position_pct ?? 0);
        metrics.tracking_error_pct = round(Math.abs(setpoint - feedback));
        if (Number(metrics.tracking_error_pct) > 35) {
          alerts.push("Economizer damper tracking drift");
          healthScore -= 22;
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
        const zoneId = this.blueprint.devices.find((device) => device.id === reading.deviceId)?.served_space_ids[0];
        const zone = zoneId ? zoneById.get(zoneId) : null;
        metrics.zone_comfort_score = zone ? round(zone.comfortScore) : null;
        if (zone && zone.co2Ppm > this.getSpace(zone.zoneId).comfort_targets.co2_limit_ppm) {
          alerts.push("Ventilation quality below target");
          healthScore -= 20;
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
