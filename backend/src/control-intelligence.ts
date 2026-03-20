import { BuildingBlueprint } from "./blueprint";
import { clamp, round } from "./physics";
import {
  FacilityModePreference,
  RuntimeControlState,
  RuntimeSimulationTrigger,
  TwinSnapshot,
  ZoneTwinState,
} from "./runtime-types";
import { SandboxAssistPlan } from "./sandbox/model";

export type ZoneTargetState = {
  zoneId: string;
  temperatureTargetC: number;
  co2TargetPpm: number;
  minimumAirflowM3H: number;
  designAirflowM3H: number;
};

export type ZoneDriftSignal = {
  zoneId: string;
  occupied: boolean;
  temperatureErrorC: number;
  temperatureRateCPerMin: number;
  projectedTemperatureErrorC: number;
  co2ExcessPpm: number;
  co2RatePpmPerMin: number;
  projectedCo2ExcessPpm: number;
  airflowShortageM3H: number;
  airflowShortageRatio: number;
  comfortGap: number;
  score: number;
  dominantIssue: "temperature_cold" | "temperature_hot" | "co2" | "airflow" | "comfort";
};

export type RuntimeDriftAssessment = {
  trigger: RuntimeSimulationTrigger | null;
  severity: number;
  cooldownMs: number;
  worstZoneId: string | null;
  reason: ZoneDriftSignal["dominantIssue"] | "fault" | null;
  modeBias: FacilityModePreference;
  horizonMinutes: number;
  signature: Record<string, number | string | string[] | null>;
  zoneSignals: ZoneDriftSignal[];
};

export type SimulationOutcomeScore = {
  totalScore: number;
  worstZoneId: string | null;
  worstZoneScore: number;
  dominantIssue: ZoneDriftSignal["dominantIssue"] | null;
  zoneSignals: ZoneDriftSignal[];
};

function getSpace(blueprint: BuildingBlueprint, zoneId: string) {
  const space = blueprint.spaces.find((candidate) => candidate.id === zoneId);

  if (!space) {
    throw new Error(`Unknown zone ${zoneId}`);
  }

  return space;
}

function getDesignAirflowForZone(blueprint: BuildingBlueprint, zoneId: string) {
  return (
    blueprint.devices.find((device) => device.kind === "actuator" && device.served_space_ids.includes(zoneId))?.design
      .design_airflow_m3_h ?? 0
  );
}

function getZoneTargetState(
  blueprint: BuildingBlueprint,
  controls: RuntimeControlState,
  zone: ZoneTwinState,
): ZoneTargetState {
  const space = getSpace(blueprint, zone.zoneId);
  const occupied = zone.occupancyCount > 0;
  const temperatureBand = occupied
    ? space.comfort_targets.occupied_temperature_band_c
    : space.comfort_targets.unoccupied_temperature_band_c;
  const designAirflowM3H = getDesignAirflowForZone(blueprint, zone.zoneId);
  const minimumAirflowBaseRatio = occupied ? 0.55 : 0.18;
  const ventilationLift = controls.ventilationBoostPct / 100;

  return {
    zoneId: zone.zoneId,
    temperatureTargetC: (temperatureBand[0] + temperatureBand[1]) / 2 + (controls.zoneTemperatureOffsetsC[zone.zoneId] ?? 0),
    co2TargetPpm: controls.zoneCo2SetpointsPpm[zone.zoneId] ?? space.comfort_targets.co2_limit_ppm,
    minimumAirflowM3H: designAirflowM3H * clamp(minimumAirflowBaseRatio + ventilationLift * 0.18, 0.18, 0.75),
    designAirflowM3H,
  };
}

function getReferenceZone(recentSnapshots: Array<Pick<TwinSnapshot, "observedAt" | "zones">>, zoneId: string, currentObservedAt: string) {
  const currentMs = new Date(currentObservedAt).getTime();

  for (let index = recentSnapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = recentSnapshots[index];
    const deltaMinutes = (currentMs - new Date(snapshot.observedAt).getTime()) / 60_000;

    if (deltaMinutes < 2 || deltaMinutes > 8) {
      continue;
    }

    const zone = snapshot.zones.find((candidate) => candidate.zoneId === zoneId);

    if (zone) {
      return {
        zone,
        deltaMinutes,
      };
    }
  }

  return null;
}

