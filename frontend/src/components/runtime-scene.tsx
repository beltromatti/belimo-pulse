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
  SandboxTimeMode,
  RuntimeSimulationPreview,
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
  showSelectedZoneBadge: boolean;
  worstZoneId: string | null;
  onSelectZone: (zoneId: string) => void;
  onSelectDevice: (deviceId: string) => void;
  totalAirflowM3H: number;
  sourcePowerKw: number;
  simulationPreview: RuntimeSimulationPreview | null;
  simulationActive: boolean;
  simulationMinute: number | null;
  timeMode: SandboxTimeMode;
  timeSpeedMultiplier: 1 | 2 | 5 | 10;
  onReturnToPortfolio?: () => void;
};

type RuntimeSceneContentProps = RuntimeSceneProps & {
  autoRotateActive: boolean;
  controlsRef: { current: import("three-stdlib").OrbitControls | null };
  hoverResetToken: number;
  onHoverStateChange: (hovered: boolean) => void;
};

type RoomBadgeProps = {
  zone: ZoneTwinState | undefined;
  label: string;
  isSelected: boolean;
  isWorstZone: boolean;
};

type DeviceHoverCardProps = {
  device: DeviceDefinition;
  product: ProductDefinition;
  diagnosis: DeviceDiagnosis | undefined;
  telemetry: DeviceTelemetryRecord["telemetry"] | null;
};

type FlowRouteProps = {
  points: THREE.Vector3[];
  color: string;
  intensity: number;
  speedMultiplier?: number;
};

type AirDeliveryFlowProps = {
  points: THREE.Vector3[];
  color: string;
  intensity: number;
  speedMultiplier?: number;
};

const LOCKED_POLAR_ANGLE = 0.96;
const AUTO_ROTATE_SPEED = 0.45;
const WALL_HEIGHT = 1.28;
const WALL_BASE_Y = 0.08;
const WALL_THICKNESS = 0.16;
const WINDOW_CENTER_Y = 0.78;
const WINDOW_PANEL_HEIGHT = 0.88;
const WINDOW_SURFACE_OFFSET = WALL_THICKNESS / 2 + 0.012;
const WINDOW_GLASS_THICKNESS = 0.024;
const WINDOW_GLASS_FACE_OFFSET = WINDOW_GLASS_THICKNESS / 2 + 0.004;
const WINDOW_FRAME_DEPTH = 0.04;
const WINDOW_FRAME_BAR = 0.06;
const WINDOW_EDGE_CLEARANCE = 0.52;
const WINDOW_PANEL_GAP = 0.28;
const WINDOW_MIN_PANEL_WIDTH = 0.68;
const WINDOW_MAX_PANEL_WIDTH = 1.45;
const DEVICE_HOVER_ANCHOR_Y_OFFSET = 0.34;
const DEVICE_HOVER_LIFT_PX = 2;
const HORIZONTAL_WALL_COLOR = "#d8e0ea";
const VERTICAL_WALL_COLOR = "#c6d0dc";
const WINDOW_TINT_COLOR = "#d7efff";
const WINDOW_EDGE_TINT_COLOR = "#c7e7ff";
const WINDOW_GLASS_BODY_COLOR = "#f6fbff";

const GLASS_FRESNEL_VERTEX_SHADER = `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const GLASS_FRESNEL_FRAGMENT_SHADER = `
  uniform vec3 uBaseColor;
  uniform vec3 uEdgeColor;
  uniform float uBaseOpacity;
  uniform float uEdgeOpacity;
  uniform float uFresnelPower;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float facing = abs(dot(normalize(vWorldNormal), viewDirection));
    float fresnel = pow(1.0 - facing, uFresnelPower);

    vec3 color = mix(uBaseColor, uEdgeColor, fresnel);
    float opacity = mix(uBaseOpacity, uEdgeOpacity, fresnel);

    gl_FragColor = vec4(color, opacity);
  }
