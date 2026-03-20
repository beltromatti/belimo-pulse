import {
  decideAutomaticRemediation,
  deriveAutomaticIssueKey,
} from "./automatic-remediation";
import test from "node:test";
import assert from "node:assert/strict";

import { isOperatorPolicyActiveAt, resolveRuntimeControlResolution } from "./brain/policy-resolver";
import { loadSandboxBlueprint } from "./blueprint";
import { loadProductsCatalog } from "./catalog";
import { BelimoEngine } from "./belimo-engine";
import {
  assessRuntimeDrift,
  buildAssistPlanFromAssessment,
  refineAssistPlanFromOutcome,
  scoreTwinSnapshotAgainstControls,
} from "./control-intelligence";
import { SandboxDataGenerationEngine } from "./sandbox/engine";
import { hasSandboxBehavior } from "./sandbox/product-behaviors";
import { OpenMeteoWeatherService } from "./sandbox/weather";
import { loadDefaultSandboxTruth } from "./sandbox-truth";
import { OperatorPolicy, RuntimeControlState, TwinSnapshot } from "./runtime-types";

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

function createManualControls(): RuntimeControlState {
  const blueprint = loadSandboxBlueprint();
  const truth = loadDefaultSandboxTruth();

  return {
    sourceModePreference: "auto",
    zoneTemperatureOffsetsC: Object.fromEntries(blueprint.spaces.map((space) => [space.id, 0])),
    zoneCo2SetpointsPpm: Object.fromEntries(
      blueprint.spaces.map((space) => [space.id, space.comfort_targets.co2_limit_ppm]),
    ),
    supplyTemperatureTrimC: 0,
    ventilationBoostPct: 0,
    occupancyBias: 1,
    windowOpenFractionByZone: Object.fromEntries(blueprint.spaces.map((space) => [space.id, 0])),
    weatherMode: "live",
    weatherOverride: {
      temperatureC: truth.weather.fallback_temperature_c,
      relativeHumidityPct: truth.weather.fallback_relative_humidity_pct,
      windSpeedMps: 2,
      windDirectionDeg: 180,
      cloudCoverPct: 55,
    },
    timeMode: "live",
    timeSpeedMultiplier: 1,
    solarGainBias: 1,
    plugLoadBias: 1,
    faultOverrides: Object.fromEntries(truth.fault_profiles.map((fault) => [fault.id, "auto"])),
  };
}

function createOperatorPolicy(overrides: Partial<OperatorPolicy> & Pick<OperatorPolicy, "id" | "policyType" | "summary">): OperatorPolicy {
  return {
    id: overrides.id,
    buildingId: overrides.buildingId ?? "sandbox-office-v1",
    conversationId: overrides.conversationId,
    policyKey: overrides.policyKey ?? overrides.id,
    policyType: overrides.policyType,
    scopeType: overrides.scopeType ?? "building",
    scopeId: overrides.scopeId,
    importance: overrides.importance ?? "preference",
    summary: overrides.summary,
    schedule: overrides.schedule ?? null,
    details: overrides.details ?? {},
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? "2026-03-19T08:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-19T08:00:00.000Z",
  };
}

async function simulateAssistPreview(input: {
  sandbox: SandboxDataGenerationEngine;
  blueprint: ReturnType<typeof loadSandboxBlueprint>;
  products: ReturnType<typeof loadProductsCatalog>["products"];
  seedBatch: Awaited<ReturnType<SandboxDataGenerationEngine["tick"]>>;
  seedSnapshot: TwinSnapshot;
  now: Date;
  horizonMinutes: number;
  plan: ReturnType<typeof buildAssistPlanFromAssessment> | null;
}) {
  const fork = input.sandbox.fork();
  fork.setAssistPlan(input.plan);
  const previewTwin = new BelimoEngine(input.blueprint, input.products);
  previewTwin.ingest(input.seedBatch);
  const tickSeconds = fork.getTickSeconds();
  const totalTicks = Math.round((input.horizonMinutes * 60) / tickSeconds);
  let lastBatch = input.seedBatch;
  let lastSnapshot = input.seedSnapshot;

  for (let tick = 1; tick <= totalTicks; tick += 1) {
    const simulatedNow = new Date(input.now.getTime() + tick * tickSeconds * 1000);
    lastBatch = await fork.tick(simulatedNow);
    lastSnapshot = previewTwin.ingest(lastBatch);
  }

  return {
    batch: lastBatch,
    snapshot: lastSnapshot,
  };
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

  assert.ok(movingSamples.length >= 1);

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
  assert.ok(coolingDemandRatio >= 0.62 && coolingDemandRatio <= 1.6);
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
  assert.ok(extrema.staticMin >= 120);
  assert.ok(extrema.staticMax <= 650);
  assert.ok(extrema.comfortMin >= 80);
});

