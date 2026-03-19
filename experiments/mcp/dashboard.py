
"""
ActuatorIQ — AI Diagnostic Dashboard
======================================
Run:
  export ANTHROPIC_API_KEY=sk-ant-...
  streamlit run dashboard.py
"""

import json
import os
import time

import altair as alt
import pandas as pd
import streamlit as st

from agent import chat, execute_tool

# ===================================================================
#  Page Config & Theme
# ===================================================================
st.set_page_config(
    page_title="ActuatorIQ",
    page_icon="⚡",
    layout="wide",
    initial_sidebar_state="expanded",
)

DARK_CSS = """
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap');

:root {
    --bg-primary: #0a0a0f;
    --bg-secondary: #12121a;
    --bg-card: #1a1a2e;
    --bg-card-hover: #1e1e35;
    --border: #2a2a40;
    --border-glow: #6366f1;
    --text-primary: #f0f0f5;
    --text-secondary: #8888a0;
    --text-muted: #5a5a70;
    --accent: #6366f1;
    --accent-bright: #818cf8;
    --success: #22c55e;
    --warning: #f59e0b;
    --danger: #ef4444;
    --cyan: #06b6d4;
    --gradient-1: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #06b6d4 100%);
}

.stApp {
    background: var(--bg-primary) !important;
    font-family: 'Inter', sans-serif !important;
}

/* Sidebar */
section[data-testid="stSidebar"] {
    background: var(--bg-secondary) !important;
    border-right: 1px solid var(--border) !important;
}
section[data-testid="stSidebar"] * {
    color: var(--text-primary) !important;
}

/* Chat messages */
.stChatMessage {
    background: var(--bg-card) !important;
    border: 1px solid var(--border) !important;
    border-radius: 16px !important;
    padding: 1rem !important;
}

/* Chat input */
.stChatInput > div {
    background: var(--bg-card) !important;
    border: 1px solid var(--border) !important;
    border-radius: 16px !important;
}
.stChatInput textarea {
    color: var(--text-primary) !important;
}

/* Metrics */
[data-testid="stMetric"] {
    background: var(--bg-card) !important;
    border: 1px solid var(--border) !important;
    border-radius: 12px !important;
    padding: 12px 16px !important;
}
[data-testid="stMetricLabel"] {
    color: var(--text-secondary) !important;
    font-size: 0.7rem !important;
    text-transform: uppercase !important;
    letter-spacing: 0.1em !important;
}
[data-testid="stMetricValue"] {
    color: var(--text-primary) !important;
    font-family: 'JetBrains Mono', monospace !important;
    font-weight: 600 !important;
}

/* Buttons */
.stButton > button {
    background: var(--bg-card) !important;
    color: var(--text-primary) !important;
    border: 1px solid var(--border) !important;
    border-radius: 12px !important;
    font-family: 'Inter', sans-serif !important;
    font-weight: 500 !important;
    transition: all 0.2s ease !important;
    padding: 0.6rem 1rem !important;
}
.stButton > button:hover {
    border-color: var(--accent) !important;
    box-shadow: 0 0 20px rgba(99, 102, 241, 0.15) !important;
    transform: translateY(-1px) !important;
}

/* Progress bar */
.stProgress > div > div {
    background: var(--gradient-1) !important;
    border-radius: 8px !important;
}
.stProgress > div {
    background: var(--bg-card) !important;
    border-radius: 8px !important;
}

/* Status expander */
[data-testid="stStatusWidget"] {
    background: var(--bg-card) !important;
    border: 1px solid var(--border) !important;
    border-radius: 12px !important;
}

/* Headings */
h1, h2, h3, h4, h5 {
    color: var(--text-primary) !important;
    font-family: 'Inter', sans-serif !important;
}

p, li, span {
    color: var(--text-primary) !important;
}

/* Dividers */
hr {
    border-color: var(--border) !important;
}

/* Code blocks */
code {
    background: var(--bg-card) !important;
    color: var(--cyan) !important;
    font-family: 'JetBrains Mono', monospace !important;
    border-radius: 6px !important;
    padding: 2px 6px !important;
}

/* Caption / tool calls */
.stCaption, [data-testid="stCaptionContainer"] {
    color: var(--text-muted) !important;
    font-family: 'JetBrains Mono', monospace !important;
    font-size: 0.75rem !important;
}

/* Altair charts dark bg */
.vega-embed {
    background: transparent !important;
}

/* Hero gradient text */
.hero-title {
    font-size: 2.8rem;
    font-weight: 800;
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 30%, #06b6d4 70%, #22c55e 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: -0.03em;
    line-height: 1.1;
    margin-bottom: 0;
}
.hero-sub {
    font-size: 1rem;
    color: var(--text-secondary);
    font-weight: 400;
    letter-spacing: 0.02em;
    margin-top: 4px;
}

/* Score ring */
.score-ring {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 20px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    margin: 12px 0;
}
.score-number {
    font-family: 'JetBrains Mono', monospace;
    font-size: 3rem;
    font-weight: 800;
    line-height: 1;
}
.score-grade {
    font-size: 1.2rem;
    font-weight: 600;
    padding: 4px 12px;
    border-radius: 8px;
    display: inline-block;
}
.grade-a { background: rgba(34,197,94,0.15); color: #22c55e; }
.grade-b { background: rgba(99,102,241,0.15); color: #818cf8; }
.grade-c { background: rgba(245,158,11,0.15); color: #f59e0b; }
.grade-d { background: rgba(239,68,68,0.15); color: #ef4444; }
.grade-f { background: rgba(239,68,68,0.25); color: #ef4444; }

/* Diagnostic pill */
.diag-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 0.82rem;
    font-weight: 500;
    margin: 3px 2px;
    font-family: 'Inter', sans-serif;
}
.pill-pass { background: rgba(34,197,94,0.12); color: #22c55e; border: 1px solid rgba(34,197,94,0.25); }
.pill-warn { background: rgba(245,158,11,0.12); color: #f59e0b; border: 1px solid rgba(245,158,11,0.25); }
.pill-fail { background: rgba(239,68,68,0.12); color: #ef4444; border: 1px solid rgba(239,68,68,0.25); }
.pill-info { background: rgba(99,102,241,0.12); color: #818cf8; border: 1px solid rgba(99,102,241,0.25); }

/* Glow card for quick actions */
.glow-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    transition: all 0.3s ease;
}
.glow-card:hover {
    border-color: var(--accent);
    box-shadow: 0 0 30px rgba(99, 102, 241, 0.1);
}

/* Animated pulse dot */
.pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 6px;
    animation: pulse 2s infinite;
}
.pulse-green { background: #22c55e; }
.pulse-yellow { background: #f59e0b; }
.pulse-red { background: #ef4444; }
@keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(34,197,94,0.4); }
    50% { opacity: 0.7; box-shadow: 0 0 0 6px rgba(34,197,94,0); }
}

/* Hide streamlit branding */
#MainMenu, footer, header { visibility: hidden; }
</style>
"""

