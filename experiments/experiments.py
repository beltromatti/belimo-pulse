"""
ActuatorIQ — Experiment Runner
===============================
Runs diagnostic experiments on the physical Belimo actuator via InfluxDB.
Uses the same API pattern as the demo code from the hackathon repo.

Experiments:
  1. Full diagnostic sweep (0 → 100 → 0)
  2. Step response (discrete jumps)
  3. Hunting simulation (oscillating setpoints)
  4. Repeated sweeps (baseline + fault comparison)

Usage:
  python experiments.py --experiment sweep --test-number 100
  python experiments.py --experiment steps --test-number 200
  python experiments.py --experiment hunting --test-number 300
  python experiments.py --experiment all --test-number 100
"""

import argparse
import time
import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# InfluxDB connection (same credentials as demo/interface/influx/api.py)
# ---------------------------------------------------------------------------
from influxdb_client import InfluxDBClient, Point
from influxdb_client.client.write_api import SYNCHRONOUS, WritePrecision

URL = "http://192.168.3.14:8086"
TOKEN = "pf-OGC6AQFmKy64gOzRM12DZrCuavnWeMgRZ2kDMOk8LYK22evDJnoyKGcmY49EgT8HnMDE9GPQeg30vXeHsRQ=="
ORG = "belimo"
BUCKET = "actuator-data"
EPOCH = datetime.fromtimestamp(0, tz=timezone.utc)

# Actuator specs (Belimo LM series)
RATED_TORQUE_NMM = 5000  # 5 Nm = 5000 Nmm for LM series
# If using CQ series, change to 1000 (1 Nm)

OUTPUT_DIR = Path("./experiment_data")
OUTPUT_DIR.mkdir(exist_ok=True)


def init_influx():
    client = InfluxDBClient(url=URL, token=TOKEN, org=ORG, verify_ssl=False)
    return client.query_api(), client.write_api(write_options=SYNCHRONOUS)


read_api, write_api = init_influx()


def write_setpoint(position: float, test_number: int):
    """Write a setpoint command to InfluxDB _process measurement."""
    position = float(np.clip(position, 0, 100))
    df = pd.DataFrame([{
        "timestamp": EPOCH,
        "setpoint_position_%": position,
        "test_number": int(test_number),
    }]).set_index("timestamp")
    write_api.write(
        bucket=BUCKET,
        record=df,
        write_precision=WritePrecision.MS,
        data_frame_measurement_name="_process",
        data_frame_tag_columns=[],
    )


def read_latest(n: int = 1) -> pd.DataFrame:
    """Read latest N telemetry points from measurements."""
    if n > 1:
        query = f'''
            from(bucket:"{BUCKET}")
            |> range(start: 0)
            |> filter(fn: (r) => r["_measurement"] == "measurements")
            |> group(columns: ["_field"])
            |> sort(columns: ["_time"], desc: true)
            |> limit(n:{n})
            |> drop(columns: ["_start", "_stop"])
            |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        '''
    else:
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
        return df
    df = df.set_index("_time").drop(columns=["result", "table"], errors="ignore")
    df.index.name = "timestamp"
    return df.sort_index()


def wait_for_position(target: float, tolerance: float = 2.0,
                      timeout: float = 30.0, test_number: int = -1) -> list:
    """
    Wait until actuator reaches target position (within tolerance).
    Collects all telemetry during the move. Returns list of dicts.
    """
    samples = []
    start = time.time()
    while time.time() - start < timeout:
        write_setpoint(target, test_number)  # keep refreshing command
        df = read_latest(1)
        if df.empty:
            time.sleep(0.1)
            continue

        row = df.iloc[-1]
        sample = {
            "time_s": time.time() - start,
            "setpoint": row.get("setpoint_position_%", target),
            "position": row.get("feedback_position_%", 0),
            "torque_nmm": row.get("motor_torque_Nmm", 0),
            "power_w": row.get("power_W", 0),
            "temperature_c": row.get("internal_temperature_deg_C", 0),
            "direction": row.get("rotation_direction", 0),
        }
        samples.append(sample)

        pos = sample["position"]
        sys.stdout.write(
            f"\r  setpoint={target:6.1f}%  position={pos:6.1f}%  "
            f"torque={sample['torque_nmm']:7.1f} Nmm  "
            f"temp={sample['temperature_c']:5.1f}°C"
        )
        sys.stdout.flush()

        if abs(pos - target) <= tolerance:
            sys.stdout.write("  ✓ reached\n")
            break
        time.sleep(0.05)  # sample as fast as practical
    else:
        sys.stdout.write("  ⏱ timeout\n")

    return samples


