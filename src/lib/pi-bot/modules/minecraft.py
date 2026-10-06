import os
import subprocess

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "mc_manage.py")


async def _run(message, subcmd, label, timeout=60):
    try:
        r = subprocess.run(["python3", "-u", SCRIPT] + subcmd, capture_output=True, text=True, timeout=timeout)
        # show stdout AND stderr (stderr holds the real error when a script crashes)
        out = ((r.stdout or "") + (r.stderr or "")).strip() or "(no output)"
    except subprocess.TimeoutExpired:
        out = f"timed out after {timeout}s"
    except Exception as e:
        out = f"error: {e}"
    if len(out) > 1900:
        out = out[:1897] + "..."
    await message.channel.send(f"**{label}**\n{out}" if out else f"**{label}** (no output)")


async def handle_minecraft_command(client, message):
    if os.path.exists("/dev/shm/pi-bot/.testall_running"):
        await message.channel.send("⏳ /testall is running -- commands paused until it finishes.")
        return
    content = message.content.strip()
    raw = message.content.strip()
    c = content.lower()

    if c in ("/mc", "/mc help"):
        await message.channel.send(
            "**Minecraft (cross-play: Java + Bedrock via Paper + Geyser)**\n"
            "/mc start       - Start the server\n"
            "/mc stop        - Graceful stop (sends 'stop' to the console)\n"
            "/mc restart     - Restart the server\n"
            "/mc status      - Service state, screen session, paper jar, tunnels\n"
            "/mc ip          - Show the server IP / how to join (Java + Bedrock)\n"
            "/mc players     - Who's online right now\n"
            "/mc who         - Online players + the IP the server sees for each\n"
            "/mc notnt       - Remove ALL primed (exploding) TNT from the world\n"
            "/mc newworld    - Generate a brand-new world (backs up + moves old aside)\n"
            "                  Usage: /mc newworld confirm  (destructive -- asks to confirm)\n"
            "/mc log [N]     - Last N lines of the server log (default 30)\n"
            "/mc say <text>  - Broadcast a message in-game\n"
            "/mc cmd <...>   - Run any server console command (op, whitelist, gamemode...)\n"
            "/mc op <player> [1-4] - Make a player an operator (level 4 = full). Works while server is off too\n"
            "/mc deop <player> - Remove operator status\n"
            "/mc ops         - List current operators\n"
            "/mc backup      - Tar the world(s) to ~/mc-backups (manual: kept indefinitely)\n"
            "/mc autobackup  - Run the auto-backup now (only if world changed; keeps last 5)\n"
            "/mc 24/7 [on|off]- Auto-restart the server if it dies (skips maintenance + /testall)\n"
            "/mc setup       - First-time install OR update (latest Paper + Geyser + Floodgate), then /mc restart\n"
            "/mc update      - Same as /mc setup\n"
            "/mc tunnels     - Show the playit.gg tunnel addresses\n"
            "/mc tunnels set <java-addr:port> <bedrock-addr:port>  - Save them so /mc status shows them\n"
            "/mc help        - This message\n\n"
            "Java players use the java tunnel (25565). Bedrock players use the bedrock tunnel (19132). "
            "Tunnels come from playit.gg -- no router port-forwarding."
        )
    elif c == "/mc start":
        await _run(message, ["start"], "Minecraft Start")
    elif c == "/mc stop":
        await _run(message, ["stop"], "Minecraft Stop", timeout=90)
    elif c == "/mc restart":
        await _run(message, ["restart"], "Minecraft Restart", timeout=60)
    elif c == "/mc status":
        await _run(message, ["status"], "Minecraft Status")
    elif c == "/mc ip":
        await _run(message, ["ip"], "Minecraft IP / How to Join")
    elif c == "/mc ops":
        await _run(message, ["ops"], "Minecraft Operators")
    elif c.startswith("/mc op "):
        parts = content.split()
        sub = ["op", parts[2]] if len(parts) >= 3 else ["ops"]
        if len(parts) >= 4:
            try:
                sub += [str(max(1, min(int(parts[3]), 4)))]
            except ValueError:
                sub += ["4"]
        await _run(message, sub, "Minecraft Op", timeout=20)
    elif c.startswith("/mc deop "):
        name = raw[len("/mc deop "):].strip()
        if name:
            await _run(message, ["deop", name], "Minecraft Deop", timeout=20)
        else:
            await message.channel.send("Usage: /mc deop <player>")
    elif c == "/mc players":
        await _run(message, ["players"], "Players Online", timeout=15)
    elif c == "/mc who":
        await _run(message, ["who"], "Players Online (IPs)", timeout=15)
    elif c == "/mc notnt":
        await _run(message, ["notnt"], "Remove All TNT", timeout=15)
    elif c in ("/mc newworld", "/mc newworld confirm"):
        await _run(message, ["newworld"] + (["confirm"] if c.endswith("confirm") else []),
                   "New World", timeout=120)
    elif c.startswith("/mc log"):
        parts = content.split()
        sub = ["log"]
        if len(parts) > 2:
            try:
                sub += [str(max(1, min(int(parts[2]), 100)))]
            except ValueError:
                sub += ["30"]
        await _run(message, sub, "Minecraft Log", timeout=15)
    elif c.startswith("/mc say "):
        text = raw[len("/mc say "):].strip()
        await _run(message, ["console", "say", text], f"Say: {text[:60]}", timeout=15)
    elif c.startswith("/mc cmd "):
        line = raw[len("/mc cmd "):].strip()
        await _run(message, ["console", line], f"Cmd: {line[:60]}", timeout=15)
    elif c == "/mc backup":
        await _run(message, ["backup"], "Minecraft Backup", timeout=300)
    elif c == "/mc autobackup":
        await _run(message, ["backup", "--auto"], "Minecraft Auto-Backup", timeout=600)
    elif c in ("/mc update", "/mc setup"):
        await _run(message, ["update"], "Minecraft Setup/Update", timeout=600)
    elif c == "/mc tunnels":
        await _run(message, ["tunnels"], "Minecraft Tunnels")
    elif c in ("/mc 24/7", "/mc 24/7 status", "/mc 24/7 on", "/mc 24/7 off"):
        mode = content.split()[-1].lower() if len(content.split()) > 2 else None
        sub = ["24/7"] + ([mode] if mode in ("on", "off") else [])
        await _run(message, sub, "Minecraft 24/7", timeout=20)
    elif c.startswith("/mc tunnels set "):
        rest = raw[len("/mc tunnels set "):].strip().split()
        if len(rest) >= 2:
            await _run(message, ["tunnels", "set", rest[0], rest[1]], "Minecraft Tunnels (saved)")
        else:
            await message.channel.send("Usage: /mc tunnels set <java-addr:port> <bedrock-addr:port>")
    else:
        await message.channel.send("Unknown Minecraft command. Try /mc help.")