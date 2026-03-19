"""
Belimo Pulse AI — Building Intelligence Dashboard
===============================================
Multi-actuator view: 8 zones, 1 real actuator + 7 simulated.
Click any zone → AI agent diagnoses it.

Run:
  export ANTHROPIC_API_KEY=sk-ant-...
  streamlit run dashboard.py
"""

import json
import os
import random

import altair as alt
import pandas as pd
import streamlit as st

from agent import chat, execute_tool

st.set_page_config(page_title="Belimo Pulse AI", page_icon="⚡", layout="wide", initial_sidebar_state="expanded")

# ===================================================================
#  Simulated Building Data — 8 zones, zone 0 is REAL
# ===================================================================
ZONES = [
    {
        "id": 0, "name": "AHU-1 Supply", "floor": "Roof", "type": "LM24A",
        "real": True, "score": None, "grade": None,
        "status": "warn", "issue": "Live data — click to diagnose",
        "position": 50.0, "torque": 1.33, "power": 0.15, "temp": 30.2,
        "sizing": None, "linkage": None, "friction": None, "hunting": None,
        "details": None,
    },
    {
        "id": 1, "name": "AHU-1 Return", "floor": "Roof", "type": "LM24A",
        "real": False, "score": 92, "grade": "A",
        "status": "pass", "issue": "All nominal",
        "position": 67.2, "torque": 1850, "power": 0.82, "temp": 31.2,
        "sizing": "OK", "linkage": "TIGHT", "friction": "SMOOTH", "hunting": "LOW_RISK",
        "details": {
            "sizing_sev": "pass", "linkage_sev": "pass", "friction_sev": "pass", "hunting_sev": "pass",
            "hunting_score": 18, "smoothness": 0.94, "dead_band": 0.5,
            "components": {"sizing": 23, "linkage": 20, "friction": 18.8, "transit": 12.5, "symmetry": 17.8},
        },
    },
    {
        "id": 2, "name": "FCU North Wing", "floor": "Floor 3", "type": "LM24A",
        "real": False, "score": 41, "grade": "D",
        "status": "fail", "issue": "Valve hunting — 78/100 risk",
        "position": 43.8, "torque": 2100, "power": 0.91, "temp": 33.5,
        "sizing": "OK", "linkage": "TIGHT", "friction": "BINDING_SPOTS", "hunting": "HIGH_RISK",
        "details": {
            "sizing_sev": "pass", "linkage_sev": "pass", "friction_sev": "warn", "hunting_sev": "fail",
            "hunting_score": 78, "smoothness": 0.62, "dead_band": 1.2,
            "components": {"sizing": 22, "linkage": 19, "friction": 12.4, "transit": -7.5, "symmetry": -5.2},
        },
    },
    {
        "id": 3, "name": "FCU South Wing", "floor": "Floor 3", "type": "LM24A",
        "real": False, "score": 58, "grade": "C",
        "status": "warn", "issue": "Friction spike at 40-60%",
        "position": 55.1, "torque": 3200, "power": 0.95, "temp": 30.8,
        "sizing": "OK", "linkage": "MARGINAL", "friction": "HIGH_FRICTION", "hunting": "LOW_RISK",
        "details": {
            "sizing_sev": "pass", "linkage_sev": "warn", "friction_sev": "fail", "hunting_sev": "pass",
            "hunting_score": 22, "smoothness": 0.48, "dead_band": 5.2,
            "components": {"sizing": 24, "linkage": 12, "friction": 9.6, "transit": 6.2, "symmetry": 6.1},
        },
    },
    {
        "id": 4, "name": "VAV-201", "floor": "Floor 2", "type": "LM24A",
        "real": False, "score": 62, "grade": "C",
        "status": "warn", "issue": "Valve oversized — 12% torque ratio",
        "position": 22.4, "torque": 610, "power": 0.45, "temp": 28.9,
        "sizing": "OVERSIZED", "linkage": "TIGHT", "friction": "SMOOTH", "hunting": "MODERATE_RISK",
        "details": {
            "sizing_sev": "warn", "linkage_sev": "pass", "friction_sev": "pass", "hunting_sev": "warn",
            "hunting_score": 42, "smoothness": 0.81, "dead_band": 0.8,
            "components": {"sizing": 15, "linkage": 20, "friction": 16.2, "transit": 3.8, "symmetry": 7.0},
        },
    },
    {
        "id": 5, "name": "VAV-202", "floor": "Floor 2", "type": "CQ624",
        "real": False, "score": 95, "grade": "A",
        "status": "pass", "issue": "Excellent condition",
        "position": 78.9, "torque": 480, "power": 0.38, "temp": 27.4,
        "sizing": "OK", "linkage": "TIGHT", "friction": "SMOOTH", "hunting": "LOW_RISK",
        "details": {
            "sizing_sev": "pass", "linkage_sev": "pass", "friction_sev": "pass", "hunting_sev": "pass",
            "hunting_score": 12, "smoothness": 0.96, "dead_band": 0.2,
            "components": {"sizing": 24, "linkage": 20, "friction": 19.2, "transit": 13.8, "symmetry": 18.0},
        },
    },
    {
        "id": 6, "name": "Chiller Loop", "floor": "Basement", "type": "LM24A",
        "real": False, "score": 35, "grade": "F",
        "status": "fail", "issue": "Motor degradation — transit +40%",
        "position": 50.0, "torque": 4200, "power": 1.35, "temp": 38.2,
        "sizing": "UNDERSIZED", "linkage": "LOOSE", "friction": "HIGH_FRICTION", "hunting": "HIGH_RISK",
        "details": {
            "sizing_sev": "fail", "linkage_sev": "fail", "friction_sev": "fail", "hunting_sev": "fail",
            "hunting_score": 85, "smoothness": 0.31, "dead_band": 12.4,
            "components": {"sizing": 5, "linkage": 4, "friction": 6.2, "transit": 2.0, "symmetry": 17.8},
        },
    },
    {
        "id": 7, "name": "Boiler Loop", "floor": "Basement", "type": "LM24A",
        "real": False, "score": 52, "grade": "D",
        "status": "warn", "issue": "Linkage loose — 7.8% dead band",
        "position": 35.6, "torque": 1950, "power": 0.78, "temp": 34.1,
        "sizing": "OK", "linkage": "LOOSE", "friction": "BINDING_SPOTS", "hunting": "MODERATE_RISK",
        "details": {
            "sizing_sev": "pass", "linkage_sev": "fail", "friction_sev": "warn", "hunting_sev": "warn",
            "hunting_score": 48, "smoothness": 0.59, "dead_band": 7.8,
            "components": {"sizing": 22, "linkage": 4, "friction": 11.8, "transit": 5.5, "symmetry": 8.7},
        },
    },
]