st.markdown(DARK_CSS, unsafe_allow_html=True)


# ===================================================================
#  Sidebar — System Status Panel
# ===================================================================
def render_sidebar():
    st.sidebar.markdown(
        '<p style="font-family: JetBrains Mono; font-size: 0.7rem; text-transform: uppercase; '
        'letter-spacing: 0.2em; color: #5a5a70; margin-bottom: 4px;">System Status</p>',
        unsafe_allow_html=True,
    )

    try:
        report = json.loads(execute_tool("get_health_report", {}))
        if "error" in report:
            st.sidebar.warning("No diagnostic data")
            return
    except Exception:
        st.sidebar.error("Failed to load report")
        return

    score = report["health"]["score"]
    grade = report["health"]["grade"]
    grade_cls = f"grade-{grade.lower()}"

    if score >= 80:
        score_color = "#22c55e"
    elif score >= 60:
        score_color = "#818cf8"
    elif score >= 40:
        score_color = "#f59e0b"
    else:
        score_color = "#ef4444"

    st.sidebar.markdown(f"""
    <div class="score-ring">
        <div>
            <div class="score-number" style="color: {score_color};">{score}</div>
            <div style="color: #5a5a70; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em;">/ 100</div>
        </div>
        <div>
            <span class="score-grade {grade_cls}">Grade {grade}</span>
            <div style="color: #8888a0; font-size: 0.78rem; margin-top: 6px;">Health Score</div>
        </div>
    </div>
    """, unsafe_allow_html=True)

    # Diagnostic pills
    severity_map = {"pass": "pill-pass", "warn": "pill-warn", "fail": "pill-fail", "info": "pill-info"}
    icon_map = {"pass": "✓", "warn": "!", "fail": "✕", "info": "i"}

    checks = [
        ("Sizing", report.get("sizing", {})),
        ("Linkage", report.get("linkage", {})),
        ("Friction", report.get("friction", {})),
    ]
    if report.get("hunting"):
        checks.append(("Hunting", report["hunting"]))
    if report.get("steps"):
        checks.append(("Response", report["steps"]))

    pills_html = ""
    for name, data in checks:
        sev = data.get("severity", "info")
        pill_cls = severity_map.get(sev, "pill-info")
        icon = icon_map.get(sev, "?")
        verdict = data.get("verdict", "N/A")
        pills_html += f'<span class="diag-pill {pill_cls}">{icon} {name}: {verdict}</span> '

    st.sidebar.markdown(pills_html, unsafe_allow_html=True)

    # Component bars
    st.sidebar.markdown("")
    st.sidebar.markdown(
        '<p style="font-family: JetBrains Mono; font-size: 0.65rem; text-transform: uppercase; '
        'letter-spacing: 0.15em; color: #5a5a70; margin: 16px 0 8px 0;">Score Breakdown</p>',
        unsafe_allow_html=True,
    )

    if "components" in report.get("health", {}):
        components = report["health"]["components"]
        max_scores = {"sizing": 25, "linkage": 20, "friction": 20, "transit": 15, "symmetry": 20}

        for comp, val in components.items():
            max_val = max_scores.get(comp, 20)
            pct = min(val / max_val, 1.0) * 100
            if pct > 80:
                bar_color = "#22c55e"
            elif pct > 50:
                bar_color = "#6366f1"
            else:
                bar_color = "#ef4444"

            st.sidebar.markdown(f"""
            <div style="margin-bottom: 8px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                    <span style="font-size: 0.75rem; color: #8888a0; text-transform: capitalize;">{comp}</span>
                    <span style="font-size: 0.75rem; font-family: JetBrains Mono; color: #f0f0f5;">{val}/{max_val}</span>
                </div>
                <div style="background: #1a1a2e; border-radius: 4px; height: 6px; overflow: hidden;">
                    <div style="background: {bar_color}; width: {pct}%; height: 100%; border-radius: 4px;
                                transition: width 0.5s ease;"></div>
                </div>
            </div>
            """, unsafe_allow_html=True)

    # Live telemetry
    st.sidebar.markdown("")
    st.sidebar.markdown(
        '<p style="font-family: JetBrains Mono; font-size: 0.65rem; text-transform: uppercase; '
        'letter-spacing: 0.15em; color: #5a5a70; margin: 16px 0 8px 0;">Live Telemetry</p>',
        unsafe_allow_html=True,
    )

    try:
        telemetry = json.loads(execute_tool("read_telemetry", {"n": 1}))
        if isinstance(telemetry, list) and telemetry:
            t = telemetry[0]
            col1, col2 = st.sidebar.columns(2)
            col1.metric("Position", f"{t.get('feedback_position_%', 0):.1f}%")
            col2.metric("Torque", f"{t.get('motor_torque_Nmm', 0):.1f} Nmm")
            col1.metric("Power", f"{t.get('power_W', 0)*1000:.0f} mW")
            col2.metric("Temp", f"{t.get('internal_temperature_deg_C', 0):.1f}°C")

            pulse_cls = "pulse-green"
            st.sidebar.markdown(
                f'<div style="text-align: center; margin-top: 8px;">'
                f'<span class="pulse-dot {pulse_cls}"></span>'
                f'<span style="font-size: 0.75rem; color: #22c55e;">Connected to actuator</span></div>',
                unsafe_allow_html=True,
            )
        else:
            st.sidebar.markdown(
                '<div style="text-align: center; padding: 12px; background: rgba(245,158,11,0.08); '
                'border-radius: 12px; border: 1px solid rgba(245,158,11,0.2);">'
                '<span style="color: #f59e0b; font-size: 0.8rem;">Offline — using cached data</span></div>',
                unsafe_allow_html=True,
            )
    except Exception:
        st.sidebar.markdown(
            '<div style="text-align: center; padding: 12px; background: rgba(245,158,11,0.08); '
            'border-radius: 12px; border: 1px solid rgba(245,158,11,0.2);">'
            '<span style="color: #f59e0b; font-size: 0.8rem;">Offline — using cached data</span></div>',
            unsafe_allow_html=True,
        )

    # Branding
    st.sidebar.markdown("")
    st.sidebar.markdown(
        '<div style="text-align: center; padding: 16px 0; border-top: 1px solid #2a2a40; margin-top: 20px;">'
        '<span style="font-family: JetBrains Mono; font-size: 0.65rem; color: #3a3a50; '
        'letter-spacing: 0.15em; text-transform: uppercase;">ActuatorIQ v1.0</span><br>'
        '<span style="font-size: 0.6rem; color: #3a3a50;">START Hack 2026 — Belimo Challenge</span>'
        '</div>',
        unsafe_allow_html=True,
    )


