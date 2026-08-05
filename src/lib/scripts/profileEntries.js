const entries = [
  {
    id: "cpu-profile",
    filename: "cpu_profile.py",
    path: "~/secure-pi-bot/scripts/cpu_profile.py",
    description: "The SINGLE sysfs writer for the CPU cpufreq files. apply(target) sets governor+max_freq for all 4 cores with an instant-exit when the desired freq already matches — so the every-minute scheduler tick and the on-demand /setprofile + maintenance calls are no-op duplicates when nothing changes, and can never fight each other. desired_target() resolves precedence: maintenance_throttle marker > manual .profile_override > time window. Three intent markers, ONE writer: no more three-way sysfs coordination drift between scheduler, /setprofile, and maintenance.",
    tags: ["performance", "cpu", "writer", "shared"],
    code: `import os
import sys
import subprocess
from datetime import datetime

SHM = "/dev/shm/pi-bot"
MAINT_MARKER = f"{SHM}/.maintenance_throttle"
OVERRIDE_MARKER = "/home/alon/secure-pi-bot/.profile_override"
CORES = range(4)

TARGETS = {
    "throttle": ("powersave", 600000),
    "restricted": ("powersave", 600000),
    "unlimited": ("schedutil", 1700000),
}

def write_sysfs(path, value):
    try:
        with open(path, "w") as f:
            f.write(value)
    except PermissionError:
        subprocess.run(["sudo", "tee", path], input=value,
                       capture_output=True, text=True)

def current_max_khz():
    try:
        with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
            return int(f.read().strip())
    except OSError:
        return None

def apply(target):
    """Single sysfs writer. Instant-exit when the desired freq is already
    current, so duplicate no-op calls (scheduler tick + manual + maintenance)
    cost nothing and never fight each other."""
    if target not in TARGETS:
        target = desired_target()
    gov, freq = TARGETS[target]
    if current_max_khz() == freq:
        return
    for c in CORES:
        base = f"/sys/devices/system/cpu/cpu{c}/cpufreq"
        write_sysfs(f"{base}/scaling_governor", gov)
        write_sysfs(f"{base}/scaling_max_freq", str(freq))

def desired_target():
    """Precedence: maintenance_throttle > manual_override > time_window."""
    if os.path.exists(MAINT_MARKER):
        return "throttle"
    if os.path.exists(OVERRIDE_MARKER):
        try:
            with open(OVERRIDE_MARKER) as f:
                t = f.read().strip()
            if t in TARGETS:
                return t
        except OSError:
            pass
    h = datetime.now().hour
    return "restricted" if (h >= 23 or h < 7) else "unlimited"

if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    apply(arg if arg in TARGETS else desired_target())
`,
  },
  {
    id: "profile-scheduler",
    filename: "profile_scheduler.py",
    path: "~/secure-pi-bot/scripts/profile_scheduler.py",
    description: "Every-minute cron. One call: cpu_profile.apply(desired_target()). No sysfs read/write here — the marker+clock reconciliation and the instant-exit live only in cpu_profile. Eliminates the old three-way coordination between this scheduler, the /setprofile scripts, and the maintenance throttle.",
    tags: ["performance", "scheduler", "cron"],
    code: `import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cpu_profile

# Reconcile markers + clock, apply the winning target. Instant-exit if the
# current sysfs already matches. Owner of all sysfs writes: cpu_profile.apply.
cpu_profile.apply(cpu_profile.desired_target())
`,
  },
  {
    id: "set-profile-restricted",
    filename: "set_profile_restricted.py",
    path: "~/secure-pi-bot/scripts/set_profile_restricted.py",
    description: "/setprofile restricted. Sets the manual override marker (pins restricted until cleared) and applies it immediately via the single writer cpu_profile. The marker makes the scheduler HONOR the pin between ticks; the direct apply gives immediate effect without waiting for the next cron tick.",
    tags: ["performance", "thermal", "cpu"],
    code: `import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cpu_profile

MARKER = "/home/alon/secure-pi-bot/.profile_override"
with open(MARKER, "w") as f:
    f.write("restricted")
cpu_profile.apply("restricted")
print("Profile: RESTRICTED | Governor: powersave | Max: 600 MHz (manual override)")
`,
  },
  {
    id: "set-profile-unlimited",
    filename: "set_profile_unlimited.py",
    path: "~/secure-pi-bot/scripts/set_profile_unlimited.py",
    description: "/setprofile unlimited. Clears the manual override marker (scheduler resumes by time window) and applies unlimited immediately via the single writer cpu_profile. Same behavior as before: 'unlimited' = go unlimited now AND let the scheduler manage going forward.",
    tags: ["performance", "cpu"],
    code: `import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cpu_profile

MARKER = "/home/alon/secure-pi-bot/.profile_override"
try:
    os.remove(MARKER)
except FileNotFoundError:
    pass
cpu_profile.apply("unlimited")
print("Profile: UNLIMITED | Governor: schedutil | Max: 1700 MHz (auto-scheduler resumed)")
`,
  },
  {
    id: "profile-status",
    filename: "profile_status.py",
    path: "~/secure-pi-bot/scripts/profile_status.py",
    description: "Reports active CPU profile by reading sysfs directly.",
    tags: ["performance", "status"],
    code: `import os

STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"

def sysfs(path, default="unknown"):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default

governor = sysfs("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
max_khz = int(sysfs("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq", "0"))
cur_khz = int(sysfs("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "0"))

profile = "RESTRICTED" if max_khz <= 600000 else "UNLIMITED"
sched = "Manual override (scheduler paused)" if os.path.exists(STATE_FILE) else "Auto-scheduler active"

print(
    f"Profile: {profile} | Governor: {governor}\\n"
    f"Max: {max_khz//1000} MHz | Current: {cur_khz//1000} MHz\\n"
    f"Scheduler: {sched}"
)
`,
  },
  {
    id: "update-bot-status",
    filename: "update_bot_status.py",
    path: "~/secure-pi-bot/scripts/update_bot_status.py",
    description: "Writes bot presence status to /dev/shm (RAM, not SD). main.py reads it every 4 min.",
    tags: ["discord", "status", "performance"],
    code: `import os, sys, json

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
`,
  },
];

export default entries;