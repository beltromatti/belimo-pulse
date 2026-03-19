"""
ActuatorIQ — Analysis Engine v2
=================================
Updated to handle both:
  - Real loaded actuators (production use)
  - Unloaded demo rigs (hackathon setup)

Automatically detects if the actuator is unloaded and adjusts
the analysis accordingly.

Usage:
  python analysis_v2.py --sweep-file experiment_data/sweep_test100.csv
  python analysis_v2.py --all --data-dir experiment_data/
"""

import argparse
import json
import numpy as np
import pandas as pd
from pathlib import Path
from dataclasses import dataclass, asdict, field
from typing import Optional, List


RATED_TORQUE_NMM = 5000  # LM series


# ===================================================================
#  Result data classes
# ===================================================================
@dataclass
class SizingResult:
    verdict: str
    severity: str
    max_torque_nmm: float
    sizing_ratio: float
    is_loaded: bool
    detail: str

@dataclass
class LinkageResult:
    verdict: str
    severity: str
    dead_band_pct: float
    detail: str

@dataclass
class FrictionResult:
    verdict: str
    severity: str
    anomaly_positions: list
    smoothness_score: float
    torque_std_by_bin: list
    detail: str

@dataclass
class StepResponseResult:
    verdict: str
    severity: str
    avg_transit_time_s: float
    transit_times: list  # per step
    avg_overshoot_pct: float
    settling_times: list
    detail: str

@dataclass
class HuntingRiskResult:
    verdict: str
    severity: str
    risk_score: float
    max_overshoot_pct: float
    avg_tracking_error: float
    dominant_frequency_hz: Optional[float]
    per_config_results: list
    detail: str

@dataclass
class HealthScore:
    score: int
    grade: str
    components: dict
    detail: str

@dataclass
class DiagnosticReport:
    actuator_model: str
    is_loaded: bool
    sizing: SizingResult
    linkage: LinkageResult
    friction: FrictionResult
    steps: Optional[StepResponseResult]
    hunting: Optional[HuntingRiskResult]
    health: HealthScore
    recommendations: list


# ===================================================================
#  Utility: detect if actuator is loaded
# ===================================================================
def detect_load_state(df: pd.DataFrame, rated_torque: float) -> bool:
    """
    Determine if the actuator has a real valve load.
    Unloaded actuators show <5% of rated torque.
    """
    if "torque_nmm" not in df.columns:
        return False
    max_torque = df["torque_nmm"].abs().max()
    ratio = max_torque / rated_torque
    return ratio > 0.05  # loaded if >5% of rated


# ===================================================================
#  ANALYSIS 1: Sizing
# ===================================================================
def analyze_sizing(df: pd.DataFrame, rated_torque: float = RATED_TORQUE_NMM) -> SizingResult:
    torque = df["torque_nmm"].abs()
    max_t = torque.max()
    mean_t = torque.mean()
    ratio = max_t / rated_torque
    is_loaded = ratio > 0.05

    if not is_loaded:
        # Unloaded demo rig — sizing can't be determined, but we report
        # the baseline internal friction which is useful reference data
        return SizingResult(
            verdict="UNLOADED",
            severity="info",
            max_torque_nmm=round(max_t, 2),
            sizing_ratio=round(ratio, 6),
            is_loaded=False,
            detail=(
                f"Actuator is running unloaded (max torque {max_t:.1f} Nmm = "
                f"{ratio*100:.2f}% of rated {rated_torque:.0f} Nmm). "
                f"This is the internal friction baseline. "
                f"In a real installation, torque should be 20-80% of rated capacity. "
                f"Baseline friction: {mean_t:.2f} Nmm — useful as reference for "
                f"future degradation monitoring."
            ),
        )

    # Loaded actuator — normal sizing analysis
    if ratio < 0.10:
        verdict, sev = "OVERSIZED", "fail"
        detail = (f"Peak torque only {ratio*100:.1f}% of capacity. "
                  f"Valve significantly oversized — poor control resolution.")
    elif ratio < 0.20:
        verdict, sev = "OVERSIZED", "warn"
        detail = f"Peak torque at {ratio*100:.1f}% — valve may be slightly oversized."
    elif ratio > 0.85:
        verdict, sev = "UNDERSIZED", "fail"
        detail = (f"Peak torque at {ratio*100:.1f}% — actuator near limit. "
                  f"May stall under system pressure.")
    elif ratio > 0.75:
        verdict, sev = "UNDERSIZED", "warn"
        detail = f"Peak torque at {ratio*100:.1f}% — marginal sizing."
    else:
        verdict, sev = "OK", "pass"
        detail = (f"Peak torque at {ratio*100:.1f}% of capacity. "
                  f"Good torque margin for reliable operation.")

    return SizingResult(verdict, sev, round(max_t, 2), round(ratio, 4),
                        is_loaded, detail)


