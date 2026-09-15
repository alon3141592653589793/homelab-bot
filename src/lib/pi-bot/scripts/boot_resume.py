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
CRON_SRC = f"{BOT}/src/lib/pi-bot/crontab.txt"
restored = False
if os.path.exists(CRON_BAK):
    r = subprocess.run(["crontab", CRON_BAK], capture_output=True, text=True, timeout=5)
    restored = r.returncode == 0
    if restored:
        os.remove(CRON_BAK)
if not restored and os.path.exists(CRON_SRC):
    # No backup -- the repo crontab.txt is the source of truth (Option A).
    r = subprocess.run(["crontab", CRON_SRC], capture_output=True, text=True, timeout=5)
    restored = r.returncode == 0
try:
    os.remove(FLAG)
except FileNotFoundError:
    pass

print(f"**Autostart RESUMED** [{ts}]")
if restored:
    print("Crontab restored (from backup, or from repo crontab.txt when no backup existed).")
else:
    print("Could not restore crontab -- re-install it with /sync (or: crontab ~/secure-pi-bot/src/lib/pi-bot/crontab.txt).")
print("Skip flag cleared. Run /restart (or reboot) to start the full lab normally.")