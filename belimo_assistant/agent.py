"""
Belimo Pulse AI — AI Agent
======================
Chat interface that uses Claude API with MCP tools to diagnose actuators.
Can be used standalone (CLI) or imported by the Streamlit dashboard.

Usage:
  export ANTHROPIC_API_KEY=sk-ant-...
  python agent.py "Check this actuator's health"
  python agent.py  # interactive mode
"""

import json
import sys
import os
from anthropic import Anthropic

from mcp_server import (
    read_telemetry,
    get_health_report,
    get_electronics_report,
    list_experiments,
    get_experiment_data,
    analyze_sweep,
    analyze_hunting,
    move_actuator,
    run_quick_sweep,
    estimate_energy_waste,
    estimate_maintenance_savings,
    compare_profiles,
    auto_commission,
    predict_degradation,
    run_install_verify,
    run_fresh_diagnosis,
    run_targeted_sweep,
    run_frequency_probe,
    run_step_test,
    read_telemetry_stream,
    detect_anomalies,
    get_torque_at_position,
    start_watchdog,
    get_baseline_fingerprint,
    generate_actuator_passport,
)

SYSTEM_PROMPT = """\
You are Belimo Pulse AI, a diagnostic system for Belimo HVAC actuators connected to real hardware.

## CRITICAL RULES — NO HALLUCINATION
- ONLY state facts that come directly from tool results. Never invent numbers.
- Clearly separate MEASURED values (from experiments) from DERIVED values (computed from measurements).
- If you don't have data for something, say "not measured" — never guess.
- Every number you cite must trace back to a specific tool call in this conversation.

## WHAT YOU MEASURE vs WHAT YOU DERIVE
MEASURED (from physical actuator via experiments):
- Torque at each position (Nmm) — from sweep
- Position tracking error (%) — from hunting test
- Overshoot (%) — from hunting test
- Resonance frequency (Hz) — from FFT on hunting data
- Transit time (seconds) — from step response
- Power draw (mW) — from electronics test
- Temperature (°C) — from telemetry
- Friction smoothness score — from torque variance across position bins
- Dead band (%) — from linkage analysis

DERIVED (computed from measurements, clearly label as estimates):
- Position limits — derived from dead zone detection in friction map
- Max slew rate — derived from resonance frequency (rule: stay below 1/3 of resonance)
- Recommended PI bandwidth — derived from resonance (cannot be validated without full HVAC loop)
- Energy waste estimates — modeled from hunting score, NOT measured
- Maintenance forecasts — extrapolated from torque trending

Always say "Based on measured resonance at X Hz, the recommended maximum control bandwidth is Y Hz"
NOT "The optimal PI gains are Kp=x, Ti=y" — we cannot determine exact PI gains without a real control loop, room, and valve.

## ANOMALY INVESTIGATION PROTOCOL
When you detect something unusual in the data:
1. Flag it: "Anomaly detected: [what] at [where] — [measured value] vs [expected]"
2. Investigate: Run a targeted test to confirm. Use run_targeted_sweep() to zoom into the anomaly zone.
3. Confirm or dismiss: "Confirmed: friction spike at 45-55% — torque 2.1x baseline" or "False alarm: within normal variance"
4. Recommend: Specific action based on confirmed finding

Example chain:
- get_health_report() shows friction anomaly at 50%
- run_targeted_sweep(start=40, end=60, steps=20) to map that zone precisely
- run_step_test(from_pct=45, to_pct=55) to test dynamics in the anomaly zone
- Result: "Confirmed binding at 48-52%. Torque peaks at 3.2 Nmm (4.6x baseline). Likely valve packing issue."

## THREE LIFECYCLE PROTOCOLS

INSTALL VERIFY (2 min): run_fresh_diagnosis() or run_quick_sweep() + analyze_sweep()
→ Output: pass/fail + what the installer should fix before leaving

COMMISSION TUNE (5 min): auto_commission() + run_frequency_probe() at key frequencies
→ Output: measured operating envelope (position limits, max slew rate, resonance frequency)
→ NOT exact PI gains — those depend on the building's control loop which we cannot test

CONTINUOUS WATCH (passive): predict_degradation() + compare_profiles()
→ Output: degradation rate, forecast service date, friction trend

## CONTEXT
Physical Belimo LM actuator on a demo rig (unloaded — no valve attached).
Connected via InfluxDB on Raspberry Pi (192.168.3.14:8086).
Rated torque: 5000 Nmm. All experiment data is real, from this physical actuator.
The actuator is unloaded so torque values reflect internal motor friction only (~0.7-1.3 Nmm).
"""

