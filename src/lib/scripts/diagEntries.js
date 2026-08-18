const netdiag = {
  id: "netdiag",
  filename: "netdiag.py",
  path: "~/secure-pi-bot/scripts/netdiag.py",
  description: "Network + SSH + WiFi diagnostics for the /diag command. Dumps ip brief, wifi link + power_save state, gateway, gateway+internet pings, listening tcp ports, failed services, and the last ssh journal lines -- the exact signals needed to diagnose why SSH stopped accepting connections (WiFi power_save, sshd, logind) from Discord when SSH itself is dead.",
  tags: ["network", "diag", "ssh", "wifi"],
  code: `import subprocess
from datetime import datetime

def run(cmd, timeout=6):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        out = (r.stdout or r.stderr or "").strip()
        return out if out else "(empty)"
    except subprocess.TimeoutExpired:
        return "(timeout)"
    except FileNotFoundError:
        return "(not installed)"
    except Exception as e:
        return f"(error: {e})"

def default_gw():
    try:
        r = subprocess.run(["ip", "route"], capture_output=True, text=True, timeout=3)
        for line in r.stdout.splitlines():
            if line.startswith("default"):
                return line.split()[2]
    except Exception:
        pass
    return None

ts = datetime.now().strftime("%H:%M:%S")
gw = default_gw()
parts = [
    f"**Net Diag** [{ts}]",
    f"ip: {run(['ip','-br','a'])}",
    f"wifi: {run(['iw','dev','wlan0','link'])}",
    f"power_save: {run(['iw','dev','wlan0','get','power_save'])}",
    f"gateway: {gw or '(none)'}",
]
if gw:
    parts.append(f"ping gw: {run(['ping','-c','1','-W','2',gw])}")
parts += [
    f"ping 1.1.1.1: {run(['ping','-c','1','-W','2','1.1.1.1'])}",
    f"listen tcp: {run(['ss','-tln'])}",
    f"failed svc: {run(['systemctl','list-units','--state=failed','--no-legend','--plain'])}",
    f"ssh log: {run(['journalctl','-u','ssh','-n','12','--no-pager'])}",
]
out = "\\n".join(parts)
print(out[:1900] + ("..." if len(out) > 1900 else ""))
`,
};

const diskHealth = {
  id: "disk-health",
  filename: "disk_health.py",
  path: "~/secure-pi-bot/scripts/disk_health.py",
  description: "SD-card health check for the /diskhealth command. Reports df, dmesg mmc/I-O/read-only/remount hits, root mount options (flags READ-ONLY if the card flipped ro), and smartctl if available. Catches the #2 silent killer -- SD card going read-only or throwing I/O errors -- before it takes the Pi down.",
  tags: ["disk", "sdcard", "health"],
  code: `import os
import re
import subprocess
from datetime import datetime

def run(cmd, timeout=8):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (r.stdout or r.stderr or "").strip()
    except Exception as e:
        return f"(error: {e})"

ts = datetime.now().strftime("%H:%M:%S")
parts = [f"**Disk Health** [{ts}]", f"df: {run(['df','-h','/'])}"]

dmesg = run(["dmesg"], timeout=5)
hits = []
for line in (dmesg or "").splitlines():
    if re.search(r"mmc|read-only|remount|crc|I/O error", line, re.I):
        hits.append(line.strip())
parts.append("dmesg: " + ("\\n" + "\\n".join(hits[-8:]) if hits else "(clean)"))

root = run(["findmnt","/","-o","OPTIONS","-n"])
ro = "ro" in [x.strip() for x in root.split(",")]
parts.append("root opts: " + root + ("  **[READ-ONLY!]**" if ro else ""))

smart = run(["smartctl","-a","/dev/mmcblk0"], timeout=8)
parts.append("smartctl: " + (smart[:500] if smart and not smart.startswith("(error") else "(unavailable)"))

out = "\\n".join(parts)
print(out[:1900] + ("..." if len(out) > 1900 else ""))
`,
};

const logTail = {
  id: "log-tail",
  filename: "log_tail.py",
  path: "~/secure-pi-bot/scripts/log_tail.py",
  description: "Tail any log from Discord for the /logs command. Searches /dev/shm/pi-bot and ~/secure-pi-bot/logs for a name prefix; '/logs' alone lists available files. Usage: /logs <name> [lines] (default 40, max 200). Reach for it when SSH is dead and you need to read a log.",
  tags: ["logs", "tail", "discord"],
  code: `import os
import re
import sys
import glob

DIRS = ["/dev/shm/pi-bot", "/home/alon/secure-pi-bot/logs"]

if len(sys.argv) < 2 or not sys.argv[1]:
    names = set()
    for d in DIRS:
        if os.path.isdir(d):
            for f in glob.glob(os.path.join(d, "*")):
                if os.path.isfile(f):
                    names.add(os.path.basename(f))
    print("Usage: /logs <name> [lines]\\nAvailable: " + ", ".join(sorted(names)))
    sys.exit(0)

name = sys.argv[1]
# Sanitize: only a plain filename, no path separators or ".." -- stops
# /logs ../home/alon/.secrets/gemini_key from dumping secrets into Discord.
if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
    print(f"Invalid log name '{name}'. Use a plain filename (letters, digits, _ . -) -- no paths.")
    sys.exit(0)
try:
    n = int(sys.argv[2])
except (ValueError, IndexError):
    n = 40
n = max(1, min(n, 200))

matches = []
for d in DIRS:
    if os.path.isdir(d):
        for f in glob.glob(os.path.join(d, name + "*")):
            if os.path.isfile(f):
                matches.append(f)

if not matches:
    print(f"No log matching '{name}'.")
    sys.exit(0)

matches.sort(key=lambda p: os.path.getmtime(p), reverse=True)
path = matches[0]

try:
    with open(path) as f:
        lines = f.readlines()
except OSError as e:
    print(f"Error: {e}")
    sys.exit(0)

tail = lines[-n:]
out = f"**{os.path.basename(path)}** (last {len(tail)}):\\n" + "".join(l.rstrip("\\n") + "\\n" for l in tail)
print(out[:1900] + ("..." if len(out) > 1900 else ""))
`,
};

const diagEntries = [netdiag, diskHealth, logTail];
export default diagEntries;