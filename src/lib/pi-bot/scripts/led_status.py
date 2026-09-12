import os
import time
import glob
import subprocess
from datetime import datetime

SHM = "/dev/shm/pi-bot"
OVERRIDE = f"{SHM}/led_override"
GRACE = f"{SHM}/led_grace_until"

def read(p, d=""):
    try:
        with open(p) as f:
            return f.read().strip()
    except OSError:
        return d

def led_on():
    for p in glob.glob("/sys/class/leds/*"):
        try:
            with open(f"{p}/brightness") as f:
                if f.read().strip() != "0":
                    return True
        except OSError:
            pass
    return False

override = read(OVERRIDE, "auto")
actual = "on" if led_on() else "off"

try:
    grace = float(read(GRACE, "0") or "0")
except ValueError:
    grace = 0.0

h = datetime.now().hour
sleep = h >= 22 or h < 10

try:
    r = subprocess.run(["who"], capture_output=True, text=True, timeout=3)
    ssh = " pts/" in (r.stdout or "")
except Exception:
    ssh = False

remain = ""
if grace > time.time():
    remain = f" | SSH grace {int((grace - time.time()) // 60)}m left"

print(f"**LEDs** [{datetime.now().strftime('%H:%M')}]\nMode: {override} | Actual: {actual}\nSSH active: {'yes' if ssh else 'no'}{remain}\nYour sleep window (22:00-10:00): {'yes' if sleep else 'no'}\nCommands: /leds off | /leds on | /leds auto")