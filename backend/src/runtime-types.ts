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

export type RuntimeControlState = {
  sourceModePreference: FacilityModePreference;
  zoneTemperatureOffsetsC: Record<string, number>;
  occupancyBias: number;
  faultOverrides: Record<string, FaultOverrideMode>;
};

export type RuntimeControlInput = Partial<{
  sourceModePreference: FacilityModePreference;
  zoneTemperatureOffsetsC: Record<string, number>;
  occupancyBias: number;
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

export type RuntimeBootstrapPayload = {
  buildingId: string;
  generatedAt: string;
  blueprint: BuildingBlueprint;
  products: ProductDefinition[];
  latestSandboxBatch: SandboxTickResult | null;
  latestTwinSnapshot: TwinSnapshot | null;
  controls: RuntimeControlState;
  availableFaults: RuntimeFaultDescriptor[];
  persistenceSummary: RuntimePersistenceSummary;
};

export type WebSocketTickMessage = {
  type: "tick";
  payload: {
    generatedAt: string;
    twin: TwinSnapshot | null;
    sandbox: SandboxTickResult | null;
    controls: RuntimeControlState;
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
  };
};

export type WebSocketErrorMessage = {
  type: "error";
  payload: {
    message: string;
  };
};

export type RuntimeSocketMessage = WebSocketTickMessage | WebSocketHelloMessage | WebSocketAckMessage | WebSocketErrorMessage;
