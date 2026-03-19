import { BelimoRotaryActuatorFamily, getActuatorTravelPct } from "./shared";
import { RuntimeDeviceModelProps } from "./types";

export function BelimoNm24aModAirDamperActuatorModel({ telemetry }: RuntimeDeviceModelProps) {
  return (
    <BelimoRotaryActuatorFamily
      travelPct={getActuatorTravelPct(telemetry)}
      bodyLength={0.158}
      bodyHeight={0.082}
      bodyWidth={0.102}
    />
  );
}