test("sandbox supports manual weather overrides for sandbox-only what-if runs", async () => {
  const { sandbox } = createSandboxEngine({
    disableNoise: true,
    disableFaults: true,
  });

  sandbox.updateControls({
    weatherMode: "manual",
    weatherOverride: {
      temperatureC: -4,
      relativeHumidityPct: 82,
      windSpeedMps: 7.5,
      windDirectionDeg: 35,
      cloudCoverPct: 96,
    },
  });

  const batch = await sandbox.tick(new Date("2026-03-19T06:00:00+01:00"));

  assert.equal(batch.weather.temperatureC, -4);
  assert.equal(batch.weather.relativeHumidityPct, 82);
  assert.equal(batch.weather.windSpeedMps, 7.5);
  assert.equal(batch.weather.windDirectionDeg, 35);
  assert.equal(batch.weather.cloudCoverPct, 96);
  assert.equal(batch.weather.isStale, false);
});

test("forked sandbox previews do not mutate the live runtime state", async () => {
  const { blueprint, truth, products } = createSandboxEngine({
    disableNoise: true,
    disableFaults: true,
  });
  const baseWeather = {
    temperatureC: 23,
    relativeHumidityPct: 51,
    windSpeedMps: 2.4,
    windDirectionDeg: 180,
    cloudCoverPct: 32,
  };
  const createLiveSandbox = () =>
    new SandboxDataGenerationEngine(
      blueprint,
      structuredClone(truth),
      products,
      createWeatherService(baseWeather),
    );

  const liveSandbox = createLiveSandbox();
  const controlInput = {
    zoneTemperatureOffsetsC: { open_office: -1.4 },
    ventilationBoostPct: 12,
    weatherMode: "manual" as const,
    weatherOverride: {
      temperatureC: 4,
      relativeHumidityPct: 78,
      windSpeedMps: 5,
      windDirectionDeg: 140,
      cloudCoverPct: 88,
    },
  };
  liveSandbox.updateControls(controlInput);

  const start = new Date("2026-03-19T08:00:00+01:00");
  await liveSandbox.tick(start);

  const fork = liveSandbox.fork();
  let previewNow = new Date(start.getTime());

  for (let tick = 0; tick < 180; tick += 1) {
    previewNow = new Date(previewNow.getTime() + truth.runtime.simulation_timestep_s * 1000);
    await fork.tick(previewNow);
  }

  const liveNextAt = new Date(start.getTime() + truth.runtime.simulation_timestep_s * 1000);
  const liveNext = await liveSandbox.tick(liveNextAt);

  const referenceSandbox = createLiveSandbox();
  referenceSandbox.updateControls(controlInput);
  await referenceSandbox.tick(start);
  const referenceNext = await referenceSandbox.tick(liveNextAt);

  assert.deepEqual(liveNext.weather, referenceNext.weather);
  assert.deepEqual(liveNext.truth, referenceNext.truth);
  assert.deepEqual(liveNext.operationalState, referenceNext.operationalState);
});

