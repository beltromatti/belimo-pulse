import { z } from "zod";

import { DeviceTelemetryRecord, RuntimeControlInput, RuntimeControlState, RuntimeFaultDescriptor, SandboxTickResult } from "./runtime-types";

export const gatewayTransportSchema = z.enum(["wss_json", "https_json"]);
export const gatewayFieldProtocolSchema = z.enum([
  "bacnet_mstp",
  "bacnet_ip",
  "modbus_rtu",
  "modbus_tcp",
  "mp_bus",
  "analog_io",
  "wifi_ip",
]);

export const gatewayDescriptorSchema = z.object({
  gatewayId: z.string().min(1),
  productId: z.string().min(1),
  buildingId: z.string().min(1),
  displayName: z.string().min(1),
  transport: gatewayTransportSchema,
  fieldProtocols: z.array(gatewayFieldProtocolSchema).min(1),
  sourceKind: z.enum(["sandbox", "real"]),
});

export const gatewayHelloEnvelopeSchema = z.object({
  protocolVersion: z.literal("belimo-pulse-gateway.v1"),
  messageType: z.literal("gateway.hello"),
  connectedAt: z.string().datetime(),
  gateway: gatewayDescriptorSchema,
  capabilities: z.object({
    supportsCommandAcks: z.boolean(),
    supportsDeviceWrites: z.boolean(),
    snapshotCadenceSeconds: z.number().positive(),
  }),
});

export const gatewayCommandEnvelopeSchema = z.object({
  protocolVersion: z.literal("belimo-pulse-gateway.v1"),
  messageType: z.literal("gateway.command.write"),
  issuedAt: z.string().datetime(),
  actor: z.string().min(1),
  gatewayId: z.string().min(1),
  buildingId: z.string().min(1),
  controlInput: z.record(z.string(), z.unknown()),
  deviceWrites: z.array(
    z.object({
      deviceId: z.string().min(1),
      productId: z.string().min(1),
      values: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
    }),
  ),
});

export const gatewayCommandAckSchema = z.object({
  protocolVersion: z.literal("belimo-pulse-gateway.v1"),
  messageType: z.literal("gateway.command.ack"),
  observedAt: z.string().datetime(),
  gatewayId: z.string().min(1),
  buildingId: z.string().min(1),
  accepted: z.boolean(),
  appliedControls: z.object({
    sourceModePreference: z.enum(["auto", "ventilation", "cooling", "heating", "economizer"]),
    zoneTemperatureOffsetsC: z.record(z.string(), z.number()),
    zoneCo2SetpointsPpm: z.record(z.string(), z.number()),
    supplyTemperatureTrimC: z.number(),
    ventilationBoostPct: z.number(),
    occupancyBias: z.number(),
    windowOpenFractionByZone: z.record(z.string(), z.number()),
    weatherMode: z.enum(["live", "manual"]),
    weatherOverride: z.object({
      temperatureC: z.number(),
      relativeHumidityPct: z.number(),
      windSpeedMps: z.number(),
      windDirectionDeg: z.number(),
      cloudCoverPct: z.number(),
    }),
    timeMode: z.enum(["live", "virtual"]),
    timeSpeedMultiplier: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)]),
    solarGainBias: z.number(),
    plugLoadBias: z.number(),
    faultOverrides: z.record(z.string(), z.enum(["auto", "forced_on", "forced_off"])),
  }),
});

export const gatewaySnapshotEnvelopeSchema = z.object({
  protocolVersion: z.literal("belimo-pulse-gateway.v1"),
  messageType: z.literal("gateway.snapshot"),
  observedAt: z.string().datetime(),
  gateway: gatewayDescriptorSchema,
  controls: z.object({
    sourceModePreference: z.enum(["auto", "ventilation", "cooling", "heating", "economizer"]),
    zoneTemperatureOffsetsC: z.record(z.string(), z.number()),
    zoneCo2SetpointsPpm: z.record(z.string(), z.number()),
    supplyTemperatureTrimC: z.number(),
    ventilationBoostPct: z.number(),
    occupancyBias: z.number(),
    windowOpenFractionByZone: z.record(z.string(), z.number()),
    weatherMode: z.enum(["live", "manual"]),
    weatherOverride: z.object({
      temperatureC: z.number(),
      relativeHumidityPct: z.number(),
      windSpeedMps: z.number(),
      windDirectionDeg: z.number(),
      cloudCoverPct: z.number(),
    }),
    timeMode: z.enum(["live", "virtual"]),
    timeSpeedMultiplier: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)]),
    solarGainBias: z.number(),
    plugLoadBias: z.number(),
    faultOverrides: z.record(z.string(), z.enum(["auto", "forced_on", "forced_off"])),
  }),
  availableFaults: z.array(
    z.object({
      id: z.string().min(1),
      deviceId: z.string().min(1),
      faultType: z.string().min(1),
      severity: z.number(),
    }),
  ),
  deviceReadings: z.array(
    z.object({
      deviceId: z.string().min(1),
      productId: z.string().min(1),
      category: z.string().min(1),
      observedAt: z.string().datetime(),
      telemetry: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
    }),
  ),
  weather: z.object({
    source: z.literal("open-meteo"),
    observedAt: z.string().datetime(),
    temperatureC: z.number(),
    relativeHumidityPct: z.number(),
    windSpeedMps: z.number(),
    windDirectionDeg: z.number(),
    cloudCoverPct: z.number(),
    isStale: z.boolean(),
  }),
});

