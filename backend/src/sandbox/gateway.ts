import { BuildingBlueprint } from "../blueprint";
import { ProductDefinition } from "../catalog";
import {
  BuildingGatewayAdapter,
  GatewayCommandAck,
  GatewayDescriptor,
  GatewayPollResult,
  createGatewayCommandEnvelope,
  createGatewayProtocolDescriptor,
} from "../gateway-protocol";
import { RuntimeControlInput, RuntimeControlState, RuntimeFaultDescriptor } from "../runtime-types";
import { SandboxDataGenerationEngine } from "./engine";

export class SandboxBuildingGateway implements BuildingGatewayAdapter {
  private readonly descriptor: GatewayDescriptor;

  constructor(
    private readonly blueprint: BuildingBlueprint,
    private readonly products: ProductDefinition[],
    private readonly sandboxEngine: SandboxDataGenerationEngine,
  ) {
    const displayName =
      products.find((product) => product.id === "belimo_edge_building_gateway")?.official_reference_models[0] ??
      "Belimo Gateway";

    this.descriptor = {
      gatewayId: "gateway-1",
      productId: "belimo_edge_building_gateway",
      buildingId: blueprint.blueprint_id,
      displayName,
      transport: "wss_json",
      fieldProtocols: ["bacnet_mstp", "modbus_rtu", "mp_bus"],
      sourceKind: "sandbox",
    };
  }

  getDescriptor() {
    return this.descriptor;
  }

  getProtocolDescriptor() {
    return createGatewayProtocolDescriptor();
  }

  getControlState(): RuntimeControlState {
    return this.sandboxEngine.getControlState();
  }

  getAvailableFaults(): RuntimeFaultDescriptor[] {
    return this.sandboxEngine.getAvailableFaults();
  }

  async applyControl(input: RuntimeControlInput, actor: string) {
    const controls = this.sandboxEngine.updateControls(input);
    createGatewayCommandEnvelope({
      actor,
      gateway: this.descriptor,
      controlInput: input,
    });

    const ack: GatewayCommandAck = {
      protocolVersion: "belimo-pulse-gateway.v1",
      messageType: "gateway.command.ack",
      observedAt: new Date().toISOString(),
      gatewayId: this.descriptor.gatewayId,
      buildingId: this.descriptor.buildingId,
      accepted: true,
      appliedControls: controls,
    };

    return { controls, ack };
  }

  async pollSnapshot(now = new Date()): Promise<GatewayPollResult> {
    const batch = await this.sandboxEngine.tick(now);
    return {
      batch,
      envelope: {
        protocolVersion: "belimo-pulse-gateway.v1",
        messageType: "gateway.snapshot",
        observedAt: batch.observedAt,
        gateway: this.descriptor,
        controls: this.getControlState(),
        availableFaults: this.getAvailableFaults(),
        deviceReadings: batch.deviceReadings,
        weather: batch.weather,
      },
    };
  }
}
