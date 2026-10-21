#!/usr/bin/env python3
"""Self-healing watchdog for the Minecraft server + playit.gg agent.

Runs from cron (every 2 min, offset 1 min from mc_watchdog so they never race).
Unlike mc_watchdog (which only restarts the server if /mc 24/7 on was set),
this one ALWAYS keeps the server up when it is installed -- the @reboot cron
already starts it unconditionally on boot, so keeping it up between ticks is
consistent. It also checks the playit.gg system service and starts it if the
agent died (needs the one-time sudoers entry in setup-notes; without it the
check still runs and logs, it just can't start the service).

Skips during nightly maintenance (.maintenance_throttle) and /testall.
"""
import os
import sys
import time
import shutil
import subprocess

MC_DIR = os.path.expanduser("~/mc-server")
SCREEN = "mc"
LAUNCH = os.path.join(MC_DIR, "start.sh")
MAINT_THROTTLE = "/dev/shm/pi-bot/.maintenance_throttle"
TESTALL = "/dev/shm/pi-bot/.testall_running"
LOG = "/dev/shm/pi-bot/playit_watchdog.log"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mc_manage  # noqa: E402


def log(msg):
    try:
        os.makedirs("/dev/shm/pi-bot", exist_ok=True)
        with open(LOG, "a") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S") + "  " + msg + "\n")
    except OSError:
        pass


def ensure_server():
    """Start the Minecraft server if start.sh exists and the screen is dead."""
    if not os.path.exists(LAUNCH):
        return  # not installed
    if mc_manage.screen_alive():
        return  # already up
    log("server: screen dead -> starting")
    subprocess.run(["screen", "-dmS", SCREEN, LAUNCH],
                   capture_output=True, text=True, timeout=10)
    time.sleep(8)
    if mc_manage.screen_alive():
        mc_manage.auto_chunky()
        log("server: started OK")
    else:
        # screen exited immediately -- surface why (e.g. java error)
        err = mc_manage.run(["bash", LAUNCH], timeout=25)
        log("server: start FAILED -> " + (err or "(no output)")[:300])


def ensure_playit():
    """Start the playit.gg agent if its systemd service exists but is inactive.
    Needs `alon ALL=(root) NOPASSWD: /bin/systemctl start playit` in sudoers
    (one-time, see setup-notes) to actually start it; the check itself needs no
    sudo."""
    if not shutil.which("systemctl"):
        return
    r = subprocess.run(["systemctl", "is-active", "playit"],
                       capture_output=True, text=True, timeout=5)
    state = (r.stdout or "").strip()
    if state == "active":
        return  # healthy
    if state == "inactive" or state == "failed":
        log("playit: service " + state + " -> attempting start")
        r2 = subprocess.run(["sudo", "-n", "systemctl", "start", "playit"],
                            capture_output=True, text=True, timeout=15)
        if r2.returncode == 0:
            log("playit: started OK")
        else:
            log("playit: could not start (needs sudoers: alon ALL=(root) NOPASSWD: /bin/systemctl start playit) -> "
                + (r2.stderr or "").strip()[:200])
    # state == "unknown" or "activating" -> service not installed or booting; skip


def main():
    if os.path.exists(MAINT_THROTTLE):
        return  # nightly maintenance may reboot
    if os.path.exists(TESTALL):
        return  # /testall running -> commands paused
    ensure_server()
    ensure_playit()


if __name__ == "__main__":
    main()