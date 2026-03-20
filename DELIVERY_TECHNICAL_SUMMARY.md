# Belimo Pulse Delivery Technical Summary

## 1. Challenge and Product Direction

Belimo START Hack 2026 asked for a technically feasible concept that extracts operational value from Belimo actuator data, especially signals such as motor position, torque, embedded temperature, and related control parameters. The requested value was practical: detect malfunctions, support commissioning, improve control quality, increase energy efficiency, and give facility teams actionable insight instead of raw field data.

Belimo Pulse answers that challenge by turning actuator and sensor telemetry into a full closed-loop building control stack:

- a realistic catalog of Belimo field devices and their writable/measurable points
- a physically plausible one-floor commercial office blueprint
- a live sandbox building that generates synthetic but realistic HVAC telemetry
- a backend digital twin that reconstructs zone conditions and diagnoses device health from incoming field data
- a facility control surface for real operator intent
- a separate sandbox control surface for hidden disturbances, biases, and faults
- an optimization loop that previews corrective action on the digital twin before pushing commands to the gateway

The result is already an end-to-end building control product for the demo scope. It monitors, predicts, simulates, commands, verifies, and keeps comfort targets stable even when adverse weather, occupancy shifts, open windows, or device degradation are introduced.

## 2. What Was Actually Built

### 2.1 End-to-End Runtime

The current software runs as a complete pipeline:

1. The sandbox data generation engine acts as the “real building”.
2. The sandbox gateway exposes that building through a stable JSON protocol.
3. The backend ingests live snapshots from the gateway.
4. The Belimo Engine reconstructs the live digital twin from telemetry.
5. The control layer detects drift or faults, simulates candidate fixes, selects the best plan, and writes controls back to the gateway.
6. The frontend renders the digital twin in 3D and exposes separate operator panels for facility controls and sandbox controls.

This same pipeline is intentionally shaped so a real building could replace the sandbox later without changing the backend contract.

### 2.2 Frontend

The frontend is a Next.js + React + TypeScript dashboard centered on a live 3D digital twin:

- main page: real-time 3D “dollhouse” building view
- left control drawer:
  - `Live Link`
  - `Facility Control Panel`
  - `Sandbox Panel`
- right inspection drawer:
  - zone state
  - device telemetry
  - device diagnostics
  - product details
- top bar:
  - Zurich time
  - simulation indicator during preview playback
  - virtual-time speed badge for sandbox `2x`, `5x`, `10x`

The Belimo Brain chat UI has been removed from the delivered interface and disabled in the frontend proxy routes.

### 2.3 Backend

The backend is a Node.js + TypeScript + Express runtime that hosts:

- the product catalog loader
- the building blueprint loader and validator
- the sandbox data generation engine
- the sandbox gateway adapter
- the Belimo Engine digital twin
- the control intelligence layer
- the simulation preview and automatic remediation loop
- persistence to Supabase/Postgres
- WebSocket streaming to the frontend

## 3. Main Technical Components

### 3.1 Realistic Belimo Product Catalog

`backend/products.json` defines a finite product schema with:

- product identity
- concept role
- telemetry schema
- command schema
- sandbox failure modes
- visualization metadata
- catalog basis and official specs

The demo uses these key products:

- `belimo_lm_series_sample_air_damper_actuator`
  - high-fidelity local sample actuator based on the real actuator tested on site
  - used where actuator behavior and diagnostics must stay closest to the fetched sample data
- `belimo_nm24a_mod_air_damper_actuator`
  - AHU/RTU outdoor, return, and exhaust dampers
- `belimo_nmv_d3_mp_vav_compact`
  - meeting-room VAV airflow control
- `belimo_22dt_12r_duct_temperature_sensor`
  - mixed air and supply air temperature
- `belimo_22dth_15m_duct_humidity_temperature_sensor`
  - supply air humidity and dew point
- `belimo_22adp_154k_differential_pressure_sensor`
  - main duct static pressure and inferred airflow envelope
- `belimo_22rtm_5u00a_room_iaq_sensor`
  - room temperature, RH, and CO2
- `belimo_edge_building_gateway`
  - fictional Belimo gateway product used as the edge bridge between field network and backend

Non-Belimo source equipment is intentionally simplified but realistic enough to support the HVAC loop:

- `non_belimo_daikin_rebel_dps_rooftop_heat_pump`

The catalog also encodes failure modes such as:

