const entry = {
  id: "adguard",
  filename: "adguard.py",
  path: "~/secure-pi-bot/modules/adguard.py",
  description: "Discord command router for the #adguard channel. Drives the native AdGuardHome service (/opt/AdGuardHome/AdGuardHome): status/restart/stop/start/update/logs/test/version + custom /adguard help. Mutually paused with /testall via the shared lockfile.",
  tags: ["router", "adguard", "dns", "discord"],
  code: `import os
import subprocess

AGH = "/opt/AdGuardHome/AdGuardHome"

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

async def handle_adguard_command(client, message):
    if os.path.exists("/dev/shm/pi-bot/.testall_running"):
        await message.channel.send("⏳ /testall is running -- commands paused until it finishes.")
        return
    content = message.content.strip().lower()

    if content in ("/adguard", "/adguard help"):
        await message.channel.send(
            "**AdGuard Home (DNS)**\\n"
            "/adguard status      - Service status + listen port\\n"
            "/adguard restart     - Restart AdGuardHome\\n"
            "/adguard stop        - Stop AdGuardHome\\n"
            "/adguard start       - Start AdGuardHome\\n"
            "/adguard update      - Upgrade the AdGuardHome binary\\n"
            "/adguard logs [N]    - Last N journal lines (default 50)\\n"
            "/adguard test        - DNS resolution test via 127.0.0.1:53\\n"
            "/adguard version     - Installed AdGuardHome version\\n"
            "/adguard help        - This message"
        )
    elif content == "/adguard status":
        await _run(message, [AGH, "-s", "status"], "AdGuard Home Status")
    elif content == "/adguard restart":
        await _run(message, [AGH, "-s", "restart"], "AdGuard Restart")
    elif content == "/adguard stop":
        await _run(message, [AGH, "-s", "stop"], "AdGuard Stop")
    elif content == "/adguard start":
        await _run(message, [AGH, "-s", "start"], "AdGuard Start")
    elif content == "/adguard update":
        await _run(message, [AGH, "-s", "upgrade"], "AdGuard Update", timeout=120)
    elif content.startswith("/adguard logs"):
        n = "50"
        parts = content.split()
        if len(parts) > 2:
            try:
                n = str(max(1, min(int(parts[2]), 200)))
            except ValueError:
                n = "50"
        await _run(message, ["journalctl", "-u", "AdGuardHome", "-n", n, "--no-pager"],
                   f"AdGuard Logs (last {n})")
    elif content == "/adguard test":
        await _run(message, ["dig", "@127.0.0.1", "-p", "53", "example.com", "+short"],
                   "DNS Resolver Test")
    elif content == "/adguard version":
        await _run(message, [AGH, "--version"], "AdGuard Version")
    else:
        await message.channel.send("Unknown AdGuard command. Try /adguard help.")
`,
};

export default entry;