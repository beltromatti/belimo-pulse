import { clamp } from "./physics";
import { RuntimeControlInput, RuntimeControlState } from "./runtime-types";

function cloneRecord<T extends string>(input: Record<string, T>) {
  return { ...input };
}

export function cloneRuntimeControlState(state: RuntimeControlState): RuntimeControlState {
  return {
    sourceModePreference: state.sourceModePreference,
    zoneTemperatureOffsetsC: { ...state.zoneTemperatureOffsetsC },
    zoneCo2SetpointsPpm: { ...state.zoneCo2SetpointsPpm },
    supplyTemperatureTrimC: state.supplyTemperatureTrimC,
    ventilationBoostPct: state.ventilationBoostPct,
    occupancyBias: state.occupancyBias,
    windowOpenFractionByZone: { ...state.windowOpenFractionByZone },
    weatherMode: state.weatherMode,
    weatherOverride: { ...state.weatherOverride },
    timeMode: state.timeMode,
    timeSpeedMultiplier: state.timeSpeedMultiplier,
    solarGainBias: state.solarGainBias,
    plugLoadBias: state.plugLoadBias,
    faultOverrides: cloneRecord(state.faultOverrides),
  };
}

export function applyRuntimeControlInput(base: RuntimeControlState, input: RuntimeControlInput): RuntimeControlState {
  const next = cloneRuntimeControlState(base);

  if (input.sourceModePreference) {
    next.sourceModePreference = input.sourceModePreference;
  }

  if (typeof input.occupancyBias === "number") {
    next.occupancyBias = clamp(input.occupancyBias, 0.4, 1.6);
  }

  if (typeof input.supplyTemperatureTrimC === "number") {
    next.supplyTemperatureTrimC = clamp(input.supplyTemperatureTrimC, -4, 4);
  }

  if (typeof input.ventilationBoostPct === "number") {
    next.ventilationBoostPct = clamp(input.ventilationBoostPct, 0, 35);
  }

  if (typeof input.solarGainBias === "number") {
    next.solarGainBias = clamp(input.solarGainBias, 0.5, 1.75);
  }

  if (typeof input.plugLoadBias === "number") {
    next.plugLoadBias = clamp(input.plugLoadBias, 0.5, 1.75);
  }

  if (input.zoneTemperatureOffsetsC) {
    for (const [zoneId, offset] of Object.entries(input.zoneTemperatureOffsetsC)) {
      if (zoneId in next.zoneTemperatureOffsetsC) {
        next.zoneTemperatureOffsetsC[zoneId] = clamp(offset, -3, 3);
      }
    }
  }

  if (input.zoneCo2SetpointsPpm) {
    for (const [zoneId, setpoint] of Object.entries(input.zoneCo2SetpointsPpm)) {
      if (zoneId in next.zoneCo2SetpointsPpm) {
        next.zoneCo2SetpointsPpm[zoneId] = clamp(setpoint, 650, 1200);
      }
    }
  }

  if (input.windowOpenFractionByZone) {
    for (const [zoneId, openness] of Object.entries(input.windowOpenFractionByZone)) {
      if (zoneId in next.windowOpenFractionByZone) {
        next.windowOpenFractionByZone[zoneId] = clamp(openness, 0, 1);
      }
    }
  }

  if (input.weatherMode) {
    next.weatherMode = input.weatherMode;
  }

  if (input.timeMode) {
    next.timeMode = input.timeMode;

    if (input.timeMode === "live") {
      next.timeSpeedMultiplier = 1;
    } else if (next.timeSpeedMultiplier === 1) {
      next.timeSpeedMultiplier = 2;
    }
  }

  if (typeof input.timeSpeedMultiplier === "number") {
    if (input.timeSpeedMultiplier === 2 || input.timeSpeedMultiplier === 5 || input.timeSpeedMultiplier === 10) {
      next.timeSpeedMultiplier = input.timeSpeedMultiplier;
      next.timeMode = "virtual";
    } else {
      next.timeSpeedMultiplier = 1;
    }
  }

  if (input.weatherOverride) {
    if (typeof input.weatherOverride.temperatureC === "number") {
      next.weatherOverride.temperatureC = clamp(input.weatherOverride.temperatureC, -25, 42);
    }

    if (typeof input.weatherOverride.relativeHumidityPct === "number") {
      next.weatherOverride.relativeHumidityPct = clamp(input.weatherOverride.relativeHumidityPct, 5, 100);
    }

    if (typeof input.weatherOverride.windSpeedMps === "number") {
      next.weatherOverride.windSpeedMps = clamp(input.weatherOverride.windSpeedMps, 0, 30);
    }

    if (typeof input.weatherOverride.windDirectionDeg === "number") {
      next.weatherOverride.windDirectionDeg = clamp(input.weatherOverride.windDirectionDeg, 0, 360);
    }

    if (typeof input.weatherOverride.cloudCoverPct === "number") {
      next.weatherOverride.cloudCoverPct = clamp(input.weatherOverride.cloudCoverPct, 0, 100);
    }
  }

  if (input.faultOverrides) {
    for (const [faultId, mode] of Object.entries(input.faultOverrides)) {
      if (faultId in next.faultOverrides) {
        next.faultOverrides[faultId] = mode;
      }
    }
  }

  return next;
}

export function normalizeRuntimeControlState(candidate: unknown, fallback: RuntimeControlState): RuntimeControlState {
  if (!candidate || typeof candidate !== "object") {
    return cloneRuntimeControlState(fallback);
  }

  return applyRuntimeControlInput(fallback, candidate as RuntimeControlInput);
}
