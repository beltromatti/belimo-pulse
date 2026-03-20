import { BuildingBlueprint } from "./blueprint";
import { ProductDefinition } from "./catalog";
import { WeatherSnapshot } from "./physics";

export type DeviceTelemetryRecord = {
  deviceId: string;
  productId: string;
  category: ProductDefinition["category"];
  observedAt: string;
  telemetry: Record<string, number | string | boolean | null>;
};

export type ZoneTwinState = {
  zoneId: string;
  temperatureC: number;
  relativeHumidityPct: number;
  co2Ppm: number;
  occupancyCount: number;
  supplyAirflowM3H: number;
  sensibleLoadW: number;
  comfortScore: number;
};

export type DeviceDiagnosis = {
  deviceId: string;
  productId: string;
  healthScore: number;
  alerts: string[];
  metrics: Record<string, number | string | boolean | null>;
};

export type TwinSnapshot = {
  buildingId: string;
  observedAt: string;
  sourceKind: "sandbox" | "real";
  summary: {
    averageComfortScore: number;
    worstZoneId: string;
    activeAlertCount: number;
    outdoorTemperatureC: number;
    supplyTemperatureC: number;
  };
  weather: WeatherSnapshot;
  zones: ZoneTwinState[];
  devices: DeviceDiagnosis[];
  derived: {
    buildingCoolingDemandKw: number;
    buildingHeatingDemandKw: number;
    ventilationEffectivenessPct: number;
    staticPressurePa: number;
  };
};

export type SandboxTickResult = {
  buildingId: string;
  observedAt: string;
  weather: WeatherSnapshot;
  deviceReadings: DeviceTelemetryRecord[];
  operationalState: {
    runtimeSeconds: number;
    activeFaults: Array<{
      id: string;
      deviceId: string;
      faultType: string;
      severity: number;
    }>;
  };
  truth: {
    zones: ZoneTwinState[];
    supplyTemperatureC: number;
    mixedAirTemperatureC: number;
    outdoorAirFraction: number;
    supplyAirflowM3H: number;
    staticPressurePa: number;
  };
};

export type FacilityModePreference = "auto" | "ventilation" | "cooling" | "heating" | "economizer";

export type FaultOverrideMode = "auto" | "forced_on" | "forced_off";

export type SandboxWeatherMode = "live" | "manual";
export type SandboxTimeMode = "live" | "virtual";
export type SandboxTimeSpeedMultiplier = 1 | 2 | 5 | 10;

export type SandboxWeatherOverride = {
  temperatureC: number;
  relativeHumidityPct: number;
  windSpeedMps: number;
  windDirectionDeg: number;
  cloudCoverPct: number;
};

export type RuntimeControlState = {
  sourceModePreference: FacilityModePreference;
  zoneTemperatureOffsetsC: Record<string, number>;
  zoneCo2SetpointsPpm: Record<string, number>;
  supplyTemperatureTrimC: number;
  ventilationBoostPct: number;
  occupancyBias: number;
  windowOpenFractionByZone: Record<string, number>;
  weatherMode: SandboxWeatherMode;
  weatherOverride: SandboxWeatherOverride;
  timeMode: SandboxTimeMode;
  timeSpeedMultiplier: SandboxTimeSpeedMultiplier;
  solarGainBias: number;
  plugLoadBias: number;
  faultOverrides: Record<string, FaultOverrideMode>;
};

export type RuntimeControlInput = Partial<{
  sourceModePreference: FacilityModePreference;
  zoneTemperatureOffsetsC: Record<string, number>;
  zoneCo2SetpointsPpm: Record<string, number>;
  supplyTemperatureTrimC: number;
  ventilationBoostPct: number;
  occupancyBias: number;
  windowOpenFractionByZone: Record<string, number>;
  weatherMode: SandboxWeatherMode;
  weatherOverride: Partial<SandboxWeatherOverride>;
  timeMode: SandboxTimeMode;
  timeSpeedMultiplier: SandboxTimeSpeedMultiplier;
  solarGainBias: number;
  plugLoadBias: number;
  faultOverrides: Record<string, FaultOverrideMode>;
}>;

export type RuntimeFaultDescriptor = {
  id: string;
  deviceId: string;
  faultType: string;
  severity: number;
};

export type RuntimePersistenceSummary = {
  rawWeatherSamples: number;
  rawDeviceSamples: number;
  twinSnapshots: number;
  runtimeFrames: number;
  zoneTwinSamples: number;
  deviceDiagnosisSamples: number;
  lastPersistedObservedAt: string | null;
};

