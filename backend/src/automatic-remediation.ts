import { RuntimeDriftAssessment, ZoneDriftSignal } from "./control-intelligence";

export type AutomaticRemediationState = {
  issueKey: string;
  trigger: NonNullable<RuntimeDriftAssessment["trigger"]>;
  reason: RuntimeDriftAssessment["reason"];
  appliedAtRuntimeSeconds: number;
  reevaluateAfterRuntimeSeconds: number;
  baselineSeverity: number;
  lastWorstZoneId: string | null;
};

export type AutomaticRemediationDecision =
  | {
      action: "skip";
      issueKey: string;
      nextState: AutomaticRemediationState | null;
    }
  | {
      action: "apply";
      issueKey: string;
      nextState: AutomaticRemediationState;
    };

function getComfortIssueKey(reason: ZoneDriftSignal["dominantIssue"] | "fault" | null) {
  if (reason === "temperature_cold") {
    return "comfort:temperature_cold";
  }

  if (reason === "temperature_hot") {
    return "comfort:temperature_hot";
  }

  if (reason === "co2" || reason === "airflow") {
    return "comfort:ventilation";
  }

  return "comfort:general";
}

export function deriveAutomaticIssueKey(assessment: RuntimeDriftAssessment, activeFaultIds: string[]) {
  if (assessment.trigger === "fault_detected") {
    return `fault:${activeFaultIds.sort().join(",") || "general"}`;
  }

  return getComfortIssueKey(assessment.reason);
}

export function shouldClearAutomaticRemediationState(
  assessment: RuntimeDriftAssessment,
  existing: AutomaticRemediationState | null,
) {
  if (!existing) {
    return false;
  }

  if (!assessment.trigger) {
    return true;
  }

  return false;
}

export function decideAutomaticRemediation(input: {
  assessment: RuntimeDriftAssessment;
  runtimeSeconds: number;
  activeFaultIds: string[];
  existing: AutomaticRemediationState | null;
}) {
  const issueKey = deriveAutomaticIssueKey(input.assessment, input.activeFaultIds);

  if (!input.assessment.trigger) {
    return {
      action: "skip",
      issueKey,
      nextState: null,
    } satisfies AutomaticRemediationDecision;
  }

  const reevaluateWindowSeconds =
    input.assessment.trigger === "fault_detected"
      ? 30 * 60
      : input.assessment.severity >= 3
        ? 30 * 60
        : 20 * 60;

  if (!input.existing) {
    return {
      action: "apply",
      issueKey,
      nextState: {
        issueKey,
        trigger: input.assessment.trigger,
        reason: input.assessment.reason,
        appliedAtRuntimeSeconds: input.runtimeSeconds,
        reevaluateAfterRuntimeSeconds: input.runtimeSeconds + reevaluateWindowSeconds,
        baselineSeverity: input.assessment.severity,
        lastWorstZoneId: input.assessment.worstZoneId,
      },
    } satisfies AutomaticRemediationDecision;
  }

  const severityDelta = input.assessment.severity - input.existing.baselineSeverity;
  const severityRatio = input.existing.baselineSeverity <= 0 ? Number.POSITIVE_INFINITY : input.assessment.severity / input.existing.baselineSeverity;
  const materiallyEscalated =
    severityDelta >= 1.1 ||
    severityRatio >= 1.45 ||
    (input.existing.lastWorstZoneId !== input.assessment.worstZoneId && severityDelta >= 0.9);

  if (
    input.runtimeSeconds < input.existing.reevaluateAfterRuntimeSeconds &&
    !materiallyEscalated
  ) {
    return {
      action: "skip",
      issueKey,
      nextState: input.existing,
    } satisfies AutomaticRemediationDecision;
  }

  return {
    action: "apply",
    issueKey,
    nextState: {
      issueKey,
      trigger: input.assessment.trigger,
      reason: input.assessment.reason,
      appliedAtRuntimeSeconds: input.runtimeSeconds,
      reevaluateAfterRuntimeSeconds: input.runtimeSeconds + reevaluateWindowSeconds,
      baselineSeverity: input.assessment.severity,
      lastWorstZoneId: input.assessment.worstZoneId,
    },
  } satisfies AutomaticRemediationDecision;
}
