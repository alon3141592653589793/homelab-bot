#!/usr/bin/env python3
"""One-time, NO-DOCKER installer for FreeLLMAPI on the Pi.

  python3 ~/secure-pi-bot/scripts/llm_install.py

Does (idempotent -- safe to re-run to UPDATE):
  1. checks Node >= 20.18 and < 25, npm, git
  2. clones https://github.com/tashfeenahmed/freellmapi -> ~/freellmapi
     (or `git pull` if already there)
  3. writes ~/freellmapi/.env (ENCRYPTION_KEY generated ONCE, PORT=3001,
     bound to 127.0.0.1 only) -- an existing .env is never overwritten
  4. npm install + npm run build   (a few minutes on a Pi; RAM-heavy)
  5. writes ~/.config/systemd/user/freellmapi.service, enables + starts it
     and enables lingering so it survives logout / starts at boot

Afterwards, in Discord:
  /llm status
  open http://127.0.0.1:3001 (SSH tunnel: ssh -L 3001:127.0.0.1:3001 alon@<pi>)
  create the dashboard account, then manage everything with /llm ...
"""
import os
import re
import sys
import secrets
import subprocess

HOME = os.path.expanduser("~")
DIR = os.path.join(HOME, "freellmapi")
REPO = "https://github.com/tashfeenahmed/freellmapi.git"
UNIT_DIR = os.path.join(HOME, ".config", "systemd", "user")
UNIT = os.path.join(UNIT_DIR, "freellmapi.service")
PORT = os.getenv("PORT", "3001")


def sh(cmd, cwd=None, timeout=1800):
    print(f"$ {' '.join(cmd)}", flush=True)
    r = subprocess.run(cmd, cwd=cwd, timeout=timeout)
    if r.returncode != 0:
        print(f"FAILED (exit {r.returncode}): {' '.join(cmd)}")
        sys.exit(r.returncode)


def out(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=15).stdout.strip()
    except Exception:
        return ""


def check_node():
    v = out(["node", "--version"])
    m = re.match(r"v(\d+)\.(\d+)", v)
    if not m:
        print("Node.js not found. Install Node 20 or 22 LTS, e.g.:")
        print("  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs")
        sys.exit(1)
    major, minor = int(m.group(1)), int(m.group(2))
    if major < 20 or (major == 20 and minor < 18) or major >= 25:
        print(f"Node {v} is unsupported (FreeLLMAPI needs >=20.18 and <25). Install Node 22 LTS (see above).")
        sys.exit(1)
    print(f"node {v} ok")


def main():
    check_node()
    for tool in ("npm", "git"):
        if not out(["which", tool]):
            print(f"{tool} not found: sudo apt install -y {tool if tool == 'git' else 'npm'}")
            sys.exit(1)

    if os.path.isdir(os.path.join(DIR, ".git")):
        sh(["git", "pull", "--ff-only"], cwd=DIR, timeout=300)
    else:
        sh(["git", "clone", "--depth", "1", REPO, DIR], timeout=600)

    env_path = os.path.join(DIR, ".env")
    if not os.path.exists(env_path):
        fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(f"ENCRYPTION_KEY={secrets.token_hex(32)}\nPORT={PORT}\nNODE_ENV=production\nHOST=127.0.0.1\n")
        print("wrote .env (new ENCRYPTION_KEY -- BACK THIS FILE UP; losing it makes stored provider keys unreadable)")
    else:
        print(".env exists -- left untouched")

    # Low-RAM Pi: cap Node's heap during the build.
    os.environ["NODE_OPTIONS"] = "--max-old-space-size=1024"
    sh(["npm", "install", "--no-audit", "--no-fund"], cwd=DIR)
    sh(["npm", "run", "build:server"], cwd=DIR)
    # Dashboard UI (client/dist). Without it the server only exposes the API
    # and http://127.0.0.1:3001/ answers "Not Found".
    sh(["npm", "run", "build", "-w", "client"], cwd=DIR)

    node = out(["which", "node"])
    os.makedirs(UNIT_DIR, exist_ok=True)
    with open(UNIT, "w") as f:
        f.write(f"""[Unit]
Description=FreeLLMAPI gateway (pooled free LLM providers)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={DIR}/server
EnvironmentFile={DIR}/.env
ExecStart={node} dist/index.js
Restart=on-failure
RestartSec=10
# Keep the gateway from starving the Pi / Minecraft
MemoryMax=400M
Nice=10

[Install]
WantedBy=default.target
""")
    print(f"wrote {UNIT}")
    sh(["systemctl", "--user", "daemon-reload"])
    sh(["systemctl", "--user", "enable", "--now", "freellmapi.service"])
    user = os.environ.get("USER", "alon")
    subprocess.run(["loginctl", "enable-linger", user])  # start at boot without login

    print("\nDONE. Next:")
    print("  1) /llm status")
    print(f"  2) SSH tunnel:  ssh -p 54321 -L {PORT}:127.0.0.1:{PORT} {user}@<pi-ip>   then open http://127.0.0.1:{PORT}")
    print("     create the dashboard account, add provider keys on the Keys page")
    print("  3) /llm unified <unified key from the Keys page header>")
    print("  4) /llm token <dashboard token>  (only needed for /llm addkey|keys|rmkey|testkey)")


if __name__ == "__main__":
    main()