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

export type SandboxZoneControlMemory = {
  temperatureIntegralC: number;
  co2IntegralPpm: number;
  temperatureSlopeCPerMin: number;
  co2SlopePpmPerMin: number;
  lastTemperatureC: number;
  lastCo2Ppm: number;
};

export type SandboxAssistPlan = {
  trigger: "facility_manual_change" | "fault_detected" | "comfort_drift";
  modeBias: Exclude<SandboxSourceMode, "off"> | "auto";
  supplyTemperatureBiasC: number;
  fanSpeedBiasPct: number;
  outdoorAirBias: number;
  zoneDamperBiasPct: Record<string, number>;
  generatedAtRuntimeSeconds: number;
  expiresAtRuntimeSeconds: number;
};

export type SandboxRuntimeState = {
  runtimeSeconds: number;
  zones: Map<string, MutableZoneTruth>;
  zoneControlMemory: Map<string, SandboxZoneControlMemory>;
  actuators: Map<string, SandboxActuatorState>;
  filterLoadingFactor: number;
  sourceMode: SandboxSourceMode;
  supplyFanSpeedPct: number;
  outdoorAirFraction: number;
  mixedAirTemperatureC: number;
  supplyTemperatureC: number;
  supplyRelativeHumidityPct: number;
  supplyCo2Ppm: number;
  assistPlan: SandboxAssistPlan | null;
};