# ===================================================================
#  ANALYSIS 2: Linkage / Dead Band
# ===================================================================
def analyze_linkage(df: pd.DataFrame) -> LinkageResult:
    if "torque_nmm" not in df.columns or "position" not in df.columns:
        return LinkageResult("UNKNOWN", "warn", 0, "Insufficient data")

    # Use opening direction data, sorted by position
    if "direction" in df.columns:
        opening = df[df["direction"] == "opening"].sort_values("position")
    else:
        opening = df.sort_values("position")

    if opening.empty or len(opening) < 5:
        return LinkageResult("UNKNOWN", "warn", 0, "Not enough data points")

    torque_abs = opening["torque_nmm"].abs()
    max_torque = torque_abs.max()
    if max_torque == 0:
        return LinkageResult("UNKNOWN", "warn", 0, "Zero torque — cannot analyze")

    # Threshold: 15% of max torque (slightly higher threshold for robustness)
    threshold = max_torque * 0.15
    above = opening[torque_abs > threshold]

    if above.empty:
        return LinkageResult("UNKNOWN", "warn", 0, "Could not determine torque onset")

    first_loaded = above["position"].iloc[0]
    start = opening["position"].iloc[0]
    dead_band = abs(first_loaded - start)

    if dead_band > 8:
        return LinkageResult(
            "LOOSE", "fail", round(dead_band, 1),
            f"Dead band of {dead_band:.1f}% — actuator travels {dead_band:.1f}% "
            f"before engaging valve. Tighten coupling.")
    elif dead_band > 4:
        return LinkageResult(
            "MARGINAL", "warn", round(dead_band, 1),
            f"Dead band of {dead_band:.1f}% — slight play in linkage.")
    else:
        return LinkageResult(
            "TIGHT", "pass", round(dead_band, 1),
            f"Dead band of {dead_band:.1f}% — linkage properly secured.")


