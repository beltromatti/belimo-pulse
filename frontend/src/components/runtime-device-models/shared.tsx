import { RoundedBox } from "@react-three/drei/core/RoundedBox";
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { RuntimeDeviceModelProps } from "./types";

export const belimoPalette = {
  orange: "#d9691f",
  orangeDark: "#b94f12",
  gray: "#b7bfc9",
  grayDark: "#7b8794",
  steel: "#d8dee6",
  steelDark: "#9099a6",
  black: "#1f2937",
  graphite: "#2f3640",
  amber: "#efb52b",
  copper: "#cc8c54",
};

function CableHarness({
  points,
  radius = 0.006,
  color = belimoPalette.black,
}: {
  points: Array<[number, number, number]>;
  radius?: number;
  color?: string;
}) {
  const curve = useMemo(
    () => new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z))),
    [points],
  );

  return (
    <mesh>
      <tubeGeometry args={[curve, 24, radius, 10, false]} />
      <meshStandardMaterial color={color} roughness={0.82} metalness={0.12} />
    </mesh>
  );
}

function CableGland({ position }: { position: [number, number, number] }) {
  return (
    <mesh position={position} rotation={[0, 0, Math.PI / 2]}>
      <cylinderGeometry args={[0.011, 0.011, 0.028, 18]} />
      <meshStandardMaterial color={belimoPalette.graphite} roughness={0.58} metalness={0.28} />
    </mesh>
  );
}

function BelimoBadge({ position }: { position: [number, number, number] }) {
  return (
    <RoundedBox args={[0.05, 0.016, 0.032]} radius={0.004} smoothness={3} position={position}>
      <meshStandardMaterial color={belimoPalette.black} roughness={0.48} metalness={0.14} />
    </RoundedBox>
  );
}

function MountPlate({
  position,
  args,
  rotation,
  color = belimoPalette.gray,
}: {
  position: [number, number, number];
  args: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
}) {
  return (
    <RoundedBox args={args} radius={0.004} smoothness={3} position={position} rotation={rotation}>
      <meshStandardMaterial color={color} roughness={0.62} metalness={0.34} />
    </RoundedBox>
  );
}

function ActuatorTravelIndicator({ travelPct }: { travelPct: number }) {
  const indicatorRef = useRef<THREE.Group | null>(null);
  const targetRotation = ((travelPct / 100) * 0.96 - 0.48) * Math.PI;

  useFrame(() => {
    if (!indicatorRef.current) {
      return;
    }

    indicatorRef.current.rotation.x = THREE.MathUtils.lerp(
      indicatorRef.current.rotation.x,
      targetRotation,
      0.18,
    );
  });

  return (
    <group ref={indicatorRef}>
      <mesh rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[0.028, 0.0045, 12, 28]} />
        <meshStandardMaterial color={belimoPalette.amber} roughness={0.38} metalness={0.22} />
      </mesh>
      <mesh position={[0, 0.03, 0]}>
        <boxGeometry args={[0.007, 0.05, 0.005]} />
        <meshStandardMaterial color={belimoPalette.amber} roughness={0.34} metalness={0.22} />
      </mesh>
    </group>
  );
}

export function getActuatorTravelPct(telemetry: RuntimeDeviceModelProps["telemetry"]) {
  if (!telemetry) {
    return 42;
  }

  if (typeof telemetry["feedback_position_%"] === "number") {
    return Number(telemetry["feedback_position_%"]);
  }

  if (typeof telemetry.feedback_position_pct === "number") {
    return Number(telemetry.feedback_position_pct);
  }

  if (typeof telemetry.damper_position_pct === "number") {
    return Number(telemetry.damper_position_pct);
  }

  return 42;
}

