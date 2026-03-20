import { DeviceDefinition } from "../blueprint";
import { ProductDefinition } from "../catalog";
import { clamp, dewPointFromTempRh, gaussianNoise, lerp, round } from "../physics";
import { DeviceTelemetryRecord } from "../runtime-types";
import { SandboxTruth } from "../sandbox-truth";
import {
  MutableZoneTruth,
  SandboxActuatorState,
  SandboxRuntimeFault,
  SandboxRuntimeState,
  SandboxSourceMode,
} from "./model";

type ActuatorTruthRecord = SandboxTruth["equipment_truth"]["actuator_truth"][number];

type SandboxTelemetryContext = {
  observedAt: string;
  weather: { temperatureC: number; relativeHumidityPct: number };
  random: () => number;
  sensorNoise: SandboxTruth["sensor_noise"];
  runtimeState: SandboxRuntimeState;
  zones: Map<string, MutableZoneTruth>;
  branchFlows: Record<string, number>;
  staticPressurePa: number;
  activeFaults: SandboxRuntimeFault[];
  sourceTruth: SandboxTruth["equipment_truth"]["source_equipment"];
  sourceDevice: DeviceDefinition;
};

type ActuatorStepInput = {
  device: DeviceDefinition;
  current: SandboxActuatorState;
  targetPct: number;
  dtSeconds: number;
  truth: ActuatorTruthRecord;
  obstructionSeverity: number;
};

type ActuatorBehavior = {
  initialize(device: DeviceDefinition): SandboxActuatorState;
  computeZoneCommand?(zoneDemand: number): number;
  step(input: ActuatorStepInput): SandboxActuatorState;
  toTelemetry(
    device: DeviceDefinition,
    product: ProductDefinition,
    actuator: SandboxActuatorState,
    context: SandboxTelemetryContext,
  ): DeviceTelemetryRecord;
};

type NonActuatorBehavior = {
  toTelemetry(device: DeviceDefinition, product: ProductDefinition, context: SandboxTelemetryContext): DeviceTelemetryRecord;
};

function createActuatorTelemetryRecord(
  device: DeviceDefinition,
  product: ProductDefinition,
  observedAt: string,
  telemetry: DeviceTelemetryRecord["telemetry"],
): DeviceTelemetryRecord {
  return {
    deviceId: device.id,
    productId: product.id,
    category: product.category,
    observedAt,
    telemetry,
  };
}

function initializeActuatorState(bodyTemperatureC: number): SandboxActuatorState {
  return {
    commandPct: 42,
    feedbackPct: 42,
    rotationDirection: 0,
    torqueNmm: 0,
    powerW: 0,
    bodyTemperatureC,
  };
}

function stepSampleLmActuator(input: ActuatorStepInput) {
  const current = structuredClone(input.current);
  current.commandPct = input.targetPct;

  let movementLimit = input.truth.max_rate_pct_per_s * input.dtSeconds;
  let obstructionTrackingOffsetPct = 0;
  if (input.obstructionSeverity > 0) {
    movementLimit *= 0.28;
    obstructionTrackingOffsetPct = 8 + input.obstructionSeverity * 10;
  }

  const biasedTarget =
    input.targetPct +
    input.truth.baseline_tracking_bias_pct +
    (input.targetPct >= current.feedbackPct ? -obstructionTrackingOffsetPct : obstructionTrackingOffsetPct * 0.45);
  const previousFeedback = current.feedbackPct;
  const nextFeedback =
    biasedTarget > previousFeedback
      ? Math.min(biasedTarget, previousFeedback + movementLimit)
      : Math.max(biasedTarget, previousFeedback - movementLimit);
  current.rotationDirection = nextFeedback === previousFeedback ? 0 : nextFeedback > previousFeedback ? 1 : 2;
  current.feedbackPct = nextFeedback;

  const branchLoadFactor = clamp(Math.abs(input.targetPct - nextFeedback) / 30, 0, 1);
  const movementPct = Math.abs(nextFeedback - previousFeedback);
  const speedFactor = clamp(movementPct / Math.max(movementLimit, 0.001), 0, 1.25);
  const obstruction = input.obstructionSeverity * 3.2;
  current.torqueNmm = round(
    current.rotationDirection === 0
      ? 0
      : input.truth.baseline_torque_nmm + speedFactor * 0.55 + branchLoadFactor * 0.7 + obstruction * 1.35,
    2,
  );
  current.powerW = round(
    current.rotationDirection === 0 ? 0 : 0.04 + speedFactor * 0.28 + branchLoadFactor * 0.14 + obstruction * 0.2,
    3,
  );
  current.bodyTemperatureC = round(lerp(current.bodyTemperatureC, 29.2 + current.powerW * 5.2, 0.16));
  return current;
}

