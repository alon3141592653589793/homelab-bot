import os
import json
from datetime import datetime

PIBOT_DIR = "/dev/shm/pi-bot"
RAM_LOG = f"{PIBOT_DIR}/fan_events.jsonl"
STATE_FILE = f"{PIBOT_DIR}/fan_state.txt"
MAX_LINES = 2000

# Wait 60s after boot — fan behavior is erratic during early boot
try:
    with open("/proc/uptime") as f:
        uptime = float(f.read().split()[0])
    if uptime < 60:
        raise SystemExit(0)
except OSError:
    pass

# If the RAM dir doesn't exist yet the bot hasn't started — skip silently
if not os.path.isdir(PIBOT_DIR):
    raise SystemExit(0)

def get_fan_active() -> bool:
    # This Pi's fan is a 2-wire fan hardwired to 5V/GND — always on while the
    # Pi has power. Confirmed uncontrollable: pwm1 is read-only and flipping
    # pwm1_enable to manual did not stop it. The gpio-fan overlay is loaded but
    # controls nothing, so we record one continuous "on" session from boot.
    return True

now_active = get_fan_active()
now_str = datetime.now().isoformat(timespec="seconds")

# Read previous state (tiny JSON in RAM)
prev_state = None
try:
    with open(STATE_FILE) as f:
        prev_state = json.load(f).get("active")
except (OSError, json.JSONDecodeError):
    pass

# Write new state
with open(STATE_FILE, "w") as f:
    json.dump({"active": now_active, "ts": now_str}, f)

# Only append to log on state change (or first run)
if prev_state is None or prev_state != now_active:
    note = "initial" if prev_state is None else None
    event = {"ts": now_str, "event": "on" if now_active else "off"}
    if note:
        event["note"] = note

    # Cap log size to avoid unbounded RAM growth
    try:
        with open(RAM_LOG) as f:
            existing = f.readlines()
    except OSError:
        existing = []

    if len(existing) >= MAX_LINES:
        existing = existing[MAX_LINES // 2:]  # drop oldest half

    existing.append(json.dumps(event) + "\n")
    with open(RAM_LOG, "w") as f:
        f.writelines(existing)