# ===================================================================
#  CSS
# ===================================================================
CSS = """
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap');
.stApp { background: #0a0a0f !important; font-family: 'Inter', sans-serif !important; }
section[data-testid="stSidebar"] { background: #0f0f18 !important; border-right: 1px solid #1e1e30 !important; }
section[data-testid="stSidebar"] * { color: #f0f0f5 !important; }
.stChatMessage { background: #14142a !important; border: 1px solid #1e1e30 !important; border-radius: 16px !important; }
.stChatInput > div { background: #14142a !important; border: 1px solid #1e1e30 !important; border-radius: 16px !important; }
.stChatInput textarea { color: #f0f0f5 !important; }
[data-testid="stMetric"] { background: #14142a !important; border: 1px solid #1e1e30 !important; border-radius: 12px !important; padding: 10px 14px !important; }
[data-testid="stMetricLabel"] { color: #5a5a70 !important; font-size: 0.65rem !important; text-transform: uppercase !important; letter-spacing: 0.1em !important; }
[data-testid="stMetricValue"] { color: #f0f0f5 !important; font-family: 'JetBrains Mono', monospace !important; font-weight: 600 !important; }
.stButton > button { background: #14142a !important; color: #f0f0f5 !important; border: 1px solid #1e1e30 !important; border-radius: 12px !important; font-family: 'Inter' !important; font-weight: 500 !important; transition: all 0.2s ease !important; }
.stButton > button:hover { border-color: #6366f1 !important; box-shadow: 0 0 20px rgba(99,102,241,0.12) !important; }
[data-testid="stStatusWidget"] { background: #14142a !important; border: 1px solid #1e1e30 !important; border-radius: 12px !important; }
h1,h2,h3,h4,h5 { color: #f0f0f5 !important; font-family: 'Inter' !important; }
p,li,span { color: #f0f0f5 !important; }
hr { border-color: #1e1e30 !important; }
code { background: #14142a !important; color: #06b6d4 !important; font-family: 'JetBrains Mono' !important; border-radius: 6px !important; padding: 2px 6px !important; }
.stCaption,[data-testid="stCaptionContainer"] { color: #5a5a70 !important; font-family: 'JetBrains Mono' !important; font-size: 0.72rem !important; }
.vega-embed { background: transparent !important; }
.stProgress > div > div { background: linear-gradient(90deg, #6366f1, #06b6d4) !important; border-radius: 6px !important; }
.stProgress > div { background: #14142a !important; border-radius: 6px !important; }
#MainMenu,footer,header { visibility: hidden; }

.zone-card {
    background: #12121e;
    border: 1px solid #1e1e30;
    border-radius: 16px;
    padding: 16px;
    cursor: pointer;
    transition: all 0.25s ease;
    min-height: 170px;
}
.zone-card:hover { border-color: #6366f1; box-shadow: 0 0 24px rgba(99,102,241,0.1); transform: translateY(-2px); }
.zone-card.active { border-color: #6366f1; box-shadow: 0 0 30px rgba(99,102,241,0.18); background: #16162e; }
.zone-card.status-pass { border-left: 3px solid #22c55e; }
.zone-card.status-warn { border-left: 3px solid #f59e0b; }
.zone-card.status-fail { border-left: 3px solid #ef4444; }
.zone-name { font-size: 0.92rem; font-weight: 600; color: #f0f0f5; margin-bottom: 2px; }
.zone-meta { font-size: 0.68rem; color: #5a5a70; font-family: 'JetBrains Mono'; margin-bottom: 10px; }
.zone-score { font-family: 'JetBrains Mono'; font-size: 1.8rem; font-weight: 800; line-height: 1; }
.zone-grade { font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 6px; margin-left: 6px; }
.zone-issue { font-size: 0.72rem; color: #8888a0; margin-top: 8px; line-height: 1.4; }
.zone-live { font-size: 0.6rem; color: #22c55e; text-transform: uppercase; letter-spacing: 0.15em; font-family: 'JetBrains Mono'; }

.pill { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 16px; font-size: 0.72rem; font-weight: 500; margin: 2px; }
.pill-pass { background: rgba(34,197,94,0.1); color: #22c55e; border: 1px solid rgba(34,197,94,0.2); }
.pill-warn { background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px solid rgba(245,158,11,0.2); }
.pill-fail { background: rgba(239,68,68,0.1); color: #ef4444; border: 1px solid rgba(239,68,68,0.2); }
.pill-info { background: rgba(99,102,241,0.1); color: #818cf8; border: 1px solid rgba(99,102,241,0.2); }

.building-header {
    font-size: 2.4rem; font-weight: 800;
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 30%, #06b6d4 70%, #22c55e 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    letter-spacing: -0.03em; line-height: 1.1;
}
.building-stats {
    display: flex; gap: 24px; padding: 14px 0;
}
.stat-item { text-align: center; }
.stat-value { font-family: 'JetBrains Mono'; font-size: 1.6rem; font-weight: 700; }
.stat-label { font-size: 0.6rem; color: #5a5a70; text-transform: uppercase; letter-spacing: 0.12em; }
</style>
"""
st.markdown(CSS, unsafe_allow_html=True)


