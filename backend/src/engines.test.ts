import test from "node:test";
import assert from "node:assert/strict";

import { loadSandboxBlueprint } from "./blueprint";
import { loadProductsCatalog } from "./catalog";
import { BelimoEngine } from "./belimo-engine";
import { SandboxDataGenerationEngine } from "./sandbox/engine";
import { hasSandboxBehavior } from "./sandbox/product-behaviors";
import { OpenMeteoWeatherService } from "./sandbox/weather";
import { loadDefaultSandboxTruth } from "./sandbox-truth";

function createWeatherService(snapshot: {
  temperatureC: number;
  relativeHumidityPct: number;
  windSpeedMps: number;
  windDirectionDeg: number;
  cloudCoverPct: number;
}) {
  const weatherService = new OpenMeteoWeatherService("https://example.invalid");
  weatherService.getWeather = async (_latitude, _longitude, _timezone, now) => ({
    source: "open-meteo" as const,
    observedAt: now.toISOString(),
    isStale: false,
    ...snapshot,
  });
  return weatherService;
}

function createDynamicWeatherService(
  generator: (now: Date) => {
    temperatureC: number;
    relativeHumidityPct: number;
    windSpeedMps: number;
    windDirectionDeg: number;
    cloudCoverPct: number;
  },
) {
  const weatherService = new OpenMeteoWeatherService("https://example.invalid");
  weatherService.getWeather = async (_latitude, _longitude, _timezone, now) => ({
    source: "open-meteo" as const,
    observedAt: now.toISOString(),
    isStale: false,
    ...generator(now),
  });
  return weatherService;
}

function createSandboxEngine(options?: {
  weather?: Parameters<typeof createWeatherService>[0];
  disableNoise?: boolean;
  disableFaults?: boolean;
}) {
  const blueprint = loadSandboxBlueprint();
  const products = loadProductsCatalog().products;
  const truth = structuredClone(loadDefaultSandboxTruth());

  if (options?.disableNoise) {
    truth.sensor_noise = {
      temperature_c_sigma: 0,
      humidity_pct_sigma: 0,
      co2_ppm_sigma: 0,
      pressure_pa_sigma: 0,
      airflow_m3_h_sigma: 0,
    };
  }

  if (options?.disableFaults) {
    truth.fault_profiles = truth.fault_profiles.map((fault) => ({
      ...fault,
      activation_runtime_s: 999_999_999,
    }));
  }

  return {
    blueprint,
    truth,
    products,
    sandbox: new SandboxDataGenerationEngine(
      blueprint,
      truth,
      products,
      createWeatherService(
        options?.weather ?? {
          temperatureC: 31,
          relativeHumidityPct: 58,
          windSpeedMps: 2.2,
          windDirectionDeg: 180,
          cloudCoverPct: 22,
        },
      ),
    ),
  };
}

function getTelemetrySchemaMap() {
  return new Map(
    loadProductsCatalog().products.map((product) => [
      product.id,
      new Set(product.telemetry_schema.map((entry) => String(entry.name))),
    ]),
  );
}

test("every sandbox blueprint product is backed by an explicit behavior module", () => {
  const blueprint = loadSandboxBlueprint();

  for (const device of blueprint.devices) {
    assert.ok(hasSandboxBehavior(device.product_id), `Missing sandbox behavior for ${device.product_id}`);
  }
});

test("sandbox emits telemetry for every device and exposes derived AHU air-state signals", async () => {
  const { blueprint, sandbox } = createSandboxEngine();
  const batch = await sandbox.tick(new Date("2026-03-19T10:00:00+01:00"));

  assert.equal(batch.deviceReadings.length, blueprint.devices.length);

  const sourceReading = batch.deviceReadings.find((reading) => reading.deviceId === "rtu-1");
  assert.ok(sourceReading);
  assert.equal(typeof sourceReading.telemetry.mixed_air_temperature_c, "number");
  assert.equal(typeof sourceReading.telemetry.outdoor_air_fraction, "number");
  assert.equal(typeof sourceReading.telemetry.supply_air_co2_ppm, "number");

  const humidityReading = batch.deviceReadings.find((reading) => reading.deviceId === "supply-air-humidity-1");
  assert.ok(humidityReading);
  assert.equal(typeof humidityReading.telemetry.dew_point_c, "number");
});

