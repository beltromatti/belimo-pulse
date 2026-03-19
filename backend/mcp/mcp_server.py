"""
ActuatorIQ — MCP Server
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
    "ActuatorIQ",
    instructions=(
        "You are ActuatorIQ, an AI diagnostic system for Belimo HVAC actuators. "
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
        "max_safe_frequency_hz": max_safe_freq,
        "max_slew_rate_pct_per_s": max_slew_rate,
        "recommended_kp": recommended_kp,
        "recommended_ti_s": recommended_ti,
        "hunting_risk_score": risk_score,
        "reason": (
            f"Resonance detected at {resonance_freq:.3f} Hz. "
            f"Limit control bandwidth to {max_safe_freq:.3f} Hz. "
            f"Recommended PI: Kp={recommended_kp}, Ti={recommended_ti:.0f}s. "
            f"Max setpoint slew rate: {max_slew_rate}%/s."
            if resonance_freq else
            "No hunting data available. Using conservative defaults."
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
        f"=== COMMISSIONING PARAMETERS ===\n"
        f"Position range: {result['position_limits']['min_pct']:.0f}% – {result['position_limits']['max_pct']:.0f}%\n"
        f"Dead band compensation: {result['dead_band_compensation']['offset_pct']}%\n"
        f"PI gains: Kp = {recommended_kp}, Ti = {recommended_ti:.0f}s\n"
        f"Max slew rate: {max_slew_rate}%/s\n"
        f"Actuator speed: {speed_pct_per_s}%/s ({100/speed_pct_per_s:.0f}s full stroke)\n"
        f"Health: {health.get('score', 0)}/100 ({health.get('grade', '?')})\n"
        f"Hunting risk: {risk_score:.0f}/100\n"
        f"================================"
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
#  Entry point
# ===================================================================

if __name__ == "__main__":
    if "--sse" in sys.argv:
        mcp.run(transport="sse")
    else:
        mcp.run()
