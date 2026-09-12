import subprocess
from datetime import datetime

try:
    r = subprocess.run(
        ["lynis", "audit", "system", "--quick", "--no-colors"],
        capture_output=True, text=True, timeout=180
    )
    out = (r.stdout or r.stderr or "").strip()
except FileNotFoundError:
    print("FAILURE: lynis not installed. Run: sudo apt install lynis")
    raise SystemExit(0)
except subprocess.TimeoutExpired:
    print("FAILURE: lynis timed out after 180s")
    raise SystemExit(0)

lines = out.splitlines()
interesting = []
for ln in lines:
    s = ln.strip()
    if s.startswith("W:") or s.startswith("S:") or "Hardening index" in s or "Tests performed" in s:
        interesting.append(s)

ts = datetime.now().strftime("%H:%M")
header = f"**Lynis Report** [{ts}]"
if not interesting:
    print(f"{header}\nNo warnings or suggestions found.\n\n{out[-1500:]}")
else:
    body = "\n".join(interesting)
    if len(body) > 1800:
        body = body[:1800]
    print(f"{header}\n{body}")