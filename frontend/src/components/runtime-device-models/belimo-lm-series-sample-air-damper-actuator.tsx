import { BelimoRotaryActuatorFamily, getActuatorTravelPct } from "./shared";
import { RuntimeDeviceModelProps } from "./types";

export function BelimoLmSeriesSampleAirDamperActuatorModel({ telemetry }: RuntimeDeviceModelProps) {
  return <BelimoRotaryActuatorFamily travelPct={getActuatorTravelPct(telemetry)} />;
}
