import os
import sys
import json
from datetime import datetime

ENABLED_FLAG = "/home/alon/secure-pi-bot/.logging_enabled"
PIBOT_DIR = "/dev/shm/pi-bot"
RAM_LOG = f"{PIBOT_DIR}/system_log.jsonl"
DISK_IO_STATE = f"{PIBOT_DIR}/.disk_io_state"
MAX_LINES = 1500

if not os.path.exists(ENABLED_FLAG):
    sys.exit(0)

os.makedirs(PIBOT_DIR, exist_ok=True)

try:
    import psutil
except ImportError:
    sys.exit(1)

ts = datetime.now().isoformat(timespec="seconds")

# Temp — direct sysfs read
try:
    with open("/sys/class/thermal/thermal_zone0/temp") as f:
        temp_c = round(int(f.read()) / 1000.0, 1)
except OSError:
    temp_c = None

# RAM — only flag at 90%+ (not logged every tick)
vm = psutil.virtual_memory()
ram_warning = vm.percent >= 90.0

# Disk I/O spike — compare with last reading (>5 MB/s avg = spike)
disk_warning = False
current_io = psutil.disk_io_counters()
if current_io:
    if os.path.exists(DISK_IO_STATE):
        try:
            with open(DISK_IO_STATE) as f:
                prev = json.load(f)
            delta = (current_io.read_bytes + current_io.write_bytes) - (prev["read_bytes"] + prev["write_bytes"])
            elapsed = (datetime.now() - datetime.fromisoformat(prev["ts"])).total_seconds()
            if elapsed > 0 and (delta / elapsed) / (1024 * 1024) > 5:
                disk_warning = True
        except Exception:
            pass
    with open(DISK_IO_STATE, "w") as f:
        json.dump({"read_bytes": current_io.read_bytes, "write_bytes": current_io.write_bytes, "ts": ts}, f)

# Build entry — temp + warnings only (no continuous RAM)
entry = {"ts": ts, "temp_c": temp_c}
if ram_warning:
    entry["ram_warning"] = True
    entry["ram_pct"] = round(vm.percent, 1)
if disk_warning:
    entry["disk_spike"] = True

# Temp spike detection — seek to end for last line
last_temp = None
if os.path.exists(RAM_LOG):
    try:
        with open(RAM_LOG, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 512))
            tail = f.read().decode(errors="ignore")
            last_line = [l for l in tail.splitlines() if l.strip()][-1] if tail.strip() else None
            if last_line:
                last_temp = json.loads(last_line).get("temp_c")
    except Exception:
        pass

if last_temp is not None and temp_c is not None and temp_c - last_temp >= 5.0:
    entry["spike"] = True

# Cap log size
try:
    with open(RAM_LOG) as f:
        lines = f.readlines()
except OSError:
    lines = []

if len(lines) >= MAX_LINES:
    lines = lines[MAX_LINES // 2:]

lines.append(json.dumps(entry) + "\n")
with open(RAM_LOG, "w") as f:
    f.writelines(lines)