- mechanical obstruction
- slow response
- pressure tube clogging
- humidity probe condensation
- sensor bias drift

### 3.2 Blueprint System

`backend/blueprints/sandbox-office-v1.json` defines a realistic small commercial building:

- 1 floor
- multiple rooms:
  - lobby
  - open office
  - meeting room
  - facility office
- geometry and placement for 3D rendering
- envelope constructions
- occupancy design
- internal loads
- comfort targets
- air loop topology
- device placement and design airflow values

The blueprint is not decorative only. It drives:

- HVAC topology
- airflow routing
- zone thermal and IAQ calculations
- control targets
- device serving relationships
- visualization placement

### 3.3 Sandbox Truth Model

`backend/blueprints/sandbox-office-v1.truth.json` and `backend/src/sandbox-truth.ts` define the hidden “real physics” of the sandbox:

- effective UA
- effective thermal capacitance
- infiltration
- occupancy behavior
- solar gain scaling
- actuator truth
- branch flow coefficients
- source equipment capacities
- fault activation profiles
- sensor noise

These values are known only to the sandbox generation engine. The backend digital twin must infer building behavior from telemetry, not from direct access to truth.

### 3.4 Sandbox Data Generation Engine

`backend/src/sandbox/engine.ts` is the synthetic building runtime.

It computes each tick:

- live or manually overridden weather
- occupancy per room
- room sensible loads
- humidity behavior
- CO2 buildup and dilution
- infiltration and window effects
- source mode:
  - heating
  - cooling
  - ventilation
  - economizer
- supply fan speed
- outdoor air fraction
- duct static pressure
- branch flows
- actuator movement and lag
- room temperatures, RH, CO2, airflow, and comfort

Important implemented behaviors:

- separate `Facility` vs `Sandbox` controls
- manual weather overrides
- virtual time `2x / 5x / 10x`
- occupancy bias
- solar gain bias
- plug-load bias
- per-zone window opening
- injected faults
- forked runtime copies for preview simulation

The sandbox is the “real building” for this concept. It emits live snapshots through the gateway using the same shape the backend would expect from a real site.

### 3.5 Sandbox Device Behaviors

`backend/src/sandbox/product-behaviors.ts` gives each device family explicit runtime behavior.

Examples:

- LM sample actuator:
  - command vs feedback separation
  - torque estimation
  - power draw estimation
  - body temperature rise
  - obstruction tracking offset
- standard dampers:
  - slower or biased tracking under faults
- VAV compact:
  - measured airflow and dynamic pressure
- duct sensors:
  - temperature, humidity, dew point, differential pressure
- rooftop unit:
  - source mode, mixed air, return air, supply air, airflow, OA fraction, electrical power

This is what makes the device layer useful for diagnostics instead of being just random numbers.

### 3.6 Fictitious Belimo Gateway

`backend/src/sandbox/gateway.ts` implements the fictional `belimo_edge_building_gateway`.

Its role is to prove the deployment architecture:

- backend does not speak directly to BACnet, Modbus, or MP-Bus
- backend only speaks to a gateway contract
- the sandbox gateway already behaves like that future edge bridge

The gateway:

- exposes current control state
- reports available faults
- accepts control writes
- returns command acknowledgements
- polls and returns snapshots from the sandbox engine

### 3.7 Communication Protocol

`backend/src/gateway-protocol.ts` defines the protocol `belimo-pulse-gateway.v1`.

Transport:

- northbound: `wss_json`
- intended field abstractions:
  - BACnet MS/TP
  - BACnet/IP
  - Modbus RTU
  - Modbus TCP
  - MP-Bus
  - Wi-Fi/IP

Messages:

- uplink:
  - `gateway.hello`
  - `gateway.snapshot`
  - `gateway.command.ack`
- downlink:
  - `gateway.command.write`

Every snapshot includes:

- gateway descriptor
- current controls
- available faults
- device readings
- weather

This is one of the most important architectural decisions in the project: the backend pipeline is already decoupled from fieldbus specifics.

### 3.8 Belimo Engine Digital Twin

`backend/src/belimo-engine.ts` is the digital twin estimator and diagnostics engine.

It ingests live field telemetry and reconstructs:

- zone temperature
- zone humidity
- zone CO2
- occupancy proxy
- supply airflow per zone
- inferred sensible load
- comfort score

It also derives building-level state:

- average comfort score
- worst zone
- cooling demand
- heating demand
- ventilation effectiveness
- static pressure

