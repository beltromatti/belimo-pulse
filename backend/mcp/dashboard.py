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
from html import escape

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
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

:root {
    --bg: #f7f2e8;
    --bg-soft: #fcf8f2;
    --panel: rgba(255, 255, 255, 0.86);
    --panel-strong: rgba(255, 253, 249, 0.94);
    --panel-warm: rgba(255, 247, 238, 0.94);
    --line: rgba(30, 44, 56, 0.10);
    --line-strong: rgba(212, 107, 44, 0.24);
    --text: #16202a;
    --muted: #61707a;
    --muted-soft: #7b867d;
    --accent: #d46b2c;
    --accent-strong: #8a3a0d;
    --accent-soft: rgba(212, 107, 44, 0.12);
    --success: #2d8c68;
    --warning: #d29227;
    --danger: #c55644;
    --info: #3f7d8f;
    --shadow-lg: 0 28px 64px rgba(57, 44, 29, 0.12);
    --shadow-md: 0 16px 36px rgba(57, 44, 29, 0.09);
}

html, body, .stApp, [data-testid="stAppViewContainer"] {
    color: var(--text) !important;
    font-family: 'Space Grotesk', sans-serif !important;
    background: transparent !important;
}

body {
    background:
        radial-gradient(circle at top left, rgba(212, 107, 44, 0.22), transparent 34%),
        radial-gradient(circle at bottom right, rgba(212, 107, 44, 0.12), transparent 32%),
        linear-gradient(135deg, #faf5ed 0%, #f3ede3 56%, #efe6d9 100%);
}

.stApp {
    background:
        radial-gradient(circle at 10% 0%, rgba(212, 107, 44, 0.14), transparent 24%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.36) 0%, rgba(255, 255, 255, 0) 28%),
        transparent !important;
}

[data-testid="stAppViewContainer"]::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    background-image:
        linear-gradient(to right, transparent 0, transparent calc(100% - 1px), rgba(22, 32, 42, 0.05) calc(100% - 1px)),
        linear-gradient(to bottom, transparent 0, transparent calc(100% - 1px), rgba(22, 32, 42, 0.05) calc(100% - 1px));
    background-size: 72px 72px;
    opacity: 0.28;
}

.block-container {
    max-width: 1540px !important;
    padding-top: 2rem !important;
    padding-bottom: 4rem !important;
}

#MainMenu, footer, header {
    visibility: hidden;
}

section[data-testid="stSidebar"] {
    min-width: 348px !important;
    max-width: 348px !important;
    transform: none !important;
    background: linear-gradient(180deg, rgba(255, 250, 244, 0.96) 0%, rgba(246, 239, 229, 0.98) 100%) !important;
    border-right: 1px solid var(--line) !important;
    box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.45);
}

section[data-testid="stSidebar"] .block-container {
    padding-top: 1.5rem !important;
}

button[data-testid="stSidebarCollapseButton"] {
    display: none !important;
}

h1, h2, h3, h4, h5, h6 {
    color: var(--text) !important;
    font-family: 'Space Grotesk', sans-serif !important;
    letter-spacing: -0.03em;
}

div[data-testid="stMarkdownContainer"] p,
div[data-testid="stMarkdownContainer"] li {
    color: var(--muted) !important;
}

.stChatMessage {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.90) 0%, rgba(255, 249, 242, 0.92) 100%) !important;
    border: 1px solid var(--line) !important;
    border-radius: 24px !important;
    box-shadow: var(--shadow-md) !important;
}

[data-testid="stBottomBlockContainer"] {
    background: linear-gradient(180deg, rgba(247, 242, 232, 0) 0%, rgba(247, 242, 232, 0.82) 24%, rgba(247, 242, 232, 0.98) 100%) !important;
    padding-top: 1rem !important;
    backdrop-filter: blur(10px);
}

[data-testid="stBottomBlockContainer"] > div {
    background: transparent !important;
}

[data-testid="stChatInput"],
[data-testid="stChatInputContainer"],
.stChatInput {
    background: transparent !important;
}

.stChatInput > div {
    background: rgba(255, 255, 255, 0.92) !important;
    border: 1px solid var(--line) !important;
    border-radius: 22px !important;
    box-shadow: var(--shadow-md) !important;
}

.stChatInput > div > div,
.stChatInput div[data-baseweb="textarea"],
.stChatInput div[data-baseweb="base-input"] {
    background: transparent !important;
    border: 0 !important;
    box-shadow: none !important;
}

.stChatInput textarea {
    background: transparent !important;
    color: var(--text) !important;
    font-family: 'Space Grotesk', sans-serif !important;
}

.stChatInput textarea::placeholder {
    color: var(--muted-soft) !important;
}

.stChatInput button {
    background: linear-gradient(135deg, #f1a24e 0%, #d46b2c 100%) !important;
    color: #fff7ef !important;
    border: 0 !important;
    border-radius: 16px !important;
    box-shadow: 0 10px 20px rgba(212, 107, 44, 0.22) !important;
}

.stChatInput button:hover {
    background: linear-gradient(135deg, #f5b067 0%, #c95d20 100%) !important;
}

[data-testid="stMetric"] {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.90) 0%, rgba(255, 248, 240, 0.95) 100%) !important;
    border: 1px solid var(--line) !important;
    border-radius: 18px !important;
    padding: 0.95rem 1rem !important;
    box-shadow: 0 12px 24px rgba(57, 44, 29, 0.08) !important;
}

