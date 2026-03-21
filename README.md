# Belimo Pulse

Belimo Pulse is our START Hack 2026 response to Belimo's **Smart Actuators** challenge.

## The Problem

Belimo actuators already expose valuable internal signals such as position feedback, torque, temperature, and control behavior, but these signals are often not turned into direct operational value for facility teams.

That creates real building problems:

- faults are noticed too late
- actuator issues are hard to diagnose remotely
- comfort drift is detected only after occupants feel it
- control systems react blindly instead of predicting the effect of changes

## Our Solution

Belimo Pulse turns actuator and sensor telemetry into a live, closed-loop building control platform.

It combines:

- a realistic catalog of Belimo actuators and sensors
- a physically plausible sandbox building
- a backend digital twin that reconstructs room state and diagnoses device issues
- a gateway protocol that mirrors how a real building would connect
- a facility control panel for real operator intent
- a sandbox panel for hidden disturbances, weather changes, and fault injection
- fast digital-twin simulations before applying corrective actions

## What It Does

Belimo Pulse can:

- monitor room temperature, CO2, airflow, humidity, and equipment state in real time
- detect actuator problems such as obstruction or degraded response
- simulate corrective actions on the digital twin before writing controls
- keep room targets stable even when weather, open windows, occupancy shifts, or faults disturb the system
- persist raw telemetry, derived twin data, diagnoses, and runtime history for analysis

## Stack

- Frontend: Next.js, React, TypeScript, Tailwind CSS
- Backend: Node.js, TypeScript, Express
- Data: Supabase Postgres
- Deployment: Vercel for frontend, Docker + AWS for backend

## Delivery Notes

- The main technical handoff is documented in [DELIVERY_TECHNICAL_SUMMARY.md](/Users/beltromatti/Desktop/belimo-pulse/DELIVERY_TECHNICAL_SUMMARY.md)
- The delivered demo focuses on the end-to-end building runtime, digital twin, gateway, and control loop

## Team

- Mattia Beltrami - Computer Engeenering POLIMI
- Abransh baliyan - Computer Engeenering POLIMI
- Hyeongbin Lee - Elettronic Engeenring POLIMI
- Matteo Impieri - Design POLIMI