def collect_continuous(duration_s: float, test_number: int = -1,
                       setpoint_fn=None) -> list:
    """
    Collect telemetry for a fixed duration.
    If setpoint_fn is provided, call it each cycle to get the setpoint.
    """
    samples = []
    start = time.time()
    while time.time() - start < duration_s:
        t = time.time() - start
        if setpoint_fn:
            sp = setpoint_fn(t)
            write_setpoint(sp, test_number)
        df = read_latest(1)
        if df.empty:
            time.sleep(0.05)
            continue
        row = df.iloc[-1]
        samples.append({
            "time_s": t,
            "setpoint": row.get("setpoint_position_%", 0),
            "position": row.get("feedback_position_%", 0),
            "torque_nmm": row.get("motor_torque_Nmm", 0),
            "power_w": row.get("power_W", 0),
            "temperature_c": row.get("internal_temperature_deg_C", 0),
            "direction": row.get("rotation_direction", 0),
        })
        sys.stdout.write(
            f"\r  t={t:5.1f}s  pos={samples[-1]['position']:6.1f}%  "
            f"torque={samples[-1]['torque_nmm']:7.1f} Nmm"
        )
        sys.stdout.flush()
        time.sleep(0.05)
    print()
    return samples


def save_experiment(name: str, test_number: int, samples: list, metadata: dict = None):
    """Save experiment data as CSV + JSON metadata."""
    df = pd.DataFrame(samples)
    csv_path = OUTPUT_DIR / f"{name}_test{test_number}.csv"
    df.to_csv(csv_path, index=False)

    meta = {
        "experiment": name,
        "test_number": test_number,
        "timestamp": datetime.now().isoformat(),
        "n_samples": len(samples),
        "rated_torque_nmm": RATED_TORQUE_NMM,
    }
    if metadata:
        meta.update(metadata)
    meta_path = OUTPUT_DIR / f"{name}_test{test_number}_meta.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"  💾 Saved {len(samples)} samples → {csv_path}")
    return csv_path


# ===================================================================
#  EXPERIMENT 1: Full Diagnostic Sweep (0 → 100 → 0)
# ===================================================================
def experiment_sweep(test_number: int, n_repeats: int = 3):
    """
    The fingerprint sweep. Moves actuator through full range and back.
    This is the single most diagnostic test you can run.
    """
    print(f"\n{'='*60}")
    print(f"  EXPERIMENT 1: Diagnostic Sweep (test #{test_number})")
    print(f"  Moving 0 → 100 → 0  ({n_repeats} repeats)")
    print(f"{'='*60}\n")

    all_samples = []

    for rep in range(n_repeats):
        print(f"  --- Repeat {rep+1}/{n_repeats} ---")

        # Go to start position first
        print("  Moving to 0% (start position)...")
        wait_for_position(0, tolerance=1.0, timeout=45, test_number=test_number)
        time.sleep(2)  # let it settle

        # Sweep up: 0 → 100 in fine steps
        print("  Sweeping 0% → 100% (opening)...")
        up_samples = []
        for target in np.linspace(0, 100, 50):  # 50 steps = 2% resolution
            write_setpoint(target, test_number)
            time.sleep(0.3)  # give actuator time to move between steps
            df = read_latest(1)
            if not df.empty:
                row = df.iloc[-1]
                up_samples.append({
                    "time_s": time.time(),
                    "repeat": rep,
                    "direction": "opening",
                    "setpoint": target,
                    "position": row.get("feedback_position_%", 0),
                    "torque_nmm": row.get("motor_torque_Nmm", 0),
                    "power_w": row.get("power_W", 0),
                    "temperature_c": row.get("internal_temperature_deg_C", 0),
                })
                sys.stdout.write(
                    f"\r  ↑ {target:5.1f}% → pos={up_samples[-1]['position']:5.1f}%  "
                    f"torque={up_samples[-1]['torque_nmm']:7.1f} Nmm"
                )
                sys.stdout.flush()
        print()

        # Wait at 100% for a moment
        wait_for_position(100, tolerance=1.0, timeout=30, test_number=test_number)
        time.sleep(2)

        # Sweep down: 100 → 0 in fine steps
        print("  Sweeping 100% → 0% (closing)...")
        down_samples = []
        for target in np.linspace(100, 0, 50):
            write_setpoint(target, test_number)
            time.sleep(0.3)
            df = read_latest(1)
            if not df.empty:
                row = df.iloc[-1]
                down_samples.append({
                    "time_s": time.time(),
                    "repeat": rep,
                    "direction": "closing",
                    "setpoint": target,
                    "position": row.get("feedback_position_%", 0),
                    "torque_nmm": row.get("motor_torque_Nmm", 0),
                    "power_w": row.get("power_W", 0),
                    "temperature_c": row.get("internal_temperature_deg_C", 0),
                })
                sys.stdout.write(
                    f"\r  ↓ {target:5.1f}% → pos={down_samples[-1]['position']:5.1f}%  "
                    f"torque={down_samples[-1]['torque_nmm']:7.1f} Nmm"
                )
                sys.stdout.flush()
        print()

        all_samples.extend(up_samples)
        all_samples.extend(down_samples)

    return save_experiment("sweep", test_number, all_samples, {
        "n_repeats": n_repeats,
        "steps_per_direction": 50,
        "step_delay_s": 0.3,
    })