function computeZoneSignal(input: {
  blueprint: BuildingBlueprint;
  controls: RuntimeControlState;
  currentZone: ZoneTwinState;
  currentObservedAt: string;
  recentSnapshots: Array<Pick<TwinSnapshot, "observedAt" | "zones">>;
}) {
  const target = getZoneTargetState(input.blueprint, input.controls, input.currentZone);
  const reference = getReferenceZone(input.recentSnapshots, input.currentZone.zoneId, input.currentObservedAt);
  const deltaMinutes = Math.max(reference?.deltaMinutes ?? 0.25, 0.25);
  const referenceZone = reference?.zone ?? input.currentZone;
  const temperatureRateCPerMin = (input.currentZone.temperatureC - referenceZone.temperatureC) / deltaMinutes;
  const co2RatePpmPerMin = (input.currentZone.co2Ppm - referenceZone.co2Ppm) / deltaMinutes;
  const temperatureErrorC = round(input.currentZone.temperatureC - target.temperatureTargetC, 3);
  const projectedTemperatureErrorC = round(temperatureErrorC + temperatureRateCPerMin * 10, 3);
  const co2ExcessPpm = round(input.currentZone.co2Ppm - target.co2TargetPpm, 1);
  const projectedCo2ExcessPpm = round(co2ExcessPpm + co2RatePpmPerMin * 10, 1);
  const airflowShortageM3H = round(Math.max(0, target.minimumAirflowM3H - input.currentZone.supplyAirflowM3H), 1);
  const airflowShortageRatio = round(
    target.designAirflowM3H > 0 ? airflowShortageM3H / target.designAirflowM3H : 0,
    3,
  );
  const comfortGap = round(Math.max(0, 94 - input.currentZone.comfortScore), 1);

  const temperatureMagnitudeScore = Math.abs(temperatureErrorC) / 0.32;
  const temperatureTrendScore = Math.max(0, Math.sign(temperatureErrorC || 0) * temperatureRateCPerMin) / 0.045;
  const temperatureProjectedScore = Math.abs(projectedTemperatureErrorC) / 0.42;
  const co2MagnitudeScore = Math.max(0, co2ExcessPpm) / 45;
  const co2TrendScore = Math.max(0, co2RatePpmPerMin) / 12;
  const co2ProjectedScore = Math.max(0, projectedCo2ExcessPpm) / 65;
  const airflowScore = airflowShortageRatio / 0.09;
  const comfortScore = comfortGap / 4;

  const coldScore = temperatureErrorC < 0
    ? Math.max(
        Math.abs(temperatureMagnitudeScore) * 0.7 + temperatureTrendScore * 0.5,
        temperatureProjectedScore,
      )
    : 0;
  const hotScore = temperatureErrorC > 0
    ? Math.max(
        Math.abs(temperatureMagnitudeScore) * 0.7 + temperatureTrendScore * 0.5,
        temperatureProjectedScore,
      )
    : 0;
  const ventilationScore = Math.max(
    co2MagnitudeScore * 0.8 + co2TrendScore * 0.6,
    co2ProjectedScore,
    airflowScore * 0.95,
  );

  const ranked = [
    { issue: "temperature_cold" as const, score: coldScore },
    { issue: "temperature_hot" as const, score: hotScore },
    { issue: "co2" as const, score: Math.max(co2MagnitudeScore * 0.9 + co2TrendScore * 0.4, co2ProjectedScore) },
    { issue: "airflow" as const, score: airflowScore },
    { issue: "comfort" as const, score: comfortScore },
  ].sort((left, right) => right.score - left.score);

  return {
    zoneId: input.currentZone.zoneId,
    occupied: input.currentZone.occupancyCount > 0,
    temperatureErrorC,
    temperatureRateCPerMin: round(temperatureRateCPerMin, 3),
    projectedTemperatureErrorC,
    co2ExcessPpm,
    co2RatePpmPerMin: round(co2RatePpmPerMin, 3),
    projectedCo2ExcessPpm,
    airflowShortageM3H,
    airflowShortageRatio,
    comfortGap,
    score: round(Math.max(ranked[0]?.score ?? 0, ventilationScore, comfortScore), 3),
    dominantIssue: ranked[0]?.issue ?? "comfort",
  } satisfies ZoneDriftSignal;
}

