import os
import subprocess
from datetime import datetime

try:
    import psutil
except ImportError:
    psutil = None

BOT = "/home/alon/secure-pi-bot"
SHM = "/dev/shm/pi-bot"

def sh(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (r.stdout or r.stderr or "").strip()
    except Exception as e:
        return f"(err: {e})"

def tail_file(path, n=12):
    if not os.path.exists(path):
        return f"(no {os.path.basename(path)} yet)"
    return sh(["bash", "-c", f"tail -n {n} '{path}'"]) or "(empty)"

out = []
now = datetime.now()
out.append(f"**/boot diagnosis** {now.strftime('%Y-%m-%d %H:%M')}  (today={now.strftime('%A')}; maintenance reboots only Sunday)")

if psutil:
    boot = datetime.fromtimestamp(psutil.boot_time())
    up = now - boot
    out.append(f"Last boot: {boot.strftime('%Y-%m-%d %H:%M:%S')}  uptime {up.days}d {up.seconds//3600}h {(up.seconds%3600)//60}m")

lock = os.path.exists(f"{BOT}/.updates_disabled")
out.append(f".updates_disabled: {'SET -> weekly reboot+updates SKIPPED (run /updates start to clear)' if lock else 'not set'}")
try:
    with open("/home/alon/.secrets/last_upgrade.txt") as f:
        out.append(f"last_upgrade: {f.read().strip()}")
except OSError:
    out.append("last_upgrade: (unknown)")

ram_path = f"{SHM}/maintenance.log"
out.append("\n[maintenance.log RAM tail]  (survives since last boot; absent => maintenance did NOT run this boot)")
if os.path.exists(ram_path):
    out.append(tail_file(ram_path, 12))
else:
    out.append("ABSENT -> maintenance did NOT run since last boot (cron dead / or /dev/shm wiped by a reboot)")
out.append("[maintenance.log DISK tail]  (persistent across reboots)")
out.append(tail_file(f"{BOT}/logs/maintenance.log", 12))

failed = sh(["bash", "-c", "systemctl list-units --state=failed --no-legend --plain | grep -v clamav | awk '{print $1}' | head -10"])
out.append(f"\nfailed services: {failed or '(none)'}")
out.append("ssh.service: " + sh(["systemctl", "is-active", "ssh.service"]))
out.append("AdGuardHome unit: " + sh(["systemctl", "is-active", "AdGuardHome"]))
out.append("AdGuardHome -s status: " + sh(["/opt/AdGuardHome/AdGuardHome", "-s", "status"], timeout=8))

out.append("\n[last -x reboot|shutdown]")
out.append(sh(["bash", "-c", "last -x reboot shutdown 2>/dev/null | head -10"]) or "(no wtmp)")
out.append("\n[previous boot errors]")
out.append(sh(["bash", "-c", "journalctl -b -1 -p err --no-pager 2>/dev/null | tail -12"]) or "(none or no previous boot)")
out.append("\n[this boot errors]")
out.append(sh(["bash", "-c", "journalctl -b 0 -p err --no-pager 2>/dev/null | tail -10"]) or "(none)")

print("\n".join(out))