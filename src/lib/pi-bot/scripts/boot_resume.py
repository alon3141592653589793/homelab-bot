#!/usr/bin/env python3
"""Reverse /bootpause: restore the crontab from backup and clear the skip flag.
Triggered by /bootresume. Reboot after (or /restart) to start the full lab."""
import os
import subprocess
from datetime import datetime

BOT = "/home/alon/secure-pi-bot"
FLAG = f"{BOT}/.skip_autostart"
CRON_BAK = f"{BOT}/.crontab_backup"

ts = datetime.now().strftime("%H:%M:%S")
restored = False
if os.path.exists(CRON_BAK):
    r = subprocess.run(["crontab", CRON_BAK], capture_output=True, text=True, timeout=5)
    restored = r.returncode == 0
    if restored:
        os.remove(CRON_BAK)
try:
    os.remove(FLAG)
except FileNotFoundError:
    pass

print(f"**Autostart RESUMED** [{ts}]")
if restored:
    print("Crontab restored from backup.")
else:
    print("No crontab backup found -- re-install it with /sync (or: crontab ~/secure-pi-bot/src/lib/pi-bot/crontab.txt).")
print("Skip flag cleared. Run /restart (or reboot) to start the full lab normally.")