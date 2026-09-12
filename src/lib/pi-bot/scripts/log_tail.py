import os
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
    print("Usage: /logs <name> [lines]\nAvailable: " + ", ".join(sorted(names)))
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
out = f"**{os.path.basename(path)}** (last {len(tail)}):\n" + "".join(l.rstrip("\n") + "\n" for l in tail)
print(out[:1900] + ("..." if len(out) > 1900 else ""))