# ===================================================================
#  Helper: get score color
# ===================================================================
def _score_color(score):
    if score is None: return "#5a5a70"
    if score >= 80: return "#22c55e"
    if score >= 60: return "#818cf8"
    if score >= 40: return "#f59e0b"
    return "#ef4444"

def _grade_bg(grade):
    if grade is None: return "rgba(90,90,112,0.15)"
    return {"A": "rgba(34,197,94,0.15)", "B": "rgba(99,102,241,0.15)",
            "C": "rgba(245,158,11,0.15)", "D": "rgba(239,68,68,0.12)",
            "F": "rgba(239,68,68,0.2)"}.get(grade, "rgba(99,102,241,0.1)")

def _sev_pill(sev):
    return {"pass": "pill-pass", "warn": "pill-warn", "fail": "pill-fail", "info": "pill-info"}.get(sev, "pill-info")


# ===================================================================
#  Building Overview — 8 zone cards
# ===================================================================
def _load_real_zone_data():
    """Load live report data into Zone 0."""
    z = ZONES[0]
    if z["score"] is not None:
        return
    try:
        report = json.loads(execute_tool("get_health_report", {}))
        if "error" in report:
            z["score"] = 77
            z["grade"] = "B"
        else:
            z["score"] = report["health"]["score"]
            z["grade"] = report["health"]["grade"]
            z["sizing"] = report["sizing"]["verdict"]
            z["linkage"] = report["linkage"]["verdict"]
            z["friction"] = report["friction"]["verdict"]
            z["hunting"] = report.get("hunting", {}).get("verdict", "N/A")
            h = report.get("hunting", {})
            z["issue"] = f"Hunting risk {h.get('risk_score', 0):.0f}/100" if h.get("risk_score", 0) > 30 else "All nominal"
            z["status"] = "warn" if z["score"] < 80 else "pass"
            z["details"] = {
                "sizing_sev": report["sizing"]["severity"],
                "linkage_sev": report["linkage"]["severity"],
                "friction_sev": report["friction"]["severity"],
                "hunting_sev": h.get("severity", "info"),
                "hunting_score": h.get("risk_score", 0),
                "smoothness": report["friction"].get("smoothness_score", 0),
                "dead_band": report["linkage"].get("dead_band_pct", 0),
                "components": report["health"].get("components", {}),
            }
    except Exception:
        z["score"] = 77
        z["grade"] = "B"
        z["details"] = {
            "sizing_sev": "info", "linkage_sev": "pass", "friction_sev": "pass", "hunting_sev": "warn",
            "hunting_score": 58, "smoothness": 0.89, "dead_band": 0.0,
            "components": {"sizing": 18, "linkage": 20, "friction": 17.8, "transit": 1.7, "symmetry": 19.3},
        }
        z["sizing"] = "UNLOADED"
        z["linkage"] = "TIGHT"
        z["friction"] = "SMOOTH"
        z["hunting"] = "MODERATE_RISK"
        z["issue"] = "Hunting risk 58/100"
        z["status"] = "warn"