# ===================================================================
#  EXPERIMENT 2: Step Response
# ===================================================================
def experiment_steps(test_number: int):
    """
    Discrete position jumps to measure response dynamics.
    Reveals nonlinear valve characteristics and transit times.
    """
    print(f"\n{'='*60}")
    print(f"  EXPERIMENT 2: Step Response (test #{test_number})")
    print(f"{'='*60}\n")

    steps = [
        (0, 25),
        (25, 50),
        (50, 75),
        (75, 100),
        (100, 75),
        (75, 50),
        (50, 25),
        (25, 0),
        # Large jumps
        (0, 50),
        (50, 100),
        (100, 50),
        (50, 0),
        # Full range
        (0, 100),
        (100, 0),
    ]

    all_samples = []

    # Start at 0
    print("  Moving to start position (0%)...")
    wait_for_position(0, tolerance=1.0, timeout=45, test_number=test_number)
    time.sleep(2)

    for i, (from_pos, to_pos) in enumerate(steps):
        print(f"\n  Step {i+1}/{len(steps)}: {from_pos}% → {to_pos}%")

        # Ensure we're at from_pos
        wait_for_position(from_pos, tolerance=1.5, timeout=30, test_number=test_number)
        time.sleep(1)  # settle

        # Now jump to to_pos and record everything
        step_start = time.time()
        step_samples = []
        write_setpoint(to_pos, test_number)

        # Collect for enough time to see full response
        collect_time = 15.0  # seconds
        while time.time() - step_start < collect_time:
            write_setpoint(to_pos, test_number)
            df = read_latest(1)
            if not df.empty:
                row = df.iloc[-1]
                step_samples.append({
                    "time_s": time.time() - step_start,
                    "step_from": from_pos,
                    "step_to": to_pos,
                    "step_size": abs(to_pos - from_pos),
                    "setpoint": to_pos,
                    "position": row.get("feedback_position_%", 0),
                    "torque_nmm": row.get("motor_torque_Nmm", 0),
                    "power_w": row.get("power_W", 0),
                    "temperature_c": row.get("internal_temperature_deg_C", 0),
                    "direction": row.get("rotation_direction", 0),
                })
                pos = step_samples[-1]["position"]
                sys.stdout.write(
                    f"\r  t={step_samples[-1]['time_s']:5.1f}s  "
                    f"pos={pos:6.1f}%  torque={step_samples[-1]['torque_nmm']:7.1f}"
                )
                sys.stdout.flush()

                # Stop early if settled
                if (step_samples[-1]["time_s"] > 5.0 and
                        abs(pos - to_pos) < 1.5):
                    break
            time.sleep(0.05)
        print()
        all_samples.extend(step_samples)

    return save_experiment("steps", test_number, all_samples, {
        "steps": steps,
    })


