const manager = {
  id: "led-manager",
  filename: "led_manager.py",
  path: "~/secure-pi-bot/scripts/led_manager.py",
  description: "Persistent LED scheduler (systemd root service). Priority order: /leds on|off commands (until reboot) FIRST, then SSH activity, then the day/night schedule. Auto schedule = LEDs ON 10:00-22:00, OFF 22:00-10:00 -- but ON while an SSH session is active and for 1h after the last disconnect. /leds off forces dark even while SSH'd in (sleep mode); /leds on forces on even at night. Polls every 10s; runs as root (systemd unit in header comment).",
  tags: ["leds", "sleep", "ssh", "systemd", "daemon"],
  code: `#!/usr/bin/env python3
# LED sleep scheduler + SSH grace daemon (run as root via systemd service).
#
# One-time setup (as root):
#   cat > /etc/systemd/system/pi-leds.service << 'UNIT'
#   [Unit]
#   Description=Pi LED sleep/SSH scheduler
#   After=network.target
#   [Service]
#   Type=simple
#   ExecStart=/usr/bin/python3 -u /home/alon/secure-pi-bot/scripts/led_manager.py
#   Restart=always
#   [Install]
#   WantedBy=multi-user.target
#   UNIT
#   systemctl daemon-reload && systemctl enable --now pi-leds
#
# LED-brightness sysfs is root-only, so this MUST run as root (the unit above does that).
# The Discord bot writes /dev/shm/pi-bot/led_override ("off"|"on"|"auto"; default "auto").

import os
import time
import subprocess
from datetime import datetime

SHM = "/dev/shm/pi-bot"
OVERRIDE = f"{SHM}/led_override"
GRACE = f"{SHM}/led_grace_until"
PREV_SSH = f"{SHM}/led_prev_ssh"
ACTUAL = f"{SHM}/led_actual"
os.makedirs(SHM, exist_ok=True)

LEDS = ["/sys/class/leds/led0", "/sys/class/leds/led1"]
SLEEP_START = 22  # LEDs off from 22:00 ...
SLEEP_END = 10    # ... until 10:00

def ssh_active():
    try:
        r = subprocess.run(["who"], capture_output=True, text=True, timeout=3)
        return any(" pts/" in line for line in r.stdout.splitlines())
    except Exception:
        return False

def in_sleep_window():
    h = datetime.now().hour
    return h >= SLEEP_START or h < SLEEP_END

def read_file(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default

def write_leds(on):
    for path in LEDS:
        if not os.path.exists(path):
            continue
        try:
            with open(f"{path}/trigger", "w") as f:
                f.write("none")  # stop heartbeat/act trigger so brightness sticks
            with open(f"{path}/brightness", "w") as f:
                f.write("255" if on else "0")
        except OSError:
            pass

last_state = None
while True:
    override = read_file(OVERRIDE, "auto")
    now = time.time()
    ssh = ssh_active()
    prev_ssh = read_file(PREV_SSH, "") == "1"

    # SSH just disconnected -> start a 1h "stay on" grace
    if not ssh and prev_ssh:
        try:
            with open(GRACE, "w") as f:
                f.write(str(now + 3600))
            os.chmod(GRACE, 0o666)
        except OSError:
            pass
    try:
        with open(PREV_SSH, "w") as f:
            f.write("1" if ssh else "0")
        os.chmod(PREV_SSH, 0o666)
    except OSError:
        pass

    try:
        grace_until = float(read_file(GRACE, "0") or "0")
    except ValueError:
        grace_until = 0.0

    # Priority: command (override) -> SSH -> day/night schedule.
    if override == "off":
        on = False        # command: force dark (sleep) -- beats SSH
    elif override == "on":
        on = True         # command: force on -- beats schedule
    elif ssh or now < grace_until:
        on = True         # SSH active or 1h post-disconnect grace
    else:
        on = not in_sleep_window()  # day (10:00-22:00) -> on; night -> off

    if on != last_state:
        write_leds(on)
        last_state = on
        try:
            with open(ACTUAL, "w") as f:
                f.write("on" if on else "off")
            os.chmod(ACTUAL, 0o666)
        except OSError:
            pass

    time.sleep(10)
`,
};

const status = {
  id: "led-status",
  filename: "led_status.py",
  path: "~/secure-pi-bot/scripts/led_status.py",
  description: "Reads the /leds override mode + actual LED brightness + SSH grace state for the /leds command. Runs as alon (reads sysfs brightness + the /dev/shm state files the root daemon writes).",
  tags: ["leds", "status", "discord"],
  code: `import os
import time
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
    for p in ["/sys/class/leds/led0", "/sys/class/leds/led1"]:
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

print(f"**Leds** [{datetime.now().strftime('%H:%M')}]\\nMode: {override} | Actual: {actual}\\nSSH active: {'yes' if ssh else 'no'}{remain}\\nSleep window (22:00-10:00): {'yes' if sleep else 'no'}\\nCommands: /leds off | /leds on | /leds auto")
`,
};

const ledEntries = [manager, status];
export default ledEntries;