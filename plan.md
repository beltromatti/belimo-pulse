Belimo Pulse — Implementation Plan

     Context

     START Hack 2026 for Belimo. The backend (physics engine, digital twin, sandbox simulation, DB
     persistence, WebSocket streaming) and frontend (3D building viz, control panel, device models) are
     ~70% complete. Two critical gaps remain: the AI building brain (zero LLM code exists despite
     OPENAI_API_KEY in config) and 3D visual polish. User wants both done in parallel. LLM: GPT-5.4 (or
     best available OpenAI model).

     ---
     Workstream 1: AI Building Brain + Chat

     Step 1 — Install OpenAI SDK

     cd backend && npm install openai

     Step 2 — Create AI types

     New file: backend/src/ai/types.ts
     - ChatMessage { role, content, actions?, timestamp, conversationId }
     - BrainAlert { id, severity, title, body, suggestedAction?, timestamp, dismissed }
     - BrainToolResult { toolName, input, output }

     Step 3 — Define AI tools

     New file: backend/src/ai/tools.ts

     8 OpenAI function-calling tools wrapping BelimoPlatform methods:

     ┌────────────────────────────────────┬──────────────┬─────────────────────────────────────────────┐
     │                Tool                │ Reads/Writes │               Platform method               │
     ├────────────────────────────────────┼──────────────┼─────────────────────────────────────────────┤
     │ get_building_summary               │ Read         │ platform.getLatestTwinState() → summary +   │
     │                                    │              │ derived + weather                           │
     ├────────────────────────────────────┼──────────────┼─────────────────────────────────────────────┤
     │ get_zone_details(zoneId)           │ Read         │ snapshot.zones[] + blueprint.spaces[]       │
     ├────────────────────────────────────┼──────────────┼─────────────────────────────────────────────┤
     │ get_device_health(deviceId)        │ Read         │ snapshot.devices[] (DeviceDiagnosis)        │
     ├────────────────────────────────────┼──────────────┼─────────────────────────────────────────────┤
     │ adjust_zone_temperature(zoneId,    │ Write        │ platform.updateControls({                   │
     │ offsetC)                           │              │ zoneTemperatureOffsetsC }, "ai-brain")      │
     ├────────────────────────────────────┼──────────────┼─────────────────────────────────────────────┤
     │ set_facility_mode(mode)            │ Write        │ platform.updateControls({                   │
     │                                    │              │ sourceModePreference }, "ai-brain")         │
     ├────────────────────────────────────┼──────────────┼─────────────────────────────────────────────┤
     │ toggle_fault(faultId, mode)        │ Write        │ platform.updateControls({ faultOverrides }, │
     │                                    │              │  "ai-brain")                                │
     ├────────────────────────────────────┼──────────────┼─────────────────────────────────────────────┤
     │ get_weather                        │ Read         │ snapshot.weather                            │
     ├────────────────────────────────────┼──────────────┼─────────────────────────────────────────────┤
     │ get_comfort_history(zoneId, limit) │ Read         │ listRecentZoneTwinObservations() from db.ts │
     └────────────────────────────────────┴──────────────┴─────────────────────────────────────────────┘

     Step 4 — Build the BuildingBrainAgent class

     New file: backend/src/ai/agent.ts

     class BuildingBrainAgent {
       constructor(platform: BelimoPlatform, openaiApiKey: string)

       // Main chat — handles tool call loops (max 5 iterations)
       async chat(message: string, conversationId?: string): Promise<ChatMessage>

       // Called each tick — checks comfort drops, device health, new alerts, weather shifts
       evaluateTick(snapshot: TwinSnapshot, controls: RuntimeControlState): BrainAlert | null

       getActiveAlerts(): BrainAlert[]
       dismissAlert(alertId: string): void
     }

     - Conversations stored in-memory Map<string, ChatMessage[]>
     - System prompt populated from platform.getBlueprint() (building name, zone names, device count)
     - Model: "gpt-4.1" (or "gpt-5.4" when available in SDK — use best available)

     Step 5 — Wire into server

     Modify: backend/src/server.ts

     1. Construct BuildingBrainAgent after platform (after line 70)
     2. Add POST /api/chat — accepts { message, conversationId? }, returns AI response
     3. Add GET /api/brain/alerts — returns active alerts
     4. Add POST /api/brain/alerts/:id/dismiss
     5. In platform.onTick() callback (line 309), call brainAgent.evaluateTick() and broadcast
     brain_alert via WebSocket

     Modify: backend/src/runtime-types.ts
     - Add brain_alert to RuntimeSocketMessage union type

     Step 6 — Frontend chat proxy

     New file: frontend/src/app/api/chat/route.ts
     - Same pattern as frontend/src/app/api/runtime/control/route.ts — proxy POST to backend

     Step 7 — Frontend ChatPanel component

     New file: frontend/src/components/chat-panel.tsx

     - Collapsible drawer (fixed bottom-right, overlays on top)
     - Message bubbles (user right-aligned, AI left-aligned)
     - Action cards when AI executes tools
     - Quick action buttons: "Building Status", "Run Diagnostics", "Optimize Comfort"
     - Alert toast when brain_alert arrives via WebSocket
     - Glass-morphism style matching existing panels

     Step 8 — Integrate into RuntimeShell

     Modify: frontend/src/components/runtime-shell.tsx
     - Import and render <ChatPanel>
     - Handle brain_alert WebSocket messages in existing handler
     - Pass alerts state to ChatPanel

     Modify: frontend/src/lib/runtime-types.ts
     - Add ChatMessage, BrainAlert types
     - Add brain_alert to RuntimeSocketMessage

     ---
     Workstream 2: 3D Visual Polish

     All changes in frontend/src/components/:

     Step 1 — Thermal heatmap floor overlay (highest visual impact)

     Modify: runtime-scene.tsx
     - New ThermalOverlay component inside each room
     - Maps zone temperature to blue→green→yellow→red gradient
     - Semi-transparent plane (opacity 0.35) slightly above floor
     - Subtle pulse animation via useFrame

     Step 2 — Device fault visualization

     Modify: runtime-scene.tsx
     - New DeviceHealthIndicator component wrapping each device
     - When healthScore < 85: translucent red pulsing sphere around device
     - When healthScore < 60: faster pulse + "!" HTML badge
     - Build Map<deviceId, DeviceDiagnosis> from twin.devices

     Step 3 — Comfort score ambient glow

     Modify: runtime-scene.tsx
     - pointLight per room colored by comfort score
     - Green (>92), amber (78-92), red (<78)
     - Low intensity (0.3-1.0) so it's subtle not overwhelming

     Step 4 — Lighting & environment

     Modify: runtime-scene.tsx
     - Add <Environment preset="city" /> from drei (subtle reflections)
     - Second fill directional light from opposite side (intensity 0.4)
     - Optional: soft shadows on floor (512x512 shadow map for performance)

     Step 5 — Material upgrades

     Modify: runtime-device-models/shared.tsx
     - Increase metalness on steel parts (0.34→0.55)
     - Lower roughness on housing
     - Add envMapIntensity on Belimo orange housing

     Step 6 — Duct improvements

     Modify: runtime-scene.tsx
     - Metallic material on ducts (metalness 0.42, roughness 0.35)
     - Smooth junction fittings at trunk-branch intersections

     ---
     Execution Order (hackathon speed)

     Workstream 1 (AI Brain) — you or teammate:
     1. Steps 2+3 (types + tools) — 30 min
     2. Step 4 (agent core) — 60 min
     3. Step 5 (server wiring) — 20 min
     4. Steps 6+7 (frontend proxy + chat) — 45 min
     5. Step 8 (shell integration) — 15 min
     Total: ~3 hours

     Workstream 2 (3D Polish) — other person:
     1. Step 1 (thermal heatmap) — 30 min — biggest wow
     2. Step 2 (fault glow) — 25 min — demo critical
     3. Step 3 (comfort glow) — 15 min
     4. Step 4 (lighting/env) — 20 min
     5. Steps 5+6 (materials/ducts) — 20 min
     Total: ~2 hours

     ---
     Critical Files

     ┌──────────────────────────────────────────────────────────┬─────────┬────────────────────────────┐
     │                           File                           │  Who    │        What changes        │
     │                                                          │ touches │                            │
     ├──────────────────────────────────────────────────────────┼─────────┼────────────────────────────┤
     │ backend/src/ai/types.ts                                  │ WS1     │ New — AI types             │
     ├──────────────────────────────────────────────────────────┼─────────┼────────────────────────────┤
     │ backend/src/ai/tools.ts                                  │ WS1     │ New — 8 tool definitions   │
     ├──────────────────────────────────────────────────────────┼─────────┼────────────────────────────┤
     │ backend/src/ai/agent.ts                                  │ WS1     │ New — BuildingBrainAgent   │
     │                                                          │         │ class                      │
     ├──────────────────────────────────────────────────────────┼─────────┼────────────────────────────┤
     │ backend/src/server.ts                                    │ WS1     │ Add chat + alerts          │
     │                                                          │         │ endpoints, hook into tick  │
     ├──────────────────────────────────────────────────────────┼─────────┼────────────────────────────┤
     │ backend/src/runtime-types.ts                             │ WS1     │ Add brain_alert WS message │
     │                                                          │         │  type                      │
     ├──────────────────────────────────────────────────────────┼─────────┼────────────────────────────┤
     │ backend/src/platform.ts                                  │ Neither │ Read-only — already has    │
     │                                                          │         │ all needed methods         │
     ├──────────────────────────────────────────────────────────┼─────────┼────────────────────────────┤
     │ frontend/src/components/chat-panel.tsx                   │ WS1     │ New — chat UI              │
     ├──────────────────────────────────────────────────────────┼─────────┼────────────────────────────┤
     │ frontend/src/components/runtime-shell.tsx                │ WS1     │ Add ChatPanel +            │
     │                                                          │         │ brain_alert handler        │
     ├──────────────────────────────────────────────────────────┼─────────┼────────────────────────────┤
     │                                                          │         │ Thermal overlay, fault     │
     │ frontend/src/components/runtime-scene.tsx                │ WS2     │ glow, comfort glow,        │
     │                                                          │         │ lighting                   │
     ├──────────────────────────────────────────────────────────┼─────────┼────────────────────────────┤
     │ frontend/src/components/runtime-device-models/shared.tsx │ WS2     │ Material upgrades          │
     ├──────────────────────────────────────────────────────────┼─────────┼────────────────────────────┤
     │ frontend/src/lib/runtime-types.ts                        │ WS1     │ Add ChatMessage,           │
     │                                                          │         │ BrainAlert types           │
     └──────────────────────────────────────────────────────────┴─────────┴────────────────────────────┘

     No file conflicts between workstreams.

     ---
     Verification

     1. Backend AI: curl -X POST localhost:8080/api/chat -H 'Content-Type: application/json' -d
     '{"message":"What is the current building status?"}' — should return AI summary with zone temps,
     comfort scores, active alerts
     2. Proactive alerts: Wait for fault activation (1200s runtime) — should see brain_alert WebSocket
     message
     3. 3D thermal: Open frontend, check rooms have colored floor overlays matching their temperatures
     4. 3D fault glow: Force-on a fault via control panel → device should pulse red
     5. End-to-end: Chat "the meeting room feels cold" → AI should adjust zone offset and explain




