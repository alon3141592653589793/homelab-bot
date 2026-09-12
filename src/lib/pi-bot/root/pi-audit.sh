#!/bin/bash
# Security audit — ClamAV + Rkhunter, throttled under nice/ionice.
# Called nightly by pi-maintenance.sh at 03:00 (inherits root — no sudo here).
# NO OS upgrades or reboots — pi-maintenance.sh owns those.
# Refuses to run while the maintenance_disabled lock is set.

TS() { date '+%Y-%m-%d %H:%M:%S'; }
LOCK="/home/alon/secure-pi-bot/.maintenance_disabled"
QUEUE="/home/alon/scripts/logs/ntfy_queue.txt"

[ -f "$LOCK" ] && { echo "[$(TS)] Audit: maintenance_disabled lock set — abort."; exit 0; }

NICE="nice -n 19 ionice -c 3"
FOUND=0

echo "[$(TS)] --- AUDIT START ---"

# 1. ClamAV — report infections only, drop LibClamAV warnings
CLAM=$( { $NICE clamscan -r --infected --quiet /home /var/www /tmp; } 2>&1 | grep -iv 'LibClamAV Warning' )
if [ -n "$CLAM" ]; then
  echo "[$(TS)] [!] CRITICAL: VIRUS FOUND"
  echo "$CLAM"
  echo "CRITICAL: Virus detected (ClamAV)" >> "$QUEUE"
  FOUND=1
fi

# 2. Rkhunter — refresh file property DB, then check for warnings
rkhunter --propupd >/dev/null 2>&1
RK=$(rkhunter --check --sk --no-colors 2>/dev/null | grep -i warning | grep -iv 'No warnings')
if [ -n "$RK" ]; then
  echo "[$(TS)] [!] CRITICAL: ROOTKIT WARNING"
  echo "$RK"
  echo "CRITICAL: Rootkit warning (Rkhunter)" >> "$QUEUE"
  FOUND=1
fi

[ "$FOUND" -eq 0 ] && echo "[$(TS)] Audit: clean (ClamAV + Rkhunter)"