# ActuatorIQ — Developer Handoff Guide

## What Is This Project?

We're at **START Hack 2026** building **ActuatorIQ** — an AI diagnostic system for **Belimo HVAC actuators**. We have a physical actuator on the table connected to a Raspberry Pi. Our system reads actuator signals (torque, position, power, temperature), runs diagnostic algorithms, and uses Claude AI to interpret results in natural language.

**One-line pitch:** "One sweep of the actuator tells you everything about the installation — sizing, linkage, friction, health, and hunting risk — with zero extra hardware."

---

## The Hardware Setup

```
Your Laptop ←── WiFi (BELIMO-X) ──→ Raspberry Pi 5 ←── Serial (MP-Bus) ──→ Belimo Actuator
                                          │
                                     InfluxDB 2.x
                                   192.168.3.14:8086
```

- **WiFi SSID:** `BELIMO-X` (X = number on Pi label), password: `raspberry`
- **InfluxDB UI:** http://192.168.3.14:8086 (user: `pi`, pass: `raspberry`)
- **Bucket:** `actuator-data`
- **Two measurements:** `measurements` (telemetry IN), `_process` (commands OUT)
- **Data does NOT persist on Pi reboot** — export CSVs during your session

### How Commands Work

You don't talk to the actuator directly. You write to InfluxDB, the Pi's logger reads it and sends it to the actuator via MP-Bus:

```python
# Write a setpoint — actuator physically moves
write_setpoint(position=75.0, test_number=100)

# Read latest telemetry
df = read_latest(n=10)  # returns: position, torque, power, temp, direction
```

All commands use **epoch timestamp** (`1970-01-01T00:00:00Z`) to avoid clock sync issues.

---

## What We've Built So Far

### Layer 1: Experiments & Analysis (`experiments/`)

**4 automated experiments** that drive the actuator and collect data:

| Experiment | Command | What it does | Time |
|-----------|---------|-------------|------|
| Sweep | `python experiments.py --experiment sweep --test-number 100` | Full 0→100→0 stroke, measures torque-position curve | ~9 min |
| Steps | `python experiments.py --experiment steps --test-number 200` | Discrete jumps (25%, 50%, 75%), measures transit time & overshoot | ~4 min |
| Hunting | `python experiments.py --experiment hunting --test-number 300` | Oscillating setpoints at 4 frequencies, measures tracking ability | ~5 min |
| Electronics | `python experiment_electronics.py --test-number 500` | Power map across full stroke, idle power, stroke consistency | ~8 min |

**5 diagnostic algorithms** (`analysis_v2.py`):

1. **Sizing Check** — `max_torque / rated_torque` → oversized/undersized/OK
2. **Linkage/Dead Band** — finds position where torque first exceeds 10% of max
3. **Friction Map** — bins 0-100% into 20 segments, flags bins >1.5x running mean
4. **Hunting Risk** — FFT + overshoot + tracking error → risk score 0-100
5. **Health Score** — weighted composite: sizing(25) + linkage(20) + friction(20) + transit(15) + symmetry(20) = 100

**Data we've collected** (in `experiments/experiment_data/`):

| File | What |
|------|------|
| `sweep_test100.csv` | Healthy baseline sweep (300 rows) |
| `sweep_test400.csv` | Second sweep for comparison (300 rows) |
| `steps_test200.csv` | Step response data (391 rows) |
| `hunting_test300.csv` | Oscillation test at 4 frequencies (797 rows) |
| `thermal_test400.csv` | Temperature rise under continuous load (574 rows) |
| `report_v2.json` | **Current analysis results** — health 75/100, grade B |

**Key findings from `report_v2.json`:**
- Health: 75/100 (Grade B)
- Linkage: TIGHT (0% dead band) ✓
- Friction: SMOOTH (0.867 smoothness) ✓
- Step Response: CRISP (0% overshoot) ✓
- Hunting: MODERATE_RISK (55/100) ⚠ — resonance at 0.05 Hz with 13.2% overshoot
- Actuator is unloaded (demo rig, no valve attached)

### Layer 2: AI Agent System (`backend/mcp/`)

