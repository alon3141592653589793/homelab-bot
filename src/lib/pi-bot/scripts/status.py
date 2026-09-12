import sys
import subprocess
from datetime import datetime

try:
    import psutil
except ImportError:
    print("FAILURE: psutil missing. pip3 install psutil")
    sys.exit(1)

def sysfs(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None

def vcgencmd(arg):
    try:
        r = subprocess.run(["vcgencmd"] + arg.split(), capture_output=True, text=True, timeout=3)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None

# Temperature
raw_temp = sysfs("/sys/class/thermal/thermal_zone0/temp")
temp = f"{int(raw_temp) / 1000:.1f}C" if raw_temp else "Unknown"

# CPU — 0.5s interval
cpu_pct = psutil.cpu_percent(interval=0.5)
freq = psutil.cpu_freq()
cpu_ghz = f"{freq.current / 1000:.2f} GHz" if freq else "Unknown"

# GPU
gpu_raw = vcgencmd("measure_clock core")
gpu_mhz = f"{int(gpu_raw.split('=')[1]) // 1_000_000} MHz" if gpu_raw else "Unknown"

# RAM
vm = psutil.virtual_memory()
ram_str = f"{vm.used // (1024*1024)} MB / {vm.total // (1024*1024)} MB ({vm.percent}%)"

# RAM speed — vcgencmd can't measure SDRAM on Pi 4 (returns 0)
ram_speed = "N/A"
config_raw = vcgencmd("get_config sdram_freq")
if config_raw:
    try:
        val = int(config_raw.split("=")[1])
        if val > 0:
            ram_speed = f"{val} MHz"
    except (ValueError, IndexError):
        pass
if ram_speed == "N/A":
    model_raw = (sysfs("/proc/device-tree/model") or "").split(chr(0))[0].strip()
    if "Pi 5" in model_raw:
        ram_speed = "4267 MHz"
    elif "Pi 4" in model_raw:
        ram_speed = "3200 MHz"
    elif "Pi Zero 2" in model_raw or "Pi 3" in model_raw:
        ram_speed = "450 MHz"
    elif "Pi Zero" in model_raw:
        ram_speed = "400 MHz"

# Profile
try:
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
        max_khz = int(f.read().strip())
    profile = "Restricted" if max_khz <= 600000 else "Unlimited"
except OSError:
    profile = "Unknown"

# IP
try:
    r = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3)
    ip = r.stdout.strip().split()[0] if r.stdout.strip() else "Unknown"
except Exception:
    ip = "Unknown"

# Uptime
try:
    boot_dt = datetime.fromtimestamp(psutil.boot_time())
    d = datetime.now() - boot_dt
    uptime = f"{d.days}d {d.seconds//3600}h {(d.seconds%3600)//60}m"
except Exception:
    uptime = "Unknown"

# Current time
now_str = datetime.now().strftime("%H:%M:%S")

# Last upgrade
last_upgrade = sysfs("/home/alon/.secrets/last_upgrade.txt") or "Unknown"

print(
    f"**Pi Status** — {now_str}\n"
    f"Temp: {temp} | CPU: {cpu_pct}% {cpu_ghz}\n"
    f"GPU: {gpu_mhz} | Profile: {profile}\n"
    f"RAM: {ram_str} | RAM Speed: {ram_speed}\n"
    f"IP: {ip} | Uptime: {uptime}\n"
    f"Last Upgrade: {last_upgrade}"
)