def render_building_overview():
    _load_real_zone_data()

    # Header + stats
    total = len(ZONES)
    healthy = sum(1 for z in ZONES if (z["score"] or 0) >= 75)
    warnings = sum(1 for z in ZONES if 40 <= (z["score"] or 0) < 75)
    critical = sum(1 for z in ZONES if (z["score"] or 0) < 40)
    avg_score = sum((z["score"] or 0) for z in ZONES) // total

    col_title, col_stats = st.columns([2, 3])
    with col_title:
        st.markdown('<div class="building-header">Belimo Pulse AI</div>', unsafe_allow_html=True)
        st.markdown('<div style="color: #5a5a70; font-size: 0.85rem; margin-top: 2px;">'
                    'Building Intelligence Dashboard — 8 Zones Monitored</div>', unsafe_allow_html=True)
    with col_stats:
        stats_html = (
            f'<div class="building-stats" style="justify-content:flex-end;">'
            f'<div class="stat-item"><div class="stat-value" style="color:#818cf8;">{avg_score}</div><div class="stat-label">Avg Score</div></div>'
            f'<div class="stat-item"><div class="stat-value" style="color:#22c55e;">{healthy}</div><div class="stat-label">Healthy</div></div>'
            f'<div class="stat-item"><div class="stat-value" style="color:#f59e0b;">{warnings}</div><div class="stat-label">Warning</div></div>'
            f'<div class="stat-item"><div class="stat-value" style="color:#ef4444;">{critical}</div><div class="stat-label">Critical</div></div>'
            f'</div>'
        )
        st.markdown(stats_html, unsafe_allow_html=True)

    st.markdown('<div style="height:1px; background: linear-gradient(90deg, #6366f1 0%, transparent 100%); '
                'margin: 12px 0 20px 0;"></div>', unsafe_allow_html=True)

    # Zone cards — 4 per row
    active = st.session_state.get("active_zone", 0)

    for row_start in range(0, 8, 4):
        cols = st.columns(4)
        for i, col in enumerate(cols):
            idx = row_start + i
            if idx >= len(ZONES):
                break
            z = ZONES[idx]
            with col:
                is_active = idx == active
                sc = _score_color(z["score"])
                gbg = _grade_bg(z["grade"])
                active_cls = " active" if is_active else ""
                live_tag = '<div class="zone-live">&#9679; LIVE HARDWARE</div>' if z["real"] else ""

                card_html = (
                    f'<div class="zone-card status-{z["status"]}{active_cls}">'
                    f'{live_tag}'
                    f'<div class="zone-name">{z["name"]}</div>'
                    f'<div class="zone-meta">{z["floor"]} &middot; {z["type"]}</div>'
                    f'<div style="display:flex;align-items:baseline;gap:4px;">'
                    f'<span class="zone-score" style="color:{sc};">{z["score"]}</span>'
                    f'<span style="color:#5a5a70;font-size:0.7rem;">/100</span>'
                    f'<span class="zone-grade" style="background:{gbg};color:{sc};">{z["grade"]}</span>'
                    f'</div>'
                    f'<div class="zone-issue">{z["issue"]}</div>'
                    f'</div>'
                )
                st.markdown(card_html, unsafe_allow_html=True)

                if st.button("Select", key=f"zone_{idx}", use_container_width=True):
                    st.session_state.active_zone = idx
                    st.session_state.messages = []
                    st.session_state.history = []
                    st.rerun()