TOOLS = [
    {
        "name": "read_telemetry",
        "description": "Read latest N telemetry readings from the physical actuator. Returns position, torque, power, temperature.",
        "input_schema": {
            "type": "object",
            "properties": {"n": {"type": "integer", "description": "Number of readings (default 10)", "default": 10}},
        },
    },
    {
        "name": "get_health_report",
        "description": "Get the full diagnostic report: health score, sizing, linkage, friction, step response, hunting risk, recommendations.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_electronics_report",
        "description": "Get electronic diagnostics: idle power, power map, directional asymmetry, stroke consistency.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_experiments",
        "description": "List all available experiment data files.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_experiment_data",
        "description": "Load a CSV experiment file and return first N rows as JSON.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "CSV filename"},
                "head": {"type": "integer", "description": "Rows to return (default 50)", "default": 50},
            },
            "required": ["filename"],
        },
    },
    {
        "name": "analyze_sweep",
        "description": "Run full diagnostic analysis on a sweep CSV. Returns sizing, linkage, friction, health score.",
        "input_schema": {
            "type": "object",
            "properties": {
                "csv_filename": {"type": "string", "default": "sweep_test100.csv"},
                "rated_torque": {"type": "number", "default": 5000},
            },
        },
    },
    {
        "name": "analyze_hunting",
        "description": "Run hunting risk analysis on oscillation test data.",
        "input_schema": {
            "type": "object",
            "properties": {"csv_filename": {"type": "string", "default": "hunting_test300.csv"}},
        },
    },
    {
        "name": "move_actuator",
        "description": "Move the physical actuator to a position (0-100%). Causes real movement.",
        "input_schema": {
            "type": "object",
            "properties": {
                "position": {"type": "number", "description": "Target position 0-100%"},
                "test_number": {"type": "integer", "default": 999},
            },
            "required": ["position"],
        },
    },
    {
        "name": "run_quick_sweep",
        "description": "Run a fast diagnostic sweep (~2 min). Moves the actuator through full range.",
        "input_schema": {
            "type": "object",
            "properties": {"test_number": {"type": "integer", "default": 900}},
        },
    },
    {
        "name": "estimate_energy_waste",
        "description": "Estimate annual energy waste and CHF cost from valve hunting.",
        "input_schema": {
            "type": "object",
            "properties": {
                "hunting_score": {"type": "number", "description": "Hunting risk score 0-100"},
                "building_zones": {"type": "integer", "default": 8},
                "hours_per_day": {"type": "number", "default": 12},
                "energy_rate_chf_per_kwh": {"type": "number", "default": 0.22},
            },
            "required": ["hunting_score"],
        },
    },
    {
        "name": "estimate_maintenance_savings",
        "description": "Estimate annual maintenance savings from predictive monitoring.",
        "input_schema": {
            "type": "object",
            "properties": {
                "health_score": {"type": "integer"},
                "n_actuators": {"type": "integer", "default": 50},
                "replacement_cost_chf": {"type": "number", "default": 450},
            },
            "required": ["health_score"],
        },
    },
    {
        "name": "compare_profiles",
        "description": "Compare two sweep profiles to detect degradation. Shows torque drift and health delta.",
        "input_schema": {
            "type": "object",
            "properties": {
                "baseline_test": {"type": "integer", "default": 100},
                "current_test": {"type": "integer", "default": 400},
            },
        },
    },
    {
        "name": "auto_commission",
        "description": "Generate optimal commissioning parameters: position limits, PI gains (Kp, Ti), max slew rate, dead band compensation. The AI prescribes, not just diagnoses.",
        "input_schema": {
            "type": "object",
            "properties": {
                "rated_torque": {"type": "number", "default": 5000, "description": "Rated torque Nmm (5000=LM, 1000=CQ)"},
            },
        },
    },
    {
        "name": "predict_degradation",
        "description": "Predict actuator and valve degradation by comparing two sweeps. Forecasts remaining life, valve service dates, and friction pattern changes.",
        "input_schema": {
            "type": "object",
            "properties": {
                "baseline_test": {"type": "integer", "default": 100},
                "current_test": {"type": "integer", "default": 400},
                "months_between": {"type": "number", "default": 6, "description": "Months between the two sweeps"},
                "rated_torque": {"type": "number", "default": 5000},
            },
        },
    },
    {
        "name": "run_install_verify",
        "description": "Run the complete Install Verify protocol — 2-minute automated sweep + analysis + commissioning card. Returns pass/fail for the installer.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "run_fresh_diagnosis",
        "description": "Run a COMPLETE fresh diagnosis from scratch on the LIVE actuator: physically sweep it, analyze the raw data, generate commissioning parameters — all in one call. Takes ~2-3 min. Use when user wants fresh data with NO cached results.",
        "input_schema": {
            "type": "object",
            "properties": {
                "test_number": {"type": "integer", "default": 950},
                "rated_torque": {"type": "number", "default": 5000},
            },
        },
    },
    {
        "name": "run_targeted_sweep",
        "description": "Run a sweep over a SPECIFIC position range to investigate an anomaly. Use when you detect unusual torque/friction at a position and want to zoom in. The actuator physically moves through only the specified range.",
        "input_schema": {
            "type": "object",
            "properties": {
                "start_pct": {"type": "number", "description": "Start position (0-100)"},
                "end_pct": {"type": "number", "description": "End position (0-100)"},
                "steps": {"type": "integer", "default": 20, "description": "Number of measurement steps"},
                "test_number": {"type": "integer", "default": 960},
            },
            "required": ["start_pct", "end_pct"],
        },
    },
    {
        "name": "run_frequency_probe",
        "description": "Test the actuator at a SPECIFIC frequency to measure tracking ability. Use to confirm hunting risk at a suspected resonance frequency. Oscillates the actuator around 50% at the given frequency.",
        "input_schema": {
            "type": "object",
            "properties": {
                "frequency_hz": {"type": "number", "description": "Frequency to test (e.g. 0.05)"},
                "amplitude_pct": {"type": "number", "default": 15, "description": "Oscillation amplitude in %"},
                "duration_s": {"type": "number", "default": 60, "description": "Test duration in seconds"},
                "test_number": {"type": "integer", "default": 970},
            },
            "required": ["frequency_hz"],
        },
    },
    {
        "name": "run_step_test",
        "description": "Run a single step response test between two positions. Measures transit time, overshoot, and settling time for that specific move. Use to test dynamics in a specific range.",
        "input_schema": {
            "type": "object",
            "properties": {
                "from_pct": {"type": "number", "description": "Starting position (0-100)"},
                "to_pct": {"type": "number", "description": "Target position (0-100)"},
                "hold_s": {"type": "number", "default": 10, "description": "Seconds to hold at target"},
                "test_number": {"type": "integer", "default": 980},
            },
            "required": ["from_pct", "to_pct"],
        },
    },
    {
        "name": "read_telemetry_stream",
        "description": "Read continuous telemetry for a duration. Returns all samples collected during the window. Use to observe actuator behavior during operation or after a command.",
        "input_schema": {
            "type": "object",
            "properties": {
                "duration_s": {"type": "number", "default": 10, "description": "Seconds to collect data"},
                "sample_interval": {"type": "number", "default": 0.3, "description": "Seconds between samples"},
            },
        },
    },
    {
        "name": "detect_anomalies",
        "description": "Scan the latest health report for anomalies that warrant investigation. Returns a list of findings with suggested follow-up experiments. Use this as the FIRST step before investigating.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "get_torque_at_position",
        "description": "Get torque statistics at a specific position range from the latest sweep data. Returns mean, max, std, and sample count for that zone.",
        "input_schema": {
            "type": "object",
            "properties": {
                "position_center": {"type": "number", "description": "Center position (0-100)"},
                "window_pct": {"type": "number", "default": 10, "description": "Window width in % (e.g. 10 = +/-5%)"},
            },
            "required": ["position_center"],
        },
    },
    {
        "name": "start_watchdog",
        "description": "Monitor the actuator for anomalies in real time. Compares live torque to baseline every 2 seconds. Returns IMMEDIATELY if anomaly detected (torque > 2.5x baseline). Use to watch for faults live. Follow up with run_targeted_sweep() on detection.",
        "input_schema": {
            "type": "object",
            "properties": {
                "duration_s": {"type": "number", "default": 30, "description": "Monitoring duration (max 120s)"},
                "check_interval": {"type": "number", "default": 2.0},
            },
        },
    },
    {
        "name": "get_baseline_fingerprint",
        "description": "Get the stored baseline torque-by-position profile. Used to compare against live data. Returns the friction map bins from the last analysis.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "generate_actuator_passport",
        "description": "Generate a complete Actuator Passport — structured identity card with ALL measured and derived values. Like a vehicle inspection report. Every value labeled MEASURED or DERIVED.",
        "input_schema": {"type": "object", "properties": {}},
    },
]