export type RuntimeSimulationTrigger = "facility_manual_change" | "fault_detected" | "comfort_drift";

export type RuntimeSimulationPlan = {
  sourceMode: Exclude<FacilityModePreference, "auto">;
  supplyTemperatureSetpointC: number;
  supplyFanSpeedPct: number;
  outdoorAirFraction: number;
  zoneDamperTargetsPct: Record<string, number>;
};

export type RuntimeSimulationFrame = {
  simulatedMinute: number;
  twin: TwinSnapshot;
  sandbox: SandboxTickResult;
};

export type RuntimeSimulationPreview = {
  id: string;
  generatedAt: string;
  trigger: RuntimeSimulationTrigger;
  summary: string;
  accelerationFactor: number;
  horizonMinutes: number;
  playbackDurationMs: number;
  plan: RuntimeSimulationPlan;
  frames: RuntimeSimulationFrame[];
};

export type RuntimeBootstrapPayload = {
  buildingId: string;
  generatedAt: string;
  blueprint: BuildingBlueprint;
  products: ProductDefinition[];
  latestSandboxBatch: SandboxTickResult | null;
  latestTwinSnapshot: TwinSnapshot | null;
  controls: RuntimeControlState;
  manualControls: RuntimeControlState;
  controlResolution: RuntimeControlResolution;
  availableFaults: RuntimeFaultDescriptor[];
  persistenceSummary: RuntimePersistenceSummary;
  latestSimulationPreview: RuntimeSimulationPreview | null;
};

export type OperatorPolicyDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type OperatorPolicySchedule = {
  timezone: string;
  daysOfWeek: OperatorPolicyDay[];
  startLocalTime: string;
  endLocalTime: string;
};

export type OperatorPolicyType =
  | "zone_temperature_schedule"
  | "facility_mode_preference"
  | "occupancy_bias_preference"
  | "energy_strategy"
  | "operating_note";

export type OperatorPolicyScopeType = "building" | "zone";

export type OperatorPolicyImportance = "requirement" | "preference";

export type OperatorPolicyStatus = "active" | "superseded";

export type OperatorPolicy = {
  id: string;
  buildingId: string;
  conversationId?: string;
  policyKey: string;
  policyType: OperatorPolicyType;
  scopeType: OperatorPolicyScopeType;
  scopeId?: string;
  importance: OperatorPolicyImportance;
  summary: string;
  schedule: OperatorPolicySchedule | null;
  details: Record<string, unknown>;
  status: OperatorPolicyStatus;
  createdAt: string;
  updatedAt: string;
};

export type ActiveControlPolicy = {
  id: string;
  policyType: OperatorPolicyType;
  scopeType: OperatorPolicyScopeType;
  scopeId?: string;
  importance: OperatorPolicyImportance;
  summary: string;
  schedule: OperatorPolicySchedule | null;
  appliedControlPaths: string[];
};

export type RuntimeControlResolution = {
  generatedAt: string;
  manualControls: RuntimeControlState;
  effectiveControls: RuntimeControlState;
  activePolicies: ActiveControlPolicy[];
};

export type WebSocketTickMessage = {
  type: "tick";
  payload: {
    generatedAt: string;
    twin: TwinSnapshot | null;
    sandbox: SandboxTickResult | null;
    controls: RuntimeControlState;
    manualControls: RuntimeControlState;
    controlResolution: RuntimeControlResolution;
    persistenceSummary: RuntimePersistenceSummary;
  };
};

export type WebSocketHelloMessage = {
  type: "hello";
  payload: RuntimeBootstrapPayload;
};

export type WebSocketAckMessage = {
  type: "ack";
  payload: {
    generatedAt: string;
    controls: RuntimeControlState;
    manualControls: RuntimeControlState;
    controlResolution: RuntimeControlResolution;
  };
};

export type WebSocketErrorMessage = {
  type: "error";
  payload: {
    message: string;
  };
};

export type WebSocketBrainAlertMessage = {
  type: "brain_alert";
  payload: {
    id: string;
    severity: "info" | "warning" | "critical";
    title: string;
    body: string;
    suggestedAction?: string;
    timestamp: string;
  };
};

export type WebSocketSimulationPreviewMessage = {
  type: "simulation_preview";
  payload: RuntimeSimulationPreview;
};

export type RuntimeSocketMessage =
  | WebSocketTickMessage
  | WebSocketHelloMessage
  | WebSocketAckMessage
  | WebSocketErrorMessage
  | WebSocketBrainAlertMessage
  | WebSocketSimulationPreviewMessage;
