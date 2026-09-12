import subprocess, os, json
from datetime import datetime
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = "/dev/shm/pi-bot/command_log.jsonl"

print("Flushing logs...")
subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "compress_logs.py")], capture_output=True)

# Wait for any in-flight critical cloud ops before power off
import api_manager
api_manager.wait_critical()

# Use systemctl poweroff — goes through polkit (no sudo, no password prompt)
result = subprocess.run(["systemctl", "poweroff"], capture_output=True, text=True, timeout=10)
if result.returncode != 0:
    err = result.stderr.strip() or result.stdout.strip() or "unknown error"
    print(f"FAILED to power off: {err}")
    try:
        os.makedirs("/dev/shm/pi-bot", exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps({"ts": datetime.now().isoformat(timespec="seconds"), "cmd": "shutdown", "status": "failed", "error": err}) + "\n")
    except OSError:
        pass
else:
    print("Powering off...")
    try:
        os.makedirs("/dev/shm/pi-bot", exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps({"ts": datetime.now().isoformat(timespec="seconds"), "cmd": "shutdown", "status": "ok"}) + "\n")
    except OSError:
        pass