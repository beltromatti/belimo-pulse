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
  BrainAlert,
  DeviceDiagnosis,
  DeviceTelemetryRecord,
  FacilityModePreference,
  FaultOverrideMode,
  RuntimeBootstrapPayload,
  RuntimeControlState,
  RuntimeSocketMessage,
  ZoneTwinState,
} from "@/lib/runtime-types";
import { ChatPanel } from "@/components/chat-panel";
import { InventoryPanel } from "@/components/inventory-panel";

const RuntimeScene = dynamic(
  () => import("@/components/runtime-scene").then((module) => module.RuntimeScene),
  { ssr: false },
);

type RuntimeShellProps = {
  initial: RuntimeBootstrapPayload;
  initialBrainAlerts?: BrainAlert[];
  websocketUrl: string;
};

type RuntimeState = {
  twin: RuntimeBootstrapPayload["latestTwinSnapshot"];
  sandbox: RuntimeBootstrapPayload["latestSandboxBatch"];
  controls: RuntimeControlState;
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

function getSourceReading(readings: DeviceTelemetryRecord[] | undefined) {
  return readings?.find((reading) => reading.deviceId === "rtu-1") ?? null;
}

function getOperationalNarrative({
  sourceMode,
  supplyTemperatureC,
  mixedAirTemperatureC,
  outdoorAirFraction,
  worstZone,
  activeAlerts,
  activeFaults,
}: {
  sourceMode: string;
  supplyTemperatureC: number;
  mixedAirTemperatureC: number;
  outdoorAirFraction: number;
  worstZone: ZoneTwinState | null;
  activeAlerts: number;
  activeFaults: number;
}) {
  const statements = [
    `${formatModeLabel(sourceMode)} loop active. Mixed air ${mixedAirTemperatureC.toFixed(1)}°C, supply air ${supplyTemperatureC.toFixed(1)}°C, outdoor air fraction ${(outdoorAirFraction * 100).toFixed(0)}%.`,
  ];

  if (worstZone) {
    const zoneLabel = formatZoneLabel(worstZone.zoneId);
    const zoneState =
      worstZone.comfortScore >= 96
        ? `${zoneLabel} remains inside comfort band at ${worstZone.temperatureC.toFixed(1)}°C and ${worstZone.co2Ppm.toFixed(0)} ppm CO2.`
        : `${zoneLabel} is the limiting zone at comfort ${worstZone.comfortScore.toFixed(0)} with ${worstZone.co2Ppm.toFixed(0)} ppm CO2.`;
    statements.push(zoneState);
  }

  statements.push(
    activeAlerts > 0 || activeFaults > 0
      ? `${activeAlerts} twin alerts and ${activeFaults} active sandbox disturbances currently need attention.`
      : "No active diagnostics are escalating right now. The twin and sandbox stay aligned.",
  );

  return statements;
}

export function RuntimeShell({ initial, initialBrainAlerts, websocketUrl }: RuntimeShellProps) {
  const [runtime, setRuntime] = useState<RuntimeState>({
    twin: initial.latestTwinSnapshot,
    sandbox: initial.latestSandboxBatch,
    controls: initial.controls,
    persistenceSummary: initial.persistenceSummary,
  });
  const [draftControls, setDraftControls] = useState<RuntimeControlState>(initial.controls);
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "offline">("connecting");
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(
    initial.latestTwinSnapshot?.summary.worstZoneId ?? initial.blueprint.spaces[0]?.id ?? null,
  );
  const [controlError, setControlError] = useState<string | null>(null);
  const [brainAlerts, setBrainAlerts] = useState<BrainAlert[]>(initialBrainAlerts ?? []);
  const [isPending, startUiTransition] = useTransition();
  const [isLeftDrawerOpen, setIsLeftDrawerOpen] = useState(false);
  const [isRightDrawerOpen, setIsRightDrawerOpen] = useState(false);
  const deferredRuntime = useDeferredValue(runtime);
  const heartbeatRef = useRef<number | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const selectedSpace = useMemo(
    () => initial.blueprint.spaces.find((space) => space.id === selectedZoneId) ?? null,
    [initial.blueprint.spaces, selectedZoneId],
  );

  const selectedZone = useMemo(
    () => deferredRuntime.twin?.zones.find((zone) => zone.zoneId === selectedZoneId) ?? null,
    [deferredRuntime.twin?.zones, selectedZoneId],
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

  const watchlistDevices = useMemo(() => {
    const devices = [...(deferredRuntime.twin?.devices ?? [])];
    return devices
      .sort((left, right) => {
        if (left.healthScore !== right.healthScore) {
          return left.healthScore - right.healthScore;
        }

        return right.alerts.length - left.alerts.length;
      })
      .slice(0, 5);
  }, [deferredRuntime.twin?.devices]);

  const sourceReading = getSourceReading(deferredRuntime.sandbox?.deviceReadings);
  const sourceTelemetry = sourceReading?.telemetry ?? {};
  const activeAlerts = deferredRuntime.twin?.summary.activeAlertCount ?? 0;
  const activeFaults = deferredRuntime.sandbox?.operationalState.activeFaults ?? [];
  const comfort = deferredRuntime.twin?.summary.averageComfortScore ?? 0;
  const runtimeHours = ((deferredRuntime.sandbox?.operationalState.runtimeSeconds ?? 0) / 3600).toFixed(2);
  const persistenceSummary = deferredRuntime.persistenceSummary;
  const totalAirflow = deferredRuntime.sandbox?.truth.supplyAirflowM3H ?? 0;
  const sourcePower = Number(sourceTelemetry.electrical_power_kw ?? 0);
  const mixedAirTemperatureC = Number(
    sourceTelemetry.mixed_air_temperature_c ?? deferredRuntime.sandbox?.truth.mixedAirTemperatureC ?? 0,
  );
  const outdoorAirFraction = Number(
    sourceTelemetry.outdoor_air_fraction ?? deferredRuntime.sandbox?.truth.outdoorAirFraction ?? 0,
  );
  const sourceMode = String(sourceTelemetry.operating_mode ?? runtime.controls.sourceModePreference);
  const worstZone =
    deferredRuntime.twin?.zones.find((zone) => zone.zoneId === deferredRuntime.twin?.summary.worstZoneId) ?? null;
  const operationalNarrative = getOperationalNarrative({
    sourceMode,
    supplyTemperatureC: deferredRuntime.twin?.summary.supplyTemperatureC ?? 0,
    mixedAirTemperatureC,
    outdoorAirFraction,
    worstZone,
    activeAlerts,
    activeFaults: activeFaults.length,
  });

  const handleSocketMessage = useEffectEvent((message: RuntimeSocketMessage) => {
    if (message.type === "hello") {
      startTransition(() => {
        setDraftControls(message.payload.controls);
        setRuntime({
          twin: message.payload.latestTwinSnapshot,
          sandbox: message.payload.latestSandboxBatch,
          controls: message.payload.controls,
          persistenceSummary: message.payload.persistenceSummary,
        });
      });
      setConnectionState("live");
      return;
    }

    if (message.type === "tick") {
      startTransition(() => {
        setDraftControls(message.payload.controls);
        setRuntime({
          twin: message.payload.twin,
          sandbox: message.payload.sandbox,
          controls: message.payload.controls,
          persistenceSummary: message.payload.persistenceSummary,
        });
      });
      setConnectionState("live");
      return;
    }

    if (message.type === "ack") {
      startTransition(() => {
        setDraftControls(message.payload.controls);
        setRuntime((current) => ({
          ...current,
          controls: message.payload.controls,
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
          message?: string;
        };

        if (!response.ok || !payload.ok || !payload.controls) {
          setControlError(payload.message ?? "Control update failed.");
          return;
        }

        setRuntime((current) => ({
          ...current,
          controls: payload.controls ?? current.controls,
        }));
        setDraftControls(payload.controls);
      } catch (error) {
        setControlError(error instanceof Error ? error.message : "Unexpected control error.");
      }
    });
  };

  const commitZoneOffset = (zoneId: string) => {
    const draftValue = draftControls.zoneTemperatureOffsetsC[zoneId] ?? 0;
    const currentValue = runtime.controls.zoneTemperatureOffsetsC[zoneId] ?? 0;

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
    if (draftControls.occupancyBias === runtime.controls.occupancyBias) {
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

  return (
  <>
    <main className="relative min-h-screen overflow-hidden px-4 py-4 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1680px] flex-col gap-4">
        <section className="relative">
          <DrawerToggle
            side="left"
            isOpen={isLeftDrawerOpen}
            onClick={() => setIsLeftDrawerOpen((current) => !current)}
            label="Controls"
          />
          <DrawerToggle
            side="right"
            isOpen={isRightDrawerOpen}
            onClick={() => setIsRightDrawerOpen((current) => !current)}
            label="Inspect"
          />

          <aside
            className={`glass-panel fixed inset-y-4 left-4 z-30 flex w-[min(23rem,calc(100vw-1.5rem))] flex-col gap-4 overflow-y-auto p-4 transition-all duration-300 ${
              isLeftDrawerOpen ? "translate-x-0 opacity-100" : "-translate-x-[calc(100%+1.5rem)] opacity-0 pointer-events-none"
            }`}
            aria-hidden={!isLeftDrawerOpen}
          >
            <CardBlock>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[13px] font-medium uppercase tracking-[0.34em] text-[#d9691f]">Belimo Pulse</p>
                  <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-slate-950">Sandbox Twin</h1>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Live facility cockpit for the St. Gallen office sandbox, anchored to the Belimo twin pipeline.
                  </p>
                </div>
                <StatusDot state={connectionState} />
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <DetailPill
                  label="Weather"
                  value={`${deferredRuntime.twin?.weather.temperatureC.toFixed(1) ?? "--"}°C`}
                />
                <DetailPill label="Runtime" value={`${runtimeHours} h`} />
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
                      runtime.controls.sourceModePreference === option.value
                        ? "bg-[#d9691f] text-white shadow-[0_10px_30px_rgba(217,105,31,0.35)]"
                        : "bg-slate-200/70 text-slate-700 hover:bg-slate-300/80"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

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
              </div>
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
          </aside>

          <section
            className={`flex flex-col gap-4 transition-[margin] duration-300 ${
              isLeftDrawerOpen ? "xl:ml-[23rem]" : ""
            } ${isRightDrawerOpen ? "xl:mr-[23rem]" : ""}`}
          >
            <div className="grid gap-3 md:grid-cols-4">
              <MetricCard label="Unit" value={initial.blueprint.building.name} tone="dark" />
              <MetricCard label="Total Air Flow" value={`${totalAirflow.toFixed(0)} m³/h`} />
              <MetricCard label="Energy Draw" value={`${sourcePower.toFixed(1)} kW`} />
              <MetricCard
                label="System Status"
                value={activeAlerts === 0 ? "Nominal" : `${activeAlerts} Alerts`}
                status={connectionState}
              />
            </div>

            <div>
              <RuntimeScene
                blueprint={initial.blueprint}
                products={initial.products}
                twin={deferredRuntime.twin}
                sandbox={deferredRuntime.sandbox}
                selectedZoneId={selectedZoneId}
                worstZoneId={deferredRuntime.twin?.summary.worstZoneId ?? null}
                onSelectZone={setSelectedZoneId}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
              <CardBlock>
                <div className="flex items-center justify-between">
                  <SectionEyebrow label="Operational Story" />
                  <p className="font-mono text-xs text-slate-500">Runtime {runtimeHours} h</p>
                </div>
                <div className="mt-4 space-y-3">
                  {operationalNarrative.map((statement) => (
                    <div
                      key={statement}
                      className="rounded-2xl border border-white/55 bg-white/72 px-4 py-3 text-sm leading-6 text-slate-700"
                    >
                      {statement}
                    </div>
                  ))}
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  <InsightCard label="Comfort" value={`${comfort.toFixed(0)}%`} tone="emerald" />
                  <InsightCard label="Mixed Air" value={`${mixedAirTemperatureC.toFixed(1)}°C`} tone="sky" />
                  <InsightCard
                    label="Outdoor Air"
                    value={`${(outdoorAirFraction * 100).toFixed(0)}%`}
                    tone="amber"
                  />
                </div>
              </CardBlock>

              <CardBlock>
                <SectionEyebrow label="Device Watchlist" />
                <div className="mt-4 space-y-3">
                  {watchlistDevices.map((device) => (
                    <WatchlistRow key={device.deviceId} device={device} />
                  ))}
                </div>
              </CardBlock>
            </div>

            <InventoryPanel
              blueprint={initial.blueprint}
              products={initial.products}
              sandbox={deferredRuntime.sandbox}
            />
          </section>

          <aside
            className={`glass-panel fixed inset-y-4 right-4 z-30 flex w-[min(23rem,calc(100vw-1.5rem))] flex-col gap-4 overflow-y-auto p-4 transition-all duration-300 ${
              isRightDrawerOpen ? "translate-x-0 opacity-100" : "translate-x-[calc(100%+1.5rem)] opacity-0 pointer-events-none"
            }`}
            aria-hidden={!isRightDrawerOpen}
          >
            <CardBlock>
              <SectionEyebrow label="Selected Zone" />
              <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-slate-950">
                {selectedSpace?.name ?? "No selection"}
              </h2>
              {selectedZone ? (
                <>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <DetailPill label="Temperature" value={`${selectedZone.temperatureC.toFixed(1)}°C`} />
                    <DetailPill label="Humidity" value={`${selectedZone.relativeHumidityPct.toFixed(0)}%`} />
                    <DetailPill label="CO₂" value={`${selectedZone.co2Ppm.toFixed(0)} ppm`} />
                    <DetailPill label="Airflow" value={`${selectedZone.supplyAirflowM3H.toFixed(0)} m³/h`} />
                    <DetailPill label="Occupancy" value={`${selectedZone.occupancyCount}`} />
                    <DetailPill label="Comfort" value={`${selectedZone.comfortScore.toFixed(0)}%`} />
                  </div>
                  <p className="mt-4 text-sm leading-6 text-slate-600">
                    Target comfort band {selectedSpace?.comfort_targets.occupied_temperature_band_c[0].toFixed(1)} to{" "}
                    {selectedSpace?.comfort_targets.occupied_temperature_band_c[1].toFixed(1)}°C, CO₂ ceiling{" "}
                    {selectedSpace?.comfort_targets.co2_limit_ppm.toFixed(0)} ppm.
                  </p>
                </>
              ) : (
                <p className="mt-4 text-sm text-slate-500">Select a room in the scene to inspect it.</p>
              )}
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
                    <div key={device.deviceId} className="rounded-2xl border border-slate-200/70 bg-white/75 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-slate-900">{device.deviceId}</p>
                        <span className="rounded-full bg-slate-950 px-2 py-1 text-[11px] font-medium text-white">
                          {device.healthScore}%
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-slate-600">{device.alerts[0] ?? "Degraded but not alarming."}</p>
                    </div>
                  ))
                )}
              </div>
              <div className="mt-5 grid gap-2">
                {selectedZoneDevices.map((device) => (
                  <div key={`${device.deviceId}-asset`} className="flex items-center justify-between rounded-2xl bg-slate-100/70 px-3 py-2">
                    <p className="text-sm text-slate-700">{device.deviceId}</p>
                    <span className="text-xs font-medium text-slate-500">{device.productId}</span>
                  </div>
                ))}
              </div>
            </CardBlock>

            <CardBlock>
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
                future building-brain analysis. Last archived frame:{" "}
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
      onDismissAlert={(alertId) => {
        setBrainAlerts((prev) => prev.filter((a) => a.id !== alertId));
        fetch(`/api/brain/alerts/${alertId}/dismiss`, { method: "POST" }).catch(() => {});
      }}
    />
  </>
  );
}

function CardBlock({ children }: { children: React.ReactNode }) {
  return <div className="rounded-[1.6rem] border border-white/55 bg-white/65 p-4">{children}</div>;
}

function SectionEyebrow({ label }: { label: string }) {
  return <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">{label}</p>;
}

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

function MetricCard({
  label,
  value,
  tone = "light",
  status,
}: {
  label: string;
  value: string;
  tone?: "light" | "dark";
  status?: "connecting" | "live" | "offline";
}) {
  return (
    <div
      className={`rounded-[1.6rem] border px-4 py-4 ${
        tone === "dark"
          ? "border-slate-950/90 bg-slate-950 text-white"
          : "border-white/60 bg-white/72 text-slate-950"
      }`}
    >
      <p className={`text-xs font-medium uppercase tracking-[0.28em] ${tone === "dark" ? "text-white/55" : "text-slate-500"}`}>
        {label}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <p className="text-2xl font-semibold tracking-[-0.04em]">{value}</p>
        {status ? <StatusDot state={status} /> : null}
      </div>
    </div>
  );
}

function InsightCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "emerald" | "sky" | "amber";
}) {
  const toneClass =
    tone === "emerald"
      ? "from-emerald-500/30 to-emerald-100 text-emerald-800"
      : tone === "sky"
        ? "from-sky-500/30 to-sky-100 text-sky-800"
        : "from-amber-500/30 to-amber-100 text-amber-800";

  return (
    <div className={`rounded-[1.25rem] border border-white/55 bg-gradient-to-br p-4 ${toneClass}`}>
      <p className="text-[11px] font-medium uppercase tracking-[0.24em]">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-[-0.04em]">{value}</p>
    </div>
  );
}

function WatchlistRow({ device }: { device: DeviceDiagnosis }) {
  return (
    <div className="rounded-[1.2rem] border border-slate-200/70 bg-white/75 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-900">{device.deviceId}</p>
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-slate-500">{device.productId}</p>
        </div>
        <span
          className={`rounded-full px-2 py-1 text-[11px] font-medium ${
            device.healthScore >= 95
              ? "bg-emerald-500/15 text-emerald-700"
              : device.healthScore >= 85
                ? "bg-amber-500/15 text-amber-700"
                : "bg-rose-500/15 text-rose-700"
          }`}
        >
          {device.healthScore}%
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-600">{device.alerts[0] ?? "No active alert. Device is simply the weakest link right now."}</p>
    </div>
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
