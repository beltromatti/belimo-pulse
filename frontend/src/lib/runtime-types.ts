export type WeatherSnapshot = {
  source: "open-meteo";
  observedAt: string;
  temperatureC: number;
  relativeHumidityPct: number;
  windSpeedMps: number;
  windDirectionDeg: number;
  cloudCoverPct: number;
  isStale: boolean;
};

export type ProductDefinition = {
  id: string;
  brand: string;
  category: string;
  subtype: string;
};

export type BlueprintSurface = {
  surface_id: string;
  construction_id: string;
  area_m2: number;
  boundary: "outdoor" | "ground" | "adjacent";
  orientation_deg: number;
};

export type SpaceDefinition = {
  id: string;
  name: string;
  type: string;
  layout: {
    origin_m: { x: number; y: number; z: number };
    size_m: { width: number; depth: number };
  };
  geometry: {
    area_m2: number;
    height_m: number;
    volume_m3: number;
  };
  envelope: {
    opaque_surfaces: BlueprintSurface[];
    transparent_surfaces: BlueprintSurface[];
    infiltration_class: string;
  };
  comfort_targets: {
    occupied_temperature_band_c: [number, number];
    unoccupied_temperature_band_c: [number, number];
    humidity_band_pct: [number, number];
    co2_limit_ppm: number;
  };
};

export type DeviceDefinition = {
  id: string;
  product_id: string;
  kind: "source_equipment" | "actuator" | "sensor";
  placement: string;
  served_space_ids: string[];
  layout: {
    position_m: { x: number; y: number; z: number };
  };
  design: Record<string, number>;
};

export type BuildingBlueprint = {
  blueprint_id: string;
  blueprint_version: string;
  source_type: "sandbox" | "real";
  building: {
    name: string;
    timezone: string;
    location: {
      city: string;
      country: string;
      latitude: number;
      longitude: number;
    };
  };
  spaces: SpaceDefinition[];
  devices: DeviceDefinition[];
};

export type DeviceTelemetryRecord = {
  deviceId: string;
  productId: string;
  category: string;
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

export type RuntimeSocketMessage =
  | {
      type: "hello";
      payload: RuntimeBootstrapPayload;
    }
  | {
      type: "tick";
      payload: {
        generatedAt: string;
        twin: TwinSnapshot | null;
        sandbox: SandboxTickResult | null;
        controls: RuntimeControlState;
        persistenceSummary: RuntimePersistenceSummary;
      };
    }
  | {
      type: "ack";
      payload: {
        generatedAt: string;
        controls: RuntimeControlState;
      };
    }
  | {
      type: "error";
      payload: {
        message: string;
      };
    };
