"use client";

import dynamic from "next/dynamic";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useTransition,
} from "react";

import {
  FacilityModePreference,
  FaultOverrideMode,
  RuntimeBootstrapPayload,
  RuntimeControlState,
  RuntimeSocketMessage,
  ZoneTwinState,
} from "@/lib/runtime-types";

const RuntimeScene = dynamic(
  () => import("@/components/runtime-scene").then((module) => module.RuntimeScene),
  { ssr: false },
);

type RuntimeShellProps = {
  initial: RuntimeBootstrapPayload;
  websocketUrl: string;
};

type RuntimeState = {
  twin: RuntimeBootstrapPayload["latestTwinSnapshot"];
  sandbox: RuntimeBootstrapPayload["latestSandboxBatch"];
  controls: RuntimeControlState;
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

export function RuntimeShell({ initial, websocketUrl }: RuntimeShellProps) {
  const [runtime, setRuntime] = useState<RuntimeState>({
    twin: initial.latestTwinSnapshot,
    sandbox: initial.latestSandboxBatch,
    controls: initial.controls,
  });
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "offline">("connecting");
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(
    initial.latestTwinSnapshot?.summary.worstZoneId ?? initial.blueprint.spaces[0]?.id ?? null,
  );
  const [controlError, setControlError] = useState<string | null>(null);
  const [isPending, startUiTransition] = useTransition();
  const deferredRuntime = useDeferredValue(runtime);

  const selectedZone = useMemo(
    () => deferredRuntime.twin?.zones.find((zone) => zone.zoneId === selectedZoneId) ?? null,
    [deferredRuntime.twin?.zones, selectedZoneId],
  );

  const selectedZoneAlerts = useMemo(() => {
    if (!selectedZoneId || !deferredRuntime.twin) {
      return [];
    }

    const relatedDevices = initial.blueprint.devices.filter((device) => device.served_space_ids.includes(selectedZoneId));
    return deferredRuntime.twin.devices.filter((device) => relatedDevices.some((related) => related.id === device.deviceId));
  }, [deferredRuntime.twin, initial.blueprint.devices, selectedZoneId]);

  const handleSocketMessage = useEffectEvent((message: RuntimeSocketMessage) => {
    if (message.type === "hello") {
      startTransition(() => {
        setRuntime({
          twin: message.payload.latestTwinSnapshot,
          sandbox: message.payload.latestSandboxBatch,
          controls: message.payload.controls,
        });
      });
      setConnectionState("live");
      return;
    }

    if (message.type === "tick") {
      startTransition(() => {
        setRuntime({
          twin: message.payload.twin,
          sandbox: message.payload.sandbox,
          controls: message.payload.controls,
        });
      });
      setConnectionState("live");
      return;
    }

    if (message.type === "ack") {
      startTransition(() => {
        setRuntime((current) => ({
          ...current,
          controls: message.payload.controls,
        }));
      });
      return;
    }

    setConnectionState("offline");
    setControlError(message.payload.message);
  });

  useEffect(() => {
    const socket = new WebSocket(websocketUrl);
    let heartbeat: number | null = null;

    socket.addEventListener("open", () => {
      setConnectionState("live");
      heartbeat = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send("ping");
        }
      }, 20000);
    });

    socket.addEventListener("message", (event) => {
      try {
        handleSocketMessage(JSON.parse(event.data) as RuntimeSocketMessage);
      } catch {
        setConnectionState("offline");
      }
    });

    socket.addEventListener("close", () => {
      setConnectionState("offline");
      if (heartbeat) {
        window.clearInterval(heartbeat);
      }
    });

    socket.addEventListener("error", () => {
      setConnectionState("offline");
      if (heartbeat) {
        window.clearInterval(heartbeat);
      }
    });

    return () => {
      if (heartbeat) {
        window.clearInterval(heartbeat);
      }
      socket.close();
    };
  }, [handleSocketMessage, websocketUrl]);

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
      } catch (error) {
        setControlError(error instanceof Error ? error.message : "Unexpected control error.");
      }
    });
  };

  const totalAirflow = deferredRuntime.sandbox?.truth.supplyAirflowM3H ?? 0;
  const sourcePower = Number(
    deferredRuntime.sandbox?.deviceReadings.find((reading) => reading.deviceId === "rtu-1")?.telemetry.electrical_power_kw ?? 0,
  );
  const activeAlerts = deferredRuntime.twin?.summary.activeAlertCount ?? 0;
  const comfort = deferredRuntime.twin?.summary.averageComfortScore ?? 0;
  const runtimeHours = ((deferredRuntime.sandbox?.operationalState.runtimeSeconds ?? 0) / 3600).toFixed(2);

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-4 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1680px] flex-col gap-4">
        <section className="grid gap-4 xl:grid-cols-[0.24fr_1fr_0.28fr]">
          <aside className="glass-panel flex flex-col gap-4 p-4">
            <div className="rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
              <p className="text-[13px] font-medium uppercase tracking-[0.34em] text-[#d9691f]">
                Belimo Pulse
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-slate-950">
                Sandbox Twin
              </h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Live concept environment for the St. Gallen office sandbox.
              </p>
            </div>

            <div className="rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">
                Facility Controls
              </p>
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
                  <span className="font-mono text-slate-500">{runtime.controls.occupancyBias.toFixed(2)}x</span>
                </label>
                <input
                  type="range"
                  min="0.4"
                  max="1.6"
                  step="0.05"
                  value={runtime.controls.occupancyBias}
                  onChange={(event) =>
                    void submitControls({
                      occupancyBias: Number(event.target.value),
                    })
                  }
                  className="mt-3 w-full accent-[#d9691f]"
                />
              </div>
            </div>

            <div className="rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">
                Zone Offsets
              </p>
              <div className="mt-4 space-y-4">
                {initial.blueprint.spaces.map((space) => (
                  <div key={space.id}>
                    <label className="flex items-center justify-between text-sm font-medium text-slate-700">
                      <span>{space.name}</span>
                      <span className="font-mono text-slate-500">
                        {runtime.controls.zoneTemperatureOffsetsC[space.id]?.toFixed(1) ?? "0.0"}°C
                      </span>
                    </label>
                    <input
                      type="range"
                      min="-3"
                      max="3"
                      step="0.1"
                      value={runtime.controls.zoneTemperatureOffsetsC[space.id] ?? 0}
                      onChange={(event) =>
                        void submitControls({
                          zoneTemperatureOffsetsC: {
                            [space.id]: Number(event.target.value),
                          },
                        })
                      }
                      className="mt-2 w-full accent-[#d9691f]"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">
                  Sandbox Faults
                </p>
                <span className="rounded-full bg-slate-900 px-2 py-1 text-[11px] font-medium text-white">
                  Demo
                </span>
              </div>
              <div className="mt-4 space-y-3">
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
                              activeMode === mode
                                ? "bg-slate-950 text-white"
                                : "bg-slate-200/70 text-slate-700"
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
          </aside>

          <section className="glass-panel flex flex-col p-4">
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

            <div className="mt-4">
              <RuntimeScene
                blueprint={initial.blueprint}
                twin={deferredRuntime.twin}
                sandbox={deferredRuntime.sandbox}
                selectedZoneId={selectedZoneId}
                onSelectZone={setSelectedZoneId}
              />
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_0.8fr]">
              <div className="rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">
                    Live Analysis
                  </p>
                  <p className="font-mono text-xs text-slate-500">
                    Runtime {runtimeHours} h
                  </p>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <AnalysisBar
                    label="Comfort"
                    value={comfort}
                    max={100}
                    tone="#16a34a"
                  />
                  <AnalysisBar
                    label="Ventilation"
                    value={deferredRuntime.twin?.derived.ventilationEffectivenessPct ?? 0}
                    max={100}
                    tone="#0ea5e9"
                  />
                  <AnalysisBar
                    label="Static Pressure"
                    value={deferredRuntime.twin?.derived.staticPressurePa ?? 0}
                    max={500}
                    tone="#d9691f"
                  />
                </div>
                <p className="mt-5 max-w-3xl text-sm leading-7 text-slate-600">
                  The Belimo engine is running independently from the sandbox generator and reconstructs the building
                  state from telemetry, weather and the uploadable blueprint only. The dashboard is already shaped around
                  the future facility manager workflow.
                </p>
              </div>

              <div className="rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
                <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">
                  Real Building
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-slate-950">
                  Connect Real Network
                </h2>
                <p className="mt-3 text-sm leading-7 text-slate-600">
                  This section is intentionally present but not active yet. The production path will require network
                  connection to real devices and upload of the building blueprint in the same schema used by the sandbox.
                </p>
                <button
                  type="button"
                  className="mt-5 rounded-full border border-slate-300 bg-slate-100 px-5 py-3 text-sm font-medium text-slate-500"
                >
                  Upload Blueprint + Connect Devices
                </button>
              </div>
            </div>
          </section>

          <aside className="glass-panel flex flex-col gap-4 p-4">
            <div className="rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">
                Selected Zone
              </p>
              <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-slate-950">
                {selectedZoneId ? formatZoneLabel(selectedZoneId) : "No selection"}
              </h2>
              {selectedZone ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <DetailPill label="Temperature" value={`${selectedZone.temperatureC.toFixed(1)}°C`} />
                  <DetailPill label="Humidity" value={`${selectedZone.relativeHumidityPct.toFixed(0)}%`} />
                  <DetailPill label="CO₂" value={`${selectedZone.co2Ppm.toFixed(0)} ppm`} />
                  <DetailPill label="Airflow" value={`${selectedZone.supplyAirflowM3H.toFixed(0)} m³/h`} />
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-500">Select a room in the scene to inspect it.</p>
              )}
            </div>

            <div className="rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">
                Diagnostics
              </p>
              <div className="mt-4 space-y-3">
                {selectedZoneAlerts.length === 0 ? (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    Selected zone is nominal.
                  </div>
                ) : (
                  selectedZoneAlerts.map((device) => (
                    <div key={device.deviceId} className="rounded-2xl border border-slate-200/70 bg-white/75 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-slate-900">{device.deviceId}</p>
                        <span className="rounded-full bg-slate-950 px-2 py-1 text-[11px] font-medium text-white">
                          {device.healthScore}%
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-slate-600">
                        {device.alerts[0] ?? "No active diagnostic alert."}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-[1.6rem] border border-white/55 bg-white/65 p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">
                  Live Link
                </p>
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
                <DetailPill
                  label="Worst Zone"
                  value={deferredRuntime.twin?.summary.worstZoneId ?? "--"}
                />
                <DetailPill
                  label="Alerts"
                  value={`${deferredRuntime.twin?.summary.activeAlertCount ?? 0}`}
                />
              </div>
              {controlError ? (
                <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {controlError}
                </p>
              ) : null}
              {isPending ? (
                <p className="mt-4 text-sm text-slate-500">Applying controls…</p>
              ) : null}
            </div>
          </aside>
        </section>
      </div>
    </main>
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
        {status ? (
          <span
            className={`h-3.5 w-3.5 rounded-full ${
              status === "live" ? "bg-emerald-500 shadow-[0_0_14px_rgba(34,197,94,0.9)]" : status === "connecting" ? "bg-amber-400" : "bg-rose-500"
            }`}
          />
        ) : null}
      </div>
    </div>
  );
}

function AnalysisBar({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  tone: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));

  return (
    <div className="rounded-[1.3rem] border border-white/50 bg-white/75 p-4">
      <p className="text-sm font-medium text-slate-700">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">
        {value.toFixed(0)}
      </p>
      <div className="mt-4 h-24 overflow-hidden rounded-[1rem] bg-slate-900/90 p-3">
        <div className="flex h-full items-end gap-2">
          {Array.from({ length: 6 }, (_, index) => {
            const local = Math.max(18, Math.min(100, pct * (0.5 + index * 0.1)));
            return (
              <div
                key={`${label}-${index}`}
                className="w-full rounded-t-md"
                style={{
                  height: `${local}%`,
                  background: `linear-gradient(180deg, ${tone}, rgba(255,255,255,0.18))`,
                  boxShadow: `0 0 18px ${tone}55`,
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DetailPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1.15rem] border border-slate-200/70 bg-white/75 px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-base font-semibold text-slate-950">{value}</p>
    </div>
  );
}
