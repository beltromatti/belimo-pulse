Start Hackathon 2026

## Backend
- Node.js
- TypeScript
- Express.js
- Docker
- AWS EC2 deploy
- Supabase Postgres

## Frontend
- Next.js
- React
- TypeScript
- Tailwind CSS
- Vercel deploy

## Runtime
- Backend public health: `http://18.195.64.10/health`
- Frontend production: `https://belimo-pulse.vercel.app`
- Frontend bridge route: `POST /api/bridge/test`
- Database table created on startup: `pulse_healthchecks`

## Deploy
- Push su `main` soltanto
- GitHub Actions job `build_image` builda il backend e pubblica l'immagine su GHCR
- GitHub Actions job `deploy` fa pull sul server AWS, mette online il container e rimuove le immagini backend obsolete
- Il frontend usa il Git integration nativo di Vercel sul repository `beltromatti/belimo-pulse`


 Plan: AI Agent System for ActuatorIQ — Honest Engineering Assessment                             
                                                                                                
 Context                                                                                          
                                                                                                  
 You have real actuator data, 5 working diagnostic algorithms, and a health score. The question   
 is: can you build an AI agent system that autonomously diagnoses actuators, and will it win the  
 hackathon?

 Short answer: Yes, but with pragmatic scope. Here's what's real vs what's hype, and the exact
 build order.

 ---
 Honest Feasibility Assessment

 What's genuinely buildable (3-5 hours)

 1. MCP Server wrapping InfluxDB + analysis functions → FastMCP in Python
 2. Claude API agent that calls those tools and produces natural language diagnostics
 3. Streamlit UI with chat + live actuator sidebar

 What's risky

 ┌────────────────┬──────────────────────┬──────────────────────────────────────────────────┐
 │      Risk      │        Impact        │                    Mitigation                    │
 ├────────────────┼──────────────────────┼──────────────────────────────────────────────────┤
 │ WiFi to Pi     │ Agent can't read     │ Pre-cache CSVs + report JSON. Agent works with   │
 │ drops during   │ live data            │ cached data as fallback                          │
 │ demo           │                      │                                                  │
 ├────────────────┼──────────────────────┼──────────────────────────────────────────────────┤
 │ Full sweep     │                      │ Don't run full sweep in demo. Use pre-collected  │
 │ takes 9 min    │ Judges won't wait    │ data. Do ONE small move (e.g., 0→50) to show     │
 │                │                      │ physical control                                 │
 ├────────────────┼──────────────────────┼──────────────────────────────────────────────────┤
 │ Claude API     │ 3-5s per tool call   │ Stream responses. Show "thinking" steps visually │
 │ latency        │ chain                │                                                  │
 ├────────────────┼──────────────────────┼──────────────────────────────────────────────────┤
 │ Claude API     │ Demo breaks          │ Pre-warm the conversation. Have a recorded       │
 │ rate limit     │ mid-presentation     │ backup                                           │
 └────────────────┴──────────────────────┴──────────────────────────────────────────────────┘

 What the "swarm" actually is

 The AI agent proposal talks about 4 agents (Observer, Diagnostician, Advisor, Controller). In
 reality, this is one Claude API call with tool_use. Claude naturally switches roles based on
 which tools it calls. The "swarm" framing is good for the presentation but the implementation is
  just: give Claude tools, let it chain them.

 What's missing from the current plan

 1. No faulty data for comparison — You only have healthy/unloaded sweeps. The "money shot"
 (healthy vs faulty) requires running a sweep while physically resisting the shaft. Without this,
  the demo is "here's a healthy actuator" which is less compelling.
 2. Cost estimation needs grounding — The agent should compute from actual data:
 hunting_energy_waste = overshoot_pct × cycles_per_hour × motor_power × hours_per_year. Not a
 made-up number.
 3. Electronics analysis not integrated — analysis_v2.py doesn't process electronics experiment
 output. The agent needs to read the electronics report JSON directly.

 ---
 Build Plan (in execution order)

 Step 1: Install dependencies (~5 min)

 File: experiments/requirements.txt — add:
 fastmcp>=2.0.0
 anthropic>=0.52.0
 streamlit>=1.45.0
 altair>=5.0.0

 Run: cd experiments && source venv/bin/activate && pip install fastmcp anthropic streamlit
 altair

 Step 2: MCP Server (experiments/mcp_server.py) — ~1.5 hours

 A FastMCP server exposing these tools:

 Read tools (safe, no side effects):
 - read_telemetry(n: int = 10) → Latest N telemetry readings from InfluxDB
 - get_health_report() → Returns report_v2.json contents
 - get_electronics_report() → Returns electronics report JSON
 - get_experiment_data(experiment: str) → Returns CSV data as JSON for a specific experiment
 - list_experiments() → Lists available experiment files

 Analysis tools:
 - analyze_sweep(csv_path: str) → Runs analysis_v2 on sweep data, returns diagnostic JSON
 - analyze_hunting(csv_path: str) → Runs hunting analysis, returns result JSON

 Control tools (physical actuator movement):
 - move_actuator(position: float, test_number: int) → Sends setpoint to actuator
 - run_quick_sweep(test_number: int) → Runs a FAST single sweep (1 repeat, 25 steps) — ~2 min
 instead of 9

 Advisory tools (pure computation, no I/O):
 - estimate_energy_waste(hunting_score: float, building_zones: int, hours_per_day: float) →
 Computes annual CHF waste from hunting. Formula: zones × (hunting_score/100) × 0.024 kWh/cycle ×
  cycles_per_hour × hours × 365 × CHF_per_kWh
 - estimate_maintenance_savings(health_score: int, n_actuators: int) → Computes avoided emergency
  repair costs
 - compare_profiles(baseline_test: int, current_test: int) → Loads two sweep CSVs, computes
 torque drift, friction change, health delta

 Implementation: Import from experiments.py (write_setpoint, read_latest), analysis_v2.py
 (analyze_sweep, analyze_hunting), and read report JSONs from experiment_data/.

 The MCP server wraps existing functions — no new analysis logic needed. The key is: every
 function that already exists in experiments.py and analysis_v2.py just gets a thin MCP tool
 wrapper.

 Step 3: Agent Script (experiments/agent.py) — ~1 hour

 Simple script using anthropic SDK:
 - System prompt: "You are ActuatorIQ, an AI diagnostic system for Belimo HVAC actuators..."
 - Loads MCP tools from the server
 - Sends user message + tools to Claude API
 - Streams response, executing tool calls as they come
 - Prints tool call names visibly so judges see the "thinking chain"

 This is ~100 lines of code. The intelligence comes from Claude + the tools, not from
 orchestration logic.

 Step 4: Streamlit Dashboard (experiments/dashboard.py) — ~2 hours

 Layout:
 ┌─────────────────────────────────────┬──────────────────┐
 │                                     │ ACTUATOR STATUS   │
 │   💬 Chat with ActuatorIQ          │ Position: 50.2%   │
 │                                     │ Torque: 0.7 Nmm   │
 │   User: Check this actuator        │ Power: 0.15 W      │
 │                                     │ Temp: 29.8°C       │
 │   🤖 Reading telemetry...          │                    │
 │   🤖 Analyzing sweep data...       │ HEALTH: 75/100 [B] │
 │   🤖 Health score: 75/100 (B)     │ ████████░░          │
 │   Linkage: TIGHT ✓                 │                    │
 │   Friction: SMOOTH ✓               │ Sizing: ── (unloaded)│
 │   Hunting risk: MODERATE ⚠         │ Linkage: ✓         │
 │   ...                              │ Friction: ✓        │
 │                                     │ Hunting: ⚠ 55/100 │
 │   User: Show the torque curve      │                    │
 │   🤖 [Altair chart renders]       │                    │
 │                                     │                    │
 ├─────────────────────────────────────┤                    │
 │ [Type a message...]          [Send] │                    │
 └─────────────────────────────────────┴──────────────────┘

 Uses st.chat_message for conversation, st.sidebar for live status. The sidebar polls InfluxDB
 every 2s for live telemetry (or shows cached data if offline).

 Charts: Altair plots for torque-position curve, power map, hunting frequency response — rendered
  inline in chat when the agent references them.

 Step 5: Demo Preparation

 Pre-collect this data before the presentation:
 1. Healthy sweep (test 100) — already have
 2. Faulty sweep (test 400 with hand resistance) — NEED TO RUN
 3. Electronics experiment (test 500) — running now
 4. Have report_v2.json and electronics report ready

 Demo script (3 turns, ~3 minutes):

 Turn 1: "Check this actuator's health."
 → Agent reads report, summarizes health score, flags hunting risk at 0.05 Hz.

 Turn 2: "Move the actuator to 75% and back to show it's working."
 → Actuator physically moves on the table. Takes 10 seconds. Judges see it.

 Turn 3: "What would this cost a building owner if left unaddressed?"
 → Agent calls estimate_energy_waste with real numbers, outputs CHF/year.

 Backup if WiFi fails: Agent works entirely from cached report_v2.json + CSVs. No live InfluxDB
 needed for the core diagnostic conversation.

 ---
 Files to create/modify

 ┌──────────────────────────────┬────────┬─────────────────────────────────────────────┐
 │             File             │ Action │                   Purpose                   │
 ├──────────────────────────────┼────────┼─────────────────────────────────────────────┤
 │ experiments/requirements.txt │ Edit   │ Add fastmcp, anthropic, streamlit, altair   │
 ├──────────────────────────────┼────────┼─────────────────────────────────────────────┤
 │ experiments/mcp_server.py    │ Create │ FastMCP server wrapping InfluxDB + analysis │
 ├──────────────────────────────┼────────┼─────────────────────────────────────────────┤
 │ experiments/agent.py         │ Create │ Claude API agent with tool_use              │
 ├──────────────────────────────┼────────┼─────────────────────────────────────────────┤
 │ experiments/dashboard.py     │ Create │ Streamlit chat UI + live sidebar            │
 └──────────────────────────────┴────────┴─────────────────────────────────────────────┘

 No changes needed to: experiments.py, analysis_v2.py, experiment_electronics.py — these are
 stable and the MCP server imports from them.

 ---
 What makes this win (engineering perspective)

 Creativity (35%): No team will have an AI that physically controls the actuator AND interprets
 the results. The combination of tool_use + physical hardware control is genuinely novel in HVAC.

 Technical feasibility (35%): Every component exists and works. The analysis algorithms are
 validated against real data. The MCP server is a thin wrapper, not new science. The risky part
 (live demo) has a cached fallback.

 Business feasibility (20%): The cost estimation tool grounds the value in real numbers. "CHF
 3,800/year per building from hunting alone" is defensible if derived from actual overshoot data
 × published energy costs.

 Presentation (10%): Three-turn live conversation beats 20 slides. The actuator moving on command
  is memorable.

 ---
 Verification

 1. cd experiments && source venv/bin/activate
 2. pip install fastmcp anthropic streamlit altair
 3. python mcp_server.py — should start MCP server, list tools
 4. python agent.py "What is the actuator health score?" — should return natural language answer
 from report_v2.json
 5. streamlit run dashboard.py — should show chat UI + sidebar
 6. In chat: type "Check actuator health" → should see tool call chain + diagnosis
 7. If on WiFi: "Move actuator to 25%" → actuator physically moves