# CLAUDE.md — ActuatorIQ Project Context

## What This Project Is

We are at **START Hack 2026** in St. Gallen, Switzerland. The challenge sponsor is **Belimo** — the global market leader in HVAC actuators (CHF 944M revenue, ~21% global share). We are building **ActuatorIQ**: an AI-powered diagnostic system that turns raw actuator signals into actionable insights — something Belimo's products cannot do today.

**One-line pitch**: "One sweep of the actuator tells you everything about the installation — sizing, linkage, friction, health, and hunting risk — with zero extra hardware."

---

## The Challenge (verbatim from Belimo)

> Belimo's actuators collect and measure a large amount of internal data, including valuable information about how they are operated, such as load profiles and control parameters. Today, these datapoints are not yet used to create additional value for customers.
>
> The goal is to create innovative concepts by analyzing signals from Belimo's field devices, such as torque, motor position, and temperature, to generate actionable insights. These insights should help resolve issues, correct errors, improve energy efficiency in control systems, and create measurable value during installation, commissioning, and operation.

### Judging Criteria
- **Creativity (35%)** — New, out-of-the-box ideas. Highest recognition for insights previously unknown or unanticipated.
- **Technical Feasibility (35%)** — Must be realistic. Real-world limitations must be considered (production variance, signal isolation from disturbances).
- **Business Feasibility (20%)** — Strong fit to the HVAC industry.
- **Presentation (10%)** — Easy to understand, captivating. Professional design NOT important.

### Target Users
- Installers, mechanical contractors, system integrators, OEMs, facility managers
- All in commercial building HVAC

---

## The Hardware Setup

We have a **physical Belimo LM/CQ actuator** connected to a **Raspberry Pi 5** running InfluxDB.

### Network
- WiFi SSID: `BELIMO-X` (X = number on label), password: `raspberry`
- InfluxDB UI: `http://192.168.3.14:8086` (username: `pi`, password: `raspberry`)

### InfluxDB Data Model
- **Bucket**: `actuator-data`
- **Two measurements**:
  - `measurements` — continuous telemetry from actuator
  - `_process` — commands we write to move the actuator

### Telemetry Fields (from `measurements`)
| Field | Description | Unit |
|-------|-------------|------|
| `setpoint_position_%` | Commanded target (0=closed, 100=open) | % |
| `feedback_position_%` | Actual shaft position | % |
| `rotation_direction` | 0=still, 1=opening, 2=closing | - |
| `motor_torque_Nmm` | Torque (sign inconsistent with direction) | Nmm |
| `power_W` | Power consumption | W |
| `internal_temperature_deg_C` | PCB temperature | °C |
| `test_number` | Experiment tag (default -1) | int |

### Command Fields (write to `_process`)
| Field | Description |
|-------|-------------|
| `setpoint_position_%` | Desired position [0, 100] |
| `test_number` | Integer experiment tag |

### Critical Implementation Details
- Commands use **epoch timestamp** (`1970-01-01T00:00:00Z`) to handle clock sync issues
- Data does **NOT persist** on Pi reboot — export CSVs during session
- No fixed sampling rate — telemetry is read as fast as possible
- Writing to `_process` causes the actuator to physically move

### Actuator Specs
- **Belimo LM series**: 5 Nm torque (5000 Nmm), 95° rotation, 150s transit time, 24V AC/DC
- **Belimo CQ series**: 1 Nm torque (1000 Nmm), 75s transit time (zone ball valves)
- Both use **MP-Bus** protocol over serial
- **Halomo motor**: sensorless brushless DC, 1/3° position resolution via back-EMF
- Operating temp: LM -30°C to +50°C (IP54), CQ 5°C to 40°C (IP40)
- Power: LM24A draws 1W moving, 0.2W at rest

---

## Domain Knowledge: Why This Matters

### The Real-World Problem
Commercial HVAC is a slow feedback loop: thermostat → PI controller → actuator → valve → water/air flow → room temperature → sensor → back to controller. This loop has **5-15 minutes of thermal lag**. The PI controller doesn't know about this lag and overreacts, causing **hunting** (oscillation around setpoint).

