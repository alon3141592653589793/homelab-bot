const entry = {
  id: "vpn",
  filename: "vpn.py",
  path: "~/secure-pi-bot/modules/vpn.py",
  description: "Discord command router for the #vpn channel. Drives the wg-easy Docker container (status/peers/logs/up/down/restart/port) and a custom /vpn help. Mutually paused with /testall via the shared lockfile (also gated centrally in main.on_message).",
  tags: ["router", "vpn", "wireguard", "docker", "discord"],
  code: `import os
import subprocess

WG_CONTAINER = "wg-easy"

async def _run(message, cmd, label, timeout=30):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        out = (r.stdout or r.stderr or "(no output)").strip()
    except subprocess.TimeoutExpired:
        out = f"Command timed out after {timeout}s"
    except Exception as e:
        out = f"Error: {e}"
    if len(out) > 1900:
        out = out[:1897] + "..."
    await message.channel.send(f"**{label}**\\n{out}" if out else f"**{label}** (no output)")

def _running():
    try:
        r = subprocess.run(["docker", "ps", "-q", "-f", f"name={WG_CONTAINER}"],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0 and bool(r.stdout.strip())
    except Exception:
        return False

async def handle_vpn_command(client, message):
    if os.path.exists("/dev/shm/pi-bot/.testall_running"):
        await message.channel.send("⏳ /testall is running -- commands paused until it finishes.")
        return
    content = message.content.strip().lower()

    if content in ("/vpn", "/vpn help"):
        await message.channel.send(
            "**WireGuard VPN (Docker: wg-easy)**\\n"
            "/vpn status        - Container + WG interface status\\n"
            "/vpn peers         - Peer list (transfer / last handshake)\\n"
            "/vpn logs [N]      - Last N container logs (default 50)\\n"
            "/vpn up            - Start the wg-easy container\\n"
            "/vpn down          - Stop the wg-easy container\\n"
            "/vpn restart       - Restart the wg-easy container\\n"
            "/vpn port          - Listen port + web UI URL\\n"
            "/vpn help          - This message\\n\\n"
            "Peer add/remove/QR is done in the wg-easy web UI (http://<pi-ip>:51821)."
        )
    elif content == "/vpn status":
        await _run(message,
                   ["docker", "ps", "-a", "--filter", f"name={WG_CONTAINER}",
                    "--format", "{{.Names}}\\t{{.Status}}\\t{{.Ports}}"],
                   "VPN Status")
    elif content == "/vpn peers":
        if _running():
            await _run(message, ["docker", "exec", WG_CONTAINER, "wg", "show"], "WG Peers")
        else:
            await message.channel.send("**WG Peers**\\nContainer not running.")
    elif content.startswith("/vpn logs"):
        n = "50"
        parts = content.split()
        if len(parts) > 2:
            try:
                n = str(max(1, min(int(parts[2]), 200)))
            except ValueError:
                n = "50"
        await _run(message, ["docker", "logs", "--tail", n, WG_CONTAINER], f"VPN Logs (last {n})")
    elif content == "/vpn up":
        await _run(message, ["docker", "start", WG_CONTAINER], "VPN Up")
    elif content == "/vpn down":
        await _run(message, ["docker", "stop", WG_CONTAINER], "VPN Down")
    elif content == "/vpn restart":
        await _run(message, ["docker", "restart", WG_CONTAINER], "VPN Restart")
    elif content == "/vpn port":
        if _running():
            await _run(message, ["docker", "exec", WG_CONTAINER, "wg", "show", "wg0"], "WG Port")
        else:
            await message.channel.send("**WG Port**\\nUDP 51820 (container stopped) | Web UI http://<pi-ip>:51821")
    else:
        await message.channel.send("Unknown VPN command. Try /vpn help.")
`,
};

export default entry;