[data-testid="stMetricLabel"] {
    color: var(--muted) !important;
    font-size: 0.62rem !important;
    font-family: 'IBM Plex Mono', monospace !important;
    text-transform: uppercase !important;
    letter-spacing: 0.16em !important;
}

[data-testid="stMetricValue"] {
    color: var(--text) !important;
    font-family: 'Space Grotesk', sans-serif !important;
    font-weight: 700 !important;
    letter-spacing: -0.04em !important;
}

.stButton > button {
    min-height: 2.85rem;
    background: rgba(255, 255, 255, 0.78) !important;
    color: var(--accent-strong) !important;
    border: 1px solid rgba(212, 107, 44, 0.22) !important;
    border-radius: 16px !important;
    font-family: 'Space Grotesk', sans-serif !important;
    font-size: 0.92rem !important;
    font-weight: 600 !important;
    letter-spacing: -0.01em !important;
    box-shadow: 0 12px 24px rgba(57, 44, 29, 0.08) !important;
    transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease, background 0.2s ease !important;
}

.stButton > button:hover {
    background: linear-gradient(135deg, #fff9f2 0%, #ffe9d7 100%) !important;
    border-color: rgba(212, 107, 44, 0.48) !important;
    box-shadow: 0 18px 34px rgba(57, 44, 29, 0.12) !important;
    transform: translateY(-1px);
}

.stButton > button:focus:not(:active) {
    border-color: rgba(212, 107, 44, 0.56) !important;
    box-shadow: 0 0 0 4px rgba(212, 107, 44, 0.12) !important;
}

[data-testid="stStatusWidget"] {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.88) 0%, rgba(255, 245, 235, 0.94) 100%) !important;
    border: 1px solid rgba(212, 107, 44, 0.16) !important;
    border-radius: 20px !important;
    box-shadow: var(--shadow-md) !important;
}

code {
    background: rgba(212, 107, 44, 0.09) !important;
    color: var(--accent-strong) !important;
    font-family: 'IBM Plex Mono', monospace !important;
    border-radius: 999px !important;
    padding: 0.15rem 0.5rem !important;
}

.stCaption,
[data-testid="stCaptionContainer"] {
    color: var(--muted) !important;
    font-family: 'IBM Plex Mono', monospace !important;
    font-size: 0.72rem !important;
}

.stProgress > div {
    background: rgba(22, 32, 42, 0.08) !important;
    border-radius: 999px !important;
}

.stProgress > div > div {
    background: linear-gradient(90deg, #f1a24e, #d46b2c) !important;
    border-radius: 999px !important;
}

.vega-embed {
    background: transparent !important;
}

pre {
    background: rgba(255, 255, 255, 0.84) !important;
    border: 1px solid var(--line) !important;
    border-radius: 20px !important;
}

.page-hero {
    display: grid;
    grid-template-columns: minmax(0, 1.55fr) minmax(320px, 0.95fr);
    gap: 1.25rem;
    margin-bottom: 1.4rem;
}

.hero-panel,
.focus-panel,
.section-shell,
.protocol-card,
.chat-intro,
.empty-state-card {
    position: relative;
    overflow: hidden;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.88) 0%, rgba(255, 248, 239, 0.95) 100%);
    border: 1px solid rgba(212, 107, 44, 0.14);
    border-radius: 30px;
    box-shadow: var(--shadow-lg);
}

.hero-panel::after,
.focus-panel::after,
.empty-state-card::after {
    content: "";
    position: absolute;
    right: -70px;
    bottom: -90px;
    width: 240px;
    height: 240px;
    background: radial-gradient(circle, rgba(212, 107, 44, 0.16) 0%, rgba(212, 107, 44, 0) 70%);
    border-radius: 50%;
}

.hero-panel,
.focus-panel {
    padding: 1.9rem 2rem;
}

.hero-kicker,
.section-kicker,
.sidebar-kicker,
.focus-label,
.protocol-card-label,
.zone-chip,
.sidebar-section-label {
    font-family: 'IBM Plex Mono', monospace !important;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.22em;
}

.hero-kicker,
.section-kicker,
.sidebar-kicker,
.focus-label,
.protocol-card-label,
.sidebar-section-label {
    color: var(--accent-strong) !important;
}

.hero-title {
    max-width: 12ch;
    margin-top: 0.9rem;
    color: var(--text);
    font-size: clamp(2.8rem, 4vw, 4rem);
    line-height: 0.98;
    font-weight: 700;
    letter-spacing: -0.06em;
}

.hero-copy,
.section-copy,
.protocol-card-copy,
.focus-issue,
.chat-empty-copy {
    color: var(--muted) !important;
    line-height: 1.7;
}

.hero-copy {
    max-width: 60ch;
    margin-top: 1rem;
    font-size: 1rem;
}

.hero-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.8rem;
    margin-top: 1.35rem;
}

.hero-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.72rem 0.95rem;
    background: rgba(255, 255, 255, 0.78);
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--text);
    box-shadow: 0 10px 20px rgba(57, 44, 29, 0.06);
    font-size: 0.88rem;
}

