"use client";

import { Html, OrbitControls, OrthographicCamera, RoundedBox, Text } from "@react-three/drei";
import { Canvas, ThreeEvent, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

import {
  BuildingBlueprint,
  SandboxTickResult,
  TwinSnapshot,
  ZoneTwinState,
} from "@/lib/runtime-types";

type RuntimeSceneProps = {
  blueprint: BuildingBlueprint;
  twin: TwinSnapshot | null;
  sandbox: SandboxTickResult | null;
  selectedZoneId: string | null;
  onSelectZone: (zoneId: string) => void;
};

type RoomCardProps = {
  zone: ZoneTwinState | undefined;
  label: string;
  isSelected: boolean;
};

type FlowTubeProps = {
  start: THREE.Vector3;
  mid: THREE.Vector3;
  end: THREE.Vector3;
  color: string;
  intensity: number;
};

function getRoomCenter(space: BuildingBlueprint["spaces"][number]) {
  return new THREE.Vector3(
    space.layout.origin_m.x + space.layout.size_m.width / 2,
    0,
    space.layout.origin_m.y + space.layout.size_m.depth / 2,
  );
}

function getZoneTone(zone: ZoneTwinState | undefined) {
  if (!zone) {
    return "#cbd5e1";
  }

  if (zone.comfortScore >= 92) {
    return "#16a34a";
  }

  if (zone.comfortScore >= 78) {
    return "#f59e0b";
  }

  return "#dc2626";
}

function RoomCard({ zone, label, isSelected }: RoomCardProps) {
  return (
    <div
      className={`min-w-[148px] rounded-2xl border px-3 py-2 text-slate-950 shadow-[0_16px_36px_rgba(15,23,42,0.18)] backdrop-blur ${
        isSelected
          ? "border-white/70 bg-white/90"
          : "border-white/40 bg-white/80"
      }`}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-slate-500">
        {label}
      </p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <p className="text-xl font-semibold leading-none">
            {zone ? `${zone.temperatureC.toFixed(1)}°` : "--"}
          </p>
          <p className="mt-1 text-xs text-slate-600">
            {zone ? `${zone.co2Ppm.toFixed(0)} ppm` : "No data"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: getZoneTone(zone) }}
          />
          <span className="text-xs font-medium text-slate-700">
            {zone ? `${zone.comfortScore.toFixed(0)}%` : "--"}
          </span>
        </div>
      </div>
    </div>
  );
}

function FlowTube({ start, mid, end, color, intensity }: FlowTubeProps) {
  const curve = useMemo(() => new THREE.CatmullRomCurve3([start, mid, end]), [end, mid, start]);
  const particleRefs = useRef<Array<THREE.Mesh | null>>([]);
  const points = useMemo(() => Array.from({ length: 6 }, (_, index) => index / 6), []);

  useFrame(({ clock }) => {
    const time = clock.getElapsedTime();
    particleRefs.current.forEach((mesh, index) => {
      if (!mesh) {
        return;
      }

      const progress = (points[index] + time * (0.06 + intensity * 0.08)) % 1;
      const point = curve.getPointAt(progress);
      mesh.position.copy(point);
    });
  });

  return (
    <group>
      <mesh>
        <tubeGeometry args={[curve, 48, 0.07 + intensity * 0.035, 12, false]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.3} transparent opacity={0.68} />
      </mesh>
      {points.map((point, index) => (
        <mesh
          key={`${point}-${index}`}
          ref={(node) => {
            particleRefs.current[index] = node;
          }}
        >
          <sphereGeometry args={[0.08 + intensity * 0.03, 18, 18]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2.6} />
        </mesh>
      ))}
    </group>
  );
}

