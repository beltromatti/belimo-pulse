import { BuildingBlueprint } from "../blueprint";
import { cloneRuntimeControlState } from "../control-state";
import { clamp } from "../physics";
import {
  ActiveControlPolicy,
  OperatorPolicy,
  OperatorPolicyDay,
  RuntimeControlResolution,
  RuntimeControlState,
} from "../runtime-types";

const weekdayMap: Record<string, OperatorPolicyDay> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

const previousWeekday: Record<OperatorPolicyDay, OperatorPolicyDay> = {
  mon: "sun",
  tue: "mon",
  wed: "tue",
  thu: "wed",
  fri: "thu",
  sat: "fri",
  sun: "sat",
};

function parseLocalTime(value: string) {
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  return hours * 60 + minutes;
}

function getScheduleDurationMinutes(schedule: NonNullable<OperatorPolicy["schedule"]>) {
  const start = parseLocalTime(schedule.startLocalTime);
  const end = parseLocalTime(schedule.endLocalTime);

  if (start === end) {
    return 24 * 60;
  }

  return start < end ? end - start : 24 * 60 - start + end;
}

function getLocalCalendarParts(now: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");

  if (!weekday || !(weekday in weekdayMap)) {
    throw new Error(`Unable to resolve local weekday for timezone ${timeZone}`);
  }

  return {
    day: weekdayMap[weekday],
    minutes: hour * 60 + minute,
  };
}

function comparePolicyPriority(left: OperatorPolicy, right: OperatorPolicy) {
  if (left.importance !== right.importance) {
    return left.importance === "requirement" ? -1 : 1;
  }

  if (Boolean(left.schedule) !== Boolean(right.schedule)) {
    return left.schedule ? -1 : 1;
  }

  if (left.schedule && right.schedule) {
    if (left.schedule.daysOfWeek.length !== right.schedule.daysOfWeek.length) {
      return left.schedule.daysOfWeek.length - right.schedule.daysOfWeek.length;
    }

    const leftDuration = getScheduleDurationMinutes(left.schedule);
    const rightDuration = getScheduleDurationMinutes(right.schedule);

    if (leftDuration !== rightDuration) {
      return leftDuration - rightDuration;
    }
  }

  const updatedDelta = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();

  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  const createdDelta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();

  if (createdDelta !== 0) {
    return createdDelta;
  }

  return left.id.localeCompare(right.id);
}

function trackAppliedPolicy(
  appliedPolicies: Map<string, ActiveControlPolicy>,
  policy: OperatorPolicy,
  controlPath: string,
) {
  const existing = appliedPolicies.get(policy.id);

  if (existing) {
    if (!existing.appliedControlPaths.includes(controlPath)) {
      existing.appliedControlPaths.push(controlPath);
    }
    return;
  }

  appliedPolicies.set(policy.id, {
    id: policy.id,
    policyType: policy.policyType,
    scopeType: policy.scopeType,
    scopeId: policy.scopeId,
    importance: policy.importance,
    summary: policy.summary,
    schedule: policy.schedule,
    appliedControlPaths: [controlPath],
  });
}

function getZoneOccupiedMidpoint(blueprint: BuildingBlueprint, zoneId: string) {
  const zone = blueprint.spaces.find((space) => space.id === zoneId);

  if (!zone) {
    throw new Error(`Unknown zone ${zoneId} referenced by operator policy`);
  }

  const [minC, maxC] = zone.comfort_targets.occupied_temperature_band_c;
  return (minC + maxC) / 2;
}

function sortPolicies(policies: OperatorPolicy[]) {
  return [...policies].sort(comparePolicyPriority);
}

export function createRuntimeControlResolution(
  manualControls: RuntimeControlState,
  generatedAt = new Date().toISOString(),
): RuntimeControlResolution {
  const controls = cloneRuntimeControlState(manualControls);

  return {
    generatedAt,
    manualControls: cloneRuntimeControlState(manualControls),
    effectiveControls: controls,
    activePolicies: [],
  };
}

