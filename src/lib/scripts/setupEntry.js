const entry = {
  id: "setup",
  filename: "setup-notes.txt",
  path: null,
  description: "Setup guide: API key storage, log2ram config, crontab, permissions.",
  tags: ["setup", "reference"],
  code: `# ============================================================
# API KEY STORAGE (secure, not in .env)
# ============================================================
# The Gemini key is stored at ~/.secrets/gemini_key
# - Owned by alon, readable only by alon (chmod 600)
# - Never in .env, never in a world-readable file
# - Never logged or printed by any script

mkdir -p /home/alon/.secrets
echo 'YOUR_GEMINI_KEY_HERE' > /home/alon/.secrets/gemini_key
chmod 600 /home/alon/.secrets/gemini_key
chmod 700 /home/alon/.secrets
# Get key at: https://aistudio.google.com/app/apikey

# ============================================================
# LOG2RAM CONFIG (if already installed)
# ============================================================
# Our logs go to /dev/shm/pi-bot which is tmpfs by default.
# If you have log2ram, you can optionally map it:
# Edit /etc/log2ram.conf:
#   SIZE=40M
#   PATH_DISK=/var/log:/home/alon/secure-pi-bot/logs
# Then restart: sudo systemctl restart log2ram
# But /dev/shm is already RAM — log2ram not required for our setup.

# ============================================================
# UDEV RULE — allow alon to write cpufreq without sudo
# ============================================================
# This eliminates ALL sudo usage from profile scripts:
echo 'SUBSYSTEM=="cpu", ACTION=="add", RUN+="/bin/chmod -R a+w /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor /sys/devices/system/cpu/cpu*/cpufreq/scaling_max_freq"' | sudo tee /etc/udev/rules.d/99-cpufreq.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
# After this, set_profile_restricted.py and set_profile_unlimited.py need NO sudo at all.

# ============================================================
# POLKIT RULE — allow alon to reboot/poweroff without sudo
# ============================================================
# This lets /restart, /reboot, and /shutdown work from the Discord bot
# without sudo or any password prompt. systemctl reboot/poweroff go
# through polkit (same mechanism desktop environments use).
sudo tee /etc/polkit-1/rules.d/49-pi-bot.rules << 'POLKIT'
polkit.addRule(function(action, subject) {
    if ((action.id == "org.freedesktop.login1.reboot" ||
         action.id == "org.freedesktop.login1.power-off" ||
         action.id == "org.freedesktop.login1.reboot-multiple-sessions" ||
         action.id == "org.freedesktop.login1.power-off-multiple-sessions") &&
        subject.user == "alon") {
        return polkit.Result.YES;
    }
});
POLKIT
sudo systemctl restart polkit

# ============================================================
# DIRECTORIES + LOGGING ENABLE
# ============================================================
mkdir -p /home/alon/secure-pi-bot/logs/weekly_reports
mkdir -p /dev/shm/pi-bot
touch /home/alon/secure-pi-bot/.logging_enabled

# ============================================================
# PYTHON DEPENDENCIES
# ============================================================
pip3 install --user requests psutil python-dotenv gspread

# ============================================================
# GOOGLE SHEETS LOG SYNC (replaces SD-card log flush)
# ============================================================
# RAM logs (system_log + fan_events) are synced to a Google Sheet by
# log_sync.py every 30 min and at reboot via compress_logs.py.
# NO project logs touch the SD card anymore.
#
# 1. Google Cloud Console: enable BOTH "Google Sheets API" AND
#    "Google Drive API", create a service account, add a JSON key,
#    download it, and place at:
mkdir -p /home/alon/.secrets
#    (upload the JSON as) /home/alon/.secrets/gcp_service_account.json
chmod 600 /home/alon/.secrets/gcp_service_account.json
chmod 700 /home/alon/.secrets
#
# 2. Create a Google Sheet in Drive, share it with the service account's
#    email (Editor). Put the sheet ID (from its URL) into a file:
echo 'YOUR_SHEET_ID_HERE' > /home/alon/.secrets/gsheets_log_id.txt
chmod 600 /home/alon/.secrets/gsheets_log_id.txt
#
# 3. lynis_snapshot.py uploads weekly Lynis versions to Drive (keeping
#    the last 4) and shares each file with your email so you can read it:
echo 'your_email@gmail.com' > /home/alon/.secrets/gdrive_share_email.txt
chmod 600 /home/alon/.secrets/gdrive_share_email.txt
#
# (google-auth, used by log_sync + lynis_snapshot, is installed as a
#  dependency of gspread. If you skipped gspread, also run:
#  pip3 install --user google-auth)
#
# log_sync.py auto-creates two worksheets inside that sheet:
#   "System Log"  -> ts, temp_c, ram_pct, warnings, spikes, failed
#   "Fan Events"  -> ts, event, note
# Delta-sync by timestamp, so RAM rotation is safe:
# already-synced entries are never re-pushed.

# ============================================================
# GOOGLE API SETUP (Sheets / Drive) — how to actually get them
# ============================================================
# ONE service account key serves Google Sheets and Google Drive. No Google
# Docs API needed — all docs are saved as plain-text files on Drive.
# Until you set up the service account, log_sync + lynis_snapshot automatically
# fall back to SD-card storage. Set the keys up to move fully to cloud.
#
# Step 1 — Enable the APIs (get them here):
#   Open https://console.cloud.google.com/ -> APIs & Services -> Library
#   Search and ENABLE each one you need:
#     - "Google Sheets API"     (log_sync.py)
#     - "Google Drive API"      (lynis_snapshot.py)
#   (No Google Docs API — files saved as plain text on Drive.)
#
# Step 2 — Create a service account + download a key:
#   IAM & Admin > Service accounts > CREATE SERVICE ACCOUNT
#     (any name, no project roles required)
#   Open the new account > KEYS tab > ADD KEY > Create new key > JSON > Download
#   Copy the downloaded JSON to:
      /home/alon/.secrets/gcp_service_account.json
chmod 600 /home/alon/.secrets/gcp_service_account.json
#   The file's "client_email" field is what you must share things with below.
#
# Step 3 — Sheets (log_sync.py): connect a spreadsheet
#   - Create a spreadsheet in Google Drive.
#   - Click Share and add the service account's client_email as Editor.
#   - Grab the sheet ID from its URL: docs.google.com/spreadsheets/d/<SHEET_ID>/edit
#   - Save it:
echo 'YOUR_SHEET_ID_HERE' > /home/alon/.secrets/gsheets_log_id.txt
chmod 600 /home/alon/.secrets/gsheets_log_id.txt
#
# Step 4 — Drive (lynis_snapshot.py): where your files land
#   The script uploads into the SERVICE ACCOUNT'S own Drive (invisible to you
#   by default), then shares each file with your reading email. Put that
#   email here so the files appear in your "Shared with me":
echo 'your_email@gmail.com' > /home/alon/.secrets/gdrive_share_email.txt
chmod 600 /home/alon/.secrets/gdrive_share_email.txt
#
# Step 5 — Outage buffer (automatic SD-card fallback)
#   When Drive/Sheets are down, failed entries are queued to:
#     /home/alon/secure-pi-bot/outage/<provider>.jsonl
#   outage_drain.py (cron, every 5 min) replays them once the API is reachable.
#   No setup needed — the directory is auto-created by api_manager.py.

# ============================================================
# CRONTAB
# ============================================================
crontab - << 'EOF'
* * * * * python3 /home/alon/secure-pi-bot/scripts/profile_scheduler.py
*/10 * * * * python3 /home/alon/secure-pi-bot/scripts/system_logger.py
* * * * * python3 /home/alon/secure-pi-bot/scripts/fan_logger.py
*/30 * * * * python3 /home/alon/secure-pi-bot/scripts/log_sync.py
*/5 * * * * python3 /home/alon/secure-pi-bot/scripts/outage_drain.py
0 9 * * 1 python3 /home/alon/secure-pi-bot/scripts/weekly_report.py
0 3 * * * /usr/local/bin/pi-maintenance.sh >> /dev/shm/pi-bot/maintenance_cron.log 2>&1
0 4 * * 0 python3 /home/alon/secure-pi-bot/scripts/lynis_snapshot.py
0 5 * * 0 python3 /home/alon/secure-pi-bot/scripts/ai_debug.py --audit
EOF

crontab -l

# ============================================================
# WHAT CHANGED FROM PREVIOUS VERSION
# ============================================================
# Security:
#   - Gemini API key moved to ~/.secrets/gemini_key (chmod 600)
#   - No secrets in .env except Discord token
#   - udev rule eliminates cpufreq sudo
#   - Polkit rule replaces sudoers for reboot/shutdown (no sudo at all)
#   - Thermal alert cooldown (5 min) prevents spam flooding
#
# SD card writes:
#   - bot_status.json -> /dev/shm (RAM)
#   - rate limit file -> /dev/shm (RAM)
#   - All logging in /dev/shm, only flushed on reboot
#
# Power:
#   - profile_scheduler exits instantly if no change needed
#   - fan_logger exits instantly if /dev/shm/pi-bot missing
#   - maintenance.sh no longer calls sudo unnecessarily
#
# Performance:
#   - system_logger reads last log line via seek (no full file load)
#   - compress_logs streams line by line (no full file in memory)
#   - status.py reads sysfs directly instead of subprocess where possible

# ============================================================
# WIREGUARD VPN (Docker: wg-easy) -- one-time setup
# ============================================================
# Manually on the Pi (interactive, or with flags/env):
#   python3 ~/secure-pi-bot/scripts/wireguard_setup.py \
#       --host <public-ip-or-dyndns> --password <web-ui-pw>
# Env alternatives: WG_HOST, WG_PASSWORD, WG_DEFAULT_DNS
#
# The setup writes ~/secure-pi-bot/wireguard/{.env,docker-compose.yml},
# creates the wg-easy data dir at ~/.wg-easy, ensures net.ipv4.ip_forward,
# opens ufw 51820/udp + 51821/tcp if ufw is active, and starts the container.
# Web UI for peer add/remove/QR: http://<pi-ip>:51821
#
# Add alon to the docker group ONCE (so the bot can run docker w/o sudo),
# then log ALL the way out and back in:
#   sudo usermod -aG docker alon
#
# AdGuardHome service control (/adguard restart|stop|start|update) uses
# 'AdGuardHome -s <verb>'. If your install needs root for that, allow alon
# to run it passwordless (extend your polkit rule OR add a sudoers line):
#   echo "alon ALL=(root) NOPASSWD: /opt/AdGuardHome/AdGuardHome -s *" | \
#       sudo tee /etc/sudoers.d/pi-adguard
# ...then change those four commands in modules/adguard.py to wrap the
# binary with sudo (['sudo', AGH, '-s', '<verb>']).

# ============================================================
# NEW DISCORD CHANNELS (per-channel command routing)
# ============================================================
# Add to ~/secure-pi-bot/.env:
#   ADGUARD_CHANNEL_ID=<discord channel id of the #adguard channel>
#   VPN_CHANNEL_ID=<discord channel id of the #vpn channel>
# Leave them at 0 to keep those channels disabled. main.py now routes each
# incoming message to the matching handler: #commands -> reactive, #adguard
# -> adguard, #vpn -> vpn. Every channel pauses during /testall.
`,
};

export default entry;