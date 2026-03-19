import { readFileSync } from "fs";
import path from "path";
import { z } from "zod";

const sandboxTruthSchema = z.object({
  schema_version: z.string().min(1),
  truth_version: z.string().min(1),
  blueprint_id: z.string().min(1),
  runtime: z.object({
    simulation_timestep_s: z.number().int().positive(),
    random_seed: z.number().int(),
  }),
  weather: z.object({
    source: z.string().min(1),
    fallback_temperature_c: z.number(),
    fallback_relative_humidity_pct: z.number(),
  }),
  zone_truth: z.array(
    z.object({
      zone_id: z.string().min(1),
      effective_ua_w_per_k: z.number().positive(),
      effective_thermal_capacitance_kj_per_k: z.number().positive(),
      effective_infiltration_ach: z.number().nonnegative(),
      solar_gain_scale: z.number().min(0),
      occupancy_profile: z.object({
        weekday_peak_fraction: z.number().min(0).max(1),
        weekend_peak_fraction: z.number().min(0).max(1),
        stochastic_variation_pct: z.number().min(0).max(1),
      }),
    }),
  ),
  equipment_truth: z.object({
    source_equipment: z.object({
      device_id: z.string().min(1),
      cooling_capacity_kw: z.number().positive(),
      heating_capacity_kw: z.number().positive(),
      fan_static_coeff_pa: z.number().positive(),
      economizer_effectiveness: z.number().min(0).max(1),
    }),
    branch_flow_coefficients: z.array(
      z.object({
        device_id: z.string().min(1),
        flow_weight: z.number().positive(),
      }),
    ),
    actuator_truth: z.array(
      z.object({
        device_id: z.string().min(1),
        max_rate_pct_per_s: z.number().positive(),
        baseline_tracking_bias_pct: z.number(),
        baseline_torque_nmm: z.number().nonnegative(),
      }),
    ),
    filter: z.object({
      baseline_loading_factor: z.number().nonnegative(),
      natural_loading_hours_to_full_scale: z.number().positive(),
    }),
  }),
  sensor_noise: z.object({
    temperature_c_sigma: z.number().nonnegative(),
    humidity_pct_sigma: z.number().nonnegative(),
    co2_ppm_sigma: z.number().nonnegative(),
    pressure_pa_sigma: z.number().nonnegative(),
    airflow_m3_h_sigma: z.number().nonnegative(),
  }),
  fault_profiles: z.array(
    z.object({
      id: z.string().min(1),
      device_id: z.string().min(1),
      fault_type: z.string().min(1),
      activation_runtime_s: z.number().int().nonnegative(),
      severity: z.number().min(0).max(1),
    }),
  ),
});

export type SandboxTruth = z.infer<typeof sandboxTruthSchema>;

let cachedSandboxTruth: SandboxTruth | null = null;

function getTruthPath(blueprintId: string) {
  return path.resolve(__dirname, "..", "blueprints", `${blueprintId}.truth.json`);
}

export function loadSandboxTruth(blueprintId: string) {
  const raw = readFileSync(getTruthPath(blueprintId), "utf8");
  return sandboxTruthSchema.parse(JSON.parse(raw));
}

export function loadDefaultSandboxTruth() {
  if (cachedSandboxTruth) {
    return cachedSandboxTruth;
  }

  cachedSandboxTruth = loadSandboxTruth("sandbox-office-v1");
  return cachedSandboxTruth;
}
