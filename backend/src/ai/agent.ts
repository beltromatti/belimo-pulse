import { randomUUID } from "crypto";
import OpenAI from "openai";

import { BelimoPlatform } from "../platform";
import { RuntimeControlState, TwinSnapshot } from "../runtime-types";

import { BrainAction, BrainAlert, ChatMessage, ChatResponse } from "./types";
import { brainToolDefinitions, executeBrainTool } from "./tools";

const MAX_TOOL_ROUNDS = 6;

export class BuildingBrainAgent {
  private readonly openai: OpenAI;
  private readonly conversations = new Map<string, ChatMessage[]>();
  private readonly alerts: BrainAlert[] = [];
  private readonly systemPrompt: string;

  private previousComfortScore: number | null = null;
  private previousAlertCount = 0;
  private previousWeatherC: number | null = null;
  private ticksSinceLastEval = 0;

  constructor(
    private readonly platform: BelimoPlatform,
    openaiApiKey: string,
  ) {
    this.openai = new OpenAI({ apiKey: openaiApiKey });

    const blueprint = platform.getBlueprint();
    const zoneNames = blueprint.spaces.map((s) => `${s.id} ("${s.name}", ${s.geometry.area_m2}m²)`).join(", ");
    const deviceCount = blueprint.devices.length;
    const faults = platform.getAvailableFaults();
    const faultList = faults.map((f) => `${f.id} (${f.faultType} on ${f.deviceId})`).join(", ");

    this.systemPrompt = `You are the Building Brain for "${blueprint.building.name}", an AI facility management assistant powered by Belimo Pulse. You monitor a commercial HVAC system in ${blueprint.building.location.city}, ${blueprint.building.location.country} in real-time.

Building: ${blueprint.spaces.length} thermal zones, ${deviceCount} devices (actuators, sensors, rooftop unit).
Zones: ${zoneNames}.
Available fault simulations: ${faultList}.

Your role:
- Monitor building comfort, energy, and device health in real-time
- Interpret telemetry and explain conditions in plain, actionable language
- Detect anomalies: comfort drops, device degradation, mechanical obstructions, unusual energy patterns
- Recommend and execute control adjustments (mode changes, zone temperature offsets)
- When you detect a potential mechanical obstruction (high torque, tracking error), explain what might cause it (e.g., debris, a rodent, linkage failure) and suggest diagnostic steps

Comfort score: 0-100. Green ≥92, amber 78-91, red <78.
Device health: 0-100. Alerts list specific issues.

Guidelines:
- Be concise and direct. Lead with the most actionable insight.
- When you take an action (adjust temperature, change mode), always explain what you did and why.
- Use the tools to get current data before answering — don't guess.
- If a zone feels cold/hot, first check the data, then adjust the offset if appropriate.
- When multiple issues exist, prioritize by impact on occupant comfort.
- Reference specific numbers (temperatures, scores, airflow rates) to build trust.`;
  }

  async chat(message: string, conversationId?: string): Promise<ChatResponse> {
    const convId = conversationId ?? randomUUID();
    const history = this.conversations.get(convId) ?? [];

    const userMessage: ChatMessage = {
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    };
    history.push(userMessage);

    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: this.systemPrompt },
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    const actions: BrainAction[] = [];
    let finalContent = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const completion = await this.openai.chat.completions.create({
        model: "gpt-4.1",
        messages: openaiMessages,
        tools: brainToolDefinitions,
        tool_choice: "auto",
        temperature: 0.4,
        max_tokens: 1200,
      });

      const choice = completion.choices[0];

      if (!choice) {
        break;
      }