# ===================================================================
#  ANALYSIS 3: Friction Map
# ===================================================================
def analyze_friction(df: pd.DataFrame, n_bins: int = 20) -> FrictionResult:
    if "torque_nmm" not in df.columns or "position" not in df.columns:
        return FrictionResult("UNKNOWN", "warn", [], 0, [], "Insufficient data")

    df_c = df[["position", "torque_nmm"]].dropna().copy()
    df_c["torque_abs"] = df_c["torque_nmm"].abs()

    # Bin by position
    bins = pd.cut(df_c["position"], bins=n_bins, labels=False)
    df_c["bin"] = bins

    stats = df_c.groupby("bin")["torque_abs"].agg(["mean", "std", "max", "count"])
    # Add position centers
    bin_width = 100.0 / n_bins
    stats["pos_center"] = stats.index * bin_width + bin_width / 2

    running_mean = stats["mean"].mean()
    running_std = stats["mean"].std()

    if running_mean == 0:
        return FrictionResult("UNKNOWN", "warn", [], 0, [], "Zero mean torque")

    # Find anomalies: bins where torque is >1.5x running average
    anomalies = []
    for idx, row in stats.iterrows():
        ratio = row["mean"] / running_mean if running_mean > 0 else 0
        if ratio > 1.5 and row["count"] >= 2:
            anomalies.append({
                "position_pct": round(row["pos_center"], 1),
                "torque_ratio": round(ratio, 2),
                "torque_mean_nmm": round(row["mean"], 2),
            })

    # Smoothness score: 1 - normalized std deviation
    cv = running_std / running_mean if running_mean > 0 else 1
    smoothness = round(max(0, min(1, 1 - cv)), 3)

    # Per-bin torque for visualization
    torque_by_bin = [
        {"position": round(r["pos_center"], 1), "torque_mean": round(r["mean"], 2)}
        for _, r in stats.iterrows()
    ]

    if len(anomalies) > 3:
        return FrictionResult(
            "HIGH_FRICTION", "fail", anomalies, smoothness, torque_by_bin,
            f"{len(anomalies)} friction anomalies detected. Smoothness: {smoothness:.2f}. "
            f"Worst at {anomalies[0]['position_pct']}% ({anomalies[0]['torque_ratio']:.1f}x avg).")
    elif len(anomalies) > 0:
        spots = ", ".join(f"{a['position_pct']}%" for a in anomalies)
        return FrictionResult(
            "BINDING_SPOTS", "warn", anomalies, smoothness, torque_by_bin,
            f"{len(anomalies)} binding spot(s) at {spots}. Smoothness: {smoothness:.2f}.")
    else:
        return FrictionResult(
            "SMOOTH", "pass", [], smoothness, torque_by_bin,
            f"No friction anomalies. Smoothness: {smoothness:.2f}. Clean operation.")


# ===================================================================
#  ANALYSIS 4: Step Response
# ===================================================================
def analyze_steps(df: pd.DataFrame) -> StepResponseResult:
    if "step_from" not in df.columns or "step_to" not in df.columns:
        return StepResponseResult("UNKNOWN", "warn", 0, [], 0, [], "No step data")

    steps = df.groupby(["step_from", "step_to"])
    transit_times = []
    overshoots = []
    settling_times = []

    for (sf, st), group in steps:
        group = group.sort_values("time_s")
        if len(group) < 3:
            continue

        target = st
        tolerance = abs(st - sf) * 0.05 + 1.0  # 5% of step + 1%

        # Transit time: time to first reach within tolerance of target
        reached = group[group["position"].sub(target).abs() < tolerance]
        if not reached.empty:
            tt = reached["time_s"].iloc[0]
            transit_times.append({
                "from": sf, "to": st,
                "transit_s": round(tt, 2),
                "step_size": abs(st - sf)
            })
        else:
            transit_times.append({
                "from": sf, "to": st,
                "transit_s": None,
                "step_size": abs(st - sf)
            })

        # Overshoot: max deviation past target in direction of motion
        direction = 1 if st > sf else -1
        if direction > 0:
            overshoot_val = (group["position"] - target).max()
        else:
            overshoot_val = (target - group["position"]).max()
        overshoot_pct = max(0, overshoot_val)
        overshoots.append(overshoot_pct)

        # Settling time: last time position is outside tolerance band
        outside = group[group["position"].sub(target).abs() >= tolerance]
        if not outside.empty:
            settle = outside["time_s"].iloc[-1]
            settling_times.append(round(settle, 2))

    valid_tt = [t["transit_s"] for t in transit_times if t["transit_s"] is not None]
    avg_tt = np.mean(valid_tt) if valid_tt else 0
    avg_overshoot = np.mean(overshoots) if overshoots else 0

    # Verdict based on overshoot
    if avg_overshoot > 5:
        verdict, sev = "SLUGGISH", "warn"
        detail = (f"Average overshoot: {avg_overshoot:.1f}%, "
                  f"avg transit: {avg_tt:.1f}s. Response is slow with significant overshoot.")
    elif avg_overshoot > 2:
        verdict, sev = "ACCEPTABLE", "pass"
        detail = (f"Average overshoot: {avg_overshoot:.1f}%, "
                  f"avg transit: {avg_tt:.1f}s. Normal response dynamics.")
    else:
        verdict, sev = "CRISP", "pass"
        detail = (f"Average overshoot: {avg_overshoot:.1f}%, "
                  f"avg transit: {avg_tt:.1f}s. Excellent step response.")

    return StepResponseResult(
        verdict, sev, round(avg_tt, 2), transit_times,
        round(avg_overshoot, 2), settling_times, detail)