test("drift intelligence triggers on fast co2 and airflow deterioration before comfort fully collapses", () => {
  const blueprint = loadSandboxBlueprint();
  const controls = createManualControls();
  const comfortableZones = blueprint.spaces.map((space) => ({
    zoneId: space.id,
    temperatureC: 22.6,
    relativeHumidityPct: 45,
    co2Ppm: 620,
    occupancyCount: 0,
    supplyAirflowM3H:
      blueprint.devices.find((device) => device.kind === "actuator" && device.served_space_ids.includes(space.id))?.design
        .design_airflow_m3_h ?? 0,
    sensibleLoadW: 120,
    comfortScore: 97,
  }));
  const currentSnapshot: TwinSnapshot = {
    buildingId: blueprint.blueprint_id,
    observedAt: "2026-03-19T10:08:00.000+01:00",
    sourceKind: "sandbox",
    summary: {
      averageComfortScore: 92,
      worstZoneId: "open_office",
      activeAlertCount: 0,
      outdoorTemperatureC: 8,
      supplyTemperatureC: 18,
    },
    weather: {
      source: "open-meteo",
      observedAt: "2026-03-19T10:08:00.000+01:00",
      temperatureC: 8,
      relativeHumidityPct: 78,
      windSpeedMps: 3.8,
      windDirectionDeg: 140,
      cloudCoverPct: 62,
      isStale: false,
    },
    zones: comfortableZones.map((zone) =>
      zone.zoneId === "open_office"
        ? {
            ...zone,
            co2Ppm: 1_025,
            occupancyCount: 20,
            supplyAirflowM3H: 710,
            comfortScore: 89,
          }
        : zone,
    ),
    devices: [],
    derived: {
      buildingCoolingDemandKw: 8.2,
      buildingHeatingDemandKw: 0,
      ventilationEffectivenessPct: 78,
      staticPressurePa: 235,
    },
  };
  const recentSnapshots = [
    {
      observedAt: "2026-03-19T10:03:00.000+01:00",
      zones: comfortableZones.map((zone) =>
        zone.zoneId === "open_office"
          ? {
              ...zone,
              co2Ppm: 905,
              occupancyCount: 18,
              supplyAirflowM3H: 1_040,
              comfortScore: 95,
            }
          : zone,
      ),
    },
  ];

  const assessment = assessRuntimeDrift({
    blueprint,
    controls,
    currentSnapshot,
    recentSnapshots,
    activeFaultIds: [],
  });

  assert.equal(assessment.trigger, "comfort_drift");
  assert.ok(assessment.reason === "co2" || assessment.reason === "airflow");
  assert.ok(assessment.severity >= 1.05);
  assert.equal(assessment.worstZoneId, "open_office");
});

test("automatic remediation suppresses repeated previews for the same unchanged drift", () => {
  const blueprint = loadSandboxBlueprint();
  const controls = createManualControls();
  const zones = blueprint.spaces.map((space) => ({
    zoneId: space.id,
    temperatureC: 22.6,
    relativeHumidityPct: 45,
    co2Ppm: 620,
    occupancyCount: 0,
    supplyAirflowM3H:
      blueprint.devices.find((device) => device.kind === "actuator" && device.served_space_ids.includes(space.id))?.design
        .design_airflow_m3_h ?? 0,
    sensibleLoadW: 120,
    comfortScore: 97,
  }));
  const assessment = assessRuntimeDrift({
    blueprint,
    controls,
    currentSnapshot: {
      buildingId: blueprint.blueprint_id,
      observedAt: "2026-03-19T10:10:00.000+01:00",
      sourceKind: "sandbox",
      summary: {
        averageComfortScore: 89,
        worstZoneId: "open_office",
        activeAlertCount: 0,
        outdoorTemperatureC: -8,
        supplyTemperatureC: 22,
      },
      weather: {
        source: "open-meteo",
        observedAt: "2026-03-19T10:10:00.000+01:00",
        temperatureC: -8,
        relativeHumidityPct: 82,
        windSpeedMps: 4.5,
        windDirectionDeg: 45,
        cloudCoverPct: 88,
        isStale: false,
      },
      zones: zones.map((zone) =>
        zone.zoneId === "open_office"
          ? {
              ...zone,
              temperatureC: 22,
              occupancyCount: 18,
              comfortScore: 86,
            }
          : zone,
      ),
      devices: [],
      derived: {
        buildingCoolingDemandKw: 0,
        buildingHeatingDemandKw: 9.5,
        ventilationEffectivenessPct: 94,
        staticPressurePa: 240,
      },
    },
    recentSnapshots: [
      {
        observedAt: "2026-03-19T10:05:00.000+01:00",
        zones: zones.map((zone) =>
          zone.zoneId === "open_office"
            ? {
                ...zone,
                temperatureC: 22.4,
                occupancyCount: 18,
                comfortScore: 92,
              }
            : zone,
        ),
      },
    ],
    activeFaultIds: [],
  });

  assert.equal(assessment.trigger, "comfort_drift");
  const firstDecision = decideAutomaticRemediation({
    assessment,
    runtimeSeconds: 900,
    activeFaultIds: [],
    existing: null,
  });
  const repeatedDecision = decideAutomaticRemediation({
    assessment,
    runtimeSeconds: 1_020,
    activeFaultIds: [],
    existing: firstDecision.nextState,
  });

  assert.equal(firstDecision.action, "apply");
  assert.equal(deriveAutomaticIssueKey(assessment, []), "comfort:temperature_cold");
  assert.equal(repeatedDecision.action, "skip");
});