# ===================================================================
#  Hero Header
# ===================================================================
def render_header():
    col1, col2 = st.columns([3, 1])
    with col1:
        st.markdown('<div class="hero-title">ActuatorIQ</div>', unsafe_allow_html=True)
        st.markdown(
            '<div class="hero-sub">AI-powered diagnostics for Belimo HVAC actuators — '
            'real-time analysis, predictive maintenance, actionable insights</div>',
            unsafe_allow_html=True,
        )
    with col2:
        st.markdown(
            '<div style="text-align: right; padding-top: 12px;">'
            '<span style="font-family: JetBrains Mono; font-size: 0.65rem; color: #5a5a70; '
            'text-transform: uppercase; letter-spacing: 0.15em;">Powered by</span><br>'
            '<span style="font-size: 1.1rem; font-weight: 600; color: #818cf8;">Claude AI</span>'
            '</div>',
            unsafe_allow_html=True,
        )
    st.markdown('<div style="height: 1px; background: linear-gradient(90deg, #6366f1 0%, transparent 100%); '
                'margin: 16px 0 24px 0;"></div>', unsafe_allow_html=True)


# ===================================================================
#  Quick Action Cards
# ===================================================================
def render_quick_actions():
    st.markdown(
        '<p style="font-family: JetBrains Mono; font-size: 0.65rem; text-transform: uppercase; '
        'letter-spacing: 0.2em; color: #5a5a70; margin-bottom: 12px;">Quick Actions</p>',
        unsafe_allow_html=True,
    )

    cols = st.columns(4)
    actions = [
        ("🏥", "Health Check", "Full diagnostic scan", "Run a complete health check on this actuator."),
        ("🔍", "Compare Profiles", "Baseline vs current", "Compare the baseline sweep (test 100) with the current sweep (test 400). What changed and what does it mean?"),
        ("💰", "Cost Analysis", "Business impact in CHF", "Estimate the annual energy waste and maintenance savings for a 50-actuator commercial building based on this actuator's diagnostics."),
        ("⚡", "Move Actuator", "Physical control", "Move the actuator to 75% position, then back to 50%."),
    ]

    for i, (icon, title, desc, prompt) in enumerate(actions):
        with cols[i]:
            if st.button(f"{icon} {title}", key=f"qa_{i}", use_container_width=True,
                         help=desc):
                _inject_message(prompt)