Critically, it produces device diagnoses from actuator and sensor behavior, including alerts such as:

- mechanical obstruction suspected
- actuator response slower than expected
- zone under-conditioned despite open damper
- filter loading or fan-path restriction inferred
- ventilation quality below target
- heating section under-performing versus return air
- cooling section under-performing versus return air

This directly addresses the hackathon request to turn actuator-internal signals into actionable operational insight.

### 3.9 Control Intelligence Layer

`backend/src/control-intelligence.ts` converts live twin data into control decisions.

For each zone, it computes:

- instantaneous error against facility targets
- recent rate of change
- short-horizon projection
- airflow shortage
- CO2 excess
- comfort gap

It then builds a drift assessment with:

- trigger type:
  - `facility_manual_change`
  - `comfort_drift`
  - `fault_detected`
- severity
- worst zone
- dominant issue
- preferred operating mode
- target horizon in minutes

From that assessment it generates a candidate assist plan:

- source mode bias
- supply temperature bias
- fan speed bias
- outdoor air bias
- zone damper bias

The planner scores multiple candidate plans, refines the best one, and selects the lowest-error outcome before applying it to the live sandbox.

### 3.10 Automatic Remediation Guard

`backend/src/automatic-remediation.ts` prevents control thrashing.

Without it, automatic triggers would repeatedly launch simulations and re-issue changes before the last correction had time to take effect.

The current policy:

- groups repeated anomalies by issue key
- allows immediate manual facility changes
- suppresses repeated automatic remediation for the same unchanged issue
- waits roughly:
  - `20 min` for comfort issues
  - `30 min` for severe issues or active faults
- retriggers earlier only if the issue materially worsens

This makes the closed-loop behavior stable instead of noisy.

### 3.11 Simulation Preview on the Digital Twin

The digital twin is not only observational. It is also used as a fast preview engine.

When a facility change happens, or when drift/fault logic requires intervention:

1. The backend forks the sandbox runtime.
2. It simulates candidate control plans against the current state.
3. It scores the outcome against facility targets.
4. It optionally refines the plan if the first simulation still leaves too much error.
5. It applies the selected plan to the live sandbox.
6. It streams preview frames to the frontend.

Frontend playback:

- preview is shown in the 3D twin
- airflow and dynamics are visually accelerated
- top bar indicates simulation is running
- playback acceleration is fixed at `100x`

That means:

- `15 min` simulated horizon -> `9 s` playback
- `20 min` simulated horizon -> `12 s`
- `30 min` simulated horizon -> `18 s`

After playback, the view returns to the real live twin state.

## 4. Operator Controls and Separation of Concerns

### 4.1 Facility Control Panel

The `Facility Control Panel` represents controls that a real facility manager should have:

- operating mode preference
- per-room temperature targets
- per-room CO2 targets
- supply air trim
- ventilation boost

Facility changes trigger an immediate simulation preview and then live application.

### 4.2 Sandbox Panel

The `Sandbox Panel` represents hidden simulation-side disturbances and lab controls:

- occupancy bias
- solar gain bias
- plug-load bias
- per-zone window opening
- weather mode:
  - live St. Gallen weather
  - manual weather
- time mode:
  - real time
  - virtual time `2x / 5x / 10x`
- fault lab overrides

Sandbox changes do **not** trigger an immediate preview. They change the underlying “real building” conditions. A simulation is triggered later only if measured telemetry begins to drift or faults become visible in the incoming data.

This separation is central to the concept:

- facility controls express operator intent
- sandbox controls express hidden world disturbances

## 5. Persistence and Historical Data Use

The backend persists both raw and derived data to Supabase/Postgres through `backend/src/db.ts`.

Persisted artifacts include:

- raw weather observations
- raw device observations
- twin snapshots
- runtime frames
- zone twin observations
- device diagnoses
- facility preferences
- effective control state

Representative tables:

- `pulse_weather_observations`
- `pulse_device_observations`
- `pulse_twin_snapshots`
- `pulse_runtime_frames`
- `pulse_zone_twin_observations`
- `pulse_device_diagnoses`
- `pulse_facility_preferences`
- `pulse_effective_control_state`

This matters because the software does not only react to the latest sample. It uses:

- live telemetry
- recent historical trend windows
- persisted control state
- persisted runtime context
- derived twin metrics

The system therefore reasons on both measured and computed data.

## 6. Weather, Time, and Realism

