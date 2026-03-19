import { readFileSync } from "fs";
import path from "path";
import { z } from "zod";

const materialSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  thermal_conductivity_w_mk: z.number().positive(),
  density_kg_m3: z.number().positive(),
  specific_heat_j_kgk: z.number().positive(),
});

const constructionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  nominal_u_value_w_m2k: z.number().positive(),
  solar_heat_gain_coefficient: z.number().min(0).max(1).optional(),
  thermal_mass_class: z.enum(["low", "medium", "heavy"]),
  layers: z.array(
    z.object({
      material_id: z.string().min(1),
      thickness_m: z.number().positive(),
    }),
  ),
});

const spaceSurfaceSchema = z.object({
  surface_id: z.string().min(1),
  construction_id: z.string().min(1),
  area_m2: z.number().positive(),
  boundary: z.enum(["outdoor", "ground", "adjacent"]),
  orientation_deg: z.number().min(0).max(360),
});

const spaceSchema = z.object({
  id: z.string().min(1),
  floor_id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  layout: z.object({
    origin_m: z.object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
    }),
    size_m: z.object({
      width: z.number().positive(),
      depth: z.number().positive(),
    }),
  }),
  geometry: z.object({
    area_m2: z.number().positive(),
    height_m: z.number().positive(),
    volume_m3: z.number().positive(),
  }),
  envelope: z.object({
    opaque_surfaces: z.array(spaceSurfaceSchema),
    transparent_surfaces: z.array(spaceSurfaceSchema),
    infiltration_class: z.enum(["entry_high", "office_standard", "tight"]),
  }),
  occupancy_design: z.object({
    design_people: z.number().int().nonnegative(),
    co2_generation_lps_per_person: z.number().positive(),
    sensible_gain_w_per_person: z.number().nonnegative(),
    latent_gain_w_per_person: z.number().nonnegative(),
  }),
  internal_load_design: z.object({
    plug_w_per_m2: z.number().nonnegative(),
    lighting_w_per_m2: z.number().nonnegative(),
  }),
  comfort_targets: z.object({
    occupied_temperature_band_c: z.tuple([z.number(), z.number()]),
    unoccupied_temperature_band_c: z.tuple([z.number(), z.number()]),
    humidity_band_pct: z.tuple([z.number(), z.number()]),
    co2_limit_ppm: z.number().positive(),
  }),
});

const deviceSchema = z.object({
  id: z.string().min(1),
  product_id: z.string().min(1),
  kind: z.enum(["source_equipment", "actuator", "sensor"]),
  placement: z.string().min(1),
  served_space_ids: z.array(z.string()).default([]),
  layout: z.object({
    position_m: z.object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
    }),
  }),
  design: z.record(z.string(), z.number()).default({}),
});

const airLoopSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  source_equipment_id: z.string().min(1),
  node_ids: z.array(z.string().min(1)),
  edges: z.array(
    z.object({
      id: z.string().min(1),
      from_node_id: z.string().min(1),
      to_node_id: z.string().min(1),
      component_id: z.string().min(1),
      medium: z.literal("air"),
      type: z.string().min(1),
    }),
  ),
});

const blueprintSchema = z.object({
  schema_version: z.string().min(1),
  blueprint_version: z.string().min(1),
  blueprint_id: z.string().min(1),
  source_type: z.enum(["sandbox", "real"]),
  building: z.object({
    name: z.string().min(1),
    timezone: z.string().min(1),
    location: z.object({
      city: z.string().min(1),
      country: z.string().min(1),
      latitude: z.number(),
      longitude: z.number(),
    }),
    usage_type: z.string().min(1),
    gross_floor_area_m2: z.number().positive(),
    floor_count: z.number().int().positive(),
    ceiling_plenum_height_m: z.number().nonnegative(),
  }),
  design_basis: z.object({
    reference_patterns: z.array(z.string()),
    physics_model_intent: z.object({
      zone_model: z.string().min(1),
      air_distribution_model: z.string().min(1),
      digital_twin_goal: z.string().min(1),
    }),
  }),
  material_library: z.array(materialSchema).min(1),
  construction_library: z.array(constructionSchema).min(1),
  floors: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      elevation_m: z.number(),
      height_m: z.number().positive(),
    }),
  ),
  spaces: z.array(spaceSchema).min(1),
  devices: z.array(deviceSchema).min(1),
  systems: z.object({
    air_loops: z.array(airLoopSchema).min(1),
  }),
  control_profiles: z.object({
    occupancy_design: z.object({
      weekday_start_hour: z.number().min(0).max(24),
      weekday_peak_hour: z.number().min(0).max(24),
      weekday_end_hour: z.number().min(0).max(24),
      weekend_design_multiplier: z.number().min(0).max(1),
    }),
    air_loop_design: z.object({
      supply_air_temperature_reset_c: z.tuple([z.number(), z.number()]),
      supply_fan_speed_pct: z.tuple([z.number(), z.number()]),
      economizer_lockout_temperature_c: z.number(),
    }),
  }),
  identification_targets: z.object({
    building_parameters: z.array(z.string()),
    device_parameters: z.array(z.string()),
  }),
});