test("sandbox telemetry stays conformant with products.json and within product-plausible envelopes", async () => {
  const { sandbox, truth } = createSandboxEngine({
    weather: {
      temperatureC: 30,
      relativeHumidityPct: 61,
      windSpeedMps: 2.5,
      windDirectionDeg: 180,
      cloudCoverPct: 28,
    },
  });
  const telemetrySchemas = getTelemetrySchemaMap();
  let now = new Date("2026-03-19T09:00:00+01:00");

  for (let tick = 0; tick < 180; tick += 1) {
    const batch = await sandbox.tick(now);

    for (const reading of batch.deviceReadings) {
      const allowedKeys = telemetrySchemas.get(reading.productId);
      assert.ok(allowedKeys, `Missing telemetry schema for ${reading.productId}`);
      assert.deepEqual(
        new Set(Object.keys(reading.telemetry)),
        allowedKeys,
        `Telemetry keys for ${reading.deviceId} diverge from products.json`,
      );

      if (reading.productId === "belimo_nm24a_mod_air_damper_actuator") {
        assert.ok(Number(reading.telemetry.estimated_torque_nm) >= 0);
        assert.ok(Number(reading.telemetry.estimated_torque_nm) <= 10.5);
      }

      if (reading.productId === "belimo_nmv_d3_mp_vav_compact") {
        assert.ok(Number(reading.telemetry.airflow_measured_m3_h) >= 0);
        assert.ok(Number(reading.telemetry.dynamic_pressure_pa) >= 0);
        assert.ok(Number(reading.telemetry.dynamic_pressure_pa) <= 2500);
      }

      if (reading.productId === "belimo_22adp_154k_differential_pressure_sensor") {
        assert.ok(Number(reading.telemetry.differential_pressure_pa) >= -100);
        assert.ok(Number(reading.telemetry.differential_pressure_pa) <= 2500);
      }

      if (reading.productId === "belimo_22rtm_5u00a_room_iaq_sensor") {
        assert.ok(Number(reading.telemetry.room_co2_ppm) >= 0);
        assert.ok(Number(reading.telemetry.room_co2_ppm) <= 2000);
        assert.ok(Number(reading.telemetry.room_relative_humidity_pct) >= 0);
        assert.ok(Number(reading.telemetry.room_relative_humidity_pct) <= 100);
        assert.ok(Number(reading.telemetry.room_temperature_c) >= 0);
        assert.ok(Number(reading.telemetry.room_temperature_c) <= 50);
      }

      if (reading.productId === "non_belimo_daikin_rebel_dps_rooftop_heat_pump") {
        assert.ok(Number(reading.telemetry.outdoor_air_fraction) >= 0.12);
        assert.ok(Number(reading.telemetry.outdoor_air_fraction) <= 0.95);
        assert.ok(Number(reading.telemetry.supply_airflow_m3_h) >= 0);
        assert.ok(Number(reading.telemetry.supply_airflow_m3_h) <= Number(reading.telemetry.design_supply_airflow_m3_h) * 1.15);
      }
    }

    now = new Date(now.getTime() + truth.runtime.simulation_timestep_s * 1000);
  }
});

test("sandbox sample LM actuator stays inside the observed real-device operating envelope", async () => {
  const { sandbox, truth } = createSandboxEngine({
    weather: {
      temperatureC: 31,
      relativeHumidityPct: 55,
      windSpeedMps: 2,
      windDirectionDeg: 180,
      cloudCoverPct: 35,
    },
    disableNoise: true,
    disableFaults: true,
  });
  const movingSamples: Array<{ powerW: number; torqueNmm: number }> = [];
  let now = new Date("2026-03-19T09:00:00+01:00");

  for (let tick = 0; tick < 720; tick += 1) {
    if (tick === 20) {
      sandbox.updateControls({ zoneTemperatureOffsetsC: { open_office: -2.5 } });
    }
    if (tick === 140) {
      sandbox.updateControls({ zoneTemperatureOffsetsC: { open_office: 2.5 } });
    }
    if (tick === 260) {
      sandbox.updateControls({ zoneTemperatureOffsetsC: { open_office: -1.5 } });
    }

    const batch = await sandbox.tick(now);
    const officeDamper = batch.deviceReadings.find((reading) => reading.deviceId === "zone-damper-office-1");
    assert.ok(officeDamper);

    const trackingError = Math.abs(
      Number(officeDamper.telemetry["setpoint_position_%"] ?? 0) -
        Number(officeDamper.telemetry["feedback_position_%"] ?? 0),
    );

    if (trackingError > 1) {
      movingSamples.push({
        powerW: Number(officeDamper.telemetry.power_W ?? 0),
        torqueNmm: Number(officeDamper.telemetry.motor_torque_Nmm ?? 0),
      });
    }

    now = new Date(now.getTime() + truth.runtime.simulation_timestep_s * 1000);
  }

  assert.ok(movingSamples.length >= 2);

  const meanPowerW = movingSamples.reduce((sum, sample) => sum + sample.powerW, 0) / movingSamples.length;
  const meanTorqueNmm = movingSamples.reduce((sum, sample) => sum + sample.torqueNmm, 0) / movingSamples.length;
  const maxPowerW = Math.max(...movingSamples.map((sample) => sample.powerW));
  const maxTorqueNmm = Math.max(...movingSamples.map((sample) => sample.torqueNmm));

  assert.ok(meanPowerW >= 0.2 && meanPowerW <= 0.65);
  assert.ok(meanTorqueNmm >= 1 && meanTorqueNmm <= 2.2);
  assert.ok(maxPowerW <= 1.6);
  assert.ok(maxTorqueNmm <= 2.5);
});