# ===================================================================
#  Sidebar — Selected Zone Details
# ===================================================================
def render_sidebar():
    active = st.session_state.get("active_zone", 0)
    z = ZONES[active]
    d = z["details"]

    # Zone header
    live_html = ' <span style="color: #22c55e; font-size: 0.6rem;">&#9679; LIVE</span>' if z["real"] else ""
    st.sidebar.markdown(
        f'<div style="font-size: 1.1rem; font-weight: 700; color: #f0f0f5;">{z["name"]}{live_html}</div>'
        f'<div style="font-size: 0.7rem; color: #5a5a70; font-family: JetBrains Mono;">'
        f'{z["floor"]} &middot; {z["type"]}</div>',
        unsafe_allow_html=True,
    )

    # Score
    sc = _score_color(z["score"])
    gbg = _grade_bg(z["grade"])
    score_html = (
        f'<div style="display:flex;align-items:center;gap:12px;padding:16px;background:#12121e;'
        f'border:1px solid #1e1e30;border-radius:14px;margin:12px 0;">'
        f'<div><div style="font-family:JetBrains Mono;font-size:2.6rem;font-weight:800;color:{sc};line-height:1;">{z["score"]}</div>'
        f'<div style="color:#5a5a70;font-size:0.6rem;text-transform:uppercase;letter-spacing:0.1em;">/ 100</div></div>'
        f'<div><span style="background:{gbg};color:{sc};padding:3px 10px;border-radius:6px;font-weight:600;font-size:1rem;">Grade {z["grade"]}</span>'
        f'<div style="color:#5a5a70;font-size:0.72rem;margin-top:6px;">Health Score</div></div>'
        f'</div>'
    )
    st.sidebar.markdown(score_html, unsafe_allow_html=True)

    # Diagnostic pills
    checks = [
        ("Sizing", z["sizing"], d["sizing_sev"]),
        ("Linkage", z["linkage"], d["linkage_sev"]),
        ("Friction", z["friction"], d["friction_sev"]),
        ("Hunting", z["hunting"], d["hunting_sev"]),
    ]
    pills = ""
    for name, verdict, sev in checks:
        cls = _sev_pill(sev)
        icon = {"pass": "&#10003;", "warn": "!", "fail": "&#10007;", "info": "i"}.get(sev, "?")
        pills += f'<span class="pill {cls}">{icon} {name}: {verdict}</span> '
    st.sidebar.markdown(pills, unsafe_allow_html=True)

    # Component bars
    st.sidebar.markdown(
        '<div style="font-family: JetBrains Mono; font-size: 0.6rem; text-transform: uppercase; '
        'letter-spacing: 0.12em; color: #5a5a70; margin: 16px 0 8px;">Score Components</div>',
        unsafe_allow_html=True,
    )
    max_scores = {"sizing": 25, "linkage": 20, "friction": 20, "transit": 15, "symmetry": 20}
    for comp, val in d["components"].items():
        mx = max_scores.get(comp, 20)
        pct = max(0, min(val / mx, 1.0)) * 100
        bc = "#22c55e" if pct > 75 else "#6366f1" if pct > 50 else "#f59e0b" if pct > 25 else "#ef4444"
        bar_html = (
            f'<div style="margin-bottom:6px;">'
            f'<div style="display:flex;justify-content:space-between;">'
            f'<span style="font-size:0.7rem;color:#8888a0;text-transform:capitalize;">{comp}</span>'
            f'<span style="font-size:0.7rem;font-family:JetBrains Mono;color:#f0f0f5;">{max(0,val):.0f}/{mx}</span>'
            f'</div>'
            f'<div style="background:#0f0f18;border-radius:3px;height:5px;overflow:hidden;margin-top:2px;">'
            f'<div style="background:{bc};width:{pct}%;height:100%;border-radius:3px;"></div>'
            f'</div></div>'
        )
        st.sidebar.markdown(bar_html, unsafe_allow_html=True)

    # Telemetry
    st.sidebar.markdown(
        '<div style="font-family: JetBrains Mono; font-size: 0.6rem; text-transform: uppercase; '
        'letter-spacing: 0.12em; color: #5a5a70; margin: 16px 0 8px;">Telemetry</div>',
        unsafe_allow_html=True,
    )

    if z["real"]:
        try:
            telemetry = json.loads(execute_tool("read_telemetry", {"n": 1}))
            if isinstance(telemetry, list) and telemetry:
                t = telemetry[0]
                c1, c2 = st.sidebar.columns(2)
                c1.metric("Position", f"{t.get('feedback_position_%', 0):.1f}%")
                c2.metric("Torque", f"{t.get('motor_torque_Nmm', 0):.1f} Nmm")
                c1.metric("Power", f"{t.get('power_W', 0)*1000:.0f} mW")
                c2.metric("Temp", f"{t.get('internal_temperature_deg_C', 0):.1f} C")
            else:
                _show_cached_telemetry(z)
        except Exception:
            _show_cached_telemetry(z)
    else:
        _show_cached_telemetry(z)

    # Branding
    st.sidebar.markdown(
        '<div style="text-align: center; padding: 14px 0; border-top: 1px solid #1e1e30; margin-top: 20px;">'
        '<span style="font-family: JetBrains Mono; font-size: 0.6rem; color: #2a2a40; letter-spacing: 0.12em; '
        'text-transform: uppercase;">Belimo Pulse AI v2.0</span><br>'
        '<span style="font-size: 0.55rem; color: #2a2a40;">START Hack 2026</span></div>',
        unsafe_allow_html=True,
    )