export type BuildingBlueprint = z.infer<typeof blueprintSchema>;
export type SpaceDefinition = z.infer<typeof spaceSchema>;
export type DeviceDefinition = z.infer<typeof deviceSchema>;
export type ConstructionDefinition = z.infer<typeof constructionSchema>;

let cachedSandboxBlueprint: BuildingBlueprint | null = null;

function getBlueprintPath(blueprintId: string) {
  return path.resolve(__dirname, "..", "blueprints", `${blueprintId}.json`);
}

export function loadBlueprint(blueprintId: string) {
  const raw = readFileSync(getBlueprintPath(blueprintId), "utf8");
  return blueprintSchema.parse(JSON.parse(raw));
}

export function loadSandboxBlueprint() {
  if (cachedSandboxBlueprint) {
    return cachedSandboxBlueprint;
  }

  cachedSandboxBlueprint = loadBlueprint("sandbox-office-v1");
  return cachedSandboxBlueprint;
}

export function getConstructionById(blueprint: BuildingBlueprint, constructionId: string) {
  const construction = blueprint.construction_library.find((candidate) => candidate.id === constructionId);

  if (!construction) {
    throw new Error(`Unknown construction id ${constructionId}`);
  }

  return construction;
}

export function getNominalUaForSpace(blueprint: BuildingBlueprint, spaceId: string) {
  const space = blueprint.spaces.find((candidate) => candidate.id === spaceId);

  if (!space) {
    throw new Error(`Unknown space ${spaceId}`);
  }

  const opaqueUa = space.envelope.opaque_surfaces.reduce(
    (sum, surface) => sum + getConstructionById(blueprint, surface.construction_id).nominal_u_value_w_m2k * surface.area_m2,
    0,
  );
  const transparentUa = space.envelope.transparent_surfaces.reduce(
    (sum, surface) => sum + getConstructionById(blueprint, surface.construction_id).nominal_u_value_w_m2k * surface.area_m2,
    0,
  );

  return opaqueUa + transparentUa;
}

export function getNominalThermalCapacitanceKjPerK(blueprint: BuildingBlueprint, spaceId: string) {
  const space = blueprint.spaces.find((candidate) => candidate.id === spaceId);

  if (!space) {
    throw new Error(`Unknown space ${spaceId}`);
  }

  const massClassFactor =
    space.envelope.opaque_surfaces.reduce((sum, surface) => {
      const construction = getConstructionById(blueprint, surface.construction_id);
      const factor = construction.thermal_mass_class === "heavy" ? 55 : construction.thermal_mass_class === "medium" ? 34 : 16;
      return sum + surface.area_m2 * factor;
    }, 0) / Math.max(space.geometry.area_m2, 1);

  return space.geometry.area_m2 * clampMassFactor(massClassFactor);
}

export function getNominalInfiltrationAch(space: SpaceDefinition) {
  if (space.envelope.infiltration_class === "entry_high") {
    return 0.65;
  }

  if (space.envelope.infiltration_class === "tight") {
    return 0.2;
  }

  return 0.35;
}

function clampMassFactor(value: number) {
  if (value < 22) {
    return 22;
  }

  if (value > 115) {
    return 115;
  }

  return value;
}
