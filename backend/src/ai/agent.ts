import { randomUUID } from "crypto";

import OpenAI from "openai";
import type { ResponseInput, ResponseInputItem, ResponseTextConfig } from "openai/resources/responses/responses";
import { z } from "zod";

import {
  formatOperatorPolicyDraftForPrompt,
  formatOperatorPolicyForPrompt,
  materializeOperatorPolicies,
  operatorPolicyExtractionJsonSchema,
  parseOperatorPolicyExtraction,
} from "../brain/policies";
import {
  dismissBelimoBrainAlert,
  insertBelimoBrainAlert,
  insertBelimoBrainMessages,
  insertOperatorPolicies,
  listActiveBelimoBrainAlerts,
  listActiveOperatorPolicies,
  listBelimoBrainConversationMessages,
} from "../db";
import { BelimoPlatform } from "../platform";
import { OperatorPolicy, RuntimeControlState, TwinSnapshot } from "../runtime-types";

import { BrainAction, BrainAlert, ChatMessage, ChatResponse } from "./types";
import { brainToolDefinitions, executeBrainTool } from "./tools";

const MAX_TOOL_ROUNDS = 6;
const DEFAULT_CHAT_HISTORY_LIMIT = 40;
const DEFAULT_ALERT_HISTORY_LIMIT = 50;
const DEFAULT_POLICY_LIMIT = 24;
const PROACTIVE_CONVERSATION_SUFFIX = "belimo-brain-proactive";

const proactiveAnalysisSchema = z.object({
  summary: z.string().min(1),
  needsAttention: z.boolean(),
  severity: z.enum(["none", "info", "warning", "critical"]),
  title: z.string(),
  body: z.string(),
  suggestedAction: z.string().nullable(),
});

type BelimoBrainReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

type RunBelimoBrainResponseOptions = {
  instructions: string;
  input: ResponseInput;
  text: ResponseTextConfig;
};

type ProactiveTrigger = {
  urgent: boolean;
  reasons: string[];
};

export class BelimoBrainAgent {
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly reasoningEffort: BelimoBrainReasoningEffort;
  private readonly proactiveAnalysisIntervalTicks: number;
  private readonly buildingId: string;
  private readonly proactiveConversationId: string;
  private readonly systemPrompt: string;
  private readonly alertListeners = new Set<(alert: BrainAlert) => void>();

  private conversations = new Map<string, ChatMessage[]>();
  private alerts: BrainAlert[] = [];
  private analysisInFlight = false;
  private ticksSinceLastProactiveAnalysis = 0;
  private previousComfortScore: number | null = null;
  private previousAlertCount = 0;
  private previousWeatherC: number | null = null;

  constructor(
    private readonly platform: BelimoPlatform,
    openaiApiKey: string,
    model = "gpt-5.4",
    reasoningEffort: BelimoBrainReasoningEffort = "medium",
    proactiveAnalysisIntervalTicks = 12,
  ) {
    this.openai = new OpenAI({ apiKey: openaiApiKey.trim() });
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.proactiveAnalysisIntervalTicks = Math.max(1, proactiveAnalysisIntervalTicks);

    const blueprint = platform.getBlueprint();
    const zoneNames = blueprint.spaces.map((space) => `${space.id} ("${space.name}", ${space.geometry.area_m2}m²)`).join(", ");
    const deviceCount = blueprint.devices.length;
    const faults = platform.getAvailableFaults();
    const faultList = faults.map((fault) => `${fault.id} (${fault.faultType} on ${fault.deviceId})`).join(", ");

    this.buildingId = blueprint.blueprint_id;
    this.proactiveConversationId = `${this.buildingId}:${PROACTIVE_CONVERSATION_SUFFIX}`;

    this.systemPrompt = `You are Belimo Brain for "${blueprint.building.name}", an AI facility management assistant powered by Belimo Pulse. You monitor a commercial HVAC system in ${blueprint.building.location.city}, ${blueprint.building.location.country} in real time.

Building: ${blueprint.spaces.length} thermal zones, ${deviceCount} devices (actuators, sensors, rooftop unit).
Zones: ${zoneNames}.
Available fault simulations: ${faultList}.

Your role:
- Monitor building comfort, energy efficiency, and device health continuously.
- Explain the state of the building in plain operational language grounded in the data.
- Use recent history, not only the current frame, before concluding that a problem is transient or persistent.
- Detect issues such as comfort drift, zone starvation, filter loading, actuator obstruction, poor ventilation, and weather-driven instability.
- When safe and clearly supported by the data, apply low-risk control adjustments with tools and explain what changed.
- Treat a suspected mechanical obstruction seriously and describe plausible causes such as debris, a rodent, linkage slip, or damper binding.

Operating rules:
- Lead with the most actionable insight.
- Always query the tools before making claims about the building.
- Reference concrete values such as temperatures, airflow, comfort scores, CO2, torque, tracking error, and device health.
- In proactive mode, use current state plus recent history before deciding whether to raise an operator alert.
- Only take low-risk autonomous actions: a facility mode change or a single zone temperature offset adjustment within the supported range.
- Never toggle simulated faults during proactive analysis.`;
  }

