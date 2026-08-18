const manager = {
  id: "led-manager",
  filename: "led_manager.py",
  path: "~/secure-pi-bot/scripts/led_manager.py",
  description: "Persistent LED scheduler (systemd root service). Priority: /leds override (until reboot) > SSH activity > day/night schedule. Auto = lights ON 10:00-22:00, OFF 22:00-10:00 ('sleep' = YOUR sleep -- dark room, NOT the Pi sleeping), but ON while SSH'd in + 1h grace. /leds on|off are applied instantly by /usr/local/bin/led_ctl (root, via sudoers) so they work WITHOUT this daemon; the daemon only owns the automatic schedule + SSH grace. Polls 10s; runs as root (systemd unit in header).",
  tags: ["leds", "sleep", "ssh", "systemd", "daemon"],
  code: `#!/usr/bin/env python3
# LED day/night + SSH grace scheduler ("sleep" = YOUR sleep -- lights off in
# your room, NOT the Pi sleeping). Run as root via systemd service.
#
# One-time setup (as root):
#   cat > /etc/systemd/system/pi-leds.service << 'UNIT'
#   [Unit]
#   Description=Pi LED day/night + SSH scheduler
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
import glob
import subprocess
from datetime import datetime

SHM = "/dev/shm/pi-bot"
OVERRIDE = f"{SHM}/led_override"
GRACE = f"{SHM}/led_grace_until"
PREV_SSH = f"{SHM}/led_prev_ssh"
ACTUAL = f"{SHM}/led_actual"
os.makedirs(SHM, exist_ok=True)

# "Sleep" = YOUR sleep (lights off in your room), NOT the Pi sleeping.
SLEEP_START = 22  # lights off from 22:00 ...
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
    # Flip EVERY /sys/class/leds/* node so the red PWR LED turns off too. Its
    # default trigger is "default-on" and holds it lit; trigger=none first
    # makes brightness writable -- that's what actually turns the red one off.
    for path in glob.glob("/sys/class/leds/*"):
        if not os.path.isdir(path):
            continue
        try:
            with open(f"{path}/trigger", "w") as f:
                f.write("none")
        except OSError:
            pass
        try:
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
        on = False        # command: lights off (your sleep) -- beats SSH
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
  description: "Reads the /leds override mode + actual LED brightness (all /sys/class/leds/*) + SSH grace state. Runs as alon (sysfs brightness is world-readable; /dev/shm state files are 0666). 'sleep' = your sleep, not the Pi's.",
  tags: ["leds", "status", "discord"],
  code: `import os
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

print(f"**LEDs** [{datetime.now().strftime('%H:%M')}]\\nMode: {override} | Actual: {actual}\\nSSH active: {'yes' if ssh else 'no'}{remain}\\nYour sleep window (22:00-10:00): {'yes' if sleep else 'no'}\\nCommands: /leds off | /leds on | /leds auto")
`,
};

const ctl = {
  id: "led-ctl",
  filename: "led_ctl.py",
  path: "/usr/local/bin/led_ctl",
  description: "Immediate LED control helper, run as root via the sudoers rule in setup (from the Discord /leds on|off|auto commands). Applies brightness to EVERY /sys/class/leds/* so it flips the red PWR LED too -- the red's default trigger is 'default-on' and holds it lit; led_ctl flips trigger to 'none' first, then brightness, which is what actually turns it off. Also writes /dev/shm/pi-bot/led_override (RAM -> cleared on reboot -> auto schedule resumes) so the pi-leds daemon keeps honoring it until reboot. /leds off = lights off for YOUR sleep, not the Pi sleeping. Works with or without the daemon.",
  tags: ["leds", "root", "sudoers", "helper"],
  code: `#!/usr/bin/env python3
# Immediate LED control. Run as root (via the sudoers rule, from the Discord
# bot's /leds on|off|auto commands, or directly). Applies brightness to ALL
# /sys/class/leds/* so the red PWR LED flips too, and writes the override flag
# in /dev/shm (RAM -> cleared on reboot -> auto schedule resumes).
import os
import sys
import glob

SHM = "/dev/shm/pi-bot"
OVERRIDE = f"{SHM}/led_override"

def apply_brightness(on):
    # While a trigger (mmc/act/default-on/heartbeat) owns the LED it ignores
    # brightness writes. trigger=none first, then brightness is writable --
    # that's what actually turns the red PWR LED off (default-on holds it lit).
    for p in glob.glob("/sys/class/leds/*"):
        try:
            with open(f"{p}/trigger", "w") as f:
                f.write("none")
        except OSError:
            pass
        try:
            with open(f"{p}/brightness", "w") as f:
                f.write("255" if on else "0")
        except OSError:
            pass

mode = (sys.argv[1] if len(sys.argv) > 1 else "auto").lower()
os.makedirs(SHM, exist_ok=True)
if mode in ("on", "off", "auto"):
    try:
        with open(OVERRIDE, "w") as f:
            f.write(mode)
    except OSError:
        pass
if mode == "on":
    apply_brightness(True)
elif mode == "off":
    apply_brightness(False)
# auto: just set the flag; the pi-leds daemon reconciles the schedule.
print(f"led override -> {mode}")
`,
};

const ledEntries = [manager, ctl, status];
export default ledEntries;