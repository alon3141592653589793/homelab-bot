#!/usr/bin/env python3
"""Manage the cross-play Minecraft server (Paper + Geyser) on the Pi.

Wraps the USER systemd service 'minecraft.service' and the screen session 'mc'.

Sub-commands:
  start | stop | restart | status | log [N] | console "<command...>" | players
  backup | tunnels | tunnels set <java-addr:port> <bedrock-addr:port>
  update [--version V] [--heap H]    # re-run setup (latest Paper + Geyser + Floodgate)
"""
import os
import sys
import json
import time
import shutil
import argparse
import subprocess

MC_DIR = os.path.expanduser("~/mc-server")
SCREEN = "mc"
LAUNCH = os.path.join(MC_DIR, "start.sh")
TUNNELS_FILE = os.path.join(MC_DIR, ".tunnels")
BACKUP_DIR = os.path.expanduser("~/mc-backups")
LOG = os.path.join(MC_DIR, "logs", "latest.log")
SETUP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mc_setup.py")


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


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("start")
    sub.add_parser("stop")
    sub.add_parser("restart")
    sub.add_parser("status")
    p_log = sub.add_parser("log"); p_log.add_argument("n", nargs="?", type=int, default=30)
    p_con = sub.add_parser("console"); p_con.add_argument("line", nargs="+")
    sub.add_parser("players")
    sub.add_parser("backup")
    p_tun = sub.add_parser("tunnels")
    p_tun.add_argument("set", nargs="?")
    p_tun.add_argument("java", nargs="?")
    p_tun.add_argument("bedrock", nargs="?")
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