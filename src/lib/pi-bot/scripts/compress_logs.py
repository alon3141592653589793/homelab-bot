import os
import subprocess

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))

# Before reboot — flush any unsynced RAM logs to Google Sheets (NO SD writes).
# Delta-sync + service-account auth live in log_sync.py.
r = subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "log_sync.py")],
                   capture_output=True, text=True, timeout=120)
out = (r.stdout or "").strip()
err = (r.stderr or "").strip()
if err:
    print(f"Log sync warning: {err}")
print(out or "Logs synced to Google Sheets.")