**MCP Server** (`mcp_server.py`) — 12 tools exposed via FastMCP:

| Tool | Type | What it does |
|------|------|-------------|
| `read_telemetry(n)` | Read | Live sensor data from Pi via InfluxDB |
| `get_health_report()` | Read | Returns `report_v2.json` — the pre-computed diagnostics |
| `get_electronics_report()` | Read | Returns electronics experiment report |
| `list_experiments()` | Read | Lists available CSV/JSON files |
| `get_experiment_data(filename, head)` | Read | Loads a specific CSV as JSON |
| `analyze_sweep(csv_filename)` | Analysis | Runs all 5 diagnostics on a sweep CSV |
| `analyze_hunting(csv_filename)` | Analysis | Runs hunting risk analysis |
| `move_actuator(position, test_number)` | Control | **Physically moves the actuator** |
| `run_quick_sweep(test_number)` | Control | Runs a fast 2-min sweep (1 repeat, 25 steps) |
| `estimate_energy_waste(hunting_score, ...)` | Advisory | Computes CHF/year from hunting |
| `estimate_maintenance_savings(health_score, ...)` | Advisory | Predictive maintenance ROI |
| `compare_profiles(baseline_test, current_test)` | Advisory | Torque drift between two sweeps |

**Agent** (`agent.py`) — Claude API with tool_use. Chains tools autonomously:
```
User: "Check this actuator's health"
Agent: calls get_health_report() → read_telemetry() → responds with diagnosis
```

**Dashboard** (`dashboard.py`) — Streamlit UI with:
- Dark theme, gradient hero, JetBrains Mono
- Chat interface with visible tool call chain
- Sidebar: health score ring, diagnostic pills, score breakdown bars, live telemetry
- Auto-renders charts (friction map, hunting frequency response) when relevant
- Quick action buttons: Health Check, Compare Profiles, Cost Analysis, Move Actuator

### Layer 3: Web Deployment (not the main focus)

- **Backend** (`backend/src/`): Express + TypeScript on AWS EC2. Health check endpoints + Supabase Postgres. Deployed via GitHub Actions on push to `main`.
- **Frontend** (`frontend/`): Next.js on Vercel. Bridge route proxies to backend. Currently just a deploy verification UI.

---

## How to Run Everything

### Prerequisites

```bash
cd /Users/abranshbaliyan/belimo-pulse/experiments
source venv/bin/activate   # Python 3.14 venv with all deps installed
```

The venv already has: influxdb-client, pandas, numpy, scipy, fastmcp, anthropic, streamlit, altair.

### API Key

```bash
export ANTHROPIC_API_KEY
```

### Run the Agent (CLI — quick test)

```bash
cd /Users/abranshbaliyan/belimo-pulse/backend/mcp
../../experiments/venv/bin/python agent.py "Check this actuator's health"
```

This works without WiFi (uses cached data). Tested and confirmed working.

### Run the Dashboard (Streamlit UI)

```bash
cd /Users/abranshbaliyan/belimo-pulse/backend/mcp
export ANTHROPIC_API_KEY=<your-key-here>
../../experiments/venv/bin/streamlit run dashboard.py
```

Opens at http://localhost:8501

### Run Experiments (requires Pi WiFi)

1. Connect to `BELIMO-X` WiFi (password: `raspberry`)
2. Verify: `curl http://192.168.3.14:8086/health`
3. Run:
```bash
cd /Users/abranshbaliyan/belimo-pulse/experiments
source venv/bin/activate
python experiments.py --experiment sweep --test-number 600
python analysis_v2.py --data-dir experiment_data/
```

### The WiFi Problem