# ===================================================================
#  ANALYSIS 5: Hunting Risk (improved)
# ===================================================================
def analyze_hunting(df: pd.DataFrame) -> HuntingRiskResult:
    if "setpoint" not in df.columns or "position" not in df.columns:
        return HuntingRiskResult("UNKNOWN", "warn", 0, 0, 0, None, [], "No data")

    per_config = []

    # Analyze per frequency config if available
    if "frequency_hz" in df.columns:
        configs = df.groupby("frequency_hz")
    else:
        configs = [("all", df)]

    all_errors = []
    all_overshoots = []

    for freq, group in configs:
        group = group.sort_values("time_s").copy()
        error = (group["position"] - group["setpoint"]).abs()
        signed_error = group["position"] - group["setpoint"]

        avg_err = error.mean()
        max_err = error.max()
        all_errors.append(avg_err)

        # Overshoot: position goes beyond setpoint direction
        sp_change = group["setpoint"].diff()
        overshoot_mask = (signed_error * sp_change) > 0
        max_os = error[overshoot_mask].max() if overshoot_mask.any() else 0
        all_overshoots.append(max_os)

        # Phase lag estimation
        # Cross-correlate setpoint and position to find lag
        sp = group["setpoint"].values - group["setpoint"].mean()
        pos = group["position"].values - group["position"].mean()
        if len(sp) > 20:
            corr = np.correlate(sp, pos, mode="full")
            mid = len(corr) // 2
            # Look for peak in positive lag region (position lags setpoint)
            search = corr[mid:mid+len(sp)//2]
            if len(search) > 0:
                lag_samples = np.argmax(search)
                dt = np.median(np.diff(group["time_s"].values))
                lag_s = lag_samples * dt if dt > 0 else 0
            else:
                lag_s = 0
        else:
            lag_s = 0

        per_config.append({
            "frequency_hz": float(freq) if freq != "all" else None,
            "avg_error_pct": round(avg_err, 2),
            "max_overshoot_pct": round(max_os, 2),
            "phase_lag_s": round(lag_s, 2),
            "n_samples": len(group),
        })

    # Global metrics
    total_avg_error = np.mean(all_errors)
    total_max_overshoot = max(all_overshoots) if all_overshoots else 0

    # FFT on full position signal
    position = df.sort_values("time_s")["position"].values
    dominant_freq = None
    hunting_ratio = 0
    if len(position) > 50:
        pos_det = position - np.mean(position)
        dt = np.median(np.diff(df.sort_values("time_s")["time_s"].values))
        if dt > 0:
            freqs = np.fft.rfftfreq(len(pos_det), d=dt)
            fft_mag = np.abs(np.fft.rfft(pos_det))
            fft_mag[0] = 0
            if len(fft_mag) > 1:
                dominant_freq = float(freqs[np.argmax(fft_mag)])
                band = (freqs > 0.01) & (freqs < 1.0)
                total_power = np.sum(fft_mag ** 2)
                hunting_ratio = np.sum(fft_mag[band] ** 2) / total_power if total_power > 0 else 0

    # Risk score
    os_score = min(40, total_max_overshoot * 1.0)  # 40% overshoot = 40 pts
    err_score = min(30, total_avg_error * 3)
    hunt_score = min(30, hunting_ratio * 100)
    risk = os_score + err_score + hunt_score

    if risk > 60:
        verdict, sev = "HIGH_RISK", "fail"
        gain_reduction = min(50, int(risk * 0.6))
        detail = (f"Hunting risk: {risk:.0f}/100 — HIGH. "
                  f"Max overshoot: {total_max_overshoot:.1f}%, "
                  f"avg error: {total_avg_error:.1f}%. "
                  f"Recommend reducing proportional gain by ~{gain_reduction}%.")
    elif risk > 30:
        verdict, sev = "MODERATE_RISK", "warn"
        detail = (f"Hunting risk: {risk:.0f}/100 — moderate. "
                  f"Overshoot: {total_max_overshoot:.1f}%, error: {total_avg_error:.1f}%.")
    else:
        verdict, sev = "LOW_RISK", "pass"
        detail = (f"Hunting risk: {risk:.0f}/100 — low. "
                  f"Good tracking. Overshoot: {total_max_overshoot:.1f}%.")

    return HuntingRiskResult(
        verdict, sev, round(risk, 1), round(total_max_overshoot, 1),
        round(total_avg_error, 1), dominant_freq, per_config, detail)


# ===================================================================
#  HEALTH SCORE (recalibrated)
# ===================================================================
def compute_health(sizing, linkage, friction, steps, hunting,
                   df_sweep) -> HealthScore:
    components = {}

    # Sizing: 25 pts
    if sizing.is_loaded:
        components["sizing"] = {"pass": 25, "warn": 15, "fail": 5}.get(sizing.severity, 12)
    else:
        # Unloaded — give neutral score, don't penalize
        components["sizing"] = 18  # "we can't tell, but nothing wrong detected"

    # Linkage: 20 pts
    components["linkage"] = {"pass": 20, "warn": 12, "fail": 4}.get(linkage.severity, 10)

    # Friction: 20 pts
    components["friction"] = round(friction.smoothness_score * 20, 1)

    # Transit consistency: 15 pts
    components["transit"] = 12  # default
    if steps and steps.transit_times:
        valid = [t["transit_s"] for t in steps.transit_times if t["transit_s"] is not None]
        if len(valid) > 2:
            cv = np.std(valid) / np.mean(valid) if np.mean(valid) > 0 else 1
            components["transit"] = round(max(0, 15 * (1 - cv * 3)), 1)

    # Symmetry: 20 pts (opening vs closing torque)
    components["symmetry"] = 20
    if "direction" in df_sweep.columns and "torque_nmm" in df_sweep.columns:
        op = df_sweep[df_sweep["direction"] == "opening"]["torque_nmm"].abs()
        cl = df_sweep[df_sweep["direction"] == "closing"]["torque_nmm"].abs()
        if len(op) > 0 and len(cl) > 0:
            op_mean, cl_mean = op.mean(), cl.mean()
            if min(op_mean, cl_mean) > 0:
                ratio = max(op_mean, cl_mean) / min(op_mean, cl_mean)
                components["symmetry"] = round(max(0, 20 * (1 - (ratio - 1) / 2)), 1)

    total = int(round(sum(components.values())))
    total = max(0, min(100, total))

    grades = [(90, "A"), (75, "B"), (60, "C"), (40, "D"), (0, "F")]
    grade = next(g for threshold, g in grades if total >= threshold)

    breakdown = ", ".join(f"{k}: {v}" for k, v in components.items())
    return HealthScore(total, grade, components,
                       f"Health: {total}/100 (Grade {grade}). {breakdown}.")


# ===================================================================
#  RECOMMENDATIONS
# ===================================================================
def generate_recs(report: DiagnosticReport) -> list:
    recs = []

    # Sizing
    if report.sizing.severity == "fail":
        recs.append({"priority": "CRITICAL", "category": "sizing",
                      "action": f"Valve sizing: {report.sizing.verdict}",
                      "detail": report.sizing.detail})
    elif report.sizing.severity == "info" and not report.sizing.is_loaded:
        recs.append({"priority": "INFO", "category": "sizing",
                      "action": "Actuator running unloaded — sizing cannot be assessed",
                      "detail": report.sizing.detail})

    # Linkage
    if report.linkage.severity in ("fail", "warn"):
        recs.append({"priority": "CRITICAL" if report.linkage.severity == "fail" else "MONITOR",
                      "category": "linkage",
                      "action": f"Linkage: {report.linkage.verdict} ({report.linkage.dead_band_pct}% dead band)",
                      "detail": report.linkage.detail})

    # Friction
    if report.friction.severity in ("fail", "warn"):
        recs.append({"priority": "HIGH" if report.friction.severity == "fail" else "MONITOR",
                      "category": "friction",
                      "action": f"Friction: {report.friction.verdict}",
                      "detail": report.friction.detail})

    # Hunting
    if report.hunting and report.hunting.severity in ("fail", "warn"):
        recs.append({"priority": "HIGH" if report.hunting.severity == "fail" else "MONITOR",
                      "category": "hunting",
                      "action": f"Hunting risk: {report.hunting.risk_score:.0f}/100",
                      "detail": report.hunting.detail})

    # Steps
    if report.steps and report.steps.severity == "warn":
        recs.append({"priority": "MONITOR", "category": "response",
                      "action": f"Step response: {report.steps.verdict}",
                      "detail": report.steps.detail})

    if not recs:
        recs.append({"priority": "NONE", "category": "overall",
                      "action": "All checks passed",
                      "detail": f"Health: {report.health.score}/100 ({report.health.grade})"})

    return recs


# ===================================================================
#  MAIN PIPELINE
# ===================================================================
def run_full_analysis(data_dir: str, rated_torque: float = RATED_TORQUE_NMM) -> DiagnosticReport:
    data_dir = Path(data_dir)
    print(f"\n{'='*60}")
    print(f"  ActuatorIQ v2 — Full Analysis")
    print(f"  Data directory: {data_dir}")
    print(f"  Rated torque: {rated_torque} Nmm")
    print(f"{'='*60}")

    # Load sweep data
    sweep_files = sorted(data_dir.glob("sweep_*.csv"))
    steps_files = sorted(data_dir.glob("steps_*.csv"))
    hunting_files = sorted(data_dir.glob("hunting_*.csv"))

    if not sweep_files:
        print("  ERROR: No sweep CSV files found!")
        return None

    df_sweep = pd.read_csv(sweep_files[0])
    print(f"\n  Loaded sweep: {sweep_files[0].name} ({len(df_sweep)} samples)")

    # Detect load state
    is_loaded = detect_load_state(df_sweep, rated_torque)
    print(f"  Load state: {'LOADED' if is_loaded else 'UNLOADED (demo rig)'}")

    # Run analyses
    print("\n  [1/5] Sizing analysis...")
    sizing = analyze_sizing(df_sweep, rated_torque)
    print(f"    → {sizing.verdict} ({sizing.severity})")

    print("  [2/5] Linkage analysis...")
    linkage = analyze_linkage(df_sweep)
    print(f"    → {linkage.verdict} ({linkage.severity}, {linkage.dead_band_pct}% dead band)")

    print("  [3/5] Friction analysis...")
    friction = analyze_friction(df_sweep)
    print(f"    → {friction.verdict} (smoothness: {friction.smoothness_score})")

    # Steps (optional)
    steps_result = None
    if steps_files:
        print("  [4/5] Step response analysis...")
        df_steps = pd.read_csv(steps_files[0])
        print(f"    Loaded steps: {steps_files[0].name} ({len(df_steps)} samples)")
        steps_result = analyze_steps(df_steps)
        print(f"    → {steps_result.verdict} (avg transit: {steps_result.avg_transit_time_s}s)")
    else:
        print("  [4/5] Step response — no data, skipping")

    # Hunting (optional)
    hunting_result = None
    if hunting_files:
        print("  [5/5] Hunting analysis...")
        df_hunt = pd.read_csv(hunting_files[0])
        print(f"    Loaded hunting: {hunting_files[0].name} ({len(df_hunt)} samples)")
        hunting_result = analyze_hunting(df_hunt)
        print(f"    → {hunting_result.verdict} (risk: {hunting_result.risk_score}/100)")
    else:
        print("  [5/5] Hunting — no data, skipping")

    # Health score
    print("\n  Computing health score...")
    health = compute_health(sizing, linkage, friction, steps_result,
                            hunting_result, df_sweep)
    print(f"  → {health.score}/100 (Grade {health.grade})")

    # Build report
    report = DiagnosticReport(
        actuator_model="LM" if rated_torque >= 5000 else "CQ",
        is_loaded=is_loaded,
        sizing=sizing, linkage=linkage, friction=friction,
        steps=steps_result, hunting=hunting_result,
        health=health, recommendations=[],
    )
    report.recommendations = generate_recs(report)

    return report


def print_report(report: DiagnosticReport):
    print(f"\n{'='*60}")
    print(f"  ActuatorIQ — DIAGNOSTIC REPORT")
    print(f"  Model: {report.actuator_model} series")
    print(f"  Load state: {'Loaded' if report.is_loaded else 'Unloaded (demo rig)'}")
    print(f"{'='*60}")

    severity_icon = {"pass": "✅", "warn": "⚠️ ", "fail": "❌", "info": "ℹ️ "}

    print(f"\n  HEALTH SCORE: {report.health.score}/100 (Grade {report.health.grade})")
    for k, v in report.health.components.items():
        print(f"    {k:12s}: {v}")

    print(f"\n  {severity_icon.get(report.sizing.severity, '  ')} SIZING: {report.sizing.verdict}")
    print(f"    {report.sizing.detail}")

    print(f"\n  {severity_icon.get(report.linkage.severity, '  ')} LINKAGE: {report.linkage.verdict}")
    print(f"    {report.linkage.detail}")

    print(f"\n  {severity_icon.get(report.friction.severity, '  ')} FRICTION: {report.friction.verdict}")
    print(f"    {report.friction.detail}")

    if report.steps:
        print(f"\n  {severity_icon.get(report.steps.severity, '  ')} STEP RESPONSE: {report.steps.verdict}")
        print(f"    {report.steps.detail}")

    if report.hunting:
        print(f"\n  {severity_icon.get(report.hunting.severity, '  ')} HUNTING: {report.hunting.verdict}")
        print(f"    {report.hunting.detail}")
        if report.hunting.per_config_results:
            print(f"    Per-frequency breakdown:")
            for cfg in report.hunting.per_config_results:
                f = cfg.get("frequency_hz")
                freq_str = f"{f:.3f} Hz" if f else "all"
                print(f"      {freq_str:>10s}: error={cfg['avg_error_pct']:.1f}%, "
                      f"overshoot={cfg['max_overshoot_pct']:.1f}%, "
                      f"lag={cfg['phase_lag_s']:.2f}s")

    print(f"\n  RECOMMENDATIONS:")
    icons = {"CRITICAL": "🔴", "HIGH": "🟠", "MONITOR": "🟡",
             "INFO": "🔵", "NONE": "🟢"}
    for rec in report.recommendations:
        print(f"    {icons.get(rec['priority'], '⚪')} [{rec['priority']}] {rec['action']}")

    print(f"\n{'='*60}")


def save_report(report: DiagnosticReport, path: str):
    def convert(obj):
        if hasattr(obj, '__dict__'):
            return {k: convert(v) for k, v in obj.__dict__.items()}
        elif isinstance(obj, list):
            return [convert(i) for i in obj]
        elif isinstance(obj, (np.integer,)):
            return int(obj)
        elif isinstance(obj, (np.floating,)):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        return obj

    with open(path, "w") as f:
        json.dump(convert(report), f, indent=2, default=str)
    print(f"\n  💾 Report → {path}")


# ===================================================================
#  CLI
# ===================================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ActuatorIQ Analysis v2")
    parser.add_argument("--data-dir", type=str, default="experiment_data")
    parser.add_argument("--rated-torque", type=float, default=RATED_TORQUE_NMM)
    parser.add_argument("--output", type=str, default=None)
    args = parser.parse_args()

    if args.output is None:
        args.output = str(Path(args.data_dir) / "report_v2.json")

    report = run_full_analysis(args.data_dir, args.rated_torque)
    if report:
        print_report(report)
        save_report(report, args.output)