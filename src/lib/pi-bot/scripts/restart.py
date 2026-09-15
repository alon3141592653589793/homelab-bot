import subprocess, os, json
from datetime import datetime
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = "/dev/shm/pi-bot/command_log.jsonl"

print("Flushing logs...")
subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "compress_logs.py")], capture_output=True)

# Wait for any in-flight critical cloud ops (Drive/Sheets sync) before rebooting
import api_manager
api_manager.wait_critical()

# Drop a flag so main.py announces "scripts loaded" when the bot comes back.
# /dev/shm is RAM (cleared on reboot), so this must live on disk.
try:
    open("/home/alon/secure-pi-bot/.reboot_notify", "w").close()
except OSError:
    pass

# Use systemctl reboot — goes through polkit (no sudo, no password prompt)
result = subprocess.run(["systemctl", "reboot"], capture_output=True, text=True, timeout=10)
if result.returncode != 0:
    err = result.stderr.strip() or result.stdout.strip() or "unknown error"
    print(f"FAILED to reboot: {err}")
    # Log to RAM
    try:
        os.makedirs("/dev/shm/pi-bot", exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps({"ts": datetime.now().isoformat(timespec="seconds"), "cmd": "restart", "status": "failed", "error": err}) + "\n")
    except OSError:
        pass
else:
    print("Rebooting...")
    try:
        os.makedirs("/dev/shm/pi-bot", exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps({"ts": datetime.now().isoformat(timespec="seconds"), "cmd": "restart", "status": "ok"}) + "\n")
    except OSError:
        pass