import type { Tool } from "openai/resources/responses/responses";

import {
  listActiveOperatorPolicies,
  listRecentDeviceTelemetryHistory,
  listRecentTwinSnapshotSummaries,
  listRecentZoneTwinObservations,
} from "../db";
import { BelimoPlatform } from "../platform";

export const brainToolDefinitions: Tool[] = [
  {
    type: "function",
    name: "get_building_summary",
    description:
      "Get the current building status including comfort scores, weather, energy demand, and active alerts. Call this first when the user asks about the building.",
    parameters: { type: "object", properties: {}, required: [] },
    strict: false,
  },
  {
    type: "function",
    name: "get_zone_details",
    description:
      "Get detailed information about a specific thermal zone including temperature, humidity, CO2, airflow, occupancy, and comfort score.",
    parameters: {
      type: "object",
      properties: {
        zoneId: { type: "string", description: "The zone ID (e.g. 'lobby', 'open-office', 'meeting-room', 'facility-office')" },
      },
      required: ["zoneId"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "get_device_health",
    description:
      "Get the health status and diagnostics for a specific device including health score, alerts, and telemetry metrics.",
    parameters: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "The device ID (e.g. 'zone-damper-office-1', 'rtu-1', 'room-iaq-office-1')" },
      },
      required: ["deviceId"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "adjust_zone_temperature",
    description:
      "Adjust the temperature offset for a specific zone. Positive values make the zone warmer, negative values make it cooler. Range: -3 to +3 degrees C.",
    parameters: {
      type: "object",
      properties: {
        zoneId: { type: "string", description: "The zone to adjust" },
        offsetC: { type: "number", description: "Temperature offset in Celsius (-3 to +3)" },
      },
      required: ["zoneId", "offsetC"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "set_facility_mode",
    description:
      "Change the HVAC operating mode. 'auto' lets the system decide, 'cooling' forces cooling, 'heating' forces heating, 'economizer' uses free cooling from outdoor air, 'ventilation' provides air circulation without active heating/cooling.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["auto", "ventilation", "cooling", "heating", "economizer"],
          description: "The facility operating mode",
        },
      },
      required: ["mode"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "toggle_fault",
    description:
      "Toggle a fault simulation for testing or diagnostics. Use 'forced_on' to activate, 'forced_off' to deactivate, or 'auto' for time-based activation.",
    parameters: {
      type: "object",
      properties: {
        faultId: { type: "string", description: "The fault profile ID" },
        mode: { type: "string", enum: ["auto", "forced_on", "forced_off"], description: "Fault activation mode" },
      },
      required: ["faultId", "mode"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "get_weather",
    description: "Get the current outdoor weather conditions for the building location.",
    parameters: { type: "object", properties: {}, required: [] },
    strict: false,
  },
  {
    type: "function",
    name: "get_comfort_history",
    description: "Get recent comfort and environmental history for a specific zone.",
    parameters: {
      type: "object",
      properties: {
        zoneId: { type: "string", description: "The zone to query" },
        limit: { type: "number", description: "Number of recent observations (default 20, max 100)" },
      },
      required: ["zoneId"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "get_building_history",
    description:
      "Get recent historical building snapshots including comfort, supply temperature, demand, static pressure, controls, and active faults.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent snapshots to retrieve (default 12, max 48)" },
      },
      required: [],
    },
    strict: false,
  },
  {
    type: "function",
    name: "get_active_policies",
    description:
      "Get the durable operator policies Belimo Brain has stored for future building coordination, such as temperature schedules and energy preferences.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of active policies to retrieve (default 12, max 24)" },
      },
      required: [],
    },
    strict: false,
  },
  {
    type: "function",
    name: "get_device_telemetry_history",
    description:
      "Get recent raw telemetry samples for a device so Belimo Brain can inspect signal trends over time.",
    parameters: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "The device ID to inspect" },
        limit: { type: "number", description: "Number of recent samples to retrieve (default 20, max 60)" },
      },
      required: ["deviceId"],
    },
    strict: false,
  },
];