TOOL_FUNCTIONS = {
    "read_telemetry": read_telemetry,
    "get_health_report": get_health_report,
    "get_electronics_report": get_electronics_report,
    "list_experiments": list_experiments,
    "get_experiment_data": get_experiment_data,
    "analyze_sweep": analyze_sweep,
    "analyze_hunting": analyze_hunting,
    "move_actuator": move_actuator,
    "run_quick_sweep": run_quick_sweep,
    "estimate_energy_waste": estimate_energy_waste,
    "estimate_maintenance_savings": estimate_maintenance_savings,
    "compare_profiles": compare_profiles,
    "auto_commission": auto_commission,
    "predict_degradation": predict_degradation,
    "run_install_verify": run_install_verify,
    "run_fresh_diagnosis": run_fresh_diagnosis,
    "run_targeted_sweep": run_targeted_sweep,
    "run_frequency_probe": run_frequency_probe,
    "run_step_test": run_step_test,
    "read_telemetry_stream": read_telemetry_stream,
    "detect_anomalies": detect_anomalies,
    "get_torque_at_position": get_torque_at_position,
    "start_watchdog": start_watchdog,
    "get_baseline_fingerprint": get_baseline_fingerprint,
    "generate_actuator_passport": generate_actuator_passport,
}


def execute_tool(name: str, input_args: dict) -> str:
    fn = TOOL_FUNCTIONS.get(name)
    if not fn:
        return json.dumps({"error": f"Unknown tool: {name}"})
    try:
        return fn(**input_args)
    except Exception as e:
        return json.dumps({"error": f"{name} failed: {e}"})