# ===================================================================
#  Chat Interface
# ===================================================================
def render_chat():
    if "messages" not in st.session_state:
        st.session_state.messages = []
    if "history" not in st.session_state:
        st.session_state.history = []

    for msg in st.session_state.messages:
        avatar = "✦" if msg["role"] == "assistant" else "▸"
        with st.chat_message(msg["role"], avatar=avatar):
            if msg.get("tools"):
                tool_html = " → ".join(
                    f'<code style="font-size: 0.72rem; background: rgba(99,102,241,0.1); '
                    f'color: #818cf8; padding: 2px 8px; border-radius: 4px;">{t}</code>'
                    for t in msg["tools"]
                )
                st.markdown(
                    f'<div style="margin-bottom: 8px; font-size: 0.72rem; color: #5a5a70;">'
                    f'Tool chain: {tool_html}</div>',
                    unsafe_allow_html=True,
                )
            st.markdown(msg["content"])
            if msg.get("chart_data"):
                _render_chart(msg["chart_data"])

    if prompt := st.chat_input("Ask ActuatorIQ anything about this actuator..."):
        st.session_state.messages.append({"role": "user", "content": prompt})
        with st.chat_message("user", avatar="▸"):
            st.markdown(prompt)
        _run_agent(prompt)


def _run_agent(prompt: str):
    with st.chat_message("assistant", avatar="✦"):
        tool_names = []
        status = st.status("Analyzing...", expanded=True)

        def on_tool(name, args):
            tool_names.append(name)
            args_str = ", ".join(f"{k}={v}" for k, v in args.items()) if args else ""
            status.write(f"`{name}({args_str})`")

        try:
            response, st.session_state.history = chat(
                prompt,
                st.session_state.history,
                on_tool_call=on_tool,
            )

            label = f"Analyzed — {len(tool_names)} tool{'s' if len(tool_names) != 1 else ''} used"
            status.update(label=label, state="complete", expanded=False)

            st.markdown(response)
            chart_data = _detect_chart_opportunity(response)
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
            st.error(str(e))
            st.session_state.messages.append({
                "role": "assistant",
                "content": f"Error: {e}",
                "tools": tool_names,
            })