.hero-badge strong {
    color: var(--accent-strong);
    font-weight: 700;
}

.hero-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.8rem;
    margin-top: 1.7rem;
}

.hero-stat {
    padding: 1rem 1.05rem;
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(212, 107, 44, 0.12);
    border-radius: 20px;
}

.hero-stat-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--muted);
}

.hero-stat-value {
    margin-top: 0.5rem;
    color: var(--text);
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: -0.06em;
}

.focus-title,
.section-title {
    color: var(--text);
    font-weight: 700;
    letter-spacing: -0.04em;
}

.focus-title {
    margin-top: 0.9rem;
    font-size: 1.85rem;
    line-height: 1.08;
}

.focus-meta {
    margin-top: 0.45rem;
    color: var(--muted);
    font-size: 0.9rem;
}

.focus-score-row {
    display: flex;
    align-items: end;
    gap: 0.9rem;
    margin-top: 1.25rem;
}

.focus-score {
    color: var(--text);
    font-size: 4rem;
    font-weight: 700;
    letter-spacing: -0.08em;
    line-height: 0.9;
}

.focus-grade,
.zone-grade,
.sidebar-grade {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2rem;
    padding: 0.28rem 0.75rem;
    border-radius: 999px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.74rem;
    font-weight: 600;
    letter-spacing: 0.08em;
}

.focus-caption,
.sidebar-score-caption {
    margin-top: 0.45rem;
    color: var(--muted);
    font-size: 0.82rem;
}

.focus-issue {
    margin-top: 1rem;
    font-size: 0.95rem;
}

.focus-metrics,
.sidebar-mini-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.8rem;
    margin-top: 1.25rem;
}

.focus-metric,
.sidebar-mini-card {
    padding: 0.95rem 1rem;
    background: rgba(212, 107, 44, 0.06);
    border: 1px solid rgba(212, 107, 44, 0.12);
    border-radius: 18px;
}

.focus-metric-label,
.sidebar-mini-label,
.zone-footer-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--muted);
}

.focus-metric-value,
.sidebar-mini-value,
.zone-footer-value {
    margin-top: 0.42rem;
    color: var(--text);
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: -0.03em;
}

.section-shell {
    margin-bottom: 1.1rem;
    padding: 1.3rem 1.5rem;
}

.section-title {
    margin-top: 0.45rem;
    font-size: 1.55rem;
}

.section-copy {
    margin-top: 0.45rem;
    font-size: 0.94rem;
}

.zone-card {
    position: relative;
    overflow: hidden;
    min-height: 248px;
    padding: 1.15rem;
    margin-bottom: 0.5rem;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(255, 249, 242, 0.96) 100%);
    border: 1px solid var(--line);
    border-radius: 26px;
    box-shadow: 0 14px 32px rgba(57, 44, 29, 0.08);
    transition: transform 0.22s ease, box-shadow 0.22s ease, border-color 0.22s ease;
}

.zone-card:hover {
    transform: translateY(-3px);
    border-color: rgba(212, 107, 44, 0.30);
    box-shadow: 0 22px 40px rgba(57, 44, 29, 0.12);
}

.zone-card.active {
    border-color: rgba(212, 107, 44, 0.52);
    box-shadow: 0 26px 44px rgba(212, 107, 44, 0.18);
    background: linear-gradient(180deg, rgba(255, 253, 248, 0.98) 0%, rgba(255, 240, 222, 0.96) 100%);
}

.zone-card.status-pass { border-top: 4px solid var(--success); }
.zone-card.status-warn { border-top: 4px solid var(--warning); }
.zone-card.status-fail { border-top: 4px solid var(--danger); }

.zone-top {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 0.8rem;
}

.zone-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.85rem;
}

.zone-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.42rem 0.7rem;
    border-radius: 999px;
}

.zone-chip-live {
    background: rgba(45, 140, 104, 0.12);
    color: var(--success);
    border: 1px solid rgba(45, 140, 104, 0.20);
}

.zone-chip-sim {
    background: rgba(63, 125, 143, 0.10);
    color: var(--info);
    border: 1px solid rgba(63, 125, 143, 0.16);
}

.zone-status-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.45rem 0.72rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
}

.zone-status-pass {
    color: var(--success);
    background: rgba(45, 140, 104, 0.11);
    border: 1px solid rgba(45, 140, 104, 0.18);
}

.zone-status-warn {
    color: var(--warning);
    background: rgba(210, 146, 39, 0.12);
    border: 1px solid rgba(210, 146, 39, 0.18);
}

.zone-status-fail {
    color: var(--danger);
    background: rgba(197, 86, 68, 0.12);
    border: 1px solid rgba(197, 86, 68, 0.18);
}

.zone-name {
    color: var(--text);
    font-size: 1.04rem;
    font-weight: 700;
    line-height: 1.18;
}

.zone-meta {
    margin-top: 0.35rem;
    color: var(--muted);
    font-size: 0.72rem;
    font-family: 'IBM Plex Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.16em;
}

.zone-score-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-top: 1.25rem;
}

.zone-score {
    font-size: 2.45rem;
    font-weight: 700;
    letter-spacing: -0.08em;
    line-height: 0.9;
}

.zone-score-max {
    color: var(--muted);
    font-size: 0.74rem;
}

