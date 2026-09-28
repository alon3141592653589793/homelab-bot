#!/usr/bin/env python3
"""24/7 watchdog for the Minecraft server.

Runs from cron (every 2 min). Only restarts the server if the user opted in
with `mc_manage.py 24/7 on` (creates ~/mc-server/.auto_restart). Skips during
nightly maintenance (.maintenance_throttle) and /testall (.testall_running)
so it never fights the maintenance reboot or the test suite.
"""
import os
import sys
import time

MC_DIR = os.path.expanduser("~/mc-server")
MARKER = os.path.join(MC_DIR, ".auto_restart")
MAINT_THROTTLE = "/dev/shm/pi-bot/.maintenance_throttle"
TESTALL = "/dev/shm/pi-bot/.testall_running"
MANAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mc_manage.py")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mc_manage  # noqa: E402


def log(msg):
    # silent on stdout (cron) -- only log to RAM when we actually act
    pass


def main():
    if not os.path.exists(MARKER):
        return  # 24/7 not enabled -> nothing to do
    if not os.path.exists(os.path.join(MC_DIR, "start.sh")):
        return  # server not installed
    if os.path.exists(MAINT_THROTTLE):
        return  # nightly maintenance is running (may reboot) -> don't fight it
    if os.path.exists(TESTALL):
        return  # /testall is running -> commands paused

    if mc_manage.screen_alive():
        return  # already up

    # server is down and 24/7 is on -> start it
    os.makedirs("/dev/shm/pi-bot", exist_ok=True)
    try:
        with open("/dev/shm/pi-bot/mc_watchdog.log", "a") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S") + "  24/7: server down -> restarting\n")
    except OSError:
        pass
    mc_manage.run(["screen", "-dmS", mc_manage.SCREEN, mc_manage.LAUNCH])
    time.sleep(8)
    if mc_manage.screen_alive():
        mc_manage.auto_chunky()
        try:
            with open("/dev/shm/pi-bot/mc_watchdog.log", "a") as f:
                f.write(time.strftime("%Y-%m-%d %H:%M:%S") + "  24/7: restarted OK\n")
        except OSError:
            pass


if __name__ == "__main__":
    main()