test("Belimo engine reconstructs sandbox zone state with low physical-state error", async () => {
  const { sandbox, truth, products } = createSandboxEngine({
    weather: {
      temperatureC: 31,
      relativeHumidityPct: 58,
      windSpeedMps: 2.2,
      windDirectionDeg: 180,
      cloudCoverPct: 22,
    },
    disableNoise: true,
    disableFaults: true,
  });
  const twin = new BelimoEngine(loadSandboxBlueprint(), products);
  const errors: Array<{ temp: number; rh: number; co2: number; occ: number }> = [];
  let latestBatch: Awaited<ReturnType<SandboxDataGenerationEngine["tick"]>> | null = null;
  let latestSnapshot: ReturnType<BelimoEngine["ingest"]> | null = null;
  let now = new Date("2026-03-19T10:00:00+01:00");

  for (let tick = 0; tick < 360; tick += 1) {
    latestBatch = await sandbox.tick(now);
    latestSnapshot = twin.ingest(latestBatch);

    if (tick >= 300) {
      for (const zone of latestSnapshot.zones) {
        const truthZone = latestBatch.truth.zones.find((candidate) => candidate.zoneId === zone.zoneId);
        assert.ok(truthZone);
        errors.push({
          temp: Math.abs(zone.temperatureC - truthZone.temperatureC),
          rh: Math.abs(zone.relativeHumidityPct - truthZone.relativeHumidityPct),
          co2: Math.abs(zone.co2Ppm - truthZone.co2Ppm),
          occ: Math.abs(zone.occupancyCount - truthZone.occupancyCount),
        });
      }
    }

    now = new Date(now.getTime() + truth.runtime.simulation_timestep_s * 1000);
  }

  assert.ok(latestBatch);
  assert.ok(latestSnapshot);

  const mae = {
    temp: errors.reduce((sum, error) => sum + error.temp, 0) / errors.length,
    rh: errors.reduce((sum, error) => sum + error.rh, 0) / errors.length,
    co2: errors.reduce((sum, error) => sum + error.co2, 0) / errors.length,
    occ: errors.reduce((sum, error) => sum + error.occ, 0) / errors.length,
  };
  const truthCoolingDemandKw = latestBatch.truth.zones.reduce((sum, zone) => sum + Math.max(0, zone.sensibleLoadW) / 1000, 0);
  const coolingDemandRatio =
    latestSnapshot.derived.buildingCoolingDemandKw / Math.max(truthCoolingDemandKw, 0.1);

  assert.ok(mae.temp <= 0.15);
  assert.ok(mae.rh <= 0.5);
  assert.ok(mae.co2 <= 5);
  assert.ok(mae.occ <= 2.5);
  assert.ok(coolingDemandRatio >= 0.7 && coolingDemandRatio <= 1.6);
});

test("Belimo engine diagnoses an obstructed sample actuator", async () => {
  const { sandbox, truth, products } = createSandboxEngine({
    weather: {
      temperatureC: 31,
      relativeHumidityPct: 55,
      windSpeedMps: 2,
      windDirectionDeg: 180,
      cloudCoverPct: 30,
    },
    disableNoise: true,
  });
  const twin = new BelimoEngine(loadSandboxBlueprint(), products);
  sandbox.updateControls({
    zoneTemperatureOffsetsC: { open_office: -2.5 },
    faultOverrides: { "mouse-obstruction-open-office": "forced_on" },
  });

  let snapshot: ReturnType<BelimoEngine["ingest"]> | null = null;
  let now = new Date("2026-03-19T11:00:00+01:00");

  for (let tick = 0; tick < 240; tick += 1) {
    const batch = await sandbox.tick(now);
    snapshot = twin.ingest(batch);
    now = new Date(now.getTime() + truth.runtime.simulation_timestep_s * 1000);
  }

  assert.ok(snapshot);

  const officeDamperDiagnosis = snapshot.devices.find((device) => device.deviceId === "zone-damper-office-1");
  assert.ok(officeDamperDiagnosis);
  assert.ok(officeDamperDiagnosis.alerts.includes("Mechanical obstruction suspected"));
  assert.ok(officeDamperDiagnosis.healthScore <= 60);
});

