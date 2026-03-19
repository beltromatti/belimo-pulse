"use client";

import { useMemo, useState } from "react";

import { ProductModelPreview } from "@/components/product-model-preview";
import {
  BuildingBlueprint,
  DeviceTelemetryRecord,
  ProductDefinition,
  SandboxTickResult,
} from "@/lib/runtime-types";

function formatLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatValue(value: unknown): string | null {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => formatValue(entry)).join(" / ");
  }

  return null;
}

function extractTechnicalSpecs(product: ProductDefinition) {
  const officialSpecs =
    product.catalog_basis && typeof product.catalog_basis === "object" && "official_specs" in product.catalog_basis
      ? (product.catalog_basis.official_specs as Record<string, unknown>)
      : null;

  if (!officialSpecs) {
    return [];
  }

  return Object.entries(officialSpecs)
    .map(([key, value]) => ({
      label: formatLabel(key),
      value: formatValue(value),
    }))
    .filter((entry) => entry.value)
    .slice(0, 4) as Array<{ label: string; value: string }>;
}

function getTelemetryHighlights(reading: DeviceTelemetryRecord | null) {
  if (!reading) {
    return [];
  }

  return Object.entries(reading.telemetry)
    .filter(([, value]) => typeof value === "number" || typeof value === "string")
    .slice(0, 3)
    .map(([key, value]) => ({
      label: formatLabel(key),
      value: typeof value === "number" ? value.toFixed(Number.isInteger(value) ? 0 : 1) : value,
    }));
}

function categoryOrder(category: string) {
  if (category === "actuator") {
    return 0;
  }

  if (category === "sensor") {
    return 1;
  }

  return 2;
}

function inferMountType(product: ProductDefinition) {
  if (product.visualization?.mount_type) {
    return product.visualization.mount_type;
  }

  if (product.category === "actuator") {
    return "duct_shaft_side";
  }

  if (product.category === "sensor") {
    return product.subtype.includes("room") ? "wall_surface" : "duct_surface_probe";
  }

  return "equipment_base";
}

