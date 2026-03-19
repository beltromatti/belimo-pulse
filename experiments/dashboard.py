"""
ActuatorIQ — Streamlit Dashboard
==================================
Chat with the AI diagnostic agent + live actuator status sidebar.

Run:
  export ANTHROPIC_API_KEY=sk-ant-...
  streamlit run dashboard.py
"""

import json
import os

import altair as alt
import pandas as pd
import streamlit as st

from agent import chat, execute_tool

st.set_page_config(
    page_title="ActuatorIQ",
    page_icon="⚡",
    layout="wide",
    initial_sidebar_state="expanded",
)


# ===================================================================
#  Sidebar — Actuator Status
# ===================================================================
def render_sidebar():
    st.sidebar.markdown("## ⚡ Actuator Status")

    # Load health report
    try:
        report = json.loads(execute_tool("get_health_report", {}))
        if "error" not in report:
            score = report["health"]["score"]
            grade = report["health"]["grade"]

            grade_color = {"A": "green", "B": "blue", "C": "orange", "D": "red", "F": "red"}.get(grade, "gray")
            st.sidebar.markdown(f"### Health: **:{grade_color}[{score}/100 ({grade})]**")
            st.sidebar.progress(score / 100)

            st.sidebar.markdown("#### Diagnostics")
            severity_icon = {"pass": "✅", "warn": "⚠️", "fail": "❌", "info": "ℹ️"}

            checks = [
                ("Sizing", report.get("sizing", {})),
                ("Linkage", report.get("linkage", {})),
                ("Friction", report.get("friction", {})),
            ]
            for name, data in checks:
                icon = severity_icon.get(data.get("severity", ""), "❓")
                verdict = data.get("verdict", "N/A")
                st.sidebar.markdown(f"{icon} **{name}**: {verdict}")

            if "hunting" in report and report["hunting"]:
                h = report["hunting"]
                icon = severity_icon.get(h.get("severity", ""), "❓")
                st.sidebar.markdown(f"{icon} **Hunting**: {h.get('verdict', 'N/A')} ({h.get('risk_score', 0):.0f}/100)")

            if "steps" in report and report["steps"]:
                s = report["steps"]
                icon = severity_icon.get(s.get("severity", ""), "❓")
                st.sidebar.markdown(f"{icon} **Step Response**: {s.get('verdict', 'N/A')}")

            # Component breakdown
            if "components" in report.get("health", {}):
                st.sidebar.markdown("#### Score Breakdown")
                components = report["health"]["components"]
                comp_df = pd.DataFrame([
                    {"Component": k.title(), "Score": v}
                    for k, v in components.items()
                ])
                max_scores = {"Sizing": 25, "Linkage": 20, "Friction": 20, "Transit": 15, "Symmetry": 20}
                comp_df["Max"] = comp_df["Component"].map(max_scores).fillna(20)
                chart = alt.Chart(comp_df).mark_bar().encode(
                    x=alt.X("Score:Q", scale=alt.Scale(domain=[0, 25])),
                    y=alt.Y("Component:N", sort="-x"),
                    color=alt.condition(
                        alt.datum.Score > alt.datum.Max * 0.7,
                        alt.value("#22c55e"),
                        alt.value("#ef4444"),
                    ),
                ).properties(height=150)
                st.sidebar.altair_chart(chart, use_container_width=True)

        else:
            st.sidebar.warning("No health report available")
    except Exception as e:
        st.sidebar.error(f"Error loading report: {e}")

    # Live telemetry (if available)
    st.sidebar.markdown("---")
    st.sidebar.markdown("#### Live Telemetry")
    try:
        telemetry = json.loads(execute_tool("read_telemetry", {"n": 1}))
        if isinstance(telemetry, list) and telemetry:
            t = telemetry[0]
            col1, col2 = st.sidebar.columns(2)
            col1.metric("Position", f"{t.get('feedback_position_%', 0):.1f}%")
            col2.metric("Torque", f"{t.get('motor_torque_Nmm', 0):.1f} Nmm")
            col1.metric("Power", f"{t.get('power_W', 0)*1000:.0f} mW")
            col2.metric("Temp", f"{t.get('internal_temperature_deg_C', 0):.1f}°C")
        elif isinstance(telemetry, dict) and "error" in telemetry:
            st.sidebar.info("📡 Offline — using cached data")
    except Exception:
        st.sidebar.info("📡 Offline — using cached data")


# ===================================================================
#  Main — Chat Interface
# ===================================================================
def render_chat():
    st.markdown("# ⚡ ActuatorIQ")
    st.markdown("*AI-powered actuator diagnostics for Belimo HVAC systems*")
    st.markdown("---")

    if "messages" not in st.session_state:
        st.session_state.messages = []
    if "history" not in st.session_state:
        st.session_state.history = []

    # Render chat history
    for msg in st.session_state.messages:
        with st.chat_message(msg["role"], avatar="🔧" if msg["role"] == "assistant" else "👤"):
            if msg.get("tools"):
                for tool_name in msg["tools"]:
                    st.caption(f"🔧 Called `{tool_name}`")
            st.markdown(msg["content"])

            if msg.get("chart_data"):
                _render_chart(msg["chart_data"])

    # Input
    if prompt := st.chat_input("Ask about the actuator..."):
        st.session_state.messages.append({"role": "user", "content": prompt})
        with st.chat_message("user", avatar="👤"):
            st.markdown(prompt)

        with st.chat_message("assistant", avatar="🔧"):
            tool_names = []
            status = st.status("Thinking...", expanded=True)

            def on_tool(name, args):
                tool_names.append(name)
                args_str = ", ".join(f"{k}={v}" for k, v in args.items()) if args else ""
                status.update(label=f"🔧 {name}({args_str})")
                st.caption(f"🔧 `{name}({args_str})`")

            try:
                response, st.session_state.history = chat(
                    prompt,
                    st.session_state.history,
                    on_tool_call=on_tool,
                )
                status.update(label="Done", state="complete", expanded=False)
                st.markdown(response)

                chart_data = _detect_chart_opportunity(response, st.session_state.history)
                if chart_data:
                    _render_chart(chart_data)

                st.session_state.messages.append({
                    "role": "assistant",
                    "content": response,
                    "tools": tool_names,
                    "chart_data": chart_data,
                })

            except Exception as e:
                status.update(label="Error", state="error")
                error_msg = f"Error: {e}"
                st.error(error_msg)
                st.session_state.messages.append({
                    "role": "assistant",
                    "content": error_msg,
                    "tools": tool_names,
                })


