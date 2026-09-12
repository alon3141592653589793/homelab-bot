import os
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
parts.append("dmesg: " + ("\n" + "\n".join(hits[-8:]) if hits else "(clean)"))

root = run(["findmnt","/","-o","OPTIONS","-n"])
ro = "ro" in [x.strip() for x in root.split(",")]
parts.append("root opts: " + root + ("  **[READ-ONLY!]**" if ro else ""))

smart = run(["smartctl","-a","/dev/mmcblk0"], timeout=8)
parts.append("smartctl: " + (smart[:500] if smart and not smart.startswith("(error") else "(unavailable)"))

out = "\n".join(parts)
print(out[:1900] + ("..." if len(out) > 1900 else ""))