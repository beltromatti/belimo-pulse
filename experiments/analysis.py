"""
ActuatorIQ — Analysis Engine
==============================
Takes raw experiment CSVs and computes 5 diagnostic insights:
  1. Sizing check (over/undersized valve)
  2. Linkage / dead band detection
  3. Friction map (binding spots)
  4. Composite health score (0-100)
  5. Hunting risk score

Usage:
  python analysis.py --sweep-file experiment_data/sweep_test100.csv
  python analysis.py --all --data-dir experiment_data/
"""

import argparse
import json
import numpy as np
import pandas as pd
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Optional


# Belimo LM series: 5 Nm = 5000 Nmm
# Belimo CQ series: 1 Nm = 1000 Nmm
RATED_TORQUE_NMM = 5000


# ===================================================================
#  Data classes for structured results
# ===================================================================
@dataclass
class SizingResult:
    verdict: str           # "OK", "OVERSIZED", "UNDERSIZED"
    severity: str          # "pass", "warn", "fail"
    max_torque_nmm: float
    sizing_ratio: float    # max_torque / rated_torque
    detail: str

@dataclass
class LinkageResult:
    verdict: str
    severity: str
    dead_band_pct: float   # degrees of dead band as % of travel
    detail: str

@dataclass
class FrictionResult:
    verdict: str
    severity: str
    friction_map: list     # list of (position_pct, torque_ratio) for anomalies
    smoothness_score: float  # 0-1, how smooth the torque curve is
    detail: str

@dataclass
class HuntingRiskResult:
    verdict: str
    severity: str
    risk_score: float        # 0-100
    max_overshoot_pct: float
    avg_tracking_error: float
    dominant_frequency_hz: Optional[float]
    detail: str

@dataclass
class HealthScore:
    score: int              # 0-100
    grade: str              # A, B, C, D, F
    sizing_component: float
    linkage_component: float
    friction_component: float
    transit_component: float
    symmetry_component: float
    detail: str

@dataclass
class DiagnosticReport:
    sizing: SizingResult
    linkage: LinkageResult
    friction: FrictionResult
    hunting: Optional[HuntingRiskResult]
    health: HealthScore
    recommendations: list


# ===================================================================
#  Analysis functions
# ===================================================================

def analyze_sizing(df: pd.DataFrame, rated_torque: float = RATED_TORQUE_NMM) -> SizingResult:
    """
    Determine if the valve-actuator pairing is correctly sized.

    Logic:
    - max torque < 20% of rated → OVERSIZED valve (poor control resolution)
    - max torque > 80% of rated → UNDERSIZED actuator (will fail under load)
    - 20-80% → correctly sized
    """
    torque_col = "torque_nmm"
    if torque_col not in df.columns:
        return SizingResult("UNKNOWN", "warn", 0, 0, "No torque data available")

    # Use absolute torque values (sign can be inconsistent per README)
    max_torque = df[torque_col].abs().max()
    mean_running = df[torque_col].abs().mean()
    ratio = max_torque / rated_torque

    if ratio < 0.10:
        return SizingResult(
            "OVERSIZED", "fail", max_torque, ratio,
            f"Peak torque is only {ratio*100:.1f}% of actuator capacity ({max_torque:.0f}/{rated_torque:.0f} Nmm). "
            f"Valve is significantly oversized. Control resolution will be very poor — "
            f"small signal changes produce large flow changes, causing hunting."
        )
    elif ratio < 0.20:
        return SizingResult(
            "OVERSIZED", "warn", max_torque, ratio,
            f"Peak torque at {ratio*100:.1f}% of capacity. Valve may be slightly oversized. "
            f"Monitor for control stability."
        )
    elif ratio > 0.85:
        return SizingResult(
            "UNDERSIZED", "fail", max_torque, ratio,
            f"Peak torque at {ratio*100:.1f}% of capacity ({max_torque:.0f}/{rated_torque:.0f} Nmm). "
            f"Actuator is at torque limit. Under real operating conditions with system pressure, "
            f"the actuator may stall. Recommend upsizing actuator."
        )
    elif ratio > 0.75:
        return SizingResult(
            "UNDERSIZED", "warn", max_torque, ratio,
            f"Peak torque at {ratio*100:.1f}% of capacity. Marginal sizing — "
            f"may have issues under high differential pressure."
        )
    else:
        return SizingResult(
            "OK", "pass", max_torque, ratio,
            f"Peak torque at {ratio*100:.1f}% of capacity. Good sizing — "
            f"adequate torque margin for reliable operation."
        )


