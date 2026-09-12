#!/bin/bash
# Master Maintenance Script — full nightly, CPU-throttled to stay cool

LOG_FILE="/dev/shm/pi-bot/maintenance.log"
DISK_LOG="/home/alon/secure-pi-bot/logs/maintenance.log"
QUEUE="/home/alon/scripts/logs/ntfy_queue.txt"
mkdir -p /home/alon/scripts/logs /home/alon/secure-pi-bot/logs /dev/shm/pi-bot

[ -f /home/alon/secure-pi-bot/.maintenance_disabled ] && {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Maintenance disabled." >> "$LOG_FILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Maintenance disabled." >> "$DISK_LOG"
    exit 0
}

# log() writes both RAM (realtime) AND disk (survives reboot -> lets /boot
# tell whether a past maintenance run skipped or issued the reboot).
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$DISK_LOG"; }

# --- Thermal gate (temp in milli-degrees) ---
TEMP_ZONE="/sys/class/thermal/thermal_zone0/temp"
COOL_BELOW=55000     # wait until under 55C between steps
MAX_WAIT_SEC=1800    # cap per-step thermal wait at 30 min

cur_temp() { cat "$TEMP_ZONE" 2>/dev/null || echo 0; }

wait_for_cool() {
    local waited=0
    while [ "$waited" -lt "$MAX_WAIT_SEC" ]; do
        local t=$(cur_temp)
        [ "$t" -eq 0 ] && return 0
        [ "$t" -lt "$COOL_BELOW" ] && return 0
        log "Thermal gate: $((t/1000))C — waiting 30s..."
        sleep 30
        waited=$((waited + 30))
    done
    log "Thermal gate: max wait reached, proceeding anyway"
}

# --- CPU throttle: cap ALL cores to 600 MHz / powersave for the whole window.
throttle_cpu() {
    touch /dev/shm/pi-bot/.maintenance_throttle
    python3 /home/alon/secure-pi-bot/scripts/cpu_profile.py throttle
    log "CPU throttled to 600 MHz / powersave (maintenance marker set)"
}

# Lowest CPU + idle-IO priority. apt told to keep old conffiles so full-upgrade
# never blocks on an interactive prompt during the automated run.
NICE="nice -n 19 ionice -c 3"
APT_OPTS="-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef -o Acquire::Retries=3"

log "--- MAINTENANCE START (full nightly, throttled) ---"
echo "--- Pi Report ($(date '+%Y-%m-%d')) ---" > "$QUEUE"

# 0. Throttle CPU + flush RAM logs
throttle_cpu
log "Flushing RAM logs..."
python3 /home/alon/secure-pi-bot/scripts/compress_logs.py >> "$LOG_FILE" 2>&1
wait_for_cool

# 1. AdGuard
log "AdGuard upgrade..."
/opt/AdGuardHome/AdGuardHome -s upgrade >> "$LOG_FILE" 2>&1
wait_for_cool

UPDATES_LOCK="/home/alon/secure-pi-bot/.updates_disabled"
UPDATES_DOW="7"   # weekly apt+reboot day (1=Mon..7=Sun)

# 2. OS Updates — full cycle, throttled (only on $UPDATES_DOW; skipped if /updates stop)
if [ -f "$UPDATES_LOCK" ] || [ "$(date +%u)" != "$UPDATES_DOW" ]; then
    log "OS Updates: SKIPPED (.updates_disabled set, or not weekly DOW $UPDATES_DOW)"
    echo "OS Updates: PAUSED (weekly DOW $UPDATES_DOW)" >> "$QUEUE"
else
    log "apt update..."
    $NICE apt-get update -y >> "$LOG_FILE" 2>&1
    wait_for_cool
    log "apt full-upgrade (throttled, auto-resolve conffiles)..."
    $NICE apt-get $APT_OPTS full-upgrade -y >> "$LOG_FILE" 2>&1
    wait_for_cool
    log "apt autoremove..."
    $NICE apt-get $APT_OPTS autoremove -y >> "$LOG_FILE" 2>&1
    echo "OS Updates: FULL (throttled, weekly DOW $UPDATES_DOW)" >> "$QUEUE"

    mkdir -p /home/alon/.secrets
    date '+%Y-%m-%d %H:%M:%S' > /home/alon/.secrets/last_upgrade.txt
    chown alon:alon /home/alon/.secrets/last_upgrade.txt
fi
wait_for_cool

# 3. Security Audit — once a week (Sunday), throttled
if [ "$(date +%u)" = "7" ]; then
    log "Security audit (weekly Sunday)..."
    $NICE /usr/local/bin/pi-audit.sh >> "$LOG_FILE" 2>&1
    echo "Audit: COMPLETED (weekly Sun)" >> "$QUEUE"
else
    log "Audit: skipped (weekly — runs Sunday)"
    echo "Audit: SKIPPED (weekly Sun)" >> "$QUEUE"
fi
wait_for_cool

# 4. Service Health
FAILED=$(systemctl list-units --state=failed --no-legend --plain | grep -v clamav | awk '{print $1}')
if [[ -n "$FAILED" ]]; then
    echo "FAILED: $FAILED" >> "$QUEUE"
    log "CRITICAL: $FAILED"
else
    echo "Services: OK" >> "$QUEUE"
fi

# 5. Sync + Notify
sync
/usr/local/bin/ntfy-queue.sh >> "$LOG_FILE" 2>&1

# 6. Reboot — only when updates ran (weekly). Resets CPU clocks; profile_scheduler restores governor within 1 min.
if [ -f "$UPDATES_LOCK" ] || [ "$(date +%u)" != "$UPDATES_DOW" ]; then
    log "Reboot: SKIPPED (no updates ran this pass)"
    echo "Reboot: SKIPPED" >> "$QUEUE"
else
    python3 -c "import sys; sys.path.insert(0,'/home/alon/secure-pi-bot/scripts'); import api_manager; api_manager.wait_critical()"
    log "Issuing scheduled maintenance reboot via systemctl reboot (polkit-authorized)."
    systemctl reboot >> "$LOG_FILE" 2>&1
fi

# Release the maintenance throttle marker so the profile scheduler restores
# the normal profile (on Sun, /dev/shm also clears on reboot — belt+braces).
rm -f /dev/shm/pi-bot/.maintenance_throttle