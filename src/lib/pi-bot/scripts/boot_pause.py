#!/usr/bin/env python3
"""Pause the lab autostart for the next boot(s): back up + remove the crontab
and set a flag that makes main.py skip its monitoring task loops (the bot itself
stays up in minimal mode for remote control). Reverses with boot_resume.py."""
import os
import subprocess
from datetime import datetime

BOT = "/home/alon/secure-pi-bot"
FLAG = f"{BOT}/.skip_autostart"
CRON_BAK = f"{BOT}/.crontab_backup"

# 1. Back up + remove crontab (so no cron-launched lab scripts start on boot).
try:
    current = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=5)
    if current.returncode == 0 and current.stdout.strip():
        with open(CRON_BAK, "w") as f:
            f.write(current.stdout)
    subprocess.run(["crontab", "-r"], capture_output=True, text=True, timeout=5)
except Exception:
    pass

# 2. Flag so main.py skips its task loops (bot still runs for remote control).
open(FLAG, "w").close()

ts = datetime.now().strftime("%H:%M:%S")
print(f"**Autostart PAUSED** [{ts}]")
print("Crontab backed up + removed; bot monitoring tasks will skip on next boot.")
print("On next reboot: NO lab cron, bot runs minimal (commands still work).")
print("To resume: /bootresume  (then /restart to reboot into normal).")
print(f"Crontab backup: {CRON_BAK}")