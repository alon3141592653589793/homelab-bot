#!/usr/bin/env python3
# LED schedule reconciler -- runs as `alon` via cron every minute.
# Replaces the old root `led_manager` daemon: instead of a long-running root
# process (which had no install/start mechanism in the repo and silently died
# after reboots), this evaluates the same day/night + SSH + override logic and
# applies brightness through `sudo /usr/local/bin/led_ctl apply on|off`
# (already covered by the pi-leds sudoers rule). State lives in /dev/shm (RAM),
# so it clears on reboot -- manual /leds on|off overrides never persist past boot.
import os
import time
import subprocess
from datetime import datetime

try:
    from zoneinfo import ZoneInfo
    _TZ = ZoneInfo("Asia/Jerusalem")  # your wall clock, regardless of Pi system TZ
except Exception:
    _TZ = None

SHM = "/dev/shm/pi-bot"
OVERRIDE = f"{SHM}/led_override"
GRACE = f"{SHM}/led_grace_until"
PREV_SSH = f"{SHM}/led_prev_ssh"
LAST = f"{SHM}/led_sched_last"  # last applied state -> skip redundant sudo writes

# "Sleep" = YOUR sleep (lights off in your room), NOT the Pi sleeping.
SLEEP_START = 22  # lights off from 22:00 ...
SLEEP_END = 10    # ... until 10:00

LED_CTL = ["sudo", "-n", "/usr/local/bin/led_ctl"]


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def ssh_active():
    try:
        r = subprocess.run(["who"], capture_output=True, text=True, timeout=3)
        return any(" pts/" in line for line in (r.stdout or "").splitlines())
    except Exception:
        return False


def in_sleep_window():
    h = (datetime.now(_TZ) if _TZ else datetime.now()).hour
    return h >= SLEEP_START or h < SLEEP_END


def main():
    os.makedirs(SHM, exist_ok=True)
    override = read(OVERRIDE, "auto")
    now = time.time()
    ssh = ssh_active()
    prev_ssh = read(PREV_SSH, "") == "1"

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
        grace_until = float(read(GRACE, "0") or "0")
    except ValueError:
        grace_until = 0.0

    # Priority: command (override) -> SSH -> day/night schedule.
    if override == "off":
        on = False
    elif override == "on":
        on = True
    elif ssh or now < grace_until:
        on = True
    else:
        on = not in_sleep_window()  # day (10:00-22:00) -> on; night -> off

    state = "on" if on else "off"
    if read(LAST, "") == state:
        return  # no change since last run -> skip the sudo/write
    r = subprocess.run(LED_CTL + ["apply", state], capture_output=True, text=True, timeout=10)
    if r.returncode == 0:
        try:
            with open(LAST, "w") as f:
                f.write(state)
            os.chmod(LAST, 0o666)
        except OSError:
            pass
    # apply failed -> leave LAST unchanged so next minute retries


if __name__ == "__main__":
    main()