`;

type WallSegmentDefinition = {
  key: string;
  axis: "x" | "z";
  position: [number, number, number];
  size: [number, number, number];
  exterior: boolean;
};

type LinearSpan = {
  start: number;
  end: number;
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getWallSpan(space: BuildingBlueprint["spaces"][number], orientationDeg: number) {
  return orientationDeg === 90 || orientationDeg === 270 ? space.layout.size_m.depth : space.layout.size_m.width;
}

function subtractLinearSpans(base: LinearSpan, blockers: LinearSpan[]) {
  if (blockers.length === 0) {
    return [base];
  }

  const normalized = blockers
    .map((blocker) => ({
      start: clamp(blocker.start, base.start, base.end),
      end: clamp(blocker.end, base.start, base.end),
    }))
    .filter((blocker) => blocker.end - blocker.start > 0.001)
    .sort((left, right) => left.start - right.start);

  const merged: LinearSpan[] = [];

  for (const blocker of normalized) {
    const previous = merged.at(-1);

    if (!previous || blocker.start > previous.end + 0.001) {
      merged.push({ ...blocker });
      continue;
    }

    previous.end = Math.max(previous.end, blocker.end);
  }

  const spans: LinearSpan[] = [];
  let cursor = base.start;

  for (const blocker of merged) {
    if (blocker.start > cursor + 0.001) {
      spans.push({ start: cursor, end: blocker.start });
    }

    cursor = Math.max(cursor, blocker.end);
  }

  if (cursor < base.end - 0.001) {
    spans.push({ start: cursor, end: base.end });
  }

  return spans;
}

function getExposedWallSpans(
  space: BuildingBlueprint["spaces"][number],
  spaces: BuildingBlueprint["spaces"],
  orientationDeg: number,
) {
  const xStart = space.layout.origin_m.x;
  const xEnd = xStart + space.layout.size_m.width;
  const zStart = space.layout.origin_m.y;
  const zEnd = zStart + space.layout.size_m.depth;
  const blockers: LinearSpan[] = [];

  for (const other of spaces) {
    if (other.id === space.id) {
      continue;
    }

    const otherXStart = other.layout.origin_m.x;
    const otherXEnd = otherXStart + other.layout.size_m.width;
    const otherZStart = other.layout.origin_m.y;
    const otherZEnd = otherZStart + other.layout.size_m.depth;

    if (orientationDeg === 0 && Math.abs(otherZEnd - zStart) <= 0.001) {
      const overlapStart = Math.max(xStart, otherXStart);
      const overlapEnd = Math.min(xEnd, otherXEnd);

      if (overlapEnd - overlapStart > 0.001) {
        blockers.push({ start: overlapStart - xStart, end: overlapEnd - xStart });
      }
    }

    if (orientationDeg === 180 && Math.abs(otherZStart - zEnd) <= 0.001) {
      const overlapStart = Math.max(xStart, otherXStart);
      const overlapEnd = Math.min(xEnd, otherXEnd);

      if (overlapEnd - overlapStart > 0.001) {
        blockers.push({ start: overlapStart - xStart, end: overlapEnd - xStart });
      }
    }

    if (orientationDeg === 90 && Math.abs(otherXStart - xEnd) <= 0.001) {
      const overlapStart = Math.max(zStart, otherZStart);
      const overlapEnd = Math.min(zEnd, otherZEnd);

      if (overlapEnd - overlapStart > 0.001) {
        blockers.push({ start: overlapStart - zStart, end: overlapEnd - zStart });
      }
    }

    if (orientationDeg === 270 && Math.abs(otherXEnd - xStart) <= 0.001) {
      const overlapStart = Math.max(zStart, otherZStart);
      const overlapEnd = Math.min(zEnd, otherZEnd);

      if (overlapEnd - overlapStart > 0.001) {
        blockers.push({ start: overlapStart - zStart, end: overlapEnd - zStart });
      }
    }
  }

  return subtractLinearSpans({ start: 0, end: getWallSpan(space, orientationDeg) }, blockers);
}

function buildWindowPanels(
  space: BuildingBlueprint["spaces"][number],
  surface: BuildingBlueprint["spaces"][number]["envelope"]["transparent_surfaces"][number],
  spaces: BuildingBlueprint["spaces"],
) {
  const wallSpan = getWallSpan(space, surface.orientation_deg);
  const exposedSpans = getExposedWallSpans(space, spaces, surface.orientation_deg).filter(
    (span) => span.end - span.start > WINDOW_MIN_PANEL_WIDTH * 0.9,
  );

  return exposedSpans.flatMap((span, spanIndex) => {
    const spanLength = span.end - span.start;
    const edgeClearance = Math.min(WINDOW_EDGE_CLEARANCE, Math.max(0.18, spanLength * 0.14));
    const usableSpan = spanLength - edgeClearance * 2;

    if (usableSpan < WINDOW_MIN_PANEL_WIDTH) {
      return [];
    }

    let panelCount = spanLength >= 8 ? 3 : spanLength >= 3.8 ? 2 : 1;

    while (panelCount > 1) {
      const availablePanelWidth = (usableSpan - WINDOW_PANEL_GAP * (panelCount - 1)) / panelCount;

      if (availablePanelWidth >= WINDOW_MIN_PANEL_WIDTH) {
        break;
      }

      panelCount -= 1;
    }

    const totalGap = WINDOW_PANEL_GAP * (panelCount - 1);
    const maxPanelWidthForSpan = (usableSpan - totalGap) / panelCount;

    if (maxPanelWidthForSpan < WINDOW_MIN_PANEL_WIDTH) {
      return [];
    }

    const panelWidth = clamp(maxPanelWidthForSpan * 0.84, WINDOW_MIN_PANEL_WIDTH, WINDOW_MAX_PANEL_WIDTH);
    const combinedWidth = panelWidth * panelCount + totalGap;
    const firstPanelCenter = span.start + spanLength / 2 - combinedWidth / 2 + panelWidth / 2;

    return Array.from({ length: panelCount }, (_, panelIndex) => {
      const panelCenterLocal = firstPanelCenter + panelIndex * (panelWidth + WINDOW_PANEL_GAP);

      return {
        key: `${surface.surface_id}-span-${spanIndex}-panel-${panelIndex}`,
        width: panelWidth,
        offsetAlongWall: panelCenterLocal - wallSpan / 2,
      };
    });
  });
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

function getWallMountedDeviceTransform(
  device: DeviceDefinition,
  product: ProductDefinition,
  blueprint: BuildingBlueprint,
) {
  const baseTransform = getDeviceModelTransform(device);

  if (product.visualization?.mount_type !== "wall_surface" || device.served_space_ids.length === 0) {
    return baseTransform;
  }

  const servedSpace = blueprint.spaces.find((space) => space.id === device.served_space_ids[0]);

  if (!servedSpace) {
    return baseTransform;
  }

  const x = device.layout.position_m.x;
  const z = device.layout.position_m.y;
  const xMin = servedSpace.layout.origin_m.x;
  const xMax = xMin + servedSpace.layout.size_m.width;
  const zMin = servedSpace.layout.origin_m.y;
  const zMax = zMin + servedSpace.layout.size_m.depth;
  const wallInset = 0.028;

  const distances = [
    { wall: "west", distance: Math.abs(x - xMin) },
    { wall: "east", distance: Math.abs(xMax - x) },
    { wall: "north", distance: Math.abs(z - zMin) },
    { wall: "south", distance: Math.abs(zMax - z) },
  ].sort((left, right) => left.distance - right.distance);

  const nearestWall = distances[0]?.wall;
  const baseYOffset = baseTransform.positionOffset[1];

  if (nearestWall === "west") {
    return {
      ...baseTransform,
      rotation: [0, Math.PI / 2, 0] as [number, number, number],
      positionOffset: [wallInset, baseYOffset, 0] as [number, number, number],
    };
  }

  if (nearestWall === "east") {
    return {
      ...baseTransform,
      rotation: [0, -Math.PI / 2, 0] as [number, number, number],
      positionOffset: [-wallInset, baseYOffset, 0] as [number, number, number],
    };
  }

  if (nearestWall === "south") {
    return {
      ...baseTransform,
      rotation: [0, Math.PI, 0] as [number, number, number],
      positionOffset: [0, baseYOffset, -wallInset] as [number, number, number],
    };
  }

  return {
    ...baseTransform,
    rotation: [0, 0, 0] as [number, number, number],
    positionOffset: [0, baseYOffset, wallInset] as [number, number, number],
  };
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
      className={`pointer-events-none rounded-[1.15rem] border px-2.5 py-2 shadow-[0_14px_30px_rgba(15,23,42,0.14)] backdrop-blur ${
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
            {zone ? `${zone.temperatureC.toFixed(1)}°C` : "--"}
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
      <Html center style={{ pointerEvents: "none" }}>
        <RoomBadge
          zone={zone}
          label={label}
          isSelected={isSelected}
          isWorstZone={isWorstZone}
        />
      </Html>
    </group>
  );
}

