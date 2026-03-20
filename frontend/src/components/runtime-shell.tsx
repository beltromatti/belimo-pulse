"use client";

import dynamic from "next/dynamic";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  ActiveControlPolicy,
  BrainAlert,
  DeviceDefinition,
  DeviceDiagnosis,
  DeviceTelemetryRecord,
  FacilityModePreference,
  FaultOverrideMode,
  OperatorPolicy,
  ProductDefinition,
  RuntimeBootstrapPayload,
  RuntimeControlState,
  RuntimeSocketMessage,
  ZoneTwinState,
} from "@/lib/runtime-types";
import { BrandLockup } from "@/components/brand-lockup";
import { ChatPanel } from "@/components/chat-panel";
import { ProductModelPreview } from "@/components/product-model-preview";

const RuntimeScene = dynamic(
  () => import("@/components/runtime-scene").then((module) => module.RuntimeScene),
  { ssr: false },
);

type RuntimeShellProps = {
  initial: RuntimeBootstrapPayload;
  initialBrainAlerts?: BrainAlert[];
  initialBrainPolicies?: OperatorPolicy[];
  websocketUrl: string;
  onReturnToPortfolio?: () => void;
};

type RuntimeState = {
  twin: RuntimeBootstrapPayload["latestTwinSnapshot"];
  sandbox: RuntimeBootstrapPayload["latestSandboxBatch"];
  controls: RuntimeControlState;
  manualControls: RuntimeControlState;
  controlResolution: RuntimeBootstrapPayload["controlResolution"];
  persistenceSummary: RuntimeBootstrapPayload["persistenceSummary"];
};

const modeOptions: Array<{ value: FacilityModePreference; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "heating", label: "Heat" },
  { value: "cooling", label: "Cool" },
  { value: "economizer", label: "Eco" },
  { value: "ventilation", label: "Vent" },
];

function formatZoneLabel(zoneId: string) {
  return zoneId
    .split("_")
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function formatModeLabel(mode: string) {
  return mode
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatPolicyScheduleLabel(policy: OperatorPolicy) {
  if (!policy.schedule) {
    return "Always active";
  }

  return `${policy.schedule.daysOfWeek
    .map((day) => day.charAt(0).toUpperCase() + day.slice(1))
    .join(", ")} ${policy.schedule.startLocalTime}-${policy.schedule.endLocalTime}`;
}

function formatPolicyScopeLabel(policy: OperatorPolicy, initial: RuntimeBootstrapPayload) {
  if (policy.scopeType !== "zone" || !policy.scopeId) {
    return initial.blueprint.building.name;
  }

  return initial.blueprint.spaces.find((space) => space.id === policy.scopeId)?.name ?? policy.scopeId;
}

function formatAppliedControlPath(path: string, initial: RuntimeBootstrapPayload) {
  if (path === "occupancyBias") {
    return "Occupancy bias";
  }

  if (path === "sourceModePreference") {
    return "Source mode preference";
  }

  if (path.startsWith("zoneTemperatureOffsetsC.")) {
    const zoneId = path.replace("zoneTemperatureOffsetsC.", "");
    return initial.blueprint.spaces.find((space) => space.id === zoneId)?.name ?? zoneId;
  }

  return formatModeLabel(path);
}

function formatLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatValue(value: unknown): string | null {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => formatValue(entry)).filter(Boolean).join(" / ");
  }

  return null;
}

function extractTechnicalSpecs(product: ProductDefinition) {
  const officialSpecs =
    product.catalog_basis && typeof product.catalog_basis === "object" && "official_specs" in product.catalog_basis
      ? (product.catalog_basis.official_specs as Record<string, unknown>)
      : null;

  if (!officialSpecs) {
    return [];
  }

  return Object.entries(officialSpecs)
    .map(([key, value]) => ({
      label: formatLabel(key),
      value: formatValue(value),
    }))
    .filter((entry): entry is { label: string; value: string } => Boolean(entry.value))
    .slice(0, 4);
}

function getTelemetryHighlights(reading: DeviceTelemetryRecord | null) {
  if (!reading) {
    return [];
  }

  return Object.entries(reading.telemetry)
    .map(([key, value]) => {
      if (typeof value === "number") {
        return {
          label: formatLabel(key),
          value: value.toFixed(Number.isInteger(value) ? 0 : 1),
        };
      }

      if (typeof value === "string") {
        return {
          label: formatLabel(key),
          value,
        };
      }

      return null;
    })
    .filter((entry): entry is { label: string; value: string } => entry !== null)
    .slice(0, 4);
}

function formatDeviceKind(kind: DeviceDefinition["kind"]) {
  if (kind === "source_equipment") {
    return "Source Equipment";
  }

  return formatLabel(kind);
}

function getDeviceDisplayName(product: ProductDefinition) {
  return product.official_reference_models[0] ?? formatLabel(product.subtype);
}

function ProductLineupIcon({
  kind,
}: {
  kind: DeviceDefinition["kind"];
}) {
  if (kind === "actuator") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true" className="h-4 w-4">
        <rect x="8" y="9" width="12" height="9" rx="2.5" fill="currentColor" opacity="0.9" />
        <path
          d="M20 13h4.5c1.4 0 2.5 1.1 2.5 2.5S25.9 18 24.5 18H22"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M7 22.5h14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (kind === "sensor") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true" className="h-4 w-4">
        <rect x="10" y="7.5" width="12" height="17" rx="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="16" cy="20.5" r="1.8" fill="currentColor" />
        <path d="M16 12v5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === "source_equipment") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true" className="h-4 w-4">
        <rect x="7.5" y="8" width="17" height="12.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M11 24.5h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M12 14h8M16 10.5v7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="h-4 w-4">
      <rect x="8" y="8" width="16" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M16 11v10M11 16h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function AreaLineupIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="h-4 w-4">
      <path
        d="M8 10.5h16v11H8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M16 10.5v11M8 16h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function getSourceReading(readings: DeviceTelemetryRecord[] | undefined) {
  return readings?.find((reading) => reading.deviceId === "rtu-1") ?? null;
}

