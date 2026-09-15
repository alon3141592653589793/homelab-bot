// Source of truth = the real .py/.sh/.txt files under src/lib/pi-bot/.
// Each script's code is read from the real file at build time via the
// "pi-bot:<path>" virtual module (see piBotRaw() in vite.config.js), so the
// dashboard shows exactly what /sync deploys.
// Edit the real file under src/lib/pi-bot/, commit, push, /sync.

import mainPy from "pi-bot:main.py";
import reactivePy from "pi-bot:modules/reactive.py";
import runnerPy from "pi-bot:modules/runner.py";
import adguardPy from "pi-bot:modules/adguard.py";
import vpnPy from "pi-bot:modules/vpn.py";

import constantsPy from "pi-bot:scripts/constants.py";
import apiManagerPy from "pi-bot:scripts/api_manager.py";
import statusPy from "pi-bot:scripts/status.py";
import cooldownPy from "pi-bot:scripts/cooldown.py";
import restartPy from "pi-bot:scripts/restart.py";
import shutdownPy from "pi-bot:scripts/shutdown.py";
import systemLoggerPy from "pi-bot:scripts/system_logger.py";
import fanLoggerPy from "pi-bot:scripts/fan_logger.py";
import fanReportPy from "pi-bot:scripts/fan_report.py";
import compressLogsPy from "pi-bot:scripts/compress_logs.py";
import logSyncPy from "pi-bot:scripts/log_sync.py";
import outageDrainPy from "pi-bot:scripts/outage_drain.py";
import weeklyReportPy from "pi-bot:scripts/weekly_report.py";
import lynisReportPy from "pi-bot:scripts/lynis_report.py";
import lynisSnapshotPy from "pi-bot:scripts/lynis_snapshot.py";
import aiDebugPy from "pi-bot:scripts/ai_debug.py";
import apiFailReportPy from "pi-bot:scripts/api_fail_report.py";
import testAllPy from "pi-bot:scripts/test_all.py";
import bootDiagPy from "pi-bot:scripts/boot_diag.py";
import paramsPy from "pi-bot:scripts/params.py";
import netdiagPy from "pi-bot:scripts/netdiag.py";
import diskHealthPy from "pi-bot:scripts/disk_health.py";
import logTailPy from "pi-bot:scripts/log_tail.py";
import bootPausePy from "pi-bot:scripts/boot_pause.py";
import bootResumePy from "pi-bot:scripts/boot_resume.py";
import ledManagerPy from "pi-bot:scripts/led_manager.py";
import ledStatusPy from "pi-bot:scripts/led_status.py";
import cpuProfilePy from "pi-bot:scripts/cpu_profile.py";
import profileSchedulerPy from "pi-bot:scripts/profile_scheduler.py";
import setProfileRestrictedPy from "pi-bot:scripts/set_profile_restricted.py";
import setProfileUnlimitedPy from "pi-bot:scripts/set_profile_unlimited.py";
import profileStatusPy from "pi-bot:scripts/profile_status.py";
import updateBotStatusPy from "pi-bot:scripts/update_bot_status.py";
import gofileMirrorPy from "pi-bot:scripts/gofile_mirror.py";
import gofileKeepalivePy from "pi-bot:scripts/gofile_keepalive.py";
import wireguardSetupPy from "pi-bot:scripts/wireguard_setup.py";
import piDeployPy from "pi-bot:scripts/pi_deploy.py";
import deployInfoPy from "pi-bot:scripts/deploy_info.py";
import integrityCheckPy from "pi-bot:scripts/integrity_check.py";
import testReplyPy from "pi-bot:scripts/test_reply.py";
import netScanPy from "pi-bot:scripts/net_scan.py";
import netScanAutoPy from "pi-bot:scripts/net_scan_auto.py";

import piMaintenanceSh from "pi-bot:root/pi-maintenance.sh";
import piAuditSh from "pi-bot:root/pi-audit.sh";
import piSystemFixesSh from "pi-bot:root/pi-system-fixes.sh";
import ledCtlPy from "pi-bot:root/led_ctl.py";
import piDeployRootSh from "pi-bot:root/pi_deploy_root.sh";

import crontabTxt from "pi-bot:crontab.txt";
import deployManifestTxt from "pi-bot:deploy_manifest.txt";
import setupNotesTxt from "pi-bot:setup-notes.txt";