export function BelimoRotaryActuatorFamily({
  travelPct,
  bodyLength = 0.145,
  bodyHeight = 0.078,
  bodyWidth = 0.098,
  hasPressurePorts = false,
}: {
  travelPct: number;
  bodyLength?: number;
  bodyHeight?: number;
  bodyWidth?: number;
  hasPressurePorts?: boolean;
}) {
  return (
    <group>
      <MountPlate position={[0.034, -0.024, 0]} args={[0.125, 0.028, 0.1]} color={belimoPalette.grayDark} />
      <MountPlate position={[0.034, -0.006, 0]} args={[0.154, 0.01, 0.055]} color={belimoPalette.steelDark} />
      <mesh position={[-0.005, 0.004, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.016, 0.016, 0.046, 24]} />
        <meshStandardMaterial color={belimoPalette.steel} roughness={0.4} metalness={0.65} />
      </mesh>
      <ActuatorTravelIndicator travelPct={travelPct} />

      <RoundedBox args={[bodyLength, bodyHeight, bodyWidth]} radius={0.01} smoothness={4} position={[0.08, 0.05, 0]}>
        <meshStandardMaterial color={belimoPalette.orange} roughness={0.68} metalness={0.08} />
      </RoundedBox>
      <RoundedBox args={[0.05, bodyHeight * 0.58, bodyWidth * 0.58]} radius={0.008} smoothness={4} position={[0.128, 0.057, 0]}>
        <meshStandardMaterial color={belimoPalette.black} roughness={0.5} metalness={0.18} />
      </RoundedBox>
      <BelimoBadge position={[0.04, 0.092, 0]} />
      <CableGland position={[0.152, 0.066, 0]} />
      <CableHarness
        points={[
          [0.167, 0.066, 0],
          [0.22, 0.085, 0.01],
          [0.29, 0.092, 0.022],
        ]}
      />

      <MountPlate position={[-0.004, -0.028, 0.032]} args={[0.06, 0.008, 0.012]} rotation={[0.18, 0, 0]} />
      <mesh position={[-0.036, -0.026, 0.032]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.007, 0.007, 0.028, 18]} />
        <meshStandardMaterial color={belimoPalette.copper} roughness={0.36} metalness={0.66} />
      </mesh>

      {hasPressurePorts ? (
        <group>
          <mesh position={[0.02, 0.032, -0.045]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.008, 0.008, 0.022, 18]} />
            <meshStandardMaterial color={belimoPalette.black} roughness={0.58} metalness={0.18} />
          </mesh>
          <mesh position={[0.02, 0.032, 0.045]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.008, 0.008, 0.022, 18]} />
            <meshStandardMaterial color={belimoPalette.black} roughness={0.58} metalness={0.18} />
          </mesh>
        </group>
      ) : null}
    </group>
  );
}

export function BelimoDuctSensorFamily({
  variant = "probe",
  probeLength = 0.14,
}: {
  variant?: "probe" | "humidity" | "pressure";
  probeLength?: number;
}) {
  return (
    <group>
      <MountPlate position={[0, 0.012, 0]} args={[0.07, 0.024, 0.055]} />
      <RoundedBox args={[0.108, 0.07, 0.074]} radius={0.01} smoothness={4} position={[0, 0.06, 0]}>
        <meshStandardMaterial color={belimoPalette.orange} roughness={0.68} metalness={0.08} />
      </RoundedBox>
      <BelimoBadge position={[-0.01, 0.101, 0]} />
      <CableGland position={[0.06, 0.067, 0]} />
      <CableHarness
        points={[
          [0.074, 0.067, 0],
          [0.12, 0.08, -0.004],
          [0.16, 0.085, -0.016],
        ]}
      />

      {variant === "pressure" ? (
        <group>
          <mesh position={[-0.018, -0.012, -0.016]}>
            <cylinderGeometry args={[0.004, 0.004, 0.06, 14]} />
            <meshStandardMaterial color={belimoPalette.steel} roughness={0.42} metalness={0.62} />
          </mesh>
          <mesh position={[0.018, -0.012, 0.016]}>
            <cylinderGeometry args={[0.004, 0.004, 0.06, 14]} />
            <meshStandardMaterial color={belimoPalette.steel} roughness={0.42} metalness={0.62} />
          </mesh>
          <CableHarness
            points={[
              [-0.018, 0.02, -0.016],
              [-0.012, -0.005, -0.03],
              [-0.004, -0.055, -0.04],
            ]}
            radius={0.003}
            color={belimoPalette.black}
          />
          <CableHarness
            points={[
              [0.018, 0.02, 0.016],
              [0.012, -0.005, 0.03],
              [0.004, -0.055, 0.04],
            ]}
            radius={0.003}
            color={belimoPalette.black}
          />
        </group>
      ) : (
        <group>
          <mesh position={[0, -probeLength * 0.48, 0]}>
            <cylinderGeometry args={[variant === "humidity" ? 0.006 : 0.004, 0.0065, probeLength, 18]} />
            <meshStandardMaterial color={belimoPalette.steel} roughness={0.4} metalness={0.7} />
          </mesh>
          <mesh position={[0, -probeLength + 0.008, 0]}>
            <sphereGeometry args={[variant === "humidity" ? 0.011 : 0.008, 16, 16]} />
            <meshStandardMaterial color={belimoPalette.grayDark} roughness={0.56} metalness={0.24} />
          </mesh>
          <MountPlate position={[0, 0.002, 0]} args={[0.04, 0.012, 0.04]} color={belimoPalette.steelDark} />
        </group>
      )}
    </group>
  );
}

