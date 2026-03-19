"""
ActuatorIQ — Electronic Diagnostics Experiment
=================================================
Tests the electrical health of the actuator by mapping power consumption
across the full stroke and checking consistency.

What this reveals:
  1. Idle power draw — electronics baseline vs 200mW spec
  2. Power-by-position map — electrical fingerprint of the actuator
  3. Directional power asymmetry — opening vs closing power differences
  4. Power-torque divergence — positions where electrical losses dominate
  5. Stroke-to-stroke consistency — repeatability of power draw
  6. Energy per stroke — cost of specific moves
  7. Power anomalies — spikes that indicate electronics faults

Usage:
  python experiment_electronics.py --test-number 500
"""

import argparse
import time
import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime, timezone
from pathlib import Path
from influxdb_client import InfluxDBClient
from influxdb_client.client.write_api import SYNCHRONOUS, WritePrecision

URL = "http://192.168.3.14:8086"
TOKEN = "pf-OGC6AQFmKy64gOzRM12DZrCuavnWeMgRZ2kDMOk8LYK22evDJnoyKGcmY49EgT8HnMDE9GPQeg30vXeHsRQ=="
ORG = "belimo"
BUCKET = "actuator-data"
EPOCH = datetime.fromtimestamp(0, tz=timezone.utc)

OUTPUT_DIR = Path("./experiment_data")
OUTPUT_DIR.mkdir(exist_ok=True)

client = InfluxDBClient(url=URL, token=TOKEN, org=ORG, verify_ssl=False)
read_api = client.query_api()
write_api = client.write_api(write_options=SYNCHRONOUS)


def write_setpoint(position: float, test_number: int):
    position = float(np.clip(position, 0, 100))
    df = pd.DataFrame([{
        "timestamp": EPOCH,
        "setpoint_position_%": position,
        "test_number": int(test_number),
    }]).set_index("timestamp")
    write_api.write(
        bucket=BUCKET, record=df, write_precision=WritePrecision.MS,
        data_frame_measurement_name="_process", data_frame_tag_columns=[],
    )


def read_latest():
    query = f'''
        from(bucket:"{BUCKET}")
        |> range(start: 0)
        |> filter(fn: (r) => r["_measurement"] == "measurements")
        |> group(columns: ["_field"])
        |> last()
        |> drop(columns: ["_start", "_stop"])
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
    '''
    df = read_api.query_data_frame(query)
    if df.empty:
        return None
    return df.iloc[-1]


def sample(start_time):
    row = read_latest()
    if row is None:
        return None
    return {
        "time_s": round(time.time() - start_time, 3),
        "position": row.get("feedback_position_%", 0),
        "setpoint": row.get("setpoint_position_%", 0),
        "torque_nmm": row.get("motor_torque_Nmm", 0),
        "power_w": row.get("power_W", 0),
        "power_mw": row.get("power_W", 0) * 1000,
        "temperature_c": row.get("internal_temperature_deg_C", 0),
        "direction": row.get("rotation_direction", 0),
    }


def print_sample(s):
    sys.stdout.write(
        f"\r  t={s['time_s']:6.1f}s  pos={s['position']:5.1f}%  "
        f"power={s['power_mw']:6.1f}mW  torque={s['torque_nmm']:5.1f}Nmm  "
        f"temp={s['temperature_c']:5.1f}°C"
    )
    sys.stdout.flush()


def wait_and_sample(target, test_number, start, all_samples, phase, hold_s=2.0, extra_tags=None):
    """Wait for actuator to reach target, then hold and collect samples."""
    timeout = 30
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = sample(start)
        if s:
            s["phase"] = phase
            if extra_tags:
                s.update(extra_tags)
            all_samples.append(s)
            print_sample(s)
            if abs(s["position"] - target) < 2.0:
                break
        time.sleep(0.1)

    hold_samples = []
    t_hold = time.time()
    while time.time() - t_hold < hold_s:
        s = sample(start)
        if s:
            s["phase"] = phase
            if extra_tags:
                s.update(extra_tags)
            all_samples.append(s)
            hold_samples.append(s)
            print_sample(s)
        time.sleep(0.2)

    return hold_samples


