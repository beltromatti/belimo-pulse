import { readFileSync } from "fs";
import path from "path";
import { z } from "zod";

const productSchema = z.object({
  id: z.string().min(1),
  brand: z.string().min(1),
  category: z.string().min(1),
  subtype: z.string().min(1),
  abstraction_level: z.string().min(1),
  official_reference_models: z.array(z.string()).default([]),
  concept_roles: z.array(z.string()).default([]),
  telemetry_schema: z.array(z.record(z.string(), z.unknown())).default([]),
  command_schema: z.array(z.record(z.string(), z.unknown())).default([]),
  sandbox_failure_modes: z.array(z.string()).default([]),
  catalog_basis: z.record(z.string(), z.unknown()).default({}),
  visualization: z.object({
    model_id: z.string().min(1),
    family: z.enum([
      "belimo_rotary_actuator",
      "belimo_duct_sensor",
      "belimo_room_sensor",
      "rooftop_unit",
      "central_plant_module",
    ]),
    mount_type: z.enum([
      "duct_shaft_side",
      "duct_surface_probe",
      "wall_surface",
      "equipment_base",
      "plant_room_pad",
    ]),
  }),
  sandbox_notes: z.string().optional(),
});

const productsCatalogSchema = z.object({
  schema_version: z.string().min(1),
  catalog_version: z.string().min(1),
  generated_for: z.string().min(1),
  products: z.array(productSchema),
});

export type ProductDefinition = z.infer<typeof productSchema>;
export type ProductsCatalog = z.infer<typeof productsCatalogSchema>;

let cachedCatalog: ProductsCatalog | null = null;

function getCatalogPath() {
  return path.resolve(__dirname, "..", "products.json");
}

export function loadProductsCatalog() {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  const raw = readFileSync(getCatalogPath(), "utf8");
  cachedCatalog = productsCatalogSchema.parse(JSON.parse(raw));
  return cachedCatalog;
}

export function getProductIndex() {
  return new Map(loadProductsCatalog().products.map((product) => [product.id, product]));
}

export function getProductById(productId: string) {
  const product = getProductIndex().get(productId);

  if (!product) {
    throw new Error(`Unknown product id: ${productId}`);
  }

  return product;
}