def _show_cached_telemetry(z):
    c1, c2 = st.sidebar.columns(2)
    c1.metric("Position", f"{z['position']:.1f}%")
    c2.metric("Torque", f"{z['torque']:.1f} Nmm")
    c1.metric("Power", f"{z['power']*1000:.0f} mW")
    c2.metric("Temp", f"{z['temp']:.1f} C")


# ===================================================================
#  Protocol Action Bar
# ===================================================================
def render_protocols():
    active = st.session_state.get("active_zone", 0)
    z = ZONES[active]

    st.markdown(
        '<div style="font-family: JetBrains Mono; font-size: 0.6rem; text-transform: uppercase; '
        'letter-spacing: 0.15em; color: #5a5a70; margin-bottom: 8px;">Protocols</div>',
        unsafe_allow_html=True,
    )

    cols = st.columns(5)
    live_note = " (runs on real hardware)" if z["real"] else ""

    protocols = [
        ("Install Verify", f"Run Install Verify protocol on {z['name']}.{live_note} Sweep, analyze, and give me commissioning parameters."),
        ("Commission Tune", f"Generate commissioning parameters for {z['name']}. What PI gains should the engineer set? Include position limits and slew rate."),
        ("Predict Degradation", f"Predict degradation for {z['name']}. Compare baseline to current state. When will it need maintenance?"),
        ("Cost Analysis", f"Estimate the annual cost impact of {z['name']}'s issues for a 50-actuator commercial building. Include energy waste and maintenance."),
        ("Move Actuator", f"Move the actuator on {z['name']} to 75% position, then back to 50%.") if z["real"] else
        ("Building Report", f"Give me a summary of all 8 zones in this building. Which ones need immediate attention?"),
    ]

    for i, (label, prompt) in enumerate(protocols):
        with cols[i]:
            if st.button(label, key=f"proto_{i}", use_container_width=True):
                _inject_message(prompt)