def run_electronic_diagnostics(test_number: int):
    print(f"\n{'='*60}")
    print(f"  Electronic Diagnostics (test #{test_number})")
    print(f"{'='*60}")

    all_samples = []
    start = time.time()

    # =========================================================
    # PHASE 1: Idle baseline (30 seconds, actuator stationary)
    # =========================================================
    print(f"\n  PHASE 1: Idle baseline — measuring resting power + temperature")
    print(f"  Holding at 50% for 30 seconds...\n")
    write_setpoint(50, test_number)
    time.sleep(5)

    for _ in range(60):
        s = sample(start)
        if s:
            s["phase"] = "idle"
            all_samples.append(s)
            print_sample(s)
        time.sleep(0.5)
    print()

    idle_samples = [s for s in all_samples if s["phase"] == "idle"]
    idle_power = np.mean([s["power_mw"] for s in idle_samples])
    idle_temp = np.mean([s["temperature_c"] for s in idle_samples])
    print(f"  Idle baseline: {idle_power:.1f} mW, {idle_temp:.1f}°C")

    # =========================================================
    # PHASE 2: Power Map — sweep 0→100→0 measuring power at
    # each position. Builds a power-by-position profile.
    # =========================================================
    print(f"\n  PHASE 2: Power Map — sweep with power measurement at each step")
    print(f"  50 steps per direction, 2s hold per step...\n")

    step_count = 25
    positions = np.linspace(0, 100, step_count + 1)
    opening_bins = {}
    closing_bins = {}

    write_setpoint(0, test_number)
    time.sleep(8)

    print(f"  Opening sweep: 0% → 100%")
    for pos in positions:
        write_setpoint(float(pos), test_number)
        hold = wait_and_sample(
            float(pos), test_number, start, all_samples,
            phase="power_map",
            hold_s=2.0,
            extra_tags={"sweep_direction": "opening", "target_pos": float(pos)},
        )
        if hold:
            bin_key = int(round(pos / 5) * 5)
            opening_bins.setdefault(bin_key, []).extend(hold)
    print()

    print(f"  Closing sweep: 100% → 0%")
    for pos in reversed(positions):
        write_setpoint(float(pos), test_number)
        hold = wait_and_sample(
            float(pos), test_number, start, all_samples,
            phase="power_map",
            hold_s=2.0,
            extra_tags={"sweep_direction": "closing", "target_pos": float(pos)},
        )
        if hold:
            bin_key = int(round(pos / 5) * 5)
            closing_bins.setdefault(bin_key, []).extend(hold)
    print()

    power_map = []
    all_bin_keys = sorted(set(list(opening_bins.keys()) + list(closing_bins.keys())))
    for bk in all_bin_keys:
        entry = {"position": bk}
        if bk in opening_bins:
            entry["opening_power_mw"] = round(np.mean([s["power_mw"] for s in opening_bins[bk]]), 1)
            entry["opening_torque_nmm"] = round(np.mean([abs(s["torque_nmm"]) for s in opening_bins[bk]]), 3)
        if bk in closing_bins:
            entry["closing_power_mw"] = round(np.mean([s["power_mw"] for s in closing_bins[bk]]), 1)
            entry["closing_torque_nmm"] = round(np.mean([abs(s["torque_nmm"]) for s in closing_bins[bk]]), 3)
        power_map.append(entry)

    opening_powers = [e["opening_power_mw"] for e in power_map if "opening_power_mw" in e]
    closing_powers = [e["closing_power_mw"] for e in power_map if "closing_power_mw" in e]
    if opening_powers and closing_powers:
        avg_opening = np.mean(opening_powers)
        avg_closing = np.mean(closing_powers)
        denom = max(avg_opening, avg_closing, 0.01)
        directional_asymmetry = round(abs(avg_opening - avg_closing) / denom * 100, 1)
    else:
        directional_asymmetry = 0.0

    divergence_entries = []
    for entry in power_map:
        op = entry.get("opening_power_mw", 0)
        ot = entry.get("opening_torque_nmm", 0)
        cp = entry.get("closing_power_mw", 0)
        ct = entry.get("closing_torque_nmm", 0)
        avg_p = (op + cp) / 2 if op and cp else max(op, cp)
        avg_t = (ot + ct) / 2 if ot and ct else max(ot, ct)
        if avg_t > 0.05 and avg_p > 0:
            ratio = avg_p / (avg_t * 1000)
            divergence_entries.append({"position": entry["position"], "power_torque_ratio": round(ratio, 3)})

    if divergence_entries:
        mean_ratio = np.mean([d["power_torque_ratio"] for d in divergence_entries])
        for d in divergence_entries:
            d["divergence"] = round(d["power_torque_ratio"] / mean_ratio, 2) if mean_ratio > 0 else 1.0
    else:
        mean_ratio = 0

    print(f"  Power map: {len(power_map)} bins collected")
    print(f"  Directional asymmetry: {directional_asymmetry:.1f}%")

    # =========================================================
    # PHASE 3: Stroke Consistency — 5 identical 20→80 strokes
    # =========================================================
    print(f"\n  PHASE 3: Stroke Consistency — 5 identical 20%→80% strokes\n")

    consistency_energies = []
    consistency_powers = []

    for rep in range(5):
        write_setpoint(20, test_number)
        time.sleep(6)

        stroke_start = time.time()
        stroke_samples = []
        write_setpoint(80, test_number)

        while time.time() - stroke_start < 20:
            s = sample(start)
            if s:
                s["phase"] = "consistency"
                s["repetition"] = rep
                stroke_samples.append(s)
                all_samples.append(s)
                print_sample(s)
                if abs(s["position"] - 80) < 2.0 and time.time() - stroke_start > 2:
                    break
            time.sleep(0.05)

        if stroke_samples:
            powers = [s["power_w"] for s in stroke_samples]
            duration = stroke_samples[-1]["time_s"] - stroke_samples[0]["time_s"]
            energy = np.mean(powers) * duration if duration > 0 else 0
            consistency_energies.append(energy * 1000)
            consistency_powers.append(np.mean([s["power_mw"] for s in stroke_samples]))
    print()

    if consistency_energies and np.mean(consistency_energies) > 0:
        stroke_cv = round(np.std(consistency_energies) / np.mean(consistency_energies), 3)
    else:
        stroke_cv = 0.0

    print(f"  Stroke energies (mJ): {[round(e, 1) for e in consistency_energies]}")
    print(f"  Consistency CV: {stroke_cv}")

    # =========================================================
    # PHASE 4: Energy per stroke — specific moves
    # =========================================================
    print(f"\n  PHASE 4: Energy per stroke — measuring power for specific moves")

    stroke_results = []
    strokes = [(10, 90), (90, 10), (25, 75), (75, 25), (0, 100), (100, 0)]

    for from_pos, to_pos in strokes:
        print(f"\n  Stroke: {from_pos}% → {to_pos}%")
        write_setpoint(from_pos, test_number)
        time.sleep(8)

        stroke_start = time.time()
        stroke_samples = []
        write_setpoint(to_pos, test_number)

        while time.time() - stroke_start < 20:
            s = sample(start)
            if s:
                s["phase"] = "stroke"
                s["stroke_from"] = from_pos
                s["stroke_to"] = to_pos
                stroke_samples.append(s)
                all_samples.append(s)
                print_sample(s)
                if abs(s["position"] - to_pos) < 2.0 and time.time() - stroke_start > 2:
                    break
            time.sleep(0.05)

        if stroke_samples:
            powers = [s["power_w"] for s in stroke_samples]
            duration = stroke_samples[-1]["time_s"] - stroke_samples[0]["time_s"]
            avg_power = np.mean(powers)
            max_power = max(powers)
            energy_j = avg_power * duration if duration > 0 else 0
            stroke_size = abs(to_pos - from_pos)
            energy_per_degree = energy_j / (stroke_size * 0.95) if stroke_size > 0 else 0

            stroke_results.append({
                "from": from_pos, "to": to_pos,
                "stroke_pct": stroke_size,
                "duration_s": round(duration, 2),
                "avg_power_mw": round(avg_power * 1000, 1),
                "max_power_mw": round(max_power * 1000, 1),
                "energy_mj": round(energy_j * 1000, 1),
                "energy_per_degree_mj": round(energy_per_degree * 1000, 2),
            })
    print()

    # =========================================================
    # Compute summary metrics
    # =========================================================
    print(f"\n{'='*60}")
    print(f"  ELECTRONIC HEALTH METRICS")
    print(f"{'='*60}")

    idle_status = "OK" if idle_power < 300 else "HIGH"
    print(f"\n  Idle power draw:        {idle_power:.1f} mW")
    print(f"  Spec (LM24A):           200 mW at rest")
    print(f"  Status:                 {idle_status}")

    print(f"\n  Power map bins:         {len(power_map)}")
    print(f"  Directional asymmetry:  {directional_asymmetry:.1f}%")
    asym_status = "SYMMETRIC" if directional_asymmetry < 15 else "ASYMMETRIC"
    print(f"  Status:                 {asym_status}")

    if divergence_entries:
        max_div = max(divergence_entries, key=lambda d: abs(d["divergence"] - 1.0))
        print(f"\n  Power-torque divergence:")
        print(f"  Mean ratio:             {mean_ratio:.3f} mW/Nmm")
        print(f"  Max divergence:         {max_div['divergence']:.2f}x at {max_div['position']}%")

    print(f"\n  Stroke consistency:     CV = {stroke_cv}")
    consist_status = "CONSISTENT" if stroke_cv < 0.1 else "INCONSISTENT"
    print(f"  Status:                 {consist_status}")

    motion_samples = [s for s in all_samples if s["phase"] in ("power_map", "consistency", "stroke")]
    motion_power_vals = [s["power_mw"] for s in motion_samples if s["power_mw"] > idle_power * 1.5]
    if motion_power_vals:
        mean_motion_power = np.mean(motion_power_vals)
        power_anomalies = [s for s in all_samples if s["power_mw"] > mean_motion_power * 3]
    else:
        mean_motion_power = idle_power
        power_anomalies = []
    print(f"\n  Power anomalies:        {len(power_anomalies)} spikes detected")

    print(f"\n  Energy per stroke:")
    for sr in stroke_results:
        print(f"    {sr['from']:3d}→{sr['to']:3d}%: "
              f"{sr['energy_mj']:6.1f} mJ in {sr['duration_s']:.1f}s "
              f"(avg {sr['avg_power_mw']:.0f} mW, peak {sr['max_power_mw']:.0f} mW)")

    # =========================================================
    # Save
    # =========================================================
    df = pd.DataFrame(all_samples)
    csv_path = OUTPUT_DIR / f"electronics_test{test_number}.csv"
    df.to_csv(csv_path, index=False)

    report = {
        "experiment": "electronic_diagnostics",
        "test_number": test_number,
        "timestamp": datetime.now().isoformat(),
        "n_samples": len(all_samples),
        "metrics": {
            "idle_power_mw": round(idle_power, 1),
            "idle_power_status": idle_status,
            "idle_temp_c": round(idle_temp, 1),
            "power_map": power_map,
            "directional_asymmetry_pct": directional_asymmetry,
            "directional_asymmetry_status": asym_status,
            "power_torque_divergence": divergence_entries,
            "stroke_consistency_cv": stroke_cv,
            "stroke_consistency_status": consist_status,
            "power_anomaly_count": len(power_anomalies),
            "stroke_energy": stroke_results,
        },
    }

    report_path = OUTPUT_DIR / f"electronics_test{test_number}_report.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\n  Saved {len(all_samples)} samples → {csv_path}")
    print(f"  Report → {report_path}")
    print(f"{'='*60}\n")

    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Electronic Diagnostics")
    parser.add_argument("--test-number", type=int, default=500)
    args = parser.parse_args()

    try:
        run_electronic_diagnostics(args.test_number)
    except KeyboardInterrupt:
        print("\n\n  Interrupted — returning to safe position...")
        write_setpoint(50, args.test_number)