def analyze_linkage(df: pd.DataFrame) -> LinkageResult:
    """
    Detect dead band (loose coupling between actuator and valve).

    Logic:
    - At stroke start, if position changes but torque stays near zero,
      the actuator is spinning without loading the valve.
    - Dead band > 5% of travel = loose coupling.
    """
    torque_col = "torque_nmm"
    pos_col = "position"

    if torque_col not in df.columns or pos_col not in df.columns:
        return LinkageResult("UNKNOWN", "warn", 0, "Insufficient data")

    # Filter to opening direction only
    opening = df[df.get("direction", "opening") == "opening"].copy()
    if opening.empty:
        # Try using all data sorted by position
        opening = df.sort_values(pos_col)

    # Find where torque first exceeds a threshold (10% of max torque)
    torque_abs = opening[torque_col].abs()
    threshold = torque_abs.max() * 0.10

    above_threshold = opening[torque_abs > threshold]
    if above_threshold.empty:
        return LinkageResult("UNKNOWN", "warn", 0, "Could not determine torque onset")

    first_loaded_pos = above_threshold[pos_col].iloc[0]
    start_pos = opening[pos_col].iloc[0]
    dead_band = abs(first_loaded_pos - start_pos)

    if dead_band > 8:
        return LinkageResult(
            "LOOSE", "fail", dead_band,
            f"Dead band of {dead_band:.1f}% detected. Actuator travels {dead_band:.1f}% "
            f"before engaging valve. Shaft coupling is loose — tighten set screws "
            f"or replace coupling."
        )
    elif dead_band > 4:
        return LinkageResult(
            "MARGINAL", "warn", dead_band,
            f"Dead band of {dead_band:.1f}% — slight play in the linkage. "
            f"Check set screws and coupling alignment."
        )
    else:
        return LinkageResult(
            "TIGHT", "pass", dead_band,
            f"Dead band of {dead_band:.1f}% — linkage is properly secured."
        )