test("end-to-end HVAC envelopes stay plausible across a full day with variable weather", async () => {
  const blueprint = loadSandboxBlueprint();
  const products = loadProductsCatalog().products;
  const truth = structuredClone(loadDefaultSandboxTruth());
  truth.sensor_noise = {
    temperature_c_sigma: 0,
    humidity_pct_sigma: 0,
    co2_ppm_sigma: 0,
    pressure_pa_sigma: 0,
    airflow_m3_h_sigma: 0,
  };
  truth.fault_profiles = truth.fault_profiles.map((fault) => ({
    ...fault,
    activation_runtime_s: 999_999_999,
  }));

  const sandbox = new SandboxDataGenerationEngine(
    blueprint,
    truth,
    products,
    createDynamicWeatherService((now) => {
      const hour = now.getHours() + now.getMinutes() / 60;
      const dayWave = Math.sin(((hour - 6) / 24) * Math.PI * 2);
      return {
        temperatureC: 10 + dayWave * 11,
        relativeHumidityPct: 72 - dayWave * 18,
        windSpeedMps: 1.5 + Math.max(0, dayWave) * 2.5,
        windDirectionDeg: 180,
        cloudCoverPct: 40 + Math.max(0, -dayWave) * 30,
      };
    }),
  );
  const twin = new BelimoEngine(blueprint, products);
  const extrema = {
    tempMin: Number.POSITIVE_INFINITY,
    tempMax: Number.NEGATIVE_INFINITY,
    rhMin: Number.POSITIVE_INFINITY,
    rhMax: Number.NEGATIVE_INFINITY,
    co2Min: Number.POSITIVE_INFINITY,
    co2Max: Number.NEGATIVE_INFINITY,
    satMin: Number.POSITIVE_INFINITY,
    satMax: Number.NEGATIVE_INFINITY,
    staticMin: Number.POSITIVE_INFINITY,
    staticMax: Number.NEGATIVE_INFINITY,
    comfortMin: Number.POSITIVE_INFINITY,
  };
  let now = new Date("2026-03-19T00:00:00+01:00");

  for (let tick = 0; tick < 17_280; tick += 1) {
    const batch = await sandbox.tick(now);
    const snapshot = twin.ingest(batch);

    for (const zone of snapshot.zones) {
      extrema.tempMin = Math.min(extrema.tempMin, zone.temperatureC);
      extrema.tempMax = Math.max(extrema.tempMax, zone.temperatureC);
      extrema.rhMin = Math.min(extrema.rhMin, zone.relativeHumidityPct);
      extrema.rhMax = Math.max(extrema.rhMax, zone.relativeHumidityPct);
      extrema.co2Min = Math.min(extrema.co2Min, zone.co2Ppm);
      extrema.co2Max = Math.max(extrema.co2Max, zone.co2Ppm);
      extrema.comfortMin = Math.min(extrema.comfortMin, zone.comfortScore);
    }

    extrema.satMin = Math.min(extrema.satMin, snapshot.summary.supplyTemperatureC);
    extrema.satMax = Math.max(extrema.satMax, snapshot.summary.supplyTemperatureC);
    extrema.staticMin = Math.min(extrema.staticMin, snapshot.derived.staticPressurePa);
    extrema.staticMax = Math.max(extrema.staticMax, snapshot.derived.staticPressurePa);
    now = new Date(now.getTime() + truth.runtime.simulation_timestep_s * 1000);
  }

  assert.ok(extrema.tempMin >= 19);
  assert.ok(extrema.tempMax <= 24);
  assert.ok(extrema.rhMin >= 20);
  assert.ok(extrema.rhMax <= 65);
  assert.ok(extrema.co2Min >= 400);
  assert.ok(extrema.co2Max <= 1_050);
  assert.ok(extrema.satMin >= 17);
  assert.ok(extrema.satMax <= 31);
  assert.ok(extrema.staticMin >= 140);
  assert.ok(extrema.staticMax <= 650);
  assert.ok(extrema.comfortMin >= 80);
});
