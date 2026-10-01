#!/usr/bin/env python3
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
    # brightness writes. trigger=none first, then brightness is writable.
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

# "apply on|off" -> used by the cron scheduler (led_schedule.py) to set
# brightness WITHOUT touching the override flag, so manual /leds on|off
# choices still win until reboot. Not meant for direct manual use.
if mode == "apply":
    target = (sys.argv[2] if len(sys.argv) > 2 else "").lower()
    if target in ("on", "off"):
        apply_brightness(target == "on")
    print(f"led apply -> {target}")
elif mode in ("on", "off", "auto"):
    try:
        with open(OVERRIDE, "w") as f:
            f.write(mode)
    except OSError:
        pass
    if mode == "on":
        apply_brightness(True)
    elif mode == "off":
        apply_brightness(False)
    # auto: just set the flag; the cron scheduler reconciles the schedule.
    print(f"led override -> {mode}")