export type GatewayDescriptor = z.infer<typeof gatewayDescriptorSchema>;
export type GatewayHelloEnvelope = z.infer<typeof gatewayHelloEnvelopeSchema>;
export type GatewayCommandEnvelope = z.infer<typeof gatewayCommandEnvelopeSchema>;
export type GatewayCommandAck = z.infer<typeof gatewayCommandAckSchema>;
export type GatewaySnapshotEnvelope = z.infer<typeof gatewaySnapshotEnvelopeSchema>;

export type GatewayProtocolDescriptor = {
  protocolVersion: "belimo-pulse-gateway.v1";
  transport: "wss_json";
  purpose: string;
  fieldProtocolAbstraction: string[];
  uplinkMessages: Array<"gateway.hello" | "gateway.snapshot" | "gateway.command.ack">;
  downlinkMessages: Array<"gateway.command.write">;
  requiredSnapshotShape: {
    weather: string[];
    deviceReadings: string[];
    controlState: string[];
  };
  technicianNotes: string[];
};

export function createGatewayHelloEnvelope(input: {
  gateway: GatewayDescriptor;
  snapshotCadenceSeconds: number;
}): GatewayHelloEnvelope {
  return {
    protocolVersion: "belimo-pulse-gateway.v1",
    messageType: "gateway.hello",
    connectedAt: new Date().toISOString(),
    gateway: input.gateway,
    capabilities: {
      supportsCommandAcks: true,
      supportsDeviceWrites: true,
      snapshotCadenceSeconds: input.snapshotCadenceSeconds,
    },
  };
}

export type GatewayPollResult = {
  batch: SandboxTickResult;
  envelope: GatewaySnapshotEnvelope;
};

export interface BuildingGatewayAdapter {
  getDescriptor(): GatewayDescriptor;
  getProtocolDescriptor(): GatewayProtocolDescriptor;
  getControlState(): RuntimeControlState;
  getAvailableFaults(): RuntimeFaultDescriptor[];
  applyControl(input: RuntimeControlInput, actor: string): Promise<{ controls: RuntimeControlState; ack: GatewayCommandAck }>;
  pollSnapshot(now?: Date): Promise<GatewayPollResult>;
}

export function createGatewayProtocolDescriptor(): GatewayProtocolDescriptor {
  return {
    protocolVersion: "belimo-pulse-gateway.v1",
    transport: "wss_json",
    purpose:
      "Stable backend-to-building contract that abstracts BACnet, Modbus, MP-Bus and similar field integrations behind one JSON gateway surface.",
    fieldProtocolAbstraction: ["bacnet_mstp", "bacnet_ip", "modbus_rtu", "modbus_tcp", "mp_bus", "wifi_ip"],
    uplinkMessages: ["gateway.hello", "gateway.snapshot", "gateway.command.ack"],
    downlinkMessages: ["gateway.command.write"],
    requiredSnapshotShape: {
      weather: ["temperatureC", "relativeHumidityPct", "windSpeedMps", "windDirectionDeg", "cloudCoverPct"],
      deviceReadings: ["deviceId", "productId", "observedAt", "telemetry"],
      controlState: [
        "sourceModePreference",
        "zoneTemperatureOffsetsC",
        "zoneCo2SetpointsPpm",
        "supplyTemperatureTrimC",
        "ventilationBoostPct",
        "occupancyBias",
        "windowOpenFractionByZone",
        "weatherMode",
        "weatherOverride",
        "timeMode",
        "timeSpeedMultiplier",
        "solarGainBias",
        "plugLoadBias",
        "faultOverrides",
      ],
    },
    technicianNotes: [
      "Gateway is responsible for discovering local device addresses and translating fieldbus payloads into products.json-aligned telemetry and writable points.",
      "Backend never speaks BACnet, Modbus or MP-Bus directly; it only exchanges belimo-pulse-gateway.v1 JSON envelopes with the gateway.",
      "Sandbox uses the same contract through a virtual gateway adapter, so the backend pipeline is identical for simulated and real buildings.",
    ],
  };
}

export function createGatewayCommandEnvelope(input: {
  actor: string;
  gateway: GatewayDescriptor;
  controlInput: RuntimeControlInput;
  deviceWrites?: Array<{
    deviceId: string;
    productId: string;
    values: DeviceTelemetryRecord["telemetry"];
  }>;
}): GatewayCommandEnvelope {
  return {
    protocolVersion: "belimo-pulse-gateway.v1",
    messageType: "gateway.command.write",
    issuedAt: new Date().toISOString(),
    actor: input.actor,
    gatewayId: input.gateway.gatewayId,
    buildingId: input.gateway.buildingId,
    controlInput: input.controlInput,
    deviceWrites: (input.deviceWrites ?? []).map((write) => ({
      deviceId: write.deviceId,
      productId: write.productId,
      values: write.values,
    })),
  };
}
