import os
import json
import sys
from datetime import datetime

RAM_LOG = "/dev/shm/pi-bot/fan_events.jsonl"
DISK_LOG = "/home/alon/secure-pi-bot/logs/fan_events.jsonl"

events = []
seen = set()
for path in (DISK_LOG, RAM_LOG):
    if not os.path.exists(path):
        continue
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(e, dict) or "ts" not in e:
                continue
            if e["ts"] not in seen:
                seen.add(e["ts"])
                events.append(e)

events.sort(key=lambda x: x["ts"])

if not events:
    print("No fan events logged yet.")
    sys.exit(0)

# Build sessions: on -> off pairs
sessions = []
i = 0
while i < len(events):
    if events[i]["event"] == "on":
        start = events[i]["ts"]
        end = None
        for j in range(i + 1, len(events)):
            if events[j]["event"] == "off":
                end = events[j]["ts"]
                i = j
                break
        sessions.append((start, end))
    i += 1

lines = [f"**Fan Log** ({len(sessions)} sessions)"]
for start, end in sessions[-20:]:
    s = datetime.fromisoformat(start)
    if end:
        e = datetime.fromisoformat(end)
        secs = (e - s).total_seconds()
        lines.append(f"  {s.strftime('%m/%d %H:%M')} -> {e.strftime('%H:%M')} ({int(secs//60)}m{int(secs%60):02d}s)")
    else:
        lines.append(f"  {s.strftime('%m/%d %H:%M')} -> running")

now = datetime.now()
total = sum(
    (datetime.fromisoformat(e) - datetime.fromisoformat(s)).total_seconds() if e
    else (now - datetime.fromisoformat(s)).total_seconds()
    for s, e in sessions
)
lines.append(f"Total fan-on: {int(total // 60)}m")
print("\n".join(lines))