# ===================================================================
#  Chat Interface
# ===================================================================
def render_chat():
    if "messages" not in st.session_state:
        st.session_state.messages = []
    if "history" not in st.session_state:
        st.session_state.history = []

    active = st.session_state.get("active_zone", 0)
    z = ZONES[active]

    for msg in st.session_state.messages:
        avatar = "✦" if msg["role"] == "assistant" else "▸"
        with st.chat_message(msg["role"], avatar=avatar):
            if msg.get("tools"):
                tool_html = " &#8594; ".join(
                    f'<code style="font-size:0.68rem; background:rgba(99,102,241,0.08); '
                    f'color:#818cf8; padding:2px 7px; border-radius:4px;">{t}</code>'
                    for t in msg["tools"]
                )
                st.markdown(f'<div style="margin-bottom:6px; font-size:0.68rem; color:#3a3a50;">{tool_html}</div>',
                            unsafe_allow_html=True)
            st.markdown(msg["content"])
            if msg.get("chart_data"):
                _render_chart(msg["chart_data"])

    placeholder_text = f"Ask about {z['name']}..." if not z["real"] else f"Ask about {z['name']} (live hardware)..."
    if prompt := st.chat_input(placeholder_text):
        # Inject zone context for simulated actuators
        if not z["real"]:
            context = (
                f"[CONTEXT: The user is asking about zone '{z['name']}' on {z['floor']}. "
                f"This is a SIMULATED actuator (type {z['type']}). Health: {z['score']}/100 ({z['grade']}). "
                f"Sizing: {z['sizing']}, Linkage: {z['linkage']} (dead band {z['details']['dead_band']}%), "
                f"Friction: {z['friction']} (smoothness {z['details']['smoothness']}), "
                f"Hunting: {z['hunting']} (score {z['details']['hunting_score']}/100). "
                f"Issue: {z['issue']}. "
                f"Answer as if this is real data. Do NOT use MCP tools that require live hardware. "
                f"Use get_health_report or auto_commission for the real actuator data as reference, "
                f"but present findings for THIS zone with ITS specific numbers.]\n\n"
            )
            augmented = context + prompt
        else:
            augmented = prompt

        st.session_state.messages.append({"role": "user", "content": prompt})
        with st.chat_message("user", avatar="👤"):
            st.markdown(prompt)
        _run_agent(augmented)


def _run_agent(prompt: str):
    with st.chat_message("assistant", avatar="🤖"):
        tool_names = []
        status = st.status("Analyzing...", expanded=True)

        def on_tool(name, args):
            tool_names.append(name)
            args_str = ", ".join(f"{k}={v}" for k, v in args.items()) if args else ""
            status.write(f"`{name}({args_str})`")

        try:
            response, st.session_state.history = chat(
                prompt, st.session_state.history, on_tool_call=on_tool,
            )
            label = f"Done — {len(tool_names)} tool{'s' if len(tool_names) != 1 else ''}"
            status.update(label=label, state="complete", expanded=False)
            st.markdown(response)

            chart_data = _detect_chart(response)
            if chart_data:
                _render_chart(chart_data)

            st.session_state.messages.append({
                "role": "assistant", "content": response,
                "tools": tool_names, "chart_data": chart_data,
            })
        except Exception as e:
            status.update(label="Error", state="error")
            st.error(str(e))
            st.session_state.messages.append({"role": "assistant", "content": f"Error: {e}", "tools": tool_names})


def _inject_message(msg: str):
    st.session_state.messages.append({"role": "user", "content": msg})
    st.session_state._pending_message = msg
    st.rerun()


# ===================================================================
#  Charts
# ===================================================================
CHART_CFG = {
    "background": "#0f0f18",
    "title": {"color": "#f0f0f5", "font": "Inter", "fontSize": 13, "fontWeight": 600},
    "axis": {"gridColor": "#1e1e30", "domainColor": "#1e1e30", "tickColor": "#1e1e30",
             "labelColor": "#5a5a70", "titleColor": "#5a5a70", "labelFont": "JetBrains Mono",
             "titleFont": "Inter", "labelFontSize": 10},
    "view": {"stroke": "transparent"},
    "legend": {"labelColor": "#8888a0", "titleColor": "#8888a0"},
}