test("automatic remediation retriggers when the same issue materially worsens", () => {
  const previousState = {
    issueKey: "comfort:temperature_cold",
    trigger: "comfort_drift" as const,
    reason: "temperature_cold" as const,
    appliedAtRuntimeSeconds: 900,
    reevaluateAfterRuntimeSeconds: 2_100,
    baselineSeverity: 2.2,
    lastWorstZoneId: "open_office",
  };
  const escalatedAssessment = {
    trigger: "comfort_drift" as const,
    severity: 3.6,
    cooldownMs: 30_000,
    worstZoneId: "open_office",
    reason: "temperature_cold" as const,
    modeBias: "heating" as const,
    horizonMinutes: 30,
    signature: {},
    zoneSignals: [],
  };

  const decision = decideAutomaticRemediation({
    assessment: escalatedAssessment,
    runtimeSeconds: 1_080,
    activeFaultIds: [],
    existing: previousState,
  });

  assert.equal(decision.action, "apply");
  assert.ok(decision.nextState.baselineSeverity > previousState.baselineSeverity);
});

test("simulation refinement improves cold-drift recovery under extreme weather within the target horizon", async () => {
  const { blueprint, truth, products } = createSandboxEngine({
    disableNoise: true,
    disableFaults: true,
  });
  const sandbox = new SandboxDataGenerationEngine(
    blueprint,
    structuredClone(truth),
    products,
    createWeatherService({
      temperatureC: -10,
      relativeHumidityPct: 81,
      windSpeedMps: 6.2,
      windDirectionDeg: 35,
      cloudCoverPct: 92,
    }),
  );
  const twin = new BelimoEngine(blueprint, products);
  const recentSnapshots: Array<Pick<TwinSnapshot, "observedAt" | "zones">> = [];
  const openOfficeTargetC = 24.3;
  const occupiedMidpoint = 22.75;
  let horizonMinutes = 20;
  let now = new Date("2026-03-19T10:00:00+01:00");
  let latestBatch: Awaited<ReturnType<SandboxDataGenerationEngine["tick"]>> | null = null;
  let latestSnapshot: TwinSnapshot | null = null;

  sandbox.updateControls({
    weatherMode: "manual",
    weatherOverride: {
      temperatureC: -10,
      relativeHumidityPct: 81,
      windSpeedMps: 6.2,
      windDirectionDeg: 35,
      cloudCoverPct: 92,
    },
    zoneTemperatureOffsetsC: {
      open_office: openOfficeTargetC - occupiedMidpoint,
    },
  });

  for (let tick = 0; tick < 180; tick += 1) {
    latestBatch = await sandbox.tick(now);
    latestSnapshot = twin.ingest(latestBatch);
    recentSnapshots.push({
      observedAt: latestSnapshot.observedAt,
      zones: latestSnapshot.zones,
    });

    if (recentSnapshots.length > 120) {
      recentSnapshots.shift();
    }

    const office = latestSnapshot.zones.find((zone) => zone.zoneId === "open_office");
    assert.ok(office);

    if (office.temperatureC <= 22.2 && recentSnapshots.length >= 30) {
      break;
    }

    now = new Date(now.getTime() + truth.runtime.simulation_timestep_s * 1000);
  }

  assert.ok(latestBatch);
  assert.ok(latestSnapshot);

  const assessment = assessRuntimeDrift({
    blueprint,
    controls: sandbox.getControlState(),
    currentSnapshot: latestSnapshot,
    recentSnapshots,
    activeFaultIds: [],
  });

  assert.equal(assessment.trigger, "comfort_drift");
  assert.equal(assessment.reason, "temperature_cold");
  assert.ok(assessment.severity >= 2);
  horizonMinutes = assessment.horizonMinutes;

  const basePlan = buildAssistPlanFromAssessment({
    assessment,
    currentSnapshot: latestSnapshot,
    runtimeSeconds: latestBatch.operationalState.runtimeSeconds,
    horizonMinutes,
  });

  const noPlan = await simulateAssistPreview({
    sandbox,
    blueprint,
    products,
    seedBatch: latestBatch,
    seedSnapshot: latestSnapshot,
    now,
    horizonMinutes,
    plan: null,
  });
  const baseOutcome = await simulateAssistPreview({
    sandbox,
    blueprint,
    products,
    seedBatch: latestBatch,
    seedSnapshot: latestSnapshot,
    now,
    horizonMinutes,
    plan: basePlan,
  });
  const baseScore = scoreTwinSnapshotAgainstControls({
    blueprint,
    controls: sandbox.getControlState(),
    snapshot: baseOutcome.snapshot,
  });
  const refinedPlan = refineAssistPlanFromOutcome({
    blueprint,
    controls: sandbox.getControlState(),
    currentSnapshot: latestSnapshot,
    outcomeSnapshot: baseOutcome.snapshot,
    previousPlan: basePlan,
    runtimeSeconds: latestBatch.operationalState.runtimeSeconds,
    horizonMinutes,
  });
  const refinedOutcome = await simulateAssistPreview({
    sandbox,
    blueprint,
    products,
    seedBatch: latestBatch,
    seedSnapshot: latestSnapshot,
    now,
    horizonMinutes,
    plan: refinedPlan,
  });
  const noPlanScore = scoreTwinSnapshotAgainstControls({
    blueprint,
    controls: sandbox.getControlState(),
    snapshot: noPlan.snapshot,
  });
  const refinedScore = scoreTwinSnapshotAgainstControls({
    blueprint,
    controls: sandbox.getControlState(),
    snapshot: refinedOutcome.snapshot,
  });
  const refinedOffice = refinedOutcome.snapshot.zones.find((zone) => zone.zoneId === "open_office");

  assert.ok(refinedOffice);
  assert.ok(baseScore.totalScore < noPlanScore.totalScore);
  assert.ok(refinedScore.totalScore <= baseScore.totalScore);
  assert.ok(Math.abs(refinedOffice.temperatureC - openOfficeTargetC) <= 1);

  sandbox.setAssistPlan(refinedScore.totalScore < baseScore.totalScore ? refinedPlan : basePlan);
  const liveTwin = new BelimoEngine(blueprint, products);
  liveTwin.ingest(latestBatch);
  let liveNow = new Date(now.getTime());
  let liveSnapshot = latestSnapshot;

  for (let tick = 0; tick < Math.round((horizonMinutes * 60) / truth.runtime.simulation_timestep_s); tick += 1) {
    liveNow = new Date(liveNow.getTime() + truth.runtime.simulation_timestep_s * 1000);
    const liveBatch = await sandbox.tick(liveNow);
    liveSnapshot = liveTwin.ingest(liveBatch);
  }

  const liveOffice = liveSnapshot.zones.find((zone) => zone.zoneId === "open_office");

  assert.ok(liveOffice);
  assert.ok(Math.abs(liveOffice.temperatureC - openOfficeTargetC) <= 1.1);
});

