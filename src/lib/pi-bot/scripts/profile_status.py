import os

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
    f"Profile: {profile} | Governor: {governor}\n"
    f"Max: {max_khz//1000} MHz | Current: {cur_khz//1000} MHz\n"
    f"Scheduler: {sched}"
)