export function BelimoRoomSensorFamily() {
  return (
    <group>
      <RoundedBox args={[0.066, 0.086, 0.008]} radius={0.008} smoothness={4} position={[0, 0, -0.004]}>
        <meshStandardMaterial color="#eef2f6" roughness={0.72} metalness={0.06} />
      </RoundedBox>
      <RoundedBox args={[0.058, 0.078, 0.024]} radius={0.01} smoothness={4} position={[0, 0, 0.012]}>
        <meshStandardMaterial color={belimoPalette.orange} roughness={0.7} metalness={0.08} />
      </RoundedBox>
      <BelimoBadge position={[0, 0.028, 0.026]} />
      {[-0.02, -0.007, 0.006, 0.019].map((y) => (
        <mesh key={y} position={[0, y, 0.028]}>
          <boxGeometry args={[0.028, 0.003, 0.003]} />
          <meshStandardMaterial color={belimoPalette.orangeDark} roughness={0.72} metalness={0.04} />
        </mesh>
      ))}
    </group>
  );
}

function SourceFan() {
  const fanRef = useRef<THREE.Group | null>(null);

  useFrame(({ clock }) => {
    if (!fanRef.current) {
      return;
    }

    fanRef.current.rotation.y = clock.getElapsedTime() * 2.1;
  });

  return (
    <group ref={fanRef} position={[0, 0.72, 0]}>
      {Array.from({ length: 4 }, (_, index) => (
        <mesh key={index} rotation={[0, (Math.PI / 2) * index, 0]}>
          <boxGeometry args={[0.08, 0.03, 0.58]} />
          <meshStandardMaterial color="#111827" metalness={0.2} roughness={0.45} />
        </mesh>
      ))}
    </group>
  );
}

export function NonBelimoRooftopHeatPumpFamily() {
  return (
    <group>
      <RoundedBox args={[2.3, 1.25, 1.5]} radius={0.14} smoothness={4} position={[0, 0, 0]}>
        <meshStandardMaterial color={belimoPalette.orange} metalness={0.18} roughness={0.42} />
      </RoundedBox>
      <RoundedBox args={[1.5, 0.2, 0.86]} radius={0.06} smoothness={3} position={[0, 0.55, 0]}>
        <meshStandardMaterial color="#f6d0bd" metalness={0.16} roughness={0.48} />
      </RoundedBox>
      <RoundedBox args={[0.72, 0.18, 0.52]} radius={0.04} smoothness={3} position={[-0.55, 0.32, 0]}>
        <meshStandardMaterial color="#111827" metalness={0.2} roughness={0.52} />
      </RoundedBox>
      <RoundedBox args={[0.72, 0.14, 0.3]} radius={0.04} smoothness={3} position={[0.62, 0.26, 0]}>
        <meshStandardMaterial color="#dbe5ee" metalness={0.16} roughness={0.46} />
      </RoundedBox>
      <SourceFan />
    </group>
  );
}

export function FutureCentralPlantModuleFamily({
  accentColor,
}: {
  accentColor: string;
}) {
  return (
    <group>
      <RoundedBox args={[1.3, 0.58, 0.82]} radius={0.06} smoothness={4} position={[0, 0, 0]}>
        <meshStandardMaterial color="#d7dde6" metalness={0.18} roughness={0.44} />
      </RoundedBox>
      <RoundedBox args={[0.28, 0.52, 0.82]} radius={0.04} smoothness={3} position={[-0.46, 0.02, 0]}>
        <meshStandardMaterial color={accentColor} metalness={0.12} roughness={0.54} />
      </RoundedBox>
      <mesh position={[0.48, -0.12, 0.26]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.07, 0.07, 0.42, 24]} />
        <meshStandardMaterial color={belimoPalette.steelDark} metalness={0.54} roughness={0.38} />
      </mesh>
      <mesh position={[0.48, -0.12, -0.26]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.07, 0.07, 0.42, 24]} />
        <meshStandardMaterial color={belimoPalette.steelDark} metalness={0.54} roughness={0.38} />
      </mesh>
    </group>
  );
}