def analyze_friction(df: pd.DataFrame, n_bins: int = 20) -> FrictionResult:
    """
    Map friction across the full stroke to find binding spots.

    Logic:
    - Bin position into N segments
    - Compute mean torque per bin
    - Flag positions where torque > 1.5x the running average
    """
    torque_col = "torque_nmm"
    pos_col = "position"

    if torque_col not in df.columns or pos_col not in df.columns:
        return FrictionResult("UNKNOWN", "warn", [], 0, "Insufficient data")

    df_clean = df[[pos_col, torque_col]].dropna()
    df_clean["torque_abs"] = df_clean[torque_col].abs()

    # Bin by position
    df_clean["pos_bin"] = pd.cut(df_clean[pos_col], bins=n_bins, labels=False)
    bin_stats = df_clean.groupby("pos_bin")["torque_abs"].agg(["mean", "std", "max"])
    bin_stats["pos_center"] = np.linspace(
        100 / (2 * n_bins), 100 - 100 / (2 * n_bins), n_bins
    )[:len(bin_stats)]

    running_mean = bin_stats["mean"].mean()
    if running_mean == 0:
        return FrictionResult("UNKNOWN", "warn", [], 0, "Zero mean torque — no load detected")

    # Find anomalous bins
    anomalies = []
    for _, row in bin_stats.iterrows():
        ratio = row["mean"] / running_mean
        if ratio > 1.5:
            anomalies.append({
                "position_pct": round(row["pos_center"], 1),
                "torque_ratio": round(ratio, 2),
                "torque_mean": round(row["mean"], 1),
            })

    # Compute smoothness: coefficient of variation across bins
    cv = bin_stats["mean"].std() / bin_stats["mean"].mean() if bin_stats["mean"].mean() > 0 else 1
    smoothness = max(0, 1 - cv)  # 1 = perfectly smooth, 0 = very rough

    if len(anomalies) > 3:
        return FrictionResult(
            "HIGH_FRICTION", "fail", anomalies, smoothness,
            f"Multiple friction anomalies detected at {len(anomalies)} positions. "
            f"Smoothness score: {smoothness:.2f}/1.00. "
            f"Investigate valve for debris, corrosion, or packing wear. "
            f"Worst spot: {anomalies[0]['position_pct']}% position "
            f"({anomalies[0]['torque_ratio']:.1f}x average torque)."
        )
    elif len(anomalies) > 0:
        return FrictionResult(
            "BINDING_SPOTS", "warn", anomalies, smoothness,
            f"{len(anomalies)} binding spot(s) detected. "
            f"Smoothness: {smoothness:.2f}/1.00. "
            f"Spots at: {', '.join(str(a['position_pct'])+'%' for a in anomalies)}."
        )
    else:
        return FrictionResult(
            "SMOOTH", "pass", [], smoothness,
            f"No friction anomalies. Smoothness: {smoothness:.2f}/1.00. "
            f"Valve operates cleanly across full stroke."
        )


def analyze_hunting_risk(df: pd.DataFrame) -> HuntingRiskResult:
    """
    Analyze oscillation data to determine hunting risk.

    Uses:
    - Overshoot measurement
    - Tracking error (setpoint vs position)
    - FFT to find dominant oscillation frequency
    """
    if "setpoint" not in df.columns or "position" not in df.columns:
        return HuntingRiskResult("UNKNOWN", "warn", 0, 0, 0, None, "No hunting data")

    # Tracking error
    df_clean = df[["setpoint", "position", "time_s"]].dropna()
    error = (df_clean["position"] - df_clean["setpoint"]).abs()
    avg_error = error.mean()
    max_error = error.max()

    # Overshoot: when position goes beyond setpoint in the direction of motion
    signed_error = df_clean["position"] - df_clean["setpoint"]
    setpoint_change = df_clean["setpoint"].diff()
    # Overshoot occurs when error sign matches the direction of setpoint change
    overshoot_mask = (signed_error * setpoint_change) > 0
    max_overshoot = error[overshoot_mask].max() if overshoot_mask.any() else 0

    # FFT on position signal to find dominant oscillation
    position = df_clean["position"].values
    if len(position) > 50:
        # Detrend
        position_detrended = position - np.mean(position)
        # Estimate sampling rate from time column
        dt = np.median(np.diff(df_clean["time_s"].values))
        if dt > 0:
            fs = 1.0 / dt
            freqs = np.fft.rfftfreq(len(position_detrended), d=dt)
            fft_mag = np.abs(np.fft.rfft(position_detrended))
            # Ignore DC component
            fft_mag[0] = 0
            # Find dominant frequency
            dominant_idx = np.argmax(fft_mag)
            dominant_freq = freqs[dominant_idx] if dominant_idx < len(freqs) else None

            # Hunting ratio: power in 0.01-1Hz band vs total
            band_mask = (freqs > 0.01) & (freqs < 1.0)
            band_power = np.sum(fft_mag[band_mask] ** 2)
            total_power = np.sum(fft_mag ** 2)
            hunting_ratio = band_power / total_power if total_power > 0 else 0
        else:
            dominant_freq = None
            hunting_ratio = 0
    else:
        dominant_freq = None
        hunting_ratio = 0

    # Compute risk score (0-100)
    # Components:
    #   - overshoot penalty (0-40 pts)
    #   - tracking error penalty (0-30 pts)
    #   - hunting ratio penalty (0-30 pts)
    overshoot_score = min(40, max_overshoot * 4)  # 10% overshoot = 40 pts
    error_score = min(30, avg_error * 3)           # 10% avg error = 30 pts
    hunting_score = min(30, hunting_ratio * 100)   # ratio 0.3 = 30 pts
    risk_score = overshoot_score + error_score + hunting_score

    if risk_score > 60:
        severity = "fail"
        verdict = "HIGH_RISK"
        detail = (
            f"Hunting risk score: {risk_score:.0f}/100 — HIGH. "
            f"Max overshoot: {max_overshoot:.1f}%, avg tracking error: {avg_error:.1f}%. "
            f"This actuator-valve combination will likely oscillate under real control. "
            f"Recommend reducing proportional gain by ~{min(50, int(risk_score*0.6))}%."
        )
    elif risk_score > 30:
        severity = "warn"
        verdict = "MODERATE_RISK"
        detail = (
            f"Hunting risk: {risk_score:.0f}/100 — moderate. "
            f"Overshoot: {max_overshoot:.1f}%, error: {avg_error:.1f}%. "
            f"May hunt under certain load conditions. Monitor after commissioning."
        )
    else:
        severity = "pass"
        verdict = "LOW_RISK"
        detail = (
            f"Hunting risk: {risk_score:.0f}/100 — low. "
            f"Good tracking performance. Overshoot: {max_overshoot:.1f}%, "
            f"error: {avg_error:.1f}%."
        )

    return HuntingRiskResult(
        verdict, severity, risk_score, max_overshoot,
        avg_error, dominant_freq, detail,
    )


