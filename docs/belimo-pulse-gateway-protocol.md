# Belimo Pulse Gateway Protocol

## Purpose

`belimo-pulse-gateway.v1` is the northbound contract between an onsite building gateway and the Belimo Pulse backend.

The backend does not communicate directly with BACnet, Modbus, MP-Bus or vendor-specific local networks. The gateway is responsible for:

- discovering field devices inside the building
- translating southbound telemetry into the normalized product surface defined in `backend/products.json`
- executing writable commands against actuators and other controllable equipment
- publishing normalized building snapshots to the backend

The sandbox uses the same contract through a virtual adapter, so the backend runtime path is identical for simulated and real buildings.

## Transport

- Recommended transport: `wss_json`
- Alternative transport reserved by schema: `https_json`
- Authentication: bearer token or equivalent gateway credential managed outside the payload body

## Message Types

Uplink from gateway to backend:

- `gateway.hello`
- `gateway.snapshot`
- `gateway.command.ack`

Downlink from backend to gateway:

- `gateway.command.write`

## Gateway Responsibilities

The gateway owns the southbound side of the integration. That means it can speak whatever is appropriate for the local installation, for example:

- BACnet MS/TP
- BACnet/IP
- Modbus RTU
- Modbus TCP
- MP-Bus
- direct IP or Wi-Fi device APIs for newer products
- adapters for non-Belimo equipment included in the building blueprint

The backend only sees normalized Belimo Pulse envelopes and never depends on building-specific fieldbus details.

## Normalized Device Model

Every device exposed by the gateway must map to one product present in `backend/products.json`.

The gateway must emit:

- `deviceId`: stable device identifier from the blueprint
- `productId`: catalog product identifier
- `observedAt`: ISO timestamp
- `telemetry`: normalized telemetry object using the field names defined for that product

When a product is writable, the gateway must also translate backend commands into the writable points exposed by the real device.

## Envelope Examples

### `gateway.hello`

```json
{
  "protocolVersion": "belimo-pulse-gateway.v1",
  "messageType": "gateway.hello",
  "connectedAt": "2026-03-20T10:00:00.000Z",
  "gateway": {
    "gatewayId": "gateway-edge-01",
    "productId": "belimo_edge_building_gateway",
    "buildingId": "zurich-campus-west",
    "displayName": "Belimo Edge Building Gateway",
    "transport": "wss_json",
    "fieldProtocols": ["bacnet_mstp", "modbus_rtu", "mp_bus"],
    "sourceKind": "real"
  },
  "capabilities": {
    "supportsCommandAcks": true,
    "supportsDeviceWrites": true,
    "snapshotCadenceSeconds": 5
  }
}
```

### `gateway.snapshot`

```json
{
  "protocolVersion": "belimo-pulse-gateway.v1",
  "messageType": "gateway.snapshot",
  "observedAt": "2026-03-20T10:00:05.000Z",
  "gateway": {
    "gatewayId": "gateway-edge-01",
    "productId": "belimo_edge_building_gateway",
    "buildingId": "zurich-campus-west",
    "displayName": "Belimo Edge Building Gateway",
    "transport": "wss_json",
    "fieldProtocols": ["bacnet_mstp", "modbus_rtu", "mp_bus"],
    "sourceKind": "real"
  },
  "controls": {
    "sourceModePreference": "auto",
    "zoneTemperatureOffsetsC": {
      "open_office": 0.5
    },
    "occupancyBias": 0,
    "faultOverrides": {}
  },
  "availableFaults": [],
  "deviceReadings": [
    {
      "deviceId": "zone-damper-office-1",
      "productId": "belimo_lm24a_sr",
      "category": "actuator",
      "observedAt": "2026-03-20T10:00:05.000Z",
      "telemetry": {
        "position_pct": 47.2,
        "torque_nm": 5,
        "travel_time_s": 150
      }
    }
  ],
  "weather": {
    "source": "open-meteo",
    "observedAt": "2026-03-20T10:00:05.000Z",
    "temperatureC": 8.9,
    "relativeHumidityPct": 71,
    "windSpeedMps": 2.8,
    "windDirectionDeg": 215,
    "cloudCoverPct": 54,
    "isStale": false
  }
}
```

### `gateway.command.write`

```json
{
  "protocolVersion": "belimo-pulse-gateway.v1",
  "messageType": "gateway.command.write",
  "issuedAt": "2026-03-20T10:00:06.000Z",
  "actor": "building-brain",
  "gatewayId": "gateway-edge-01",
  "buildingId": "zurich-campus-west",
  "controlInput": {
    "sourceModePreference": "cooling",
    "zoneTemperatureOffsetsC": {
      "open_office": -0.3
    },
    "occupancyBias": 0.1,
    "faultOverrides": {}
  },
  "deviceWrites": [
    {
      "deviceId": "zone-damper-office-1",
      "productId": "belimo_lm24a_sr",
      "values": {
        "position_command_pct": 54
      }
    }
  ]
}
```

### `gateway.command.ack`

```json
{
  "protocolVersion": "belimo-pulse-gateway.v1",
  "messageType": "gateway.command.ack",
  "observedAt": "2026-03-20T10:00:06.180Z",
  "gatewayId": "gateway-edge-01",
  "buildingId": "zurich-campus-west",
  "accepted": true,
  "appliedControls": {
    "sourceModePreference": "cooling",
    "zoneTemperatureOffsetsC": {
      "open_office": -0.3
    },
    "occupancyBias": 0.1,
    "faultOverrides": {}
  }
}
```

## Blueprint Onboarding

When onboarding a building, the technician must provide a blueprint JSON compatible with the Belimo Pulse schema.

At minimum, the blueprint must define:

- building metadata
- floors
- spaces
- devices
- air loops
- a gateway device entry when the building is expected to operate live through an onsite gateway

The frontend onboarding modal validates the blueprint against the backend schema through `POST /api/blueprints/validate`.

## Implementation Checklist

1. Build or configure the onsite gateway so it can reach the backend over the chosen northbound transport.
2. Discover all Belimo and non-Belimo field devices inside the building.
3. Map every real device to a `productId` from `backend/products.json`.
4. Normalize all telemetry keys and writable points to the Belimo Pulse product contract.
5. Emit `gateway.hello` once the session is established.
6. Stream `gateway.snapshot` on a stable cadence.
7. Accept `gateway.command.write` and answer with `gateway.command.ack`.
8. Preserve stable `deviceId` values that match the uploaded blueprint so the digital twin, database and AI pipeline stay coherent.

## Sandbox Parity

The sandbox does not bypass this contract anymore. `backend/src/sandbox/gateway.ts` implements the same gateway abstraction and feeds the backend runtime with normalized gateway snapshots. This keeps the production architecture honest: simulated buildings and real buildings share the same backend ingestion model.
