#!/usr/bin/env python3
# LED day/night + SSH grace scheduler ("sleep" = YOUR sleep -- lights off in
# your room, NOT the Pi sleeping). Run as root via systemd service.
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
    # Flip EVERY /sys/class/leds/* node so the red PWR LED turns off too.
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