### 6.1 Weather

The sandbox building is located in St. Gallen, Switzerland, and uses Open-Meteo weather in live mode.

The weather path supports:

- live external weather
- manual weather override for controlled experiments

Weather affects:

- infiltration
- economizer opportunity
- mixed air temperature
- envelope heat loss/gain
- humidity behavior

### 6.2 Virtual Time

Sandbox virtual time is not a preview. It is accelerated live runtime.

Available speeds:

- `2x`
- `5x`
- `10x`

The scheduler shortens the real tick interval while keeping the simulation timestep internally coherent.

## 7. How the System Resolves Problems in Practice

Belimo Pulse continuously compares live room conditions to operator targets.

If a room starts drifting, the system does not only check the current difference. It also checks:

- how fast the room is diverging
- whether the projected short-horizon state will be worse
- whether airflow is insufficient
- whether CO2 is rising
- whether a device looks obstructed or lagging

Then it:

1. identifies the dominant issue
2. decides whether to intervene now or suppress retriggering
3. simulates multiple candidate plans on a forked twin
4. chooses the best plan
5. applies the resulting adjustments through the gateway
6. keeps monitoring until the building converges

Control actions may include:

- raising or lowering supply air temperature
- changing fan speed
- trimming outdoor air fraction
- prioritizing one zone with damper bias
- de-prioritizing adjacent zones enough to preserve stability

The current controller is also mode-aware at zone level:

- in cooling/economizer, already-cold zones are trimmed back
- in heating, already-warm zones are trimmed back

This prevents the classic instability where one room is corrected at the expense of making another one unlivable.

## 8. Technical Evidence From Tests

The backend test suite currently passes `16/16`.

Important tests in `backend/src/engines.test.ts` include:

- `every sandbox blueprint product is backed by an explicit behavior module`
- `sandbox telemetry stays conformant with products.json and within product-plausible envelopes`
- `Belimo engine reconstructs sandbox zone state with low physical-state error`
- `Belimo engine diagnoses an obstructed sample actuator`
- `end-to-end HVAC envelopes stay plausible across a full day with variable weather`
- `drift intelligence triggers on fast co2 and airflow deterioration before comfort fully collapses`
- `automatic remediation suppresses repeated previews for the same unchanged drift`
- `automatic remediation retriggers when the same issue materially worsens`
- `simulation refinement improves cold-drift recovery under extreme weather within the target horizon`
- `sandbox-only disturbances are recovered back to the facility target within the target horizon`

Recovered scenarios now validated by tests:

- extreme cold weather manual target recovery
  - open office target raised to `24.3 C`
  - cold weather disturbance
  - recovered within the selected `20–30 min` horizon
  - test tolerance tightened to `<= 0.6 C`
- sandbox disturbance recovery
  - open office window opened through the sandbox console
  - controller re-detects drift from live telemetry
  - simulation chooses a new corrective plan
  - room returns to facility target within the target horizon

The suite also verifies that:

- preview forks do not mutate the live runtime
- the controller still respects whole-day HVAC plausibility envelopes
- actuator telemetry remains compatible with the declared product schemas

## 9. API Surface Used by the Demo

Important backend endpoints:

- `GET /api/runtime/bootstrap`
- `POST /api/runtime/control`
- `GET /api/gateway/protocol`
- `GET /api/sandbox/status`
- `GET /api/sandbox/telemetry`
- `GET /api/runtime/history`
- `GET /api/twin/history/zones`
- `GET /api/twin/history/devices`
- `GET /api/twin/status`
- `POST /api/blueprints/validate`

Streaming:

- WebSocket at `/ws`
- message types used by the delivered runtime:
  - `hello`
  - `tick`
  - `ack`
  - `simulation_preview`

## 10. What This Solves From the Original Belimo Request

Belimo asked for additional customer value from actuator data. This software delivers that in a concrete HVAC workflow:

- actuator and sensor data are not only visualized, they are interpreted
- actuator internals become diagnostics, not just telemetry
- room-level comfort is continuously estimated and corrected
- device issues can be detected from command/feedback mismatch and system consequences
- operator intent is separated from hidden disturbances
- every meaningful control action is validated first on the digital twin
- the same gateway contract can scale from sandbox to real buildings

In short, Belimo Pulse is already a functioning intelligent building-control concept centered on Belimo devices, realistic actuator behavior, a live digital twin, and a physically grounded closed-loop control architecture.