def _inject_message(msg: str):
    st.session_state.messages.append({"role": "user", "content": msg})
    st.session_state._pending_message = msg
    st.rerun()


# ===================================================================
#  Charts — Dark themed
# ===================================================================
CHART_CONFIG = {
    "background": "#12121a",
    "title": {"color": "#f0f0f5", "font": "Inter", "fontSize": 14, "fontWeight": 600},
    "axis": {
        "gridColor": "#2a2a40",
        "domainColor": "#2a2a40",
        "tickColor": "#2a2a40",
        "labelColor": "#8888a0",
        "titleColor": "#8888a0",
        "labelFont": "JetBrains Mono",
        "titleFont": "Inter",
        "labelFontSize": 11,
    },
    "view": {"stroke": "transparent"},
    "legend": {"labelColor": "#8888a0", "titleColor": "#8888a0"},
}


def _detect_chart_opportunity(response: str) -> dict | None:
    response_lower = response.lower()

    if any(k in response_lower for k in ["torque", "friction", "sweep", "position curve"]):
        try:
            report = json.loads(execute_tool("get_health_report", {}))
            if "friction" in report and "torque_std_by_bin" in report["friction"]:
                return {"type": "friction_map", "data": report["friction"]["torque_std_by_bin"]}
        except Exception:
            pass

    if any(k in response_lower for k in ["hunting", "frequency", "oscillat", "overshoot"]):
        try:
            report = json.loads(execute_tool("get_health_report", {}))
            if report.get("hunting") and "per_config_results" in report["hunting"]:
                return {"type": "hunting_frequency", "data": report["hunting"]["per_config_results"]}
        except Exception:
            pass

    return None


