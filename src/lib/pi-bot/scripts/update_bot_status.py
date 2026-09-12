import os, sys, json

# Write to RAM — not SD card
STATUS_FILE = "/dev/shm/pi-bot/.bot_status.json"
STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"

try:
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
        max_khz = int(f.read().strip())
except OSError:
    sys.exit(1)

if max_khz <= 600000:
    text = "Resting | 600 MHz | Powersave"
else:
    text = "Active | 1.7 GHz | Schedutil"

if os.path.exists(STATE_FILE):
    text += " (manual)"

os.makedirs("/dev/shm/pi-bot", exist_ok=True)
with open(STATUS_FILE, "w") as f:
    json.dump({"text": text}, f)

print(f"Status: {text}")