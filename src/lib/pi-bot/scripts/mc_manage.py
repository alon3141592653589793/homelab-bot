#!/usr/bin/env python3
"""Manage the cross-play Minecraft server (Paper + Geyser) on the Pi.

Wraps the USER systemd service 'minecraft.service' and the screen session 'mc'.

Sub-commands:
  start | stop | restart | status | log [N] | console "<command...>" | players
  backup | tunnels | tunnels set <java-addr:port> <bedrock-addr:port>
  24/7 [on|off]                      # auto-restart the server if it dies (cron watchdog)
  update [--version V] [--heap H]    # re-run setup (latest Paper + Geyser + Floodgate)
"""
import os
import sys
import json
import time
import shutil
import argparse
import subprocess
import urllib.request

MC_DIR = os.path.expanduser("~/mc-server")
SCREEN = "mc"
LAUNCH = os.path.join(MC_DIR, "start.sh")
TUNNELS_FILE = os.path.join(MC_DIR, ".tunnels")
OPS_FILE = os.path.join(MC_DIR, "ops.json")
BACKUP_DIR = os.path.expanduser("~/mc-backups")
LOG = os.path.join(MC_DIR, "logs", "latest.log")
SETUP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mc_setup.py")
MARKER_247 = os.path.join(MC_DIR, ".auto_restart")


