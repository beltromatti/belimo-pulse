export const AIR_DENSITY_KG_PER_M3 = 1.2;
export const AIR_HEAT_CAPACITY_J_PER_KG_K = 1005;
export const WATER_VAPOR_LATENT_HEAT_J_PER_KG = 2_450_000;
export const STANDARD_ATMOSPHERIC_PRESSURE_KPA = 101.325;
export const OUTDOOR_CO2_PPM = 420;
export const NOMINAL_ROOM_RH_PCT = 45;

export type WeatherSnapshot = {
  source: "open-meteo";
  observedAt: string;
  temperatureC: number;
  relativeHumidityPct: number;
  windSpeedMps: number;
  windDirectionDeg: number;
  cloudCoverPct: number;
  isStale: boolean;
};

export type ZoneMassBalanceInput = {
  dtSeconds: number;
  zoneTemperatureC: number;
  outdoorTemperatureC: number;
  supplyTemperatureC: number;
  supplyAirflowM3H: number;
  zoneVolumeM3: number;
  uaWPerK: number;
  thermalCapacitanceKjPerK: number;
  infiltrationAch: number;
  sensibleInternalLoadW: number;
};

export type ZoneAirQualityInput = {
  dtSeconds: number;
  zoneVolumeM3: number;
  zoneCo2Ppm: number;
  outdoorCo2Ppm: number;
  supplyCo2Ppm: number;
  supplyAirflowM3H: number;
  infiltrationAch: number;
  occupancyCount: number;
  co2GenerationLpsPerPerson: number;
};

export type ZoneHumidityInput = {
  dtSeconds: number;
  zoneTemperatureC: number;
  outdoorTemperatureC: number;
  supplyTemperatureC: number;
  zoneRhPct: number;
  outdoorRhPct: number;
  supplyRhPct: number;
  supplyAirflowM3H: number;
  infiltrationAch: number;
  occupancyCount: number;
  latentGainWPerPerson: number;
  zoneVolumeM3: number;
};

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(from: number, to: number, weight: number) {
  return from + (to - from) * weight;
}

export function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
}

export function smoothStep(current: number, target: number, maxDelta: number) {
  if (target > current) {
    return Math.min(target, current + maxDelta);
  }

  return Math.max(target, current - maxDelta);
}