      const toolCalls = choice.message.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        finalContent = choice.message.content ?? "";
        break;
      }

      openaiMessages.push(choice.message);

      for (const toolCall of toolCalls) {
        if (toolCall.type !== "function") {
          continue;
        }

        const args = JSON.parse(toolCall.function.arguments || "{}");
        const result = await executeBrainTool(this.platform, toolCall.function.name, args);

        actions.push({
          tool: toolCall.function.name,
          input: args,
          result,
        });

        openaiMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }

      if (choice.finish_reason === "stop") {
        finalContent = choice.message.content ?? "";
        break;
      }
    }

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: finalContent,
      actions: actions.length > 0 ? actions : undefined,
      timestamp: new Date().toISOString(),
    };
    history.push(assistantMessage);
    this.conversations.set(convId, history);

    if (history.length > 40) {
      history.splice(1, history.length - 30);
    }

    return {
      message: assistantMessage,
      conversationId: convId,
      alerts: this.getActiveAlerts(),
    };
  }

  evaluateTick(snapshot: TwinSnapshot, _controls: RuntimeControlState): BrainAlert | null {
    this.ticksSinceLastEval++;

    if (this.ticksSinceLastEval < 3) {
      return null;
    }

    this.ticksSinceLastEval = 0;

    const currentComfort = snapshot.summary.averageComfortScore;
    const currentAlertCount = snapshot.summary.activeAlertCount;
    const currentWeatherC = snapshot.weather.temperatureC;

    let alert: BrainAlert | null = null;

    if (this.previousComfortScore !== null && this.previousComfortScore >= 78 && currentComfort < 78) {
      alert = {
        id: randomUUID(),
        severity: "warning",
        title: "Comfort Drop Detected",
        body: `Average comfort score dropped to ${currentComfort.toFixed(0)}% (was ${this.previousComfortScore.toFixed(0)}%). Worst zone: ${snapshot.summary.worstZoneId}.`,
        suggestedAction: "Check zone temperatures and device health.",
        timestamp: new Date().toISOString(),
        dismissed: false,
      };
    }

    if (!alert && currentAlertCount > this.previousAlertCount) {
      const newAlertCount = currentAlertCount - this.previousAlertCount;
      const unhealthyDevices = snapshot.devices.filter((d) => d.healthScore < 70);

      if (unhealthyDevices.length > 0) {
        const worst = unhealthyDevices.reduce((a, b) => (a.healthScore < b.healthScore ? a : b));
        alert = {
          id: randomUUID(),
          severity: worst.healthScore < 50 ? "critical" : "warning",
          title: `${newAlertCount} New Device Alert${newAlertCount > 1 ? "s" : ""}`,
          body: `${worst.deviceId} health at ${worst.healthScore}%. ${worst.alerts[0] ?? "Check device diagnostics."}`,
          suggestedAction: `Inspect ${worst.deviceId} — possible mechanical issue.`,
          timestamp: new Date().toISOString(),
          dismissed: false,
        };
      }
    }

    if (!alert && this.previousWeatherC !== null && Math.abs(currentWeatherC - this.previousWeatherC) > 5) {
      alert = {
        id: randomUUID(),
        severity: "info",
        title: "Significant Weather Change",
        body: `Outdoor temperature shifted from ${this.previousWeatherC.toFixed(1)}°C to ${currentWeatherC.toFixed(1)}°C. System may need mode adjustment.`,
        suggestedAction: "Consider switching to auto mode if not already.",
        timestamp: new Date().toISOString(),
        dismissed: false,
      };
    }

    this.previousComfortScore = currentComfort;
    this.previousAlertCount = currentAlertCount;
    this.previousWeatherC = currentWeatherC;

    if (alert) {
      this.alerts.push(alert);

      if (this.alerts.length > 50) {
        this.alerts.splice(0, this.alerts.length - 50);
      }
    }

    return alert;
  }

  getActiveAlerts(): BrainAlert[] {
    return this.alerts.filter((a) => !a.dismissed);
  }

  dismissAlert(alertId: string) {
    const alert = this.alerts.find((a) => a.id === alertId);

    if (alert) {
      alert.dismissed = true;
    }
  }
}
