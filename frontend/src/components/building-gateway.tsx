"use client";

import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { BrandLockup } from "@/components/brand-lockup";
import { RuntimeShell } from "@/components/runtime-shell";
import { BrainAlert, OperatorPolicy, RuntimeBootstrapPayload } from "@/lib/runtime-types";

type BuildingGatewayProps = {
  initial: RuntimeBootstrapPayload;
  initialBrainAlerts?: BrainAlert[];
  initialBrainPolicies?: OperatorPolicy[];
  websocketUrl: string;
  initialSelectedBuildingId?: string;
  initialView?: "portfolio" | "dashboard";
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
  actionLabel: "Enter" | "Add building";
  actionKind: "enter_dashboard" | "gateway_error" | "open_modal";
  dashboardEnabled: boolean;
  variant: "courtyard" | "campus" | "tower" | "add";
};

type GatewayProtocolResponse = {
  ok: boolean;
  gateway: {
    gatewayId: string;
    displayName: string;
    transport: string;
    fieldProtocols: string[];
  };
  protocol: {
    protocolVersion: string;
    transport: string;
    purpose: string;
    fieldProtocolAbstraction: string[];
    uplinkMessages: string[];
    downlinkMessages: string[];
    requiredSnapshotShape: {
      weather: string[];
      deviceReadings: string[];
      controlState: string[];
    };
    technicianNotes: string[];
  };
};

