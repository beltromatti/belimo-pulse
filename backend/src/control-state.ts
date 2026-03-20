import { clamp } from "./physics";
import { RuntimeControlInput, RuntimeControlState } from "./runtime-types";

function cloneRecord<T extends string>(input: Record<string, T>) {
  return { ...input };
}

export function cloneRuntimeControlState(state: RuntimeControlState): RuntimeControlState {
  return {
    sourceModePreference: state.sourceModePreference,
    zoneTemperatureOffsetsC: { ...state.zoneTemperatureOffsetsC },
    occupancyBias: state.occupancyBias,
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

  if (input.zoneTemperatureOffsetsC) {
    for (const [zoneId, offset] of Object.entries(input.zoneTemperatureOffsetsC)) {
      if (zoneId in next.zoneTemperatureOffsetsC) {
        next.zoneTemperatureOffsetsC[zoneId] = clamp(offset, -3, 3);
      }
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