function stepStandardDamperActuator(input: ActuatorStepInput) {
  const current = structuredClone(input.current);
  current.commandPct = input.targetPct;

  let movementLimit = input.truth.max_rate_pct_per_s * input.dtSeconds;
  let obstructionTrackingOffsetPct = 0;
  if (input.obstructionSeverity > 0) {
    movementLimit *= 0.28;
    obstructionTrackingOffsetPct = 7 + input.obstructionSeverity * 11;
  }

  const biasedTarget =
    input.targetPct +
    input.truth.baseline_tracking_bias_pct +
    (input.targetPct >= current.feedbackPct ? -obstructionTrackingOffsetPct : obstructionTrackingOffsetPct * 0.45);
  const previousFeedback = current.feedbackPct;
  const nextFeedback =
    biasedTarget > previousFeedback
      ? Math.min(biasedTarget, previousFeedback + movementLimit)
      : Math.max(biasedTarget, previousFeedback - movementLimit);
  current.rotationDirection = nextFeedback === previousFeedback ? 0 : nextFeedback > previousFeedback ? 1 : 2;
  current.feedbackPct = nextFeedback;

  const branchLoadFactor = clamp(Math.abs(input.targetPct - nextFeedback) / 30, 0, 1);
  const obstruction = input.obstructionSeverity * 3.2;
  current.torqueNmm = round(input.truth.baseline_torque_nmm + branchLoadFactor * 190 + obstruction * 180, 1);
  current.powerW = round(0.18 + branchLoadFactor * 0.16 + obstruction * 0.08, 3);
  current.bodyTemperatureC = round(lerp(current.bodyTemperatureC, 29 + current.powerW * 18, 0.16));
  return current;
}

const actuatorBehaviors: Record<string, ActuatorBehavior> = {
  belimo_lm_series_sample_air_damper_actuator: {
    initialize: () => initializeActuatorState(29.4),
    computeZoneCommand: (zoneDemand) => clamp(24 + zoneDemand * 68, 18, 98),
    step: stepSampleLmActuator,
    toTelemetry: (device, product, actuator, context) =>
      createActuatorTelemetryRecord(device, product, context.observedAt, {
        "setpoint_position_%": round(actuator.commandPct),
        "feedback_position_%": round(actuator.feedbackPct),
        rotation_direction: actuator.rotationDirection,
        motor_torque_Nmm: round(actuator.torqueNmm, 2),
        power_W: round(actuator.powerW, 3),
        internal_temperature_deg_C: round(actuator.bodyTemperatureC),
        test_number: -1,
      }),
  },
  belimo_nm24a_mod_air_damper_actuator: {
    initialize: () => initializeActuatorState(29),
    computeZoneCommand: (zoneDemand) => clamp(24 + zoneDemand * 68, 18, 98),
    step: stepStandardDamperActuator,
    toTelemetry: (device, product, actuator, context) =>
      createActuatorTelemetryRecord(device, product, context.observedAt, {
        commanded_position_pct: round(actuator.commandPct),
        feedback_position_pct: round(actuator.feedbackPct),
        rotation_direction: actuator.rotationDirection === 0 ? "idle" : actuator.rotationDirection === 1 ? "opening" : "closing",
        estimated_torque_nm: round(actuator.torqueNmm / 1000, 3),
        actuator_body_temperature_c: round(actuator.bodyTemperatureC),
      }),
  },
  belimo_nmv_d3_mp_vav_compact: {
    initialize: () => initializeActuatorState(29),
    computeZoneCommand: (zoneDemand) => clamp(28 + zoneDemand * 62, 20, 95),
    step: stepStandardDamperActuator,
    toTelemetry: (device, product, actuator, context) =>
      createActuatorTelemetryRecord(device, product, context.observedAt, {
        airflow_setpoint_m3_h: round((device.design.design_airflow_m3_h ?? 900) * (actuator.commandPct / 100)),
        airflow_measured_m3_h: round(
          (context.branchFlows[device.id] ?? 0) + gaussianNoise(context.random, context.sensorNoise.airflow_m3_h_sigma),
        ),
        damper_position_pct: round(actuator.feedbackPct),
        dynamic_pressure_pa: round(context.staticPressurePa * 0.42 + gaussianNoise(context.random, context.sensorNoise.pressure_pa_sigma)),
        zone_mode: "vav",
      }),
  },
};