.zone-progress {
    margin-top: 1rem;
    height: 8px;
    border-radius: 999px;
    background: rgba(22, 32, 42, 0.08);
    overflow: hidden;
}

.zone-progress-fill {
    height: 100%;
    border-radius: 999px;
}

.zone-issue {
    min-height: 3.1rem;
    margin-top: 0.95rem;
    color: var(--muted);
    font-size: 0.84rem;
    line-height: 1.55;
}

.zone-footer {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
    margin-top: 1rem;
    padding-top: 0.95rem;
    border-top: 1px solid rgba(22, 32, 42, 0.08);
}

.sidebar-hero,
.sidebar-score-card,
.sidebar-section-card {
    background: rgba(255, 255, 255, 0.78);
    border: 1px solid var(--line);
    border-radius: 24px;
    box-shadow: 0 12px 28px rgba(57, 44, 29, 0.08);
}

.sidebar-hero,
.sidebar-score-card,
.sidebar-section-card {
    padding: 1.1rem 1.15rem;
}

.sidebar-title {
    margin-top: 0.7rem;
    color: var(--text);
    font-size: 1.35rem;
    font-weight: 700;
    letter-spacing: -0.04em;
}

.sidebar-meta {
    margin-top: 0.35rem;
    color: var(--muted);
    font-size: 0.78rem;
    font-family: 'IBM Plex Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.16em;
}

.sidebar-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
    margin-top: 0.95rem;
}

.sidebar-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.46rem 0.72rem;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 600;
}

.sidebar-chip-live {
    background: rgba(45, 140, 104, 0.12);
    color: var(--success);
    border: 1px solid rgba(45, 140, 104, 0.18);
}

.sidebar-chip-sim {
    background: rgba(63, 125, 143, 0.10);
    color: var(--info);
    border: 1px solid rgba(63, 125, 143, 0.16);
}

.sidebar-score-card {
    margin: 0.95rem 0;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.86) 0%, rgba(255, 245, 233, 0.96) 100%);
}

.sidebar-score-row {
    display: flex;
    align-items: end;
    gap: 0.8rem;
    margin-top: 0.8rem;
}

.sidebar-score {
    color: var(--text);
    font-size: 3.2rem;
    font-weight: 700;
    line-height: 0.9;
    letter-spacing: -0.08em;
}

.sidebar-score-issue {
    margin-top: 0.9rem;
    color: var(--muted);
    font-size: 0.88rem;
    line-height: 1.55;
}

.pill-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
    margin: 0.8rem 0 1rem;
}

.pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.52rem 0.78rem;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 600;
}

.pill-pass {
    background: rgba(45, 140, 104, 0.12);
    color: var(--success);
    border: 1px solid rgba(45, 140, 104, 0.18);
}

.pill-warn {
    background: rgba(210, 146, 39, 0.12);
    color: var(--warning);
    border: 1px solid rgba(210, 146, 39, 0.18);
}

.pill-fail {
    background: rgba(197, 86, 68, 0.12);
    color: var(--danger);
    border: 1px solid rgba(197, 86, 68, 0.18);
}

.pill-info {
    background: rgba(63, 125, 143, 0.10);
    color: var(--info);
    border: 1px solid rgba(63, 125, 143, 0.16);
}

.component-row {
    margin-bottom: 0.8rem;
}

.component-meta {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.8rem;
    margin-bottom: 0.3rem;
}

.component-name {
    color: var(--muted);
    font-size: 0.78rem;
    text-transform: capitalize;
}

.component-value {
    color: var(--text);
    font-size: 0.78rem;
    font-family: 'IBM Plex Mono', monospace;
}

.component-track {
    height: 7px;
    background: rgba(22, 32, 42, 0.08);
    border-radius: 999px;
    overflow: hidden;
}

.component-fill {
    height: 100%;
    border-radius: 999px;
}

.protocol-card {
    min-height: 190px;
    padding: 1.15rem 1.15rem 1rem;
    margin-bottom: 0.75rem;
}

.protocol-card-title {
    margin-top: 0.75rem;
    color: var(--text);
    font-size: 1.08rem;
    font-weight: 700;
    letter-spacing: -0.03em;
}

.protocol-card-copy {
    margin-top: 0.55rem;
    font-size: 0.88rem;
}

.protocol-card-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.8rem;
    margin-top: 1rem;
    color: var(--muted);
    font-size: 0.74rem;
}

.tool-tag {
    display: inline-flex;
    align-items: center;
    padding: 0.22rem 0.58rem;
    border-radius: 999px;
    background: rgba(212, 107, 44, 0.10);
    border: 1px solid rgba(212, 107, 44, 0.16);
    color: var(--accent-strong);
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.7rem;
}

.chat-intro {
    margin-top: 0.6rem;
    margin-bottom: 1rem;
    padding: 1.35rem 1.5rem;
}

.chat-empty {
    margin-bottom: 1rem;
    padding: 1.25rem 1.35rem;
    background: rgba(255, 250, 244, 0.82);
    border: 1px dashed rgba(212, 107, 44, 0.30);
    border-radius: 22px;
}

.chat-empty-title {
    color: var(--text);
    font-size: 1rem;
    font-weight: 700;
}

.chat-empty-copy {
    margin-top: 0.35rem;
    font-size: 0.9rem;
}

