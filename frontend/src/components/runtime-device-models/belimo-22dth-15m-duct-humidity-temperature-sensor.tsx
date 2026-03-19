import { BelimoDuctSensorFamily } from "./shared";

export function Belimo22dth15mDuctHumidityTemperatureSensorModel() {
  return <BelimoDuctSensorFamily variant="humidity" probeLength={0.14} />;
}