export function InventoryPanel({
  blueprint,
  products,
  sandbox,
}: {
  blueprint: BuildingBlueprint;
  products: ProductDefinition[];
  sandbox: SandboxTickResult | null;
}) {
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const telemetryByDeviceId = useMemo(
    () => new Map((sandbox?.deviceReadings ?? []).map((reading) => [reading.deviceId, reading])),
    [sandbox?.deviceReadings],
  );

  const installedInventory = useMemo(() => {
    const grouped = new Map<
      string,
      {
        product: ProductDefinition;
        devices: BuildingBlueprint["devices"];
      }
    >();

    for (const device of blueprint.devices) {
      const product = productById.get(device.product_id);

      if (!product) {
        continue;
      }

      const existing = grouped.get(product.id);

      if (existing) {
        existing.devices.push(device);
        continue;
      }

      grouped.set(product.id, {
        product,
        devices: [device],
      });
    }

    return Array.from(grouped.values()).sort((left, right) => {
      const categoryDelta = categoryOrder(left.product.category) - categoryOrder(right.product.category);

      if (categoryDelta !== 0) {
        return categoryDelta;
      }

      return right.devices.length - left.devices.length || left.product.id.localeCompare(right.product.id);
    });
  }, [blueprint.devices, productById]);

  const [selectedProductId, setSelectedProductId] = useState<string | null>(installedInventory[0]?.product.id ?? null);

  const selectedEntry =
    installedInventory.find((entry) => entry.product.id === selectedProductId) ?? installedInventory[0] ?? null;

  if (!selectedEntry) {
    return null;
  }

  const selectedDevice = selectedEntry.devices[0];
  const telemetryReading = telemetryByDeviceId.get(selectedDevice.id) ?? null;
  const technicalSpecs = extractTechnicalSpecs(selectedEntry.product);
  const telemetryHighlights = getTelemetryHighlights(telemetryReading);

  return (
    <section className="mt-4 grid gap-4 xl:grid-cols-[0.56fr_0.44fr]">
      <div className="rounded-[2rem] border border-white/55 bg-white/68 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.11)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.3em] text-slate-500">Installed Inventory</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-slate-950">
              {selectedEntry.devices.length}x {selectedEntry.product.official_reference_models[0] ?? formatLabel(selectedEntry.product.subtype)}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Building-ready inventory view with a rotatable 3D product preview linked directly to the same model
              registry used inside the live twin.
            </p>
          </div>
          <span className="rounded-full bg-[#d9691f]/12 px-3 py-2 text-xs font-medium uppercase tracking-[0.22em] text-[#b94f12]">
            {selectedEntry.product.brand}
          </span>
        </div>

        <div className="mt-4">
          <ProductModelPreview
            product={selectedEntry.product}
            device={selectedDevice}
            telemetry={telemetryReading?.telemetry ?? null}
          />
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <SpecCard label="Installed" value={`${selectedEntry.devices.length} units`} />
          <SpecCard label="Category" value={formatLabel(selectedEntry.product.category)} />
          <SpecCard label="Mounting" value={formatLabel(inferMountType(selectedEntry.product))} />
        </div>
      </div>

      <div className="rounded-[2rem] border border-white/55 bg-white/68 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.11)]">
        <div className="grid gap-4 lg:grid-cols-[0.54fr_0.46fr]">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.3em] text-slate-500">Inventory List</p>
            <div className="mt-4 space-y-3">
              {installedInventory.map((entry) => {
                const active = entry.product.id === selectedEntry.product.id;

                return (
                  <button
                    key={entry.product.id}
                    type="button"
                    onClick={() => setSelectedProductId(entry.product.id)}
                    className={`w-full rounded-[1.4rem] border px-4 py-4 text-left transition ${
                      active
                        ? "border-[#d9691f]/30 bg-[#fff6f0] shadow-[0_16px_36px_rgba(217,105,31,0.12)]"
                        : "border-slate-200/70 bg-white/78 hover:border-slate-300/80 hover:bg-white"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">
                          {entry.devices.length}x {entry.product.official_reference_models[0] ?? entry.product.id}
                        </p>
                        <p className="mt-1 text-[11px] uppercase tracking-[0.22em] text-slate-500">
                          {entry.product.brand} · {formatLabel(entry.product.category)}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                          active ? "bg-[#d9691f] text-white" : "bg-slate-200/70 text-slate-600"
                        }`}
                      >
                        {entry.devices.length}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-[0.3em] text-slate-500">Selected Product Notes</p>
            <div className="mt-4 rounded-[1.5rem] border border-slate-200/70 bg-white/80 p-4">
              <p className="text-sm font-semibold text-slate-950">
                {selectedEntry.product.official_reference_models[0] ?? selectedEntry.product.id}
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {selectedEntry.product.concept_roles.slice(0, 2).map(formatLabel).join(" · ")}
              </p>

              <div className="mt-4 grid gap-3">
                {technicalSpecs.map((spec) => (
                  <SpecCard key={spec.label} label={spec.label} value={spec.value} compact />
                ))}
              </div>

              <div className="mt-4 rounded-[1.2rem] border border-slate-200/70 bg-slate-50/90 p-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-slate-500">Live Snapshot</p>
                <div className="mt-3 grid gap-2">
                  {telemetryHighlights.length > 0 ? (
                    telemetryHighlights.map((item) => (
                      <div key={item.label} className="flex items-center justify-between gap-3 rounded-full bg-white px-3 py-2">
                        <span className="text-xs uppercase tracking-[0.18em] text-slate-500">{item.label}</span>
                        <span className="text-sm font-semibold text-slate-900">{item.value}</span>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-slate-500">No live telemetry currently available for this device.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SpecCard({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  return (
    <div className={`rounded-[1.2rem] border border-slate-200/70 bg-white/80 ${compact ? "px-3 py-3" : "px-4 py-4"}`}>
      <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-slate-500">{label}</p>
      <p className={`mt-2 font-semibold text-slate-950 ${compact ? "text-sm" : "text-base"}`}>{value}</p>
    </div>
  );
}
