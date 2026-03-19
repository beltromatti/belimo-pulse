# ActuatorIQ — Quick Start Guide
# ================================
# Run this at the hackathon to collect and analyze actuator data.
#
# SETUP:
#   1. Connect to WiFi: BELIMO-X (password: raspberry)
#   2. Verify InfluxDB: http://192.168.3.14:8086 (pi/raspberry)
#   3. pip install influxdb-client pandas numpy scipy
#   4. Copy experiments.py and analysis.py into your working directory
#
# STEP 1 — RUN THE MOST IMPORTANT EXPERIMENT FIRST
#   python experiments.py --experiment sweep --test-number 100
#   (Takes ~5 min — moves actuator 0→100→0 three times)
#
# STEP 2 — RUN STEP RESPONSE
#   python experiments.py --experiment steps --test-number 200
#   (Takes ~4 min — discrete position jumps)
#
# STEP 3 — RUN HUNTING TEST
#   python experiments.py --experiment hunting --test-number 300
#   (Takes ~5 min — oscillating setpoints at different frequencies)
#
# STEP 4 — SIMULATE A FAULT (do this manually!)
#   While running:  python experiments.py --experiment sweep --test-number 400
#   Gently resist the actuator shaft with your hand at ~50% position
#   This creates a "faulty" torque profile for comparison
#
# STEP 5 — ANALYZE EVERYTHING
#   python analysis.py --all --data-dir experiment_data/
#
# STEP 6 — COMPARE HEALTHY vs FAULTY
#   python analysis.py --sweep-file experiment_data/sweep_test100.csv
#   python analysis.py --sweep-file experiment_data/sweep_test400.csv
#   (The health scores will be dramatically different!)
#
# OR — RUN EVERYTHING AT ONCE:
#   python experiments.py --experiment all --test-number 100
#   python analysis.py --all
#
# OUTPUT:
#   experiment_data/
#     sweep_test100.csv          — torque-position fingerprint
#     steps_test200.csv          — step response dynamics
#     hunting_test300.csv        — oscillation tracking data
#     sweep_test400.csv          — faulty profile (with manual resistance)
#     report.json                — complete diagnostic report
#
# IMPORTANT NOTES:
#   - Data does NOT persist on Pi reboot — save CSVs to your laptop!
#   - Use test_number to tag experiments so you can filter in InfluxDB
#   - The actuator is shared — coordinate with other teams
#   - Don't spam commands — the existing code has appropriate delays
#   - Keep setpoints between 0-100
#
# FOR THE DEMO:
#   Scene 1: Show "healthy" sweep → Health Score: 85+
#   Scene 2: Show "faulty" sweep (hand resistance) → Health Score: <50
#   Scene 3: Show hunting detection → "Reduce gain by 30%"
#   The contrast between healthy and faulty is your money shot.