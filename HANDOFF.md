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

**MCP Server** (`mcp_server.py`) — **15 tools** exposed via FastMCP, organized by lifecycle protocol:

**Protocol 1: Install Verify** (for installers — 2 min)
| Tool | What it does |
|------|-------------|
| `run_install_verify()` | Full automated protocol: sweep → analyze → commission card → pass/fail |
| `analyze_sweep(csv_filename)` | Runs all 5 diagnostics on a sweep CSV |
| `get_health_report()` | Returns pre-computed diagnostics from `report_v2.json` |

**Protocol 2: Commission Tune** (for engineers — 5 min)
| Tool | What it does |
|------|-------------|
| `auto_commission(rated_torque)` | **Generates optimal PI gains (Kp, Ti), position limits, max slew rate, dead band compensation** |
| `analyze_hunting(csv_filename)` | Hunting risk analysis with per-frequency breakdown |
| `move_actuator(position, test_number)` | **Physically moves the actuator** |
| `run_quick_sweep(test_number)` | Fast 2-min diagnostic sweep (1 repeat, 25 steps) |

**Protocol 3: Continuous Watch** (for facility managers — passive)
| Tool | What it does |
|------|-------------|
| `predict_degradation(baseline, current, months)` | **Forecasts valve service dates, friction trends, remaining life** |
| `compare_profiles(baseline_test, current_test)` | Torque drift and per-position friction comparison |
| `estimate_energy_waste(hunting_score, ...)` | Annual CHF waste from hunting |
| `estimate_maintenance_savings(health_score, ...)` | Predictive maintenance ROI |

**Core Data Tools**
| Tool | What it does |
|------|-------------|
| `read_telemetry(n)` | Live sensor data from Pi via InfluxDB |
| `get_electronics_report()` | Electronics experiment report (power map, consistency) |
| `list_experiments()` | Lists available CSV/JSON files |
| `get_experiment_data(filename, head)` | Loads a specific CSV as JSON |

**Key difference from v1:** The agent now **prescribes actions**, not just reports problems:
- `auto_commission` outputs: "Use Kp=0.33, Ti=120s, max slew 2.5%/s" (not "hunting risk is moderate")
- `predict_degradation` outputs: "Inspect valve at 60-70% by Sep 2026" (not "friction increased 61%")
- `run_install_verify` outputs: "PASS — ready for commissioning" (not raw data)

**Agent** (`agent.py`) — Claude API with tool_use. System prompt now references three lifecycle protocols. Chains tools autonomously:
```
User: "Generate commissioning parameters"
Agent: calls auto_commission() → "Use Kp=0.33, Ti=120s, limit slew to 2.5%/s"

User: "When will this actuator need maintenance?"
Agent: calls predict_degradation() → "Friction spike at 60-70%. Inspect by Sep 2026."
```

**Dashboard** (`dashboard.py`) — Streamlit UI with:
- Dark theme, gradient hero, JetBrains Mono fonts
- Chat interface with visible tool call chain
- Sidebar: health score ring, diagnostic pills, score breakdown bars, live telemetry
- Auto-renders Altair charts (friction map, hunting frequency response) when relevant
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
│  MCP SERVER (mcp_server.py) — 15 tools via FastMCP               │
│                                                                   │
│  INSTALL VERIFY    COMMISSION TUNE    CONTINUOUS WATCH             │
│  ──────────────    ──────────────     ────────────────             │
│  run_install_verify auto_commission   predict_degradation          │
│  analyze_sweep     analyze_hunting    compare_profiles             │
│  get_health_report move_actuator      estimate_energy_waste        │
│                    run_quick_sweep    estimate_maintenance_savings  │
│                                                                   │
│  CORE: read_telemetry, get_electronics_report,                    │
│        list_experiments, get_experiment_data                       │
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

## The Product Concept

**"Your actuator already knows. Now you can listen."**

Every Belimo actuator already measures torque, position, power, and temperature. These signals contain a diagnostic picture of the valve, the control loop, and the actuator itself. ActuatorIQ extracts this through three protocols:

| Protocol | Who | Time | What It Does | Key Tool |
|----------|-----|------|-------------|----------|
| **Install Verify** | Installer | 2 min | Sweep → pass/fail card (sizing, linkage, friction) | `run_install_verify()` |
| **Commission Tune** | Engineer | 5 min | Hunting test → PI gains, position limits, slew rate | `auto_commission()` |
| **Continuous Watch** | Facility Mgr | Passive | Compare sweeps → degradation forecast, service dates | `predict_degradation()` |

**The key insight the judges should hear:** The actuator is a diagnostic probe for the **entire HVAC system** — valve health (torque trending), controller quality (hunting detection), and its own electronics (power analysis) — disguised as a simple motor.

---

## What Still Needs to Be Done

### Priority 1: Live Demo Connection
- Get both Pi access AND internet on one laptop (phone USB tethering or Ethernet to Pi)
- Verify: `curl http://192.168.3.14:8086/health` works while internet also works
- Then the dashboard talks to the actuator AND Claude API simultaneously

### Priority 2: Faulty Comparison Demo (THE MONEY SHOT)
- Run a sweep while physically resisting the actuator shaft at ~50% position
- This creates a "faulty" profile with high friction/torque anomalies
- Command: `python experiments.py --experiment sweep --test-number 700` (while holding shaft)
- Then ask the agent: "Compare baseline to current — what changed?"
- The visual contrast between healthy and faulty torque curves is the entire presentation

### Priority 3: Presentation (5 slides + live demo)
- **Slide 1:** Problem — 70% of valves hunt, installers have zero feedback, $5.2B/yr industry waste
- **Slide 2:** Solution — ActuatorIQ: 3 protocols across the actuator lifecycle
- **Slide 3:** Live Demo — 3 turns:
  - "Run install verify" → AI sweeps actuator, returns pass/fail + commissioning card
  - "Move actuator to 75%" → judges watch it move on the table
  - "What does this cost a building?" → CHF 8,871/year savings
- **Slide 4:** Business Case — CHF 8,871/building/year × scale
- **Slide 5:** Vision — every Belimo actuator ships with ActuatorIQ built in

### Priority 4: Electronics Integration
- `experiment_electronics.py` was redesigned with power map (Phase 2) and stroke consistency (Phase 3)
- Run it: `python experiment_electronics.py --test-number 500`
- The report gets picked up by `get_electronics_report()` MCP tool automatically

### Priority 5: Dashboard Quick Actions Update
- Add buttons for the three protocols: "Install Verify", "Commission Tune", "Predict Degradation"
- These map directly to the new tools

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
