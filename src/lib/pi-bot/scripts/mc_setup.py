#!/usr/bin/env python3
"""Install/update a cross-play Minecraft server (Paper + Geyser + Floodgate) on the Pi.

Java players connect via TCP 25565; Bedrock players connect via Geyser on UDP 19132.
Both are exposed through playit.gg tunnels (no router port-forwarding).

Designed to run as a non-root user. The server runs under a USER systemd unit
(~/.config/systemd/user/minecraft.service) inside a `screen` session so the
console is attachable and scriptable.

Usage:
  python3 mc_setup.py                 # install/update to the latest Paper 1.21.x
  python3 mc_setup.py --version 1.21.6
  python3 mc_setup.py --heap 1024M

Requires: java (openjdk-21 for MC 1.21), screen.
"""
import os
import sys
import json
import shutil
import argparse
import subprocess
import urllib.request

MC_DIR = os.path.expanduser("~/mc-server")
PLUGINS = os.path.join(MC_DIR, "plugins")
PAPER_API = "https://fill.papermc.io/v3/projects/paper"
GEYSER_JAR = "https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot"
FLOODGATE_JAR = "https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot"
HEAP_FILE = os.path.join(MC_DIR, ".heap")
LAUNCH = os.path.join(MC_DIR, "start.sh")

DEFAULT_HEAP = "1024M"


def die(msg):
    print(f"FAILURE: {msg}")
    sys.exit(1)


def have(cmd):
    return shutil.which(cmd) is not None


def fetch_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "pi-bot/mc-setup"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def download(url, dest):
    print(f"  downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "pi-bot/mc-setup"})
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, length=1024 * 1024)


def _semver_key(s):
    key = []
    for x in str(s).split("."):
        try:
            key.append(int(x))
        except ValueError:
            key.append(0)
    return key


def pick_version(requested):
    if requested:
        return requested
    data = fetch_json(PAPER_API)
    raw = data.get("versions", []) if isinstance(data, dict) else data
    cands = []
    if isinstance(raw, dict):
        for grp in raw.values():
            cands.extend(grp if isinstance(grp, list) else [grp])
    elif isinstance(raw, list):
        cands = list(raw)
    cands = [v for v in cands if isinstance(v, str) and v[:1].isdigit()]
    if not cands:
        return None
    cands.sort(key=_semver_key)
    return cands[-1]


def latest_paper_build(mc_version):
    data = fetch_json(f"{PAPER_API}/versions/{mc_version}/builds")
    if isinstance(data, dict) and data.get("ok") is False:
        return None, None, None
    builds = data if isinstance(data, list) else (data.get("builds", []) if isinstance(data, dict) else [])
    stable = [b for b in builds if b.get("channel") == "STABLE"]
    if not stable:
        stable = list(builds)
    if not stable:
        return None, None, None
    pick = max(stable, key=lambda b: int(b.get("id", 0) or 0))
    dl_obj = (pick.get("downloads") or {}).get("server:default") or {}
    url = dl_obj.get("url")
    fname = dl_obj.get("name") or (url.split("/")[-1] if url else "paper.jar")
    return pick.get("id"), fname, url


def find_paper_jar():
    try:
        return next(f for f in os.listdir(MC_DIR) if f.startswith("paper-") and f.endswith(".jar"))
    except (StopIteration, OSError):
        return None


def write_launch(heap):
    os.makedirs(MC_DIR, exist_ok=True)
    with open(HEAP_FILE, "w") as f:
        f.write(heap)
    paper_jar = find_paper_jar()
    if not paper_jar:
        die("paper jar not found after download")
    with open(LAUNCH, "w") as f:
        f.write("#!/bin/bash\n")
        f.write(f"cd {MC_DIR}\n")
        f.write(f"exec java -Xms{heap} -Xmx{heap} -XX:+UseG1GC -jar {paper_jar} nogui\n")
    os.chmod(LAUNCH, 0o755)

    print("  wrote start.sh (run via: screen -dmS mc start.sh  -- managed directly, no systemd)")


def ensure_eula_and_props():
    os.makedirs(MC_DIR, exist_ok=True)
    eula = os.path.join(MC_DIR, "eula.txt")
    if not os.path.exists(eula):
        with open(eula, "w") as f:
            f.write("eula=true\n")
    sp = os.path.join(MC_DIR, "server.properties")
    if not os.path.exists(sp):
        with open(sp, "w") as f:
            f.write("# Cross-play server (Java 25565, Bedrock via Geyser 19132)\n")
            f.write("server-port=25565\n")
            f.write("online-mode=true\n")
            f.write("max-players=12\n")
            f.write("motd=HomeLab cross-play server\n")
            f.write("level-name=world\n")
            f.write("# Floodgate lets Bedrock players join even with online-mode=true\n")