### What We Learned from Talking to Belimo Engineers
1. **Commissioning is the #1 pain point** — installers have zero feedback on whether installation is correct
2. **Temperature accuracy complaints** are common — often caused by sensor drift or placement, not actuator issues
3. **The feedback loop problem** is the root cause — nobody tunes PI loops properly because it takes too long and conditions change seasonally
4. **Only 25% of HVAC control loops** perform excellently (Honeywell study). 34% are "fair", 16% "poor"
5. **Valve hunting wastes 2-4% of HVAC energy** and affects 70% of chilled-water valves

### What Belimo Doesn't Have (Our Innovation Gap)
- No torque monitoring as a diagnostic tool (only stall protection)
- No actuator health score
- No edge analytics on standard actuators
- No automated commissioning validation
- No cross-actuator correlation
- The Energy Valve has cloud + analytics, but standard LM/CQ actuators are "dumb"

### Failure Modes Detectable from Actuator Data
| Failure | Signal Signature |
|---------|-----------------|
| Stuck/seized valve | Torque at max, position unchanged |
| Increasing friction | Running torque trends up over time |
| Loose linkage | Dead zone — position changes but torque near zero |
| Wrong sizing (oversized) | Peak torque <20% of rated capacity |
| Wrong sizing (undersized) | Peak torque >80% of rated capacity |
| Valve hunting | Oscillation in position signal (FFT detectable) |
| Motor degradation | Transit time increasing, power consumption rising |

---

## Our Solution Architecture

### Three Modes, Same Pipeline

**Mode 1: Install Check** (2 min, runs once)
- Automated full sweep 0→100→0
- Extracts torque-position fingerprint
- Outputs: sizing verdict, linkage check, friction map, health score
- Value: catches installation errors before they become complaints

**Mode 2: Commission Tune** (15 min)
- Step response tests + oscillation tests
- Outputs: hunting risk score, recommended PI gains, valve characteristic curve
- Value: prevents hunting, reduces energy waste

**Mode 3: Continuous Watch** (runs forever)
- Passive monitoring during operation
- Outputs: rolling health score, energy waste detection, degradation forecast
- Value: predictive maintenance, avoids emergency failures

### Technical Stack
```
Physical Actuator ← MP-Bus → Raspberry Pi 5
                              ↓
                         InfluxDB 2.x (on Pi)
                              ↓
              experiments.py (send commands, collect data)
                              ↓
                    experiment_data/*.csv
                              ↓
              analysis.py (5 diagnostic algorithms)
                              ↓
                    report.json (structured results)
                              ↓
              AI Agent (Claude API via MCP) — natural language interpretation
                              ↓
              Streamlit Dashboard — live visualization + recommendations
```

### The 5 Diagnostic Algorithms

1. **Sizing Check**: `max_torque / rated_torque` → threshold classification (<20% oversized, >80% undersized)
2. **Linkage/Dead Band**: Find position where torque first exceeds 10% of max; gap from start = dead band
3. **Friction Map**: Bin 0-100% into 20 segments, compute mean torque per bin, flag bins >1.5x running mean
4. **Hunting Risk**: Overshoot measurement + tracking error + FFT dominant frequency → composite 0-100 score
5. **Health Score**: Weighted composite: sizing (25pts) + linkage (20pts) + friction (20pts) + transit consistency (15pts) + torque symmetry (20pts)

---

## Existing Code

### From Belimo's Repo (demo/)
- `demo/interface/influx/api.py` — InfluxDB connection, read/write helpers
- `demo/signal/waveform.py` — sine/triangle/square waveform generators
- `demo/app.py` — Streamlit UI for basic control + plotting
- `demo/main.py` — CLI for control + terminal output

### Our Code
- `experiments.py` — 4 automated experiments (sweep, steps, hunting, thermal)
- `analysis.py` — 5 diagnostic algorithms + health score + report generation
- `QUICKSTART.py` — Step-by-step execution guide
- `requirements.txt` — Dependencies

### InfluxDB Connection Details (from their api.py)
```python
url = "http://192.168.3.14:8086"
token = "pf-OGC6AQFmKy64gOzRM12DZrCuavnWeMgRZ2kDMOk8LYK22evDJnoyKGcmY49EgT8HnMDE9GPQeg30vXeHsRQ=="
org = "belimo"
bucket = "actuator-data"
verify_ssl = False
```

