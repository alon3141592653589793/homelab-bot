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
PAPER_API = "https://api.papermc.io/v2/projects/paper"
GEYSER_JAR = "https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot"
FLOODGATE_JAR = "https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot"
HEAP_FILE = os.path.join(MC_DIR, ".heap")
LAUNCH = os.path.join(MC_DIR, "start.sh")
UNIT_DIR = os.path.expanduser("~/.config/systemd/user")
UNIT = os.path.join(UNIT_DIR, "minecraft.service")

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


def pick_version(requested):
    if requested:
        return requested
    versions = fetch_json(PAPER_API).get("versions", [])
    cands = [v for v in versions if v.startswith("1.") and v.replace(".", "").isdigit()]
    cands.sort(key=lambda s: [int(x) for x in s.split(".")])
    return cands[-1] if cands else None


def latest_paper_build(mc_version):
    data = fetch_json(f"{PAPER_API}/versions/{mc_version}/builds")
    builds = data.get("builds", [])
    stable = [b for b in builds if b.get("channel") == "default"]
    pick = stable[-1] if stable else (builds[-1] if builds else None)
    if not pick:
        return None, None, None
    bnum = pick["build"]
    fname = pick["downloads"]["application"]["name"]
    dl = f"{PAPER_API}/versions/{mc_version}/builds/{bnum}/downloads/{fname}"
    return bnum, fname, dl


def find_paper_jar():
    try:
        return next(f for f in os.listdir(MC_DIR) if f.startswith("paper-") and f.endswith(".jar"))
    except (StopIteration, OSError):
        return None


def write_launch_and_unit(heap):
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

    os.makedirs(UNIT_DIR, exist_ok=True)
    with open(UNIT, "w") as f:
        f.write("[Unit]\n")
        f.write("Description=Minecraft (Paper + Geyser) cross-play server\n")
        f.write("After=network-online.target\n\n")
        f.write("[Service]\n")
        f.write("Type=forking\n")
        f.write(f"WorkingDirectory={MC_DIR}\n")
        f.write(f"ExecStart=/usr/bin/screen -dmS mc {LAUNCH}\n")
        f.write("ExecStop=/usr/bin/screen -S mc -p 0 -X stuff 'stop\\n'\n")
        f.write("TimeoutStopSec=40\n")
        f.write("Restart=on-failure\n")
        f.write("RestartSec=10\n\n")
        f.write("[Install]\n")
        f.write("WantedBy=default.target\n")
    subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
    print("  wrote start.sh + user systemd unit (minecraft.service)")


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
        die("java not found. MC 1.21 needs JDK 21, which is NOT in RPi OS bookworm. Install Azul Zulu 21 (works on arm32 + arm64):\n"
            "  sudo apt install -y gnupg ca-certificates wget screen\n"
            "  sudo mkdir -p /etc/apt/keyrings\n"
            "  wget -qO - https://repos.azul.com/azul-bin-public-install.key | sudo gpg --dearmor -o /etc/apt/keyrings/azul.gpg\n"
            "  echo 'deb [signed-by=/etc/apt/keyrings/azul.gpg] https://repos.azul.com/zulu-apt stable main' | sudo tee /etc/apt/sources.list.d/zulu.list\n"
            "  sudo apt update && sudo apt install -y zulu21-jdk-headless\n"
            "  java -version   # should print 21.x\n"
            "then re-run: /mc setup")
    if not have("screen"):
        die("screen not found. sudo apt install -y screen")
    user = os.environ.get("USER") or os.path.basename(os.path.expanduser("~"))
    subprocess.run(["loginctl", "enable-linger", user], capture_output=True, timeout=10)

    print("== picking Paper version ==")
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
    try:
        download(dl, os.path.join(MC_DIR, fname))
    except Exception as e:
        die(f"Paper download failed: {e}")
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
    write_launch_and_unit(args.heap)

    print("\nDONE. Next:")
    print("  1) /mc start   (or: systemctl --user enable --now minecraft.service)")
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