def _detect_chart_opportunity(response: str, history: list) -> dict | None:
    """Check if we should render a chart based on the conversation."""
    keywords_torque = ["torque", "friction", "sweep", "position curve"]
    keywords_hunting = ["hunting", "frequency", "oscillat", "overshoot"]

    response_lower = response.lower()

    if any(k in response_lower for k in keywords_torque):
        try:
            report = json.loads(execute_tool("get_health_report", {}))
            if "friction" in report and "torque_std_by_bin" in report["friction"]:
                return {"type": "friction_map", "data": report["friction"]["torque_std_by_bin"]}
        except Exception:
            pass

    if any(k in response_lower for k in keywords_hunting):
        try:
            report = json.loads(execute_tool("get_health_report", {}))
            if "hunting" in report and report["hunting"] and "per_config_results" in report["hunting"]:
                return {"type": "hunting_frequency", "data": report["hunting"]["per_config_results"]}
        except Exception:
            pass

    return None


def _render_chart(chart_data: dict):
    if not chart_data:
        return

    if chart_data["type"] == "friction_map":
        df = pd.DataFrame(chart_data["data"])
        chart = alt.Chart(df).mark_bar(color="#f97316").encode(
            x=alt.X("position:Q", title="Position (%)"),
            y=alt.Y("torque_mean:Q", title="Mean Torque (Nmm)"),
        ).properties(title="Torque Friction Map", height=250)
        st.altair_chart(chart, use_container_width=True)

    elif chart_data["type"] == "hunting_frequency":
        df = pd.DataFrame(chart_data["data"])
        if "frequency_hz" in df.columns:
            df["frequency_hz"] = df["frequency_hz"].astype(float)
            base = alt.Chart(df).encode(
                x=alt.X("frequency_hz:Q", title="Frequency (Hz)", scale=alt.Scale(type="log")),
            )
            error_line = base.mark_line(color="#ef4444", strokeWidth=2).encode(
                y=alt.Y("avg_error_pct:Q", title="Tracking Error (%)"),
            )
            overshoot_line = base.mark_line(color="#f97316", strokeDash=[5, 3], strokeWidth=2).encode(
                y=alt.Y("max_overshoot_pct:Q"),
            )
            chart = (error_line + overshoot_line).properties(
                title="Hunting Frequency Response", height=250,
            )
            st.altair_chart(chart, use_container_width=True)


# ===================================================================
#  Quick Actions
# ===================================================================
def render_quick_actions():
    st.markdown("---")
    st.markdown("#### Quick Actions")
    cols = st.columns(4)

    if cols[0].button("🏥 Health Check", use_container_width=True):
        _inject_message("Give me a full health check of this actuator.")
    if cols[1].button("🔍 Compare Profiles", use_container_width=True):
        _inject_message("Compare the baseline sweep (test 100) with the faulty sweep (test 400). What changed?")
    if cols[2].button("💰 Cost Analysis", use_container_width=True):
        _inject_message("Estimate the energy waste and maintenance savings for a typical 50-actuator commercial building.")
    if cols[3].button("⚡ Move Actuator", use_container_width=True):
        _inject_message("Move the actuator to 75%, wait 3 seconds, then move it back to 50%.")


def _inject_message(msg: str):
    st.session_state.messages.append({"role": "user", "content": msg})
    st.session_state._pending_message = msg
    st.rerun()


# ===================================================================
#  Main
# ===================================================================
def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        st.error("Set ANTHROPIC_API_KEY environment variable before running.")
        st.code("export ANTHROPIC_API_KEY=sk-ant-...\nstreamlit run dashboard.py", language="bash")
        st.stop()

    render_sidebar()

    # Handle pending message from quick actions
    if "_pending_message" in st.session_state:
        msg = st.session_state.pop("_pending_message")
        with st.chat_message("user", avatar="👤"):
            st.markdown(msg)
        with st.chat_message("assistant", avatar="🔧"):
            tool_names = []
            status = st.status("Thinking...", expanded=True)

            def on_tool(name, args):
                tool_names.append(name)
                args_str = ", ".join(f"{k}={v}" for k, v in args.items()) if args else ""
                status.update(label=f"🔧 {name}({args_str})")
                st.caption(f"🔧 `{name}({args_str})`")

            try:
                response, st.session_state.history = chat(
                    msg, st.session_state.get("history", []), on_tool_call=on_tool,
                )
                status.update(label="Done", state="complete", expanded=False)
                st.markdown(response)
                st.session_state.messages.append({
                    "role": "assistant", "content": response,
                    "tools": tool_names,
                })
            except Exception as e:
                status.update(label="Error", state="error")
                st.error(str(e))

    render_chat()
    render_quick_actions()


if __name__ == "__main__":
    main()
