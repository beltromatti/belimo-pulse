import { DeviceDefinition, DeviceTelemetryRecord } from "@/lib/runtime-types";

export type RuntimeDeviceModelProps = {
  device: DeviceDefinition;
  telemetry?: DeviceTelemetryRecord["telemetry"] | null;
};