  async hydrate() {
    this.alerts = await listActiveBelimoBrainAlerts(this.buildingId, DEFAULT_ALERT_HISTORY_LIMIT);
  }

  onAlert(listener: (alert: BrainAlert) => void) {
    this.alertListeners.add(listener);

    return () => {
      this.alertListeners.delete(listener);
    };
  }

  async chat(message: string, conversationId?: string): Promise<ChatResponse> {
    const convId = conversationId ?? randomUUID();
    const trimmedMessage = message.trim();
    const policyExtraction = await this.extractOperatorPolicies(trimmedMessage, convId);
    const history = await this.getConversationHistory(convId);
    const userTimestamp = new Date().toISOString();
    const userMessage: ChatMessage = {
      role: "user",
      content: trimmedMessage,
      timestamp: userTimestamp,
    };

    const instructions = await this.buildContextualInstructions({
      latestPolicyLines: policyExtraction.policies.map((policy) =>
        formatOperatorPolicyDraftForPrompt(policy, this.platform.getBlueprint()),
      ),
      missingInformation: policyExtraction.missingInformation,
    });
    const { outputText, actions: responseActions } = await this.runBelimoBrainResponse({
      instructions,
      input: this.toResponseInput([...history, userMessage]),
      text: {
        verbosity: "medium",
      },
    });
    const persistedPolicies =
      policyExtraction.policies.length > 0
        ? await insertOperatorPolicies(
            materializeOperatorPolicies({
              buildingId: this.buildingId,
              conversationId: convId,
              sourceMessage: {
                content: trimmedMessage,
                timestamp: userTimestamp,
              },
              drafts: policyExtraction.policies,
            }),
          )
        : [];
    const actions: BrainAction[] = persistedPolicies.map((policy) => ({
      tool: "persist_operator_policy",
      input: {
        policyType: policy.policyType,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId ?? null,
        importance: policy.importance,
      },
      result: {
        policyId: policy.id,
        summary: policy.summary,
        schedule: policy.schedule,
      },
    }));
    actions.push(...responseActions);

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: outputText || "Belimo Brain completed the request.",
      actions: actions.length > 0 ? actions : undefined,
      timestamp: new Date().toISOString(),
    };

    const nextHistory = this.commitConversationMessages(convId, [userMessage, assistantMessage]);
    await insertBelimoBrainMessages(this.buildingId, convId, [userMessage, assistantMessage]);

    this.conversations.set(convId, nextHistory);