export function RuntimeShell({
  initial,
  initialBrainAlerts,
  initialBrainPolicies,
  websocketUrl,
  onReturnToPortfolio,
}: RuntimeShellProps) {
  const drawerDockOffset = "calc(1.5rem + min(23rem, calc(100vw - 1.5rem)) + 0.75rem)";
  const [runtime, setRuntime] = useState<RuntimeState>({
    twin: initial.latestTwinSnapshot,
    sandbox: initial.latestSandboxBatch,
    controls: initial.controls,
    manualControls: initial.manualControls,
    controlResolution: initial.controlResolution,
    persistenceSummary: initial.persistenceSummary,
  });
  const [draftControls, setDraftControls] = useState<RuntimeControlState>(initial.manualControls);
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "offline">("connecting");
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(
    initial.latestTwinSnapshot?.summary.worstZoneId ?? initial.blueprint.spaces[0]?.id ?? null,
  );
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [brainAlerts, setBrainAlerts] = useState<BrainAlert[]>(initialBrainAlerts ?? []);
  const [brainPolicies, setBrainPolicies] = useState<OperatorPolicy[]>(initialBrainPolicies ?? []);
  const [isPending, startUiTransition] = useTransition();
  const [isLeftDrawerOpen, setIsLeftDrawerOpen] = useState(false);
  const [isRightDrawerOpen, setIsRightDrawerOpen] = useState(false);
  const [inspectView, setInspectView] = useState<"overview" | "zone" | "device">("overview");
  const deferredRuntime = useDeferredValue(runtime);
  const heartbeatRef = useRef<number | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const rightDrawerRef = useRef<HTMLElement | null>(null);

  const selectedSpace = useMemo(
    () => initial.blueprint.spaces.find((space) => space.id === selectedZoneId) ?? null,
    [initial.blueprint.spaces, selectedZoneId],
  );

  const selectedZone = useMemo(
    () => deferredRuntime.twin?.zones.find((zone) => zone.zoneId === selectedZoneId) ?? null,
    [deferredRuntime.twin?.zones, selectedZoneId],
  );

  const deviceById = useMemo(() => new Map(initial.blueprint.devices.map((device) => [device.id, device])), [initial.blueprint.devices]);
  const productById = useMemo(() => new Map(initial.products.map((product) => [product.id, product])), [initial.products]);
  const diagnosisByDeviceId = useMemo(
    () => new Map((deferredRuntime.twin?.devices ?? []).map((device) => [device.deviceId, device])),
    [deferredRuntime.twin?.devices],
  );
  const telemetryByDeviceId = useMemo(
    () => new Map((deferredRuntime.sandbox?.deviceReadings ?? []).map((reading) => [reading.deviceId, reading])),
    [deferredRuntime.sandbox?.deviceReadings],
  );

  const selectedZoneDevices = useMemo(() => {
    if (!selectedZoneId || !deferredRuntime.twin) {
      return [];
    }

    const relatedDevices = initial.blueprint.devices.filter((device) => device.served_space_ids.includes(selectedZoneId));
    return deferredRuntime.twin.devices.filter((device) => relatedDevices.some((related) => related.id === device.deviceId));
  }, [deferredRuntime.twin, initial.blueprint.devices, selectedZoneId]);

  const selectedZoneAlertDevices = useMemo(
    () => selectedZoneDevices.filter((device) => device.alerts.length > 0 || device.healthScore < 92),
    [selectedZoneDevices],
  );

  const selectedDevice = useMemo(
    () => (selectedDeviceId ? deviceById.get(selectedDeviceId) ?? null : null),
    [deviceById, selectedDeviceId],
  );

  const selectedDeviceProduct = useMemo(
    () => (selectedDevice ? productById.get(selectedDevice.product_id) ?? null : null),
    [productById, selectedDevice],
  );

  const selectedDeviceDiagnosis = useMemo(
    () => (selectedDevice ? diagnosisByDeviceId.get(selectedDevice.id) ?? null : null),
    [diagnosisByDeviceId, selectedDevice],
  );

  const selectedTelemetryReading = useMemo(
    () => (selectedDevice ? telemetryByDeviceId.get(selectedDevice.id) ?? null : null),
    [selectedDevice, telemetryByDeviceId],
  );

  const selectedDeviceSpaces = useMemo(
    () =>
      selectedDevice
        ? initial.blueprint.spaces.filter((space) => selectedDevice.served_space_ids.includes(space.id))
        : [],
    [initial.blueprint.spaces, selectedDevice],
  );

  const selectedDeviceTechnicalSpecs = useMemo(
    () => (selectedDeviceProduct ? extractTechnicalSpecs(selectedDeviceProduct) : []),
    [selectedDeviceProduct],
  );

  const selectedDeviceTelemetryHighlights = useMemo(
    () => getTelemetryHighlights(selectedTelemetryReading),
    [selectedTelemetryReading],
  );

  const inspectOverviewSpaces = useMemo(
    () =>
      initial.blueprint.spaces.map((space) => ({
        space,
        zone: deferredRuntime.twin?.zones.find((zone) => zone.zoneId === space.id) ?? null,
      })),
    [deferredRuntime.twin?.zones, initial.blueprint.spaces],
  );

  const inspectOverviewDevices = useMemo(() => {
    return initial.blueprint.devices
      .map((device) => ({
        device,
        product: productById.get(device.product_id) ?? null,
        diagnosis: diagnosisByDeviceId.get(device.id) ?? null,
      }))
      .filter(
        (
          entry,
        ): entry is {
          device: DeviceDefinition;
          product: ProductDefinition;
          diagnosis: DeviceDiagnosis | null;
        } => entry.product !== null,
      )
      .sort((left, right) => {
        const kindOrder = (kind: string) => (kind === "actuator" ? 0 : kind === "sensor" ? 1 : 2);
        return (
          kindOrder(left.device.kind) - kindOrder(right.device.kind) ||
          left.device.id.localeCompare(right.device.id)
        );
      });
  }, [diagnosisByDeviceId, initial.blueprint.devices, productById]);

  const visibleBrainPolicies = useMemo(() => brainPolicies.slice(0, 5), [brainPolicies]);
  const activeControlPolicies = useMemo(
    () => runtime.controlResolution.activePolicies,
    [runtime.controlResolution.activePolicies],
  );

  const sourceReading = getSourceReading(deferredRuntime.sandbox?.deviceReadings);
  const sourceTelemetry = sourceReading?.telemetry ?? {};
  const activeFaults = deferredRuntime.sandbox?.operationalState.activeFaults ?? [];
  const runtimeHours = ((deferredRuntime.sandbox?.operationalState.runtimeSeconds ?? 0) / 3600).toFixed(2);
  const persistenceSummary = deferredRuntime.persistenceSummary;
  const totalAirflow = deferredRuntime.sandbox?.truth.supplyAirflowM3H ?? 0;
  const sourcePower = Number(sourceTelemetry.electrical_power_kw ?? 0);

  function handleZoneSelection(zoneId: string) {
    setSelectedZoneId(zoneId);
    setSelectedDeviceId(null);
    setInspectView("zone");
    setIsRightDrawerOpen(true);
  }

  function handleDeviceSelection(deviceId: string) {
    const device = deviceById.get(deviceId) ?? null;
    const servedZoneId = device?.served_space_ids[0] ?? null;

    if (servedZoneId) {
      setSelectedZoneId(servedZoneId);
    }

    setSelectedDeviceId(deviceId);
    setInspectView("device");
    setIsRightDrawerOpen(true);
  }

  function handleInspectDrawerToggle() {
    setIsRightDrawerOpen((current) => {
      const next = !current;

      if (next) {
        setInspectView("overview");
      }

      return next;
    });
  }

  const handleSocketMessage = useEffectEvent((message: RuntimeSocketMessage) => {
    if (message.type === "hello") {
      startTransition(() => {
        setDraftControls(message.payload.manualControls);
        setRuntime({
          twin: message.payload.latestTwinSnapshot,
          sandbox: message.payload.latestSandboxBatch,
          controls: message.payload.controls,
          manualControls: message.payload.manualControls,
          controlResolution: message.payload.controlResolution,
          persistenceSummary: message.payload.persistenceSummary,
        });
      });
      setConnectionState("live");
      return;
    }

    if (message.type === "tick") {
      startTransition(() => {
        setDraftControls(message.payload.manualControls);
        setRuntime({
          twin: message.payload.twin,
          sandbox: message.payload.sandbox,
          controls: message.payload.controls,
          manualControls: message.payload.manualControls,
          controlResolution: message.payload.controlResolution,
          persistenceSummary: message.payload.persistenceSummary,
        });
      });
      setConnectionState("live");
      return;
    }

    if (message.type === "ack") {
      startTransition(() => {
        setDraftControls(message.payload.manualControls);
        setRuntime((current) => ({
          ...current,
          controls: message.payload.controls,
          manualControls: message.payload.manualControls,
          controlResolution: message.payload.controlResolution,
        }));
      });
      setControlError(null);
      return;
    }

    if (message.type === "brain_alert") {
      setBrainAlerts((prev) => [...prev.slice(-19), message.payload]);
      return;
    }

    setControlError(message.payload.message);
  });

  useEffect(() => {
    if (!isRightDrawerOpen) {
      return;
    }

    rightDrawerRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [inspectView, isRightDrawerOpen, selectedDeviceId, selectedZoneId]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let disposed = false;

    const clearHeartbeat = () => {
      if (heartbeatRef.current) {
        window.clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };

    const clearReconnect = () => {
      if (reconnectRef.current) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed) {
        return;
      }

      clearReconnect();
      clearHeartbeat();
      setConnectionState("connecting");
      const delay = Math.min(10000, 1000 * 2 ** Math.min(reconnectAttemptsRef.current, 3));
      reconnectAttemptsRef.current += 1;
      reconnectRef.current = window.setTimeout(() => {
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      socket = new WebSocket(websocketUrl);
      let disconnectHandled = false;

      socket.addEventListener("open", () => {
        reconnectAttemptsRef.current = 0;
        clearReconnect();
        clearHeartbeat();
        setConnectionState("live");
        heartbeatRef.current = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send("ping");
          }
        }, 20000);
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string" || event.data === "ping" || event.data === "pong") {
          return;
        }

        try {
          handleSocketMessage(JSON.parse(event.data) as RuntimeSocketMessage);
        } catch {
          // Ignore non-JSON frames and keep the live connection open.
        }
      });

      const handleDisconnect = () => {
        if (disconnectHandled || disposed) {
          return;
        }

        disconnectHandled = true;
        setConnectionState("offline");
        scheduleReconnect();
      };

      socket.addEventListener("close", handleDisconnect);
      socket.addEventListener("error", handleDisconnect);
    };

    connect();

    return () => {
      disposed = true;
      clearReconnect();
      clearHeartbeat();
      socket?.close();
    };
  }, [websocketUrl]);

  const submitControls = async (next: Partial<RuntimeControlState>) => {
    startUiTransition(async () => {
      setControlError(null);

      try {
        const response = await fetch("/api/runtime/control", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            actor: "frontend-control-center",
            ...next,
          }),
        });

        const payload = (await response.json()) as {
          ok: boolean;
          controls?: RuntimeControlState;
          manualControls?: RuntimeControlState;
          controlResolution?: RuntimeState["controlResolution"];
          message?: string;
        };

        if (!response.ok || !payload.ok || !payload.controls || !payload.manualControls || !payload.controlResolution) {
          setControlError(payload.message ?? "Control update failed.");
          return;
        }

        setRuntime((current) => ({
          ...current,
          controls: payload.controls ?? current.controls,
          manualControls: payload.manualControls ?? current.manualControls,
          controlResolution: payload.controlResolution ?? current.controlResolution,
        }));
        setDraftControls(payload.manualControls);
      } catch (error) {
        setControlError(error instanceof Error ? error.message : "Unexpected control error.");
      }
    });
  };

  const commitZoneOffset = (zoneId: string) => {
    const draftValue = draftControls.zoneTemperatureOffsetsC[zoneId] ?? 0;
    const currentValue = runtime.manualControls.zoneTemperatureOffsetsC[zoneId] ?? 0;

    if (draftValue === currentValue) {
      return;
    }

    void submitControls({
      zoneTemperatureOffsetsC: {
        [zoneId]: draftValue,
      },
    });
  };

  const commitOccupancyBias = () => {
    if (draftControls.occupancyBias === runtime.manualControls.occupancyBias) {
      return;
    }

    void submitControls({
      occupancyBias: draftControls.occupancyBias,
    });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsLeftDrawerOpen(false);
        setIsRightDrawerOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscrollBehavior = document.body.style.overscrollBehavior;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlOverscrollBehavior = document.documentElement.style.overscrollBehavior;

    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscrollBehavior;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscrollBehavior;
    };
  }, []);

  return (
  <>
    <main className="relative min-h-screen overflow-hidden px-4 py-4 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1680px] flex-col gap-4">
        <section className="relative">
          <FloatingDrawerHandle
            side="left"
            isOpen={isLeftDrawerOpen}
            onClick={() => setIsLeftDrawerOpen((current) => !current)}
            label="Controls"
          />
          <FloatingDrawerHandle
            side="right"
            isOpen={isRightDrawerOpen}
            onClick={handleInspectDrawerToggle}
            label="Inspect"
          />
          <DrawerDockHandle side="left" isOpen={isLeftDrawerOpen} onClick={() => setIsLeftDrawerOpen(false)} />
          <DrawerDockHandle side="right" isOpen={isRightDrawerOpen} onClick={() => setIsRightDrawerOpen(false)} />

          <aside
            className={`glass-panel fixed inset-y-4 left-4 z-30 flex w-[min(23rem,calc(100vw-1.5rem))] flex-col gap-4 overflow-x-visible overflow-y-auto p-4 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              isLeftDrawerOpen ? "translate-x-0 opacity-100" : "-translate-x-[calc(100%+1.5rem)] opacity-0 pointer-events-none"
            } [&::-webkit-scrollbar]:hidden`}
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
            aria-hidden={!isLeftDrawerOpen}
          >
            <CardBlock>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <BrandLockup />
                  <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-slate-950">
                    {initial.blueprint.building.name}
                  </h1>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Live facility cockpit for {initial.blueprint.building.name}, anchored to the Belimo twin pipeline.
                  </p>
                </div>
                <StatusDot state={connectionState} />
              </div>
              <div className="mt-4">
                <div className="flex items-center justify-between">
                  <SectionEyebrow label="Live Link" />
                  <span
                    className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                      connectionState === "live"
                        ? "bg-emerald-500/15 text-emerald-700"
                        : connectionState === "connecting"
                          ? "bg-amber-500/15 text-amber-700"
                          : "bg-rose-500/15 text-rose-700"
                    }`}
                  >
                    {connectionState}
                  </span>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <DetailPill
                    label="Outdoor"
                    value={`${deferredRuntime.twin?.weather.temperatureC.toFixed(1) ?? "--"}°C`}
                  />
                  <DetailPill
                    label="Supply Air"
                    value={`${deferredRuntime.twin?.summary.supplyTemperatureC.toFixed(1) ?? "--"}°C`}
                  />
                  <DetailPill label="Worst Zone" value={deferredRuntime.twin?.summary.worstZoneId ?? "--"} />
                  <DetailPill label="Alerts" value={`${deferredRuntime.twin?.summary.activeAlertCount ?? 0}`} />
                  <DetailPill label="Sandbox Faults" value={`${activeFaults.length}`} />
                  <DetailPill
                    label="Static Pressure"
                    value={`${deferredRuntime.twin?.derived.staticPressurePa.toFixed(0) ?? "--"} Pa`}
                  />
                  <DetailPill label="History Frames" value={`${persistenceSummary.runtimeFrames}`} />
                  <DetailPill label="Zone Samples" value={`${persistenceSummary.zoneTwinSamples}`} />
                </div>
                <p className="mt-4 text-sm leading-6 text-slate-600">
                  Raw telemetry, twin-derived zone states, device diagnoses and per-tick control context are persisted
                  for future Belimo Brain analysis. Last archived frame:{" "}
                  {persistenceSummary.lastPersistedObservedAt
                    ? new Date(persistenceSummary.lastPersistedObservedAt).toLocaleString("en-CH", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })
                    : "not yet"}
                  .
                </p>
                {controlError ? (
                  <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                    {controlError}
                  </p>
                ) : null}
              </div>
            </CardBlock>

            <CardBlock>
              <SectionEyebrow label="Facility Controls" />
              <div className="mt-4 flex flex-wrap gap-2">
                {modeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => void submitControls({ sourceModePreference: option.value })}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                      runtime.manualControls.sourceModePreference === option.value
                        ? "bg-[#d9691f] text-white shadow-[0_10px_30px_rgba(217,105,31,0.35)]"
                        : "bg-slate-200/70 text-slate-700 hover:bg-slate-300/80"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {runtime.controls.sourceModePreference !== runtime.manualControls.sourceModePreference ? (
                <p className="mt-3 rounded-2xl border border-[#d9691f]/15 bg-[#d9691f]/8 px-3 py-2 text-sm text-[#8f4313]">
                  Belimo Brain is currently applying <span className="font-medium">{formatModeLabel(runtime.controls.sourceModePreference)}</span>{" "}
                  instead of the stored manual preference because an active policy is in force.
                </p>
              ) : null}

            </CardBlock>

            <CardBlock>
              <SectionEyebrow label="Selected Zone Tuning" />
              <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-slate-950">
                {selectedSpace?.name ?? "No selection"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Keep room-level tuning focused on the zone you are actively inspecting in the 3D twin.
              </p>
              {selectedSpace ? (
                <div className="mt-4">
                  <label className="flex items-center justify-between text-sm font-medium text-slate-700">
                    <span>Temperature offset</span>
                    <span className="font-mono text-slate-500">
                      {(draftControls.zoneTemperatureOffsetsC[selectedSpace.id] ?? 0).toFixed(1)}°C
                    </span>
                  </label>
                  <input
                    type="range"
                    min="-3"
                    max="3"
                    step="0.1"
                    value={draftControls.zoneTemperatureOffsetsC[selectedSpace.id] ?? 0}
                    onChange={(event) =>
                      setDraftControls((current) => ({
                        ...current,
                        zoneTemperatureOffsetsC: {
                          ...current.zoneTemperatureOffsetsC,
                          [selectedSpace.id]: Number(event.target.value),
                        },
                      }))
                    }
                    onPointerUp={() => commitZoneOffset(selectedSpace.id)}
                    onTouchEnd={() => commitZoneOffset(selectedSpace.id)}
                    onBlur={() => commitZoneOffset(selectedSpace.id)}
                    onKeyUp={(event) => {
                      if (event.key === "Enter" || event.key.startsWith("Arrow")) {
                        commitZoneOffset(selectedSpace.id);
                      }
                    }}
                    className="mt-3 w-full accent-[#d9691f]"
                  />
                  {runtime.controls.zoneTemperatureOffsetsC[selectedSpace.id] !==
                  runtime.manualControls.zoneTemperatureOffsetsC[selectedSpace.id] ? (
                    <p className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-400">
                      Applied now {(runtime.controls.zoneTemperatureOffsetsC[selectedSpace.id] ?? 0).toFixed(1)}°C from Belimo Brain schedule
                    </p>
                  ) : null}
                </div>
              ) : null}
            </CardBlock>

            <details className="group rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-slate-800">
                <span>Advanced sandbox controls</span>
                <span className="rounded-full bg-slate-900 px-2 py-1 text-[11px] font-medium text-white transition group-open:rotate-180">
                  +
                </span>
              </summary>

              <div className="mt-5 space-y-5">
                <div>
                  <SectionEyebrow label="All Zone Offsets" />
                  <div className="mt-3 space-y-4">
                    {initial.blueprint.spaces.map((space) => (
                      <div key={space.id}>
                        <label className="flex items-center justify-between text-sm font-medium text-slate-700">
                          <span>{space.name}</span>
                          <span className="font-mono text-slate-500">
                            {(draftControls.zoneTemperatureOffsetsC[space.id] ?? 0).toFixed(1)}°C
                          </span>
                        </label>
                        <input
                          type="range"
                          min="-3"
                          max="3"
                          step="0.1"
                          value={draftControls.zoneTemperatureOffsetsC[space.id] ?? 0}
                          onChange={(event) =>
                            setDraftControls((current) => ({
                              ...current,
                              zoneTemperatureOffsetsC: {
                                ...current.zoneTemperatureOffsetsC,
                                [space.id]: Number(event.target.value),
                              },
                            }))
                          }
                          onPointerUp={() => commitZoneOffset(space.id)}
                          onTouchEnd={() => commitZoneOffset(space.id)}
                          onBlur={() => commitZoneOffset(space.id)}
                          onKeyUp={(event) => {
                            if (event.key === "Enter" || event.key.startsWith("Arrow")) {
                              commitZoneOffset(space.id);
                            }
                          }}
                          className="mt-2 w-full accent-[#d9691f]"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <SectionEyebrow label="Fault Lab" />
                    <span className="rounded-full bg-slate-950 px-2 py-1 text-[11px] font-medium text-white">Demo</span>
                  </div>
                  <div className="mt-3 space-y-3">
                    {initial.availableFaults.map((fault) => {
                      const activeMode = runtime.controls.faultOverrides[fault.id] ?? "auto";

                      return (
                        <div key={fault.id} className="rounded-2xl border border-slate-200/70 bg-white/75 p-3">
                          <p className="text-sm font-medium text-slate-900">{fault.faultType.replaceAll("_", " ")}</p>
                          <p className="mt-1 text-xs text-slate-500">{fault.deviceId}</p>
                          <div className="mt-3 flex gap-2">
                            {(["auto", "forced_on", "forced_off"] as FaultOverrideMode[]).map((mode) => (
                              <button
                                key={mode}
                                type="button"
                                onClick={() =>
                                  void submitControls({
                                    faultOverrides: {
                                      [fault.id]: mode,
                                    },
                                  })
                                }
                                className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                                  activeMode === mode ? "bg-slate-950 text-white" : "bg-slate-200/70 text-slate-700"
                                }`}
                              >
                                {mode === "auto" ? "Auto" : mode === "forced_on" ? "On" : "Off"}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </details>

            <CardBlock>
              <SectionEyebrow label="Real Building" />
              <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-slate-950">Connect Real Network</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                The live backend is already split the right way: same twin contract, same control path, different data
                source. The real-building path just needs device networking and a blueprint upload in this schema.
              </p>
              <button
                type="button"
                className="mt-5 rounded-full border border-slate-300 bg-slate-100 px-5 py-3 text-sm font-medium text-slate-500"
              >
                Upload Blueprint + Connect Devices
              </button>
            </CardBlock>

            <CardBlock>
              <SectionEyebrow label="Belimo Brain Control Plan" />
              <div className="mt-4 space-y-3">
                {activeControlPolicies.length === 0 ? (
                  <div className="rounded-2xl border border-slate-200/70 bg-white/75 px-4 py-3 text-sm text-slate-600">
                    No scheduled or policy-driven control overrides are active right now. The runtime is following the
                    stored manual control layer.
                  </div>
                ) : (
                  activeControlPolicies.map((policy) => (
                    <ActivePolicyCard key={policy.id} initial={initial} policy={policy} />
                  ))
                )}
              </div>
            </CardBlock>

            <CardBlock>
              <SectionEyebrow label="Belimo Brain Memory" />
              <div className="mt-4 space-y-3">
                {visibleBrainPolicies.length === 0 ? (
                  <div className="rounded-2xl border border-slate-200/70 bg-white/75 px-4 py-3 text-sm text-slate-600">
                    No persistent operator policies stored yet. Ask Belimo Brain to remember schedules, comfort targets,
                    or energy preferences.
                  </div>
                ) : (
                  visibleBrainPolicies.map((policy) => (
                    <div key={policy.id} className="rounded-2xl border border-slate-200/70 bg-white/75 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-slate-900">{policy.summary}</p>
                        <span
                          className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                            policy.importance === "requirement"
                              ? "bg-[#d9691f]/15 text-[#a24710]"
                              : "bg-slate-900/8 text-slate-700"
                          }`}
                        >
                          {policy.importance === "requirement" ? "Required" : "Preference"}
                        </span>
                      </div>
                      <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                        {formatPolicyScopeLabel(policy, initial)} • {formatModeLabel(policy.policyType)}
                      </p>
                      <p className="mt-2 text-sm text-slate-600">{formatPolicyScheduleLabel(policy)}</p>
                    </div>
                  ))
                )}
              </div>
            </CardBlock>

            <details className="mt-auto group rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 marker:content-none [&::-webkit-details-marker]:hidden">
                <span className="text-sm font-medium text-slate-800">Sandbox settings</span>
                <span className="rounded-full bg-slate-950 px-2 py-1 text-[11px] font-medium text-white transition group-open:rotate-180">
                  +
                </span>
              </summary>

              <div className="mt-5">
                <label className="flex items-center justify-between text-sm font-medium text-slate-700">
                  Occupancy bias
                  <span className="font-mono text-slate-500">{draftControls.occupancyBias.toFixed(2)}x</span>
                </label>
                <input
                  type="range"
                  min="0.4"
                  max="1.6"
                  step="0.05"
                  value={draftControls.occupancyBias}
                  onChange={(event) =>
                    setDraftControls((current) => ({
                      ...current,
                      occupancyBias: Number(event.target.value),
                    }))
                  }
                  onPointerUp={commitOccupancyBias}
                  onTouchEnd={commitOccupancyBias}
                  onBlur={commitOccupancyBias}
                  onKeyUp={(event) => {
                    if (event.key === "Enter" || event.key.startsWith("Arrow")) {
                      commitOccupancyBias();
                    }
                  }}
                  className="mt-3 w-full accent-[#d9691f]"
                />
                {runtime.controls.occupancyBias !== runtime.manualControls.occupancyBias ? (
                  <p className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-400">
                    Applied now {runtime.controls.occupancyBias.toFixed(2)}x from Belimo Brain policy resolution
                  </p>
                ) : null}
              </div>
            </details>
          </aside>

          <section
            className="flex flex-col gap-6"
          >
            <div className="-mx-4 -mt-4 sm:-mx-6 lg:-mx-8">
              <RuntimeScene
                blueprint={initial.blueprint}
                products={initial.products}
                twin={deferredRuntime.twin}
                sandbox={deferredRuntime.sandbox}
                leftDrawerOpen={isLeftDrawerOpen}
                rightDrawerOpen={isRightDrawerOpen}
                selectedZoneId={selectedZoneId}
                worstZoneId={deferredRuntime.twin?.summary.worstZoneId ?? null}
                onSelectZone={handleZoneSelection}
                onSelectDevice={handleDeviceSelection}
                totalAirflowM3H={totalAirflow}
                sourcePowerKw={sourcePower}
                onReturnToPortfolio={onReturnToPortfolio}
              />
            </div>

          </section>

          <aside
            ref={rightDrawerRef}
            className={`glass-panel fixed inset-y-4 right-4 z-30 flex w-[min(23rem,calc(100vw-1.5rem))] flex-col gap-4 overflow-x-visible overflow-y-auto p-4 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              isRightDrawerOpen ? "translate-x-0 opacity-100" : "translate-x-[calc(100%+1.5rem)] opacity-0 pointer-events-none"
            } [&::-webkit-scrollbar]:hidden`}
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
            aria-hidden={!isRightDrawerOpen}
          >
            {inspectView === "device" && selectedDevice && selectedDeviceProduct ? (
              <>
                <CardBlock>
                  <div className="flex items-center justify-between gap-3">
                    <SectionEyebrow label="Selected Component" />
                    <button
                      type="button"
                      onClick={() => setInspectView("overview")}
                      className="rounded-full border border-slate-200/80 bg-white/80 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
                    >
                      Browse all
                    </button>
                  </div>
                  <div className="mt-3 flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-2xl font-semibold tracking-[-0.03em] text-slate-950">{selectedDevice.id}</h2>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {selectedDeviceProduct.brand} {getDeviceDisplayName(selectedDeviceProduct)}
                      </p>
                    </div>
                    <span className="rounded-full bg-[#d9691f]/12 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.22em] text-[#b94f12]">
                      {formatDeviceKind(selectedDevice.kind)}
                    </span>
                  </div>

                  <div className="mt-4">
                    <ProductModelPreview
                      product={selectedDeviceProduct}
                      device={selectedDevice}
                      telemetry={selectedTelemetryReading?.telemetry ?? null}
                    />
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <DetailPill label="Placement" value={formatLabel(selectedDevice.placement)} />
                    <DetailPill
                      label="Serves"
                      value={selectedDeviceSpaces.map((space) => space.name).join(" / ") || "Building-wide"}
                    />
                    <DetailPill
                      label="Health"
                      value={selectedDeviceDiagnosis ? `${selectedDeviceDiagnosis.healthScore}%` : "--"}
                    />
                    <DetailPill
                      label="Observed"
                      value={
                        selectedTelemetryReading
                          ? new Date(selectedTelemetryReading.observedAt).toLocaleTimeString("en-CH", {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })
                          : "--"
                      }
                    />
                  </div>
                </CardBlock>

                <CardBlock>
                  <div className="flex items-center justify-between gap-3">
                    <SectionEyebrow label="Component Details" />
                    <span
                      className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                        selectedDeviceDiagnosis?.alerts.length
                          ? "bg-rose-500/15 text-rose-700"
                          : "bg-emerald-500/15 text-emerald-700"
                      }`}
                    >
                      {selectedDeviceDiagnosis?.alerts.length ? `${selectedDeviceDiagnosis.alerts.length} alerts` : "Nominal"}
                    </span>
                  </div>

                  {selectedDeviceDiagnosis?.alerts.length ? (
                    <div className="mt-4 space-y-3">
                      {selectedDeviceDiagnosis.alerts.slice(0, 3).map((alert) => (
                        <div key={alert} className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                          {alert}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                      No active diagnostics are escalating for this component.
                    </div>
                  )}

                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    {selectedDeviceTelemetryHighlights.length > 0 ? (
                      selectedDeviceTelemetryHighlights.map((item) => (
                        <DetailPill key={item.label} label={item.label} value={item.value} />
                      ))
                    ) : (
                      <div className="rounded-2xl border border-slate-200/70 bg-white/75 px-4 py-3 text-sm text-slate-500 sm:col-span-2">
                        No live telemetry is currently available for this component.
                      </div>
                    )}
                  </div>

                  {selectedDeviceTechnicalSpecs.length > 0 ? (
                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      {selectedDeviceTechnicalSpecs.map((spec) => (
                        <DetailPill key={spec.label} label={spec.label} value={spec.value} />
                      ))}
                    </div>
                  ) : null}
                </CardBlock>
              </>
            ) : inspectView === "zone" && selectedZone && selectedSpace ? (
              <>
                <CardBlock>
                  <div className="flex items-center justify-between gap-3">
                    <SectionEyebrow label="Selected Zone" />
                    <button
                      type="button"
                      onClick={() => setInspectView("overview")}
                      className="rounded-full border border-slate-200/80 bg-white/80 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
                    >
                      Browse all
                    </button>
                  </div>
                  <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-slate-950">{selectedSpace.name}</h2>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <DetailPill label="Temperature" value={`${selectedZone.temperatureC.toFixed(1)}°C`} />
                    <DetailPill label="Humidity" value={`${selectedZone.relativeHumidityPct.toFixed(0)}%`} />
                    <DetailPill label="CO₂" value={`${selectedZone.co2Ppm.toFixed(0)} ppm`} />
                    <DetailPill label="Airflow" value={`${selectedZone.supplyAirflowM3H.toFixed(0)} m³/h`} />
                    <DetailPill label="Occupancy" value={`${selectedZone.occupancyCount}`} />
                    <DetailPill label="Comfort" value={`${selectedZone.comfortScore.toFixed(0)}%`} />
                  </div>
                  <p className="mt-4 text-sm leading-6 text-slate-600">
                    Target comfort band {selectedSpace.comfort_targets.occupied_temperature_band_c[0].toFixed(1)} to{" "}
                    {selectedSpace.comfort_targets.occupied_temperature_band_c[1].toFixed(1)}°C, CO₂ ceiling{" "}
                    {selectedSpace.comfort_targets.co2_limit_ppm.toFixed(0)} ppm.
                  </p>
                </CardBlock>

                <CardBlock>
                  <SectionEyebrow label="Diagnostics" />
                  <div className="mt-4 space-y-3">
                    {selectedZoneAlertDevices.length === 0 ? (
                      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                        Selected zone is nominal. No actuator or sensor in the zone is raising a twin alert.
                      </div>
                    ) : (
                      selectedZoneAlertDevices.map((device) => (
                        <button
                          key={device.deviceId}
                          type="button"
                          onClick={() => handleDeviceSelection(device.deviceId)}
                          className="w-full rounded-2xl border border-slate-200/70 bg-white/75 p-3 text-left transition hover:border-slate-300 hover:bg-white"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-medium text-slate-900">{device.deviceId}</p>
                            <span className="rounded-full bg-slate-950 px-2 py-1 text-[11px] font-medium text-white">
                              {device.healthScore}%
                            </span>
                          </div>
                          <p className="mt-2 text-sm text-slate-600">{device.alerts[0] ?? "Degraded but not alarming."}</p>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="mt-5 grid gap-2">
                    {selectedZoneDevices.map((device) => (
                      <button
                        key={`${device.deviceId}-asset`}
                        type="button"
                        onClick={() => handleDeviceSelection(device.deviceId)}
                        className="flex items-center justify-between rounded-2xl bg-slate-100/70 px-3 py-2 text-left transition hover:bg-slate-100"
                      >
                        <p className="text-sm text-slate-700">{device.deviceId}</p>
                        <span className="text-xs font-medium text-slate-500">{device.productId}</span>
                      </button>
                    ))}
                  </div>
                </CardBlock>
              </>
            ) : (
              <>
                <CardBlock>
                  <SectionEyebrow label="Inspect Menu" />
                  <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-slate-950">Browse the building</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Select a room to inspect comfort conditions or jump directly into any installed component.
                  </p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <DetailPill label="Air Flow" value={`${totalAirflow.toFixed(0)} m³/h`} />
                    <DetailPill label="Energy Draw" value={`${sourcePower.toFixed(1)} kW`} />
                  </div>
                </CardBlock>

                <details className="group rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 marker:content-none [&::-webkit-details-marker]:hidden">
                    <span className="text-sm font-medium text-slate-800">Areas</span>
                    <span className="rounded-full bg-slate-950 px-2 py-1 text-[11px] font-medium text-white transition group-open:rotate-180">
                      +
                    </span>
                  </summary>

                  <div className="mt-4 grid gap-3">
                    {inspectOverviewSpaces.map(({ space, zone }) => (
                      <button
                        key={space.id}
                        type="button"
                        onClick={() => handleZoneSelection(space.id)}
                        className="rounded-[1.35rem] border border-slate-200/80 bg-white/78 p-4 text-left transition hover:border-slate-300 hover:bg-white"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-slate-500">
                              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100/90 text-slate-700">
                                <AreaLineupIcon />
                              </span>
                              <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-500">
                                {space.name}
                              </p>
                            </div>
                          </div>
                          <span
                            className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                              (zone?.comfortScore ?? 0) >= 92
                                ? "bg-emerald-500/15 text-emerald-700"
                                : (zone?.comfortScore ?? 0) >= 78
                                  ? "bg-amber-500/15 text-amber-700"
                                  : "bg-rose-500/15 text-rose-700"
                            }`}
                          >
                            {zone ? `${zone.comfortScore.toFixed(0)}% comfort` : "No data"}
                          </span>
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-2">
                          <MiniInspectPill label="Temp" value={zone ? `${zone.temperatureC.toFixed(1)}°C` : "--"} />
                          <MiniInspectPill label="Airflow" value={zone ? `${zone.supplyAirflowM3H.toFixed(0)} m³/h` : "--"} />
                        </div>
                      </button>
                    ))}
                  </div>
                </details>

                <details className="group rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 marker:content-none [&::-webkit-details-marker]:hidden">
                    <span className="text-sm font-medium text-slate-800">Electronic Components</span>
                    <span className="rounded-full bg-slate-950 px-2 py-1 text-[11px] font-medium text-white transition group-open:rotate-180">
                      +
                    </span>
                  </summary>

                  <div className="mt-4 grid gap-3">
                    {inspectOverviewDevices.map(({ device, product, diagnosis }) => (
                      <button
                        key={device.id}
                        type="button"
                        onClick={() => handleDeviceSelection(device.id)}
                        className="rounded-[1.35rem] border border-slate-200/80 bg-white/78 p-4 text-left transition hover:border-slate-300 hover:bg-white"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2 text-slate-500">
                              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100/90 text-slate-700">
                                <ProductLineupIcon kind={device.kind} />
                              </span>
                              <p className="text-[11px] font-medium uppercase tracking-[0.22em]">
                                {formatDeviceKind(device.kind)}
                              </p>
                            </div>
                            <p className="mt-3 text-lg font-semibold tracking-[-0.03em] text-slate-950">
                              {product.brand} {getDeviceDisplayName(product)}
                            </p>
                          </div>
                          <span
                            className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                              diagnosis?.alerts.length
                                ? "bg-rose-500/15 text-rose-700"
                                : diagnosis
                                  ? "bg-emerald-500/15 text-emerald-700"
                                  : "bg-slate-200/70 text-slate-600"
                            }`}
                          >
                            {diagnosis?.alerts.length ? "Alert" : diagnosis ? `Health ${diagnosis.healthScore}%` : "Health --"}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </details>
              </>
            )}

            <CardBlock className="hidden">
              <div className="flex items-center justify-between">
                <SectionEyebrow label="Live Link" />
                <span
                  className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                    connectionState === "live"
                      ? "bg-emerald-500/15 text-emerald-700"
                      : connectionState === "connecting"
                        ? "bg-amber-500/15 text-amber-700"
                        : "bg-rose-500/15 text-rose-700"
                  }`}
                >
                  {connectionState}
                </span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <DetailPill
                  label="Outdoor"
                  value={`${deferredRuntime.twin?.weather.temperatureC.toFixed(1) ?? "--"}°C`}
                />
                <DetailPill
                  label="Supply Air"
                  value={`${deferredRuntime.twin?.summary.supplyTemperatureC.toFixed(1) ?? "--"}°C`}
                />
                <DetailPill label="Worst Zone" value={deferredRuntime.twin?.summary.worstZoneId ?? "--"} />
                <DetailPill label="Alerts" value={`${deferredRuntime.twin?.summary.activeAlertCount ?? 0}`} />
                <DetailPill label="Sandbox Faults" value={`${activeFaults.length}`} />
                <DetailPill
                  label="Static Pressure"
                  value={`${deferredRuntime.twin?.derived.staticPressurePa.toFixed(0) ?? "--"} Pa`}
                />
                <DetailPill label="History Frames" value={`${persistenceSummary.runtimeFrames}`} />
                <DetailPill label="Zone Samples" value={`${persistenceSummary.zoneTwinSamples}`} />
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-600">
                Raw telemetry, twin-derived zone states, device diagnoses and per-tick control context are persisted for
                future Belimo Brain analysis. Last archived frame:{" "}
                {persistenceSummary.lastPersistedObservedAt
                  ? new Date(persistenceSummary.lastPersistedObservedAt).toLocaleString("en-CH", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })
                  : "not yet"}
                .
              </p>
              {controlError ? (
                <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {controlError}
                </p>
              ) : null}
              {isPending ? <p className="mt-4 text-sm text-slate-500">Applying controls…</p> : null}
            </CardBlock>
          </aside>
        </section>
      </div>
    </main>
    <ChatPanel
      alerts={brainAlerts}
      rightOffset={isRightDrawerOpen ? drawerDockOffset : "1.5rem"}
      onDismissAlert={(alertId) => {
        setBrainAlerts((prev) => prev.filter((a) => a.id !== alertId));
        fetch(`/api/brain/alerts/${alertId}/dismiss`, { method: "POST" }).catch(() => {});
      }}
      onPoliciesSync={(policies) => {
        setBrainPolicies(policies);
      }}
    />
  </>
  );
}

function CardBlock({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-[1.6rem] border border-white/55 bg-white/65 p-4 ${className}`.trim()}>{children}</div>;
}

function SectionEyebrow({ label }: { label: string }) {
  return <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">{label}</p>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function DrawerToggle({
  side,
  isOpen,
  onClick,
  label,
}: {
  side: "left" | "right";
  isOpen: boolean;
  onClick: () => void;
  label: string;
}) {
  const sideClass = side === "left" ? "left-4" : "right-4";
  const arrow = side === "left" ? (isOpen ? "←" : "→") : isOpen ? "→" : "←";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={isOpen}
      aria-label={`${isOpen ? "Close" : "Open"} ${label}`}
      className={`glass-panel fixed ${sideClass} top-1/2 z-40 flex -translate-y-1/2 items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-white/85`}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/80 text-base text-slate-900">
        {arrow}
      </span>
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

function ActivePolicyCard({
  initial,
  policy,
}: {
  initial: RuntimeBootstrapPayload;
  policy: ActiveControlPolicy;
}) {
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white/75 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-900">{policy.summary}</p>
        <span
          className={`rounded-full px-2 py-1 text-[11px] font-medium ${
            policy.importance === "requirement" ? "bg-[#d9691f]/15 text-[#a24710]" : "bg-slate-900/8 text-slate-700"
          }`}
        >
          {policy.importance === "requirement" ? "Required" : "Preference"}
        </span>
      </div>
      <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">
        {policy.scopeType === "zone" && policy.scopeId
          ? initial.blueprint.spaces.find((space) => space.id === policy.scopeId)?.name ?? policy.scopeId
          : initial.blueprint.building.name}{" "}
        • {formatModeLabel(policy.policyType)}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {policy.appliedControlPaths.map((path) => (
          <span
            key={`${policy.id}-${path}`}
            className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-600"
          >
            {formatAppliedControlPath(path, initial)}
          </span>
        ))}
      </div>
      <p className="mt-3 text-sm text-slate-600">
        {policy.schedule
          ? `${policy.schedule.daysOfWeek
              .map((day) => day.charAt(0).toUpperCase() + day.slice(1))
              .join(", ")} ${policy.schedule.startLocalTime}-${policy.schedule.endLocalTime}`
          : "Always active"}
      </p>
    </div>
  );
}

function FloatingDrawerHandle({
  side,
  isOpen,
  onClick,
  label,
}: {
  side: "left" | "right";
  isOpen: boolean;
  onClick: () => void;
  label: string;
}) {
  const sideClass = side === "left" ? "left-4" : "right-4";
  const hoverWidthClass = side === "left" ? "hover:w-[9.5rem]" : "hover:w-[8.8rem]";
  const alignmentClass = "justify-center";
  const labelClass = side === "left" ? "right-4 text-right" : "left-4 text-left";
  const absorptionClass = side === "left" ? "-translate-x-5" : "translate-x-5";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={false}
      aria-label={`Open ${label}`}
      className={`group fixed ${sideClass} top-1/2 z-40 flex h-[4.3rem] w-[3.25rem] -translate-y-1/2 items-center overflow-hidden rounded-full border border-white/70 bg-white/82 text-sm font-medium text-slate-700 shadow-[0_20px_50px_rgba(15,23,42,0.16)] backdrop-blur transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${alignmentClass} ${hoverWidthClass} ${
        isOpen ? `pointer-events-none opacity-0 ${absorptionClass} scale-95` : "opacity-100"
      }`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center text-slate-900 transition-opacity duration-300 group-hover:opacity-0">
        <DrawerArrow side={side} direction="open" />
      </span>
      <span
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-700 opacity-0 transition-all duration-300 group-hover:opacity-100 ${labelClass}`}
      >
        {label}
      </span>
    </button>
  );
}

function DrawerDockHandle({
  side,
  isOpen,
  onClick,
}: {
  side: "left" | "right";
  isOpen: boolean;
  onClick: () => void;
}) {
  const positionStyle =
    side === "left"
      ? { left: "calc(1rem + min(23rem, calc(100vw - 1.5rem)) - 0.08rem)" }
      : { right: "calc(1rem + min(23rem, calc(100vw - 1.5rem)) - 0.08rem)" };
  const halfShapeClass =
    side === "left"
      ? "rounded-r-full rounded-l-none border-l-0 pl-1.5 pr-2"
      : "rounded-l-full rounded-r-none border-r-0 pl-2 pr-1.5";
  const motionClass =
    side === "left"
      ? isOpen
        ? "translate-x-0 opacity-100"
        : "-translate-x-[calc(min(23rem,calc(100vw-1.5rem))+1.5rem)] opacity-0"
      : isOpen
        ? "translate-x-0 opacity-100"
        : "translate-x-[calc(min(23rem,calc(100vw-1.5rem))+1.5rem)] opacity-0";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={isOpen}
      aria-label="Close panel"
      className={`fixed top-1/2 z-40 flex h-[4.3rem] w-[1.9rem] -translate-y-1/2 items-center justify-center border border-white/75 bg-white/90 text-slate-900 shadow-[0_18px_40px_rgba(15,23,42,0.16)] backdrop-blur transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform ${halfShapeClass} ${motionClass} ${
        isOpen ? "pointer-events-auto" : "pointer-events-none"
      }`}
      style={positionStyle}
    >
      <span className="flex h-7 w-7 items-center justify-center">
        <DrawerArrow side={side} direction="close" />
      </span>
    </button>
  );
}

function DrawerArrow({
  side,
  direction,
}: {
  side: "left" | "right";
  direction: "open" | "close";
}) {
  const pointingLeft = (side === "left" && direction === "close") || (side === "right" && direction === "open");

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4">
      <path
        d={pointingLeft ? "M11.75 4.5 6.25 10l5.5 5.5" : "M8.25 4.5 13.75 10l-5.5 5.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StatusDot({ state }: { state: "connecting" | "live" | "offline" }) {
  return (
    <span
      className={`mt-1 h-3.5 w-3.5 rounded-full ${
        state === "live"
          ? "bg-emerald-500 shadow-[0_0_14px_rgba(34,197,94,0.75)]"
          : state === "connecting"
            ? "bg-amber-400"
            : "bg-rose-500"
      }`}
    />
  );
}

function DetailPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1.15rem] border border-slate-200/70 bg-white/75 px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-slate-500">{label}</p>
      <p className="mt-2 text-base font-semibold text-slate-950">{value}</p>
    </div>
  );
}

function MiniInspectPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1rem] border border-slate-200/70 bg-slate-50/90 px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-1.5 text-sm font-semibold text-slate-950">{value}</p>
    </div>
  );
}