export function isOperatorPolicyActiveAt(policy: Pick<OperatorPolicy, "schedule">, now: Date) {
  if (!policy.schedule) {
    return true;
  }

  const local = getLocalCalendarParts(now, policy.schedule.timezone);
  const start = parseLocalTime(policy.schedule.startLocalTime);
  const end = parseLocalTime(policy.schedule.endLocalTime);

  if (start === end) {
    return policy.schedule.daysOfWeek.includes(local.day);
  }

  if (start < end) {
    return (
      policy.schedule.daysOfWeek.includes(local.day) && local.minutes >= start && local.minutes < end
    );
  }

  return (
    (policy.schedule.daysOfWeek.includes(local.day) && local.minutes >= start) ||
    (policy.schedule.daysOfWeek.includes(previousWeekday[local.day]) && local.minutes < end)
  );
}

export function resolveRuntimeControlResolution(input: {
  blueprint: BuildingBlueprint;
  manualControls: RuntimeControlState;
  policies: OperatorPolicy[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const resolution = createRuntimeControlResolution(input.manualControls, now.toISOString());
  const effectiveControls = resolution.effectiveControls;
  const appliedPolicies = new Map<string, ActiveControlPolicy>();
  const activePolicies = sortPolicies(input.policies.filter((policy) => isOperatorPolicyActiveAt(policy, now)));
  const activePolicyById = new Map(activePolicies.map((policy) => [policy.id, policy]));

  const activeEnergyStrategy = activePolicies.find((policy) => policy.policyType === "energy_strategy");

  if (activeEnergyStrategy) {
    const strategy = String(activeEnergyStrategy.details.strategy ?? "");
    let nextOccupancyBias = effectiveControls.occupancyBias;

    if (strategy === "comfort_priority") {
      nextOccupancyBias = clamp(Math.max(nextOccupancyBias, 1.12), 0.4, 1.6);
    } else if (strategy === "balanced") {
      nextOccupancyBias = 1;
    } else if (strategy === "efficiency_priority") {
      nextOccupancyBias = clamp(Math.min(nextOccupancyBias, 0.85), 0.4, 1.6);
    }

    if (nextOccupancyBias !== effectiveControls.occupancyBias) {
      effectiveControls.occupancyBias = nextOccupancyBias;
      trackAppliedPolicy(appliedPolicies, activeEnergyStrategy, "occupancyBias");
    }
  }

  const activeOccupancyPolicy = activePolicies.find((policy) => policy.policyType === "occupancy_bias_preference");

  if (activeOccupancyPolicy && typeof activeOccupancyPolicy.details.occupancyBias === "number") {
    effectiveControls.occupancyBias = clamp(activeOccupancyPolicy.details.occupancyBias, 0.4, 1.6);
    trackAppliedPolicy(appliedPolicies, activeOccupancyPolicy, "occupancyBias");
  }

  const activeModePolicy = activePolicies.find((policy) => policy.policyType === "facility_mode_preference");

  if (activeModePolicy && typeof activeModePolicy.details.mode === "string") {
    effectiveControls.sourceModePreference = activeModePolicy.details.mode as RuntimeControlState["sourceModePreference"];
    trackAppliedPolicy(appliedPolicies, activeModePolicy, "sourceModePreference");
  }

  const zonePoliciesById = new Map<string, OperatorPolicy[]>();

  for (const policy of activePolicies) {
    if (policy.policyType !== "zone_temperature_schedule" || policy.scopeType !== "zone" || !policy.scopeId) {
      continue;
    }

    const policiesForZone = zonePoliciesById.get(policy.scopeId) ?? [];
    policiesForZone.push(policy);
    zonePoliciesById.set(policy.scopeId, policiesForZone);
  }

  for (const [zoneId, policies] of zonePoliciesById.entries()) {
    const policy = sortPolicies(policies)[0];

    if (typeof policy.details.temperatureC !== "number") {
      continue;
    }

    // The low-level sandbox accepts zone offsets, so scheduled absolute targets are translated
    // against the designed occupied midpoint for the zone.
    const occupiedMidpoint = getZoneOccupiedMidpoint(input.blueprint, zoneId);
    effectiveControls.zoneTemperatureOffsetsC[zoneId] = clamp(policy.details.temperatureC - occupiedMidpoint, -3, 3);
    trackAppliedPolicy(appliedPolicies, policy, `zoneTemperatureOffsetsC.${zoneId}`);
  }

  resolution.activePolicies = [...appliedPolicies.values()].sort((left, right) => {
    const leftPolicy = activePolicyById.get(left.id);
    const rightPolicy = activePolicyById.get(right.id);

    if (!leftPolicy || !rightPolicy) {
      return left.id.localeCompare(right.id);
    }

    return comparePolicyPriority(leftPolicy, rightPolicy);
  });

  return resolution;
}
