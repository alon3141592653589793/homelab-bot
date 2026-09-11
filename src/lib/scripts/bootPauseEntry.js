const bootPause = {
  id: "boot-pause",
  filename: "boot_pause.py",
  path: "~/secure-pi-bot/scripts/boot_pause.py",
  description: "Temporarily pause the lab autostart for the next boot(s). Backs up the current crontab then removes it (so no cron-launched lab scripts -- loggers, fan, sync, maintenance, profile-scheduler -- start on boot), and sets a .skip_autostart flag that makes main.py skip its monitoring task loops. The bot still runs in minimal mode so you keep remote control (/bootresume, /diag, /restart). Use for a clean Pi during manual maintenance without uninstalling anything. Triggered by /bootpause.",
  tags: ["boot", "pause", "autostart", "maintenance", "safe-mode"],
  code: `#!/usr/bin/env python3
"""
Pause the lab autostart for the next boot(s): back up + remove the crontab and
set a flag that makes main.py skip its monitoring task loops (the bot itself
stays up in minimal mode for remote control). Reverses with boot_resume.py.

Triggered by the Discord /bootpause command. Use when you want a clean Pi (no
cron loggers/fan/maintenance/profile-scheduler, no bot monitoring tasks) for
manual maintenance, without uninstalling anything.
"""
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
`,
};

const bootResume = {
  id: "boot-resume",
  filename: "boot_resume.py",
  path: "~/secure-pi-bot/scripts/boot_resume.py",
  description: "Reverse /bootpause: restore the crontab from the backup and clear the .skip_autostart flag. Triggered by /bootresume; reboot after (or /restart) to start the full lab normally. If the backup is missing it tells you to re-install via /sync instead.",
  tags: ["boot", "resume", "autostart", "maintenance"],
  code: `#!/usr/bin/env python3
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
    print("No crontab backup found -- re-install it with /sync (or: crontab ~/secure-pi-bot/scripts/../crontab.txt).")
print("Skip flag cleared. Run /restart (or reboot) to start the full lab normally.")
`,
};

const bootPauseEntries = [bootPause, bootResume];
export default bootPauseEntries;