def _render_chart(chart_data: dict):
    if not chart_data:
        return

    if chart_data["type"] == "friction_map":
        df = pd.DataFrame(chart_data["data"])
        chart = (
            alt.Chart(df)
            .mark_bar(
                cornerRadiusTopLeft=4,
                cornerRadiusTopRight=4,
                color="#6366f1",
            )
            .encode(
                x=alt.X("position:Q", title="Position (%)", axis=alt.Axis(grid=False)),
                y=alt.Y("torque_mean:Q", title="Mean Torque (Nmm)"),
                color=alt.Color(
                    "torque_mean:Q",
                    scale=alt.Scale(scheme="viridis"),
                    legend=None,
                ),
            )
            .configure(**CHART_CONFIG)
            .properties(title="Torque Friction Map — Position vs Mean Torque", height=280)
        )
        st.altair_chart(chart, use_container_width=True)

    elif chart_data["type"] == "hunting_frequency":
        df = pd.DataFrame(chart_data["data"])
        if "frequency_hz" in df.columns:
            df["frequency_hz"] = df["frequency_hz"].astype(float)
            df_long = pd.melt(
                df, id_vars=["frequency_hz"],
                value_vars=["avg_error_pct", "max_overshoot_pct"],
                var_name="metric", value_name="value",
            )
            df_long["metric"] = df_long["metric"].map({
                "avg_error_pct": "Tracking Error %",
                "max_overshoot_pct": "Max Overshoot %",
            })
            chart = (
                alt.Chart(df_long)
                .mark_line(strokeWidth=2.5, point=alt.OverlayMarkDef(size=60))
                .encode(
                    x=alt.X("frequency_hz:Q", title="Frequency (Hz)",
                             scale=alt.Scale(type="log"), axis=alt.Axis(grid=True)),
                    y=alt.Y("value:Q", title="Percentage (%)"),
                    color=alt.Color("metric:N",
                                     scale=alt.Scale(range=["#ef4444", "#f59e0b"]),
                                     legend=alt.Legend(title=None, orient="top")),
                    strokeDash=alt.StrokeDash("metric:N", legend=None),
                )
                .configure(**CHART_CONFIG)
                .properties(title="Hunting Frequency Response", height=280)
            )
            st.altair_chart(chart, use_container_width=True)


# ===================================================================
#  Main
# ===================================================================
def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        st.markdown(DARK_CSS, unsafe_allow_html=True)
        st.markdown(
            '<div style="text-align: center; padding: 80px 20px;">'
            '<div class="hero-title" style="font-size: 2rem;">ActuatorIQ</div>'
            '<p style="color: #8888a0; margin: 20px 0;">Set your API key to get started</p>'
            '</div>',
            unsafe_allow_html=True,
        )
        st.code("export ANTHROPIC_API_KEY=sk-ant-...\nstreamlit run dashboard.py", language="bash")
        st.stop()

    render_sidebar()
    render_header()

    # Handle pending quick action
    if "_pending_message" in st.session_state:
        msg = st.session_state.pop("_pending_message")
        with st.chat_message("user", avatar="▸"):
            st.markdown(msg)
        _run_agent(msg)

    render_chat()

    st.markdown('<div style="height: 24px;"></div>', unsafe_allow_html=True)
    render_quick_actions()


if __name__ == "__main__":
    main()