def compute_health_score(
    sizing: SizingResult,
    linkage: LinkageResult,
    friction: FrictionResult,
    df_sweep: pd.DataFrame,
) -> HealthScore:
    """
    Compute composite health score (0-100) from all diagnostics.

    Weights:
    - Sizing appropriateness: 25 pts
    - Linkage quality: 20 pts
    - Friction smoothness: 20 pts
    - Transit time consistency: 15 pts
    - Torque symmetry (open vs close): 20 pts
    """

    # Sizing score (25 pts)
    if sizing.severity == "pass":
        sizing_pts = 25
    elif sizing.severity == "warn":
        sizing_pts = 15
    else:
        sizing_pts = 5

    # Linkage score (20 pts)
    if linkage.severity == "pass":
        linkage_pts = 20
    elif linkage.severity == "warn":
        linkage_pts = 12
    else:
        linkage_pts = 4

    # Friction score (20 pts)
    friction_pts = friction.smoothness_score * 20

    # Transit time consistency (15 pts)
    # Compare repeated sweeps — how consistent is the transit time?
    transit_pts = 15  # default if we can't compute
    if "repeat" in df_sweep.columns:
        repeats = df_sweep["repeat"].unique()
        if len(repeats) > 1:
            transit_times = []
            for rep in repeats:
                rep_data = df_sweep[df_sweep["repeat"] == rep]
                if len(rep_data) > 2:
                    tt = rep_data["time_s"].max() - rep_data["time_s"].min()
                    transit_times.append(tt)
            if len(transit_times) > 1:
                cv = np.std(transit_times) / np.mean(transit_times)
                transit_pts = max(0, 15 * (1 - cv * 5))  # 20% CV = 0 pts

    # Symmetry score (20 pts)
    symmetry_pts = 20
    if "direction" in df_sweep.columns and "torque_nmm" in df_sweep.columns:
        opening = df_sweep[df_sweep["direction"] == "opening"]["torque_nmm"].abs().mean()
        closing = df_sweep[df_sweep["direction"] == "closing"]["torque_nmm"].abs().mean()
        if opening > 0 and closing > 0:
            ratio = max(opening, closing) / min(opening, closing)
            # ratio of 1.0 = perfect symmetry = 20 pts
            # ratio of 2.0 = bad = ~5 pts
            symmetry_pts = max(0, 20 * (1 - (ratio - 1) / 2))

    total = int(round(sizing_pts + linkage_pts + friction_pts + transit_pts + symmetry_pts))
    total = max(0, min(100, total))

    if total >= 90:
        grade = "A"
    elif total >= 75:
        grade = "B"
    elif total >= 60:
        grade = "C"
    elif total >= 40:
        grade = "D"
    else:
        grade = "F"

    return HealthScore(
        score=total,
        grade=grade,
        sizing_component=round(sizing_pts, 1),
        linkage_component=round(linkage_pts, 1),
        friction_component=round(friction_pts, 1),
        transit_component=round(transit_pts, 1),
        symmetry_component=round(symmetry_pts, 1),
        detail=f"Health score: {total}/100 (Grade {grade}). "
               f"Sizing: {sizing_pts:.0f}/25, Linkage: {linkage_pts:.0f}/20, "
               f"Friction: {friction_pts:.0f}/20, Transit: {transit_pts:.0f}/15, "
               f"Symmetry: {symmetry_pts:.0f}/20.",
    )


