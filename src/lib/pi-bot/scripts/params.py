import os
import json
from datetime import datetime
import constants

try:
    import psutil
except ImportError:
    psutil = None

BOT = "/home/alon/secure-pi-bot"
SHM = "/dev/shm/pi-bot"

def exists(p):
    return os.path.exists(p)

def read_file(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default

def on(flag):
    return "ON" if exists(flag) else "off"

def ena(flag):
    return "DISABLED" if exists(flag) else "enabled"

def israel_now():
    try:
        import urllib.request, json as _j
        with urllib.request.urlopen("http://worldtimeapi.org/api/timezone/Asia/Jerusalem", timeout=4) as r:
            return datetime.fromisoformat(_j.load(r)["datetime"])
    except Exception:
        return datetime.now()

L = []
L.append(f"**/parameters**  {israel_now().strftime('%Y-%m-%d %H:%M')}  (Israel time)")
L.append(f"Auto updates + weekly reboot   : {ena(f'{BOT}/.updates_disabled')}  (/updates start|stop)")
L.append(f"System logger (10-min temp/RAM) : {on(f'{BOT}/.logging_enabled')}  (/logging start|stop)")
L.append(f"Weekly Discord report (Mon 09:00): {ena(f'{BOT}/.weekly_report_disabled')}  (/weeklyreport start|stop)")
L.append(f"Nightly maintenance (03:00)     : {ena(f'{BOT}/.maintenance_disabled')}")
L.append(f"Autostart skip (next boot)      : {'PAUSED -- lab will not start' if exists(f'{BOT}/.skip_autostart') else 'normal'}  (/bootpause / /bootresume)")

# CPU profile: override marker vs scheduler + actual sysfs
ov = read_file(f"{BOT}/.profile_override").lower()
if ov == "restricted":
    prof = "RESTRICTED (manual override -> scheduler paused)"
elif ov == "unlimited":
    prof = "UNLIMITED (manual override -> scheduler paused)"
else:
    prof = "AUTO (time-window scheduler)"
if exists(f"{SHM}/.maintenance_throttle"):
    prof = "THROTTLED 600MHz (maintenance in progress)"
act = ""
try:
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
        act = f"  actual {int(f.read().strip())//1000} MHz"
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor") as f:
        act += f", gov={f.read().strip()}"
except OSError:
    pass
L.append(f"CPU profile                    : {prof}{act}  (/setprofile restricted|unlimited)")
L.append(f"Thermal alert threshold        : {constants.ALERT_THRESHOLD} C  (5-min cooldown on repeat)")
L.append(f"/testall guard                 : {'IN PROGRESS -- commands paused' if exists(f'{SHM}/.testall_running') else 'idle'}")

led_mode = read_file(f"{SHM}/led_override", "auto")
L.append(f"LED mode                       : {led_mode}  (/leds on|off|auto)")

from dotenv import load_dotenv
load_dotenv(f"{BOT}/.env")
def cid(name):
    try:
        v = int(os.getenv(name, "0"))
    except ValueError:
        v = 0
    return v
adg = cid("ADGUARD_CHANNEL_ID")
vpn = cid("VPN_CHANNEL_ID")
L.append(f"#adguard channel               : {'enabled (/adguard ...)' if adg else 'DISABLED (set ADGUARD_CHANNEL_ID in .env)'}")
L.append(f"#vpn channel                   : {'enabled (/vpn ...)' if vpn else 'DISABLED (set VPN_CHANNEL_ID in .env)'}")

L.append(f"Last apt upgrade               : {read_file('/home/alon/.secrets/last_upgrade.txt', '(unknown)')}")

try:
    with open(f"{BOT}/.deploy_state.json") as f:
        ds = json.load(f)
    L.append(f"Last /sync                     : {ds.get('last_run', '?')}  apply={ds.get('last_apply', '?')} ok={ds.get('last_apply_ok', '?')}")
except (OSError, ValueError):
    L.append("Last /sync                     : (never)")

try:
    with open(f"{BOT}/.net_scan_state.json") as f:
        ns = json.load(f)
    L.append(f"Net-scan auto (50h)            : last {ns.get('last_run', '(never)')} | {len(ns.get('scans', []))} scans kept")
except (OSError, ValueError):
    L.append("Net-scan auto (50h)            : (no scans yet)")

try:
    with open(f"{SHM}/.integrity_state.json") as f:
        ic = json.load(f)
    bad = len(ic.get("divergent", [])) + len(ic.get("missing", []))
    L.append(f"Script integrity (monthly)    : {ic.get('result', '?')}  last {ic.get('last_run', '?')}  checked={ic.get('checked', '?')}  divergent={bad}  (/integrity)")
except (OSError, ValueError):
    L.append("Script integrity (monthly)    : (never run)  (/integrity)")

if psutil:
    boot = datetime.fromtimestamp(psutil.boot_time())
    up = datetime.now() - boot
    L.append(f"Uptime                         : {up.days}d {up.seconds//3600}h {(up.seconds%3600)//60}m  (booted {boot.strftime('%m-%d %H:%M')})")

print("\n".join(L))