def run(cmd, timeout=60):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (r.stdout or r.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return f"timed out after {timeout}s"
    except Exception as e:
        return f"error: {e}"


def screen_alive():
    r = subprocess.run(["screen", "-ls"], capture_output=True, text=True, timeout=5)
    return SCREEN in (r.stdout + r.stderr)


def send_console(line):
    if not screen_alive():
        return False
    subprocess.run(["screen", "-S", SCREEN, "-p", "0", "-X", "stuff", f"{line}\n"],
                   capture_output=True, text=True, timeout=5)
    return True


def read_tunnels():
    try:
        with open(TUNNELS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def write_tunnels(java, bedrock):
    os.makedirs(MC_DIR, exist_ok=True)
    with open(TUNNELS_FILE, "w") as f:
        json.dump({"java": java, "bedrock": bedrock}, f)


def _load_ops():
    try:
        with open(OPS_FILE) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_ops(ops):
    os.makedirs(MC_DIR, exist_ok=True)
    with open(OPS_FILE, "w") as f:
        json.dump(ops, f, indent=2)


def _mojang_uuid(name):
    """Resolve a Java player name -> dashed UUID via Mojang. None if offline/unavailable."""
    try:
        url = f"https://api.mojang.com/users/profiles/minecraft/{name}"
        req = urllib.request.Request(url, headers={"User-Agent": "pi-bot/mc-manage"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.load(r)
        if isinstance(data, dict) and data.get("id"):
            i = data["id"]
            return f"{i[:8]}-{i[8:12]}-{i[12:16]}-{i[16:20]}-{i[20:]}"
    except Exception:
        return None
    return None


def paper_jar():
    try:
        return next(f for f in os.listdir(MC_DIR) if f.startswith("paper-") and f.endswith(".jar"))
    except (StopIteration, OSError):
        return None


def tail(path, n=30):
    try:
        with open(path) as f:
            lines = f.readlines()[-n:]
        return "".join(lines).strip()
    except OSError:
        return "(no log)"


CHUNKY_MARKER = os.path.join(MC_DIR, ".chunky_configured")
PLUGINS_DIR = os.path.join(MC_DIR, "plugins")


def _chunky_loaded(timeout=60):
    """Wait until the Chunky plugin has enabled in the server log."""
    end = time.time() + timeout
    while time.time() < end:
        if not screen_alive():
            return False
        try:
            with open(LOG) as f:
                txt = f.read().lower()
            if "chunky" in txt and ("enabled" in txt or "loading" in txt):
                return True
        except OSError:
            pass
        time.sleep(3)
    return False


def auto_chunky():
    """After the server boots, configure Chunky once then resume pre-gen every start."""
    if not os.path.exists(os.path.join(PLUGINS_DIR, "Chunky.jar")):
        return  # not installed -> nothing to do
    if not _chunky_loaded(timeout=60):
        return  # plugin never reported ready; skip silently
    if os.path.exists(CHUNKY_MARKER):
        # already configured in a previous boot -> just resume any paused task
        send_console("chunky continue")
        return
    send_console("chunky world world")
    time.sleep(1)
    send_console("chunky radius 2000")
    time.sleep(1)
    send_console("chunky start")
    os.makedirs(MC_DIR, exist_ok=True)
    with open(CHUNKY_MARKER, "w") as f:
        f.write("configured\n")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("start")
    sub.add_parser("stop")
    sub.add_parser("restart")
    sub.add_parser("status")
    sub.add_parser("ip")
    p_op = sub.add_parser("op"); p_op.add_argument("name"); p_op.add_argument("level", nargs="?", type=int, default=4)
    p_deop = sub.add_parser("deop"); p_deop.add_argument("name")
    sub.add_parser("ops")
    p_log = sub.add_parser("log"); p_log.add_argument("n", nargs="?", type=int, default=30)
    p_con = sub.add_parser("console"); p_con.add_argument("line", nargs="+")
    sub.add_parser("players")
    sub.add_parser("backup")
    p_tun = sub.add_parser("tunnels")
    p_tun.add_argument("set", nargs="?")
    p_tun.add_argument("java", nargs="?")
    p_tun.add_argument("bedrock", nargs="?")
    p_247 = sub.add_parser("24/7"); p_247.add_argument("mode", nargs="?")
    p_upd = sub.add_parser("update"); p_upd.add_argument("--version"); p_upd.add_argument("--heap")
    args = ap.parse_args()

    if args.cmd == "start":
        if screen_alive():
            print("already running (screen 'mc' alive)")
        else:
            run(["screen", "-dmS", SCREEN, LAUNCH])
            time.sleep(6)
            if screen_alive():
                print("started (screen 'mc' alive) -- first boot generates the world (~30s)")
                # auto-resume Chunky world pre-generation (configures once on first boot)
                auto_chunky()
            else:
                # screen exited immediately -- run start.sh directly to surface the java error
                err = run(["bash", LAUNCH], timeout=25)
                print(f"failed to start (screen exited immediately). Direct run output:\n{err}")
    elif args.cmd == "stop":
        if send_console("stop"):
            print("sent 'stop' to console; waiting for graceful shutdown...")
            for _ in range(30):
                if not screen_alive():
                    break
                time.sleep(2)
            if screen_alive():
                run(["screen", "-S", SCREEN, "-X", "quit"])
            print("stopped")
        else:
            print("not running")
    elif args.cmd == "restart":
        if send_console("stop"):
            for _ in range(30):
                if not screen_alive():
                    break
                time.sleep(2)
            if screen_alive():
                run(["screen", "-S", SCREEN, "-X", "quit"])
        print(run(["screen", "-dmS", SCREEN, LAUNCH]) or "restarted")
        time.sleep(6)
        if screen_alive():
            auto_chunky()
    elif args.cmd == "status":
        alive = screen_alive()
        print(f"server: {'running' if alive else 'stopped'}")
        print(f"screen session: {'alive' if alive else 'no'}")
        print(f"paper: {paper_jar() or '(none)'}")
        print(f"java: {'ok' if shutil.which('java') else 'MISSING'}")
        t = read_tunnels()
        if t:
            print(f"java tunnel:   {t.get('java','?')}")
            print(f"bedrock tunnel: {t.get('bedrock','?')}")
        print(f"24/7 auto-restart: {'ON' if os.path.exists(MARKER_247) else 'off'}  (/mc 24/7 on|off)")
    elif args.cmd == "ip":
        import socket
        lan = "127.0.0.1"
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            lan = s.getsockname()[0]
            s.close()
        except Exception:
            try:
                lan = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=5).stdout.split()[0]
            except Exception:
                pass
        alive = screen_alive()
        print("=== How to join the Minecraft server ===")
        print(f"server: {'RUNNING' if alive else 'STOPPED'}  (start it with /mc start)\n")
        print("LOCAL / SAME WIFI:")
        print(f"  Java edition   -> add server: {lan}:25565")
        print(f"  Bedrock edition -> add server: {lan} , port 19132  (via Geyser)\n")
        t = read_tunnels()
        if t.get("java") or t.get("bedrock"):
            print("REMOTE / CROSS-PLAY (playit.gg tunnels):")
            print(f"  Java players:    {t.get('java','?')}")
            print(f"  Bedrock players: {t.get('bedrock','?')}")
            print("  CNAME your domain -> the java tunnel address")
        else:
            print("REMOTE / CROSS-PLAY: no tunnels set yet.")
            print("  1) Install playit.gg (see /mc setup output)")
            print("  2) Add a Java (TCP 25565) + Bedrock (UDP 19132) tunnel in the playit dashboard")
            print("  3) /mc tunnels set <java-addr:port> <bedrock-addr:port>")
        wan = "?"
        try:
            req = urllib.request.Request("https://api.ipify.org", headers={"User-Agent": "pi-bot/mc"})
            with urllib.request.urlopen(req, timeout=10) as r:
                wan = r.read().decode().strip()
        except Exception:
            pass
        if wan and wan != "?" and wan != lan:
            print()
            print("REMOTE VIA PORT-FORWARD (router, no tunnels):")
            print(f"  public IP: {wan}  -> forward TCP 25565 (+ UDP 19132 for Bedrock) on the router to {lan}")
            print(f"  Java players:    {wan}:25565   (after port-forwarding)")
            print(f"  Bedrock players: {wan} , port 19132")
            print("  Note: a home public IP can change on reboot -- playit.gg tunnels are more reliable.")
    elif args.cmd == "op":
        name = args.name
        lvl = max(1, min(4, args.level))
        if screen_alive():
            send_console(f"op {name}")
            time.sleep(1)
            print(f"sent 'op {name}' to the running server (level 4)")
            print(tail(LOG, 6))
        else:
            ops = _load_ops()
            if any(str(o.get("name", "")).lower() == name.lower() for o in ops):
                print(f"{name} is already an operator")
            else:
                uid = _mojang_uuid(name)
                ops.append({"uuid": uid or "", "name": name, "level": lvl, "bypassesPlayerLimit": False})
                _save_ops(ops)
                if uid:
                    print(f"added {name} as operator (level {lvl}) -- takes effect on next /mc start")
                else:
                    print(f"added {name} as operator (level {lvl}) -- WARNING: UUID not resolved (no internet/Mojang down); server resolves on start if online-mode=true")
    elif args.cmd == "deop":
        name = args.name
        if screen_alive():
            send_console(f"deop {name}")
            time.sleep(1)
            print(f"sent 'deop {name}' to the running server")
            print(tail(LOG, 6))
        else:
            ops = _load_ops()
            new = [o for o in ops if str(o.get("name", "")).lower() != name.lower()]
            if len(new) == len(ops):
                print(f"{name} is not an operator")
            else:
                _save_ops(new)
                print(f"removed {name} from operators -- takes effect on next /mc start")
    elif args.cmd == "ops":
        ops = _load_ops()
        if not ops:
            print("no operators yet. Add one: /mc op <player>")
        else:
            print(f"operators ({len(ops)}):")
            for o in ops:
                print(f"  {o.get('name', '?')}  (level {o.get('level', 4)})")
    elif args.cmd == "log":
        print(tail(LOG, args.n))
    elif args.cmd == "console":
        line = " ".join(args.line)
        if send_console(line):
            time.sleep(1)
            print(tail(LOG, 12))
        else:
            print("screen session 'mc' not running -- /mc start first")
    elif args.cmd == "players":
        if send_console("list"):
            time.sleep(1)
            print(tail(LOG, 8))
        else:
            print("server not running -- /mc start first")
    elif args.cmd == "backup":
        os.makedirs(BACKUP_DIR, exist_ok=True)
        if screen_alive():
            send_console("save-all")
            time.sleep(3)
        worlds = [d for d in os.listdir(MC_DIR)
                  if os.path.isdir(os.path.join(MC_DIR, d)) and d.startswith("world")]
        if not worlds:
            print("no world dirs found")
            return
        ts = time.strftime("%Y%m%d-%H%M%S")
        out = os.path.join(BACKUP_DIR, f"mc-{ts}.tar.gz")
        run(["tar", "-czf", out, "-C", MC_DIR] + worlds, timeout=300)
        bks = sorted(os.path.join(BACKUP_DIR, f) for f in os.listdir(BACKUP_DIR) if f.startswith("mc-"))
        for old in bks[:-5]:
            try:
                os.remove(old)
            except OSError:
                pass
        print(f"backup: {out}")
    elif args.cmd == "tunnels":
        if args.set == "set" and args.java and args.bedrock:
            write_tunnels(args.java, args.bedrock)
            print(f"saved tunnels -> java={args.java} bedrock={args.bedrock}")
        else:
            t = read_tunnels()
            if t:
                print(f"java:    {t.get('java','?')}  (share with Java players / CNAME your domain to it)")
                print(f"bedrock:  {t.get('bedrock','?')}  (share with Bedrock players)")
            else:
                print("no tunnels set. Usage: tunnels set <java-addr:port> <bedrock-addr:port>")
    elif args.cmd == "24/7":
        WATCHDOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mc_watchdog.py")
        on = args.mode in (None, "on", "status")
        if args.mode == "off":
            if os.path.exists(MARKER_247):
                os.remove(MARKER_247)
                print("24/7 auto-restart: OFF (server will no longer auto-restart if it dies)")
            else:
                print("24/7 auto-restart: already off")
        elif args.mode in ("on", None):
            os.makedirs(MC_DIR, exist_ok=True)
            with open(MARKER_247, "w") as f:
                f.write("on\n")
            print("24/7 auto-restart: ON (watchdog restarts the server if it dies, skips maintenance/testall)")
            print("  cron runs every 2 min -> /dev/shm/pi-bot/mc_watchdog.log")
            if not screen_alive():
                print("  (server is down right now -- it will start within ~2 min, or run /mc start)")
        else:
            print("Usage: 24/7 [on|off|status]")
        if args.mode in (None, "status"):
            print(f"  marker: {'set' if os.path.exists(MARKER_247) else 'not set'}  ({MARKER_247})")
            print(f"  watchdog script: {WATCHDOG}")
    elif args.cmd == "update":
        cmd = ["python3", "-u", SETUP]
        if args.version:
            cmd += ["--version", args.version]
        if args.heap:
            cmd += ["--heap", args.heap]
        subprocess.run(cmd, text=True, timeout=600)
        print("update done -- /mc restart to load the new paper jar")
    else:
        ap.print_help()


if __name__ == "__main__":
    main()