const nonActuatorBehaviors: Record<string, NonActuatorBehavior> = {
  non_belimo_daikin_rebel_dps_rooftop_heat_pump: {
    toTelemetry: (device, product, context) => {
      const totalAirflowM3H = Object.values(context.branchFlows).reduce((sum, flow) => sum + flow, 0);
      const designAirflowM3H = context.sourceDevice.design.design_supply_airflow_m3_h ?? 4000;
      const fanPowerKw = 3.8 * Math.pow(clamp(context.runtimeState.supplyFanSpeedPct / 100, 0.2, 1.1), 3);
      const mDotSupplyKgPerS = (Math.max(totalAirflowM3H, 200) / 3600) * 1.2;
      const sensibleCapacityKw =
        (mDotSupplyKgPerS * 1005 * Math.abs(context.runtimeState.mixedAirTemperatureC - context.runtimeState.supplyTemperatureC)) /
        1000;
      const sourceLoadFraction =
        context.runtimeState.sourceMode === "cooling"
          ? clamp(sensibleCapacityKw / context.sourceTruth.cooling_capacity_kw, 0, 1)
          : context.runtimeState.sourceMode === "heating"
            ? clamp(sensibleCapacityKw / context.sourceTruth.heating_capacity_kw, 0, 1)
            : 0;

      return createActuatorTelemetryRecord(device, product, context.observedAt, {
        operating_mode: context.runtimeState.sourceMode,
        supply_air_temperature_c: round(context.runtimeState.supplyTemperatureC),
        return_air_temperature_c: round(
          Array.from(context.zones.values()).reduce((sum, zone) => sum + zone.temperatureC, 0) / Math.max(context.zones.size, 1),
        ),
        mixed_air_temperature_c: round(context.runtimeState.mixedAirTemperatureC),
        outdoor_air_temperature_c: round(context.weather.temperatureC),
        supply_airflow_m3_h: round(totalAirflowM3H),
        design_supply_airflow_m3_h: round(designAirflowM3H),
        outdoor_air_fraction: round(context.runtimeState.outdoorAirFraction, 3),
        supply_air_co2_ppm: round(context.runtimeState.supplyCo2Ppm),
        electrical_power_kw: round(
          fanPowerKw +
            (context.runtimeState.sourceMode === "cooling"
              ? 8.2 * sourceLoadFraction
              : context.runtimeState.sourceMode === "heating"
                ? 7.4 * sourceLoadFraction
                : 0.4),
          2,
        ),
        fault_state: context.activeFaults.some((fault) => fault.faultType === "controller_fault") ? "controller_fault" : "none",
      });
    },
  },
  belimo_22dt_12r_duct_temperature_sensor: {
    toTelemetry: (device, product, context) =>
      createActuatorTelemetryRecord(device, product, context.observedAt, {
        temperature_c: round(
          (device.id === "mixed-air-temp-1" ? context.runtimeState.mixedAirTemperatureC : context.runtimeState.supplyTemperatureC) +
            gaussianNoise(context.random, context.sensorNoise.temperature_c_sigma),
        ),
      }),
  },
  belimo_22dth_15m_duct_humidity_temperature_sensor: {
    toTelemetry: (device, product, context) =>
      createActuatorTelemetryRecord(device, product, context.observedAt, {
        temperature_c: round(context.runtimeState.supplyTemperatureC + gaussianNoise(context.random, context.sensorNoise.temperature_c_sigma)),
        relative_humidity_pct: round(
          context.runtimeState.supplyRelativeHumidityPct + gaussianNoise(context.random, context.sensorNoise.humidity_pct_sigma),
        ),
        dew_point_c: round(
          dewPointFromTempRh(context.runtimeState.supplyTemperatureC, context.runtimeState.supplyRelativeHumidityPct),
        ),
      }),
  },
  belimo_22adp_154k_differential_pressure_sensor: {
    toTelemetry: (device, product, context) => {
      const alarmState =
        context.runtimeState.filterLoadingFactor > 0.35 ? "high_filter_drop" : context.staticPressurePa < 180 ? "low_static" : "normal";

      return createActuatorTelemetryRecord(device, product, context.observedAt, {
        differential_pressure_pa: round(context.staticPressurePa + gaussianNoise(context.random, context.sensorNoise.pressure_pa_sigma)),
        estimated_airflow_m3_h: round(
          Object.values(context.branchFlows).reduce((sum, flow) => sum + flow, 0) +
            gaussianNoise(context.random, context.sensorNoise.airflow_m3_h_sigma),
        ),
        alarm_state: alarmState,
      });
    },
  },
  belimo_22rtm_5u00a_room_iaq_sensor: {
    toTelemetry: (device, product, context) => {
      const servedZone = device.served_space_ids[0] ? context.zones.get(device.served_space_ids[0]) : null;

      if (!servedZone) {
        throw new Error(`Room sensor ${device.id} is missing a served zone binding`);
      }

      return createActuatorTelemetryRecord(device, product, context.observedAt, {
        room_temperature_c: round(servedZone.temperatureC + gaussianNoise(context.random, context.sensorNoise.temperature_c_sigma)),
        room_relative_humidity_pct: round(
          servedZone.relativeHumidityPct + gaussianNoise(context.random, context.sensorNoise.humidity_pct_sigma),
        ),
        room_co2_ppm: round(servedZone.co2Ppm + gaussianNoise(context.random, context.sensorNoise.co2_ppm_sigma)),
      });
    },
  },
  belimo_edge_building_gateway: {
    toTelemetry: (device, product, context) =>
      createActuatorTelemetryRecord(device, product, context.observedAt, {
        backend_link_state: "connected",
        connected_device_count: context.zones.size + Object.keys(context.branchFlows).length + 8,
        uplink_latency_ms: 42,
        command_queue_depth: 0,
        field_protocols_active: "bacnet_mstp|modbus_rtu|mp_bus",
      }),
  },
};