type FlowPolylineSegment = {
  from: THREE.Vector3;
  to: THREE.Vector3;
  length: number;
};

function buildFlowPolyline(points: THREE.Vector3[]) {
  const normalizedPoints: THREE.Vector3[] = [];

  for (const point of points) {
    const lastPoint = normalizedPoints.at(-1);

    if (!lastPoint || lastPoint.distanceTo(point) > 0.001) {
      normalizedPoints.push(point.clone());
    }
  }

  const segments: FlowPolylineSegment[] = [];
  let totalLength = 0;

  for (let index = 0; index < normalizedPoints.length - 1; index += 1) {
    const from = normalizedPoints[index];
    const to = normalizedPoints[index + 1];
    const length = from.distanceTo(to);

    if (length <= 0.001) {
      continue;
    }

    segments.push({ from, to, length });
    totalLength += length;
  }

  return { segments, totalLength };
}

function sampleFlowPolyline(segments: FlowPolylineSegment[], totalLength: number, distance: number) {
  if (segments.length === 0 || totalLength <= 0) {
    return new THREE.Vector3();
  }

  let remainingDistance = ((distance % totalLength) + totalLength) % totalLength;

  for (const segment of segments) {
    if (remainingDistance <= segment.length) {
      const alpha = segment.length <= 0.001 ? 0 : remainingDistance / segment.length;
      return segment.from.clone().lerp(segment.to, alpha);
    }

    remainingDistance -= segment.length;
  }

  return segments.at(-1)?.to.clone() ?? new THREE.Vector3();
}

