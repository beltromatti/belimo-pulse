import { createHash, randomUUID } from "crypto";

import { z } from "zod";

import { BuildingBlueprint } from "../blueprint";
import {
  FacilityModePreference,
  OperatorPolicy,
  OperatorPolicyDay,
  OperatorPolicyImportance,
  OperatorPolicySchedule,
  OperatorPolicyScopeType,
  OperatorPolicyType,
} from "../runtime-types";

const operatorPolicyDaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const operatorPolicyScheduleSchema = z.object({
  timezone: z.string().min(1),
  daysOfWeek: z.array(operatorPolicyDaySchema).min(1).max(7),
  startLocalTime: z.string().regex(/^\d{2}:\d{2}$/),
  endLocalTime: z.string().regex(/^\d{2}:\d{2}$/),
});

const rawExtractedOperatorPolicySchema = z.object({
  policyType: z.enum([
    "zone_temperature_schedule",
    "facility_mode_preference",
    "occupancy_bias_preference",
    "energy_strategy",
    "operating_note",
  ]),
  importance: z.enum(["requirement", "preference"]).default("preference"),
  summary: z.string().min(1),
  zoneId: z.string().nullable().optional(),
  temperatureC: z.number().nullable().optional(),
  mode: z.enum(["auto", "ventilation", "cooling", "heating", "economizer"]).nullable().optional(),
  occupancyBias: z.number().nullable().optional(),
  strategy: z.enum(["comfort_priority", "balanced", "efficiency_priority"]).nullable().optional(),
  notes: z.string().nullable().optional(),
  scopeType: z.enum(["building", "zone"]).nullable().optional(),
  scopeId: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  schedule: operatorPolicyScheduleSchema.nullable().optional(),
});

const rawExtractedOperatorPoliciesEnvelopeSchema = z.object({
  policies: z.array(rawExtractedOperatorPolicySchema).default([]),
  missingInformation: z.array(z.string()).default([]),
});

export const operatorPolicyExtractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    policies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          policyType: {
            type: "string",
            enum: [
              "zone_temperature_schedule",
              "facility_mode_preference",
              "occupancy_bias_preference",
              "energy_strategy",
              "operating_note",
            ],
          },
          importance: {
            type: "string",
            enum: ["requirement", "preference"],
          },
          summary: { type: "string" },
          zoneId: { type: ["string", "null"] },
          temperatureC: { type: ["number", "null"] },
          mode: {
            type: ["string", "null"],
            enum: ["auto", "ventilation", "cooling", "heating", "economizer", null],
          },
          occupancyBias: { type: ["number", "null"] },
          strategy: {
            type: ["string", "null"],
            enum: ["comfort_priority", "balanced", "efficiency_priority", null],
          },
          notes: { type: ["string", "null"] },
          scopeType: {
            type: ["string", "null"],
            enum: ["building", "zone", null],
          },
          scopeId: { type: ["string", "null"] },
          note: { type: ["string", "null"] },
          schedule: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  timezone: { type: "string" },
                  daysOfWeek: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
                    },
                  },
                  startLocalTime: { type: "string" },
                  endLocalTime: { type: "string" },
                },
                required: ["timezone", "daysOfWeek", "startLocalTime", "endLocalTime"],
              },
              { type: "null" },
            ],
          },
        },
        required: [
          "policyType",
          "importance",
          "summary",
          "zoneId",
          "temperatureC",
          "mode",
          "occupancyBias",
          "strategy",
          "notes",
          "scopeType",
          "scopeId",
          "note",
          "schedule",
        ],
      },
    },
    missingInformation: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["policies", "missingInformation"],
} as const;

const zoneTemperatureScheduleDraftSchema = z.object({
  policyType: z.literal("zone_temperature_schedule"),
  importance: z.enum(["requirement", "preference"]),
  summary: z.string().min(1),
  zoneId: z.string().min(1),
  temperatureC: z.number().min(16).max(30),
  schedule: operatorPolicyScheduleSchema.nullable(),
});

const facilityModePreferenceDraftSchema = z.object({
  policyType: z.literal("facility_mode_preference"),
  importance: z.enum(["requirement", "preference"]),
  summary: z.string().min(1),
  mode: z.enum(["auto", "ventilation", "cooling", "heating", "economizer"]),
  schedule: operatorPolicyScheduleSchema.nullable(),
});

const occupancyBiasPreferenceDraftSchema = z.object({
  policyType: z.literal("occupancy_bias_preference"),
  importance: z.enum(["requirement", "preference"]),
  summary: z.string().min(1),
  occupancyBias: z.number().min(0.4).max(1.6),
  schedule: operatorPolicyScheduleSchema.nullable(),
});