export function hasSandboxBehavior(productId: string) {
  return productId in actuatorBehaviors || productId in nonActuatorBehaviors;
}

export function createInitialActuatorState(device: DeviceDefinition) {
  const behavior = actuatorBehaviors[device.product_id];

  if (!behavior) {
    throw new Error(`No actuator behavior registered for ${device.product_id}`);
  }

  return behavior.initialize(device);
}

export function computeZoneActuatorCommand(productId: string, zoneDemand: number) {
  const behavior = actuatorBehaviors[productId];
  return behavior?.computeZoneCommand ? behavior.computeZoneCommand(zoneDemand) : clamp(24 + zoneDemand * 68, 18, 98);
}

export function stepActuatorBehavior(input: ActuatorStepInput) {
  const behavior = actuatorBehaviors[input.device.product_id];

  if (!behavior) {
    throw new Error(`No actuator behavior registered for ${input.device.product_id}`);
  }

  return behavior.step(input);
}

export function buildDeviceTelemetryRecord(input: {
  device: DeviceDefinition;
  product: ProductDefinition;
  actuator: SandboxActuatorState | null;
  context: SandboxTelemetryContext;
}) {
  const actuatorBehavior = actuatorBehaviors[input.device.product_id];

  if (actuatorBehavior) {
    if (!input.actuator) {
      throw new Error(`Actuator state missing for ${input.device.id}`);
    }

    return actuatorBehavior.toTelemetry(input.device, input.product, input.actuator, input.context);
  }

  const behavior = nonActuatorBehaviors[input.device.product_id];

  if (!behavior) {
    throw new Error(`No sandbox behavior registered for ${input.device.product_id}`);
  }

  return behavior.toTelemetry(input.device, input.product, input.context);
}

export function getModeledSandboxProductIds() {
  return new Set([...Object.keys(actuatorBehaviors), ...Object.keys(nonActuatorBehaviors)]);
}