def _detect_chart(response: str) -> dict | None:
    r = response.lower()
    if any(k in r for k in ["torque", "friction", "sweep"]):
        try:
            report = json.loads(execute_tool("get_health_report", {}))
            if "friction" in report and "torque_std_by_bin" in report["friction"]:
                return {"type": "friction", "data": report["friction"]["torque_std_by_bin"]}
        except Exception:
            pass
    if any(k in r for k in ["hunting", "frequency", "oscillat"]):
        try:
            report = json.loads(execute_tool("get_health_report", {}))
            if report.get("hunting") and "per_config_results" in report["hunting"]:
                return {"type": "hunting", "data": report["hunting"]["per_config_results"]}
        except Exception:
            pass
    return None

def _render_chart(cd: dict):
    if not cd:
        return
    if cd["type"] == "friction":
        df = pd.DataFrame(cd["data"])
        ch = alt.Chart(df).mark_bar(cornerRadiusTopLeft=3, cornerRadiusTopRight=3).encode(
            x=alt.X("position:Q", title="Position (%)"), y=alt.Y("torque_mean:Q", title="Torque (Nmm)"),
            color=alt.Color("torque_mean:Q", scale=alt.Scale(scheme="viridis"), legend=None),
        ).configure(**CHART_CFG).properties(title="Torque Friction Map", height=240)
        st.altair_chart(ch, use_container_width=True)
    elif cd["type"] == "hunting":
        df = pd.DataFrame(cd["data"])
        if "frequency_hz" in df.columns:
            df["frequency_hz"] = df["frequency_hz"].astype(float)
            dm = pd.melt(df, id_vars=["frequency_hz"], value_vars=["avg_error_pct", "max_overshoot_pct"],
                         var_name="metric", value_name="value")
            dm["metric"] = dm["metric"].map({"avg_error_pct": "Tracking Error", "max_overshoot_pct": "Overshoot"})
            ch = alt.Chart(dm).mark_line(strokeWidth=2.5, point=alt.OverlayMarkDef(size=50)).encode(
                x=alt.X("frequency_hz:Q", title="Frequency (Hz)", scale=alt.Scale(type="log")),
                y=alt.Y("value:Q", title="%"),
                color=alt.Color("metric:N", scale=alt.Scale(range=["#ef4444", "#f59e0b"]),
                                legend=alt.Legend(title=None, orient="top")),
            ).configure(**CHART_CFG).properties(title="Hunting Frequency Response", height=240)
            st.altair_chart(ch, use_container_width=True)


# ===================================================================
#  Main
# ===================================================================
def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        st.markdown(CSS, unsafe_allow_html=True)
        st.markdown('<div style="text-align:center; padding:80px 20px;">'
                    '<div class="building-header" style="font-size:2rem;">Belimo Pulse AI</div>'
                    '<p style="color:#5a5a70; margin:20px 0;">Set API key to start</p></div>',
                    unsafe_allow_html=True)
        st.code("export ANTHROPIC_API_KEY=sk-ant-...\nstreamlit run dashboard.py", language="bash")
        st.stop()

    if "active_zone" not in st.session_state:
        st.session_state.active_zone = 0

    _load_real_zone_data()
    render_sidebar()
    render_building_overview()

    st.markdown('<div style="height: 16px;"></div>', unsafe_allow_html=True)
    render_protocols()

    st.markdown('<div style="height: 8px;"></div>', unsafe_allow_html=True)

    if "_pending_message" in st.session_state:
        msg = st.session_state.pop("_pending_message")
        active = st.session_state.get("active_zone", 0)
        z = ZONES[active]
        if not z["real"]:
            context = (
                f"[CONTEXT: Zone '{z['name']}' on {z['floor']}. Simulated {z['type']}. "
                f"Health: {z['score']}/100 ({z['grade']}). Sizing: {z['sizing']}, "
                f"Linkage: {z['linkage']} (dead band {z['details']['dead_band']}%), "
                f"Friction: {z['friction']} (smoothness {z['details']['smoothness']}), "
                f"Hunting: {z['hunting']} (score {z['details']['hunting_score']}/100). "
                f"Issue: {z['issue']}. "
                f"Answer as if real. Use reference data from tools but present for THIS zone.]\n\n"
            )
            augmented = context + msg
        else:
            augmented = msg

        with st.chat_message("user", avatar="👤"):
            st.markdown(msg)
        _run_agent(augmented)

    render_chat()


if __name__ == "__main__":
    main()