function chooseModeBias(
  currentSnapshot: TwinSnapshot,
  strongestZone: ZoneDriftSignal | null,
): FacilityModePreference {
  if (!strongestZone) {
    return "auto";
  }

  if (strongestZone.dominantIssue === "temperature_cold") {
    return "heating";
  }

  if (strongestZone.dominantIssue === "temperature_hot") {
    return currentSnapshot.weather.temperatureC + 1.2 < currentSnapshot.zones.reduce((sum, zone) => sum + zone.temperatureC, 0) / currentSnapshot.zones.length
      ? "economizer"
      : "cooling";
  }

  if (strongestZone.dominantIssue === "co2" || strongestZone.dominantIssue === "airflow") {
    return currentSnapshot.weather.temperatureC < currentSnapshot.summary.supplyTemperatureC ? "economizer" : "ventilation";
  }

  return "auto";
}

export function assessRuntimeDrift(input: {
  blueprint: BuildingBlueprint;
  controls: RuntimeControlState;
  currentSnapshot: TwinSnapshot;
  recentSnapshots: Array<Pick<TwinSnapshot, "observedAt" | "zones">>;
  activeFaultIds?: string[];
}) {
  const zoneSignals = input.currentSnapshot.zones.map((zone) =>
    computeZoneSignal({
      blueprint: input.blueprint,
      controls: input.controls,
      currentZone: zone,
      currentObservedAt: input.currentSnapshot.observedAt,
      recentSnapshots: input.recentSnapshots,
    }),
  );
  const strongestZone = zoneSignals.reduce<ZoneDriftSignal | null>(
    (worst, zone) => (!worst || zone.score > worst.score ? zone : worst),
    null,
  );
  const activeFaultIds = [...(input.activeFaultIds ?? [])].sort();
  const faultSeverity = activeFaultIds.length > 0 ? 2.6 + activeFaultIds.length * 0.2 : 0;
  const comfortSeverity = strongestZone?.score ?? 0;
  const severity = round(Math.max(faultSeverity, comfortSeverity), 3);
  const trigger =
    activeFaultIds.length > 0
      ? "fault_detected"
      : severity >= 1.05 || input.currentSnapshot.summary.averageComfortScore < 91
        ? "comfort_drift"
        : null;

  return {
    trigger,
    severity,
    cooldownMs: severity >= 2.5 ? 15_000 : severity >= 1.65 ? 30_000 : 45_000,
    worstZoneId: strongestZone?.zoneId ?? null,
    reason: activeFaultIds.length > 0 ? "fault" : strongestZone?.dominantIssue ?? null,
    modeBias: chooseModeBias(input.currentSnapshot, strongestZone),
    horizonMinutes: activeFaultIds.length > 0 ? 30 : severity >= 3 ? 30 : severity >= 2 ? 20 : 15,
    signature: {
      trigger,
      activeFaultIds,
      worstZoneId: strongestZone?.zoneId ?? null,
      dominantIssue: strongestZone?.dominantIssue ?? null,
      temperatureErrorBucket: strongestZone ? round(strongestZone.temperatureErrorC, 1) : null,
      co2ExcessBucket: strongestZone ? round(strongestZone.co2ExcessPpm, 0) : null,
      airflowShortageBucket: strongestZone ? round(strongestZone.airflowShortageRatio, 2) : null,
    },
    zoneSignals,
  } satisfies RuntimeDriftAssessment;
}

export function scoreTwinSnapshotAgainstControls(input: {
  blueprint: BuildingBlueprint;
  controls: RuntimeControlState;
  snapshot: TwinSnapshot;
}) {
  const zoneSignals = input.snapshot.zones.map((zone) =>
    computeZoneSignal({
      blueprint: input.blueprint,
      controls: input.controls,
      currentZone: zone,
      currentObservedAt: input.snapshot.observedAt,
      recentSnapshots: [],
    }),
  );
  const worstZone = zoneSignals.reduce<ZoneDriftSignal | null>(
    (worst, zone) => (!worst || zone.score > worst.score ? zone : worst),
    null,
  );
  const totalScore = zoneSignals.reduce((sum, zone) => sum + zone.score, 0) / Math.max(zoneSignals.length, 1);

  return {
    totalScore: round(totalScore, 3),
    worstZoneId: worstZone?.zoneId ?? null,
    worstZoneScore: round(worstZone?.score ?? 0, 3),
    dominantIssue: worstZone?.dominantIssue ?? null,
    zoneSignals,
  } satisfies SimulationOutcomeScore;
}

