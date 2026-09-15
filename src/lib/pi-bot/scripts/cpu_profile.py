import os
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
        # Timeout so a misconfigured sudo (e.g. a password prompt) can't hang
        # the every-minute profile scheduler cron indefinitely.
        try:
            subprocess.run(["sudo", "tee", path], input=value,
                           capture_output=True, text=True, timeout=5)
        except subprocess.TimeoutExpired:
            pass

def current_max_khz():
    try:
        with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
            return int(f.read().strip())
    except OSError:
        return None

def apply(target):
    """Single sysfs writer. Instant-exit when the desired freq is already
    current, so duplicate no-op calls cost nothing and never fight each other."""
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