    return {
      message: assistantMessage,
      conversationId: convId,
      alerts: this.getActiveAlerts(),
      policies: await listActiveOperatorPolicies(this.buildingId, DEFAULT_POLICY_LIMIT),
    };
  }

  handleTick(snapshot: TwinSnapshot, controls: RuntimeControlState) {
    this.ticksSinceLastProactiveAnalysis += 1;
    const trigger = this.evaluateTrigger(snapshot);

    this.previousComfortScore = snapshot.summary.averageComfortScore;
    this.previousAlertCount = snapshot.summary.activeAlertCount;
    this.previousWeatherC = snapshot.weather.temperatureC;

    const periodicDue = this.ticksSinceLastProactiveAnalysis >= this.proactiveAnalysisIntervalTicks;

    if (this.analysisInFlight || (!periodicDue && !trigger.urgent)) {
      return;
    }

    this.analysisInFlight = true;
    this.ticksSinceLastProactiveAnalysis = 0;

    const triggerReason = periodicDue
      ? trigger.reasons.length > 0
        ? `periodic review + ${trigger.reasons.join("; ")}`
        : "periodic review"
      : trigger.reasons.join("; ");

    void this.runProactiveAnalysis(snapshot, controls, triggerReason)
      .catch((error) => {
        console.error("Belimo Brain proactive analysis failed", error);
      })
      .finally(() => {
        this.analysisInFlight = false;
      });
  }

  getActiveAlerts(): BrainAlert[] {
    return [...this.alerts.filter((alert) => !alert.dismissed)].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  async dismissAlert(alertId: string) {
    const alert = this.alerts.find((candidate) => candidate.id === alertId);

    if (!alert) {
      return;
    }

    alert.dismissed = true;
    await dismissBelimoBrainAlert(this.buildingId, alertId);
  }

  private async runProactiveAnalysis(snapshot: TwinSnapshot, controls: RuntimeControlState, triggerReason: string) {
    const history = await this.getConversationHistory(this.proactiveConversationId);
    const reviewMessage: ChatMessage = {
      role: "user",
      content: this.buildProactiveReviewPrompt(snapshot, controls, triggerReason),
      timestamp: new Date().toISOString(),
    };
    const instructions = await this.buildContextualInstructions({
      modeInstructions: `You are running in Belimo Brain proactive mode. Before finalizing:
- Call get_building_summary, get_building_history, and get_active_policies.
- If a zone or device looks suspicious, inspect it with get_zone_details, get_device_health, get_comfort_history, or get_device_telemetry_history.
- Use low-risk autonomous tools only when the data clearly supports a correction.
- Return JSON that matches the schema exactly.`,
    });

    const { outputText, actions } = await this.runBelimoBrainResponse({
      instructions,
      input: this.toResponseInput([...history, reviewMessage]),
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "belimo_brain_proactive_review",
          strict: true,
          description: "Belimo Brain proactive review result for operator notification and control logging.",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              needsAttention: { type: "boolean" },
              severity: { type: "string", enum: ["none", "info", "warning", "critical"] },
              title: { type: "string" },
              body: { type: "string" },
              suggestedAction: { type: ["string", "null"] },
            },
            required: ["summary", "needsAttention", "severity", "title", "body", "suggestedAction"],
          },
        },
      },
    });

    const parsed = proactiveAnalysisSchema.parse(JSON.parse(outputText || "{}"));
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: this.formatProactiveAssistantMessage(parsed),
      actions: actions.length > 0 ? actions : undefined,
      timestamp: new Date().toISOString(),
    };

    const nextHistory = this.commitConversationMessages(this.proactiveConversationId, [reviewMessage, assistantMessage]);
    await insertBelimoBrainMessages(this.buildingId, this.proactiveConversationId, [reviewMessage, assistantMessage]);
    this.conversations.set(this.proactiveConversationId, nextHistory);

    if (!parsed.needsAttention || parsed.severity === "none") {
      return;
    }

    await this.createAlert(
      {
        id: randomUUID(),
        severity: parsed.severity,
        title: parsed.title || "Belimo Brain Notice",
        body: parsed.body || parsed.summary,
        suggestedAction: parsed.suggestedAction ?? undefined,
        timestamp: new Date().toISOString(),
        dismissed: false,
      },
      "belimo-brain-proactive",
      {
        triggerReason,
        conversationId: this.proactiveConversationId,
        model: this.model,
        actionCount: actions.length,
      },
    );
  }

  private evaluateTrigger(snapshot: TwinSnapshot): ProactiveTrigger {
    const reasons: string[] = [];

    if (this.previousComfortScore !== null && this.previousComfortScore >= 78 && snapshot.summary.averageComfortScore < 78) {
      reasons.push(
        `comfort dropped from ${this.previousComfortScore.toFixed(0)} to ${snapshot.summary.averageComfortScore.toFixed(0)}`,
      );
    }

    if (snapshot.summary.activeAlertCount > this.previousAlertCount) {
      reasons.push(`device alert count increased from ${this.previousAlertCount} to ${snapshot.summary.activeAlertCount}`);
    }

    if (this.previousWeatherC !== null && Math.abs(snapshot.weather.temperatureC - this.previousWeatherC) > 5) {
      reasons.push(
        `outdoor temperature shifted from ${this.previousWeatherC.toFixed(1)}°C to ${snapshot.weather.temperatureC.toFixed(1)}°C`,
      );
    }

    const criticalDevice = snapshot.devices.find((device) => device.healthScore < 50);
    if (criticalDevice) {
      reasons.push(`critical device health on ${criticalDevice.deviceId} (${criticalDevice.healthScore}%)`);
    }

    return {
      urgent: reasons.length > 0,
      reasons,
    };
  }

  private buildProactiveReviewPrompt(snapshot: TwinSnapshot, controls: RuntimeControlState, triggerReason: string) {
    const activeFaults = this.platform
      .getLatestSandboxBatch()
      ?.operationalState.activeFaults.map((fault) => `${fault.deviceId}:${fault.faultType}`)
      .join(", ");

    return `Run a proactive Belimo Brain review for the building.

Trigger: ${triggerReason}
Observed at: ${snapshot.observedAt}
Current average comfort score: ${snapshot.summary.averageComfortScore.toFixed(1)}
Worst zone: ${snapshot.summary.worstZoneId}
Current outdoor temperature: ${snapshot.weather.temperatureC.toFixed(1)}°C
Current supply temperature: ${snapshot.summary.supplyTemperatureC.toFixed(1)}°C
Current facility mode preference: ${controls.sourceModePreference}
Active twin device alerts: ${snapshot.summary.activeAlertCount}
Active sandbox faults: ${activeFaults || "none"}

Requirements:
1. Inspect current status and recent history before concluding whether the issue is transient or persistent.
2. If the data clearly supports a low-risk correction, you may call set_facility_mode or adjust_zone_temperature.
3. Do not call toggle_fault in proactive mode.
4. If no operator alert is needed, return needsAttention=false and severity=none.
5. If you did take an action, mention it explicitly in the summary and suggestedAction.`;
  }

  private formatProactiveAssistantMessage(result: z.infer<typeof proactiveAnalysisSchema>) {
    if (!result.needsAttention || result.severity === "none") {
      return result.summary;
    }

    const lines = [result.summary];

    if (result.title) {
      lines.push(`${result.title}: ${result.body}`);
    } else if (result.body) {
      lines.push(result.body);
    }

    if (result.suggestedAction) {
      lines.push(`Suggested action: ${result.suggestedAction}`);
    }

    return lines.join("\n\n");
  }

  private async createAlert(
    alert: BrainAlert,
    source: string,
    metadata: Record<string, unknown>,
  ) {
    const activeAlerts = this.getActiveAlerts();
    const duplicate = activeAlerts.find(
      (candidate) =>
        candidate.severity === alert.severity &&
        candidate.title.trim() === alert.title.trim() &&
        candidate.body.trim() === alert.body.trim(),
    );

    if (duplicate) {
      return null;
    }

    this.alerts.push(alert);
    await insertBelimoBrainAlert(this.buildingId, alert, source, metadata);

    for (const listener of this.alertListeners) {
      listener(alert);
    }

    return alert;
  }

  private async getConversationHistory(conversationId: string) {
    const cached = this.conversations.get(conversationId);

    if (cached) {
      return cached;
    }

    const persisted = await listBelimoBrainConversationMessages(this.buildingId, conversationId, DEFAULT_CHAT_HISTORY_LIMIT);
    this.conversations.set(conversationId, persisted);
    return persisted;
  }

  private commitConversationMessages(conversationId: string, messages: ChatMessage[]) {
    const current = this.conversations.get(conversationId) ?? [];
    const next = [...current, ...messages];
    const trimmed = next.slice(-DEFAULT_CHAT_HISTORY_LIMIT);
    this.conversations.set(conversationId, trimmed);
    return trimmed;
  }

  private async extractOperatorPolicies(message: string, conversationId: string) {
    const blueprint = this.platform.getBlueprint();
    const zoneDirectory = blueprint.spaces.map((space) => `${space.id} ("${space.name}")`).join(", ");

    try {
      const response = await this.openai.responses.create({
        model: this.model,
        instructions: `You extract durable operator intent for Belimo Brain.

Only extract instructions that should influence future building behavior or future Belimo Brain reasoning.
Do not extract one-off diagnostics requests, status questions, or casual conversation.
Use only known zone IDs. Known zones: ${zoneDirectory}.
If a required detail is missing for a durable preference, do not invent it. Instead leave it out of policies and add a short item to missingInformation.
If the operator expresses a persistent qualitative preference such as "prioritize comfort during client demos" or "save energy after hours", store it as either energy_strategy or operating_note.
When no time window is specified, use schedule=null to mean always active until superseded.
Times must be 24-hour HH:MM in the building timezone ${blueprint.building.timezone}.
Weekdays/workdays means mon-fri unless the user explicitly says otherwise.
Return only durable policies worth remembering.`,
        input: [
          {
            role: "user",
            content: message,
          },
        ],
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "belimo_brain_operator_policy_extraction",
            strict: true,
            description: "Durable operator policies and missing information extracted from a facility manager message.",
            schema: operatorPolicyExtractionJsonSchema,
          },
        },
        ...this.getReasoningConfig(),
      });

      return parseOperatorPolicyExtraction(JSON.parse(response.output_text || "{}"));
    } catch (error) {
      console.error("Belimo Brain policy extraction failed", {
        conversationId,
        message,
        error,
      });

      return {
        policies: [],
        missingInformation: [],
      };
    }
  }

  private async buildContextualInstructions(input?: {
    modeInstructions?: string;
    latestPolicies?: OperatorPolicy[];
    latestPolicyLines?: string[];
    missingInformation?: string[];
  }) {
    const activePolicies = await listActiveOperatorPolicies(this.buildingId, DEFAULT_POLICY_LIMIT);
    const sections = [this.systemPrompt];

    if (activePolicies.length > 0) {
      sections.push(
        `Persistent operator policies loaded from the database:
${activePolicies.map((policy) => formatOperatorPolicyForPrompt(policy, this.platform.getBlueprint())).join("\n")}`,
      );
    } else {
      sections.push("Persistent operator policies loaded from the database: none.");
    }

    if (input?.latestPolicies && input.latestPolicies.length > 0) {
      sections.push(
        `Policies persisted from the latest operator message:
${input.latestPolicies.map((policy) => formatOperatorPolicyForPrompt(policy, this.platform.getBlueprint())).join("\n")}
Acknowledge stored policies clearly when they are relevant to the operator's request.`,
      );
    } else if (input?.latestPolicyLines && input.latestPolicyLines.length > 0) {
      sections.push(
        `Potential policies extracted from the latest operator message and queued for persistence if your response succeeds:
${input.latestPolicyLines.join("\n")}
Acknowledge durable preferences clearly when they are relevant to the operator's request.`,
      );
    }

    if (input?.missingInformation && input.missingInformation.length > 0) {
      sections.push(
        `Do not invent missing operator policy details. If the user is trying to set a lasting preference, ask a concise follow-up about:
${input.missingInformation.map((item) => `- ${item}`).join("\n")}`,
      );
    }

    if (input?.modeInstructions) {
      sections.push(input.modeInstructions);
    }

    return sections.join("\n\n");
  }

  private toResponseInput(messages: ChatMessage[]): ResponseInput {
    return messages.map((message) => ({
      role: message.role,
      content: message.content,
    })) satisfies ResponseInputItem[];
  }

  private async runBelimoBrainResponse({ instructions, input, text }: RunBelimoBrainResponseOptions) {
    let workingInput = [...input];
    const actions: BrainAction[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await this.openai.responses.create({
        model: this.model,
        instructions,
        tools: brainToolDefinitions,
        input: workingInput,
        text,
        ...this.getReasoningConfig(),
      });

      const functionCalls = response.output.filter(
        (item): item is Extract<(typeof response.output)[number], { type: "function_call" }> => item.type === "function_call",
      );

      if (functionCalls.length === 0) {
        return {
          outputText: response.output_text.trim(),
          actions,
        };
      }

      workingInput = workingInput.concat(response.output as ResponseInputItem[]);

      for (const functionCall of functionCalls) {
        const args = JSON.parse(functionCall.arguments || "{}") as Record<string, unknown>;
        const result = await executeBrainTool(this.platform, functionCall.name, args);

        actions.push({
          tool: functionCall.name,
          input: args,
          result,
        });

        workingInput.push({
          type: "function_call_output",
          call_id: functionCall.call_id,
          output: JSON.stringify(result),
        });
      }
    }

    throw new Error("Belimo Brain exceeded the maximum tool-call rounds.");
  }

  private supportsReasoning() {
    return this.model.startsWith("gpt-5") || this.model.startsWith("o");
  }

  private getReasoningConfig() {
    if (!this.supportsReasoning() || this.reasoningEffort === "none") {
      return {};
    }

    return {
      reasoning: {
        effort: this.reasoningEffort,
        summary: "concise" as const,
      },
    };
  }
}
