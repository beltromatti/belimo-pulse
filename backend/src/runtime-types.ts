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