type BlueprintValidationResponse = {
  ok: boolean;
  blueprint?: {
    blueprintId: string;
    name: string;
    sourceType: string;
    floorCount: number;
    spaceCount: number;
    deviceCount: number;
    airLoopCount: number;
  };
  message?: string;
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

function PlusGridIcon() {
  return (
    <svg viewBox="0 0 112 112" aria-hidden="true" className="w-full drop-shadow-[0_24px_48px_rgba(15,23,42,0.16)]">
      <rect x="18" y="20" width="76" height="72" rx="18" fill="#eff4f9" />
      <rect x="24" y="26" width="64" height="60" rx="14" fill="#ffffff" />
      <path d="M56 40v28M42 54h28" stroke="#d9691f" strokeWidth="7" strokeLinecap="round" />
      <path d="M30 74h52" stroke="#cbd5e1" strokeWidth="4" strokeLinecap="round" />
      <path d="M30 64h34" stroke="#dbe5ef" strokeWidth="4" strokeLinecap="round" />
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

  if (variant === "add") {
    return (
      <div className="relative mx-auto flex w-full max-w-[20rem] items-center justify-center">
        <div
          className="absolute inset-x-8 bottom-5 h-14 rounded-full blur-2xl"
          style={{ background: "radial-gradient(circle, rgba(217,105,31,0.2) 0%, rgba(217,105,31,0) 72%)" }}
        />
        <PlusGridIcon />
      </div>
    );
  }

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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-slate-200/80 bg-white/78 px-4 py-3">
      <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-500">{label}</span>
      <span className="text-sm font-medium text-slate-800">{value}</span>
    </div>
  );
}

function AddBuildingModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [gatewayId, setGatewayId] = useState("gateway-edge-01");
  const [gatewayEndpoint, setGatewayEndpoint] = useState("wss://gateway.example.com/belimo-pulse");
  const [gatewayToken, setGatewayToken] = useState("facility-token");
  const [selectedBlueprintName, setSelectedBlueprintName] = useState<string | null>(null);
  const [validation, setValidation] = useState<BlueprintValidationResponse["blueprint"] | null>(null);
  const [protocol, setProtocol] = useState<GatewayProtocolResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isLoadingProtocol, setIsLoadingProtocol] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [hasRequestedProtocol, setHasRequestedProtocol] = useState(false);

  useEffect(() => {
    if (!isOpen || protocol || isLoadingProtocol || hasRequestedProtocol) {
      return;
    }

    setHasRequestedProtocol(true);
    setIsLoadingProtocol(true);
    fetch("/api/gateway/protocol", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as GatewayProtocolResponse;
        if (!response.ok || !payload.ok) {
          throw new Error("Gateway protocol metadata is unavailable.");
        }
        setProtocol(payload);
      })
      .catch((protocolError) => {
        setError(protocolError instanceof Error ? protocolError.message : "Gateway protocol metadata is unavailable.");
      })
      .finally(() => {
        setIsLoadingProtocol(false);
      });
  }, [hasRequestedProtocol, isLoadingProtocol, isOpen, protocol]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setGatewayId("gateway-edge-01");
    setGatewayEndpoint("wss://gateway.example.com/belimo-pulse");
    setGatewayToken("facility-token");
    setSelectedBlueprintName(null);
    setValidation(null);
    setError(null);
    setStatusMessage(null);
    setIsValidating(false);
    setHasRequestedProtocol(false);
  }, [isOpen]);

  async function handleBlueprintUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setSelectedBlueprintName(file.name);
    setValidation(null);
    setStatusMessage(null);
    setError(null);
    setIsValidating(true);

    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText);
      const response = await fetch("/api/blueprints/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ blueprint: parsed }),
      });
      const payload = (await response.json()) as BlueprintValidationResponse;

      if (!response.ok || !payload.ok || !payload.blueprint) {
        throw new Error(payload.message ?? "Blueprint validation failed.");
      }

      setValidation(payload.blueprint);
      setStatusMessage(
        `Blueprint ${payload.blueprint.blueprintId} validated. The facility can now be bound to gateway ${gatewayId}.`,
      );
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Blueprint validation failed.");
    } finally {
      setIsValidating(false);
      event.target.value = "";
    }
  }

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/28 px-4 py-6 backdrop-blur-sm">
      <div className="glass-panel relative w-full max-w-[880px] overflow-hidden px-6 py-6 sm:px-8">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-5 top-5 rounded-full border border-white/70 bg-white/82 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-white"
        >
          Close
        </button>

        <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-500">Add Building</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-slate-950">Blueprint + Gateway Onboarding</h2>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
          Upload the facility blueprint, bind the onsite gateway, and verify the backend contract before connecting the
          building.
        </p>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(18rem,0.95fr)]">
          <div className="rounded-[1.6rem] border border-white/60 bg-white/72 p-5">
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-500">Facility Setup</p>

            <label className="mt-4 flex cursor-pointer flex-col items-start gap-3 rounded-[1.3rem] border border-dashed border-slate-300 bg-slate-50/80 px-4 py-5 text-sm text-slate-600 transition hover:border-[#d9691f] hover:bg-white">
                <span className="font-medium text-slate-900">Upload compatible `.json` blueprint</span>
                <span>Floors, spaces, devices and air loops must match the Belimo Pulse schema.</span>
                <input type="file" accept=".json,application/json" className="hidden" onChange={handleBlueprintUpload} />
                <span className="rounded-full bg-[#d9691f] px-4 py-2 text-sm font-medium text-white shadow-[0_14px_32px_rgba(217,105,31,0.26)]">
                  Select Blueprint
                </span>
            </label>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <DetailRow label="File" value={selectedBlueprintName ?? "No file selected"} />
              <DetailRow label="Validation" value={isValidating ? "Checking schema…" : validation ? "Compatible" : "Pending"} />
            </div>

            {validation ? (
              <div className="mt-4 rounded-[1.2rem] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {validation.name} is valid. {validation.spaceCount} spaces, {validation.deviceCount} devices, {validation.airLoopCount} air
                loop{validation.airLoopCount === 1 ? "" : "s"}.
              </div>
            ) : null}

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium text-slate-700">
                Gateway ID
                <input
                  value={gatewayId}
                  onChange={(event) => setGatewayId(event.target.value)}
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-[#d9691f]"
                />
              </label>
              <label className="text-sm font-medium text-slate-700">
                Backend Auth Token
                <input
                  value={gatewayToken}
                  onChange={(event) => setGatewayToken(event.target.value)}
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-[#d9691f]"
                />
              </label>
            </div>

            <label className="mt-3 block text-sm font-medium text-slate-700">
              Gateway Endpoint
              <input
                value={gatewayEndpoint}
                onChange={(event) => setGatewayEndpoint(event.target.value)}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-[#d9691f]"
              />
            </label>
          </div>

          <div className="rounded-[1.6rem] border border-white/60 bg-white/72 p-5">
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-500">Gateway Protocol</p>
            {protocol ? (
              <>
                <h3 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-slate-950">{protocol.protocol.protocolVersion}</h3>
                <p className="mt-3 text-sm leading-7 text-slate-600">{protocol.protocol.purpose}</p>

                <div className="mt-4 space-y-3">
                  <DetailRow label="Transport" value={protocol.protocol.transport} />
                  <DetailRow label="Gateway" value={protocol.gateway.displayName} />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {protocol.protocol.fieldProtocolAbstraction.map((item) => (
                    <span
                      key={item}
                      className="rounded-full border border-slate-200 bg-white/82 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-600"
                    >
                      {item}
                    </span>
                  ))}
                </div>

                <div className="mt-5 space-y-2 text-sm leading-6 text-slate-600">
                  <p>Map every field device to one product in `products.json`.</p>
                  <p>Normalize telemetry and writable points before sending them northbound.</p>
                  <p>Use the same contract for live buildings and the sandbox gateway.</p>
                </div>
              </>
            ) : (
              <p className="mt-4 text-sm text-slate-500">{isLoadingProtocol ? "Loading protocol…" : "Protocol metadata unavailable."}</p>
            )}
          </div>
        </div>

        {error ? (
          <p className="mt-5 rounded-[1.3rem] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
        ) : null}
        {statusMessage ? (
          <p className="mt-5 rounded-[1.3rem] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{statusMessage}</p>
        ) : null}
      </div>
    </div>
  );
}

function GatewayConnectionErrorModal({
  buildingName,
  isOpen,
  onClose,
}: {
  buildingName: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/28 px-4 py-6 backdrop-blur-sm">
      <div className="glass-panel relative w-full max-w-[520px] overflow-hidden px-6 py-6 sm:px-8">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-5 top-5 rounded-full border border-white/70 bg-white/82 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-white"
        >
          Close
        </button>

        <p className="text-xs font-medium uppercase tracking-[0.26em] text-slate-500">Gateway Error</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-slate-950">Impossible to connect to gateway</h2>
        <p className="mt-4 text-sm leading-7 text-slate-600">
          Belimo Pulse could not establish a session with the onsite gateway for {buildingName}. In this demo the
          building entry is shown as an active real facility, but the connection attempt is intentionally simulated as
          unavailable.
        </p>
        <div className="mt-5 rounded-[1.3rem] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Error: impossible to connect to the building gateway.
        </div>
      </div>
    </div>
  );
}

export function BuildingGateway({
  initial,
  initialBrainAlerts,
  initialBrainPolicies,
  websocketUrl,
  initialSelectedBuildingId,
  initialView = "portfolio",
}: BuildingGatewayProps) {
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
        location: "St. Gallen, Switzerland",
        summary:
          activeAlerts === 0
            ? "Building brain: comfort stable across all zones, no active anomalies detected."
            : `${activeAlerts} active alert${activeAlerts === 1 ? "" : "s"} currently detected by the building brain.`,
        statusLabel: activeAlerts === 0 ? "Sandbox live" : `${activeAlerts} alerts`,
        statusTone: activeAlerts === 0 ? "healthy" : "warning",
        airFlowM3H: airFlow,
        energyDrawKw: sourcePower,
        actionLabel: "Enter",
        actionKind: "enter_dashboard",
        dashboardEnabled: true,
        variant: "courtyard",
      },
      {
        id: "zurich-campus-west",
        name: "Zurich Campus West",
        location: "Zurich, Switzerland",
        summary: "No active alerts currently detected by the building brain.",
        statusLabel: "Operational",
        statusTone: "healthy",
        airFlowM3H: 6840,
        energyDrawKw: 21.4,
        actionLabel: "Enter",
        actionKind: "gateway_error",
        dashboardEnabled: false,
        variant: "campus",
      },
      {
        id: "basel-logistics-hub",
        name: "Basel Logistics Hub",
        location: "Basel, Switzerland",
        summary: "1 critical alert currently detected by the building brain.",
        statusLabel: "Critical alert",
        statusTone: "warning",
        airFlowM3H: 7920,
        energyDrawKw: 26.8,
        actionLabel: "Enter",
        actionKind: "gateway_error",
        dashboardEnabled: false,
        variant: "tower",
      },
      {
        id: "add-building",
        name: "Add Building",
        location: "Bring your own site",
        summary: "Upload a compatible blueprint, register the facility, and connect the onsite building gateway.",
        statusLabel: "Gateway onboarding",
        statusTone: "healthy",
        airFlowM3H: 0,
        energyDrawKw: 0,
        actionLabel: "Add building",
        actionKind: "open_modal",
        dashboardEnabled: false,
        variant: "add",
      },
    ];
  }, [initial]);

  const initialSelectedIndex = useMemo(() => {
    if (!initialSelectedBuildingId) {
      return 0;
    }

    const resolvedIndex = buildings.findIndex((building) => building.id === initialSelectedBuildingId);
    return resolvedIndex >= 0 ? resolvedIndex : 0;
  }, [buildings, initialSelectedBuildingId]);

  const initialHasEntered = useMemo(
    () =>
      initialView === "dashboard" &&
      buildings[initialSelectedIndex]?.actionKind === "enter_dashboard" &&
      buildings[initialSelectedIndex]?.dashboardEnabled === true,
    [buildings, initialSelectedIndex, initialView],
  );

  const [selectedIndex, setSelectedIndex] = useState(initialSelectedIndex);
  const [hasEntered, setHasEntered] = useState(initialHasEntered);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isGatewayErrorOpen, setIsGatewayErrorOpen] = useState(false);
  const activeBuilding = buildings[selectedIndex];

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("building", activeBuilding.id);

    if (hasEntered && activeBuilding.dashboardEnabled) {
      params.set("view", "dashboard");
    } else {
      params.delete("view");
    }

    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (nextUrl !== currentUrl) {
      window.history.replaceState(window.history.state, "", nextUrl);
    }
  }, [activeBuilding.dashboardEnabled, activeBuilding.id, hasEntered]);

  if (hasEntered && activeBuilding.dashboardEnabled) {
    return (
      <RuntimeShell
        initial={initial}
        initialBrainAlerts={initialBrainAlerts}
        initialBrainPolicies={initialBrainPolicies}
        websocketUrl={websocketUrl}
        onReturnToPortfolio={() => setHasEntered(false)}
      />
    );
  }

  return (
    <>
      <main className="relative min-h-screen overflow-hidden px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
        <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-[1480px] items-center justify-center">
          <section className="glass-panel relative w-full max-w-[1180px] overflow-hidden px-6 py-8 sm:px-8 lg:px-10">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-white/50 to-transparent" />
            <div className="relative flex items-center justify-between gap-4">
              <div>
                <BrandLockup />
                <h1 className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-slate-950 sm:text-4xl">
                  Building Menu
                </h1>
              </div>
              <div className="rounded-full border border-white/60 bg-white/72 px-4 py-2 text-sm font-medium text-slate-600">
                {selectedIndex + 1} / {buildings.length}
              </div>
            </div>

            <div className="relative mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)] lg:items-center">
              <button
                type="button"
                onClick={() => {
                  setIsGatewayErrorOpen(false);
                  setSelectedIndex((current) => (current - 1 + buildings.length) % buildings.length);
                }}
                aria-label="Previous building"
                className="absolute left-0 top-[38%] z-10 flex h-12 w-12 -translate-x-2 items-center justify-center rounded-full border border-white/60 bg-white/80 shadow-[0_14px_36px_rgba(15,23,42,0.12)] transition hover:bg-white sm:-translate-x-4"
              >
                <Chevron direction="left" />
              </button>

              <div className="relative px-8 sm:px-14">
                <BuildingIsometricPreview variant={activeBuilding.variant} tone={activeBuilding.statusTone} />
                <button
                  type="button"
                  onClick={() => {
                    setIsGatewayErrorOpen(false);
                    setSelectedIndex((current) => (current + 1) % buildings.length);
                  }}
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
                <p className="mt-2 text-sm uppercase tracking-[0.22em] text-slate-500">
                  {activeBuilding.location}
                </p>
                <p className="mt-5 max-w-xl text-base leading-7 text-slate-600">
                  {activeBuilding.summary}
                </p>

                {activeBuilding.variant === "add" ? (
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    <Metric icon={<AirflowIcon />} label="Blueprint" value="JSON Schema" />
                    <Metric icon={<PowerIcon />} label="Gateway" value="WSS / HTTPS" />
                  </div>
                ) : (
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    <Metric icon={<AirflowIcon />} label="Air Flow" value={`${activeBuilding.airFlowM3H.toFixed(0)} m3/h`} />
                    <Metric icon={<PowerIcon />} label="Energy Draw" value={`${activeBuilding.energyDrawKw.toFixed(1)} kW`} />
                  </div>
                )}

                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (activeBuilding.actionKind === "enter_dashboard" && activeBuilding.dashboardEnabled) {
                        setHasEntered(true);
                        return;
                      }

                      if (activeBuilding.actionKind === "open_modal") {
                        setIsGatewayErrorOpen(false);
                        setIsAddModalOpen(true);
                        return;
                      }

                      if (activeBuilding.actionKind === "gateway_error") {
                        setIsGatewayErrorOpen(true);
                      }
                    }}
                    className="rounded-full bg-[#d9691f] px-6 py-3 text-sm font-medium text-white shadow-[0_16px_40px_rgba(217,105,31,0.3)] transition hover:bg-[#c95f1b]"
                  >
                    {activeBuilding.actionLabel}
                  </button>
                  <p className="text-sm text-slate-500">
                    {activeBuilding.actionKind === "enter_dashboard"
                      ? "Open the live digital twin for this sandbox building."
                      : activeBuilding.actionKind === "open_modal"
                        ? "Upload blueprint and inspect the gateway."
                        : "Open the live digital twin for this building."}
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
      <AddBuildingModal isOpen={isAddModalOpen} onClose={() => setIsAddModalOpen(false)} />
      <GatewayConnectionErrorModal
        buildingName={activeBuilding.name}
        isOpen={isGatewayErrorOpen}
        onClose={() => setIsGatewayErrorOpen(false)}
      />
    </>
  );
}