### How Commands Work
```python
# Write a setpoint — actuator physically moves
df = pd.DataFrame([{
    "timestamp": datetime.fromtimestamp(0, tz=timezone.utc),  # always epoch!
    "setpoint_position_%": 50.0,
    "test_number": 100,
}]).set_index("timestamp")
write_api.write(bucket="actuator-data", record=df, ...)

# Read latest telemetry
query = '''
    from(bucket:"actuator-data")
    |> range(start: 0)
    |> filter(fn: (r) => r["_measurement"] == "measurements")
    |> group(columns: ["_field"])
    |> last()
    |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
'''
```

---

## What Still Needs to Be Built

### Priority 1: Streamlit Dashboard (the demo UI)
A real-time dashboard that shows:
- Live torque-position curve as the sweep runs
- Health score gauge (0-100 with color coding)
- Pass/Warn/Fail cards for each diagnostic
- Side-by-side comparison of healthy vs faulty profiles
- Natural language recommendations

Should extend the existing `demo/app.py` pattern (Streamlit + Altair charts).

### Priority 2: MCP Server + AI Agent Layer
- Wrap InfluxDB connection as an MCP server
- Claude API interprets diagnostic results in natural language
- Generates installer-friendly recommendations like "Valve appears oversized. Consider DN15 instead of DN25."
- Can also write corrective setpoints back through InfluxDB

### Priority 3: Presentation Slides
Required elements: Problem statement, Solution, Technical approach, Business case.
Format: PowerPoint or PDF. Keep it concise — the live demo IS the presentation.

### Business Case Numbers
- Building automation market: $101.7B (2025), growing 13.4% CAGR
- Predictive maintenance ROI: 8-15x investment
- HVAC = 40-60% of building energy, 5-30% wasted from poor controls
- Typical building: 50-500 actuators, $2.15/sq ft annual HVAC maintenance
- Value per building: $38K-85K/year from analytics (energy savings + avoided failures + extended life)

---

## Demo Script (for presentation)

**Scene 1** — Connect to actuator. Run diagnostic sweep. Show torque-position plot.
AI says: "Installation check complete. Health score: 92/100. All parameters nominal."

**Scene 2** — Physically resist actuator shaft with hand (simulates stuck valve).
Run sweep again. Torque profile changes dramatically.
AI says: "WARNING: Friction anomaly at 40-60% position. Torque 180% above baseline. Health score: 38/100."

**Scene 3** — Send oscillating setpoints. Show position tracking with lag.
AI says: "Hunting risk HIGH. Recommend reducing proportional gain by 30%. Estimated waste: 2.4 kWh/day."

**The contrast between Scene 1 and Scene 2 is the money shot.** The same actuator, same code, but the torque fingerprint reveals the fault instantly.

---

## Key Principles
- **Build on their code** — use the same API patterns from `demo/interface/influx/api.py`
- **Real data, not simulated** — always use the physical actuator when possible
- **Insights, not dashboards** — the output should be decisions and recommendations, not just charts
- **No new hardware** — everything runs on signals already available via MP-Bus
- **Keep it simple** — the analysis is basic signal processing (thresholds, FFT, statistics), not deep learning
- **Tag experiments** — use `test_number` consistently so data can be filtered in InfluxDB

---

## File Structure Goal
```
project/
├── CLAUDE.md                    # This file
├── requirements.txt             # Python dependencies
├── experiments.py               # Experiment runner (4 experiments)
├── analysis.py                  # Analysis engine (5 diagnostics + health score)
├── QUICKSTART.py                # Step-by-step guide
├── dashboard.py                 # Streamlit dashboard (TO BUILD)
├── mcp_server.py               # MCP server wrapping InfluxDB (TO BUILD)
├── agent.py                     # AI agent using Claude API (TO BUILD)
├── presentation/                # Slides (TO BUILD)
│   └── actuatoriq.pptx
├── experiment_data/             # CSV outputs from experiments
│   ├── sweep_test100.csv
│   ├── steps_test200.csv
│   ├── hunting_test300.csv
│   └── report.json
└── demo/                        # Original Belimo hackathon code
    ├── interface/influx/api.py
    ├── signal/waveform.py
    ├── app.py
    └── main.py
```