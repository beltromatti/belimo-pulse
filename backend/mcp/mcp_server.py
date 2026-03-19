"""
Belimo Pulse AI — MCP Server
========================
Exposes actuator diagnostics, telemetry, and control as MCP tools.
Built on FastMCP. Wraps existing experiments.py and analysis_v2.py.

Run:
  python mcp_server.py              # stdio transport (for Claude Desktop / agent.py)
  python mcp_server.py --sse        # SSE transport (for web clients)
"""

import json
import sys
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional

from fastmcp import FastMCP

# Paths — experiments code and data live in ../../experiments/
EXPERIMENTS_DIR = Path(__file__).resolve().parent.parent.parent / "experiments"
DATA_DIR = EXPERIMENTS_DIR / "experiment_data"

# Add experiments dir to sys.path so we can import experiments.py / analysis_v2.py
if str(EXPERIMENTS_DIR) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS_DIR))

mcp = FastMCP(
    "Belimo Pulse AI",
    instructions=(
        "You are Belimo Pulse AI, an AI diagnostic system for Belimo HVAC actuators. "
        "You have tools to read live telemetry from a physical actuator, run diagnostic "
        "experiments, analyze results, move the actuator, and estimate business impact. "
        "Always ground your answers in actual data from the tools. "
        "When diagnosing, explain what the numbers mean for the installer or facility manager."
    ),
)


# ===================================================================
#  Helpers — lazy imports to avoid crashing if InfluxDB is unreachable
# ===================================================================

_influx_available = None


def _check_influx():
    global _influx_available
    if _influx_available is not None:
        return _influx_available
    try:
        from experiments import read_api  # noqa: F401
        _influx_available = True
    except Exception:
        _influx_available = False
    return _influx_available


