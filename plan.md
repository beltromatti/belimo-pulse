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
