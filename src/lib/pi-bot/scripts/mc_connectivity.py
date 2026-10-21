#!/usr/bin/env python3
"""Minecraft connectivity self-check (read-only, safe).

Tests every connection layer the Pi can reach ITSELF, so the user never has to
run manual diagnostic commands to find out why players can't join. Called
automatically from mc_manage.py start/restart after the server boots, and on
demand from /mc check.

Layers checked:
  - screen alive + "Done" in log (boot complete -- a player joining before this
    gets a connection that opens then hangs/times out, the #1 'can't join'
    false alarm right after /mc restart)
  - ports 25565 / 19132 listening, and on 0.0.0.0 (not just 127.0.0.1)
  - LAN reachability: TCP connect from the Pi to its OWN lan ip:25565
    (== a Java LAN player joining, without needing a player on the wifi)
  - whitelist: enabled? who's listed? (a common 'BOTH editions can't join' cause:
    Java + Bedrock-via-Floodgate are both subject to the whitelist)
  - playit tunnels saved + bounded TCP probe of the java tunnel
  - geyser bedrock port (so the bedrock tunnel address uses the right port)
  - server.properties server-ip binding

It only REPORTS -- it changes nothing. Safe auto-remediation (restart stale
playit, restart a dead server) already lives in the watchdogs.
"""
import os
import sys
import json
import time
import socket
import shutil
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mc_manage  # noqa: E402

MC_DIR = mc_manage.MC_DIR
LOG = mc_manage.LOG
TUNNELS_FILE = os.path.join(MC_DIR, ".tunnels")
DONE_RE = "Done ("


def _run(cmd, timeout=8):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return ((r.stdout or "") + (r.stderr or "")).strip()
    except Exception as e:
        return f"(err: {e})"


def _lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=5).stdout.split()[0]
        except Exception:
            return ""


def _tcp(host, port, timeout=5):
    t0 = time.time()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return f"CONNECTED ({time.time()-t0:.1f}s)"
    except ConnectionRefusedError:
        return "REFUSED"
    except socket.timeout:
        return "TIMEOUT"
    except Exception as e:
        return f"err: {e}"