Right now the backend still treats Belimo Brain as two entrypoints, chat() and handleTick(), not as
  the operating system of the building in backend/src/ai/agent.ts:121 and backend/src/ai/agent.ts:159.
  Controls are still just direct writes through backend/src/platform.ts:135, the tool surface is still
  narrow in backend/src/ai/tools.ts:10, and the frontend still presents the brain mostly as a chat/alert
  surface in frontend/src/components/runtime-shell.tsx:124 and frontend/src/components/chat-
  panel.tsx:18.

  The right direction is: Belimo Brain should not be a chatbot with some tools. Chat should be only one
  ingress into a persistent policy-and-decision system.

  Best Model

  - Use one durable source of truth: Postgres.
  - Keep in-memory state only as cache, never as memory.
  - Do not store “AI context” separately from DB. Instead store:
      - raw conversation messages for audit/history,
      - structured operator intents and policies for execution,
      - brain decisions and outcomes for learning/explanation.
  - That is not bad duplication. It is one storage system with raw events plus normalized projections.

  What To Persist

  - conversation messages
      - Raw user/assistant history.
      - Useful for audit and operator review.
  - operator policies
      - Canonical building instructions extracted from chat.
      - Example: “Office 21.5°C weekdays 08:00-18:00.”
  - brain facts
      - Long-lived context that is not directly a schedule.
      - Example: “Facility manager prioritizes comfort over energy during client demos.”
  - brain decisions
      - What Belimo Brain decided, why, and what controls it applied.
  - brain commands
      - Future-facing queue/contract for real HVAC integration.
      - Not for MCP now, just the contract.

  Do Not Use pulse_facility_preferences For Everything
  [pulse_facility_preferences is currently just the effective runtime controls path in backend/src/
  platform.ts:63 and backend/src/platform.ts:135. It should stay close to “current applied state,” not
  become the whole memory model.]

  Use this split instead:

  - operator_policies
      - High-level intent from humans.
  - effective_controls
      - What the building should be doing right now.
  - control_events
      - What was actually changed.
  - brain_decisions
      - Why it was changed.

  That separation is what makes the brain feel real.

  How The Flow Should Work

  1. User sends natural language.
  2. Belimo Brain extracts structured intents from it.
  3. Those intents are persisted as policies/facts, linked back to the source message.
  4. A policy engine resolves what is active now.
  5. The planner loop reads:
      - live twin state,
      - recent telemetry history,
      - active policies,
      - prior decisions,
      - unresolved alerts.
  6. It computes the best next action.
  7. It writes:
      - decision log,
      - effective control update,
      - optional operator alert.
  8. Sandbox HVAC applies the control through the existing platform path.
  9. Later, a real HVAC adapter can read the same effective-control/command contract.

  Example
  User says: “Keep the meeting room at 22°C from 9 to 5 on weekdays, but save energy after hours.”

  Belimo Brain should do all of this:

  - store the raw message,
  - extract a temperature_schedule policy for meeting-room,
  - extract an energy_strategy policy for after-hours,
  - confirm back to the user what it stored,
  - use those policies in future proactive analysis,
  - apply the right control behavior when that time window becomes active,
  - record its later decisions against that policy.

  The chat itself is not the feature. The stored policy is the feature.

  What To Build In This Repo

  - Add a new backend layer, not just more prompt logic.
  - Suggested modules:
      - backend/src/brain/policies.ts
      - backend/src/brain/context.ts
      - backend/src/brain/planner.ts
      - backend/src/brain/memory.ts
      - backend/src/brain/decision-log.ts
  - Keep backend/src/ai/agent.ts as the LLM orchestration layer, but move durable business logic out of
    it.

  Suggested Tables

  - pulse_operator_policies
      - id, building_id, scope_type, scope_id, policy_type, policy_json, priority, status,
        source_message_id, starts_at, ends_at, recurrence, timezone
  - pulse_brain_facts
      - id, building_id, fact_type, summary, fact_json, confidence, source_message_id, expires_at
  - pulse_brain_decisions
      - id, building_id, decision_type, reason_summary, context_json, proposed_controls_json,
        applied_controls_json, source, source_message_id
  - pulse_brain_commands
      - id, building_id, command_type, payload_json, status, issued_at, acknowledged_at

  Why This Is Better Than “Two Storages”

  - One database.
  - Different tables for different meanings.
  - Raw chat is not the same thing as executable policy.
  - If you only keep chat, the brain is fuzzy.
  - If you only keep policy, you lose audit/history.
  - Best design is raw event + structured projection in the same Postgres system.

  Frontend
  The floating chat can stay, but it should stop being the main expression of the brain.
  Add a persistent “Belimo Brain” surface with:

  - current operating objective,
  - active schedules/policies,
  - latest decisions,
  - unresolved alerts,
  - why the system changed something,
  - what it plans next.

  That is what makes it feel like the building’s brain, not a support bot.

  Best Hackathon Scope
  I would not jump to real-HVAC execution yet. The highest-value next step is:

  1. Structured operator policy persistence.
  2. Context assembler that loads policies/facts/history for Belimo Brain.
  5. UI panel for active policies and recent decisions.

  That is the minimum architecture that makes Belimo Brain feel like the control intelligence of the
  building.

  If you want, I can implement phase 1 next:

  - pulse_operator_policies
  - intent extraction from chat into structured policies
  - DB-backed context loading for future agent runs
  - no MCP work
  - no risky runtime rewrites


› sure, lets do it
• I’m implementing phase 1 as a backend-first change: durable operator policies, intent extraction from
  chat, and DB-backed context loading for future Belimo Brain runs. I’m checking the current chat and
  type boundaries first so I can add this without destabilizing the runtime path.

• Updated Plan
    □ Add DB schema and persistence helpers for operator policies and policy-aware context loading
    □ Extend Belimo Brain chat flow to extract policies from user messages, persist them, and load
      active policies into future prompts
    □ Expose active policies to the runtime/bootstrap API and add a minimal frontend surface for them
    □ Run backend build/tests and frontend lint/build verification