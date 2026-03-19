"use client";

import Image from "next/image";
import { OrbitControls } from "@react-three/drei/core/OrbitControls";
import { RoundedBox } from "@react-three/drei/core/RoundedBox";
import { Html } from "@react-three/drei/web/Html";
import { Canvas, ThreeEvent, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import {
  BuildingBlueprint,
  DeviceDefinition,
  DeviceDiagnosis,
  ProductDefinition,
  SandboxTickResult,
  TwinSnapshot,
  ZoneTwinState,
} from "@/lib/runtime-types";
import { getDeviceModelTransform, RuntimeDeviceModel } from "@/components/runtime-device-models";

type RuntimeSceneProps = {
  blueprint: BuildingBlueprint;
  products: ProductDefinition[];
  twin: TwinSnapshot | null;
  sandbox: SandboxTickResult | null;
  selectedZoneId: string | null;
  worstZoneId: string | null;
  onSelectZone: (zoneId: string) => void;
  totalAirflowM3H: number;
  sourcePowerKw: number;
};

type RuntimeSceneContentProps = RuntimeSceneProps & {
  autoRotateActive: boolean;
  controlsRef: { current: import("three-stdlib").OrbitControls | null };
};

type RoomBadgeProps = {
  zone: ZoneTwinState | undefined;
  label: string;
  isSelected: boolean;
  isWorstZone: boolean;
};

type FlowRouteProps = {
  points: THREE.Vector3[];
  color: string;
  intensity: number;
};

const LOCKED_POLAR_ANGLE = 0.96;
const AUTO_ROTATE_IDLE_DELAY_MS = 5000;
const AUTO_ROTATE_SPEED = 0.45;

function getRoomCenter(space: BuildingBlueprint["spaces"][number]) {
  return new THREE.Vector3(
    space.layout.origin_m.x + space.layout.size_m.width / 2,
    0,
    space.layout.origin_m.y + space.layout.size_m.depth / 2,
  );
}

function getDeviceScenePosition(device: DeviceDefinition) {
  return new THREE.Vector3(device.layout.position_m.x, device.layout.position_m.z, device.layout.position_m.y);
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

function getSpaceColor(zone: ZoneTwinState | undefined) {
  if (!zone) {
    return "#ece8df";
  }

  if (zone.temperatureC >= 23.4) {
    return "#f2c4b1";
  }

  if (zone.temperatureC <= 21) {
    return "#cfe5ff";
  }

  return "#ebe7dd";
}

function RoomBadge({ zone, label, isSelected, isWorstZone }: RoomBadgeProps) {
  return (
    <div
      className={`rounded-2xl border px-3 py-2 shadow-[0_16px_36px_rgba(15,23,42,0.16)] backdrop-blur ${
        isSelected ? "min-w-[152px] border-white/75 bg-white/92" : "min-w-[118px] border-white/48 bg-white/82"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-500">{label}</p>
        <span className="flex items-center gap-2">
          {isWorstZone ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700">
              focus
            </span>
          ) : null}
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: getZoneTone(zone) }} />
        </span>
      </div>
      <div className="mt-2 flex items-end justify-between gap-4">
        <div>
          <p className="text-xl font-semibold leading-none text-slate-950">
            {zone ? `${zone.temperatureC.toFixed(1)} deg` : "--"}
          </p>
          {isSelected ? (
            <p className="mt-1 text-xs text-slate-600">
              {zone ? `${zone.co2Ppm.toFixed(0)} ppm | ${zone.supplyAirflowM3H.toFixed(0)} m3/h` : "No data"}
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-600">
              {zone ? `${zone.comfortScore.toFixed(0)}% comfort` : "No data"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function FloatingRoomBadge({
  position,
  zone,
  label,
  isSelected,
  isWorstZone,
}: {
  position: [number, number, number];
  zone: ZoneTwinState | undefined;
  label: string;
  isSelected: boolean;
  isWorstZone: boolean;
}) {
  const groupRef = useRef<THREE.Group | null>(null);
  const baseY = position[1];
  const phase = useMemo(() => position[0] * 0.11 + position[2] * 0.07, [position]);

  useFrame(({ clock }) => {
    if (!groupRef.current) {
      return;
    }

    groupRef.current.position.y = baseY + Math.sin(clock.getElapsedTime() * 1.2 + phase) * 0.06;
  });

  return (
    <group ref={groupRef} position={position}>
      <Html transform sprite distanceFactor={11}>
        <RoomBadge zone={zone} label={label} isSelected={isSelected} isWorstZone={isWorstZone} />
      </Html>
    </group>
  );
}

function FlowRoute({ points, color, intensity }: FlowRouteProps) {
  const curve = useMemo(() => new THREE.CatmullRomCurve3(points), [points]);
  const particleRefs = useRef<Array<THREE.Mesh | null>>([]);
  const particles = useMemo(() => Array.from({ length: 5 }, (_, index) => index / 5), []);

  useFrame(({ clock }) => {
    const time = clock.getElapsedTime();
    particleRefs.current.forEach((mesh, index) => {
      if (!mesh) {
        return;
      }

      const progress = (particles[index] + time * (0.045 + intensity * 0.1)) % 1;
      const point = curve.getPointAt(progress);
      mesh.position.copy(point);
    });
  });

  return (
    <group>
      <mesh>
        <tubeGeometry args={[curve, 60, 0.06 + intensity * 0.025, 10, false]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.2} transparent opacity={0.68} />
      </mesh>
      {particles.map((particle, index) => (
        <mesh
          key={`${particle}-${index}`}
          ref={(node) => {
            particleRefs.current[index] = node;
          }}
        >
          <sphereGeometry args={[0.07 + intensity * 0.025, 16, 16]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2.5} />
        </mesh>
      ))}
    </group>
  );
}

function DuctSegment({
  from,
  to,
  thickness = 0.24,
  color = "#c3ccd8",
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  thickness?: number;
  color?: string;
}) {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const dz = Math.abs(to.z - from.z);
  const center = new THREE.Vector3((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);

  if (dx >= dy && dx >= dz) {
    return (
      <RoundedBox args={[Math.max(dx, 0.2), thickness, thickness]} radius={0.04} smoothness={3} position={center}>
        <meshStandardMaterial color={color} metalness={0.38} roughness={0.4} />
      </RoundedBox>
    );
  }

  if (dz >= dx && dz >= dy) {
    return (
      <RoundedBox args={[thickness, thickness, Math.max(dz, 0.2)]} radius={0.04} smoothness={3} position={center}>
        <meshStandardMaterial color={color} metalness={0.38} roughness={0.4} />
      </RoundedBox>
    );
  }

  return (
    <RoundedBox args={[0.16, Math.max(dy, 0.2), 0.16]} radius={0.03} smoothness={3} position={center}>
      <meshStandardMaterial color={color} metalness={0.18} roughness={0.5} />
    </RoundedBox>
  );
}

function WindowStrip({
  center,
  orientationDeg,
  width,
}: {
  center: THREE.Vector3;
  orientationDeg: number;
  width: number;
}) {
  const isVerticalWall = orientationDeg === 90 || orientationDeg === 270;
  const position: [number, number, number] =
    orientationDeg === 0
      ? [center.x, 0.72, center.z - 0.08]
      : orientationDeg === 180
        ? [center.x, 0.72, center.z + 0.08]
        : orientationDeg === 90
          ? [center.x + 0.08, 0.72, center.z]
          : [center.x - 0.08, 0.72, center.z];
  const rotation: [number, number, number] = isVerticalWall ? [0, Math.PI / 2, 0] : [0, 0, 0];

  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={isVerticalWall ? [1.02, width] : [width, 1.02]} />
      <meshStandardMaterial color="#dff4ff" transparent opacity={0.55} emissive="#7dd3fc" emissiveIntensity={0.15} />
    </mesh>
  );
}

function getTemperatureColor(temperatureC: number) {
  const cold = new THREE.Color("#3b82f6");
  const neutral = new THREE.Color("#22c55e");
  const warm = new THREE.Color("#f59e0b");
  const hot = new THREE.Color("#ef4444");

  if (temperatureC <= 20) {
    return cold;
  }

  if (temperatureC <= 22) {
    return cold.clone().lerp(neutral, (temperatureC - 20) / 2);
  }

  if (temperatureC <= 24) {
    return neutral.clone().lerp(warm, (temperatureC - 22) / 2);
  }

  return warm.clone().lerp(hot, Math.min((temperatureC - 24) / 3, 1));
}

function ThermalOverlay({
  center,
  width,
  depth,
  zone,
}: {
  center: THREE.Vector3;
  width: number;
  depth: number;
  zone: ZoneTwinState | undefined;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const color = zone ? getTemperatureColor(zone.temperatureC) : new THREE.Color("#94a3b8");

  useFrame(({ clock }) => {
    if (meshRef.current) {
      const material = meshRef.current.material as THREE.MeshStandardMaterial;
      material.opacity = 0.28 + Math.sin(clock.getElapsedTime() * 1.2) * 0.06;
    }
  });

  return (
    <mesh ref={meshRef} rotation={[-Math.PI / 2, 0, 0]} position={[center.x, 0.1, center.z]}>
      <planeGeometry args={[width - 0.3, depth - 0.3]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.2}
        transparent
        opacity={0.3}
        depthWrite={false}
      />
    </mesh>
  );
}

function DeviceHealthIndicator({
  position,
  diagnosis,
  children,
}: {
  position: [number, number, number];
  diagnosis: DeviceDiagnosis | undefined;
  children: React.ReactNode;
}) {
  const glowRef = useRef<THREE.Mesh>(null);
  const showGlow = diagnosis && diagnosis.healthScore < 85;
  const isCritical = diagnosis && diagnosis.healthScore < 60;

  useFrame(({ clock }) => {
    if (glowRef.current && showGlow) {
      const speed = isCritical ? 3.5 : 1.8;
      const material = glowRef.current.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = 0.6 + Math.sin(clock.getElapsedTime() * speed) * 0.4;
      material.opacity = 0.12 + Math.sin(clock.getElapsedTime() * speed) * 0.06;
    }
  });

  return (
    <group>
      {children}
      {showGlow ? (
        <mesh ref={glowRef} position={position}>
          <sphereGeometry args={[0.45, 16, 16]} />
          <meshStandardMaterial
            color="#dc2626"
            emissive="#dc2626"
            emissiveIntensity={0.8}
            transparent
            opacity={0.15}
            depthWrite={false}
          />
        </mesh>
      ) : null}
      {isCritical ? (
        <Html position={[position[0], position[1] + 0.55, position[2]]} transform distanceFactor={10}>
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[11px] font-bold text-white shadow-lg">
            !
          </div>
        </Html>
      ) : null}
    </group>
  );
}

function ComfortGlow({
  center,
  zone,
  roomWidth,
}: {
  center: THREE.Vector3;
  zone: ZoneTwinState | undefined;
  roomWidth: number;
}) {
  if (!zone) {
    return null;
  }

  const color = zone.comfortScore >= 92 ? "#16a34a" : zone.comfortScore >= 78 ? "#f59e0b" : "#dc2626";
  const intensity = zone.comfortScore >= 92 ? 0.25 : zone.comfortScore >= 78 ? 0.45 : 0.7;

  return <pointLight position={[center.x, 0.6, center.z]} color={color} intensity={intensity} distance={roomWidth * 1.2} decay={2} />;
}

function RuntimeSceneContent({
  blueprint,
  products,
  twin,
  sandbox,
  selectedZoneId,
  worstZoneId,
  onSelectZone,
  autoRotateActive,
  controlsRef,
}: RuntimeSceneContentProps) {
  const twinZones = useMemo(() => new Map((twin?.zones ?? []).map((zone) => [zone.zoneId, zone])), [twin?.zones]);
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const telemetryByDeviceId = useMemo(
    () => new Map((sandbox?.deviceReadings ?? []).map((reading) => [reading.deviceId, reading])),
    [sandbox?.deviceReadings],
  );
  const diagnosisByDeviceId = useMemo(
    () => new Map((twin?.devices ?? []).map((d) => [d.deviceId, d])),
    [twin?.devices],
  );
  const sourceDevice = blueprint.devices.find((device) => device.kind === "source_equipment");
  const sourcePoint = sourceDevice ? getDeviceScenePosition(sourceDevice) : new THREE.Vector3(10, 4.8, 5);
  const mode = String(
    sandbox?.deviceReadings.find((reading) => reading.deviceId === "rtu-1")?.telemetry.operating_mode ?? "ventilation",
  );
  const flowColor = mode === "heating" ? "#ff7a45" : mode === "cooling" || mode === "economizer" ? "#42b8ff" : "#7dd3fc";
  const ductColor = mode === "heating" ? "#d9b7a6" : "#c7d5e3";
  const centers = blueprint.spaces.map((space) => getRoomCenter(space));
  const sceneCenter = useMemo(() => {
    if (blueprint.spaces.length === 0) {
      return new THREE.Vector3(0, 0, 0);
    }

    const minX = Math.min(...blueprint.spaces.map((space) => space.layout.origin_m.x));
    const maxX = Math.max(
      ...blueprint.spaces.map((space) => space.layout.origin_m.x + space.layout.size_m.width),
    );
    const minZ = Math.min(...blueprint.spaces.map((space) => space.layout.origin_m.y));
    const maxZ = Math.max(
      ...blueprint.spaces.map((space) => space.layout.origin_m.y + space.layout.size_m.depth),
    );

    return new THREE.Vector3((minX + maxX) / 2, 1.6, (minZ + maxZ) / 2);
  }, [blueprint.spaces]);
  const trunkX = sourcePoint.x;
  const trunkY = 3.25;
  const trunkMinZ = Math.min(...centers.map((center) => center.z)) - 0.8;
  const trunkMaxZ = Math.max(...centers.map((center) => center.z)) + 0.8;
  const trunkFeedStart = new THREE.Vector3(trunkX, Math.max(sourcePoint.y - 0.55, trunkY + 0.25), sourcePoint.z + 0.8);
  const trunkFeedEnd = new THREE.Vector3(trunkX, trunkY, sourcePoint.z + 0.8);

  const handleRoomClick = (event: ThreeEvent<MouseEvent>, zoneId: string) => {
    event.stopPropagation();
    onSelectZone(zoneId);
  };

  useEffect(() => {
    const controls = controlsRef.current;

    if (!controls) {
      return;
    }

    controls.target.set(0, sceneCenter.y, 0);
    controls.update();
  }, [controlsRef, sceneCenter]);

  return (
    <>
      <color attach="background" args={["#d9e4ee"]} />
      <fog attach="fog" args={["#d9e4ee", 18, 48]} />
      <ambientLight intensity={1.45} />
      <hemisphereLight intensity={1.25} color="#f8fafc" groundColor="#c8d4e0" />
      <directionalLight position={[8, 18, 10]} intensity={2.1} />
      <directionalLight position={[-6, 12, -8]} intensity={0.4} color="#fef3c7" />
      <OrbitControls
        ref={controlsRef}
        enablePan={false}
        enableRotate
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.72}
        minPolarAngle={LOCKED_POLAR_ANGLE}
        maxPolarAngle={LOCKED_POLAR_ANGLE}
        minZoom={28}
        maxZoom={48}
        autoRotate={autoRotateActive}
        autoRotateSpeed={AUTO_ROTATE_SPEED}
      />

      <group>
        <group position={[-sceneCenter.x, 0, -sceneCenter.z]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[11, -0.1, 5.6]}>
          <planeGeometry args={[36, 26]} />
          <meshStandardMaterial color="#d3dde8" />
        </mesh>

        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[11.4, -0.05, 5.6]}>
          <planeGeometry args={[28, 20]} />
          <meshStandardMaterial color="#eef3f7" transparent opacity={0.32} />
        </mesh>

        <DuctSegment from={trunkFeedStart} to={trunkFeedEnd} thickness={0.34} color={ductColor} />
        <DuctSegment
          from={new THREE.Vector3(trunkX, trunkY, trunkMinZ)}
          to={new THREE.Vector3(trunkX, trunkY, trunkMaxZ)}
          thickness={0.34}
          color={ductColor}
        />

        {blueprint.spaces.map((space) => {
          const center = getRoomCenter(space);
          const zone = twinZones.get(space.id);
          const isSelected = selectedZoneId === space.id;
          const branchDevice = blueprint.devices.find(
            (device) => device.kind === "actuator" && device.served_space_ids.includes(space.id),
          );
          const branchPoint = branchDevice
            ? getDeviceScenePosition(branchDevice)
            : new THREE.Vector3(center.x, 3.05, center.z);
          const trunkJunction = new THREE.Vector3(trunkX, trunkY, center.z);
          const branchHorizontal = new THREE.Vector3(branchPoint.x, trunkY, center.z);
          const intensity = zone ? Math.min(zone.supplyAirflowM3H / 1500, 1) : 0.2;
          const isWorstZone = worstZoneId === space.id;

          return (
            <group key={space.id}>
              {isSelected ? (
                <RoundedBox
                  args={[space.layout.size_m.width + 0.28, 0.04, space.layout.size_m.depth + 0.28]}
                  radius={0.08}
                  smoothness={4}
                  position={[center.x, 0.02, center.z]}
                >
                  <meshStandardMaterial
                    color="#d9691f"
                    emissive="#d9691f"
                    emissiveIntensity={0.4}
                    transparent
                    opacity={0.85}
                  />
                </RoundedBox>
              ) : null}

              <RoundedBox
                args={[space.layout.size_m.width, 0.16, space.layout.size_m.depth]}
                radius={0.08}
                smoothness={4}
                position={[center.x, 0, center.z]}
                onClick={(event) => handleRoomClick(event, space.id)}
              >
                <meshStandardMaterial color={getSpaceColor(zone)} metalness={0.06} roughness={0.88} />
              </RoundedBox>

              <ThermalOverlay center={center} width={space.layout.size_m.width} depth={space.layout.size_m.depth} zone={zone} />
              <ComfortGlow center={center} zone={zone} roomWidth={space.layout.size_m.width} />

              <RoundedBox
                args={[space.layout.size_m.width + 0.14, 0.12, 0.16]}
                radius={0.02}
                smoothness={2}
                position={[center.x, 1.18, space.layout.origin_m.y]}
              >
                <meshStandardMaterial color="#f7f5f0" />
              </RoundedBox>
              <RoundedBox
                args={[space.layout.size_m.width + 0.14, 0.12, 0.16]}
                radius={0.02}
                smoothness={2}
                position={[center.x, 1.18, space.layout.origin_m.y + space.layout.size_m.depth]}
              >
                <meshStandardMaterial color="#f7f5f0" />
              </RoundedBox>
              <RoundedBox
                args={[0.16, 1.26, space.layout.size_m.depth + 0.14]}
                radius={0.02}
                smoothness={2}
                position={[space.layout.origin_m.x, 0.58, center.z]}
              >
                <meshStandardMaterial color="#f7f5f0" />
              </RoundedBox>
              <RoundedBox
                args={[0.16, 1.26, space.layout.size_m.depth + 0.14]}
                radius={0.02}
                smoothness={2}
                position={[space.layout.origin_m.x + space.layout.size_m.width, 0.58, center.z]}
              >
                <meshStandardMaterial color="#f7f5f0" />
              </RoundedBox>

              {space.envelope.transparent_surfaces.map((surface) => {
                const width = Math.min(space.layout.size_m.width - 0.8, Math.max(1.2, surface.area_m2 / 1.4));
                const windowCenter =
                  surface.orientation_deg === 0
                    ? new THREE.Vector3(center.x, 0.72, space.layout.origin_m.y)
                    : surface.orientation_deg === 180
                      ? new THREE.Vector3(center.x, 0.72, space.layout.origin_m.y + space.layout.size_m.depth)
                      : surface.orientation_deg === 90
                        ? new THREE.Vector3(space.layout.origin_m.x + space.layout.size_m.width, 0.72, center.z)
                        : new THREE.Vector3(space.layout.origin_m.x, 0.72, center.z);

                return (
                  <WindowStrip
                    key={surface.surface_id}
                    center={windowCenter}
                    orientationDeg={surface.orientation_deg}
                    width={width}
                  />
                );
              })}

              <DuctSegment from={trunkJunction} to={branchHorizontal} color={ductColor} />
              <DuctSegment
                from={branchHorizontal}
                to={new THREE.Vector3(branchPoint.x, trunkY, branchPoint.z)}
                color={ductColor}
              />
              <DuctSegment
                from={new THREE.Vector3(branchPoint.x, trunkY, branchPoint.z)}
                to={branchPoint}
                thickness={0.18}
                color={ductColor}
              />
              <DuctSegment
                from={branchPoint}
                to={new THREE.Vector3(branchPoint.x, 1.55, branchPoint.z)}
                thickness={0.16}
                color="#d6dde6"
              />

              <FlowRoute
                points={[
                  trunkFeedEnd,
                  trunkJunction,
                  branchHorizontal,
                  new THREE.Vector3(branchPoint.x, trunkY, branchPoint.z),
                  branchPoint,
                ]}
                color={flowColor}
                intensity={intensity}
              />
              <FlowRoute
                points={[
                  branchPoint,
                  new THREE.Vector3(branchPoint.x, 2.1, branchPoint.z),
                  new THREE.Vector3(center.x, 1.42, center.z),
                ]}
                color={flowColor}
                intensity={Math.max(0.12, intensity * 0.85)}
              />

              <FloatingRoomBadge
                position={[center.x, 1.55, center.z]}
                zone={zone}
                label={space.name}
                isSelected={isSelected}
                isWorstZone={isWorstZone}
              />
            </group>
          );
        })}

        {blueprint.devices.map((device) => {
          const product = productById.get(device.product_id);

          if (!product) {
            throw new Error(`Missing product metadata for device ${device.id}`);
          }

          const point = getDeviceScenePosition(device);
          const transform = getDeviceModelTransform(device);
          const reading = telemetryByDeviceId.get(device.id) ?? null;
          const diagnosis = diagnosisByDeviceId.get(device.id);

          return (
            <DeviceHealthIndicator
              key={device.id}
              position={[
                point.x + transform.positionOffset[0],
                point.y + transform.positionOffset[1],
                point.z + transform.positionOffset[2],
              ]}
              diagnosis={diagnosis}
            >
              <group
                position={[
                  point.x + transform.positionOffset[0],
                  point.y + transform.positionOffset[1],
                  point.z + transform.positionOffset[2],
                ]}
                rotation={transform.rotation}
                scale={transform.sceneScale}
              >
                <RuntimeDeviceModel productId={product.id} device={device} telemetry={reading?.telemetry ?? null} />
              </group>
            </DeviceHealthIndicator>
          );
        })}

        <Html position={[sourcePoint.x, sourcePoint.y + 0.95, sourcePoint.z]} transform distanceFactor={12}>
          <div className="rounded-full border border-white/70 bg-white/92 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-800 shadow-[0_10px_24px_rgba(15,23,42,0.12)]">
            RTU-1
          </div>
        </Html>
        <Html position={[sourcePoint.x, sourcePoint.y + 0.6, sourcePoint.z + 1.1]} transform distanceFactor={12}>
          <div className="rounded-full border border-white/60 bg-white/88 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500 shadow-[0_8px_18px_rgba(15,23,42,0.08)]">
            {formatZoneToneLabel(mode)}
          </div>
        </Html>
        </group>
      </group>
    </>
  );
}

function formatZoneToneLabel(mode: string) {
  return mode.replace(/\b\w/g, (character) => character.toUpperCase());
}

function AirflowIcon() {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true" className="h-6 w-6 text-slate-700">
      <path
        d="M5 11.5c2.1-3 5-4.5 8.8-4.5 2.2 0 4.1.5 5.9 1.4M6.5 16.5c1.8 2.7 4.5 4 8 4 3.2 0 5.9-1.1 8-3.4M18.8 8.6c1.9.9 3.3 2.4 4.2 4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20.5 5.8l4.2 2.6-3 3.4M18.8 18.2l4.7-.3-.9 4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true" className="h-6 w-6 text-slate-700">
      <path
        d="M14 3.5v8.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M9.2 6.8a9 9 0 1 0 9.6 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function RuntimeScene(props: RuntimeSceneProps) {
  const controlsRef = useRef<import("three-stdlib").OrbitControls | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const [isAutoRotateEnabled, setIsAutoRotateEnabled] = useState(true);
  const [autoRotateActive, setAutoRotateActive] = useState(false);

  const scheduleIdleRotation = () => {
    if (idleTimerRef.current) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    if (!isAutoRotateEnabled) {
      setAutoRotateActive(false);
      return;
    }

    idleTimerRef.current = window.setTimeout(() => {
      setAutoRotateActive(true);
    }, AUTO_ROTATE_IDLE_DELAY_MS);
  };

  const registerInteraction = () => {
    setAutoRotateActive(false);
    scheduleIdleRotation();
  };

  useEffect(() => {
    scheduleIdleRotation();

    return () => {
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [isAutoRotateEnabled]);

  useEffect(() => {
    const handleInteraction = () => {
      setAutoRotateActive(false);

      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }

      if (isAutoRotateEnabled) {
        idleTimerRef.current = window.setTimeout(() => {
          setAutoRotateActive(true);
        }, AUTO_ROTATE_IDLE_DELAY_MS);
      }
    };

    window.addEventListener("pointerdown", handleInteraction);
    window.addEventListener("wheel", handleInteraction, { passive: true });
    window.addEventListener("touchstart", handleInteraction, { passive: true });
    window.addEventListener("keydown", handleInteraction);

    return () => {
      window.removeEventListener("pointerdown", handleInteraction);
      window.removeEventListener("wheel", handleInteraction);
      window.removeEventListener("touchstart", handleInteraction);
      window.removeEventListener("keydown", handleInteraction);
    };
  }, [isAutoRotateEnabled]);

  return (
    <div
      className="relative h-[100svh] min-h-[720px] w-full overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.92),rgba(224,232,240,0.75)_42%,rgba(199,211,224,0.96)_100%)]"
      onPointerDown={registerInteraction}
      onWheel={registerInteraction}
      onTouchStart={registerInteraction}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-32 bg-gradient-to-b from-white/55 to-transparent" />
      <div className="pointer-events-none absolute inset-x-4 top-4 z-10 sm:inset-x-6 sm:top-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-full border border-white/55 bg-white/62 px-4 py-3 text-slate-600 backdrop-blur">
          <div className="flex items-center">
            <Image src="/belimo-wordmark.svg" alt="Belimo Pulse" width={420} height={72} className="h-7 w-auto sm:h-8" />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3 text-slate-950">
            <div
              className="flex items-center gap-2"
              aria-label={`Total air flow ${props.totalAirflowM3H.toFixed(0)} cubic meters per hour`}
            >
              <AirflowIcon />
              <span className="text-base font-semibold tracking-[-0.03em]">
                {props.totalAirflowM3H.toFixed(0)} <span className="text-sm font-medium text-slate-500">m3/h</span>
              </span>
            </div>
            <span className="h-7 w-px bg-slate-300/80" aria-hidden="true" />
            <div
              className="flex items-center gap-2"
              aria-label={`Energy draw ${props.sourcePowerKw.toFixed(1)} kilowatts`}
            >
              <PowerIcon />
              <span className="text-base font-semibold tracking-[-0.03em]">
                {props.sourcePowerKw.toFixed(1)} <span className="text-sm font-medium text-slate-500">kW</span>
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute bottom-4 right-4 z-10">
        <button
          type="button"
          onClick={() => {
            const nextValue = !isAutoRotateEnabled;
            setIsAutoRotateEnabled(nextValue);
            setAutoRotateActive(false);

            if (idleTimerRef.current) {
              window.clearTimeout(idleTimerRef.current);
              idleTimerRef.current = null;
            }

            if (nextValue) {
              idleTimerRef.current = window.setTimeout(() => {
                setAutoRotateActive(true);
              }, AUTO_ROTATE_IDLE_DELAY_MS);
            }
          }}
          aria-pressed={isAutoRotateEnabled}
          aria-label={isAutoRotateEnabled ? "Disable auto rotate" : "Enable auto rotate"}
          className={`flex h-8 w-[58px] items-center rounded-full border px-1 transition ${
            isAutoRotateEnabled
              ? "border-emerald-400/55 bg-emerald-500/92 shadow-[0_10px_24px_rgba(16,185,129,0.24)]"
              : "border-slate-200/90 bg-white/86 shadow-[0_10px_22px_rgba(15,23,42,0.08)]"
          }`}
        >
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] transition-transform ${
              isAutoRotateEnabled
                ? "translate-x-[26px] bg-white text-emerald-600"
                : "translate-x-0 bg-slate-900 text-white"
            }`}
          >
            ↻
          </span>
        </button>
      </div>
      <Canvas
        orthographic
        camera={{ position: [18, 18, 18], zoom: 34, near: 0.1, far: 200 }}
        dpr={1}
        gl={{ antialias: false, powerPreference: "high-performance" }}
      >
        <RuntimeSceneContent {...props} autoRotateActive={autoRotateActive} controlsRef={controlsRef} />
      </Canvas>
    </div>
  );
}
