"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import { RuntimeShell } from "@/components/runtime-shell";
import { BrainAlert, RuntimeBootstrapPayload } from "@/lib/runtime-types";

type BuildingGatewayProps = {
  initial: RuntimeBootstrapPayload;
  initialBrainAlerts?: BrainAlert[];
  websocketUrl: string;
};

type GatewayBuilding = {
  id: string;
  name: string;
  location: string;
  summary: string;
  statusLabel: string;
  statusTone: "healthy" | "warning";
  airFlowM3H: number;
  energyDrawKw: number;
  actionLabel: "Enter" | "Coming soon";
  available: boolean;
  variant: "courtyard" | "campus" | "tower";
};

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
      <path d="M14 3.5v8.8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
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

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6 text-slate-700">
      <path
        d={direction === "left" ? "M14.5 5 8 12l6.5 7" : "M9.5 5 16 12l-6.5 7"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BuildingIsometricPreview({
  variant,
  tone,
}: {
  variant: GatewayBuilding["variant"];
  tone: GatewayBuilding["statusTone"];
}) {
  const accent = tone === "healthy" ? "#d9691f" : "#d97706";
  const glow = tone === "healthy" ? "rgba(217,105,31,0.24)" : "rgba(217,119,6,0.22)";
  const roof = variant === "campus" ? "#f4efe8" : variant === "tower" ? "#eef2f7" : "#f8f4ec";
  const leftWall = variant === "campus" ? "#d8dde6" : variant === "tower" ? "#ccd4df" : "#d9e1ea";
  const rightWall = variant === "campus" ? "#c0c9d5" : variant === "tower" ? "#b5c0ce" : "#c4ceda";

  return (
    <div className="relative mx-auto w-full max-w-[34rem]">
      <div
        className="absolute inset-x-12 bottom-5 h-14 rounded-full blur-2xl"
        style={{ background: `radial-gradient(circle, ${glow} 0%, rgba(217,105,31,0) 72%)` }}
      />
      <svg viewBox="0 0 520 320" className="relative w-full drop-shadow-[0_32px_60px_rgba(15,23,42,0.18)]">
        <ellipse cx="260" cy="256" rx="170" ry="28" fill="rgba(148,163,184,0.24)" />
        {variant === "courtyard" ? (
          <>
            <polygon points="128,108 278,68 396,114 250,154" fill={roof} />
            <polygon points="128,108 128,208 250,246 250,154" fill={leftWall} />
            <polygon points="250,154 396,114 396,210 250,246" fill={rightWall} />
            <polygon points="188,126 262,106 322,127 248,147" fill="#dbe5ef" />
            <polygon points="188,126 188,180 248,199 248,147" fill="#a9b7c8" />
            <polygon points="248,147 322,127 322,181 248,199" fill="#91a2b7" />
            <rect x="172" y="156" width="18" height="26" rx="4" fill="#f8fbff" opacity="0.95" />
            <rect x="198" y="165" width="18" height="23" rx="4" fill="#f8fbff" opacity="0.9" />
            <rect x="289" y="154" width="18" height="26" rx="4" fill="#eaf3ff" opacity="0.95" />
            <rect x="317" y="147" width="18" height="26" rx="4" fill="#eaf3ff" opacity="0.88" />
          </>
        ) : variant === "campus" ? (
          <>
            <polygon points="104,132 238,94 334,124 199,162" fill={roof} />
            <polygon points="104,132 104,222 199,250 199,162" fill={leftWall} />
            <polygon points="199,162 334,124 334,216 199,250" fill={rightWall} />
            <polygon points="282,116 372,90 430,108 340,133" fill="#edf1f6" />
            <polygon points="282,116 282,188 340,207 340,133" fill="#c9d2de" />
            <polygon points="340,133 430,108 430,182 340,207" fill="#b6c2d1" />
            <rect x="130" y="174" width="16" height="22" rx="4" fill="#f8fbff" />
            <rect x="153" y="180" width="16" height="22" rx="4" fill="#f8fbff" />
            <rect x="309" y="144" width="16" height="22" rx="4" fill="#eef6ff" />
            <rect x="333" y="137" width="16" height="22" rx="4" fill="#eef6ff" />
            <rect x="357" y="130" width="16" height="22" rx="4" fill="#eef6ff" />
          </>
        ) : (
          <>
            <polygon points="188,70 294,42 368,66 262,94" fill={roof} />
            <polygon points="188,70 188,222 262,248 262,94" fill={leftWall} />
            <polygon points="262,94 368,66 368,220 262,248" fill={rightWall} />
            <polygon points="160,162 236,142 286,157 211,177" fill="#edf1f6" />
            <polygon points="160,162 160,224 211,239 211,177" fill="#ccd5df" />
            <polygon points="211,177 286,157 286,220 211,239" fill="#b7c3d0" />
            <rect x="218" y="100" width="14" height="24" rx="4" fill="#f8fbff" />
            <rect x="218" y="132" width="14" height="24" rx="4" fill="#f8fbff" />
            <rect x="218" y="164" width="14" height="24" rx="4" fill="#f8fbff" />
            <rect x="284" y="86" width="14" height="24" rx="4" fill="#eef6ff" />
            <rect x="284" y="118" width="14" height="24" rx="4" fill="#eef6ff" />
            <rect x="284" y="150" width="14" height="24" rx="4" fill="#eef6ff" />
          </>
        )}
        <path d="M108 248h304" stroke="rgba(148,163,184,0.4)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="412" cy="82" r="11" fill={accent} />
        <circle cx="412" cy="82" r="4.5" fill="white" />
      </svg>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[1.4rem] border border-white/60 bg-white/70 px-4 py-3 shadow-[0_14px_40px_rgba(15,23,42,0.08)]">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100/90">{icon}</div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-500">{label}</p>
          <p className="mt-1 text-lg font-semibold tracking-[-0.03em] text-slate-950">{value}</p>
        </div>
      </div>
    </div>
  );
}

export function BuildingGateway({ initial, initialBrainAlerts, websocketUrl }: BuildingGatewayProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hasEntered, setHasEntered] = useState(false);

  const buildings = useMemo<GatewayBuilding[]>(() => {
    const airFlow = initial.latestSandboxBatch?.truth.supplyAirflowM3H ?? 0;
    const sourcePower = Number(
      initial.latestSandboxBatch?.deviceReadings.find((reading) => reading.deviceId === "rtu-1")?.telemetry
        .electrical_power_kw ?? 0,
    );
    const activeAlerts = initial.latestTwinSnapshot?.summary.activeAlertCount ?? 0;

    return [
      {
        id: initial.buildingId,
        name: initial.blueprint.building.name,
        location: `${initial.blueprint.building.location.city}, ${initial.blueprint.building.location.country}`,
        summary:
          activeAlerts === 0
            ? "Sandbox twin aligned and ready for inspection."
            : `${activeAlerts} active alert${activeAlerts === 1 ? "" : "s"} currently detected by the building brain.`,
        statusLabel: activeAlerts === 0 ? "System healthy" : `${activeAlerts} alerts active`,
        statusTone: activeAlerts === 0 ? "healthy" : "warning",
        airFlowM3H: airFlow,
        energyDrawKw: sourcePower,
        actionLabel: "Enter",
        available: true,
        variant: "courtyard",
      },
      {
        id: "zurich-campus",
        name: "Zurich Campus West",
        location: "Zurich, Switzerland",
        summary: "Multi-wing office sandbox queued for onboarding into the same Belimo Pulse pipeline.",
        statusLabel: "Coming soon",
        statusTone: "healthy",
        airFlowM3H: 6840,
        energyDrawKw: 21.4,
        actionLabel: "Coming soon",
        available: false,
        variant: "campus",
      },
      {
        id: "basel-tower",
        name: "Basel Tower Annex",
        location: "Basel, Switzerland",
        summary: "High-rise commercial profile prepared for a future digital twin rollout and runtime validation.",
        statusLabel: "Coming soon",
        statusTone: "warning",
        airFlowM3H: 7920,
        energyDrawKw: 26.8,
        actionLabel: "Coming soon",
        available: false,
        variant: "tower",
      },
    ];
  }, [initial]);

  const activeBuilding = buildings[selectedIndex];

  if (hasEntered && activeBuilding.available) {
    return <RuntimeShell initial={initial} initialBrainAlerts={initialBrainAlerts} websocketUrl={websocketUrl} />;
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-[1480px] items-center justify-center">
        <section className="glass-panel relative w-full max-w-[1180px] overflow-hidden px-6 py-8 sm:px-8 lg:px-10">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-white/50 to-transparent" />
          <div className="relative flex items-center justify-between gap-4">
            <div>
              <p className="text-[12px] font-medium uppercase tracking-[0.32em] text-[#d9691f]">Belimo Pulse</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-4xl">
                Building Portfolio
              </h1>
            </div>
            <div className="rounded-full border border-white/60 bg-white/72 px-4 py-2 text-sm font-medium text-slate-600">
              {selectedIndex + 1} / {buildings.length}
            </div>
          </div>

          <div className="relative mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)] lg:items-center">
            <button
              type="button"
              onClick={() => setSelectedIndex((current) => (current - 1 + buildings.length) % buildings.length)}
              aria-label="Previous building"
              className="absolute left-0 top-[38%] z-10 flex h-12 w-12 -translate-x-2 items-center justify-center rounded-full border border-white/60 bg-white/80 shadow-[0_14px_36px_rgba(15,23,42,0.12)] transition hover:bg-white sm:-translate-x-4"
            >
              <Chevron direction="left" />
            </button>

            <div className="relative px-8 sm:px-14">
              <BuildingIsometricPreview variant={activeBuilding.variant} tone={activeBuilding.statusTone} />
              <button
                type="button"
                onClick={() => setSelectedIndex((current) => (current + 1) % buildings.length)}
                aria-label="Next building"
                className="absolute right-0 top-[38%] z-10 flex h-12 w-12 translate-x-2 items-center justify-center rounded-full border border-white/60 bg-white/80 shadow-[0_14px_36px_rgba(15,23,42,0.12)] transition hover:bg-white sm:translate-x-4"
              >
                <Chevron direction="right" />
              </button>
            </div>

            <div className="relative">
              <div className="inline-flex rounded-full border border-white/60 bg-white/72 px-4 py-2 text-sm font-medium text-slate-700">
                {activeBuilding.statusLabel}
              </div>
              <h2 className="mt-5 text-3xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-4xl">
                {activeBuilding.name}
              </h2>
              <p className="mt-2 text-sm uppercase tracking-[0.22em] text-slate-500">{activeBuilding.location}</p>
              <p className="mt-5 max-w-xl text-base leading-7 text-slate-600">{activeBuilding.summary}</p>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <Metric icon={<AirflowIcon />} label="Air Flow" value={`${activeBuilding.airFlowM3H.toFixed(0)} m3/h`} />
                <Metric icon={<PowerIcon />} label="Energy Draw" value={`${activeBuilding.energyDrawKw.toFixed(1)} kW`} />
              </div>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (activeBuilding.available) {
                      setHasEntered(true);
                    }
                  }}
                  disabled={!activeBuilding.available}
                  className={`rounded-full px-6 py-3 text-sm font-medium transition ${
                    activeBuilding.available
                      ? "bg-[#d9691f] text-white shadow-[0_16px_40px_rgba(217,105,31,0.3)] hover:bg-[#c95f1b]"
                      : "border border-slate-300 bg-slate-100 text-slate-500"
                  }`}
                >
                  {activeBuilding.actionLabel}
                </button>
                <p className="text-sm text-slate-500">
                  {activeBuilding.available
                    ? "Open the live sandbox twin for this building."
                    : "This building slot is reserved for the next rollout."}
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