const energyStrategyDraftSchema = z.object({
  policyType: z.literal("energy_strategy"),
  importance: z.enum(["requirement", "preference"]),
  summary: z.string().min(1),
  strategy: z.enum(["comfort_priority", "balanced", "efficiency_priority"]),
  notes: z.string().nullable().optional(),
  schedule: operatorPolicyScheduleSchema.nullable(),
});

const operatingNoteDraftSchema = z
  .object({
    policyType: z.literal("operating_note"),
    importance: z.enum(["requirement", "preference"]),
    summary: z.string().min(1),
    scopeType: z.enum(["building", "zone"]),
    scopeId: z.string().nullable().optional(),
    note: z.string().min(1),
    schedule: operatorPolicyScheduleSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scopeType === "zone" && !value.scopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: "scopeId is required when scopeType is zone",
      });
    }
  });

export const operatorPolicyDraftSchema = z.discriminatedUnion("policyType", [
  zoneTemperatureScheduleDraftSchema,
  facilityModePreferenceDraftSchema,
  occupancyBiasPreferenceDraftSchema,
  energyStrategyDraftSchema,
  operatingNoteDraftSchema,
]);

export type OperatorPolicyDraft = z.infer<typeof operatorPolicyDraftSchema>;

export type OperatorPolicyExtraction = {
  policies: OperatorPolicyDraft[];
  missingInformation: string[];
};

export type PersistableOperatorPolicy = Omit<OperatorPolicy, "status" | "createdAt" | "updatedAt"> & {
  sourceMessageTimestamp: string;
  sourceMessageExcerpt: string;
};

const dayOrder: Record<OperatorPolicyDay, number> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};

const dayLabels: Record<OperatorPolicyDay, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

function normalizeSchedule(schedule: OperatorPolicySchedule | null | undefined): OperatorPolicySchedule | null {
  if (!schedule) {
    return null;
  }

  return {
    timezone: schedule.timezone.trim(),
    daysOfWeek: Array.from(new Set(schedule.daysOfWeek)).sort((left, right) => dayOrder[left] - dayOrder[right]),
    startLocalTime: schedule.startLocalTime,
    endLocalTime: schedule.endLocalTime,
  };
}

function getPolicyScope(draft: OperatorPolicyDraft): {
  scopeType: OperatorPolicyScopeType;
  scopeId?: string;
} {
  if (draft.policyType === "zone_temperature_schedule") {
    return {
      scopeType: "zone",
      scopeId: draft.zoneId,
    };
  }

  if (draft.policyType === "operating_note") {
    return {
      scopeType: draft.scopeType,
      scopeId: draft.scopeType === "zone" ? draft.scopeId ?? undefined : undefined,
    };
  }

  return {
    scopeType: "building",
  };
}

function getPolicySchedule(draft: OperatorPolicyDraft) {
  if (!("schedule" in draft)) {
    return null;
  }

  return normalizeSchedule(draft.schedule);
}

function getPolicyDetails(draft: OperatorPolicyDraft): Record<string, unknown> {
  switch (draft.policyType) {
    case "zone_temperature_schedule":
      return {
        zoneId: draft.zoneId,
        temperatureC: draft.temperatureC,
      };
    case "facility_mode_preference":
      return {
        mode: draft.mode as FacilityModePreference,
      };
    case "occupancy_bias_preference":
      return {
        occupancyBias: draft.occupancyBias,
      };
    case "energy_strategy":
      return {
        strategy: draft.strategy,
        notes: draft.notes ?? null,
      };
    case "operating_note":
      return {
        note: draft.note,
      };
  }
}

export function buildOperatorPolicyKey(draft: OperatorPolicyDraft) {
  const { scopeType, scopeId } = getPolicyScope(draft);
  const schedule = getPolicySchedule(draft);
  const matchKey =
    draft.policyType === "operating_note"
      ? {
          note: draft.note.trim().toLowerCase(),
        }
      : {};

  return createHash("sha256")
    .update(
      JSON.stringify({
        policyType: draft.policyType,
        scopeType,
        scopeId: scopeId ?? null,
        schedule,
        matchKey,
      }),
    )
    .digest("hex");
}

export function parseOperatorPolicyExtraction(payload: unknown): OperatorPolicyExtraction {
  const parsed = rawExtractedOperatorPoliciesEnvelopeSchema.parse(payload);

  return {
    policies: parsed.policies.map((candidate) => coerceOperatorPolicyDraft(candidate)),
    missingInformation: parsed.missingInformation.map((item) => item.trim()).filter(Boolean),
  };
}