def generate_recommendations(report: DiagnosticReport) -> list:
    """Generate prioritized action items from diagnostic results."""
    recs = []

    # Critical issues first
    if report.sizing.severity == "fail":
        recs.append({
            "priority": "CRITICAL",
            "action": f"Valve sizing issue: {report.sizing.verdict}",
            "detail": report.sizing.detail,
        })

    if report.linkage.severity == "fail":
        recs.append({
            "priority": "CRITICAL",
            "action": "Tighten actuator-valve coupling",
            "detail": report.linkage.detail,
        })

    if report.friction.severity == "fail":
        recs.append({
            "priority": "HIGH",
            "action": "Inspect valve internals for debris/corrosion",
            "detail": report.friction.detail,
        })

    if report.hunting and report.hunting.severity == "fail":
        recs.append({
            "priority": "HIGH",
            "action": "Reduce PI controller proportional gain",
            "detail": report.hunting.detail,
        })

    # Warnings
    for result in [report.sizing, report.linkage, report.friction]:
        if result.severity == "warn":
            recs.append({
                "priority": "MONITOR",
                "action": result.detail.split(".")[0],
                "detail": result.detail,
            })

    if not recs:
        recs.append({
            "priority": "NONE",
            "action": "No issues detected — installation passes all checks",
            "detail": f"Health score: {report.health.score}/100 ({report.health.grade})",
        })

    return recs


# ===================================================================
#  Main analysis pipeline
# ===================================================================
def analyze_sweep(csv_path: str, rated_torque: float = RATED_TORQUE_NMM) -> DiagnosticReport:
    """Run full analysis on sweep experiment data."""
    df = pd.read_csv(csv_path)
    print(f"\n  Loaded {len(df)} samples from {csv_path}")
    print(f"  Columns: {list(df.columns)}")

    print("\n  Analyzing sizing...")
    sizing = analyze_sizing(df, rated_torque)
    print(f"    → {sizing.verdict} ({sizing.severity})")

    print("  Analyzing linkage...")
    linkage = analyze_linkage(df)
    print(f"    → {linkage.verdict} ({linkage.severity})")

    print("  Analyzing friction...")
    friction = analyze_friction(df)
    print(f"    → {friction.verdict} ({friction.severity})")

    print("  Computing health score...")
    health = compute_health_score(sizing, linkage, friction, df)
    print(f"    → {health.score}/100 (Grade {health.grade})")

    report = DiagnosticReport(
        sizing=sizing,
        linkage=linkage,
        friction=friction,
        hunting=None,
        health=health,
        recommendations=[],
    )
    report.recommendations = generate_recommendations(report)

    return report