const scripts = [
  {
    id: "main",
    filename: "main.py",
    path: "~/secure-pi-bot/main.py",
    description: "Bot entry point. Thermal monitoring (60s), failed services alerts (60s), presence sync (240s).",
    tags: ["discord", "bot", "listener"],
    code: mainPy,
  },
  {
    id: "reactive",
    filename: "reactive.py",
    path: "~/secure-pi-bot/modules/reactive.py",
    description: "Command router. Maps Discord /commands to scripts.",
    tags: ["router", "dispatcher"],
    code: reactivePy,
  },
  {
    id: "runner",
    filename: "runner.py",
    path: "~/secure-pi-bot/modules/runner.py",
    description: "Execution helpers. run_script runs a subprocess and sends output to Discord.",
    tags: ["runner", "confirmation", "discord"],
    code: runnerPy,
  },
  {
    id: "adguard",
    filename: "adguard.py",
    path: "~/secure-pi-bot/modules/adguard.py",
    description: "Discord command router for the #adguard channel. Drives the native AdGuardHome service: status/restart/stop/start/update/logs/test/version.",
    tags: ["router", "adguard", "dns", "discord"],
    code: adguardPy,
  },
  {
    id: "vpn",
    filename: "vpn.py",
    path: "~/secure-pi-bot/modules/vpn.py",
    description: "Discord command router for the #vpn channel. Drives the wg-easy Docker container (status/peers/logs/up/down/restart/port).",
    tags: ["router", "vpn", "wireguard", "docker", "discord"],
    code: vpnPy,
  },
  {
    id: "constants",
    filename: "constants.py",
    path: "~/secure-pi-bot/scripts/constants.py",
    description: "Shared constants imported by main.py and params.py so a value (e.g. the thermal alert threshold) lives in ONE place.",
    tags: ["constants", "shared"],
    code: constantsPy,
  },
  {
    id: "api-manager",
    filename: "api_manager.py",
    path: "~/secure-pi-bot/scripts/api_manager.py",
    description: "Cross-script API coordinator: rate limiting, critical-op locks (reboot waits), outage buffering/replay, and a 7-day rolling API call log.",
    tags: ["api", "ratelimit", "outage", "shutdown", "shared"],
    code: apiManagerPy,
  },
  {
    id: "status",
    filename: "status.py",
    path: "~/secure-pi-bot/scripts/status.py",
    description: "System metrics: temp, CPU, GPU, RAM, profile, IP, uptime, current time. No voltage. 0.5s CPU interval.",
    tags: ["status", "hardware", "psutil"],
    code: statusPy,
  },
  {
    id: "cooldown",
    filename: "cooldown.py",
    path: "~/secure-pi-bot/scripts/cooldown.py",
    description: "Stops non-essential services (nginx, lightdm, bluetooth, cups) to shed heat.",
    tags: ["thermal", "services"],
    code: cooldownPy,
  },
  {
    id: "restart",
    filename: "restart.py",
    path: "~/secure-pi-bot/scripts/restart.py",
    description: "Flushes logs, waits for critical ops, reboots via systemctl (polkit, no sudo).",
    tags: ["reboot"],
    code: restartPy,
  },
  {
    id: "shutdown",
    filename: "shutdown.py",
    path: "~/secure-pi-bot/scripts/shutdown.py",
    description: "Flushes logs, waits for critical ops, powers off via systemctl (polkit, no sudo).",
    tags: ["shutdown"],
    code: shutdownPy,
  },
  {
    id: "system-logger",
    filename: "system_logger.py",
    path: "~/secure-pi-bot/scripts/system_logger.py",
    description: "10-min cron logger. Temp to RAM. Warns on 90%+ RAM and disk I/O spikes. Failed services handled by bot.",
    tags: ["logging", "temperature", "warnings"],
    code: systemLoggerPy,
  },
  {
    id: "fan-logger",
    filename: "fan_logger.py",
    path: "~/secure-pi-bot/scripts/fan_logger.py",
    description: "Logs fan ON/OFF transitions to /dev/shm (RAM). 60s boot delay. No SD writes. Caps at 2000 lines. This Pi's fan is hardwired always-on.",
    tags: ["fan", "logging", "thermal"],
    code: fanLoggerPy,
  },
  {
    id: "fan-report",
    filename: "fan_report.py",
    path: "~/secure-pi-bot/scripts/fan_report.py",
    description: "Reads fan event log (RAM + disk) and outputs a plain-text summary for Discord.",
    tags: ["fan", "report", "discord"],
    code: fanReportPy,
  },
  {
    id: "compress-logs",
    filename: "compress_logs.py",
    path: "~/secure-pi-bot/scripts/compress_logs.py",
    description: "Called before reboot. Triggers log_sync.py to flush RAM logs to Google Sheets (NO SD writes).",
    tags: ["logging", "compression", "maintenance"],
    code: compressLogsPy,
  },
  {
    id: "log-sync",
    filename: "log_sync.py",
    path: "~/secure-pi-bot/scripts/log_sync.py",
    description: "Syncs RAM logs (system_log + fan_events) to Google Sheets via a GCP service account. Delta-sync by timestamp. Falls back to SD-card JSONL when keys are missing.",
    tags: ["logging", "gsheets", "sync", "ram"],
    code: logSyncPy,
  },
  {
    id: "outage-drain",
    filename: "outage_drain.py",
    path: "~/secure-pi-bot/scripts/outage_drain.py",
    description: "Every 5 min cron. Replays the SD-card outage buffer: re-appends queued Sheets rows to any worksheet. Successful items removed; failures stay queued.",
    tags: ["outage", "gsheets", "cron"],
    code: outageDrainPy,
  },
  {
    id: "weekly-report",
    filename: "weekly_report.py",
    path: "~/secure-pi-bot/scripts/weekly_report.py",
    description: "Weekly report (Israel-time keyed, ISO-week idempotent): temp, fan. Posts to Discord + appends a row to the 'Weekly Reports' worksheet. Warns Discord if the Sheet sync fails >1 day.",
    tags: ["report", "discord", "weekly"],
    code: weeklyReportPy,
  },
  {
    id: "lynis-report",
    filename: "lynis_report.py",
    path: "~/secure-pi-bot/scripts/lynis_report.py",
    description: "Manual Lynis security audit invoked by /lynis. Surfaces warnings, suggestions, hardening index, and test count from a quick scan.",
    tags: ["audit", "security", "lynis", "discord"],
    code: lynisReportPy,
  },
  {
    id: "lynis-snapshot",
    filename: "lynis_snapshot.py",
    path: "~/secure-pi-bot/scripts/lynis_snapshot.py",
    description: "Weekly Lynis snapshot. Score-only change detection; on a change runs AI diff (web search) and appends a row to 'Lynis Snapshots'. Falls back to local SD files when keys are missing.",
    tags: ["lynis", "audit", "gsheets", "versioning", "ai", "web-search", "score"],
    code: lynisSnapshotPy,
  },
  {
    id: "ai-debug",
    filename: "ai_debug.py",
    path: "~/secure-pi-bot/scripts/ai_debug.py",
    description: "Token-efficient, context-aware Pi diagnostic assistant (Gemini). MANUAL (/aidebug), AUDIT (--audit, weekly), AUTO-ERROR (thermal/failed-service triggers), AUTO --web (lynis diff). Read-only whitelist only. API key from ~/.secrets/gemini_key.",
    tags: ["ai", "debug", "gemini", "tool-calling", "minified", "audit"],
    code: aiDebugPy,
  },
  {
    id: "api-fail-report",
    filename: "api_fail_report.py",
    path: "~/secure-pi-bot/scripts/api_fail_report.py",
    description: "/apifails report: per-provider failure counts + rate and a grand total over the last 7 days.",
    tags: ["api", "report", "discord", "rate"],
    code: apiFailReportPy,
  },
  {
    id: "test-all",
    filename: "test_all.py",
    path: "~/secure-pi-bot/scripts/test_all.py",
    description: "Full test harness invoked by /testall. Snapshots state, runs every script with PI_TEST_MODE=1 (skips cloud writes), streams results to #testing, restores state.",
    tags: ["test", "discord", "harness", "diagnostic", "stateful"],
    code: testAllPy,
  },
  {
    id: "boot-diag",
    filename: "boot_diag.py",
    path: "~/secure-pi-bot/scripts/boot_diag.py",
    description: "Remote boot/reboot forensics invoked by /boot. Prints last boot, uptime, .updates_disabled state, last upgrade, maintenance log, failed services, boot history, and boot errors.",
    tags: ["diagnostic", "boot", "reboot", "maintenance", "discord"],
    code: bootDiagPy,
  },
  {
    id: "params",
    filename: "params.py",
    path: "~/secure-pi-bot/scripts/params.py",
    description: "/parameters (aliases /params, /paramters). Lists the user-facing toggles and their CURRENT state. Read-only.",
    tags: ["status", "params", "config", "discord", "reference"],
    code: paramsPy,
  },
  {
    id: "netdiag",
    filename: "netdiag.py",
    path: "~/secure-pi-bot/scripts/netdiag.py",
    description: "Network + SSH + WiFi diagnostics for /diag: ip brief, wifi link + power_save, gateway, pings, listening ports, failed services, ssh journal.",
    tags: ["network", "diag", "ssh", "wifi"],
    code: netdiagPy,
  },
  {
    id: "disk-health",
    filename: "disk_health.py",
    path: "~/secure-pi-bot/scripts/disk_health.py",
    description: "SD-card health check for /diskhealth: df, dmesg mmc/I-O/read-only hits, root mount options (flags READ-ONLY), smartctl.",
    tags: ["disk", "sdcard", "health"],
    code: diskHealthPy,
  },
  {
    id: "log-tail",
    filename: "log_tail.py",
    path: "~/secure-pi-bot/scripts/log_tail.py",
    description: "Tail any log from Discord for /logs. Searches /dev/shm/pi-bot and ~/secure-pi-bot/logs. '/logs' alone lists available files. Path-traversal protected.",
    tags: ["logs", "tail", "discord"],
    code: logTailPy,
  },
  {
    id: "boot-pause",
    filename: "boot_pause.py",
    path: "~/secure-pi-bot/scripts/boot_pause.py",
    description: "/bootpause: back up + remove the crontab and set a .skip_autostart flag so main.py skips monitoring tasks. Bot stays up in minimal mode. Reverses with boot_resume.py.",
    tags: ["boot", "pause", "autostart", "maintenance", "safe-mode"],
    code: bootPausePy,
  },
  {
    id: "boot-resume",
    filename: "boot_resume.py",
    path: "~/secure-pi-bot/scripts/boot_resume.py",
    description: "/bootresume: restore the crontab from backup and clear the .skip_autostart flag. Reboot after to start the full lab.",
    tags: ["boot", "resume", "autostart", "maintenance"],
    code: bootResumePy,
  },
  {
    id: "led-manager",
    filename: "led_manager.py",
    path: "~/secure-pi-bot/scripts/led_manager.py",
    description: "Persistent LED scheduler (systemd root service). Priority: /leds override > SSH activity > day/night schedule. 'Sleep' = YOUR sleep (dark room), not the Pi sleeping.",
    tags: ["leds", "sleep", "ssh", "systemd", "daemon"],
    code: ledManagerPy,
  },
  {
    id: "led-status",
    filename: "led_status.py",
    path: "~/secure-pi-bot/scripts/led_status.py",
    description: "Reads the /leds override mode + actual LED brightness + SSH grace state for /leds status.",
    tags: ["leds", "status", "discord"],
    code: ledStatusPy,
  },
  {
    id: "cpu-profile",
    filename: "cpu_profile.py",
    path: "~/secure-pi-bot/scripts/cpu_profile.py",
    description: "The SINGLE sysfs writer for the CPU cpufreq files. Instant-exit when the desired freq already matches. Three intent markers, ONE writer.",
    tags: ["performance", "cpu", "writer", "shared"],
    code: cpuProfilePy,
  },
  {
    id: "profile-scheduler",
    filename: "profile_scheduler.py",
    path: "~/secure-pi-bot/scripts/profile_scheduler.py",
    description: "Every-minute cron. One call: cpu_profile.apply(desired_target()). No sysfs read/write here.",
    tags: ["performance", "scheduler", "cron"],
    code: profileSchedulerPy,
  },
  {
    id: "set-profile-restricted",
    filename: "set_profile_restricted.py",
    path: "~/secure-pi-bot/scripts/set_profile_restricted.py",
    description: "/setprofile restricted. Sets the manual override marker and applies restricted immediately via the single writer.",
    tags: ["performance", "thermal", "cpu"],
    code: setProfileRestrictedPy,
  },
  {
    id: "set-profile-unlimited",
    filename: "set_profile_unlimited.py",
    path: "~/secure-pi-bot/scripts/set_profile_unlimited.py",
    description: "/setprofile unlimited. Clears the manual override marker and applies unlimited immediately.",
    tags: ["performance", "cpu"],
    code: setProfileUnlimitedPy,
  },
  {
    id: "profile-status",
    filename: "profile_status.py",
    path: "~/secure-pi-bot/scripts/profile_status.py",
    description: "Reports active CPU profile by reading sysfs directly.",
    tags: ["performance", "status"],
    code: profileStatusPy,
  },
  {
    id: "update-bot-status",
    filename: "update_bot_status.py",
    path: "~/secure-pi-bot/scripts/update_bot_status.py",
    description: "Writes bot presence status to /dev/shm (RAM, not SD). main.py reads it every 4 min.",
    tags: ["discord", "status", "performance"],
    code: updateBotStatusPy,
  },
  {
    id: "gofile-mirror",
    filename: "gofile_mirror.py",
    path: "~/secure-pi-bot/scripts/gofile_mirror.py",
    description: "Cloud-to-cloud mirror of a HuggingFace model file -> Gofile (anti-censorship backup). Streams via /dev/shm tmpfs, sha256-verified, cross-checked against Gofile md5, then wiped. Resumable HTTP-Range download.",
    tags: ["gofile", "mirror", "huggingface", "anti-censorship", "integrity", "cloud"],
    code: gofileMirrorPy,
  },
  {
    id: "gofile-keepalive",
    filename: "gofile_keepalive.py",
    path: "~/secure-pi-bot/scripts/gofile_keepalive.py",
    description: "Keep-alive + integrity re-check for gofile-mirrored models. Streams from Gofile to /dev/null (traffic reset + re-hash) to prevent free-tier inactivity deletion and catch corruption.",
    tags: ["gofile", "keepalive", "integrity", "cron"],
    code: gofileKeepalivePy,
  },
  {
    id: "wireguard-setup",
    filename: "wireguard_setup.py",
    path: "~/secure-pi-bot/scripts/wireguard_setup.py",
    description: "One-time WireGuard VPN setup via Docker (wg-easy). Checks docker, enables IPv4 forwarding, writes wireguard/{.env,docker-compose.yml}, opens ufw, runs docker compose up.",
    tags: ["wireguard", "vpn", "docker", "setup", "install"],
    code: wireguardSetupPy,
  },
  {
    id: "pi-deploy",
    filename: "pi_deploy.py",
    path: "~/secure-pi-bot/scripts/pi_deploy.py",
    description: "Self-deploy (/sync). Pulls the repo (fetch + reset --hard), mirrors src/lib/pi-bot/{main.py,scripts,modules} into ~/secure-pi-bot runtime paths, installs root files from deploy_manifest.txt (only changed), reboots. One repo, one path.",
    tags: ["deploy", "github", "sync", "self-update", "reboot", "verify", "root"],
    code: piDeployPy,
  },
  {
    id: "test-reply",
    filename: "test_reply.py",
    path: "~/secure-pi-bot/scripts/test_reply.py",
    description: "/test -- pipeline check. Returns the literal 8 so a Discord reply confirms /sync pulled + deployed + ran the latest repo code.",
    tags: ["test", "deploy", "discord"],
    code: testReplyPy,
  },
  {
    id: "net-scan",
    filename: "net_scan.py",
    path: "~/secure-pi-bot/scripts/net_scan.py",
    description: "/nmap -- scan the whole local WiFi network (host discovery, -sn). Detects subnet from the default route, lists live hosts with IP/hostname/MAC/vendor. Uses sudo nmap for ARP; falls back to plain nmap.",
    tags: ["nmap", "network", "scan", "discord"],
    code: netScanPy,
  },
  {
    id: "net-scan-auto",
    filename: "net_scan_auto.py",
    path: "~/secure-pi-bot/scripts/net_scan_auto.py",
    description: "Auto stealthy network scan every 50h (cron hourly, self-gated). Polite -T2 host discovery. Saves every scan to logs/net_scans/. Reports NEW hosts not seen in the last 5 scans to Discord.",
    tags: ["nmap", "network", "scan", "cron", "stealth", "discord"],
    code: netScanAutoPy,
  },
  {
    id: "deploy-info",
    filename: "deploy_info.py",
    path: "~/secure-pi-bot/scripts/deploy_info.py",
    description: "/syncinfo (alias /deployinfo): when the GitHub repo was last updated (local HEAD vs remote) and when /sync last ran (from .deploy_state.json).",
    tags: ["deploy", "github", "sync", "status", "discord"],
    code: deployInfoPy,
  },
  {
    id: "integrity-check",
    filename: "integrity_check.py",
    path: "~/secure-pi-bot/scripts/integrity_check.py",
    description: "Monthly (1st of month) + /integrity. Verifies every deployed script byte-matches GitHub origin/main. Warns the alert channel on any modified/missing file; recommends /sync. State -> .integrity_state.json for /parameters.",
    tags: ["integrity", "github", "cron", "discord", "security"],
    code: integrityCheckPy,
  },
  {
    id: "maintenance",
    filename: "pi-maintenance.sh",
    path: "/usr/local/bin/pi-maintenance.sh",
    description: "Daily maintenance — flush logs, AdGuard, audit (Sun), service check. apt update+full-upgrade+autoremove + reboot only on Sun, CPU-throttled + thermal gates between steps.",
    tags: ["maintenance", "bash", "cron", "thermal", "throttled"],
    code: piMaintenanceSh,
  },
  {
    id: "pi-audit",
    filename: "pi-audit.sh",
    path: "/usr/local/bin/pi-audit.sh",
    description: "Weekly (Sunday) security audit called by pi-maintenance.sh. ClamAV + Rkhunter under nice/ionice. NO apt upgrades or reboot. Aborts if .maintenance_disabled is set.",
    tags: ["audit", "security", "bash", "maintenance"],
    code: piAuditSh,
  },
  {
    id: "system-fixes",
    filename: "pi-system-fixes.sh",
    path: "/usr/local/bin/pi-system-fixes.sh",
    description: "One-time Pi system fixes (run with sudo): repairs logrotate/ClamAV logger + enables ssh.service + AdGuardHome.service for auto-start. Idempotent.",
    tags: ["setup", "fix", "logrotate", "clamav", "services", "sudo"],
    code: piSystemFixesSh,
  },
  {
    id: "led-ctl",
    filename: "led_ctl.py",
    path: "/usr/local/bin/led_ctl",
    description: "Immediate LED control helper, run as root via sudoers (from /leds on|off|auto). Applies brightness to EVERY /sys/class/leds/* (incl. red PWR) and writes /dev/shm override (RAM -> cleared on reboot).",
    tags: ["leds", "root", "sudoers", "helper"],
    code: ledCtlPy,
  },
  {
    id: "pi-deploy-root",
    filename: "pi_deploy_root.sh",
    path: "/usr/local/bin/pi_deploy_root",
    description: "Root installer for /sync (NOPASSWD via sudoers). Copies listed files, validates sudoers fragments before copying, reloads systemd/udev, applies crontab. Backs up existing targets. Does NOT reboot.",
    tags: ["deploy", "root", "sudoers", "manifest", "bash"],
    code: piDeployRootSh,
  },
  {
    id: "deploy-manifest",
    filename: "deploy_manifest.txt",
    path: "~/secure-pi-bot/src/lib/pi-bot/deploy_manifest.txt",
    description: "List of files /sync installs OUTSIDE ~/secure-pi-bot (root-owned scripts + crontab). One '<src>\\t<target>' per line. Only files that CHANGED in the pull are reinstalled.",
    tags: ["deploy", "manifest", "config", "root", "reference"],
    code: deployManifestTxt,
  },
  {
    id: "crontab",
    filename: "crontab.txt",
    path: "~/secure-pi-bot/src/lib/pi-bot/crontab.txt",
    description: "Full crontab. Applied by /sync (deploy_manifest.txt @crontab) or: crontab <path>.",
    tags: ["cron", "reference"],
    code: crontabTxt,
  },
  {
    id: "setup",
    filename: "setup-notes.txt",
    path: null,
    description: "Setup guide (Option A): one-time Pi bootstrap, API key storage, udev/polkit/led rules, Google Sheets, Gofile, crontab, WireGuard.",
    tags: ["setup", "reference"],
    code: setupNotesTxt,
  },
];

export default scripts;