export async function executeBrainTool(
  platform: BelimoPlatform,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const twin = platform.getLatestTwinState();
  const blueprint = platform.getBlueprint();

  switch (toolName) {
    case "get_building_summary": {
      if (!twin) {
        return { error: "Building twin not yet initialized. Waiting for first data tick." };
      }

      return {
        building: blueprint.building.name,
        location: `${blueprint.building.location.city}, ${blueprint.building.location.country}`,
        timestamp: twin.observedAt,
        comfort: {
          averageScore: twin.summary.averageComfortScore,
          worstZone: twin.summary.worstZoneId,
          alertCount: twin.summary.activeAlertCount,
        },
        weather: {
          outdoorTemperatureC: twin.summary.outdoorTemperatureC,
          humidity: twin.weather.relativeHumidityPct,
          windSpeed: twin.weather.windSpeedMps,
          cloudCover: twin.weather.cloudCoverPct,
        },
        energy: {
          coolingDemandKw: twin.derived.buildingCoolingDemandKw,
          heatingDemandKw: twin.derived.buildingHeatingDemandKw,
          ventilationEffectiveness: twin.derived.ventilationEffectivenessPct,
          staticPressurePa: twin.derived.staticPressurePa,
        },
        supplyTemperatureC: twin.summary.supplyTemperatureC,
        zones: twin.zones.map((z) => ({
          id: z.zoneId,
          tempC: z.temperatureC,
          comfort: z.comfortScore,
          occupancy: z.occupancyCount,
        })),
        devices: twin.devices
          .filter((d) => d.alerts.length > 0 || d.healthScore < 85)
          .map((d) => ({
            id: d.deviceId,
            health: d.healthScore,
            alerts: d.alerts,
          })),
      };
    }

    case "get_zone_details": {
      const zoneId = String(args.zoneId);
      const zone = twin?.zones.find((z) => z.zoneId === zoneId);
      const space = blueprint.spaces.find((s) => s.id === zoneId);

      if (!zone || !space) {
        return { error: `Zone '${zoneId}' not found. Available: ${blueprint.spaces.map((s) => s.id).join(", ")}` };
      }

      const controls = platform.getControls();

      return {
        zone: zoneId,
        name: space.name,
        type: space.type,
        area: space.geometry.area_m2,
        volume: space.geometry.volume_m3,
        current: {
          temperatureC: zone.temperatureC,
          relativeHumidityPct: zone.relativeHumidityPct,
          co2Ppm: zone.co2Ppm,
          occupancyCount: zone.occupancyCount,
          supplyAirflowM3H: zone.supplyAirflowM3H,
          sensibleLoadW: zone.sensibleLoadW,
          comfortScore: zone.comfortScore,
        },
        targets: space.comfort_targets,
        temperatureOffset: controls.zoneTemperatureOffsetsC[zoneId] ?? 0,
      };
    }

    case "get_device_health": {
      const deviceId = String(args.deviceId);
      const device = twin?.devices.find((d) => d.deviceId === deviceId);

      if (!device) {
        return { error: `Device '${deviceId}' not found. Available: ${twin?.devices.map((d) => d.deviceId).join(", ")}` };
      }

      const blueprintDevice = blueprint.devices.find((d) => d.id === deviceId);

      return {
        deviceId: device.deviceId,
        productId: device.productId,
        kind: blueprintDevice?.kind,
        placement: blueprintDevice?.placement,
        healthScore: device.healthScore,
        alerts: device.alerts,
        metrics: device.metrics,
      };
    }

    case "adjust_zone_temperature": {
      const zoneId = String(args.zoneId);
      const offsetC = Number(args.offsetC);
      const result = await platform.updateControls(
        { zoneTemperatureOffsetsC: { [zoneId]: offsetC } },
        "belimo-brain",
        { triggerSimulationPreview: true },
      );

      return {
        success: true,
        zoneId,
        newOffset: result.controls.zoneTemperatureOffsetsC[zoneId],
        message: `Temperature offset for ${zoneId} set to ${offsetC > 0 ? "+" : ""}${offsetC}°C`,
      };
    }

    case "set_facility_mode": {
      const mode = String(args.mode) as "auto" | "ventilation" | "cooling" | "heating" | "economizer";
      const result = await platform.updateControls(
        { sourceModePreference: mode },
        "belimo-brain",
        { triggerSimulationPreview: true },
      );

      return {
        success: true,
        newMode: result.controls.sourceModePreference,
        message: `Facility mode changed to '${mode}'`,
      };
    }

    case "toggle_fault": {
      const faultId = String(args.faultId);
      const mode = String(args.mode) as "auto" | "forced_on" | "forced_off";
      const result = await platform.updateControls(
        { faultOverrides: { [faultId]: mode } },
        "belimo-brain",
        { triggerSimulationPreview: false },
      );

      return {
        success: true,
        faultId,
        newMode: result.controls.faultOverrides[faultId],
        message: `Fault '${faultId}' set to '${mode}'`,
      };
    }

    case "get_weather": {
      if (!twin) {
        return { error: "Weather data not yet available." };
      }

      return {
        source: twin.weather.source,
        observedAt: twin.weather.observedAt,
        temperatureC: twin.weather.temperatureC,
        relativeHumidityPct: twin.weather.relativeHumidityPct,
        windSpeedMps: twin.weather.windSpeedMps,
        windDirectionDeg: twin.weather.windDirectionDeg,
        cloudCoverPct: twin.weather.cloudCoverPct,
        isStale: twin.weather.isStale,
      };
    }

    case "get_comfort_history": {
      const zoneId = String(args.zoneId);
      const limit = Math.min(Number(args.limit) || 20, 100);
      const rows = await listRecentZoneTwinObservations(blueprint.blueprint_id, zoneId, limit);

      return {
        zoneId,
        count: rows.length,
        observations: rows.map((r) => ({
          at: r.observed_at,
          tempC: r.temperature_c,
          rh: r.relative_humidity_pct,
          co2: r.co2_ppm,
          occupancy: r.occupancy_count,
          airflow: r.supply_airflow_m3_h,
          comfort: r.comfort_score,
        })),
      };
    }

    case "get_building_history": {
      const limit = Math.min(Number(args.limit) || 12, 48);
      const rows = await listRecentTwinSnapshotSummaries(blueprint.blueprint_id, limit);

      return {
        count: rows.length,
        snapshots: rows.map((row) => ({
          at: row.observed_at,
          averageComfort: row.summary.averageComfortScore,
          worstZone: row.summary.worstZoneId,
          activeAlertCount: row.summary.activeAlertCount,
          outdoorTemperatureC: row.summary.outdoorTemperatureC,
          supplyTemperatureC: row.summary.supplyTemperatureC,
          coolingDemandKw: row.derived.buildingCoolingDemandKw,
          heatingDemandKw: row.derived.buildingHeatingDemandKw,
          ventilationEffectivenessPct: row.derived.ventilationEffectivenessPct,
          staticPressurePa: row.derived.staticPressurePa,
          controls: row.controls,
          activeFaults: row.active_faults ?? [],
        })),
      };
    }

    case "get_active_policies": {
      const limit = Math.min(Number(args.limit) || 12, 24);
      const rows = await listActiveOperatorPolicies(blueprint.blueprint_id, limit);

      return {
        count: rows.length,
        policies: rows.map((policy) => ({
          id: policy.id,
          summary: policy.summary,
          type: policy.policyType,
          scopeType: policy.scopeType,
          scopeId: policy.scopeId ?? null,
          importance: policy.importance,
          schedule: policy.schedule,
          details: policy.details,
          updatedAt: policy.updatedAt,
        })),
      };
    }

    case "get_device_telemetry_history": {
      const deviceId = String(args.deviceId);
      const limit = Math.min(Number(args.limit) || 20, 60);
      const rows = await listRecentDeviceTelemetryHistory(blueprint.blueprint_id, deviceId, limit);

      return {
        deviceId,
        count: rows.length,
        samples: rows.map((row) => ({
          at: row.observed_at,
          productId: row.product_id,
          telemetry: row.telemetry,
        })),
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
