"use client";

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
  DeviceTelemetryRecord,
  ProductDefinition,
  SandboxTickResult,
  TwinSnapshot,
  ZoneTwinState,
} from "@/lib/runtime-types";
import { BrandLockup } from "@/components/brand-lockup";
import { getDeviceModelTransform, RuntimeDeviceModel } from "@/components/runtime-device-models";

type RuntimeSceneProps = {
  blueprint: BuildingBlueprint;
  products: ProductDefinition[];
  twin: TwinSnapshot | null;
  sandbox: SandboxTickResult | null;
  leftDrawerOpen: boolean;
  rightDrawerOpen: boolean;
  selectedZoneId: string | null;
  worstZoneId: string | null;
  onSelectZone: (zoneId: string) => void;
  onSelectDevice: (deviceId: string) => void;
  totalAirflowM3H: number;
  sourcePowerKw: number;
  onReturnToPortfolio?: () => void;
};

type RuntimeSceneContentProps = RuntimeSceneProps & {
  autoRotateActive: boolean;
  controlsRef: { current: import("three-stdlib").OrbitControls | null };
  onHoverStateChange: (hovered: boolean) => void;
};

type RoomBadgeProps = {
  zone: ZoneTwinState | undefined;
  label: string;
  isSelected: boolean;
  isWorstZone: boolean;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
};

type DeviceHoverCardProps = {
  device: DeviceDefinition;
  product: ProductDefinition;
  diagnosis: DeviceDiagnosis | undefined;
  telemetry: DeviceTelemetryRecord["telemetry"] | null;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
};

type FlowRouteProps = {
  points: THREE.Vector3[];
  color: string;
  intensity: number;
};

const LOCKED_POLAR_ANGLE = 0.96;
const AUTO_ROTATE_SPEED = 0.45;
const WALL_HEIGHT = 1.28;
const WALL_BASE_Y = 0.08;
const WALL_THICKNESS = 0.16;
const WINDOW_SURFACE_OFFSET = WALL_THICKNESS / 2 + 0.012;
const HORIZONTAL_WALL_COLOR = "#d8e0ea";
const VERTICAL_WALL_COLOR = "#c6d0dc";
const WINDOW_TINT_COLOR = "#d4ebff";

type WallSegmentDefinition = {
  key: string;
  axis: "x" | "z";
  position: [number, number, number];
  size: [number, number, number];
  exterior: boolean;
};

function roundGeometryValue(value: number) {
  return Number(value.toFixed(3));
}

function collectSpaceBreakpoints(spaces: BuildingBlueprint["spaces"]) {
  const xValues = new Set<number>();
  const zValues = new Set<number>();

  for (const space of spaces) {
    xValues.add(roundGeometryValue(space.layout.origin_m.x));
    xValues.add(roundGeometryValue(space.layout.origin_m.x + space.layout.size_m.width));
    zValues.add(roundGeometryValue(space.layout.origin_m.y));
    zValues.add(roundGeometryValue(space.layout.origin_m.y + space.layout.size_m.depth));
  }

  return {
    x: Array.from(xValues).sort((left, right) => left - right),
    z: Array.from(zValues).sort((left, right) => left - right),
  };
}

function hasOutdoorFace(space: BuildingBlueprint["spaces"][number], orientationDeg: number) {
  return [...space.envelope.opaque_surfaces, ...space.envelope.transparent_surfaces].some(
    (surface) => surface.boundary === "outdoor" && surface.orientation_deg === orientationDeg,
  );
}