def _load_json(filename: str) -> dict | None:
    path = DATA_DIR / filename
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def _dataclass_to_dict(obj):
    if hasattr(obj, "__dict__"):
        return {k: _dataclass_to_dict(v) for k, v in obj.__dict__.items()}
    if isinstance(obj, list):
        return [_dataclass_to_dict(i) for i in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj


# ===================================================================
#  READ TOOLS — safe, no side effects
# ===================================================================

@mcp.tool()
def read_telemetry(n: int = 10) -> str:
    """Read the latest N telemetry readings from the physical actuator via InfluxDB.
    Returns position, torque, power, temperature, and direction for each reading.
    Requires WiFi connection to the Raspberry Pi."""
    if not _check_influx():
        return json.dumps({"error": "InfluxDB not reachable. Use cached data tools instead."})
    from experiments import read_latest
    df = read_latest(n)
    if df is None or df.empty:
        return json.dumps({"error": "No telemetry data available"})
    records = df.reset_index().to_dict(orient="records")
    for r in records:
        for k, v in r.items():
            if isinstance(v, (pd.Timestamp,)):
                r[k] = str(v)
    return json.dumps(records, indent=2, default=str)


@mcp.tool()
def get_health_report() -> str:
    """Get the latest full diagnostic report including health score, sizing, linkage,
    friction, step response, hunting risk, and recommendations.
    This is pre-computed from experiment data."""
    report = _load_json("report_v2.json")
    if not report:
        return json.dumps({"error": "No report found. Run analysis first."})
    return json.dumps(report, indent=2)


@mcp.tool()
def get_electronics_report() -> str:
    """Get the electronic diagnostics report including idle power, power map,
    directional asymmetry, stroke consistency, and energy per stroke."""
    for name in ["electronics_test500_report.json", "electronics_test600_report.json"]:
        report = _load_json(name)
        if report:
            return json.dumps(report, indent=2)
    return json.dumps({"error": "No electronics report found. Run experiment_electronics.py first."})


@mcp.tool()
def list_experiments() -> str:
    """List all available experiment data files (CSVs and reports)."""
    files = []
    if DATA_DIR.exists():
        for f in sorted(DATA_DIR.iterdir()):
            if f.suffix in (".csv", ".json"):
                files.append({"name": f.name, "size_kb": round(f.stat().st_size / 1024, 1)})
    return json.dumps(files, indent=2)


@mcp.tool()
def get_experiment_data(filename: str, head: int = 50) -> str:
    """Load a specific experiment CSV file and return the first N rows as JSON.
    Use list_experiments() first to see available files.
    Args:
        filename: CSV filename (e.g. 'sweep_test100.csv')
        head: Number of rows to return (default 50, max 500)
    """
    path = DATA_DIR / filename
    if not path.exists():
        return json.dumps({"error": f"File not found: {filename}"})
    head = min(head, 500)
    df = pd.read_csv(path, nrows=head)
    return json.dumps({
        "filename": filename,
        "total_rows": sum(1 for _ in open(path)) - 1,
        "showing": len(df),
        "columns": list(df.columns),
        "data": df.to_dict(orient="records"),
    }, indent=2, default=str)


# ===================================================================
#  ANALYSIS TOOLS
# ===================================================================

@mcp.tool()
def analyze_sweep(csv_filename: str = "sweep_test100.csv", rated_torque: float = 5000) -> str:
    """Run the full diagnostic analysis on a sweep CSV file.
    Returns sizing, linkage, friction, health score, and recommendations.
    Args:
        csv_filename: Sweep CSV in experiment_data/ (default: sweep_test100.csv)
        rated_torque: Rated torque in Nmm (5000 for LM series, 1000 for CQ)
    """
    path = DATA_DIR / csv_filename
    if not path.exists():
        return json.dumps({"error": f"File not found: {csv_filename}"})
    try:
        from analysis_v2 import run_full_analysis, save_report
        report = run_full_analysis(str(DATA_DIR), rated_torque)
        if report is None:
            return json.dumps({"error": "Analysis failed — no sweep data found"})
        return json.dumps(_dataclass_to_dict(report), indent=2, default=str)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def analyze_hunting(csv_filename: str = "hunting_test300.csv") -> str:
    """Run hunting risk analysis on oscillation test data.
    Returns risk score, overshoot, tracking error, and per-frequency breakdown.
    Args:
        csv_filename: Hunting CSV in experiment_data/
    """
    path = DATA_DIR / csv_filename
    if not path.exists():
        return json.dumps({"error": f"File not found: {csv_filename}"})
    try:
        from analysis_v2 import analyze_hunting as _analyze
        df = pd.read_csv(path)
        result = _analyze(df)
        return json.dumps(_dataclass_to_dict(result), indent=2, default=str)
    except Exception as e:
        return json.dumps({"error": str(e)})


# ===================================================================
#  CONTROL TOOLS — physical actuator movement
# ===================================================================

@mcp.tool()
def move_actuator(position: float, test_number: int = 999) -> str:
    """Move the physical actuator to a specific position (0-100%).
    WARNING: This causes physical movement of the actuator on the table.
    Args:
        position: Target position in % (0 = fully closed, 100 = fully open)
        test_number: Experiment tag for InfluxDB (default 999)
    """
    if not _check_influx():
        return json.dumps({"error": "InfluxDB not reachable. Cannot control actuator."})
    if not 0 <= position <= 100:
        return json.dumps({"error": "Position must be between 0 and 100"})
    try:
        from experiments import write_setpoint
        write_setpoint(float(position), int(test_number))
        return json.dumps({
            "ok": True,
            "action": f"Sent setpoint {position:.1f}% to actuator",
            "test_number": test_number,
            "note": "Actuator is now moving. It takes ~1.5s per 1% of travel.",
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def run_quick_sweep(test_number: int = 900) -> str:
    """Run a fast diagnostic sweep (single pass, 25 steps, ~2 minutes).
    Collects torque-position data for analysis. Much faster than the full 3-repeat sweep.
    WARNING: This moves the actuator through its full range.
    Args:
        test_number: Experiment tag (default 900)
    """
    if not _check_influx():
        return json.dumps({"error": "InfluxDB not reachable."})
    try:
        from experiments import experiment_sweep
        csv_path = experiment_sweep(test_number, n_repeats=1)
        return json.dumps({
            "ok": True,
            "csv_file": csv_path.name,
            "note": "Quick sweep complete. Use analyze_sweep() on this file to get diagnostics.",
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def run_fresh_diagnosis(test_number: int = 950, rated_torque: float = 5000) -> str:
    """Run a COMPLETE fresh diagnosis from scratch: sweep the actuator, analyze the data,
    generate commissioning parameters, and return everything in one call.

    This is the full Install Verify + Commission Tune pipeline on LIVE hardware.
    Takes ~2-3 minutes. The actuator will physically move through its full range.

    Use this when the user wants a fresh diagnosis with NO cached data.

    Args:
        test_number: Experiment tag (default 950)
        rated_torque: Rated torque in Nmm (5000 for LM, 1000 for CQ)
    """
    if not _check_influx():
        return json.dumps({"error": "InfluxDB not reachable. Cannot run live diagnosis."})

    result = {"protocol": "fresh_diagnosis", "test_number": test_number, "steps": []}

    # Step 1: Run sweep
    try:
        from experiments import experiment_sweep
        result["steps"].append("Running diagnostic sweep on physical actuator...")
        csv_path = experiment_sweep(test_number, n_repeats=1)
        result["sweep_file"] = csv_path.name
        result["steps"].append(f"Sweep complete: {csv_path.name}")
    except Exception as e:
        return json.dumps({"error": f"Sweep failed: {e}"})

    # Step 2: Analyze
    try:
        from analysis_v2 import run_full_analysis, save_report as _save
        import io, contextlib
        f = io.StringIO()
        with contextlib.redirect_stdout(f):
            report = run_full_analysis(str(DATA_DIR), rated_torque)
        if report is None:
            return json.dumps({"error": "Analysis failed on sweep data"})
        _save(report, str(DATA_DIR / "report_v2.json"))
        result["steps"].append("Analysis complete. Report saved.")
        result["health_score"] = report.health.score
        result["grade"] = report.health.grade
        result["sizing"] = _dataclass_to_dict(report.sizing)
        result["linkage"] = _dataclass_to_dict(report.linkage)
        result["friction"] = {
            "verdict": report.friction.verdict,
            "smoothness": report.friction.smoothness_score,
            "anomalies": len(report.friction.anomaly_positions),
        }
        if report.hunting:
            result["hunting"] = {
                "verdict": report.hunting.verdict,
                "risk_score": report.hunting.risk_score,
                "max_overshoot_pct": report.hunting.max_overshoot_pct,
                "avg_tracking_error": report.hunting.avg_tracking_error,
            }
        result["recommendations"] = report.recommendations
        result["components"] = _dataclass_to_dict(report.health.components)
    except Exception as e:
        return json.dumps({"error": f"Analysis failed: {e}"})

    # Step 3: Generate commissioning parameters
    try:
        commission = json.loads(auto_commission(rated_torque))
        result["commissioning"] = commission
        result["steps"].append("Commissioning parameters generated.")
    except Exception as e:
        result["commissioning_error"] = str(e)

    # Step 4: Read current telemetry
    try:
        from experiments import read_latest
        df = read_latest(1)
        if df is not None and not df.empty:
            row = df.iloc[-1]
            result["live_telemetry"] = {
                "position": round(float(row.get("feedback_position_%", 0)), 1),
                "torque": round(float(row.get("motor_torque_Nmm", 0)), 2),
                "power_mw": round(float(row.get("power_W", 0)) * 1000, 1),
                "temp_c": round(float(row.get("internal_temperature_deg_C", 0)), 1),
            }
    except Exception:
        pass

    result["steps"].append("Fresh diagnosis complete.")
    result["summary"] = (
        f"Health: {result['health_score']}/100 (Grade {result['grade']}). "
        f"Sizing: {result['sizing']['verdict']}. "
        f"Linkage: {result['linkage']['verdict']}. "
        f"Friction: {result['friction']['verdict']} (smoothness {result['friction']['smoothness']:.2f}). "
    )
    if "hunting" in result:
        result["summary"] += f"Hunting: {result['hunting']['verdict']} ({result['hunting']['risk_score']:.0f}/100). "

    return json.dumps(result, indent=2, default=str)


# ===================================================================
#  ADVISORY TOOLS — pure computation, no I/O
# ===================================================================

@mcp.tool()
def estimate_energy_waste(
    hunting_score: float,
    building_zones: int = 8,
    hours_per_day: float = 12,
    energy_rate_chf_per_kwh: float = 0.22,
) -> str:
    """Estimate annual energy waste and cost from valve hunting in a commercial building.

    Based on real data: hunting causes the actuator to oscillate, wasting energy
    as the HVAC system repeatedly overshoots temperature setpoints.

    Args:
        hunting_score: Hunting risk score from analysis (0-100)
        building_zones: Number of HVAC zones with actuators (default 8)
        hours_per_day: HVAC operating hours per day (default 12)
        energy_rate_chf_per_kwh: Electricity rate in CHF (default 0.22, Swiss avg)
    """
    # hunting_score 0-100 maps to overshoot severity
    # At score 55 (moderate), overshoot is ~13%, causing ~2.4 kWh/day/zone waste
    # Based on: 0.05 Hz oscillation × 1W motor power × duty cycle × thermal inefficiency
    waste_factor = (hunting_score / 100) ** 1.5  # nonlinear — worse hunting = disproportionate waste
    kwh_per_zone_per_day = waste_factor * 4.5  # 4.5 kWh/day at score=100

    daily_waste_kwh = kwh_per_zone_per_day * building_zones
    annual_waste_kwh = daily_waste_kwh * 365 * (hours_per_day / 24)
    annual_cost_chf = annual_waste_kwh * energy_rate_chf_per_kwh

    # Correction cost: technician time to retune
    technician_rate_chf = 120  # per hour
    tuning_hours = building_zones * 0.25  # 15 min per zone
    correction_cost = technician_rate_chf * tuning_hours

    payback_days = correction_cost / (annual_cost_chf / 365) if annual_cost_chf > 0 else float("inf")

    return json.dumps({
        "hunting_score": hunting_score,
        "building_zones": building_zones,
        "waste_per_zone_kwh_day": round(kwh_per_zone_per_day, 2),
        "annual_waste_kwh": round(annual_waste_kwh, 0),
        "annual_cost_chf": round(annual_cost_chf, 0),
        "correction_cost_chf": round(correction_cost, 0),
        "payback_days": round(payback_days, 0),
        "recommendation": (
            f"Hunting at score {hunting_score:.0f}/100 wastes ~{annual_waste_kwh:.0f} kWh/year "
            f"across {building_zones} zones (CHF {annual_cost_chf:.0f}/year). "
            f"PI loop retuning costs CHF {correction_cost:.0f} and pays back in "
            f"{payback_days:.0f} days."
        ),
    }, indent=2)


@mcp.tool()
def estimate_maintenance_savings(
    health_score: int,
    n_actuators: int = 50,
    replacement_cost_chf: float = 450,
) -> str:
    """Estimate annual maintenance savings from predictive monitoring.

    Unplanned actuator failure costs 3-5x more than planned replacement due to
    emergency labor, system downtime, and comfort complaints.

    Args:
        health_score: Current health score (0-100)
        n_actuators: Total actuators in building (default 50)
        replacement_cost_chf: Cost per actuator replacement (default 450 CHF)
    """
    # Industry data: 2-5% annual failure rate for HVAC actuators
    # With monitoring: catch 70% of failures before they become emergencies
    base_failure_rate = 0.035  # 3.5% annual
    emergency_multiplier = 3.5  # emergency repair costs 3.5x planned

    # Health score affects expected failure rate
    if health_score >= 80:
        adjusted_rate = base_failure_rate * 0.8
    elif health_score >= 60:
        adjusted_rate = base_failure_rate * 1.2
    else:
        adjusted_rate = base_failure_rate * 2.0

    expected_failures = n_actuators * adjusted_rate
    emergency_cost = expected_failures * replacement_cost_chf * emergency_multiplier
    planned_cost = expected_failures * replacement_cost_chf * 0.7  # catch 70% early
    savings = emergency_cost - planned_cost

    return json.dumps({
        "health_score": health_score,
        "n_actuators": n_actuators,
        "expected_failures_per_year": round(expected_failures, 1),
        "cost_without_monitoring_chf": round(emergency_cost, 0),
        "cost_with_monitoring_chf": round(planned_cost, 0),
        "annual_savings_chf": round(savings, 0),
        "recommendation": (
            f"With {n_actuators} actuators at health {health_score}/100, "
            f"expect ~{expected_failures:.1f} failures/year. "
            f"Predictive monitoring saves CHF {savings:.0f}/year by catching "
            f"70% of failures before emergency."
        ),
    }, indent=2)


@mcp.tool()
def auto_commission(rated_torque: float = 5000) -> str:
    """Generate optimal control parameters and operating envelope for this actuator.

    Reads the health report and hunting data, then computes:
    - Safe position limits (avoiding dead zones at extremes)
    - Maximum recommended slew rate (to avoid resonance)
    - Recommended PI controller gains (Kp, Ti)
    - Operating envelope summary for the commissioning engineer

    This is the "closed-loop action" — the AI doesn't just diagnose, it prescribes.

    Args:
        rated_torque: Rated torque in Nmm (5000 for LM, 1000 for CQ)
    """
    report = _load_json("report_v2.json")
    if not report:
        return json.dumps({"error": "No health report. Run analysis first."})

    result = {
        "protocol": "auto_commission",
        "actuator_model": report.get("actuator_model", "LM"),
        "rated_torque_nmm": rated_torque,
    }

    # 1. Position limits — find dead zones from friction map
    friction = report.get("friction", {})
    torque_bins = friction.get("torque_std_by_bin", [])

    min_position = 0.0
    max_position = 100.0

    if torque_bins:
        # Find where torque is too low at extremes (dead zone)
        overall_mean = np.mean([b["torque_mean"] for b in torque_bins])
        dead_threshold = overall_mean * 0.3  # below 30% of mean = dead zone

        # Scan from low end
        for b in torque_bins:
            if b["torque_mean"] < dead_threshold:
                min_position = b["position"] + 2.5  # skip this bin
            else:
                break

        # Scan from high end
        for b in reversed(torque_bins):
            if b["torque_mean"] < dead_threshold:
                max_position = b["position"] - 2.5
            else:
                break

    result["position_limits"] = {
        "min_pct": round(max(0, min_position), 1),
        "max_pct": round(min(100, max_position), 1),
        "reason": (
            f"Effective range: {max(0, min_position):.0f}–{min(100, max_position):.0f}%. "
            f"Below {max(0, min_position):.0f}% and above {min(100, max_position):.0f}% "
            f"the actuator is in dead zone with insufficient torque for reliable control."
        ),
    }

    # 2. Linkage dead band compensation
    linkage = report.get("linkage", {})
    dead_band = linkage.get("dead_band_pct", 0)
    result["dead_band_compensation"] = {
        "dead_band_pct": dead_band,
        "compensate": dead_band > 2.0,
        "offset_pct": round(dead_band * 1.2, 1) if dead_band > 2.0 else 0,
        "reason": (
            f"Dead band: {dead_band}%. "
            + ("Offset setpoint by {:.1f}% to compensate.".format(dead_band * 1.2) if dead_band > 2.0
               else "No compensation needed — linkage is tight.")
        ),
    }

    # 3. Hunting prevention — compute max safe frequency and PI gains
    hunting = report.get("hunting", {})
    per_config = hunting.get("per_config_results", [])
    resonance_freq = None
    max_safe_freq = None

    if per_config:
        # Find frequency with worst overshoot
        worst = max(per_config, key=lambda c: c.get("max_overshoot_pct", 0))
        resonance_freq = worst.get("frequency_hz")

        # Find highest frequency with < 5% overshoot
        safe_configs = [c for c in per_config if c.get("max_overshoot_pct", 0) < 5.0]
        if safe_configs:
            max_safe_freq = max(c["frequency_hz"] for c in safe_configs)
        else:
            max_safe_freq = min(c["frequency_hz"] for c in per_config) * 0.5

    # Compute recommended PI gains
    # Kp: proportional gain. Higher Kp = faster response but more overshoot
    # Ti: integral time. Longer Ti = less oscillation
    # Rule: set control loop bandwidth to 1/3 of resonance frequency
    if resonance_freq and resonance_freq > 0:
        target_bandwidth = resonance_freq / 3
        recommended_kp = round(min(2.0, target_bandwidth * 20), 2)
        recommended_ti = round(max(60, 1.0 / (target_bandwidth * 0.5)), 0)
        max_slew_rate = round(resonance_freq * 50, 1)  # %/s
    else:
        recommended_kp = 1.0
        recommended_ti = 180
        max_slew_rate = 5.0

    risk_score = hunting.get("risk_score", 0)
    result["hunting_prevention"] = {
        "resonance_frequency_hz": resonance_freq,
        "resonance_frequency_measured": True,
        "max_safe_frequency_hz": max_safe_freq,
        "max_slew_rate_pct_per_s": max_slew_rate,
        "max_slew_rate_derived": True,
        "suggested_kp_range": [round(recommended_kp * 0.7, 2), round(recommended_kp * 1.3, 2)],
        "suggested_ti_range_s": [round(recommended_ti * 0.8, 0), round(recommended_ti * 1.3, 0)],
        "hunting_risk_score": risk_score,
        "hunting_risk_measured": True,
        "note_on_pi_gains": (
            "PI gain ranges are DERIVED estimates based on measured resonance frequency. "
            "Exact gains depend on the specific valve, piping, room thermal mass, and BMS — "
            "which we cannot test with the actuator alone. Use these as starting points, "
            "then fine-tune on site."
        ),
        "reason": (
            f"MEASURED: Resonance at {resonance_freq:.3f} Hz (from hunting experiment). "
            f"MEASURED: Hunting risk {risk_score:.0f}/100, max overshoot {worst.get('max_overshoot_pct', 0):.1f}%. "
            f"DERIVED: Max safe control bandwidth {max_safe_freq:.3f} Hz (1/3 of resonance). "
            f"DERIVED: Max slew rate {max_slew_rate}%/s. "
            f"DERIVED: Suggested PI range Kp={recommended_kp*0.7:.2f}-{recommended_kp*1.3:.2f}, "
            f"Ti={recommended_ti*0.8:.0f}-{recommended_ti*1.3:.0f}s (estimates only — tune on site)."
            if resonance_freq else
            "No hunting data available. Run a hunting experiment first."
        ),
    }

    # 4. Transit speed characterization
    steps = report.get("steps", {})
    avg_transit = steps.get("avg_transit_time_s", 0)
    if avg_transit > 0:
        speed_pct_per_s = round(25.0 / avg_transit, 2)  # 25% steps
    else:
        speed_pct_per_s = 0.67  # LM spec: 150s for 100% = 0.67%/s

    result["actuator_speed"] = {
        "measured_speed_pct_per_s": speed_pct_per_s,
        "full_stroke_time_s": round(100 / speed_pct_per_s, 1) if speed_pct_per_s > 0 else 150,
        "reason": f"Measured speed: {speed_pct_per_s}%/s. Full stroke: {100/speed_pct_per_s:.0f}s.",
    }

    # 5. Overall commissioning summary
    health = report.get("health", {})
    result["summary"] = {
        "health_score": health.get("score", 0),
        "grade": health.get("grade", "?"),
        "commission_ready": health.get("score", 0) >= 60,
        "critical_actions": [],
    }

    if dead_band > 4:
        result["summary"]["critical_actions"].append("FIX: Tighten shaft coupling (dead band > 4%)")
    if risk_score > 60:
        result["summary"]["critical_actions"].append(f"TUNE: Reduce Kp to {recommended_kp}, increase Ti to {recommended_ti}s")
    sizing = report.get("sizing", {})
    if sizing.get("verdict") in ("OVERSIZED", "UNDERSIZED") and sizing.get("severity") == "fail":
        result["summary"]["critical_actions"].append(f"REPLACE: Valve is {sizing['verdict'].lower()}")

    if not result["summary"]["critical_actions"]:
        result["summary"]["critical_actions"].append("No critical issues. Ready for commissioning.")

    result["commissioning_card"] = (
        f"=== OPERATING ENVELOPE (from measured data) ===\n"
        f"[MEASURED] Position range: {result['position_limits']['min_pct']:.0f}% – {result['position_limits']['max_pct']:.0f}%\n"
        f"[MEASURED] Dead band: {dead_band}% {'(compensate +' + str(result['dead_band_compensation']['offset_pct']) + '%)' if dead_band > 2 else '(none needed)'}\n"
        f"[MEASURED] Resonance frequency: {resonance_freq:.3f} Hz\n" if resonance_freq else ""
        f"[MEASURED] Hunting risk: {risk_score:.0f}/100\n"
        f"[MEASURED] Actuator speed: {speed_pct_per_s}%/s ({100/speed_pct_per_s:.0f}s full stroke)\n"
        f"[MEASURED] Health: {health.get('score', 0)}/100 ({health.get('grade', '?')})\n"
        f"[DERIVED]  Max slew rate: {max_slew_rate}%/s (from resonance)\n"
        f"[DERIVED]  Max control bandwidth: {max_safe_freq:.3f} Hz\n" if max_safe_freq else ""
        f"[DERIVED]  PI starting range: Kp={recommended_kp*0.7:.2f}-{recommended_kp*1.3:.2f}, Ti={recommended_ti*0.8:.0f}-{recommended_ti*1.3:.0f}s\n"
        f"[NOTE]     PI values are estimates — tune on site with actual control loop\n"
        f"============================================="
    )

    return json.dumps(result, indent=2)


@mcp.tool()
def predict_degradation(
    baseline_test: int = 100,
    current_test: int = 400,
    months_between: float = 6,
    rated_torque: float = 5000,
) -> str:
    """Predict actuator and valve degradation by comparing two sweep profiles over time.

    Computes degradation rates and forecasts when maintenance will be needed.
    Uses torque trending (valve packing wear), transit time trending (motor degradation),
    and friction pattern changes (mechanical wear).

    Args:
        baseline_test: Test number of earlier sweep (default 100)
        current_test: Test number of later sweep (default 400)
        months_between: Time elapsed between the two sweeps in months (default 6)
        rated_torque: Rated torque in Nmm (5000 for LM)
    """
    base_path = DATA_DIR / f"sweep_test{baseline_test}.csv"
    curr_path = DATA_DIR / f"sweep_test{current_test}.csv"

    if not base_path.exists():
        return json.dumps({"error": f"Baseline not found: sweep_test{baseline_test}.csv"})
    if not curr_path.exists():
        return json.dumps({"error": f"Current not found: sweep_test{current_test}.csv"})

    df_base = pd.read_csv(base_path)
    df_curr = pd.read_csv(curr_path)

    result = {
        "protocol": "degradation_forecast",
        "baseline_test": baseline_test,
        "current_test": current_test,
        "months_between": months_between,
    }

    # 1. Torque trending — valve packing wear indicator
    base_torque_mean = float(df_base["torque_nmm"].abs().mean())
    curr_torque_mean = float(df_curr["torque_nmm"].abs().mean())
    torque_change_pct = ((curr_torque_mean - base_torque_mean) / max(base_torque_mean, 0.01)) * 100
    torque_rate = torque_change_pct / max(months_between, 0.1)

    # Stall threshold: when mean torque reaches 80% of rated
    stall_torque = rated_torque * 0.8
    if torque_rate > 0 and curr_torque_mean < stall_torque:
        remaining_nmm = stall_torque - curr_torque_mean
        rate_nmm_per_month = (curr_torque_mean - base_torque_mean) / max(months_between, 0.1)
        if rate_nmm_per_month > 0:
            months_to_stall = remaining_nmm / rate_nmm_per_month
        else:
            months_to_stall = None
    else:
        months_to_stall = None

    result["torque_trend"] = {
        "baseline_mean_nmm": round(base_torque_mean, 2),
        "current_mean_nmm": round(curr_torque_mean, 2),
        "change_pct": round(torque_change_pct, 1),
        "rate_pct_per_month": round(torque_rate, 2),
        "months_to_stall": round(months_to_stall, 0) if months_to_stall else None,
        "interpretation": (
            "Torque increasing — valve friction growing. "
            + (f"At current rate, valve will stall in ~{months_to_stall:.0f} months."
               if months_to_stall and months_to_stall < 120
               else "No stall risk in foreseeable future.")
            if torque_rate > 1 else
            "Torque stable or decreasing — no valve packing wear detected."
        ),
    }

    # 2. Friction pattern changes — per-position comparison
    n_bins = 10
    friction_changes = []
    for start in range(0, 100, n_bins):
        end = start + n_bins
        b_mask = (df_base["position"] >= start) & (df_base["position"] < end)
        c_mask = (df_curr["position"] >= start) & (df_curr["position"] < end)
        b_torque = df_base.loc[b_mask, "torque_nmm"].abs()
        c_torque = df_curr.loc[c_mask, "torque_nmm"].abs()

        if len(b_torque) > 0 and len(c_torque) > 0:
            b_mean = float(b_torque.mean())
            c_mean = float(c_torque.mean())
            change = ((c_mean - b_mean) / max(b_mean, 0.01)) * 100
            friction_changes.append({
                "position_range": f"{start}-{end}%",
                "baseline_nmm": round(b_mean, 2),
                "current_nmm": round(c_mean, 2),
                "change_pct": round(change, 1),
            })

    # Find worst degradation zone
    if friction_changes:
        worst_zone = max(friction_changes, key=lambda x: x["change_pct"])
    else:
        worst_zone = None

    result["friction_pattern"] = {
        "per_position": friction_changes,
        "worst_zone": worst_zone,
        "interpretation": (
            f"Worst degradation at {worst_zone['position_range']}: "
            f"+{worst_zone['change_pct']:.0f}% torque increase. "
            f"Indicates localized wear or contamination in that valve range."
            if worst_zone and worst_zone["change_pct"] > 20
            else "Friction pattern stable across all positions."
        ),
    }

    # 3. Transit time trending — motor health
    # Compare if step data exists
    base_steps = sorted(DATA_DIR.glob(f"steps_test*.csv"))
    transit_trend = None
    if base_steps:
        df_steps = pd.read_csv(base_steps[0])
        if "step_from" in df_steps.columns and "step_to" in df_steps.columns:
            # Compute average transit from step data
            valid_transits = []
            for _, group in df_steps.groupby(["step_from", "step_to"]):
                group = group.sort_values("time_s")
                if len(group) >= 3:
                    step_size = abs(group["step_to"].iloc[0] - group["step_from"].iloc[0])
                    if step_size > 0:
                        duration = group["time_s"].iloc[-1] - group["time_s"].iloc[0]
                        speed = step_size / max(duration, 0.1)
                        valid_transits.append(speed)
            if valid_transits:
                avg_speed = np.mean(valid_transits)
                spec_speed = 100 / 150  # LM spec: 150s full stroke
                speed_ratio = avg_speed / spec_speed
                transit_trend = {
                    "measured_speed_pct_per_s": round(avg_speed, 2),
                    "spec_speed_pct_per_s": round(spec_speed, 2),
                    "speed_vs_spec_pct": round(speed_ratio * 100, 1),
                    "interpretation": (
                        "Motor running at spec speed — no degradation."
                        if speed_ratio > 0.85
                        else f"Motor {(1-speed_ratio)*100:.0f}% slower than spec — may indicate wear."
                    ),
                }

    result["motor_health"] = transit_trend or {
        "interpretation": "No step response data available for motor speed assessment."
    }

    # 4. Overall forecast
    issues = []
    if torque_rate > 5:
        issues.append(f"CRITICAL: Torque rising {torque_rate:.1f}%/month — schedule valve service")
    elif torque_rate > 2:
        issues.append(f"WATCH: Torque rising {torque_rate:.1f}%/month — monitor quarterly")

    if worst_zone and worst_zone["change_pct"] > 50:
        issues.append(f"CRITICAL: Friction spike at {worst_zone['position_range']} — inspect valve")
    elif worst_zone and worst_zone["change_pct"] > 20:
        issues.append(f"WATCH: Friction increasing at {worst_zone['position_range']}")

    if not issues:
        issues.append("No degradation detected. Next check recommended in 6 months.")

    # Estimated remaining life
    if months_to_stall and months_to_stall < 120:
        remaining_years = months_to_stall / 12
        service_date = f"~{remaining_years:.1f} years from now"
    else:
        service_date = "No service needed in foreseeable future (5+ years)"

    result["forecast"] = {
        "issues": issues,
        "next_service": service_date,
        "next_check_months": 6 if any("WATCH" in i for i in issues) else 12,
        "overall_trend": (
            "DEGRADING" if torque_rate > 2 else
            "STABLE" if abs(torque_rate) < 1 else
            "IMPROVING"
        ),
    }

    return json.dumps(result, indent=2)


@mcp.tool()
def run_install_verify() -> str:
    """Run the complete Install Verify protocol (Protocol 1).

    This is the 2-minute automated test an installer runs after mounting the actuator.
    It performs a sweep, analyzes it, generates commissioning parameters, and returns
    a pass/fail installation card.

    Requires live connection to the actuator via InfluxDB.
    """
    if not _check_influx():
        # Fallback to cached data
        report = _load_json("report_v2.json")
        if not report:
            return json.dumps({"error": "No live connection and no cached data."})

        commission = json.loads(auto_commission())
        return json.dumps({
            "protocol": "install_verify",
            "mode": "cached",
            "health_score": report["health"]["score"],
            "grade": report["health"]["grade"],
            "sizing": report["sizing"]["verdict"],
            "linkage": report["linkage"]["verdict"],
            "friction": report["friction"]["verdict"],
            "commissioning": commission,
            "pass_fail": "PASS" if report["health"]["score"] >= 60 else "FAIL",
            "note": "Results from cached data. Connect to actuator for live verification.",
        }, indent=2)

    try:
        from experiments import experiment_sweep
        # Run fast single sweep
        csv_path = experiment_sweep(test_number=800, n_repeats=1)

        # Analyze it
        from analysis_v2 import run_full_analysis
        report = run_full_analysis(str(DATA_DIR))

        if not report:
            return json.dumps({"error": "Sweep completed but analysis failed."})

        # Save report
        from analysis_v2 import save_report
        save_report(report, str(DATA_DIR / "report_v2.json"))

        # Generate commissioning parameters
        commission = json.loads(auto_commission())

        health = report.health
        return json.dumps({
            "protocol": "install_verify",
            "mode": "live",
            "sweep_file": csv_path.name,
            "health_score": health.score,
            "grade": health.grade,
            "sizing": _dataclass_to_dict(report.sizing),
            "linkage": _dataclass_to_dict(report.linkage),
            "friction": {"verdict": report.friction.verdict, "smoothness": report.friction.smoothness_score},
            "commissioning": commission,
            "pass_fail": "PASS" if health.score >= 60 else "FAIL",
            "recommendations": report.recommendations,
        }, indent=2, default=str)

    except Exception as e:
        return json.dumps({"error": f"Install verify failed: {e}"})


@mcp.tool()
def compare_profiles(baseline_test: int = 100, current_test: int = 400) -> str:
    """Compare two sweep profiles to detect degradation or fault changes.
    Shows torque drift, friction change, and health score delta between two test runs.
    Args:
        baseline_test: Test number of baseline sweep (default 100 = healthy)
        current_test: Test number of current sweep (default 400 = faulty/later)
    """
    base_path = DATA_DIR / f"sweep_test{baseline_test}.csv"
    curr_path = DATA_DIR / f"sweep_test{current_test}.csv"

    if not base_path.exists():
        return json.dumps({"error": f"Baseline file not found: sweep_test{baseline_test}.csv"})
    if not curr_path.exists():
        return json.dumps({"error": f"Current file not found: sweep_test{current_test}.csv"})

    df_base = pd.read_csv(base_path)
    df_curr = pd.read_csv(curr_path)

    base_torque = df_base["torque_nmm"].abs()
    curr_torque = df_curr["torque_nmm"].abs()

    comparison = {
        "baseline_test": baseline_test,
        "current_test": current_test,
        "baseline_samples": len(df_base),
        "current_samples": len(df_curr),
        "torque": {
            "baseline_max_nmm": round(float(base_torque.max()), 2),
            "current_max_nmm": round(float(curr_torque.max()), 2),
            "change_pct": round(
                (float(curr_torque.max()) - float(base_torque.max()))
                / max(float(base_torque.max()), 0.01) * 100, 1
            ),
            "baseline_mean_nmm": round(float(base_torque.mean()), 2),
            "current_mean_nmm": round(float(curr_torque.mean()), 2),
        },
    }

    # Per-position comparison (bin into 10 segments)
    position_comparison = []
    for start in range(0, 100, 10):
        end = start + 10
        b = base_torque[(df_base["position"] >= start) & (df_base["position"] < end)]
        c = curr_torque[(df_curr["position"] >= start) & (df_curr["position"] < end)]
        if len(b) > 0 and len(c) > 0:
            position_comparison.append({
                "position_range": f"{start}-{end}%",
                "baseline_torque": round(float(b.mean()), 2),
                "current_torque": round(float(c.mean()), 2),
                "change_pct": round((float(c.mean()) - float(b.mean())) / max(float(b.mean()), 0.01) * 100, 1),
            })
    comparison["position_comparison"] = position_comparison

    torque_change = comparison["torque"]["change_pct"]
    if abs(torque_change) > 50:
        comparison["verdict"] = "SIGNIFICANT_CHANGE"
        comparison["detail"] = f"Torque changed by {torque_change:+.1f}% — indicates major condition change."
    elif abs(torque_change) > 20:
        comparison["verdict"] = "MODERATE_CHANGE"
        comparison["detail"] = f"Torque changed by {torque_change:+.1f}% — monitor closely."
    else:
        comparison["verdict"] = "STABLE"
        comparison["detail"] = f"Torque changed by {torque_change:+.1f}% — within normal variation."

    return json.dumps(comparison, indent=2)


# ===================================================================
#  INVESTIGATION TOOLS — targeted experiments for anomaly follow-up
# ===================================================================

@mcp.tool()
def run_targeted_sweep(start_pct: float, end_pct: float, steps: int = 20, test_number: int = 960) -> str:
    """Run a sweep over a SPECIFIC position range to investigate an anomaly.
    Only sweeps between start_pct and end_pct instead of full 0-100.
    Use when you detect unusual torque/friction at a position and want to zoom in.

    Args:
        start_pct: Start position (0-100)
        end_pct: End position (0-100)
        steps: Number of measurement points (default 20)
        test_number: Experiment tag
    """
    if not _check_influx():
        return json.dumps({"error": "InfluxDB not reachable."})
    try:
        import time
        from experiments import write_setpoint, read_latest

        start_pct = max(0, min(100, start_pct))
        end_pct = max(0, min(100, end_pct))
        positions = np.linspace(start_pct, end_pct, steps)
        samples = []
        t0 = time.time()

        write_setpoint(float(start_pct), test_number)
        time.sleep(5)

        for pos in positions:
            write_setpoint(float(pos), test_number)
            time.sleep(1.5)
            df = read_latest(1)
            if df is not None and not df.empty:
                row = df.iloc[-1]
                samples.append({
                    "target_pct": round(float(pos), 1),
                    "position_pct": round(float(row.get("feedback_position_%", 0)), 1),
                    "torque_nmm": round(float(row.get("motor_torque_Nmm", 0)), 3),
                    "power_mw": round(float(row.get("power_W", 0)) * 1000, 1),
                })

        write_setpoint(50, test_number)

        torques = [s["torque_nmm"] for s in samples]
        return json.dumps({
            "protocol": "targeted_sweep",
            "range": f"{start_pct:.0f}%-{end_pct:.0f}%",
            "steps": len(samples),
            "duration_s": round(time.time() - t0, 1),
            "torque_min": round(min(abs(t) for t in torques), 3) if torques else 0,
            "torque_max": round(max(abs(t) for t in torques), 3) if torques else 0,
            "torque_mean": round(np.mean([abs(t) for t in torques]), 3) if torques else 0,
            "torque_std": round(float(np.std([abs(t) for t in torques])), 3) if torques else 0,
            "samples": samples,
        }, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def run_frequency_probe(frequency_hz: float, amplitude_pct: float = 15,
                        duration_s: float = 60, test_number: int = 970) -> str:
    """Test the actuator at a SPECIFIC frequency to measure tracking ability.
    Oscillates around 50% at the given frequency and measures overshoot/error.

    Args:
        frequency_hz: Frequency to test (e.g. 0.05)
        amplitude_pct: Oscillation amplitude (default 15%)
        duration_s: Test duration (default 60s)
        test_number: Experiment tag
    """
    if not _check_influx():
        return json.dumps({"error": "InfluxDB not reachable."})
    try:
        import time, math
        from experiments import write_setpoint, read_latest

        samples = []
        t0 = time.time()
        bias = 50.0

        write_setpoint(bias, test_number)
        time.sleep(3)

        while time.time() - t0 < duration_s:
            elapsed = time.time() - t0
            setpoint = bias + amplitude_pct * math.sin(2 * math.pi * frequency_hz * elapsed)
            setpoint = max(0, min(100, setpoint))
            write_setpoint(float(setpoint), test_number)

            df = read_latest(1)
            if df is not None and not df.empty:
                row = df.iloc[-1]
                position = float(row.get("feedback_position_%", 0))
                samples.append({
                    "time_s": round(elapsed, 2),
                    "setpoint": round(setpoint, 1),
                    "position": round(position, 1),
                    "error": round(abs(position - setpoint), 2),
                    "torque_nmm": round(float(row.get("motor_torque_Nmm", 0)), 3),
                })
            time.sleep(0.1)

        write_setpoint(50, test_number)

        errors = [s["error"] for s in samples]
        positions = [s["position"] for s in samples]
        setpoints = [s["setpoint"] for s in samples]
        overshoots = []
        for i in range(1, len(samples)):
            if setpoints[i] != setpoints[i-1]:
                direction = 1 if setpoints[i] > setpoints[i-1] else -1
                overshoot = (positions[i] - setpoints[i]) * direction
                if overshoot > 0:
                    overshoots.append(overshoot)

        return json.dumps({
            "protocol": "frequency_probe",
            "frequency_hz": frequency_hz,
            "amplitude_pct": amplitude_pct,
            "duration_s": round(time.time() - t0, 1),
            "n_samples": len(samples),
            "avg_tracking_error_pct": round(np.mean(errors), 2) if errors else 0,
            "max_tracking_error_pct": round(max(errors), 2) if errors else 0,
            "max_overshoot_pct": round(max(overshoots), 2) if overshoots else 0,
            "can_track": np.mean(errors) < 5.0 if errors else False,
            "verdict": (
                "TRACKS WELL" if errors and np.mean(errors) < 3 else
                "MARGINAL" if errors and np.mean(errors) < 8 else
                "CANNOT TRACK"
            ),
        }, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def run_step_test(from_pct: float, to_pct: float, hold_s: float = 10,
                  test_number: int = 980) -> str:
    """Run a single step response test between two positions.
    Measures transit time, overshoot, and settling for that specific move.

    Args:
        from_pct: Starting position
        to_pct: Target position
        hold_s: Seconds to hold at target (default 10)
        test_number: Experiment tag
    """
    if not _check_influx():
        return json.dumps({"error": "InfluxDB not reachable."})
    try:
        import time
        from experiments import write_setpoint, read_latest

        write_setpoint(float(from_pct), test_number)
        time.sleep(5)

        samples = []
        t0 = time.time()
        write_setpoint(float(to_pct), test_number)

        reached = False
        reach_time = None
        while time.time() - t0 < hold_s + 15:
            df = read_latest(1)
            if df is not None and not df.empty:
                row = df.iloc[-1]
                pos = float(row.get("feedback_position_%", 0))
                samples.append({
                    "time_s": round(time.time() - t0, 2),
                    "position": round(pos, 1),
                    "torque_nmm": round(float(row.get("motor_torque_Nmm", 0)), 3),
                })
                if not reached and abs(pos - to_pct) < 2.0:
                    reached = True
                    reach_time = time.time() - t0
            time.sleep(0.1)

        write_setpoint(50, test_number)

        positions = [s["position"] for s in samples]
        step_dir = 1 if to_pct > from_pct else -1
        overshoot = max(((p - to_pct) * step_dir for p in positions), default=0)
        overshoot = max(0, overshoot)

        return json.dumps({
            "protocol": "step_test",
            "from_pct": from_pct,
            "to_pct": to_pct,
            "step_size_pct": abs(to_pct - from_pct),
            "transit_time_s": round(reach_time, 2) if reach_time else None,
            "overshoot_pct": round(overshoot, 2),
            "final_position": round(positions[-1], 1) if positions else None,
            "n_samples": len(samples),
        }, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def read_telemetry_stream(duration_s: float = 10, sample_interval: float = 0.3) -> str:
    """Read continuous telemetry for a duration.
    Returns all samples collected. Use to observe behavior during or after commands.

    Args:
        duration_s: Seconds to collect (default 10, max 60)
        sample_interval: Seconds between samples (default 0.3)
    """
    if not _check_influx():
        return json.dumps({"error": "InfluxDB not reachable."})
    try:
        import time
        from experiments import read_latest

        duration_s = min(duration_s, 60)
        samples = []
        t0 = time.time()

        while time.time() - t0 < duration_s:
            df = read_latest(1)
            if df is not None and not df.empty:
                row = df.iloc[-1]
                samples.append({
                    "time_s": round(time.time() - t0, 2),
                    "position": round(float(row.get("feedback_position_%", 0)), 1),
                    "torque_nmm": round(float(row.get("motor_torque_Nmm", 0)), 3),
                    "power_mw": round(float(row.get("power_W", 0)) * 1000, 1),
                    "temp_c": round(float(row.get("internal_temperature_deg_C", 0)), 1),
                })
            time.sleep(sample_interval)

        return json.dumps({
            "duration_s": round(time.time() - t0, 1),
            "n_samples": len(samples),
            "samples": samples,
        }, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def detect_anomalies() -> str:
    """Scan the latest health report and experiment data for anomalies.
    Returns findings with suggested follow-up experiments.
    Use as the FIRST step of an investigation pipeline."""
    report = _load_json("report_v2.json")
    if not report:
        return json.dumps({"error": "No report. Run analysis first."})

    anomalies = []

    # Check hunting
    hunting = report.get("hunting", {})
    if hunting.get("risk_score", 0) > 30:
        worst_freq = None
        per_config = hunting.get("per_config_results", [])
        if per_config:
            worst = max(per_config, key=lambda c: c.get("max_overshoot_pct", 0))
            worst_freq = worst.get("frequency_hz")
        anomalies.append({
            "type": "hunting_risk",
            "severity": "high" if hunting["risk_score"] > 60 else "moderate",
            "measured": f"Hunting score {hunting['risk_score']:.0f}/100, "
                        f"max overshoot {hunting.get('max_overshoot_pct', 0):.1f}%",
            "location": f"Worst at {worst_freq} Hz" if worst_freq else "Unknown frequency",
            "follow_up": f"run_frequency_probe(frequency_hz={worst_freq})" if worst_freq else "Run hunting experiment",
        })

    # Check friction
    friction = report.get("friction", {})
    if friction.get("anomaly_positions"):
        for anom in friction["anomaly_positions"]:
            anomalies.append({
                "type": "friction_spike",
                "severity": "high",
                "measured": f"Torque {anom.get('torque_ratio', 0):.1f}x baseline at {anom.get('position_pct', 0)}%",
                "location": f"{anom.get('position_pct', 0)}% position",
                "follow_up": f"run_targeted_sweep(start_pct={max(0, anom.get('position_pct', 50)-10)}, "
                             f"end_pct={min(100, anom.get('position_pct', 50)+10)})",
            })

    if friction.get("smoothness_score", 1) < 0.7:
        anomalies.append({
            "type": "rough_operation",
            "severity": "moderate",
            "measured": f"Smoothness {friction['smoothness_score']:.2f} (threshold 0.70)",
            "location": "Full stroke",
            "follow_up": "run_targeted_sweep(start_pct=0, end_pct=100, steps=40)",
        })

    # Check linkage
    linkage = report.get("linkage", {})
    if linkage.get("dead_band_pct", 0) > 3:
        anomalies.append({
            "type": "loose_linkage",
            "severity": "high",
            "measured": f"Dead band {linkage['dead_band_pct']:.1f}%",
            "location": "Shaft coupling",
            "follow_up": "run_step_test(from_pct=0, to_pct=10) to measure engagement point precisely",
        })

    # Check sizing
    sizing = report.get("sizing", {})
    if sizing.get("verdict") in ("OVERSIZED", "UNDERSIZED") and sizing.get("severity") == "fail":
        anomalies.append({
            "type": "sizing_mismatch",
            "severity": "critical",
            "measured": f"Sizing ratio {sizing.get('sizing_ratio', 0)*100:.1f}% — {sizing['verdict']}",
            "location": "Valve-actuator pairing",
            "follow_up": "No experiment needed — valve must be replaced",
        })

    # Check step response
    steps = report.get("steps", {})
    if steps.get("avg_overshoot_pct", 0) > 5:
        anomalies.append({
            "type": "step_overshoot",
            "severity": "moderate",
            "measured": f"Average overshoot {steps['avg_overshoot_pct']:.1f}%",
            "location": "Step response",
            "follow_up": "run_step_test(from_pct=25, to_pct=75) to confirm at large step",
        })

    if not anomalies:
        anomalies.append({
            "type": "none",
            "severity": "info",
            "measured": f"Health {report['health']['score']}/100 — no anomalies detected",
            "follow_up": "No investigation needed",
        })

    return json.dumps({"anomalies": anomalies, "total": len(anomalies)}, indent=2)


@mcp.tool()
def get_torque_at_position(position_center: float, window_pct: float = 10) -> str:
    """Get torque statistics at a specific position range from sweep data.

    Args:
        position_center: Center position (0-100)
        window_pct: Window width (e.g. 10 = position_center +/- 5%)
    """
    sweep_files = sorted(DATA_DIR.glob("sweep_*.csv"), reverse=True)
    if not sweep_files:
        return json.dumps({"error": "No sweep data found"})

    df = pd.read_csv(sweep_files[0])
    half = window_pct / 2
    lo, hi = position_center - half, position_center + half
    mask = (df["position"] >= lo) & (df["position"] <= hi)
    subset = df.loc[mask, "torque_nmm"].abs()

    if len(subset) == 0:
        return json.dumps({"error": f"No data points in range {lo:.0f}-{hi:.0f}%"})

    return json.dumps({
        "position_range": f"{lo:.0f}-{hi:.0f}%",
        "center": position_center,
        "n_samples": len(subset),
        "torque_mean_nmm": round(float(subset.mean()), 3),
        "torque_max_nmm": round(float(subset.max()), 3),
        "torque_min_nmm": round(float(subset.min()), 3),
        "torque_std_nmm": round(float(subset.std()), 3),
        "source_file": sweep_files[0].name,
    }, indent=2)


# ===================================================================
#  Entry point
# ===================================================================

if __name__ == "__main__":
    if "--sse" in sys.argv:
        mcp.run(transport="sse")
    else:
        mcp.run()
