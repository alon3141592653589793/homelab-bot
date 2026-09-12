import subprocess
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
out = "\n".join(parts)
print(out[:1900] + ("..." if len(out) > 1900 else ""))