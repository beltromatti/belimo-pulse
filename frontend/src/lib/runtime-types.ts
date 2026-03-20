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
  official_reference_models: string[];
  concept_roles: string[];
  catalog_basis: Record<string, unknown>;
  visualization: {
    model_id: string;
    family:
      | "belimo_rotary_actuator"
      | "belimo_duct_sensor"
      | "belimo_room_sensor"
      | "gateway_appliance"
      | "rooftop_unit"
      | "central_plant_module";
    mount_type:
      | "duct_shaft_side"
      | "duct_surface_probe"
      | "wall_surface"
      | "equipment_base"
      | "plant_room_pad";
  };
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
  kind: "source_equipment" | "actuator" | "sensor" | "gateway";
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

export type BrainAction = {
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
};

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  actions?: BrainAction[];
  timestamp: string;
};

export type BrainAlert = {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  suggestedAction?: string;
  timestamp: string;
  dismissed?: boolean;
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
        manualControls: RuntimeControlState;
        controlResolution: RuntimeControlResolution;
        persistenceSummary: RuntimePersistenceSummary;
      };
    }
  | {
      type: "ack";
      payload: {
        generatedAt: string;
        controls: RuntimeControlState;
        manualControls: RuntimeControlState;
        controlResolution: RuntimeControlResolution;
      };
    }
  | {
      type: "error";
      payload: {
        message: string;
      };
    }
  | {
      type: "brain_alert";
      payload: BrainAlert;
    }
  | {
      type: "simulation_preview";
      payload: RuntimeSimulationPreview;
    };
