#!/usr/bin/env python3
"""One-time WireGuard (wg-easy) setup on the Pi via Docker Compose.

Run manually on the Pi (interactive, or with flags/env):
    python3 ~/secure-pi-bot/scripts/wireguard_setup.py \
        --host <public-ip-or-dyndns> --password <web-ui-pw>
Or set WG_HOST / WG_PASSWORD / WG_DEFAULT_DNS in the environment.
"""
import os
import sys
import subprocess

COMPOSE_DIR = os.path.expanduser("~/secure-pi-bot/wireguard")
DATA_DIR = os.path.expanduser("~/.wg-easy")

def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)

# --- 1. docker present + usable without root ---
if run(["docker", "--version"]).returncode != 0:
    print("FAIL: docker not installed. Install it first:\n  curl -fsSL https://get.docker.com | sudo sh")
    sys.exit(1)
if run(["docker", "ps"]).returncode != 0:
    print("FAIL: cannot reach the docker daemon without root.\n  sudo usermod -aG docker alon  (then log all the way out and back in)")
    sys.exit(1)

# --- 2. IPv4 forwarding (needed so the VPN can route) ---
if "1" not in run(["sysctl", "-n", "net.ipv4.ip_forward"]).stdout:
    print("STEP: enable IPv4 forwarding (one-time, needs root), then re-run this script:")
    print("  echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-wireguard.conf")
    print("  sudo sysctl --system")
    sys.exit(1)

# --- 3. resolve parameters ---
def flag(name):
    try:
        return sys.argv[sys.argv.index(name) + 1]
    except (ValueError, IndexError):
        return None

lan_ip = (run(["hostname", "-I"]).stdout.strip().split() or [""])[0] or "192.168.1.10"
WG_HOST = flag("--host") or os.getenv("WG_HOST") or ""
WG_PASSWORD = flag("--password") or os.getenv("WG_PASSWORD") or ""
WG_DEFAULT_DNS = flag("--dns") or os.getenv("WG_DEFAULT_DNS") or lan_ip

if not WG_HOST:
    WG_HOST = input(f"WG_HOST (public IP / DynDNS; enter to use LAN IP {lan_ip}): ").strip() or lan_ip
if not WG_PASSWORD:
    WG_PASSWORD = input("wg-easy web UI password: ").strip()
if not WG_PASSWORD:
    print("FAIL: a web UI password is required.")
    sys.exit(1)

# --- 4. write .env + docker-compose.yml ---
os.makedirs(COMPOSE_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)
with open(os.path.join(COMPOSE_DIR, ".env"), "w") as f:
    f.write(f"WG_HOST={WG_HOST}\n"
            f"WG_PASSWORD={WG_PASSWORD}\n"
            f"WG_DEFAULT_DNS={WG_DEFAULT_DNS}\n"
            f"WG_DATA={DATA_DIR}\n")
compose = """services:
  wg-easy:
    image: ghcr.io/wg-easy/wg-easy:latest
    container_name: wg-easy
    environment:
      - WG_HOST=${WG_HOST}
      - PASSWORD=${WG_PASSWORD}
      - WG_PORT=51820
      - WG_DEFAULT_DNS=${WG_DEFAULT_DNS}
      - WG_ALLOWED_IPS=0.0.0.0/0
    volumes:
      - ${WG_DATA}:/etc/wireguard
    ports:
      - "51820:51820/udp"
      - "51821:51821/tcp"
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    sysctls:
      - net.ipv4.ip_forward=1
      - net.ipv4.conf.all.src_valid_mark=1
    restart: unless-stopped
"""
with open(os.path.join(COMPOSE_DIR, "docker-compose.yml"), "w") as f:
    f.write(compose)
print(f"Wrote {COMPOSE_DIR}/.env + docker-compose.yml  (WG_HOST={WG_HOST}, DNS={WG_DEFAULT_DNS})")

# --- 5. firewall (ufw only) ---
ufw = run(["ufw", "status"])
if ufw.returncode == 0 and "active" in ufw.stdout.lower():
    print("Firewall (needs root): sudo ufw allow 51820/udp && sudo ufw allow 51821/tcp")

# --- 6. start the container ---
print("docker compose up -d ...")
r = run(["docker", "compose", "-f", os.path.join(COMPOSE_DIR, "docker-compose.yml"),
         "up", "-d"], timeout=180)
if r.returncode != 0:
    print("FAIL: " + (r.stderr or r.stdout).strip())
    sys.exit(1)

print("\n=== WireGuard (wg-easy) is up ===")
print(f"Web UI:              http://{lan_ip}:51821")
print(f"DNS to VPN clients:  {WG_DEFAULT_DNS} (your AdGuard/Pi)")
print("Listen port (UDP):   51820")
if WG_HOST == lan_ip:
    print("NOTE: WG_HOST is your LAN IP. For remote access set your public IP")
    print("      / DynDNS and forward UDP 51820 to this Pi on your router.")
print("Bot: add to ~/secure-pi-bot/.env -> ADGUARD_CHANNEL_ID / VPN_CHANNEL_ID, then restart the bot.")