export function buildAssistPlanFromAssessment(input: {
  assessment: RuntimeDriftAssessment;
  currentSnapshot: TwinSnapshot;
  runtimeSeconds: number;
  horizonMinutes: number;
}) {
  const rankedZones = [...input.assessment.zoneSignals].sort((left, right) => right.score - left.score);
  const strongestZone = rankedZones[0] ?? null;
  const supplyTemperatureBiasBase =
    !strongestZone
      ? 0
      : strongestZone.dominantIssue === "temperature_cold"
        ? clamp(Math.abs(strongestZone.projectedTemperatureErrorC) * 2.5 + strongestZone.score * 0.7, 0.8, 6.8)
        : strongestZone.dominantIssue === "temperature_hot"
          ? -clamp(Math.abs(strongestZone.projectedTemperatureErrorC) * 2.4 + strongestZone.score * 0.65, 0.8, 6.2)
          : 0;
  const fanSpeedBiasPct = clamp(
    (strongestZone?.score ?? 0) * 5.5 +
      (strongestZone?.airflowShortageRatio ?? 0) * 60 +
      Math.max(0, strongestZone?.projectedCo2ExcessPpm ?? 0) / 16,
    0,
    28,
  );
  const outdoorAirBias =
    !strongestZone
      ? 0
      : strongestZone.dominantIssue === "co2" || strongestZone.dominantIssue === "airflow"
        ? clamp(
            0.08 +
              Math.max(0, strongestZone.projectedCo2ExcessPpm) / 900 +
              strongestZone.airflowShortageRatio * 0.2,
            0.08,
            0.34,
          )
        : strongestZone.dominantIssue === "temperature_cold" && strongestZone.co2ExcessPpm < 35
          ? -clamp(Math.abs(strongestZone.projectedTemperatureErrorC) * 0.05, 0.03, 0.16)
          : strongestZone.dominantIssue === "temperature_hot" &&
              input.currentSnapshot.weather.temperatureC > input.currentSnapshot.summary.supplyTemperatureC + 1
            ? -clamp(Math.abs(strongestZone.projectedTemperatureErrorC) * 0.03, 0.02, 0.1)
            : 0;
  const zoneDamperBiasPct = Object.fromEntries(
    rankedZones
      .filter((zone, index) => {
        if (!strongestZone) {
          return false;
        }

        if (index === 0) {
          return true;
        }

        if (strongestZone.dominantIssue === "temperature_cold" || strongestZone.dominantIssue === "temperature_hot") {
          return zone.dominantIssue === strongestZone.dominantIssue && zone.score >= strongestZone.score * 0.94;
        }

        return zone.score >= strongestZone.score * 0.85;
      })
      .slice(0, strongestZone?.dominantIssue === "co2" || strongestZone?.dominantIssue === "airflow" ? 2 : 1)
      .map((zone, index) => [
        zone.zoneId,
        round(
          clamp(
            (index === 0 ? 10 : 5) +
              zone.score * (index === 0 ? 5.8 : 3.1) +
              Math.max(0, Math.abs(zone.projectedTemperatureErrorC) - 0.2) * (index === 0 ? 4.2 : 1.8) +
              zone.airflowShortageRatio * (index === 0 ? 22 : 10),
            index === 0 ? 10 : 5,
            index === 0 ? 26 : 12,
          ),
        ),
      ]),
  );

  if (strongestZone && (strongestZone.dominantIssue === "temperature_cold" || strongestZone.dominantIssue === "temperature_hot")) {
    for (const zone of rankedZones.slice(1, 4)) {
      if (zone.dominantIssue !== strongestZone.dominantIssue) {
        continue;
      }

      if (zone.score >= strongestZone.score * 0.92) {
        continue;
      }

      zoneDamperBiasPct[zone.zoneId] = -round(
        clamp(3 + (strongestZone.score - zone.score) * 2.8 + Math.max(0, Math.abs(zone.temperatureErrorC) - 0.25), 3, 10),
      );
    }
  }

  return {
    trigger: input.assessment.trigger ?? "comfort_drift",
    modeBias: input.assessment.modeBias === "auto" ? "auto" : input.assessment.modeBias,
    supplyTemperatureBiasC: round(supplyTemperatureBiasBase, 2),
    fanSpeedBiasPct: round(fanSpeedBiasPct, 1),
    outdoorAirBias: round(outdoorAirBias, 3),
    zoneDamperBiasPct,
    generatedAtRuntimeSeconds: input.runtimeSeconds,
    expiresAtRuntimeSeconds: input.runtimeSeconds + input.horizonMinutes * 60,
  } satisfies SandboxAssistPlan;
}

