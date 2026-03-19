import { BelimoRotaryActuatorFamily, getActuatorTravelPct } from "./shared";
import { RuntimeDeviceModelProps } from "./types";

export function BelimoNmvD3MpVavCompactModel({ telemetry }: RuntimeDeviceModelProps) {
  return (
    <BelimoRotaryActuatorFamily
      travelPct={getActuatorTravelPct(telemetry)}
      bodyLength={0.152}
      bodyHeight={0.082}
      bodyWidth={0.11}
      hasPressurePorts
    />
  );
}
