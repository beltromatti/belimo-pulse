"""
ActuatorIQ — Electronic Diagnostics Experiment
=================================================
Tests the electrical and thermal health of the actuator by analyzing
the relationship between power, torque, and temperature.

What this reveals:
  1. Motor efficiency (torque/power ratio) — degrades with winding issues
  2. Thermal time constant — how fast PCB heats under load
  3. Idle power draw — electronics baseline consumption
  4. Power per degree of rotation — energy cost of movement
  5. Thermal recovery — how fast it cools after load stops
  6. Power anomalies — spikes that indicate electronics faults

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

# InfluxDB config (same as demo repo)
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
    """Take one measurement sample and return as dict."""
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
    time.sleep(5)  # let it reach position

    for _ in range(60):  # ~30 seconds at 0.5s intervals
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
    # PHASE 2: Continuous load — rapid back-and-forth cycling
    # Run the actuator hard for 3 minutes to heat it up
    # =========================================================
    print(f"\n  PHASE 2: Continuous load — cycling 20%-80% for 3 minutes")
    print(f"  Monitoring power draw and temperature rise...\n")

    load_start = time.time()
    cycle_count = 0
    target = 80

    while time.time() - load_start < 180:  # 3 minutes
        write_setpoint(target, test_number)
        # Flip target every ~10 seconds worth of samples
        elapsed_in_cycle = (time.time() - load_start) % 10
        if elapsed_in_cycle < 0.1:
            target = 80 if target == 20 else 20
            cycle_count += 1

        s = sample(start)
        if s:
            s["phase"] = "load"
            s["cycle"] = cycle_count
            all_samples.append(s)
            print_sample(s)
        time.sleep(0.1)
    print()

    load_samples = [s for s in all_samples if s["phase"] == "load"]
    load_power = np.mean([s["power_mw"] for s in load_samples])
    load_temp_start = load_samples[0]["temperature_c"]
    load_temp_end = load_samples[-1]["temperature_c"]
    temp_rise = load_temp_end - load_temp_start
    print(f"  Under load: avg {load_power:.1f} mW, temp rose {temp_rise:.1f}°C")
    print(f"  ({load_temp_start:.1f}°C → {load_temp_end:.1f}°C)")

    # =========================================================
    # PHASE 3: Cooldown — stop and watch temperature decay
    # =========================================================
    print(f"\n  PHASE 3: Cooldown — actuator stopped, monitoring temp decay")
    print(f"  Holding at 50% for 2 minutes...\n")
    write_setpoint(50, test_number)
    time.sleep(3)  # let it reach 50%

    for _ in range(240):  # ~2 minutes
        s = sample(start)
        if s:
            s["phase"] = "cooldown"
            all_samples.append(s)
            print_sample(s)
        time.sleep(0.5)
    print()

    cool_samples = [s for s in all_samples if s["phase"] == "cooldown"]
    cool_temp_start = cool_samples[0]["temperature_c"]
    cool_temp_end = cool_samples[-1]["temperature_c"]
    temp_drop = cool_temp_start - cool_temp_end
    print(f"  Cooldown: temp dropped {temp_drop:.1f}°C")
    print(f"  ({cool_temp_start:.1f}°C → {cool_temp_end:.1f}°C)")

    # =========================================================
    # PHASE 4: Single strokes with precise power measurement
    # Move from known positions and measure energy per stroke
    # =========================================================
    print(f"\n  PHASE 4: Energy per stroke — measuring power for specific moves")

    stroke_results = []
    strokes = [(10, 90), (90, 10), (25, 75), (75, 25), (0, 100), (100, 0)]

    for from_pos, to_pos in strokes:
        print(f"\n  Stroke: {from_pos}% → {to_pos}%")
        # Move to start
        write_setpoint(from_pos, test_number)
        time.sleep(8)  # wait for arrival

        # Now move and measure
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
                print_sample(s)

                # Done when position is within 2% of target
                if abs(s["position"] - to_pos) < 2.0 and s["time_s"] > stroke_start - start + 2:
                    break
            time.sleep(0.05)

        all_samples.extend(stroke_samples)

        # Compute energy for this stroke
        if stroke_samples:
            powers = [s["power_w"] for s in stroke_samples]
            duration = stroke_samples[-1]["time_s"] - stroke_samples[0]["time_s"]
            avg_power = np.mean(powers)
            max_power = max(powers)
            # Energy = average power × time (in joules)
            energy_j = avg_power * duration if duration > 0 else 0
            stroke_size = abs(to_pos - from_pos)
            energy_per_degree = energy_j / (stroke_size * 0.95) if stroke_size > 0 else 0
            # 0.95 factor: 100% travel = 95° rotation for LM series

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
    # Compute derived electronic metrics
    # =========================================================
    print(f"\n{'='*60}")
    print(f"  ELECTRONIC HEALTH METRICS")
    print(f"{'='*60}")

    # Motor efficiency: torque output / power input during motion
    moving = [s for s in all_samples
              if s["phase"] == "load" and abs(s["torque_nmm"]) > 0.1 and s["power_w"] > 0.001]
    if moving:
        efficiencies = [abs(s["torque_nmm"]) / (s["power_w"] * 1000) for s in moving
                        if s["power_w"] > 0.001]
        avg_efficiency = np.mean(efficiencies) if efficiencies else 0
        efficiency_cv = np.std(efficiencies) / avg_efficiency if avg_efficiency > 0 else 0
    else:
        avg_efficiency = 0
        efficiency_cv = 0

    # Thermal time constant (tau): time to reach 63.2% of final temp rise
    if load_samples and temp_rise > 0.5:
        target_temp = load_temp_start + 0.632 * temp_rise
        tau_samples = [s for s in load_samples if s["temperature_c"] >= target_temp]
        if tau_samples:
            tau = tau_samples[0]["time_s"] - load_samples[0]["time_s"]
        else:
            tau = None
    else:
        tau = None

    # Thermal recovery rate: time to drop 50% of temp rise during cooldown
    if cool_samples and temp_drop > 0.2:
        half_target = cool_temp_start - temp_drop * 0.5
        half_samples = [s for s in cool_samples if s["temperature_c"] <= half_target]
        if half_samples:
            recovery_half = half_samples[0]["time_s"] - cool_samples[0]["time_s"]
        else:
            recovery_half = None
    else:
        recovery_half = None

    # Power anomaly detection: any sample where power > 3x average during motion
    motion_power = [s["power_mw"] for s in all_samples
                    if s["phase"] in ("load", "stroke") and s["power_mw"] > idle_power * 1.5]
    if motion_power:
        mean_motion_power = np.mean(motion_power)
        power_anomalies = [s for s in all_samples
                          if s["power_mw"] > mean_motion_power * 3]
    else:
        mean_motion_power = idle_power
        power_anomalies = []

    # Print results
    print(f"\n  Idle power draw:        {idle_power:.1f} mW")
    print(f"  Spec (LM24A):           200 mW at rest")
    idle_status = "OK" if idle_power < 300 else "HIGH"
    print(f"  Status:                 {idle_status}")

    print(f"\n  Avg power under load:   {load_power:.1f} mW")
    print(f"  Spec (LM24A):           1000 mW moving")

    print(f"\n  Motor efficiency:       {avg_efficiency:.4f} Nmm/mW")
    print(f"  Efficiency stability:   CV = {efficiency_cv:.2f}")
    eff_status = "STABLE" if efficiency_cv < 0.3 else "UNSTABLE"
    print(f"  Status:                 {eff_status}")

    print(f"\n  Temperature rise:       {temp_rise:.1f}°C over 3 min load")
    if tau:
        print(f"  Thermal time constant:  {tau:.0f} seconds")
    else:
        print(f"  Thermal time constant:  Could not compute (rise too small)")
    print(f"  Temp at idle:           {idle_temp:.1f}°C")
    print(f"  Temp after load:        {load_temp_end:.1f}°C")

    if recovery_half:
        print(f"\n  Thermal recovery (50%): {recovery_half:.0f} seconds")
    else:
        print(f"\n  Thermal recovery:       Insufficient cooldown data")

    print(f"\n  Power anomalies:        {len(power_anomalies)} spikes detected")

    print(f"\n  Energy per stroke:")
    for sr in stroke_results:
        print(f"    {sr['from']:3d}→{sr['to']:3d}%: "
              f"{sr['energy_mj']:6.1f} mJ in {sr['duration_s']:.1f}s "
              f"(avg {sr['avg_power_mw']:.0f} mW, peak {sr['max_power_mw']:.0f} mW)")

    # =========================================================
    # Save everything
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
            "load_avg_power_mw": round(load_power, 1),
            "temp_rise_c": round(temp_rise, 1),
            "temp_after_load_c": round(load_temp_end, 1),
            "thermal_time_constant_s": round(tau, 1) if tau else None,
            "thermal_recovery_half_s": round(recovery_half, 1) if recovery_half else None,
            "motor_efficiency_nmm_per_mw": round(avg_efficiency, 4),
            "efficiency_cv": round(efficiency_cv, 3),
            "efficiency_status": eff_status,
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