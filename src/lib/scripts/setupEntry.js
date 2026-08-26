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
# LED CONTROL -- root helper + sudoers (lets /leds change lights NOW)
# ============================================================
# /leds off|on|auto run /usr/local/bin/led_ctl (root, via sudoers) so the
# lights change immediately -- incl. the red PWR LED (its default trigger is
# "default-on" and holds it lit; led_ctl flips trigger to "none" first). The
# override lives in /dev/shm (RAM) so it clears on reboot -> auto resumes.
# "off"/"sleep" = YOUR sleep (dark room), NOT the Pi sleeping.
sudo cp /home/alon/secure-pi-bot/scripts/led_ctl.py /usr/local/bin/led_ctl
sudo chmod 755 /usr/local/bin/led_ctl
echo "alon ALL=(root) NOPASSWD: /usr/local/bin/led_ctl" | sudo tee /etc/sudoers.d/pi-leds
sudo visudo -c   # syntax check -- a bad sudoers line can lock you out

# ============================================================
# LED AUTO SCHEDULE (optional root systemd daemon)
# ============================================================
# Only needed if you want lights to follow the day/night + SSH schedule by
# themselves. /leds commands work WITHOUT it (led_ctl applies instantly).
#   cat > /etc/systemd/system/pi-leds.service << 'UNIT'
#   [Unit]
#   Description=Pi LED day/night + SSH scheduler
#   After=network.target
#   [Service]
#   Type=simple
#   ExecStart=/usr/bin/python3 -u /home/alon/secure-pi-bot/scripts/led_manager.py
#   Restart=always
#   [Install]
#   WantedBy=multi-user.target
#   UNIT
#   systemctl daemon-reload && systemctl enable --now pi-leds

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
# GOOGLE SHEETS — the ONLY cloud destination for logs + reports
# ============================================================
# Everything that leaves the Pi goes to ONE Google Sheet:
#   - log_sync.py         -> "System Log" + "Fan Events" worksheets (every 30 min + at reboot)
#   - weekly_report.py    -> "Weekly Reports" worksheet (weekly Monday)
#   - lynis_snapshot.py   -> "Lynis Snapshots" worksheet (weekly Sunday, on score change)
#   - outage_drain.py     -> replays any failed row back into the right worksheet (every 5 min)
#
# Why Sheets (not Drive files)? A service account has NO storage quota,
# so it CANNOT own/upload Drive files -- it 403s with storageQuotaExceeded.
# But appending rows to a sheet YOU own (shared with the SA as Editor) is
# billed to YOUR quota, which is exactly what we want. One spreadsheet,
# four worksheets, zero Drive.
#
# Until the keys below are set up, log_sync + lynis_snapshot automatically
# fall back to SD-card storage so logging keeps working locally.

# ============================================================
# GOOGLE API + SHEET SETUP — how to actually configure it
# ============================================================
# ONE service account key serves all four scripts. Only the Google Sheets
# API is needed.
#
# Step 1 — Enable the Google Sheets API:
#   Open https://console.cloud.google.com/ -> APIs & Services -> Library
#   Search "Google Sheets API" and ENABLE it.
#   (No Google Drive API needed -- nothing uploads Drive files anymore.)
#
# Step 2 — Create a service account + download a key:
#   IAM & Admin > Service accounts > CREATE SERVICE ACCOUNT
#     (any name, no project roles required)
#   Open the new account > KEYS tab > ADD KEY > Create new key > JSON > Download
#   Copy the downloaded JSON to:
      /home/alon/.secrets/gcp_service_account.json
chmod 600 /home/alon/.secrets/gcp_service_account.json
chmod 700 /home/alon/.secrets
#   The file's "client_email" field is what you must share the sheet with below.
#
# Step 3 — Connect a spreadsheet (all four scripts write here):
#   - Create ONE spreadsheet in Google Drive.
#   - Click Share and add the service account's client_email as Editor.
#   - Grab the sheet ID from its URL: docs.google.com/spreadsheets/d/<SHEET_ID>/edit
#   - Save it:
echo 'YOUR_SHEET_ID_HERE' > /home/alon/.secrets/gsheets_log_id.txt
chmod 600 /home/alon/.secrets/gsheets_log_id.txt
#   worksheets ("System Log", "Fan Events", "Weekly Reports", "Lynis Snapshots")
#   are auto-created by the scripts on first run -- do not preset them.
#
# Step 4 — Outage buffer (automatic SD-card fallback):
#   When Sheets is down, failed rows are queued to:
#     /home/alon/secure-pi-bot/outage/gsheets.jsonl
#   outage_drain.py (cron, every 5 min) replays them once the API is reachable.
#   No setup needed -- the directory is auto-created by api_manager.py.
#
# (google-auth ships as a dependency of gspread. If you skipped gspread,
#  also run: pip3 install --user google-auth)

# ============================================================
# GOFILE MIRROR -- anti-censorship model backup (cloud-to-cloud via Pi)
# ============================================================
# gofile_mirror.py copies a HuggingFace model file to Gofile WITHOUT storing
# the model on the Pi (staging is /dev/shm tmpfs; only a tiny manifest is kept).
# It verifies the source by HF's published LFS sha256, then cross-checks the
# Gofile upload by comparing Gofile's returned md5 to the staged file's md5.
#
# gofile_keepalive.py streams each mirrored file from Gofile to /dev/null so
# (1) the download counts as traffic on your free account -> resets the
# inactivity-deletion timer, and (2) it re-hashes + re-verifies integrity.
#
# Get your Gofile API token (guest or email account) from:
#   https://gofile.io/myprofile
echo 'YOUR_GOFILE_TOKEN' > /home/alon/.secrets/gofile_token
chmod 600 /home/alon/.secrets/gofile_token
#   A guest token ties uploads to that guest account (keep it -- it's the only
#   way back in). A free email account is more durable. Premium makes program
#   download + file persistence reliable (Gofile then keeps files without
#   traffic, so the keep-alive cron becomes optional).
#
# Tiny end-to-end test (real ~17MB BERT-tiny, verified by HF sha256):
#   python3 /home/alon/secure-pi-bot/scripts/gofile_mirror.py
#   python3 /home/alon/secure-pi-bot/scripts/gofile_keepalive.py
# If the keepalive can't resolve a direct download on free tier, either go
# Premium or we add a headless-browser resolver next.

# ============================================================
# CRONTAB
# ============================================================
crontab - << 'EOF'
* * * * * python3 /home/alon/secure-pi-bot/scripts/profile_scheduler.py
*/10 * * * * python3 /home/alon/secure-pi-bot/scripts/system_logger.py
* * * * * python3 /home/alon/secure-pi-bot/scripts/fan_logger.py
*/30 * * * * python3 /home/alon/secure-pi-bot/scripts/log_sync.py
*/5 * * * * python3 /home/alon/secure-pi-bot/scripts/outage_drain.py
# Weekly Monday 09:00; script also self-gates by Israel day-of-week + ISO-week
# idempotency (don't rely on the Pi clock for the weekly boundary).
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
# Cloud storage:
#   - DROPPED Google Drive file uploads (service accounts have zero storage
#     quota -- 403 storageQuotaExceeded on every upload).
#   - ALL cloud sync now goes to one Google Sheet via gspread:
#       System Log / Fan Events / Weekly Reports / Lynis Snapshots.
#   - outage_drain.py replays only Sheets rows (Drive handle removed).
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
#   python3 ~/secure-pi-bot/scripts/wireguard_setup.py \\
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
#   echo "alon ALL=(root) NOPASSWD: /opt/AdGuardHome/AdGuardHome -s *" | \\
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