Pi WiFi has no internet. You need both Pi access AND internet (for Claude API) on one machine. Solutions:
- **Phone USB tethering** — connect WiFi to BELIMO-X, phone provides internet via USB
- **Two laptops** — one on Pi WiFi runs experiments, other on internet runs agent (sync CSVs via git/AirDrop)

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  STREAMLIT DASHBOARD (dashboard.py)                              │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐  │
│  │  Chat with ActuatorIQ   │  │  Sidebar: Health Score,      │  │
│  │  User types question    │  │  Diagnostics, Live Telemetry │  │
│  │  AI responds with data  │  │  Component Breakdown         │  │
│  └──────────┬──────────────┘  └──────────────────────────────┘  │
└─────────────┼────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────┐
│  AGENT (agent.py) — Claude API with tool_use                     │
│  System prompt: "You are ActuatorIQ, an AI diagnostic system..." │
│  Model: claude-sonnet-4-20250514                                 │
│  Autonomously chains tools based on user question                │
└──────────────┬───────────────────────────────────────────────────┘
               │ calls tools
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  MCP SERVER (mcp_server.py) — 12 tools via FastMCP               │
│                                                                   │
│  READ           ANALYSIS        CONTROL         ADVISORY          │
│  ─────          ────────        ───────         ────────          │
│  read_telemetry analyze_sweep   move_actuator   estimate_waste    │
│  get_report     analyze_hunting run_quick_sweep estimate_savings  │
│  get_electronics                                compare_profiles  │
│  list_experiments                                                 │
│  get_experiment_data                                              │
└──────┬───────────────────────────┬───────────────────────────────┘
       │ reads CSVs/JSON           │ InfluxDB queries/writes
       ▼                           ▼
┌──────────────┐         ┌────────────────────────┐
│ experiment_  │         │  Raspberry Pi 5         │
│ data/        │         │  InfluxDB 2.x           │
│ *.csv        │         │  192.168.3.14:8086      │
│ report_v2.json         │         │               │
└──────────────┘         │    ┌────┴────┐          │
                         │    │ Logger  │          │
                         │    └────┬────┘          │
                         └─────────┼───────────────┘
                                   │ MP-Bus serial
                                   ▼
                         ┌────────────────────┐
                         │  Belimo LM Actuator │
                         │  5Nm, 95° rotation  │
                         │  150s transit time   │
                         └────────────────────┘
```

---

## What Still Needs to Be Built

### Priority 1: Live Demo Polish
- Connect to Pi WiFi + phone tethering so dashboard has live data
- Run one more sweep during demo to show real-time data streaming
- The "move actuator" command during demo is the wow moment — judges see it move

### Priority 2: Faulty Comparison Demo
- Run a sweep while physically resisting the actuator shaft at ~50% position
- This creates a "faulty" profile with high friction/torque anomalies
- Compare healthy vs faulty in the dashboard — this is the money shot
- Command: `python experiments.py --experiment sweep --test-number 700` (while holding shaft)

### Priority 3: Presentation
- The live demo IS the presentation
- Demo script (3 turns, ~3 minutes):
  - Turn 1: "Check this actuator's health" → AI diagnoses
  - Turn 2: "Move the actuator to 75% and back" → actuator physically moves
  - Turn 3: "What would this cost a building owner?" → CHF/year impact
- Have slides as backup with: Problem → Solution → Technical Approach → Business Case

### Priority 4: Electronics Integration
- `experiment_electronics.py` was redesigned with power map (Phase 2) and stroke consistency (Phase 3)
- Run it: `python experiment_electronics.py --test-number 500`
- The report gets picked up by `get_electronics_report()` MCP tool automatically

---

## File Structure

```
belimo-pulse/
├── CLAUDE.md                          # Full project context (read this first)
├── HANDOFF.md                         # This file
├── README.md                          # Deploy notes
├── .env                               # API key (DO NOT COMMIT)
├── .gitmodules                        # Submodule config
│
├── experiments/                       # CORE — Python analysis + experiments
│   ├── venv/                          # Python 3.14 virtualenv (all deps installed)
│   ├── experiments.py                 # 4 experiment runners (sweep, steps, hunting, thermal)
│   ├── analysis.py                    # Legacy analysis engine
│   ├── analysis_v2.py                 # Current analysis engine (unloaded-aware)
│   ├── experiment_electronics.py      # Electronics diagnostics (power map, consistency)
│   ├── quickstart.py                  # Execution guide
│   ├── requirements.txt              # Python deps
│   ├── mcp_server.py                 # MCP server (original copy)
│   ├── agent.py                      # Agent (original copy)
│   ├── dashboard.py                  # Dashboard (original copy)
│   └── experiment_data/              # Collected data
│       ├── sweep_test100.csv         # Healthy sweep
│       ├── sweep_test400.csv         # Comparison sweep
│       ├── steps_test200.csv         # Step response
│       ├── hunting_test300.csv       # Oscillation test
│       ├── thermal_test400.csv       # Thermal test
│       ├── report_v2.json            # Current health report (75/100, Grade B)
│       └── *.meta.json               # Experiment metadata
│
├── backend/
│   ├── mcp/                          # WORKING COPY — MCP agent system
│   │   ├── mcp_server.py             # FastMCP server (12 tools)
│   │   ├── agent.py                  # Claude API agent
│   │   ├── dashboard.py              # Streamlit dashboard (dark theme)
│   │   └── requirements.txt
│   ├── src/                          # Express TypeScript backend
│   │   ├── server.ts
│   │   ├── config.ts
│   │   └── db.ts
│   ├── Dockerfile
│   └── package.json
│
├── frontend/                         # Next.js on Vercel
│   ├── src/app/
│   │   ├── page.tsx
│   │   ├── layout.tsx
│   │   └── api/bridge/test/route.ts
│   ├── src/components/
│   │   └── bridge-tester.tsx
│   └── package.json
│
├── Belimo-START-Hack-2026/           # Git submodule — Belimo's starter code
│   ├── demo/
│   │   ├── interface/influx/api.py   # InfluxDB wrapper (reference implementation)
│   │   ├── signal/waveform.py        # Waveform generators
│   │   ├── app.py                    # Streamlit demo
│   │   └── main.py                   # CLI demo
│   ├── Challenge.md                  # Hackathon challenge description
│   └── README.md                     # Hardware setup guide
│
└── .github/workflows/
    └── deploy.yml                    # CI/CD: Docker build → EC2 + Vercel deploy
