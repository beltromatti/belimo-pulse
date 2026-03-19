import { ZoneTwinState } from "../runtime-types";

export type MutableZoneTruth = ZoneTwinState;

export type SandboxActuatorState = {
  commandPct: number;
  feedbackPct: number;
  rotationDirection: 0 | 1 | 2;
  torqueNmm: number;
  powerW: number;
  bodyTemperatureC: number;
};

export type SandboxRuntimeFault = {
  id: string;
  deviceId: string;
  faultType: string;
  severity: number;
  active: boolean;
};

export type SandboxSourceMode = "off" | "ventilation" | "cooling" | "heating" | "economizer";

export type SandboxRuntimeState = {
  runtimeSeconds: number;
  zones: Map<string, MutableZoneTruth>;
  actuators: Map<string, SandboxActuatorState>;
  filterLoadingFactor: number;
  sourceMode: SandboxSourceMode;
  supplyFanSpeedPct: number;
  outdoorAirFraction: number;
  mixedAirTemperatureC: number;
  supplyTemperatureC: number;
  supplyRelativeHumidityPct: number;
  supplyCo2Ppm: number;
};