export function round(value: number, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function createSeededRng(seed: number) {
  let value = seed >>> 0;

  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussianNoise(random: () => number, sigma: number) {
  if (sigma === 0) {
    return 0;
  }

  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = Math.max(random(), Number.EPSILON);
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function computeOccupancyFraction(hourOfDay: number, startHour: number, peakHour: number, endHour: number) {
  if (hourOfDay <= startHour || hourOfDay >= endHour) {
    return 0.02;
  }

  if (hourOfDay <= peakHour) {
    return clamp((hourOfDay - startHour) / Math.max(peakHour - startHour, 0.5), 0.05, 1);
  }

  return clamp((endHour - hourOfDay) / Math.max(endHour - peakHour, 0.5), 0.05, 1);
}

export function solarGainMultiplier(cloudCoverPct: number, hourOfDay: number, solarGainFactor: number) {
  const daylightProfile = Math.max(0, Math.sin(((hourOfDay - 6) / 12) * Math.PI));
  const cloudFactor = 1 - clamp(cloudCoverPct / 100, 0, 0.85);
  return daylightProfile * cloudFactor * solarGainFactor;
}

export function computeZoneTemperatureStep(input: ZoneMassBalanceInput) {
  const dt = input.dtSeconds;
  const mDotSupply = (input.supplyAirflowM3H / 3600) * AIR_DENSITY_KG_PER_M3;
  const infiltrationM3PerS = (input.zoneVolumeM3 * input.infiltrationAch) / 3600;
  const mDotInfiltration = infiltrationM3PerS * AIR_DENSITY_KG_PER_M3;
  const capacitanceJPerK = input.thermalCapacitanceKjPerK * 1000;
  const envelopeHeatW = input.uaWPerK * (input.outdoorTemperatureC - input.zoneTemperatureC);
  const supplyHeatW = mDotSupply * AIR_HEAT_CAPACITY_J_PER_KG_K * (input.supplyTemperatureC - input.zoneTemperatureC);
  const infiltrationHeatW =
    mDotInfiltration * AIR_HEAT_CAPACITY_J_PER_KG_K * (input.outdoorTemperatureC - input.zoneTemperatureC);
  const deltaTJ = (envelopeHeatW + supplyHeatW + infiltrationHeatW + input.sensibleInternalLoadW) * dt;
  return input.zoneTemperatureC + deltaTJ / capacitanceJPerK;
}

export function computeZoneCo2Step(input: ZoneAirQualityInput) {
  const dt = input.dtSeconds;
  const ventilationM3PerS = input.supplyAirflowM3H / 3600;
  const infiltrationM3PerS = (input.zoneVolumeM3 * input.infiltrationAch) / 3600;
  const zoneVolume = Math.max(input.zoneVolumeM3, 1);
  const supplyExchangePpmPerSecond = (ventilationM3PerS / zoneVolume) * (input.supplyCo2Ppm - input.zoneCo2Ppm);
  const infiltrationExchangePpmPerSecond = (infiltrationM3PerS / zoneVolume) * (input.outdoorCo2Ppm - input.zoneCo2Ppm);
  const generationM3PerS = input.occupancyCount * input.co2GenerationLpsPerPerson / 1000;
  const generationPpmPerSecond = (generationM3PerS / zoneVolume) * 1_000_000;
  const nextCo2Ppm =
    input.zoneCo2Ppm + (generationPpmPerSecond + supplyExchangePpmPerSecond + infiltrationExchangePpmPerSecond) * dt;
  return Math.max(Math.min(input.outdoorCo2Ppm, input.supplyCo2Ppm), nextCo2Ppm);
}

export function computeZoneRhStep(input: ZoneHumidityInput) {
  const dt = input.dtSeconds;
  const zoneHumidityRatio = humidityRatioFromRh(input.zoneTemperatureC, input.zoneRhPct);
  const supplyHumidityRatio = humidityRatioFromRh(input.supplyTemperatureC, input.supplyRhPct);
  const outdoorHumidityRatio = humidityRatioFromRh(input.outdoorTemperatureC, input.outdoorRhPct);
  const dryAirMassKg = Math.max(input.zoneVolumeM3 * AIR_DENSITY_KG_PER_M3, 1);
  const mDotSupplyKgPerS = (input.supplyAirflowM3H / 3600) * AIR_DENSITY_KG_PER_M3;
  const mDotInfiltrationKgPerS = ((input.zoneVolumeM3 * input.infiltrationAch) / 3600) * AIR_DENSITY_KG_PER_M3;
  const moistureGenerationKgPerS =
    (input.occupancyCount * input.latentGainWPerPerson) / WATER_VAPOR_LATENT_HEAT_J_PER_KG;
  const deltaHumidityRatio =
    ((mDotSupplyKgPerS * (supplyHumidityRatio - zoneHumidityRatio) +
      mDotInfiltrationKgPerS * (outdoorHumidityRatio - zoneHumidityRatio) +
      moistureGenerationKgPerS) *
      dt) /
    dryAirMassKg;
  const nextHumidityRatio = Math.max(0.0005, zoneHumidityRatio + deltaHumidityRatio);
  return relativeHumidityFromHumidityRatio(input.zoneTemperatureC, nextHumidityRatio);
}

export function computeComfortScore(
  temperatureC: number,
  humidityPct: number,
  co2Ppm: number,
  comfortBand: [number, number],
  humidityBand: [number, number],
  co2LimitPpm: number,
) {
  const tempPenalty =
    temperatureC < comfortBand[0]
      ? (comfortBand[0] - temperatureC) * 18
      : temperatureC > comfortBand[1]
        ? (temperatureC - comfortBand[1]) * 18
        : 0;
  const humidityPenalty =
    humidityPct < humidityBand[0]
      ? (humidityBand[0] - humidityPct) * 1.2
      : humidityPct > humidityBand[1]
        ? (humidityPct - humidityBand[1]) * 1.2
        : 0;
  const co2Penalty = Math.max(0, (co2Ppm - co2LimitPpm) / 35);
  return clamp(100 - tempPenalty - humidityPenalty - co2Penalty, 0, 100);
}

export function computeMixedAirTemperature(outdoorTempC: number, returnTempC: number, outdoorAirFraction: number) {
  return outdoorTempC * outdoorAirFraction + returnTempC * (1 - outdoorAirFraction);
}

export function computeMixedRelativeHumidity(
  outdoorTempC: number,
  outdoorRhPct: number,
  returnTempC: number,
  returnRhPct: number,
  mixedAirTemperatureC: number,
  outdoorAirFraction: number,
) {
  const outdoorHumidityRatio = humidityRatioFromRh(outdoorTempC, outdoorRhPct);
  const returnHumidityRatio = humidityRatioFromRh(returnTempC, returnRhPct);
  const mixedHumidityRatio =
    outdoorHumidityRatio * outdoorAirFraction + returnHumidityRatio * (1 - outdoorAirFraction);
  return relativeHumidityFromHumidityRatio(mixedAirTemperatureC, mixedHumidityRatio);
}

export function computeStaticPressurePa(fanSpeedPct: number, totalFlowM3H: number, designFlowM3H: number, filterFactor: number) {
  const normalizedFan = clamp(fanSpeedPct / 100, 0, 1.2);
  const normalizedFlow = clamp(totalFlowM3H / Math.max(designFlowM3H, 1), 0, 1.6);
  const availableStatic = 1100 * normalizedFan * normalizedFan;
  const ductDrop = 120 * normalizedFlow * normalizedFlow;
  const filterDrop = 45 + 140 * filterFactor;
  return Math.max(25, availableStatic - ductDrop - filterDrop);
}

export function computeFilterLoading(runtimeHours: number, progressiveFaultSeverity: number, hoursToFullScale = 300) {
  const naturalLoading = clamp(runtimeHours / Math.max(hoursToFullScale, 1), 0, 0.18);
  return clamp(naturalLoading + progressiveFaultSeverity, 0, 1);
}

export function saturationVaporPressureKpa(temperatureC: number) {
  return 0.61094 * Math.exp((17.625 * temperatureC) / (temperatureC + 243.04));
}

export function humidityRatioFromRh(
  temperatureC: number,
  relativeHumidityPct: number,
  pressureKpa = STANDARD_ATMOSPHERIC_PRESSURE_KPA,
) {
  const rh = clamp(relativeHumidityPct / 100, 0, 1);
  const vaporPressureKpa = rh * saturationVaporPressureKpa(temperatureC);
  return 0.62198 * vaporPressureKpa / Math.max(pressureKpa - vaporPressureKpa, 0.1);
}

export function relativeHumidityFromHumidityRatio(
  temperatureC: number,
  humidityRatio: number,
  pressureKpa = STANDARD_ATMOSPHERIC_PRESSURE_KPA,
) {
  const vaporPressureKpa = (humidityRatio * pressureKpa) / Math.max(0.62198 + humidityRatio, 0.001);
  const saturationPressureKpa = saturationVaporPressureKpa(temperatureC);
  return clamp((vaporPressureKpa / Math.max(saturationPressureKpa, 0.01)) * 100, 5, 98);
}

export function dewPointFromTempRh(temperatureC: number, relativeHumidityPct: number) {
  const rh = clamp(relativeHumidityPct, 1, 100);
  const alpha = Math.log(rh / 100) + (17.625 * temperatureC) / (243.04 + temperatureC);
  return (243.04 * alpha) / (17.625 - alpha);
}
