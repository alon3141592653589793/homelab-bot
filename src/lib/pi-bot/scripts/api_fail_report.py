import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import api_manager
from datetime import datetime

stats = api_manager.api_fail_week()
ts = datetime.now().strftime("%H:%M")

if not stats:
    print(f"**API Failure Rate (last 7d)** [{ts}]\nNo API calls logged in the last week.")
    sys.exit(0)

lines = [f"**API Failure Rate (last 7d)** [{ts}]"]
total_ok = total_fail = 0
for p in sorted(stats):
    s = stats[p]
    total = s["ok"] + s["fail"]
    rate = (s["fail"] / total * 100) if total else 0.0
    lines.append(f"{p}: {s['fail']}/{total} failed ({rate:.0f}%) | {s['ok']} ok")
    total_ok += s["ok"]
    total_fail += s["fail"]

grand = total_ok + total_fail
grand_rate = (total_fail / grand * 100) if grand else 0.0
lines.append(f"TOTAL: {total_fail}/{grand} failed ({grand_rate:.0f}%) | {total_ok} ok")
print("\n".join(lines))