def chat(
    user_message: str,
    history: list | None = None,
    on_tool_call: callable = None,
    model: str = "claude-opus-4-6",
) -> tuple[str, list]:
    """Send a message, handle tool calls, return (response_text, updated_history).

    Args:
        user_message: The user's input
        history: Conversation history (list of message dicts). Mutated in place.
        on_tool_call: Optional callback(tool_name, tool_input) for UI display
        model: Claude model to use
    Returns:
        (assistant_text, history)
    """
    client = Anthropic()

    if history is None:
        history = []

    history.append({"role": "user", "content": user_message})

    while True:
        response = client.messages.create(
            model=model,
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=history,
        )

        # Collect text and tool use blocks
        text_parts = []
        tool_calls = []
        for block in response.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                tool_calls.append(block)

        # If no tool calls, we're done
        if not tool_calls:
            final_text = "\n".join(text_parts)
            history.append({"role": "assistant", "content": response.content})
            return final_text, history

        # Process tool calls
        history.append({"role": "assistant", "content": response.content})
        tool_results = []

        for tc in tool_calls:
            if on_tool_call:
                on_tool_call(tc.name, tc.input)

            result = execute_tool(tc.name, tc.input)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tc.id,
                "content": result,
            })

        history.append({"role": "user", "content": tool_results})

        # If stop reason is end_turn, also done
        if response.stop_reason == "end_turn":
            final_text = "\n".join(text_parts)
            return final_text, history


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: Set ANTHROPIC_API_KEY environment variable")
        print("  export ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)

    history = []

    def on_tool(name, args):
        args_str = ", ".join(f"{k}={v}" for k, v in args.items()) if args else ""
        print(f"  🔧 {name}({args_str})")

    # Single message mode
    if len(sys.argv) > 1:
        msg = " ".join(sys.argv[1:])
        print(f"\n  You: {msg}\n")
        response, history = chat(msg, history, on_tool_call=on_tool)
        print(f"\n  Belimo Pulse AI: {response}\n")
        return

    # Interactive mode
    print("\n  Belimo Pulse AI — AI Actuator Diagnostics")
    print("  Type your question. Ctrl+C to exit.\n")

    while True:
        try:
            msg = input("  You: ").strip()
            if not msg:
                continue
            print()
            response, history = chat(msg, history, on_tool_call=on_tool)
            print(f"\n  Belimo Pulse AI: {response}\n")
        except (KeyboardInterrupt, EOFError):
            print("\n  Goodbye.\n")
            break


if __name__ == "__main__":
    main()
