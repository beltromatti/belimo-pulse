"use client";

import {
  OrbitControls,
} from "@react-three/drei/core/OrbitControls";
import {
  RoundedBox,
} from "@react-three/drei/core/RoundedBox";
import { Canvas, ThreeEvent, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Html } from "@react-three/drei/web/Html";

import {
  BuildingBlueprint,
  DeviceDefinition,
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
          {isWorstZone ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700">focus</span> : null}
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: getZoneTone(zone) }} />
        </span>
      </div>
      <div className="mt-2 flex items-end justify-between gap-4">
        <div>
          <p className="text-xl font-semibold leading-none text-slate-950">{zone ? `${zone.temperatureC.toFixed(1)}°` : "--"}</p>
          {isSelected ? (
            <p className="mt-1 text-xs text-slate-600">{zone ? `${zone.co2Ppm.toFixed(0)} ppm · ${zone.supplyAirflowM3H.toFixed(0)} m³/h` : "No data"}</p>
          ) : (
            <p className="mt-1 text-xs text-slate-600">{zone ? `${zone.comfortScore.toFixed(0)}% comfort` : "No data"}</p>
          )}
        </div>
      </div>
    </div>
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
        <meshStandardMaterial color={color} metalness={0.18} roughness={0.5} />
      </RoundedBox>
    );
  }

  if (dz >= dx && dz >= dy) {
    return (
      <RoundedBox args={[thickness, thickness, Math.max(dz, 0.2)]} radius={0.04} smoothness={3} position={center}>
        <meshStandardMaterial color={color} metalness={0.18} roughness={0.5} />
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

function RuntimeSceneContent({
  blueprint,
  products,
  twin,
  sandbox,
  selectedZoneId,
  worstZoneId,
  onSelectZone,
}: RuntimeSceneProps) {
  const twinZones = useMemo(() => new Map((twin?.zones ?? []).map((zone) => [zone.zoneId, zone])), [twin?.zones]);
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const telemetryByDeviceId = useMemo(
    () => new Map((sandbox?.deviceReadings ?? []).map((reading) => [reading.deviceId, reading])),
    [sandbox?.deviceReadings],
  );
  const sourceDevice = blueprint.devices.find((device) => device.kind === "source_equipment");
  const sourcePoint = sourceDevice ? getDeviceScenePosition(sourceDevice) : new THREE.Vector3(10, 4.8, 5);
  const mode = String(
    sandbox?.deviceReadings.find((reading) => reading.deviceId === "rtu-1")?.telemetry.operating_mode ?? "ventilation",
  );
  const flowColor = mode === "heating" ? "#ff7a45" : mode === "cooling" || mode === "economizer" ? "#42b8ff" : "#7dd3fc";
  const ductColor = mode === "heating" ? "#d9b7a6" : "#c7d5e3";
  const centers = blueprint.spaces.map((space) => getRoomCenter(space));
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

  return (
    <>
      <color attach="background" args={["#d9e4ee"]} />
      <fog attach="fog" args={["#d9e4ee", 18, 48]} />
      <ambientLight intensity={1.45} />
      <hemisphereLight intensity={1.25} color="#f8fafc" groundColor="#c8d4e0" />
      <directionalLight position={[8, 18, 10]} intensity={2.1} />
      <OrbitControls enablePan={false} minPolarAngle={0.8} maxPolarAngle={1.08} minAzimuthAngle={-0.92} maxAzimuthAngle={-0.42} minZoom={28} maxZoom={48} />

      <group rotation={[-0.34, -0.72, -0.04]} position={[-11.5, 0, -6.2]}>
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
                  <meshStandardMaterial color="#d9691f" emissive="#d9691f" emissiveIntensity={0.4} transparent opacity={0.85} />
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
              <DuctSegment from={branchHorizontal} to={new THREE.Vector3(branchPoint.x, trunkY, branchPoint.z)} color={ductColor} />
              <DuctSegment from={new THREE.Vector3(branchPoint.x, trunkY, branchPoint.z)} to={branchPoint} thickness={0.18} color={ductColor} />
              <DuctSegment from={branchPoint} to={new THREE.Vector3(branchPoint.x, 1.55, branchPoint.z)} thickness={0.16} color="#d6dde6" />

              <FlowRoute
                points={[trunkFeedEnd, trunkJunction, branchHorizontal, new THREE.Vector3(branchPoint.x, trunkY, branchPoint.z), branchPoint]}
                color={flowColor}
                intensity={intensity}
              />
              <FlowRoute
                points={[branchPoint, new THREE.Vector3(branchPoint.x, 2.1, branchPoint.z), new THREE.Vector3(center.x, 1.42, center.z)]}
                color={flowColor}
                intensity={Math.max(0.12, intensity * 0.85)}
              />

              <Html position={[center.x, 1.55, center.z]} transform distanceFactor={11}>
                <RoomBadge zone={zone} label={space.name} isSelected={isSelected} isWorstZone={isWorstZone} />
              </Html>
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

          return (
            <group
              key={device.id}
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
    </>
  );
}

function formatZoneToneLabel(mode: string) {
  return mode.replace(/\b\w/g, (character) => character.toUpperCase());
}

export function RuntimeScene(props: RuntimeSceneProps) {
  return (
    <div className="relative h-[720px] w-full overflow-hidden rounded-[2rem] border border-white/40 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.92),rgba(224,232,240,0.75)_42%,rgba(199,211,224,0.96)_100%)] shadow-[0_28px_90px_rgba(15,23,42,0.18)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-32 bg-gradient-to-b from-white/55 to-transparent" />
      <div className="pointer-events-none absolute inset-x-6 top-5 z-10 flex items-center justify-between rounded-full border border-white/55 bg-white/62 px-4 py-2 text-xs font-medium uppercase tracking-[0.24em] text-slate-600 backdrop-blur">
        <span>Dollhouse HVAC Twin</span>
        <span>Ceiling supply ducts · live airflow</span>
      </div>
      <Canvas
        orthographic
        camera={{ position: [18, 18, 18], zoom: 34, near: 0.1, far: 200 }}
        dpr={1}
        gl={{ antialias: false, powerPreference: "high-performance" }}
      >
        <RuntimeSceneContent {...props} />
      </Canvas>
    </div>
  );
}