function buildWallSegments(spaces: BuildingBlueprint["spaces"]): WallSegmentDefinition[] {
  const breakpoints = collectSpaceBreakpoints(spaces);
  const segments = new Map<
    string,
    {
      axis: "x" | "z";
      fixed: number;
      start: number;
      end: number;
      exterior: boolean;
    }
  >();

  const addSegment = (
    axis: "x" | "z",
    fixed: number,
    start: number,
    end: number,
    exterior: boolean,
  ) => {
    const normalizedFixed = roundGeometryValue(fixed);
    const normalizedStart = roundGeometryValue(Math.min(start, end));
    const normalizedEnd = roundGeometryValue(Math.max(start, end));

    if (normalizedEnd - normalizedStart <= 0.001) {
      return;
    }

    const axisBreakpoints = axis === "x" ? breakpoints.z : breakpoints.x;
    const localBreakpoints = [normalizedStart];

    for (const value of axisBreakpoints) {
      if (value > normalizedStart && value < normalizedEnd) {
        localBreakpoints.push(value);
      }
    }

    localBreakpoints.push(normalizedEnd);

    for (let index = 0; index < localBreakpoints.length - 1; index += 1) {
      const segmentStart = localBreakpoints[index];
      const segmentEnd = localBreakpoints[index + 1];

      if (segmentEnd - segmentStart <= 0.001) {
        continue;
      }

      const key = `${axis}:${normalizedFixed}:${segmentStart}:${segmentEnd}`;
      const existing = segments.get(key);

      if (existing) {
        existing.exterior = existing.exterior || exterior;
        continue;
      }

      segments.set(key, {
        axis,
        fixed: normalizedFixed,
        start: segmentStart,
        end: segmentEnd,
        exterior,
      });
    }
  };

  for (const space of spaces) {
    const xStart = space.layout.origin_m.x;
    const xEnd = xStart + space.layout.size_m.width;
    const zStart = space.layout.origin_m.y;
    const zEnd = zStart + space.layout.size_m.depth;

    addSegment("z", zStart, xStart, xEnd, hasOutdoorFace(space, 0));
    addSegment("z", zEnd, xStart, xEnd, hasOutdoorFace(space, 180));
    addSegment("x", xStart, zStart, zEnd, hasOutdoorFace(space, 270));
    addSegment("x", xEnd, zStart, zEnd, hasOutdoorFace(space, 90));
  }

  return Array.from(segments.entries())
    .map(([key, segment]) => {
      const length = roundGeometryValue(segment.end - segment.start);
      const centerAlongAxis = roundGeometryValue((segment.start + segment.end) / 2);
      const centerY = WALL_BASE_Y + WALL_HEIGHT / 2;

      if (segment.axis === "x") {
        return {
          key,
          axis: segment.axis,
          position: [segment.fixed, centerY, centerAlongAxis] as [number, number, number],
          size: [WALL_THICKNESS, WALL_HEIGHT, length] as [number, number, number],
          exterior: segment.exterior,
        };
      }

      return {
        key,
        axis: segment.axis,
        position: [centerAlongAxis, centerY, segment.fixed] as [number, number, number],
        size: [length, WALL_HEIGHT, WALL_THICKNESS] as [number, number, number],
        exterior: segment.exterior,
      };
    })
    .sort((left, right) => Number(right.exterior) - Number(left.exterior));
}

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

