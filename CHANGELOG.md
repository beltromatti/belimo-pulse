# Changelog

## 2026-03-19 — AI Building Brain + 3D Visual Polish

### AI Building Brain (Backend)

**New: `backend/src/ai/`** — Complete AI agent module powered by OpenAI GPT-4.1 with function calling.

- **Agent** (`agent.ts`) — `BuildingBrainAgent` class that:
  - Accepts natural language from the facility manager via `POST /api/chat`
  - Maintains per-conversation history in memory (auto-trimmed at 40 messages)
  - Executes up to 6 tool-call rounds per request before returning a final response
  - Runs proactive evaluation every 3 ticks to detect comfort drops, device health degradation, weather shifts
  - Broadcasts `brain_alert` WebSocket messages when anomalies are detected
  - System prompt is auto-populated from the building blueprint (zone names, device count, fault profiles)

- **Tools** (`tools.ts`) — 8 function-calling tools the AI can invoke:

  | Tool | Type | What it does |
  |------|------|-------------|
  | `get_building_summary` | Read | Full building snapshot: comfort, weather, energy, zones, flagged devices |
  | `get_zone_details` | Read | Zone temperature, humidity, CO2, airflow, occupancy, comfort targets |
  | `get_device_health` | Read | Device health score, alerts, telemetry metrics |
  | `adjust_zone_temperature` | Write | Set zone temperature offset (-3 to +3 C) |
  | `set_facility_mode` | Write | Change HVAC mode (auto/cooling/heating/economizer/ventilation) |
  | `toggle_fault` | Write | Activate/deactivate fault simulations for demo |
  | `get_weather` | Read | Current outdoor conditions from Open-Meteo |
  | `get_comfort_history` | Read | Recent zone comfort time series from database |

- **Types** (`types.ts`) — `ChatMessage`, `BrainAction`, `BrainAlert`, `ChatResponse`

**Modified: `backend/src/server.ts`**
- `POST /api/chat` — Chat endpoint accepting `{ message, conversationId? }`
- `GET /api/brain/alerts` — Active (undismissed) alerts
- `POST /api/brain/alerts/:id/dismiss` — Dismiss an alert
- Tick listener now calls `brainAgent.evaluateTick()` and broadcasts alerts via WebSocket

**Modified: `backend/src/runtime-types.ts`**
- Added `WebSocketBrainAlertMessage` to `RuntimeSocketMessage` union

**Dependency: `openai@6.32.0`** added to backend.

---

### Chat Interface (Frontend)

**New: `frontend/src/components/chat-panel.tsx`**
- Floating chat button (bottom-right, Belimo orange) with alert badge count
- Collapsible 380x560px drawer with glass-morphism styling
- Message bubbles: user (dark, right-aligned), assistant (white, left-aligned)
- Tool action pills shown below AI responses (e.g., "get building summary", "adjust zone temperature")
- Quick action buttons on empty state: "Building Status", "Run Diagnostics", "Optimize Comfort"
- Alert banner showing recent brain alerts with dismiss buttons
- Loading animation (bouncing dots) during AI response
- Auto-scroll to latest message

**New: `frontend/src/app/api/chat/route.ts`** — Proxy to backend `/api/chat`

**New: `frontend/src/app/api/brain/alerts/[id]/dismiss/route.ts`** — Proxy to backend dismiss endpoint

**Modified: `frontend/src/components/runtime-shell.tsx`**
- Added `brainAlerts` state and `brain_alert` WebSocket handler
- Renders `<ChatPanel>` with alerts and dismiss callback

**Modified: `frontend/src/lib/runtime-types.ts`**
- Added `ChatMessage`, `BrainAction`, `BrainAlert` types
- Added `brain_alert` to `RuntimeSocketMessage` union

---

### 3D Visual Improvements (Frontend)

**Modified: `frontend/src/components/runtime-scene.tsx`**

- **Thermal Heatmap Overlay** — Semi-transparent color plane on each room floor. Maps zone temperature to blue (cold) -> green (comfortable) -> yellow (warm) -> red (hot) gradient. Subtle opacity pulse animation via `useFrame`.

- **Device Health Indicator** — Wraps each device in the scene. When `healthScore < 85`: pulsing translucent red sphere. When `healthScore < 60`: faster pulse + floating "!" badge. Pulse speed increases with severity.

- **Comfort Glow** — `pointLight` per room colored by comfort score. Green (>=92), amber (78-91), red (<78). Intensity scales with severity. Light distance bounded to room width.

- **Improved Lighting** — Added warm fill directional light from opposite side (intensity 0.4, warm tint `#fef3c7`) to reduce harsh single-source shadows. Slightly reduced ambient/hemisphere intensity for better contrast.

- **Metallic Duct Materials** — Upgraded duct `metalness` from 0.18 to 0.38, `roughness` from 0.5 to 0.4 for a more realistic galvanized sheet metal appearance.

---

### Configuration

The AI brain requires `OPENAI_API_KEY` in the backend `.env` (already part of the existing config schema). No new environment variables needed.

To switch to GPT-5.4 when available, change the model string in `backend/src/ai/agent.ts` line 98.