.sidebar-footer {
    padding: 1rem 0 0.3rem;
    margin-top: 1rem;
    border-top: 1px solid rgba(22, 32, 42, 0.08);
    text-align: center;
}

.sidebar-footer-top {
    color: var(--accent-strong);
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
}

.sidebar-footer-sub {
    margin-top: 0.35rem;
    color: var(--muted);
    font-size: 0.72rem;
}

.empty-state-card {
    max-width: 620px;
    margin: 5rem auto 1.25rem;
    padding: 2rem;
    text-align: center;
}

.empty-state-title {
    margin-top: 0.9rem;
    color: var(--text);
    font-size: 2.25rem;
    font-weight: 700;
    letter-spacing: -0.05em;
}

.empty-state-copy {
    margin-top: 0.8rem;
    color: var(--muted);
    line-height: 1.7;
}

@media (max-width: 1200px) {
    .page-hero {
        grid-template-columns: 1fr;
    }

    .hero-summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 740px) {
    .hero-summary,
    .focus-metrics,
    .sidebar-mini-grid,
    .zone-footer {
        grid-template-columns: 1fr;
    }

    .hero-panel,
    .focus-panel,
    .section-shell,
    .chat-intro,
    .empty-state-card {
        padding: 1.35rem;
        border-radius: 24px;
    }
}
</style>
"""
st.markdown(CSS, unsafe_allow_html=True)


# ===================================================================
#  Helper: get score color
# ===================================================================
def _score_color(score):
    if score is None:
        return "#7b867d"
    if score >= 80:
        return "#2d8c68"
    if score >= 60:
        return "#d46b2c"
    if score >= 40:
        return "#d29227"
    return "#c55644"

def _grade_bg(grade):
    if grade is None:
        return "rgba(97, 112, 122, 0.12)"
    return {
        "A": "rgba(45, 140, 104, 0.14)",
        "B": "rgba(212, 107, 44, 0.14)",
        "C": "rgba(210, 146, 39, 0.14)",
        "D": "rgba(197, 86, 68, 0.12)",
        "F": "rgba(197, 86, 68, 0.18)",
    }.get(grade, "rgba(212, 107, 44, 0.10)")

def _sev_pill(sev):
    return {"pass": "pill-pass", "warn": "pill-warn", "fail": "pill-fail", "info": "pill-info"}.get(sev, "pill-info")

def _status_label(status):
    return {"pass": "Healthy", "warn": "Watchlist", "fail": "Critical"}.get(status, "Monitor")

def _status_chip_class(status):
    return {"pass": "zone-status-pass", "warn": "zone-status-warn", "fail": "zone-status-fail"}.get(status, "zone-status-warn")

def _component_fill_color(pct):
    if pct >= 75:
        return "#2d8c68"
    if pct >= 55:
        return "#d46b2c"
    if pct >= 35:
        return "#d29227"
    return "#c55644"


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

    total = len(ZONES)
    healthy = sum(1 for z in ZONES if (z["score"] or 0) >= 75)
    warnings = sum(1 for z in ZONES if 40 <= (z["score"] or 0) < 75)
    critical = sum(1 for z in ZONES if (z["score"] or 0) < 40)
    avg_score = sum((z["score"] or 0) for z in ZONES) // total
    active = st.session_state.get("active_zone", 0)
    focused_zone = ZONES[active]
    focused_details = focused_zone.get("details") or {
        "dead_band": 0,
        "smoothness": 0,
        "hunting_score": 0,
    }
    focused_score = focused_zone["score"] or 0
    focus_color = _score_color(focused_zone["score"])
    focus_grade = focused_zone["grade"] or "N/A"
    focus_mode = "Live hardware" if focused_zone["real"] else "Simulated twin"
    live_count = sum(1 for z in ZONES if z["real"])

    hero_html = f"""
    <div class="page-hero">
        <div class="hero-panel">
            <div class="hero-kicker">Belimo Pulse AI</div>
            <div class="hero-title">Building diagnostics with a calmer control surface.</div>
            <div class="hero-copy">
                Track all eight zones at a glance, focus on the actuator that matters now,
                and move straight from anomaly to action without visual noise.
            </div>
            <div class="hero-badges">
                <span class="hero-badge"><strong>{total}</strong> monitored zones</span>
                <span class="hero-badge"><strong>{live_count}</strong> live actuator</span>
                <span class="hero-badge"><strong>{escape(focused_zone["name"])}</strong> in focus</span>
            </div>
            <div class="hero-summary">
                <div class="hero-stat">
                    <div class="hero-stat-label">Average score</div>
                    <div class="hero-stat-value" style="color:{_score_color(avg_score)};">{avg_score}</div>
                </div>
                <div class="hero-stat">
                    <div class="hero-stat-label">Healthy</div>
                    <div class="hero-stat-value" style="color:#2d8c68;">{healthy}</div>
                </div>
                <div class="hero-stat">
                    <div class="hero-stat-label">Watchlist</div>
                    <div class="hero-stat-value" style="color:#d29227;">{warnings}</div>
                </div>
                <div class="hero-stat">
                    <div class="hero-stat-label">Critical</div>
                    <div class="hero-stat-value" style="color:#c55644;">{critical}</div>
                </div>
            </div>
        </div>
        <div class="focus-panel">
            <div class="focus-label">Focused zone</div>
            <div class="focus-title">{escape(focused_zone["name"])}</div>
            <div class="focus-meta">{escape(focused_zone["floor"])} &middot; {escape(focused_zone["type"])} &middot; {escape(focus_mode)}</div>
            <div class="focus-score-row">
                <div class="focus-score" style="color:{focus_color};">{focused_score}</div>
                <div>
                    <span class="focus-grade" style="background:{_grade_bg(focused_zone["grade"])}; color:{focus_color};">Grade {escape(focus_grade)}</span>
                    <div class="focus-caption">{escape(_status_label(focused_zone["status"]))}</div>
                </div>
            </div>
            <div class="focus-issue">{escape(focused_zone["issue"])}</div>
            <div class="focus-metrics">
                <div class="focus-metric">
                    <div class="focus-metric-label">Position</div>
                    <div class="focus-metric-value">{focused_zone["position"]:.1f}%</div>
                </div>
                <div class="focus-metric">
                    <div class="focus-metric-label">Torque</div>
                    <div class="focus-metric-value">{focused_zone["torque"]:.1f} Nmm</div>
                </div>
                <div class="focus-metric">
                    <div class="focus-metric-label">Dead band</div>
                    <div class="focus-metric-value">{focused_details["dead_band"]:.1f}%</div>
                </div>
                <div class="focus-metric">
                    <div class="focus-metric-label">Hunting risk</div>
                    <div class="focus-metric-value">{focused_details["hunting_score"]:.0f}/100</div>
                </div>
            </div>
        </div>
    </div>
    """
    st.markdown(hero_html, unsafe_allow_html=True)

    st.markdown(
        """
        <div class="section-shell">
            <div class="section-kicker">Zone overview</div>
            <div class="section-title">Every actuator at a glance</div>
            <div class="section-copy">
                Scan the score, status, and key issue on each card, then select the zone you want to inspect in detail.
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

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
                details = z.get("details") or {"dead_band": 0}
                live_tag = (
                    '<span class="zone-chip zone-chip-live">&#9679; Live hardware</span>'
                    if z["real"]
                    else '<span class="zone-chip zone-chip-sim">Simulated twin</span>'
                )
                status_label = _status_label(z["status"])
                status_cls = _status_chip_class(z["status"])
                score_pct = max(0, min(z["score"] or 0, 100))

                card_html = (
                    f'<div class="zone-card status-{z["status"]}{active_cls}">'
                    f'<div class="zone-top">'
                    f'<div>'
                    f'<div class="zone-chip-row">{live_tag}</div>'
                    f'<div class="zone-name">{escape(z["name"])}</div>'
                    f'<div class="zone-meta">{escape(z["floor"])} &middot; {escape(z["type"])}</div>'
                    f'</div>'
                    f'<span class="zone-status-chip {status_cls}">{escape(status_label)}</span>'
                    f'</div>'
                    f'<div class="zone-score-row">'
                    f'<span class="zone-score" style="color:{sc};">{z["score"]}</span>'
                    f'<span class="zone-score-max">/100</span>'
                    f'<span class="zone-grade" style="background:{gbg};color:{sc};">{escape(z["grade"] or "N/A")}</span>'
                    f'</div>'
                    f'<div class="zone-progress"><div class="zone-progress-fill" style="width:{score_pct}%; background:{sc};"></div></div>'
                    f'<div class="zone-issue">{escape(z["issue"])}</div>'
                    f'<div class="zone-footer">'
                    f'<div><div class="zone-footer-label">Position</div><div class="zone-footer-value">{z["position"]:.1f}%</div></div>'
                    f'<div><div class="zone-footer-label">Dead band</div><div class="zone-footer-value">{details["dead_band"]:.1f}%</div></div>'
                    f'</div>'
                    f'</div>'
                )
                st.markdown(card_html, unsafe_allow_html=True)

                button_label = "Selected" if is_active else "Open Zone"
                if st.button(button_label, key=f"zone_{idx}", use_container_width=True, disabled=is_active):
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
    d = z.get("details") or {
        "sizing_sev": "info", "linkage_sev": "info", "friction_sev": "info", "hunting_sev": "info",
        "hunting_score": 0, "smoothness": 0, "dead_band": 0,
        "components": {"sizing": 0, "linkage": 0, "friction": 0, "transit": 0, "symmetry": 0},
    }

    st.sidebar.markdown(
        f"""
        <div class="sidebar-hero">
            <div class="sidebar-kicker">Selected zone</div>
            <div class="sidebar-title">{escape(z["name"])}</div>
            <div class="sidebar-meta">{escape(z["floor"])} &middot; {escape(z["type"])}</div>
            <div class="sidebar-chip-row">
                <span class="sidebar-chip {'sidebar-chip-live' if z['real'] else 'sidebar-chip-sim'}">
                    {'&#9679; Live hardware' if z['real'] else 'Simulated twin'}
                </span>
                <span class="sidebar-chip {_status_chip_class(z['status'])}">{escape(_status_label(z["status"]))}</span>
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    sc = _score_color(z["score"])
    gbg = _grade_bg(z["grade"])
    score_html = (
        f'<div class="sidebar-score-card">'
        f'<div class="sidebar-section-label">Health score</div>'
        f'<div class="sidebar-score-row">'
        f'<div class="sidebar-score" style="color:{sc};">{z["score"]}</div>'
        f'<div><span class="sidebar-grade" style="background:{gbg};color:{sc};">Grade {escape(z["grade"] or "N/A")}</span>'
        f'<div class="sidebar-score-caption">{escape(_status_label(z["status"]))}</div></div>'
        f'</div>'
        f'<div class="sidebar-score-issue">{escape(z["issue"])}</div>'
        f'</div>'
    )
    st.sidebar.markdown(score_html, unsafe_allow_html=True)

    st.sidebar.markdown(
        f"""
        <div class="sidebar-mini-grid">
            <div class="sidebar-mini-card">
                <div class="sidebar-mini-label">Smoothness</div>
                <div class="sidebar-mini-value">{d["smoothness"]:.2f}</div>
            </div>
            <div class="sidebar-mini-card">
                <div class="sidebar-mini-label">Dead band</div>
                <div class="sidebar-mini-value">{d["dead_band"]:.1f}%</div>
            </div>
            <div class="sidebar-mini-card">
                <div class="sidebar-mini-label">Hunting risk</div>
                <div class="sidebar-mini-value">{d["hunting_score"]:.0f}/100</div>
            </div>
            <div class="sidebar-mini-card">
                <div class="sidebar-mini-label">Power draw</div>
                <div class="sidebar-mini-value">{z["power"] * 1000:.0f} mW</div>
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    checks = [
        ("Sizing", z["sizing"], d["sizing_sev"]),
        ("Linkage", z["linkage"], d["linkage_sev"]),
        ("Friction", z["friction"], d["friction_sev"]),
        ("Hunting", z["hunting"], d["hunting_sev"]),
    ]
    pills = '<div class="sidebar-section-label" style="margin-top:1rem;">Diagnostics</div><div class="pill-group">'
    for name, verdict, sev in checks:
        cls = _sev_pill(sev)
        icon = {"pass": "&#10003;", "warn": "!", "fail": "&#10007;", "info": "i"}.get(sev, "?")
        pills += f'<span class="pill {cls}">{icon} {escape(name)}: {escape(str(verdict))}</span>'
    pills += "</div>"
    st.sidebar.markdown(pills, unsafe_allow_html=True)

    st.sidebar.markdown(
        '<div class="sidebar-section-label">Score components</div>',
        unsafe_allow_html=True,
    )
    max_scores = {"sizing": 25, "linkage": 20, "friction": 20, "transit": 15, "symmetry": 20}
    for comp, val in d["components"].items():
        mx = max_scores.get(comp, 20)
        pct = max(0, min(val / mx, 1.0)) * 100
        bc = _component_fill_color(pct)
        bar_html = (
            f'<div class="component-row">'
            f'<div class="component-meta">'
            f'<span class="component-name">{escape(comp)}</span>'
            f'<span class="component-value">{max(0, val):.0f}/{mx}</span>'
            f'</div>'
            f'<div class="component-track"><div class="component-fill" style="background:{bc}; width:{pct}%;"></div></div>'
            f'</div>'
        )
        st.sidebar.markdown(bar_html, unsafe_allow_html=True)

    st.sidebar.markdown(
        '<div class="sidebar-section-label" style="margin-top:1rem;">Telemetry</div>',
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

    if z["real"]:
        st.sidebar.markdown(
            '<div class="sidebar-section-label" style="margin-top:1rem;">Watchdog mode</div>',
            unsafe_allow_html=True,
        )
        if st.sidebar.button("Start Watchdog (30s)", key="watchdog_btn", use_container_width=True):
            _inject_message(
                "Start the watchdog — monitor this actuator for 30 seconds. "
                "If you detect any anomaly, immediately investigate it with a targeted sweep. "
                "Report what you find."
            )

    st.sidebar.markdown(
        '<div class="sidebar-footer">'
        '<div class="sidebar-footer-top">Belimo Pulse AI v2.0</div>'
        '<div class="sidebar-footer-sub">START Hack 2026</div>'
        '</div>',
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
        """
        <div class="section-shell">
            <div class="section-kicker">Protocol studio</div>
            <div class="section-title">One-click workflows for the selected zone</div>
            <div class="section-copy">
                Run structured investigations and actions without writing the prompt from scratch.
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    live_note = " (runs on real hardware)" if z["real"] else ""

    protocols = [
        (
            "Install Verify",
            "Commissioning",
            "Sweep the actuator, validate installation quality, and return commissioning parameters clearly split into measured and derived values.",
            f"Run Install Verify protocol on {z['name']}.{live_note} Sweep, analyze, and give me commissioning parameters. Label every value as MEASURED or DERIVED.",
        ),
        (
            "Commission Tune",
            "Envelope",
            "Map range, slew rate, and resonance boundaries so setup decisions are easier to defend.",
            f"Generate the operating envelope for {z['name']}. What are the measured limits? Include position range, slew rate, resonance frequency. Clearly separate MEASURED from DERIVED.",
        ),
        (
            "Predict Degradation",
            "Maintenance",
            "Compare current behavior to baseline and estimate when degradation will likely require service.",
            f"Predict degradation for {z['name']}. Compare baseline to current state. When will it need maintenance?",
        ),
        (
            "Cost Analysis",
            "Business impact",
            "Translate the actuator condition into annual energy waste and maintenance cost for a commercial building fleet.",
            f"Estimate the annual cost impact of {z['name']}'s issues for a 50-actuator commercial building. Include energy waste and maintenance.",
        ),
        (
            "Actuator Passport",
            "Documentation",
            "Generate a compact identity card with the actuator’s key mechanical and operational characteristics.",
            f"Generate a complete Actuator Passport for {z['name']}. I want the full identity card with all measured characteristics.",
        ),
        (
            "Move Actuator" if z["real"] else "Building Report",
            "Live action" if z["real"] else "Portfolio",
            "Execute a safe move sequence on the live actuator." if z["real"] else "Rank all eight zones by urgency and summarize the building-wide maintenance picture.",
            f"Move the actuator on {z['name']} to 75% position, then back to 50%." if z["real"]
            else "Give me a summary of all 8 zones in this building. Which ones need immediate attention?",
        ),
    ]

    for row_start in range(0, len(protocols), 3):
        cols = st.columns(3)
        for i, col in enumerate(cols):
            idx = row_start + i
            if idx >= len(protocols):
                continue
            label, category, description, prompt = protocols[idx]
            with col:
                st.markdown(
                    f"""
                    <div class="protocol-card">
                        <div class="protocol-card-label">{escape(category)}</div>
                        <div class="protocol-card-title">{escape(label)}</div>
                        <div class="protocol-card-copy">{escape(description)}</div>
                        <div class="protocol-card-footer">
                            <span>{'Live-ready' if z['real'] else 'Zone-aware'}</span>
                            <span>{escape(z["name"])}</span>
                        </div>
                    </div>
                    """,
                    unsafe_allow_html=True,
                )
                if st.button(f"Run {label}", key=f"proto_{idx}", use_container_width=True):
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

    st.markdown(
        f"""
        <div class="chat-intro">
            <div class="section-kicker">Diagnostics copilot</div>
            <div class="section-title">Ask the agent about {escape(z["name"])}</div>
            <div class="section-copy">
                Use natural language for diagnosis, maintenance recommendations, commissioning guidance,
                or live control on the real actuator.
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    if not st.session_state.messages:
        st.markdown(
            """
            <div class="chat-empty">
                <div class="chat-empty-title">Start with a direct question or use a workflow above.</div>
                <div class="chat-empty-copy">
                    Good prompts are short and specific: ask what is wrong, what should happen next,
                    or how the current zone compares to a healthy one.
                </div>
            </div>
            """,
            unsafe_allow_html=True,
        )
        suggestions = [
            ("Explain the health score", f"Explain the health score for {z['name']} in plain English."),
            ("Recommend next action", f"What should maintenance do next for {z['name']}?"),
            ("Summarize the risk", f"Summarize the operational risk for {z['name']} and how urgent it is."),
        ]
        cols = st.columns(3)
        for idx, (label, prompt) in enumerate(suggestions):
            with cols[idx]:
                if st.button(label, key=f"chat_suggestion_{idx}", use_container_width=True):
                    _inject_message(prompt)

    for msg in st.session_state.messages:
        avatar = "🤖" if msg["role"] == "assistant" else "👤"
        with st.chat_message(msg["role"], avatar=avatar):
            if msg.get("tools"):
                tool_html = " ".join(
                    f'<span class="tool-tag">{escape(t)}</span>'
                    for t in msg["tools"]
                )
                st.markdown(f'<div style="margin-bottom:0.6rem;">{tool_html}</div>', unsafe_allow_html=True)
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
        status = st.status("Analyzing zone...", expanded=True)

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
    "background": "transparent",
    "title": {"color": "#16202a", "font": "Space Grotesk", "fontSize": 14, "fontWeight": 700},
    "axis": {"gridColor": "rgba(22, 32, 42, 0.08)", "domainColor": "rgba(22, 32, 42, 0.12)", "tickColor": "rgba(22, 32, 42, 0.12)",
             "labelColor": "#61707a", "titleColor": "#61707a", "labelFont": "IBM Plex Mono",
             "titleFont": "Space Grotesk", "labelFontSize": 10},
    "view": {"stroke": "transparent"},
    "legend": {"labelColor": "#61707a", "titleColor": "#61707a"},
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
            color=alt.Color("torque_mean:Q", scale=alt.Scale(range=["#ffd2b0", "#f1a24e", "#d46b2c", "#8a3a0d"]), legend=None),
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
                color=alt.Color("metric:N", scale=alt.Scale(range=["#c55644", "#d46b2c"]),
                                legend=alt.Legend(title=None, orient="top")),
            ).configure(**CHART_CFG).properties(title="Hunting Frequency Response", height=240)
            st.altair_chart(ch, use_container_width=True)


# ===================================================================
#  Main
# ===================================================================
def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        st.markdown(
            """
            <div class="empty-state-card">
                <div class="hero-kicker">Belimo Pulse AI</div>
                <div class="empty-state-title">Set the API key to open the dashboard.</div>
                <div class="empty-state-copy">
                    The dashboard UI is ready, but the diagnostic agent needs an Anthropic API key
                    before live analysis and chat can start.
                </div>
            </div>
            """,
            unsafe_allow_html=True,
        )
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