def install_plugins():
    os.makedirs(PLUGINS, exist_ok=True)
    for name, url in (("Geyser-Spigot.jar", GEYSER_JAR),
                      ("floodgate-spigot.jar", FLOODGATE_JAR)):
        dest = os.path.join(PLUGINS, name)
        print(f"  installing {name}")
        try:
            download(url, dest)
        except Exception as e:
            print(f"  WARNING: could not download {name}: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default=None, help="Minecraft version, e.g. 1.21.6")
    ap.add_argument("--heap", default=DEFAULT_HEAP, help="JVM heap, e.g. 1024M or 2G")
    args = ap.parse_args()

    print("== checks ==")
    if not have("java"):
        die("java not found. MC 1.21 needs JDK 21, which is NOT in RPi OS bookworm. Install Azul Zulu 21 (arm64):\n"
            "  sudo apt install -y gnupg ca-certificates curl screen\n"
            "  curl -s https://repos.azul.com/azul-repo.key | sudo gpg --dearmor -o /usr/share/keyrings/azul.gpg\n"
            "  echo 'deb [signed-by=/usr/share/keyrings/azul.gpg] https://repos.azul.com/zulu/deb stable main' | sudo tee /etc/apt/sources.list.d/zulu.list\n"
            "  sudo chmod 644 /usr/share/keyrings/azul.gpg\n"
            "  sudo apt update && sudo apt install -y zulu21-ca-jre-headless\n"
            "  java -version   # should print 21.x\n"
            "then re-run: /mc setup")
    if not have("screen"):
        die("screen not found. sudo apt install -y screen")
    print("== picking Paper version ==")
    try:
        mc_version = pick_version(args.version)
        if not mc_version:
            die("could not determine a Paper version")
        print(f"  target: {mc_version}")

        bnum, fname, dl = latest_paper_build(mc_version)
        if not dl:
            die(f"no Paper build found for {mc_version}")
        print(f"  latest build: {bnum} -> {fname}")

        os.makedirs(MC_DIR, exist_ok=True)
        os.makedirs(PLUGINS, exist_ok=True)
        print("== downloading Paper ==")
        download(dl, os.path.join(MC_DIR, fname))
    except SystemExit:
        raise
    except Exception as e:
        die(f"could not fetch/download Paper from api.papermc.io: {e}\n"
            f"(usually a network/timeout issue -- retry /mc setup; if it keeps failing, the Pi may need internet/DNS check)")
    for fn in os.listdir(MC_DIR):
        if fn.startswith("paper-") and fn.endswith(".jar") and fn != fname:
            try:
                os.remove(os.path.join(MC_DIR, fn))
            except OSError:
                pass

    print("== plugins (Geyser + Floodgate for Bedrock cross-play) ==")
    install_plugins()

    print("== config ==")
    ensure_eula_and_props()
    write_launch(args.heap)

    print("\nDONE. Next:")
    print("  1) /mc start   (auto-starts on reboot via crontab after the next /sync)")
    print("  2) Install playit.gg (one time):")
    print("       curl -SsL https://playit-cloud.github.io/ppa/key.gpg | sudo tee /etc/apt/trusted.gpg.d/playit.gpg")
    print("       echo 'deb https://playit-cloud.github.io/ppa assets/' | sudo tee /etc/apt/sources.list.d/playit.list")
    print("       sudo apt update && sudo apt install playit && playit setup")
    print("  3) In the playit dashboard add TWO tunnels:")
    print("       'Minecraft Java' (TCP)   -> 127.0.0.1:25565")
    print("       'Minecraft Bedrock' (UDP) -> 127.0.0.1:19132")
    print("  4) Point your domain at the Java tunnel (CNAME):")
    print("       mc.yourdomain.com  ->  <java-tunnel-address>.playit.gg")
    print("     Bedrock players use the numeric <bedrock-tunnel-address>:<port>")
    print("  5) Save the tunnels so the bot can show them:  /mc tunnels set <java-addr:port> <bedrock-addr:port>")


if __name__ == "__main__":
    main()