function RuntimeSceneContent({
  blueprint,
  twin,
  sandbox,
  selectedZoneId,
  onSelectZone,
}: RuntimeSceneProps) {
  const twinZones = useMemo(
    () => new Map((twin?.zones ?? []).map((zone) => [zone.zoneId, zone])),
    [twin?.zones],
  );
  const sourceDevice = blueprint.devices.find((device) => device.kind === "source_equipment");
  const sourcePoint = sourceDevice
    ? new THREE.Vector3(sourceDevice.layout.position_m.x, 3.7, sourceDevice.layout.position_m.y)
    : new THREE.Vector3(10, 3.7, 5);
  const mode = String(
    sandbox?.deviceReadings.find((reading) => reading.deviceId === "rtu-1")?.telemetry.operating_mode ?? "ventilation",
  );
  const flowColor =
    mode === "heating" ? "#ff7a45" : mode === "cooling" || mode === "economizer" ? "#42b8ff" : "#88d1ff";

  const handleRoomClick = (event: ThreeEvent<MouseEvent>, zoneId: string) => {
    event.stopPropagation();
    onSelectZone(zoneId);
  };

  return (
    <>
      <color attach="background" args={["#dfe7ef"]} />
      <fog attach="fog" args={["#dfe7ef", 20, 48]} />
      <ambientLight intensity={1.4} />
      <hemisphereLight intensity={1.1} color="#f8fafc" groundColor="#cbd5e1" />
      <directionalLight
        castShadow
        position={[8, 18, 10]}
        intensity={2}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />
      <OrthographicCamera makeDefault position={[18, 18, 18]} zoom={36} near={0.1} far={200} />
      <OrbitControls
        enablePan={false}
        minPolarAngle={0.8}
        maxPolarAngle={1.1}
        minAzimuthAngle={-0.92}
        maxAzimuthAngle={-0.42}
        minZoom={28}
        maxZoom={48}
      />

      <group rotation={[-0.34, -0.72, -0.04]} position={[-11.5, 0, -6.2]}>
        <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[11, -0.1, 5.6]}>
          <planeGeometry args={[36, 26]} />
          <meshStandardMaterial color="#d4dde8" />
        </mesh>

        {blueprint.spaces.map((space) => {
          const center = getRoomCenter(space);
          const zone = twinZones.get(space.id);
          const color = zone
            ? zone.temperatureC >= 23.2
              ? "#f7c9b6"
              : zone.temperatureC <= 21.2
                ? "#cfe8ff"
                : "#ece8df"
            : "#ece8df";
          const isSelected = selectedZoneId === space.id;

          return (
            <group key={space.id}>
              <RoundedBox
                args={[space.layout.size_m.width, 0.16, space.layout.size_m.depth]}
                radius={0.08}
                smoothness={4}
                position={[center.x, 0, center.z]}
                receiveShadow
                castShadow
                onClick={(event) => handleRoomClick(event, space.id)}
              >
                <meshStandardMaterial color={color} metalness={0.06} roughness={0.88} />
              </RoundedBox>

              <RoundedBox
                args={[space.layout.size_m.width + 0.14, 0.12, 0.16]}
                radius={0.02}
                smoothness={2}
                position={[center.x, 1.18, space.layout.origin_m.y]}
                castShadow
              >
                <meshStandardMaterial color="#f7f5f0" />
              </RoundedBox>
              <RoundedBox
                args={[space.layout.size_m.width + 0.14, 0.12, 0.16]}
                radius={0.02}
                smoothness={2}
                position={[center.x, 1.18, space.layout.origin_m.y + space.layout.size_m.depth]}
                castShadow
              >
                <meshStandardMaterial color="#f7f5f0" />
              </RoundedBox>
              <RoundedBox
                args={[0.16, 1.26, space.layout.size_m.depth + 0.14]}
                radius={0.02}
                smoothness={2}
                position={[space.layout.origin_m.x, 0.58, center.z]}
                castShadow
              >
                <meshStandardMaterial color="#f7f5f0" />
              </RoundedBox>
              <RoundedBox
                args={[0.16, 1.26, space.layout.size_m.depth + 0.14]}
                radius={0.02}
                smoothness={2}
                position={[space.layout.origin_m.x + space.layout.size_m.width, 0.58, center.z]}
                castShadow
              >
                <meshStandardMaterial color="#f7f5f0" />
              </RoundedBox>

              <Html position={[center.x, 1.6, center.z]} transform occlude distanceFactor={10}>
                <RoomCard zone={zone} label={space.name} isSelected={isSelected} />
              </Html>
            </group>
          );
        })}

        {blueprint.spaces.map((space) => {
          const center = getRoomCenter(space);
          const zone = twinZones.get(space.id);
          const branchDevice = blueprint.devices.find(
            (device) => device.kind === "actuator" && device.served_space_ids.includes(space.id),
          );
          const branchPoint = branchDevice
            ? new THREE.Vector3(branchDevice.layout.position_m.x, 3.05, branchDevice.layout.position_m.y)
            : new THREE.Vector3(center.x, 3.05, center.z);
          const branchMid = new THREE.Vector3((sourcePoint.x + branchPoint.x) / 2, 3.45, sourcePoint.z);
          const intensity = zone ? Math.min(zone.supplyAirflowM3H / 1400, 1) : 0.2;

          return (
            <group key={`${space.id}-flow`}>
              <FlowTube start={sourcePoint} mid={branchMid} end={branchPoint} color={flowColor} intensity={intensity} />
              <FlowTube
                start={branchPoint}
                mid={new THREE.Vector3(branchPoint.x, 2.4, branchPoint.z)}
                end={new THREE.Vector3(center.x, 1.45, center.z)}
                color={flowColor}
                intensity={Math.max(0.12, intensity * 0.8)}
              />
            </group>
          );
        })}

        <RoundedBox args={[2.2, 1.2, 1.4]} radius={0.12} smoothness={4} position={[sourcePoint.x, 3.5, sourcePoint.z]}>
          <meshStandardMaterial color="#d9691f" metalness={0.18} roughness={0.42} />
        </RoundedBox>
        <Text
          position={[sourcePoint.x, 4.42, sourcePoint.z]}
          fontSize={0.36}
          color="#111827"
          anchorX="center"
          anchorY="middle"
        >
          RTU-1
        </Text>
      </group>
    </>
  );
}

export function RuntimeScene(props: RuntimeSceneProps) {
  return (
    <div className="relative h-[720px] w-full overflow-hidden rounded-[2rem] border border-white/40 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.9),rgba(223,231,239,0.72)_42%,rgba(204,214,226,0.92)_100%)] shadow-[0_28px_90px_rgba(15,23,42,0.18)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-32 bg-gradient-to-b from-white/55 to-transparent" />
      <Canvas shadows dpr={[1, 2]}>
        <RuntimeSceneContent {...props} />
      </Canvas>
    </div>
  );
}