def analyze_hunting(csv_path: str) -> HuntingRiskResult:
    """Run hunting analysis on oscillation experiment data."""
    df = pd.read_csv(csv_path)
    print(f"\n  Loaded {len(df)} hunting samples from {csv_path}")

    result = analyze_hunting_risk(df)
    print(f"    → {result.verdict} (risk: {result.risk_score:.0f}/100)")
    return result


def print_report(report: DiagnosticReport):
    """Pretty-print the diagnostic report."""
    print("\n" + "=" * 60)
    print("  ActuatorIQ — Diagnostic Report")
    print("=" * 60)

    print(f"\n  🏥 HEALTH SCORE: {report.health.score}/100 (Grade {report.health.grade})")
    print(f"     {report.health.detail}")

    print(f"\n  📐 SIZING: {report.sizing.verdict}")
    print(f"     {report.sizing.detail}")

    print(f"\n  🔗 LINKAGE: {report.linkage.verdict}")
    print(f"     {report.linkage.detail}")

    print(f"\n  ⚙️  FRICTION: {report.friction.verdict}")
    print(f"     {report.friction.detail}")

    if report.hunting:
        print(f"\n  🌊 HUNTING RISK: {report.hunting.verdict}")
        print(f"     {report.hunting.detail}")

    print(f"\n  📋 RECOMMENDATIONS:")
    for i, rec in enumerate(report.recommendations, 1):
        icon = {"CRITICAL": "🔴", "HIGH": "🟠", "MONITOR": "🟡", "NONE": "🟢"}.get(
            rec["priority"], "⚪")
        print(f"     {icon} [{rec['priority']}] {rec['action']}")

    print("\n" + "=" * 60)


def save_report(report: DiagnosticReport, output_path: str):
    """Save report as JSON."""
    data = {
        "sizing": asdict(report.sizing),
        "linkage": asdict(report.linkage),
        "friction": asdict(report.friction),
        "hunting": asdict(report.hunting) if report.hunting else None,
        "health": asdict(report.health),
        "recommendations": report.recommendations,
    }
    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"\n  💾 Report saved → {output_path}")


# ===================================================================
#  CLI
# ===================================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ActuatorIQ Analysis Engine")
    parser.add_argument("--sweep-file", type=str, help="Path to sweep CSV")
    parser.add_argument("--hunting-file", type=str, help="Path to hunting CSV")
    parser.add_argument("--all", action="store_true", help="Analyze all files in data dir")
    parser.add_argument("--data-dir", type=str, default="experiment_data",
                        help="Directory containing experiment CSVs")
    parser.add_argument("--rated-torque", type=float, default=RATED_TORQUE_NMM,
                        help="Rated actuator torque in Nmm (5000 for LM, 1000 for CQ)")
    parser.add_argument("--output", type=str, default="experiment_data/report.json",
                        help="Output path for JSON report")
    args = parser.parse_args()

    report = None

    if args.sweep_file:
        report = analyze_sweep(args.sweep_file, args.rated_torque)

    if args.hunting_file:
        hunting = analyze_hunting(args.hunting_file)
        if report:
            report.hunting = hunting
            report.recommendations = generate_recommendations(report)

    if args.all:
        data_dir = Path(args.data_dir)
        sweep_files = list(data_dir.glob("sweep_*.csv"))
        hunting_files = list(data_dir.glob("hunting_*.csv"))

        if sweep_files:
            report = analyze_sweep(str(sweep_files[0]), args.rated_torque)
        if hunting_files and report:
            report.hunting = analyze_hunting(str(hunting_files[0]))
            report.recommendations = generate_recommendations(report)

    if report:
        print_report(report)
        save_report(report, args.output)
    else:
        print("No data files specified. Use --sweep-file, --hunting-file, or --all")