test("policy resolver applies scheduled controls on top of stored manual preferences", () => {
  const blueprint = loadSandboxBlueprint();
  const manualControls = createManualControls();
  manualControls.sourceModePreference = "ventilation";
  manualControls.occupancyBias = 1.2;

  const zone = blueprint.spaces.find((space) => space.id === "open_office");
  assert.ok(zone);
  const occupiedMidpoint = (zone.comfort_targets.occupied_temperature_band_c[0] + zone.comfort_targets.occupied_temperature_band_c[1]) / 2;

  const resolution = resolveRuntimeControlResolution({
    blueprint,
    manualControls,
    policies: [
      createOperatorPolicy({
        id: "zone-always",
        policyType: "zone_temperature_schedule",
        scopeType: "zone",
        scopeId: "open_office",
        summary: "Keep open office at 21.5C by default",
        details: {
          zoneId: "open_office",
          temperatureC: 21.5,
        },
        updatedAt: "2026-03-19T07:30:00.000Z",
      }),
      createOperatorPolicy({
        id: "zone-daytime",
        policyType: "zone_temperature_schedule",
        scopeType: "zone",
        scopeId: "open_office",
        importance: "requirement",
        summary: "Keep open office at 23C during weekday daytime",
        schedule: {
          timezone: "Europe/Zurich",
          daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
          startLocalTime: "09:00",
          endLocalTime: "17:00",
        },
        details: {
          zoneId: "open_office",
          temperatureC: 23,
        },
        updatedAt: "2026-03-19T08:00:00.000Z",
      }),
      createOperatorPolicy({
        id: "mode-daytime",
        policyType: "facility_mode_preference",
        importance: "requirement",
        summary: "Force cooling during occupied daytime",
        schedule: {
          timezone: "Europe/Zurich",
          daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
          startLocalTime: "09:00",
          endLocalTime: "17:00",
        },
        details: {
          mode: "cooling",
        },
        updatedAt: "2026-03-19T08:00:00.000Z",
      }),
      createOperatorPolicy({
        id: "efficiency-night",
        policyType: "energy_strategy",
        summary: "Save energy after hours",
        schedule: {
          timezone: "Europe/Zurich",
          daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
          startLocalTime: "18:00",
          endLocalTime: "07:00",
        },
        details: {
          strategy: "efficiency_priority",
        },
      }),
    ],
    now: new Date("2026-03-19T10:30:00+01:00"),
  });

  assert.equal(resolution.manualControls.sourceModePreference, "ventilation");
  assert.equal(resolution.effectiveControls.sourceModePreference, "cooling");
  assert.equal(resolution.effectiveControls.occupancyBias, 1.2);
  assert.equal(resolution.effectiveControls.zoneTemperatureOffsetsC.open_office, 23 - occupiedMidpoint);
  assert.ok(resolution.activePolicies.some((policy) => policy.id === "zone-daytime"));
  assert.ok(resolution.activePolicies.some((policy) => policy.id === "mode-daytime"));
  assert.ok(!resolution.activePolicies.some((policy) => policy.id === "zone-always"));
  assert.ok(!resolution.activePolicies.some((policy) => policy.id === "efficiency-night"));
});

test("policy resolver activates overnight schedules using the schedule timezone", () => {
  const policy = createOperatorPolicy({
    id: "night-heat",
    policyType: "facility_mode_preference",
    importance: "requirement",
    summary: "Run heating overnight after Thursday closing",
    schedule: {
      timezone: "Europe/Zurich",
      daysOfWeek: ["thu"],
      startLocalTime: "22:00",
      endLocalTime: "06:00",
    },
    details: {
      mode: "heating",
    },
  });

  assert.equal(isOperatorPolicyActiveAt(policy, new Date("2026-03-20T02:15:00+01:00")), true);
  assert.equal(isOperatorPolicyActiveAt(policy, new Date("2026-03-20T06:15:00+01:00")), false);

  const resolution = resolveRuntimeControlResolution({
    blueprint: loadSandboxBlueprint(),
    manualControls: createManualControls(),
    policies: [policy],
    now: new Date("2026-03-20T02:15:00+01:00"),
  });

  assert.equal(resolution.effectiveControls.sourceModePreference, "heating");
  assert.ok(resolution.activePolicies.some((activePolicy) => activePolicy.id === "night-heat"));
});