function AirDeliveryFlow({ points, color, intensity, speedMultiplier = 1 }: AirDeliveryFlowProps) {
  const polyline = useMemo(() => buildFlowPolyline(points), [points]);
  const particleRefs = useRef<Array<THREE.Mesh | null>>([]);
  const particles = useMemo(() => Array.from({ length: 5 }, (_, index) => index / 5), []);
  const particleRadius = 0.024 + intensity * 0.012;
  const source = points[0];
  const dischargeTarget = points[1] ?? points[0];
  const jetDirection = useMemo(
    () => dischargeTarget.clone().sub(source).normalize(),
    [dischargeTarget, source],
  );
  const jetLength = source.distanceTo(dischargeTarget);
  const jetCenter = useMemo(() => source.clone().lerp(dischargeTarget, 0.5), [dischargeTarget, source]);
  const jetQuaternion = useMemo(() => {
    const quaternion = new THREE.Quaternion();
    quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), jetDirection);
    return quaternion;
  }, [jetDirection]);

  useFrame(({ clock }) => {
    if (polyline.totalLength <= 0) {
      return;
    }

    const time = clock.getElapsedTime();
    particleRefs.current.forEach((mesh, index) => {
      if (!mesh) {
        return;
      }

      const distance =
        (particles[index] * polyline.totalLength + time * (0.34 + intensity * 0.32) * speedMultiplier) %
        polyline.totalLength;
      const point = sampleFlowPolyline(polyline.segments, polyline.totalLength, distance);
      mesh.position.copy(point);
    });
  });

  return (
    <group renderOrder={4}>
      {jetLength > 0.05 ? (
        <mesh position={jetCenter} quaternion={jetQuaternion} renderOrder={4}>
          <cylinderGeometry args={[0.03, 0.11 + intensity * 0.04, Math.max(jetLength, 0.16), 18, 1, true]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={1.25}
            transparent
            opacity={0.16}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ) : null}
      {particles.map((particle, index) => (
        <mesh
          key={`${particle}-${index}`}
          ref={(node) => {
            particleRefs.current[index] = node;
          }}
          renderOrder={5}
        >
          <sphereGeometry args={[particleRadius, 14, 14]} />
          <meshStandardMaterial
            color="#ffffff"
            emissive={color}
            emissiveIntensity={2.2}
            transparent
            opacity={0.78}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function FlowRoute({ points, color, intensity, speedMultiplier = 1 }: FlowRouteProps) {
  const polyline = useMemo(() => buildFlowPolyline(points), [points]);
  const particleRefs = useRef<Array<THREE.Mesh | null>>([]);
  const particles = useMemo(() => Array.from({ length: 6 }, (_, index) => index / 6), []);
  const coreThickness = 0.052 + intensity * 0.018;
  const particleRadius = 0.032 + intensity * 0.015;

  useFrame(({ clock }) => {
    if (polyline.totalLength <= 0) {
      return;
    }

    const time = clock.getElapsedTime();
    particleRefs.current.forEach((mesh, index) => {
      if (!mesh) {
        return;
      }

      const distance =
        (particles[index] * polyline.totalLength + time * (0.52 + intensity * 0.7) * speedMultiplier) %
        polyline.totalLength;
      const point = sampleFlowPolyline(polyline.segments, polyline.totalLength, distance);
      mesh.position.copy(point);
    });
  });

  return (
    <group>
      {polyline.segments.map((segment, index) => (
        <FlowCoreSegment
          key={`${segment.from.toArray().join(":")}-${segment.to.toArray().join(":")}-${index}`}
          from={segment.from}
          to={segment.to}
          thickness={coreThickness}
          color={color}
        />
      ))}
      {particles.map((particle, index) => (
        <mesh
          key={`${particle}-${index}`}
          ref={(node) => {
            particleRefs.current[index] = node;
          }}
          renderOrder={5}
        >
          <sphereGeometry args={[particleRadius, 16, 16]} />
          <meshStandardMaterial
            color="#ffffff"
            emissive={color}
            emissiveIntensity={2.8}
            transparent
            opacity={0.96}
          />
        </mesh>
      ))}
    </group>
  );
}

function FlowCoreSegment({
  from,
  to,
  thickness,
  color,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  thickness: number;
  color: string;
}) {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const dz = Math.abs(to.z - from.z);
  const center = new THREE.Vector3((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);

  if (dx >= dy && dx >= dz) {
    return (
      <RoundedBox
        args={[Math.max(dx, 0.12), thickness, thickness]}
        radius={0.02}
        smoothness={3}
        position={center}
        renderOrder={4}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.9}
          transparent
          opacity={0.78}
          depthWrite={false}
        />
      </RoundedBox>
    );
  }

  if (dz >= dx && dz >= dy) {
    return (
      <RoundedBox
        args={[thickness, thickness, Math.max(dz, 0.12)]}
        radius={0.02}
        smoothness={3}
        position={center}
        renderOrder={4}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.9}
          transparent
          opacity={0.78}
          depthWrite={false}
        />
      </RoundedBox>
    );
  }

  return (
    <RoundedBox
      args={[thickness, Math.max(dy, 0.12), thickness]}
      radius={0.02}
      smoothness={3}
      position={center}
      renderOrder={4}
    >
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={1.9}
        transparent
        opacity={0.78}
        depthWrite={false}
      />
    </RoundedBox>
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
      <RoundedBox
        args={[Math.max(dx, 0.2), thickness, thickness]}
        radius={0.04}
        smoothness={3}
        position={center}
        renderOrder={2}
      >
        <meshStandardMaterial
          color={color}
          metalness={0.38}
          roughness={0.4}
          transparent
          opacity={0.6}
          depthWrite={false}
        />
      </RoundedBox>
    );
  }

  if (dz >= dx && dz >= dy) {
    return (
      <RoundedBox
        args={[thickness, thickness, Math.max(dz, 0.2)]}
        radius={0.04}
        smoothness={3}
        position={center}
        renderOrder={2}
      >
        <meshStandardMaterial
          color={color}
          metalness={0.38}
          roughness={0.4}
          transparent
          opacity={0.6}
          depthWrite={false}
        />
      </RoundedBox>
    );
  }

  return (
    <RoundedBox args={[0.16, Math.max(dy, 0.2), 0.16]} radius={0.03} smoothness={3} position={center} renderOrder={2}>
      <meshStandardMaterial
        color={color}
        metalness={0.18}
        roughness={0.5}
        transparent
        opacity={0.6}
        depthWrite={false}
      />
    </RoundedBox>
  );
}

function WindowStrip({
  center,
  orientationDeg,
  width,
  offsetAlongWall,
}: {
  center: THREE.Vector3;
  orientationDeg: number;
  width: number;
  offsetAlongWall: number;
}) {
  const isVerticalWall = orientationDeg === 90 || orientationDeg === 270;
  const adjustedCenter = isVerticalWall
    ? new THREE.Vector3(center.x, center.y, center.z + offsetAlongWall)
    : new THREE.Vector3(center.x + offsetAlongWall, center.y, center.z);
  const position: [number, number, number] =
    orientationDeg === 0
      ? [adjustedCenter.x, WINDOW_CENTER_Y, adjustedCenter.z - WINDOW_SURFACE_OFFSET]
      : orientationDeg === 180
        ? [adjustedCenter.x, WINDOW_CENTER_Y, adjustedCenter.z + WINDOW_SURFACE_OFFSET]
        : orientationDeg === 90
          ? [adjustedCenter.x + WINDOW_SURFACE_OFFSET, WINDOW_CENTER_Y, adjustedCenter.z]
          : [adjustedCenter.x - WINDOW_SURFACE_OFFSET, WINDOW_CENTER_Y, adjustedCenter.z];
  const planeRotation: [number, number, number] = isVerticalWall ? [0, Math.PI / 2, 0] : [0, 0, 0];
  const outerGlassPosition: [number, number, number] =
    orientationDeg === 0
      ? [position[0], position[1], position[2] - WINDOW_GLASS_FACE_OFFSET]
      : orientationDeg === 180
        ? [position[0], position[1], position[2] + WINDOW_GLASS_FACE_OFFSET]
        : orientationDeg === 90
          ? [position[0] + WINDOW_GLASS_FACE_OFFSET, position[1], position[2]]
          : [position[0] - WINDOW_GLASS_FACE_OFFSET, position[1], position[2]];
  const innerGlassPosition: [number, number, number] =
    orientationDeg === 0
      ? [position[0], position[1], position[2] + WINDOW_GLASS_FACE_OFFSET]
      : orientationDeg === 180
        ? [position[0], position[1], position[2] - WINDOW_GLASS_FACE_OFFSET]
        : orientationDeg === 90
          ? [position[0] - WINDOW_GLASS_FACE_OFFSET, position[1], position[2]]
          : [position[0] + WINDOW_GLASS_FACE_OFFSET, position[1], position[2]];
  const topFramePosition: [number, number, number] = [position[0], position[1] + WINDOW_PANEL_HEIGHT / 2, position[2]];
  const bottomFramePosition: [number, number, number] = [position[0], position[1] - WINDOW_PANEL_HEIGHT / 2, position[2]];
  const leadingFramePosition: [number, number, number] = isVerticalWall
    ? [position[0], position[1], position[2] - width / 2]
    : [position[0] - width / 2, position[1], position[2]];
  const trailingFramePosition: [number, number, number] = isVerticalWall
    ? [position[0], position[1], position[2] + width / 2]
    : [position[0] + width / 2, position[1], position[2]];
  const horizontalFrameArgs: [number, number, number] = isVerticalWall
    ? [WINDOW_FRAME_DEPTH, WINDOW_FRAME_BAR, width + WINDOW_FRAME_BAR]
    : [width + WINDOW_FRAME_BAR, WINDOW_FRAME_BAR, WINDOW_FRAME_DEPTH];
  const verticalFrameArgs: [number, number, number] = isVerticalWall
    ? [WINDOW_FRAME_DEPTH, WINDOW_PANEL_HEIGHT + WINDOW_FRAME_BAR, WINDOW_FRAME_BAR]
    : [WINDOW_FRAME_BAR, WINDOW_PANEL_HEIGHT + WINDOW_FRAME_BAR, WINDOW_FRAME_DEPTH];
  return (
    <group>
      <RoundedBox
        args={horizontalFrameArgs}
        radius={0.012}
        smoothness={2}
        position={topFramePosition}
      >
        <meshStandardMaterial color="#cedae6" metalness={0.04} roughness={0.4} />
      </RoundedBox>
      <RoundedBox
        args={horizontalFrameArgs}
        radius={0.012}
        smoothness={2}
        position={bottomFramePosition}
      >
        <meshStandardMaterial
          color="#cedae6"
          metalness={0.04}
          roughness={0.4}
        />
      </RoundedBox>
      <RoundedBox args={verticalFrameArgs} radius={0.012} smoothness={2} position={leadingFramePosition}>
        <meshStandardMaterial color="#cedae6" metalness={0.04} roughness={0.4} />
      </RoundedBox>
      <RoundedBox args={verticalFrameArgs} radius={0.012} smoothness={2} position={trailingFramePosition}>
        <meshStandardMaterial color="#cedae6" metalness={0.04} roughness={0.4} />
      </RoundedBox>
      <RoundedBox
        args={
          isVerticalWall
            ? [WINDOW_GLASS_THICKNESS, WINDOW_PANEL_HEIGHT - 0.04, Math.max(width - 0.04, 0.12)]
            : [Math.max(width - 0.04, 0.12), WINDOW_PANEL_HEIGHT - 0.04, WINDOW_GLASS_THICKNESS]
        }
        radius={0.008}
        smoothness={3}
        position={position}
        renderOrder={3}
      >
        <meshStandardMaterial
          color={WINDOW_GLASS_BODY_COLOR}
          transparent
          opacity={0.26}
          roughness={0.08}
          metalness={0.02}
          emissive="#e8f4ff"
          emissiveIntensity={0.025}
        />
      </RoundedBox>
      <mesh position={outerGlassPosition} rotation={planeRotation} renderOrder={4}>
        <planeGeometry args={[width - 0.04, WINDOW_PANEL_HEIGHT - 0.04]} />
        <shaderMaterial
          uniforms={{
            uBaseColor: { value: new THREE.Color("#f1f9ff") },
            uEdgeColor: { value: new THREE.Color(WINDOW_EDGE_TINT_COLOR) },
            uBaseOpacity: { value: 0.14 },
            uEdgeOpacity: { value: 0.19 },
            uFresnelPower: { value: 1.65 },
          }}
          vertexShader={GLASS_FRESNEL_VERTEX_SHADER}
          fragmentShader={GLASS_FRESNEL_FRAGMENT_SHADER}
          transparent
          toneMapped={false}
          depthWrite={false}
          side={THREE.DoubleSide}
          polygonOffset
          polygonOffsetFactor={-1}
        />
      </mesh>
      <mesh position={innerGlassPosition} rotation={planeRotation} renderOrder={4}>
        <planeGeometry args={[width - 0.04, WINDOW_PANEL_HEIGHT - 0.04]} />
        <shaderMaterial
          uniforms={{
            uBaseColor: { value: new THREE.Color("#f6fbff") },
            uEdgeColor: { value: new THREE.Color(WINDOW_TINT_COLOR) },
            uBaseOpacity: { value: 0.09 },
            uEdgeOpacity: { value: 0.13 },
            uFresnelPower: { value: 1.8 },
          }}
          vertexShader={GLASS_FRESNEL_VERTEX_SHADER}
          fragmentShader={GLASS_FRESNEL_FRAGMENT_SHADER}
          transparent
          toneMapped={false}
          depthWrite={false}
          side={THREE.DoubleSide}
          polygonOffset
          polygonOffsetFactor={-1}
        />
      </mesh>
    </group>
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
    return `${value.toFixed(1)}°C`;
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
      className="pointer-events-none relative min-w-[156px] rounded-[1.15rem] border border-white/80 bg-white/95 px-2.5 py-2 shadow-[0_14px_28px_rgba(15,23,42,0.16)] backdrop-blur"
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
        <Html position={[position[0], position[1] + 0.55, position[2]]} center occlude style={{ pointerEvents: "none" }}>
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
  showSelectedZoneBadge,
  worstZoneId,
  onSelectZone,
  onSelectDevice,
  autoRotateActive,
  controlsRef,
  hoverResetToken,
  onHoverStateChange,
  simulationPreview,
  simulationActive,
}: RuntimeSceneContentProps) {
  const [hoveredZoneState, setHoveredZoneState] = useState<{ id: string | null; token: number }>({
    id: null,
    token: hoverResetToken,
  });
  const [hoveredDeviceState, setHoveredDeviceState] = useState<{ id: string | null; token: number }>({
    id: null,
    token: hoverResetToken,
  });
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
  const animationSpeedMultiplier = simulationActive ? simulationPreview?.accelerationFactor ?? 100 : 1;
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

  const clearTransientHover = () => {
    setHoveredZoneState({ id: null, token: hoverResetToken });
    setHoveredDeviceState({ id: null, token: hoverResetToken });
  };

  useEffect(() => {
    const controls = controlsRef.current;

    if (!controls) {
      return;
    }

    controls.target.set(0, sceneCenter.y, 0);
    controls.update();
  }, [controlsRef, sceneCenter]);

  const visibleHoveredZoneId = hoveredZoneState.token === hoverResetToken ? hoveredZoneState.id : null;
  const visibleHoveredDeviceId = hoveredDeviceState.token === hoverResetToken ? hoveredDeviceState.id : null;

  useEffect(() => {
    onHoverStateChange(visibleHoveredZoneId !== null || visibleHoveredDeviceId !== null);
  }, [onHoverStateChange, visibleHoveredDeviceId, visibleHoveredZoneId]);

  return (
    <>
      <color attach="background" args={["#d9e4ee"]} />
      <fog attach="fog" args={["#d9e4ee", 30, 92]} />
      <ambientLight intensity={1.22} />
      <hemisphereLight intensity={1.02} color="#f8fafc" groundColor="#c8d4e0" />
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
        minZoom={22}
        maxZoom={118}
        autoRotate={autoRotateActive}
        autoRotateSpeed={AUTO_ROTATE_SPEED}
      />

      <group
        onPointerLeave={clearTransientHover}
      >
        <group position={[-sceneCenter.x, 0, -sceneCenter.z]}>
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[11, -0.1, 5.6]}
          onPointerMove={(event) => {
            event.stopPropagation();
            clearTransientHover();
          }}
        >
          <planeGeometry args={[36, 26]} />
          <meshStandardMaterial color="#d3dde8" />
        </mesh>

        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[11.4, -0.05, 5.6]}
          onPointerMove={(event) => {
            event.stopPropagation();
            clearTransientHover();
          }}
        >
          <planeGeometry args={[28, 20]} />
          <meshStandardMaterial color="#eef3f7" transparent opacity={0.18} />
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
          const isSelected = showSelectedZoneBadge && selectedZoneId === space.id;
          const branchDevice = blueprint.devices.find(
            (device) => device.kind === "actuator" && device.served_space_ids.includes(space.id),
          );
          const branchPoint = branchDevice
            ? getDeviceScenePosition(branchDevice)
            : new THREE.Vector3(center.x, 3.05, center.z);
          const trunkJunction = new THREE.Vector3(trunkX, trunkY, center.z);
          const branchHorizontal = new THREE.Vector3(branchPoint.x, trunkY, center.z);
          const diffuserOutlet = new THREE.Vector3(branchPoint.x, branchPoint.y - 0.14, branchPoint.z);
          const airDeliveryDrop = new THREE.Vector3(branchPoint.x, branchPoint.y - 0.34, branchPoint.z);
          const airDeliveryTarget = new THREE.Vector3(center.x, Math.max(0.96, branchPoint.y - 0.78), center.z);
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
              >
                <meshStandardMaterial color={getSpaceColor(zone)} metalness={0.06} roughness={0.88} />
              </RoundedBox>
              <mesh
                rotation={[-Math.PI / 2, 0, 0]}
                position={[center.x, 0.18, center.z]}
                onClick={(event) => handleRoomClick(event, space.id)}
                onPointerMove={(event) => {
                  event.stopPropagation();
                  setHoveredDeviceState({ id: null, token: hoverResetToken });
                  setHoveredZoneState({ id: space.id, token: hoverResetToken });
                }}
              >
                <planeGeometry args={[space.layout.size_m.width - 0.08, space.layout.size_m.depth - 0.08]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>

              <ThermalOverlay center={center} width={space.layout.size_m.width} depth={space.layout.size_m.depth} zone={zone} />
              <ComfortGlow center={center} zone={zone} roomWidth={space.layout.size_m.width} />

              {space.envelope.transparent_surfaces.map((surface) => {
                const windowCenter =
                  surface.orientation_deg === 0
                    ? new THREE.Vector3(center.x, WINDOW_CENTER_Y, space.layout.origin_m.y)
                    : surface.orientation_deg === 180
                      ? new THREE.Vector3(center.x, WINDOW_CENTER_Y, space.layout.origin_m.y + space.layout.size_m.depth)
                      : surface.orientation_deg === 90
                        ? new THREE.Vector3(space.layout.origin_m.x + space.layout.size_m.width, WINDOW_CENTER_Y, center.z)
                        : new THREE.Vector3(space.layout.origin_m.x, WINDOW_CENTER_Y, center.z);

                return buildWindowPanels(space, surface, blueprint.spaces).map((panel) => (
                  <WindowStrip
                    key={panel.key}
                    center={windowCenter}
                    orientationDeg={surface.orientation_deg}
                    width={panel.width}
                    offsetAlongWall={panel.offsetAlongWall}
                  />
                ));
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
                to={diffuserOutlet}
                thickness={0.09}
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
                speedMultiplier={animationSpeedMultiplier}
              />
              <AirDeliveryFlow
                points={[
                  diffuserOutlet,
                  airDeliveryDrop,
                  airDeliveryTarget,
                ]}
                color={flowColor}
                intensity={Math.max(0.12, intensity * 0.7)}
                speedMultiplier={animationSpeedMultiplier}
              />

              {visibleHoveredZoneId === space.id || (showSelectedZoneBadge && selectedZoneId === space.id) ? (
                <FloatingRoomBadge
                  position={[center.x, 1.55, center.z]}
                  zone={zone}
                  label={space.name}
                  isSelected={isSelected}
                  isWorstZone={isWorstZone}
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
          const transform = getWallMountedDeviceTransform(device, product, blueprint);
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
                  setHoveredZoneState({ id: null, token: hoverResetToken });
                  setHoveredDeviceState({ id: device.id, token: hoverResetToken });
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
              {visibleHoveredDeviceId === device.id ? (
                <Html
                  position={[
                    point.x + transform.positionOffset[0],
                    point.y + transform.positionOffset[1] + DEVICE_HOVER_ANCHOR_Y_OFFSET,
                    point.z + transform.positionOffset[2],
                  ]}
                  style={{
                    pointerEvents: "none",
                    transform: `translate(-50%, calc(-100% - ${DEVICE_HOVER_LIFT_PX}px))`,
                  }}
                >
                  <DeviceHoverCard
                    device={device}
                    product={product}
                    diagnosis={diagnosis}
                    telemetry={reading?.telemetry ?? null}
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

function WeatherStatusIcon({ isNight, cloudCoverPct }: { isNight: boolean; cloudCoverPct: number }) {
  const cloudOpacity = cloudCoverPct >= 35 ? 1 : 0.45;

  return (
    <svg viewBox="0 0 28 28" aria-hidden="true" className="h-7 w-7 text-slate-500">
      {isNight ? (
        <>
          <path
            d="M16.9 5.4a6.6 6.6 0 1 0 5.7 9.9 7.1 7.1 0 0 1-5.7-9.9Z"
            fill="currentColor"
            opacity="0.2"
          />
          <path
            d="M17.2 5.4a6.5 6.5 0 0 0 4.5 10.9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle cx="12.5" cy="10.5" r="3.6" fill="currentColor" opacity="0.18" />
          <circle cx="12.5" cy="10.5" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </>
      )}
      <path
        d="M9 20h9.3a3.2 3.2 0 0 0 .1-6.4 4.6 4.6 0 0 0-8.7-1.1A3.7 3.7 0 0 0 9 20Z"
        fill="currentColor"
        opacity={cloudOpacity * 0.2}
      />
      <path
        d="M9 20h9.3a3.2 3.2 0 0 0 .1-6.4 4.6 4.6 0 0 0-8.7-1.1A3.7 3.7 0 0 0 9 20Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={cloudOpacity}
      />
    </svg>
  );
}

export function RuntimeScene(props: RuntimeSceneProps) {
  const controlsRef = useRef<import("three-stdlib").OrbitControls | null>(null);
  const [isSceneHovered, setIsSceneHovered] = useState(false);
  const [hasActiveHoverCard, setHasActiveHoverCard] = useState(false);
  const [hoverResetToken, setHoverResetToken] = useState(0);
  const shouldPauseRotation = isSceneHovered || hasActiveHoverCard;
  const weatherSnapshot = props.twin?.weather ?? props.sandbox?.weather ?? null;
  const observedAt = props.twin?.observedAt ?? props.sandbox?.observedAt ?? null;
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat("it-IT", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: props.blueprint.building.timezone,
      }),
    [props.blueprint.building.timezone],
  );
  const observedDate = observedAt ? new Date(observedAt) : null;
  const localTimeLabel = observedDate ? timeFormatter.format(observedDate) : "--:--";
  const localHour = observedDate
    ? Number(
        new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          hour12: false,
          timeZone: props.blueprint.building.timezone,
        }).format(observedDate),
      )
    : 12;
  const isNight = localHour >= 21 || localHour < 6;
  const weatherLabel = isNight
    ? "NIGHT"
    : (weatherSnapshot?.cloudCoverPct ?? 0) >= 70
      ? "OVERCAST"
      : (weatherSnapshot?.cloudCoverPct ?? 0) >= 35
        ? "CLOUDY"
        : "CLEAR";
  const cityLabel = props.blueprint.building.location.city.toLocaleUpperCase("it-IT");
  const simulationBadge =
    props.simulationActive && props.simulationPreview
      ? `SIM ${props.simulationPreview.accelerationFactor}x · ${props.simulationMinute ?? 0}/${props.simulationPreview.horizonMinutes} min`
      : null;
  const runtimeSpeedBadge =
    props.timeMode === "virtual" ? `${props.timeSpeedMultiplier}x` : null;

  return (
    <div
      className="relative h-[100svh] min-h-[720px] w-full overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.92),rgba(224,232,240,0.75)_42%,rgba(199,211,224,0.96)_100%)]"
      onPointerEnter={() => setIsSceneHovered(true)}
      onPointerLeave={() => {
        setIsSceneHovered(false);
        setHoverResetToken((current) => current + 1);
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-32 bg-gradient-to-b from-white/55 to-transparent" />
      <div className="pointer-events-none absolute inset-x-4 top-4 z-10 sm:inset-x-6 sm:top-5">
        <div className="relative flex flex-wrap items-center justify-between gap-3 rounded-full border border-slate-200/70 bg-slate-100/76 px-4 py-3 text-slate-600 shadow-[0_18px_42px_rgba(148,163,184,0.16)] backdrop-blur">
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
            <div className="flex items-center gap-3 px-1 py-1">
              {simulationBadge ? (
                <>
                  <span className="rounded-full border border-[#d9691f]/25 bg-[#d9691f]/12 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#9d4511]">
                    {simulationBadge}
                  </span>
                  <span className="h-6 w-px bg-slate-300/80" aria-hidden="true" />
                </>
              ) : null}
              <span className="text-sm font-medium tracking-[-0.02em] text-slate-700">
                {localTimeLabel}, {cityLabel}
              </span>
              {runtimeSpeedBadge ? (
                <>
                  <span className="h-6 w-px bg-slate-300/80" aria-hidden="true" />
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#d9691f]/18 bg-[#d9691f]/8 px-2.5 py-1 text-[11px] font-semibold tracking-[0.02em] text-[#9d4511]"
                    aria-label={`Sandbox time accelerated to ${runtimeSpeedBadge}`}
                  >
                    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5">
                      <path
                        d="M4.5 10a5.5 5.5 0 1 0 5.5-5.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                      <path
                        d="M10 4.5v5l3.1 1.8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M2.8 6.1 5.2 3.7 5.5 6.8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {runtimeSpeedBadge}
                  </span>
                </>
              ) : null}
              <span className="h-6 w-px bg-slate-300/80" aria-hidden="true" />
              <div
                className="flex items-center gap-2"
                aria-label={`Weather ${weatherLabel.toLowerCase()} ${weatherSnapshot?.temperatureC.toFixed(0) ?? "--"} degrees Celsius`}
              >
                <WeatherStatusIcon isNight={isNight} cloudCoverPct={weatherSnapshot?.cloudCoverPct ?? 0} />
                <span className="text-sm font-semibold tracking-[-0.02em] text-slate-700">
                  {weatherLabel}, {weatherSnapshot?.temperatureC.toFixed(0) ?? "--"}°C
                </span>
              </div>
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
        camera={{ position: [18, 18, 18], zoom: 34, near: 0.1, far: 260 }}
        dpr={1}
        gl={{ antialias: false, powerPreference: "high-performance" }}
      >
        <RuntimeSceneContent
          {...props}
          autoRotateActive={!shouldPauseRotation}
          controlsRef={controlsRef}
          hoverResetToken={hoverResetToken}
          onHoverStateChange={setHasActiveHoverCard}
        />
      </Canvas>
    </div>
  );
}
