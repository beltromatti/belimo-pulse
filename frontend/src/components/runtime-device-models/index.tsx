import { ComponentType } from "react";

import { DeviceDefinition } from "@/lib/runtime-types";

import { Belimo22adp154kDifferentialPressureSensorModel } from "./belimo-22adp-154k-differential-pressure-sensor";
import { Belimo22dt12rDuctTemperatureSensorModel } from "./belimo-22dt-12r-duct-temperature-sensor";
import { Belimo22dth15mDuctHumidityTemperatureSensorModel } from "./belimo-22dth-15m-duct-humidity-temperature-sensor";
import { Belimo22rtm5u00aRoomIaqSensorModel } from "./belimo-22rtm-5u00a-room-iaq-sensor";
import { BelimoEdgeBuildingGatewayModel } from "./belimo-edge-building-gateway";
import { BelimoLmSeriesSampleAirDamperActuatorModel } from "./belimo-lm-series-sample-air-damper-actuator";
import { BelimoNm24aModAirDamperActuatorModel } from "./belimo-nm24a-mod-air-damper-actuator";
import { BelimoNmvD3MpVavCompactModel } from "./belimo-nmv-d3-mp-vav-compact";
import { NonBelimoDaikinRebelDpsRooftopHeatPumpModel } from "./non-belimo-daikin-rebel-dps-rooftop-heat-pump";
import { NonBelimoTraneSintesisRtafAirCooledChillerModel } from "./non-belimo-trane-sintesis-rtaf-air-cooled-chiller";
import { NonBelimoViessmannVitocrossal200Cm2BoilerModel } from "./non-belimo-viessmann-vitocrossal-200-cm2-boiler";
import { RuntimeDeviceModelProps } from "./types";

type ProductModelRegistration = {
  Component: ComponentType<RuntimeDeviceModelProps>;
  rotation: [number, number, number];
  positionOffset: [number, number, number];
  sceneScale: number;
  previewScale: number;
  previewRotation: [number, number, number];
};

const productModelRegistry: Record<string, ProductModelRegistration> = {
  belimo_lm_series_sample_air_damper_actuator: {
    Component: BelimoLmSeriesSampleAirDamperActuatorModel,
    rotation: [0, -Math.PI / 2, 0],
    positionOffset: [0.02, 0.01, 0],
    sceneScale: 2,
    previewScale: 7.4,
    previewRotation: [0.28, -0.88, 0],
  },
  belimo_nm24a_mod_air_damper_actuator: {
    Component: BelimoNm24aModAirDamperActuatorModel,
    rotation: [0, -Math.PI / 2, 0],
    positionOffset: [0.02, 0.012, 0],
    sceneScale: 2,
    previewScale: 7,
    previewRotation: [0.24, -0.92, 0],
  },
  belimo_nmv_d3_mp_vav_compact: {
    Component: BelimoNmvD3MpVavCompactModel,
    rotation: [0, -Math.PI / 2, 0],
    positionOffset: [0.024, 0.012, 0],
    sceneScale: 2,
    previewScale: 6.9,
    previewRotation: [0.24, -0.94, 0],
  },
  belimo_22dt_12r_duct_temperature_sensor: {
    Component: Belimo22dt12rDuctTemperatureSensorModel,
    rotation: [0, 0, 0],
    positionOffset: [0, 0.018, 0],
    sceneScale: 2,
    previewScale: 8.6,
    previewRotation: [0.16, -0.74, 0],
  },
  belimo_22dth_15m_duct_humidity_temperature_sensor: {
    Component: Belimo22dth15mDuctHumidityTemperatureSensorModel,
    rotation: [0, 0, 0],
    positionOffset: [0, 0.018, 0],
    sceneScale: 2,
    previewScale: 8.1,
    previewRotation: [0.18, -0.72, 0],
  },
  belimo_22adp_154k_differential_pressure_sensor: {
    Component: Belimo22adp154kDifferentialPressureSensorModel,
    rotation: [0, 0, 0],
    positionOffset: [0, 0.018, 0],
    sceneScale: 2,
    previewScale: 8.2,
    previewRotation: [0.16, -0.76, 0],
  },
  belimo_22rtm_5u00a_room_iaq_sensor: {
    Component: Belimo22rtm5u00aRoomIaqSensorModel,
    rotation: [0, Math.PI / 2, 0],
    positionOffset: [0, 0, 0.012],
    sceneScale: 2,
    previewScale: 10,
    previewRotation: [0.1, -0.48, 0],
  },
  belimo_edge_building_gateway: {
    Component: BelimoEdgeBuildingGatewayModel,
    rotation: [0, -Math.PI / 4, 0],
    positionOffset: [0, 0.02, 0],
    sceneScale: 1.75,
    previewScale: 8.2,
    previewRotation: [0.18, -0.72, 0],
  },
  non_belimo_daikin_rebel_dps_rooftop_heat_pump: {
    Component: NonBelimoDaikinRebelDpsRooftopHeatPumpModel,
    rotation: [0, 0, 0],
    positionOffset: [0, 0, 0],
    sceneScale: 1,
    previewScale: 0.72,
    previewRotation: [0.08, -0.48, 0],
  },
  non_belimo_trane_sintesis_rtaf_air_cooled_chiller: {
    Component: NonBelimoTraneSintesisRtafAirCooledChillerModel,
    rotation: [0, 0, 0],
    positionOffset: [0, 0, 0],
    sceneScale: 1,
    previewScale: 1.2,
    previewRotation: [0.08, -0.56, 0],
  },
  non_belimo_viessmann_vitocrossal_200_cm2_boiler: {
    Component: NonBelimoViessmannVitocrossal200Cm2BoilerModel,
    rotation: [0, 0, 0],
    positionOffset: [0, 0, 0],
    sceneScale: 1,
    previewScale: 1.2,
    previewRotation: [0.08, -0.56, 0],
  },
};

export function getProductModelRegistration(productId: string) {
  const registration = productModelRegistry[productId];

  if (!registration) {
    throw new Error(`Missing runtime 3D model registration for ${productId}`);
  }

  return registration;
}

export function getDeviceModelTransform(device: DeviceDefinition) {
  const registration = getProductModelRegistration(device.product_id);
  return registration;
}

export function RuntimeDeviceModel({
  productId,
  ...props
}: RuntimeDeviceModelProps & {
  productId: string;
}) {
  const registration = getProductModelRegistration(productId);
  const Model = registration.Component;
  return <Model {...props} />;
}