# ===================================================================
#  EXPERIMENT 3: Hunting Simulation
# ===================================================================
def experiment_hunting(test_number: int):
    """
    Send oscillating setpoints at different frequencies to measure
    the actuator's ability to track. Reveals control loop stability.
    """
    print(f"\n{'='*60}")
    print(f"  EXPERIMENT 3: Hunting Simulation (test #{test_number})")
    print(f"{'='*60}\n")

    # Move to center position first
    print("  Moving to center position (50%)...")
    wait_for_position(50, tolerance=1.5, timeout=30, test_number=test_number)
    time.sleep(2)

    all_samples = []

    # Test different frequencies and amplitudes
    configs = [
        # (frequency_hz, amplitude_pct, duration_s, description)
        (0.02, 20, 60, "slow large oscillation"),
        (0.05, 15, 45, "medium oscillation"),
        (0.1,  10, 30, "fast small oscillation"),
        (0.2,   5, 30, "rapid fine oscillation"),
        (0.02,  5, 45, "slow small — tests deadband"),
        (0.05, 30, 45, "medium large — stress test"),
    ]

    for freq, amp, duration, desc in configs:
        print(f"\n  Config: f={freq}Hz, amp=±{amp}%, {duration}s — {desc}")

        def setpoint_fn(t, f=freq, a=amp):
            return 50.0 + a * np.sin(2 * np.pi * f * t)

        samples = collect_continuous(
            duration_s=duration,
            test_number=test_number,
            setpoint_fn=setpoint_fn,
        )

        # Tag each sample with the config
        for s in samples:
            s["frequency_hz"] = freq
            s["amplitude_pct"] = amp
            s["description"] = desc

        all_samples.extend(samples)

        # Brief pause between configs
        print("  Returning to 50%...")
        wait_for_position(50, tolerance=1.5, timeout=20, test_number=test_number)
        time.sleep(2)

    return save_experiment("hunting", test_number, all_samples, {
        "configs": [{"freq": f, "amp": a, "dur": d, "desc": desc}
                    for f, a, d, desc in configs],
    })


# ===================================================================
#  EXPERIMENT 4: Temperature Under Load
# ===================================================================
def experiment_thermal(test_number: int, duration_min: float = 5):
    """
    Continuous cycling to observe temperature rise under sustained load.
    Establishes thermal baseline for health monitoring.
    """
    print(f"\n{'='*60}")
    print(f"  EXPERIMENT 4: Thermal Profile ({duration_min} min)")
    print(f"{'='*60}\n")

    duration_s = duration_min * 60

    # Triangle wave: continuous back and forth
    def triangle_setpoint(t):
        period = 30.0  # 30 second full cycle
        phase = (t % period) / period
        if phase < 0.5:
            return phase * 2 * 100  # 0 → 100
        else:
            return (1 - phase) * 2 * 100  # 100 → 0

    samples = collect_continuous(
        duration_s=duration_s,
        test_number=test_number,
        setpoint_fn=triangle_setpoint,
    )

    return save_experiment("thermal", test_number, samples, {
        "duration_min": duration_min,
        "pattern": "triangle_continuous",
        "cycle_period_s": 30,
    })


# ===================================================================
#  Run all experiments
# ===================================================================
def run_all(base_test_number: int):
    """Run complete diagnostic suite."""
    print("\n" + "=" * 60)
    print("  ActuatorIQ — Full Diagnostic Suite")
    print("=" * 60)

    files = []

    # Sweep (most important — do this first)
    files.append(experiment_sweep(base_test_number, n_repeats=3))

    # Step response
    files.append(experiment_steps(base_test_number + 100))

    # Hunting
    files.append(experiment_hunting(base_test_number + 200))

    # Thermal (shorter for hackathon)
    files.append(experiment_thermal(base_test_number + 300, duration_min=3))

    # Return to safe position
    print("\n  Returning actuator to 50% (safe position)...")
    wait_for_position(50, tolerance=2.0, timeout=30,
                      test_number=base_test_number)

    print(f"\n{'='*60}")
    print(f"  All experiments complete!")
    print(f"  Data saved in: {OUTPUT_DIR}/")
    for f in files:
        print(f"    → {f}")
    print(f"{'='*60}\n")

    return files


# ===================================================================
#  Main
# ===================================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ActuatorIQ Experiment Runner")
    parser.add_argument(
        "--experiment", type=str, default="all",
        choices=["sweep", "steps", "hunting", "thermal", "all"],
        help="Which experiment to run",
    )
    parser.add_argument(
        "--test-number", type=int, default=100,
        help="Base test number for labeling data in InfluxDB",
    )
    parser.add_argument(
        "--repeats", type=int, default=3,
        help="Number of sweep repeats (for sweep experiment)",
    )
    parser.add_argument(
        "--thermal-minutes", type=float, default=3,
        help="Duration of thermal test in minutes",
    )
    args = parser.parse_args()

    try:
        if args.experiment == "sweep":
            experiment_sweep(args.test_number, args.repeats)
        elif args.experiment == "steps":
            experiment_steps(args.test_number)
        elif args.experiment == "hunting":
            experiment_hunting(args.test_number)
        elif args.experiment == "thermal":
            experiment_thermal(args.test_number, args.thermal_minutes)
        elif args.experiment == "all":
            run_all(args.test_number)
    except KeyboardInterrupt:
        print("\n\n  ⚠ Interrupted! Returning to safe position...")
        write_setpoint(50, args.test_number)
        print("  Done.")