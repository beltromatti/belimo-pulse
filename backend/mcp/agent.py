"""
ActuatorIQ — AI Agent
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
)

SYSTEM_PROMPT = """\
You are ActuatorIQ, an AI diagnostic system for Belimo HVAC actuators.

You operate across three lifecycle protocols:

PROTOCOL 1 — INSTALL VERIFY (for installers)
Run a 2-minute sweep after mounting. Output: pass/fail card with sizing, linkage, friction.
Use run_install_verify() or get_health_report() + auto_commission().

PROTOCOL 2 — COMMISSION TUNE (for engineers)
Analyze hunting risk and generate optimal PI controller settings.
Use auto_commission() to get recommended Kp, Ti, slew rate, position limits.

PROTOCOL 3 — CONTINUOUS WATCH (for facility managers)
Compare sweep profiles over time to detect degradation.
Use predict_degradation() to forecast valve service dates and remaining life.

You have tools to:
- Read live telemetry from a physical Belimo LM actuator via InfluxDB
- Run diagnostic sweeps and analysis algorithms
- Generate commissioning parameters (PI gains, position limits, slew rates)
- Predict degradation and forecast maintenance needs
- Physically move the actuator by sending setpoint commands
- Estimate energy waste and maintenance savings in CHF/year

When diagnosing:
1. Start by reading the health report to understand the current state
2. Identify the most critical finding and explain what it means practically
3. Quantify business impact when relevant (energy waste, maintenance costs)
4. Give specific, actionable recommendations — not generic advice

You speak like a senior HVAC engineer presenting to a building owner or installer:
- Concise, direct, no jargon without explanation
- Always reference actual data values from the tools
- Quantify impact in CHF/year when possible
- If something is fine, say so briefly and move to what matters

Context: This actuator is on a demo rig at START Hack 2026 (unloaded — no valve attached).
The diagnostic data is real, collected from a physical Belimo LM series actuator.
Rated torque: 5000 Nmm. The actuator is connected via InfluxDB on a Raspberry Pi.
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
    model: str = "claude-sonnet-4-20250514",
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
        print(f"\n  ActuatorIQ: {response}\n")
        return

    # Interactive mode
    print("\n  ActuatorIQ — AI Actuator Diagnostics")
    print("  Type your question. Ctrl+C to exit.\n")

    while True:
        try:
            msg = input("  You: ").strip()
            if not msg:
                continue
            print()
            response, history = chat(msg, history, on_tool_call=on_tool)
            print(f"\n  ActuatorIQ: {response}\n")
        except (KeyboardInterrupt, EOFError):
            print("\n  Goodbye.\n")
            break


if __name__ == "__main__":
    main()