```

---

## Key Technical Details

### InfluxDB Connection (used by all Python scripts)
```python
URL = "http://192.168.3.14:8086"
TOKEN = "pf-OGC6AQFmKy64gOzRM12DZrCuavnWeMgRZ2kDMOk8LYK22evDJnoyKGcmY49EgT8HnMDE9GPQeg30vXeHsRQ=="
ORG = "belimo"
BUCKET = "actuator-data"
```

### Actuator Specs
- **Belimo LM series**: 5 Nm (5000 Nmm), 95° rotation, 150s full transit, 24V AC/DC
- **Power**: 1W moving, 0.2W at rest
- **Position resolution**: 1/3° via back-EMF sensing

### The Hunting Finding (our key insight)
At 0.05 Hz oscillation, the actuator shows 13.2% overshoot and 8.4% tracking error — a resonance problem. This means if a building's PI controller oscillates at 0.05 Hz (which happens during hunting), the actuator amplifies the problem. This is detectable from actuator data alone, and Belimo doesn't currently extract this insight from their standard products.

---

## Judging Criteria Alignment

| Criterion | Weight | Our Angle |
|-----------|--------|-----------|
| **Creativity** | 35% | AI agent that physically controls actuator + interprets results. No team has this. The hunting resonance finding is genuinely novel. |
| **Technical Feasibility** | 35% | Everything works on real hardware with real data. Analysis algorithms validated. Cached fallback if WiFi fails. |
| **Business Feasibility** | 20% | Grounded cost estimates: CHF 3,725/year energy waste + CHF 2,646/year maintenance savings per building. |
| **Presentation** | 10% | Live demo: 3 conversational turns with visible tool chains and physical actuator movement. |

---

## Troubleshooting

**"InfluxDB not reachable"**: Not on BELIMO-X WiFi. Connect and retry.

**Agent returns cached data only**: Expected when offline. All read tools fall back to `experiment_data/` files.

**Dashboard won't start**: Check `ANTHROPIC_API_KEY` is set. Check venv is activated.

**Actuator doesn't move**: Verify InfluxDB is updating (`measurements` measurement has recent timestamps). The Pi logger might need a restart — ask Belimo people.

**"Module not found"**: Make sure you're using the venv: `../../experiments/venv/bin/python` or `source ../../experiments/venv/bin/activate`.