def _done_age():
    """Seconds since the server printed 'Done (' (boot complete). None if not
    found -- means the server is still booting."""
    try:
        with open(LOG, errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return None
    for line in reversed(lines):
        if DONE_RE in line:
            # lines look like: [15:27:57] [Server thread/INFO]: Done (86.676s)!
            return True
    return None


def wait_for_done(timeout=150):
    """Block until the server log shows 'Done (' or timeout. Returns a status
    string. Used by start/restart so they only report 'ready' when players can
    actually join -- not 6s after launch while the world still generates."""
    end = time.time() + timeout
    while time.time() < end:
        if not mc_manage.screen_alive():
            return "server process died during boot"
        if _done_age() is True:
            return "boot complete (Done) -- server ready for players"
        time.sleep(3)
    return f"still booting after {timeout}s (slow Pi / first world gen) -- wait ~1 min then /mc check"


def _ports():
    out = _run(["ss", "-ltnu"])
    java_listen = "25565" in out
    bed_listen = "19132" in out
    java_bind = bed_bind = ""
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and "25565" in parts[4]:
            java_bind = parts[4]
        if len(parts) >= 5 and "19132" in parts[4]:
            bed_bind = parts[4]
    return java_listen, bed_listen, java_bind, bed_bind


def _whitelist():
    sp = os.path.join(MC_DIR, "server.properties")
    enabled = None
    try:
        for line in open(sp):
            s = line.strip()
            if s.startswith("white-list="):
                enabled = s.split("=", 1)[1] == "true"
    except OSError:
        pass
    names = []
    try:
        data = json.load(open(os.path.join(MC_DIR, "whitelist.json")))
        if isinstance(data, list):
            names = [str(e.get("name", "?")) for e in data]
    except Exception:
        pass
    return enabled, names


def _server_ip():
    sp = os.path.join(MC_DIR, "server.properties")
    try:
        for line in open(sp):
            s = line.strip()
            if s.startswith("server-ip="):
                v = s.split("=", 1)[1].strip()
                return v or "(blank = all interfaces)"
    except OSError:
        pass
    return "(no server.properties)"


def _geyser_port():
    gc = os.path.join(MC_DIR, "plugins", "Geyser-Spigot", "config.yml")
    try:
        for line in open(gc):
            if line.strip().startswith("bedrock-port:") or line.strip().startswith("port:"):
                return line.strip()
    except OSError:
        pass
    return "(geyser config not found)"


def _probe_java_tunnel():
    try:
        t = json.load(open(TUNNELS_FILE))
    except Exception:
        return None, "(no tunnels saved -- /mc tunnels set <java> <bedrock>)"
    java = (t.get("java") or "").strip()
    if not java or ":" not in java:
        return None, "(no java tunnel saved)"
    host, _, port = java.rpartition(":")
    try:
        port = int(port)
    except ValueError:
        return java, f"(bad port: {java})"
    return java, f"TCP {host}:{port} -> {_tcp(host, port)}"


def report(wait_done=False, done_timeout=150):
    """Return a short human verdict. If wait_done, block until boot completes
    first (used by start/restart)."""
    lines = ["=== Connectivity check ==="]
    if not mc_manage.screen_alive():
        lines.append("server: STOPPED -- /mc start first")
        return "\n".join(lines)
    if wait_done:
        lines.append(wait_for_done(done_timeout))
        if not mc_manage.screen_alive():
            return "\n".join(lines)
    done = _done_age()
    if done is None:
        lines.append("server: still BOOTING (no 'Done' in log) -- players can't join yet")
    else:
        lines.append("server: running, boot complete (Done in log)")

    lan = _lan_ip()
    j_listen, b_listen, j_bind, b_bind = _ports()
    lines.append(f"java  25565: {'LISTENING ' + j_bind if j_listen else 'NOT LISTENING'}")
    lines.append(f"bedrock 19132: {'LISTENING ' + b_bind if b_listen else 'NOT LISTENING'}")
    if j_bind and not j_bind.startswith("0.0.0.0") and not j_bind.startswith("*"):
        lines.append(f"  ! java bound to {j_bind} -- non-localhost players can't reach it")
    if b_bind and not b_bind.startswith("0.0.0.0") and not b_bind.startswith("*"):
        lines.append(f"  ! bedrock bound to {b_bind} -- non-localhost players can't reach it")

    if lan and j_listen:
        lines.append(f"LAN java test  {lan}:25565 -> {_tcp(lan, 25565)}")
    if lan and b_listen:
        lines.append(f"LAN bedrock     {lan}:19132 -> (UDP, listening check only)")

    wl_on, wl_names = _whitelist()
    if wl_on:
        lines.append(f"whitelist: ON, allowed: {wl_names or '(EMPTY -- nobody can join!)'}")
        if not wl_names:
            lines.append("  ! whitelist ON but empty -> NO player can join (both editions). /mc cmd whitelist off, or add players.")
    elif wl_on is False:
        lines.append("whitelist: OFF (anyone can join)")
    else:
        lines.append("whitelist: (server.properties not found)")

    lines.append(f"server-ip: {_server_ip()}")
    lines.append(f"geyser: {_geyser_port()}")

    tj, tprobe = _probe_java_tunnel()
    t = mc_manage.read_tunnels()
    if t.get("java") or t.get("bedrock"):
        lines.append(f"playit java tunnel:   {t.get('java','?')}  probe: {tprobe}")
        lines.append(f"playit bedrock tunnel: {t.get('bedrock','?')}  (bedrock players MUST use THIS address + its assigned port, NOT 19132)")
    else:
        lines.append("playit: no tunnels saved -- /mc tunnels set <java-addr:port> <bedrock-addr:port>")

    # Verdict
    problems = []
    if done is None:
        problems.append("server still booting -- wait for 'Done'")
    if not j_listen:
        problems.append("java port 25565 not listening")
    if not b_listen:
        problems.append("bedrock port 19132 not listening")
    if wl_on and not wl_names:
        problems.append("whitelist ON + empty -- blocks all players")
    if j_bind and not j_bind.startswith("0.0.0.0") and not j_bind.startswith("*"):
        problems.append(f"java bound to {j_bind} only")
    if t.get("java") and "CONNECTED" not in tprobe:
        problems.append("playit java tunnel not reachable")

    lines.append("")
    if problems:
        lines.append("VERDICT: players CANNOT join -- " + "; ".join(problems))
    else:
        lines.append("VERDICT: all layers OK -- players should be able to join:")
        lines.append(f"  Java:    {t.get('java') or lan + ':25565 (LAN)'}")
        lines.append(f"  Bedrock: {t.get('bedrock') or lan + ':19132 (LAN)'}")
    return "\n".join(lines)


def main():
    print(report(wait_done=False))


if __name__ == "__main__":
    main()