function RoomBadge({ zone, label, isSelected, isWorstZone, onPointerEnter, onPointerLeave }: RoomBadgeProps) {
  return (
    <div
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={`rounded-[1.15rem] border px-2.5 py-2 shadow-[0_14px_30px_rgba(15,23,42,0.14)] backdrop-blur ${
        isSelected ? "min-w-[140px] border-white/75 bg-white/92" : "min-w-[108px] border-white/48 bg-white/82"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">{label}</p>
        <span className="flex items-center gap-2">
          {isWorstZone ? (
            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-700">
              focus
            </span>
          ) : null}
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: getZoneTone(zone) }} />
        </span>
      </div>
      <div className="mt-2 flex items-end justify-between gap-4">
        <div>
          <p className="text-lg font-semibold leading-none text-slate-950">
            {zone ? `${zone.temperatureC.toFixed(1)} deg` : "--"}
          </p>
          {isSelected ? (
            <p className="mt-1 text-[11px] text-slate-600">
              {zone ? `${zone.co2Ppm.toFixed(0)} ppm | ${zone.supplyAirflowM3H.toFixed(0)} m3/h` : "No data"}
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-slate-600">
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
  onPointerEnter,
  onPointerLeave,
}: {
  position: [number, number, number];
  zone: ZoneTwinState | undefined;
  label: string;
  isSelected: boolean;
  isWorstZone: boolean;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
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
        <RoomBadge
          zone={zone}
          label={label}
          isSelected={isSelected}
          isWorstZone={isWorstZone}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
        />
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
      ? [center.x, 0.72, center.z - WINDOW_SURFACE_OFFSET]
      : orientationDeg === 180
        ? [center.x, 0.72, center.z + WINDOW_SURFACE_OFFSET]
        : orientationDeg === 90
          ? [center.x + WINDOW_SURFACE_OFFSET, 0.72, center.z]
          : [center.x - WINDOW_SURFACE_OFFSET, 0.72, center.z];
  const rotation: [number, number, number] = isVerticalWall ? [0, Math.PI / 2, 0] : [0, 0, 0];

  return (
    <mesh position={position} rotation={rotation} renderOrder={3}>
      <planeGeometry args={[width, 1.02]} />
      <meshStandardMaterial
        color={WINDOW_TINT_COLOR}
        transparent
        opacity={0.68}
        emissive="#8ec5f8"
        emissiveIntensity={0.18}
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-1}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function formatTelemetryValue(key: string, value: number | string | boolean | null) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "boolean") {
    return value ? "On" : "Off";
  }

  if (typeof value === "string") {
    return value.replaceAll("_", " ");
  }

  const normalizedKey = key.toLowerCase();

  if (normalizedKey.includes("temperature")) {
    return `${value.toFixed(1)} deg`;
  }

  if (normalizedKey.includes("humidity")) {
    return `${value.toFixed(0)}% RH`;
  }

  if (normalizedKey.includes("co2")) {
    return `${value.toFixed(0)} ppm`;
  }

  if (normalizedKey.includes("power")) {
    return `${value.toFixed(1)} kW`;
  }

  if (normalizedKey.includes("airflow") || normalizedKey.includes("air_flow")) {
    return `${value.toFixed(0)} m3/h`;
  }

  if (normalizedKey.includes("pressure")) {
    return `${value.toFixed(0)} Pa`;
  }

  if (normalizedKey.includes("position") || normalizedKey.includes("opening") || normalizedKey.includes("fraction")) {
    return `${value.toFixed(0)}%`;
  }

  return `${value.toFixed(1)}`;
}

function getProductDisplayName(product: ProductDefinition) {
  return product.official_reference_models[0] ?? `${product.brand} ${product.subtype.replaceAll("_", " ")}`;
}

function getDeviceHoverSummary(
  device: DeviceDefinition,
  product: ProductDefinition,
  telemetry: DeviceTelemetryRecord["telemetry"] | null,
) {
  if (device.kind === "actuator") {
    const percentageKeys = ["damper_position_pct", "actuator_position_pct", "position_pct", "opening_pct"];

    for (const key of percentageKeys) {
      const value = telemetry?.[key];

      if (typeof value === "number") {
        return {
          title: "Actuator",
          subtitle: `${product.brand} actuator air damper`,
          detail: `Damper opening ${value.toFixed(0)}%`,
        };
      }
    }

    return {
      title: "Actuator",
      subtitle: `${product.brand} actuator air damper`,
      detail: "Damper opening unavailable",
    };
  }

  if (device.kind === "sensor") {
    const sensorReading =
      Object.entries(telemetry ?? {}).find((entry) => entry[0].includes("temperature")) ??
      Object.entries(telemetry ?? {}).find((entry) => entry[0].includes("pressure")) ??
      Object.entries(telemetry ?? {}).find((entry) => entry[0].includes("humidity")) ??
      Object.entries(telemetry ?? {}).find((entry) => entry[0].includes("co2")) ??
      null;

    return {
      title: "Sensor",
      subtitle: `${product.brand} field sensor`,
      detail: sensorReading ? `${sensorReading[0].replaceAll("_", " ")} ${formatTelemetryValue(sensorReading[0], sensorReading[1])}` : "Live reading unavailable",
    };
  }

  if (device.kind === "gateway" || product.category === "gateway") {
    const power = telemetry?.electrical_power_kw;

    return {
      title: "Gateway",
      subtitle: getProductDisplayName(product),
      detail: typeof power === "number" ? `Power draw ${power.toFixed(1)} kW` : "Gateway telemetry linked",
    };
  }

  const power = telemetry?.electrical_power_kw;

  return {
    title: "Unit",
    subtitle: getProductDisplayName(product),
    detail: typeof power === "number" ? `Power draw ${power.toFixed(1)} kW` : "Runtime telemetry linked",
  };
}

function DeviceHoverCard({
  device,
  product,
  diagnosis,
  telemetry,
  onPointerEnter,
  onPointerLeave,
}: DeviceHoverCardProps) {
  const summary = getDeviceHoverSummary(device, product, telemetry);
  const statusTone = diagnosis
    ? diagnosis.healthScore >= 95
      ? "#16a34a"
      : diagnosis.healthScore >= 85
        ? "#f59e0b"
        : "#dc2626"
    : "#94a3b8";

  return (
    <div
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="relative min-w-[156px] rounded-[1.15rem] border border-white/80 bg-white/95 px-2.5 py-2 shadow-[0_14px_28px_rgba(15,23,42,0.16)] backdrop-blur"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500">{summary.title}</p>
          <p className="mt-1 text-[13px] font-semibold text-slate-950">{summary.subtitle}</p>
        </div>
        <span className="mt-0.5 h-2 w-2 rounded-full" style={{ backgroundColor: statusTone }} />
      </div>
      <p className="mt-2 text-[12px] text-slate-700">{summary.detail}</p>
      <div className="pointer-events-none absolute left-1/2 top-full h-3 w-3 -translate-x-1/2 -translate-y-[1px] rotate-45 border-b border-r border-white/75 bg-white/95" />
    </div>
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
        <Html position={[position[0], position[1] + 0.55, position[2]]} transform occlude distanceFactor={10}>
          <div className="pointer-events-none flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[11px] font-bold text-white shadow-lg">
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
  onSelectDevice,
  autoRotateActive,
  controlsRef,
  onHoverStateChange,
}: RuntimeSceneContentProps) {
  const [hoveredZoneId, setHoveredZoneId] = useState<string | null>(null);
  const [hoveredDeviceId, setHoveredDeviceId] = useState<string | null>(null);
  const roomHoverCloseRef = useRef<number | null>(null);
  const deviceHoverCloseRef = useRef<number | null>(null);
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
  const wallSegments = useMemo(() => buildWallSegments(blueprint.spaces), [blueprint.spaces]);
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

  const handleDeviceClick = (event: ThreeEvent<MouseEvent>, deviceId: string) => {
    event.stopPropagation();
    onSelectDevice(deviceId);
  };

  const cancelRoomHoverClose = () => {
    if (roomHoverCloseRef.current) {
      window.clearTimeout(roomHoverCloseRef.current);
      roomHoverCloseRef.current = null;
    }
  };

  const scheduleRoomHoverClose = (zoneId: string) => {
    cancelRoomHoverClose();
    roomHoverCloseRef.current = window.setTimeout(() => {
      setHoveredZoneId((current) => (current === zoneId ? null : current));
      roomHoverCloseRef.current = null;
    }, 140);
  };

  const cancelDeviceHoverClose = () => {
    if (deviceHoverCloseRef.current) {
      window.clearTimeout(deviceHoverCloseRef.current);
      deviceHoverCloseRef.current = null;
    }
  };

  const scheduleDeviceHoverClose = (deviceId: string) => {
    cancelDeviceHoverClose();
    deviceHoverCloseRef.current = window.setTimeout(() => {
      setHoveredDeviceId((current) => (current === deviceId ? null : current));
      deviceHoverCloseRef.current = null;
    }, 140);
  };

  useEffect(() => {
    const controls = controlsRef.current;

    if (!controls) {
      return;
    }

    controls.target.set(0, sceneCenter.y, 0);
    controls.update();
  }, [controlsRef, sceneCenter]);

  useEffect(() => {
    return () => {
      cancelRoomHoverClose();
      cancelDeviceHoverClose();
    };
  }, []);

  useEffect(() => {
    onHoverStateChange(hoveredZoneId !== null || hoveredDeviceId !== null);
  }, [hoveredDeviceId, hoveredZoneId, onHoverStateChange]);

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

        {wallSegments.map((segment) => (
          <RoundedBox
            key={segment.key}
            args={segment.size}
            radius={0.02}
            smoothness={2}
            position={segment.position}
          >
            <meshStandardMaterial
              color={segment.axis === "x" ? VERTICAL_WALL_COLOR : HORIZONTAL_WALL_COLOR}
              emissive={segment.axis === "x" ? VERTICAL_WALL_COLOR : HORIZONTAL_WALL_COLOR}
              emissiveIntensity={segment.exterior ? 0.05 : 0.025}
              metalness={segment.exterior ? 0.05 : 0.03}
              roughness={segment.exterior ? 0.5 : 0.6}
            />
          </RoundedBox>
        ))}

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
                onPointerOver={(event) => {
                  event.stopPropagation();
                  cancelRoomHoverClose();
                  setHoveredZoneId(space.id);
                }}
                onPointerOut={(event) => {
                  event.stopPropagation();
                  scheduleRoomHoverClose(space.id);
                }}
              >
                <meshStandardMaterial color={getSpaceColor(zone)} metalness={0.06} roughness={0.88} />
              </RoundedBox>

              <ThermalOverlay center={center} width={space.layout.size_m.width} depth={space.layout.size_m.depth} zone={zone} />
              <ComfortGlow center={center} zone={zone} roomWidth={space.layout.size_m.width} />

              {space.envelope.transparent_surfaces.map((surface) => {
                const wallSpan =
                  surface.orientation_deg === 90 || surface.orientation_deg === 270
                    ? space.layout.size_m.depth
                    : space.layout.size_m.width;
                const width = Math.min(wallSpan - 0.8, Math.max(1.2, surface.area_m2 / 1.4));
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

              {hoveredZoneId === space.id ? (
                <FloatingRoomBadge
                  position={[center.x, 1.55, center.z]}
                  zone={zone}
                  label={space.name}
                  isSelected={isSelected}
                  isWorstZone={isWorstZone}
                  onPointerEnter={cancelRoomHoverClose}
                  onPointerLeave={() => scheduleRoomHoverClose(space.id)}
                />
              ) : null}
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
                onClick={(event) => handleDeviceClick(event, device.id)}
                onPointerOver={(event) => {
                  event.stopPropagation();
                  cancelDeviceHoverClose();
                  setHoveredDeviceId(device.id);
                }}
                onPointerOut={(event) => {
                  event.stopPropagation();
                  scheduleDeviceHoverClose(device.id);
                }}
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
              {hoveredDeviceId === device.id ? (
                <Html
                  position={[
                    point.x + transform.positionOffset[0],
                    point.y + transform.positionOffset[1] + 1.08,
                    point.z + transform.positionOffset[2],
                  ]}
                  transform
                  sprite
                  distanceFactor={11}
                >
                  <DeviceHoverCard
                    device={device}
                    product={product}
                    diagnosis={diagnosis}
                    telemetry={reading?.telemetry ?? null}
                    onPointerEnter={cancelDeviceHoverClose}
                    onPointerLeave={() => scheduleDeviceHoverClose(device.id)}
                  />
                </Html>
              ) : null}
            </DeviceHealthIndicator>
          );
        })}

        </group>
      </group>
    </>
  );
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
  const [isSceneHovered, setIsSceneHovered] = useState(false);
  const [hasActiveHoverCard, setHasActiveHoverCard] = useState(false);
  const shouldPauseRotation = isSceneHovered || hasActiveHoverCard;

  return (
    <div
      className="relative h-[100svh] min-h-[720px] w-full overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.92),rgba(224,232,240,0.75)_42%,rgba(199,211,224,0.96)_100%)]"
      onPointerEnter={() => setIsSceneHovered(true)}
      onPointerLeave={() => setIsSceneHovered(false)}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-32 bg-gradient-to-b from-white/55 to-transparent" />
      <div className="pointer-events-none absolute inset-x-4 top-4 z-10 sm:inset-x-6 sm:top-5">
        <div className="relative flex flex-wrap items-center justify-between gap-3 rounded-full border border-white/55 bg-white/62 px-4 py-3 text-slate-600 backdrop-blur">
          <div className="pointer-events-auto flex items-center gap-3">
            <BrandLockup />
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-1/2 hidden -translate-y-1/2 justify-center lg:flex">
            <div className="pointer-events-auto inline-flex items-center gap-3 px-3 py-2">
              <span className="text-sm font-medium tracking-[-0.02em] text-slate-800">
                {props.blueprint.building.name}
              </span>
              {props.onReturnToPortfolio ? (
                <button
                  type="button"
                  onClick={props.onReturnToPortfolio}
                  className="rounded-full border border-slate-200/80 bg-white px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
                >
                  Change
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3 text-slate-950">
            <div
              className="flex items-center gap-2"
              aria-label={`Total air flow ${props.totalAirflowM3H.toFixed(0)} cubic meters per hour`}
            >
              <AirflowIcon />
              <span className="text-base font-semibold tracking-[-0.03em]">
                {props.totalAirflowM3H.toFixed(0)}{" "}
                <span className="text-sm font-medium text-slate-500">m3/h</span>
              </span>
            </div>
            <span className="h-7 w-px bg-slate-300/80" aria-hidden="true" />
            <div
              className="flex items-center gap-2"
              aria-label={`Energy draw ${props.sourcePowerKw.toFixed(1)} kilowatts`}
            >
              <PowerIcon />
              <span className="text-base font-semibold tracking-[-0.03em]">
                {props.sourcePowerKw.toFixed(1)}{" "}
                <span className="text-sm font-medium text-slate-500">kW</span>
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
        <p className="text-[11px] font-medium tracking-[0.16em] text-slate-400/90">
          press on a component to inspect
        </p>
      </div>
      <Canvas
        orthographic
        camera={{ position: [18, 18, 18], zoom: 34, near: 0.1, far: 200 }}
        dpr={1}
        gl={{ antialias: false, powerPreference: "high-performance" }}
      >
        <RuntimeSceneContent
          {...props}
          autoRotateActive={!shouldPauseRotation}
          controlsRef={controlsRef}
          onHoverStateChange={setHasActiveHoverCard}
        />
      </Canvas>
    </div>
  );
}