function coerceOperatorPolicyDraft(
  raw: z.infer<typeof rawExtractedOperatorPolicySchema>,
): OperatorPolicyDraft {
  switch (raw.policyType) {
    case "zone_temperature_schedule":
      return zoneTemperatureScheduleDraftSchema.parse({
        policyType: raw.policyType,
        importance: raw.importance,
        summary: raw.summary.trim(),
        zoneId: raw.zoneId ?? "",
        temperatureC: raw.temperatureC,
        schedule: normalizeSchedule(raw.schedule),
      });
    case "facility_mode_preference":
      return facilityModePreferenceDraftSchema.parse({
        policyType: raw.policyType,
        importance: raw.importance,
        summary: raw.summary.trim(),
        mode: raw.mode,
        schedule: normalizeSchedule(raw.schedule),
      });
    case "occupancy_bias_preference":
      return occupancyBiasPreferenceDraftSchema.parse({
        policyType: raw.policyType,
        importance: raw.importance,
        summary: raw.summary.trim(),
        occupancyBias: raw.occupancyBias,
        schedule: normalizeSchedule(raw.schedule),
      });
    case "energy_strategy":
      return energyStrategyDraftSchema.parse({
        policyType: raw.policyType,
        importance: raw.importance,
        summary: raw.summary.trim(),
        strategy: raw.strategy,
        notes: raw.notes ?? null,
        schedule: normalizeSchedule(raw.schedule),
      });
    case "operating_note":
      return operatingNoteDraftSchema.parse({
        policyType: raw.policyType,
        importance: raw.importance,
        summary: raw.summary.trim(),
        scopeType: raw.scopeType ?? "building",
        scopeId: raw.scopeId ?? null,
        note: raw.note ?? raw.summary,
        schedule: normalizeSchedule(raw.schedule),
      });
  }
}

export function materializeOperatorPolicies(input: {
  buildingId: string;
  conversationId?: string;
  sourceMessage: {
    content: string;
    timestamp: string;
  };
  drafts: OperatorPolicyDraft[];
}): PersistableOperatorPolicy[] {
  return input.drafts.map((draft) => {
    const schedule = getPolicySchedule(draft);
    const { scopeType, scopeId } = getPolicyScope(draft);

    return {
      id: randomUUID(),
      buildingId: input.buildingId,
      conversationId: input.conversationId,
      policyKey: buildOperatorPolicyKey(draft),
      policyType: draft.policyType as OperatorPolicyType,
      scopeType,
      scopeId,
      importance: draft.importance as OperatorPolicyImportance,
      summary: draft.summary.trim(),
      schedule,
      details: getPolicyDetails(draft),
      sourceMessageTimestamp: input.sourceMessage.timestamp,
      sourceMessageExcerpt: input.sourceMessage.content.trim().slice(0, 400),
    };
  });
}

export function describeOperatorPolicySchedule(schedule: OperatorPolicySchedule | null) {
  if (!schedule) {
    return "always active";
  }

  const days = schedule.daysOfWeek.map((day) => dayLabels[day]).join(", ");
  return `${days} ${schedule.startLocalTime}-${schedule.endLocalTime} ${schedule.timezone}`;
}

export function formatOperatorPolicyForPrompt(policy: Pick<OperatorPolicy, "summary" | "policyType" | "scopeType" | "scopeId" | "schedule" | "importance">, blueprint: BuildingBlueprint) {
  const scopeLabel =
    policy.scopeType === "zone" && policy.scopeId
      ? blueprint.spaces.find((space) => space.id === policy.scopeId)?.name ?? policy.scopeId
      : blueprint.building.name;

  return `- [${policy.importance}] ${policy.summary} | scope: ${scopeLabel} | schedule: ${describeOperatorPolicySchedule(policy.schedule)} | type: ${policy.policyType}`;
}

export function formatOperatorPolicyDraftForPrompt(policy: OperatorPolicyDraft, blueprint: BuildingBlueprint) {
  const { scopeType, scopeId } = getPolicyScope(policy);
  const scopeLabel =
    scopeType === "zone" && scopeId
      ? blueprint.spaces.find((space) => space.id === scopeId)?.name ?? scopeId
      : blueprint.building.name;

  return `- [${policy.importance}] ${policy.summary} | scope: ${scopeLabel} | schedule: ${describeOperatorPolicySchedule(getPolicySchedule(policy))} | type: ${policy.policyType}`;
}

export function formatOperatorPolicyForUi(policy: Pick<OperatorPolicy, "summary" | "schedule">) {
  return {
    summary: policy.summary,
    scheduleLabel: describeOperatorPolicySchedule(policy.schedule),
  };
}