export function refineAssistPlanFromOutcome(input: {
  blueprint: BuildingBlueprint;
  controls: RuntimeControlState;
  currentSnapshot: TwinSnapshot;
  outcomeSnapshot: TwinSnapshot;
  previousPlan: SandboxAssistPlan;
  runtimeSeconds: number;
  horizonMinutes: number;
}) {
  const outcome = scoreTwinSnapshotAgainstControls({
    blueprint: input.blueprint,
    controls: input.controls,
    snapshot: input.outcomeSnapshot,
  });
  const strongestZone = outcome.zoneSignals.reduce<ZoneDriftSignal | null>(
    (worst, zone) => (!worst || zone.score > worst.score ? zone : worst),
    null,
  );

  if (!strongestZone) {
    return {
      ...input.previousPlan,
      generatedAtRuntimeSeconds: input.runtimeSeconds,
      expiresAtRuntimeSeconds: input.runtimeSeconds + input.horizonMinutes * 60,
    } satisfies SandboxAssistPlan;
  }

  const nextZoneDamperBiasPct = { ...input.previousPlan.zoneDamperBiasPct };
  const currentBias = nextZoneDamperBiasPct[strongestZone.zoneId] ?? 0;
  let supplyTemperatureBiasC = input.previousPlan.supplyTemperatureBiasC;
  let fanSpeedBiasPct = input.previousPlan.fanSpeedBiasPct;
  let outdoorAirBias = input.previousPlan.outdoorAirBias;
  let modeBias = input.previousPlan.modeBias;

  if (strongestZone.dominantIssue === "temperature_cold") {
    modeBias = "heating";
    supplyTemperatureBiasC += clamp(Math.abs(strongestZone.temperatureErrorC) * 2 + 0.8, 0.8, 3.2);
    fanSpeedBiasPct += clamp(Math.abs(strongestZone.projectedTemperatureErrorC) * 4 + strongestZone.airflowShortageRatio * 18, 3, 10);

    if (strongestZone.co2ExcessPpm < 40) {
      outdoorAirBias -= 0.05;
    }
  } else if (strongestZone.dominantIssue === "temperature_hot") {
    modeBias = input.currentSnapshot.weather.temperatureC + 1 < input.currentSnapshot.summary.supplyTemperatureC ? "economizer" : "cooling";
    supplyTemperatureBiasC -= clamp(Math.abs(strongestZone.temperatureErrorC) * 2 + 0.8, 0.8, 3.2);
    fanSpeedBiasPct += clamp(Math.abs(strongestZone.projectedTemperatureErrorC) * 4 + strongestZone.airflowShortageRatio * 16, 3, 10);

    if (input.currentSnapshot.weather.temperatureC > input.currentSnapshot.summary.supplyTemperatureC + 1.5) {
      outdoorAirBias -= 0.04;
    }
  } else if (strongestZone.dominantIssue === "co2" || strongestZone.dominantIssue === "airflow") {
    modeBias = input.currentSnapshot.weather.temperatureC + 1 < input.currentSnapshot.zones.reduce((sum, zone) => sum + zone.temperatureC, 0) / input.currentSnapshot.zones.length
      ? "economizer"
      : "ventilation";
    fanSpeedBiasPct += clamp(Math.max(0, strongestZone.projectedCo2ExcessPpm) / 18 + strongestZone.airflowShortageRatio * 28, 4, 12);
    outdoorAirBias += clamp(Math.max(0, strongestZone.projectedCo2ExcessPpm) / 1000 + strongestZone.airflowShortageRatio * 0.18, 0.05, 0.18);
  } else if (strongestZone.comfortGap <= 2 && Math.abs(strongestZone.temperatureErrorC) < 0.2) {
    supplyTemperatureBiasC *= 0.7;
    fanSpeedBiasPct *= 0.8;
    outdoorAirBias *= 0.8;
  }

  nextZoneDamperBiasPct[strongestZone.zoneId] = round(
    clamp(currentBias + 4 + strongestZone.airflowShortageRatio * 18, 4, 24),
  );

  return {
    trigger: input.previousPlan.trigger,
    modeBias,
    supplyTemperatureBiasC: round(clamp(supplyTemperatureBiasC, -8, 8), 2),
    fanSpeedBiasPct: round(clamp(fanSpeedBiasPct, 0, 35), 1),
    outdoorAirBias: round(clamp(outdoorAirBias, -0.2, 0.4), 3),
    zoneDamperBiasPct: nextZoneDamperBiasPct,
    generatedAtRuntimeSeconds: input.runtimeSeconds,
    expiresAtRuntimeSeconds: input.runtimeSeconds + input.horizonMinutes * 60,
  } satisfies SandboxAssistPlan;
}
