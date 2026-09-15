import os
import sys
import json
import asyncio
import subprocess
from dotenv import load_dotenv
import discord
from discord.ext import tasks
from modules.reactive import handle_reactive_command
from modules.adguard import handle_adguard_command
from modules.vpn import handle_vpn_command

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
import constants

load_dotenv()

TOKEN = os.getenv("DISCORD_BOT_TOKEN")
try:
    ALLOWED_USER_ID = int(os.getenv("ALLOWED_USER_ID", "0"))
    COMMAND_CHANNEL_ID = int(os.getenv("COMMAND_CHANNEL_ID", "0"))
    ALERT_CHANNEL_ID = int(os.getenv("ALERT_CHANNEL_ID", "0"))
    ADGUARD_CHANNEL_ID = int(os.getenv("ADGUARD_CHANNEL_ID", "0"))
    VPN_CHANNEL_ID = int(os.getenv("VPN_CHANNEL_ID", "0"))
except ValueError:
    ALLOWED_USER_ID = 0
    COMMAND_CHANNEL_ID = 0
    ALERT_CHANNEL_ID = 0
    ADGUARD_CHANNEL_ID = 0
    VPN_CHANNEL_ID = 0

if not TOKEN or not ALLOWED_USER_ID or not COMMAND_CHANNEL_ID or not ALERT_CHANNEL_ID:
    print("CRITICAL: Environment variables misconfigured.")
    sys.exit(1)

# Per-channel command routers (defaults to 0 = channel disabled). The /testall
# lock is checked centrally in on_message so ALL channels pause during a run.
CHANNEL_HANDLERS = {
    COMMAND_CHANNEL_ID: handle_reactive_command,
    ADGUARD_CHANNEL_ID: handle_adguard_command,
    VPN_CHANNEL_ID: handle_vpn_command,
}

intents = discord.Intents.default()
intents.message_content = True
intents.reactions = True
client = discord.Client(intents=intents)

IS_TEST_MODE = "--alert-test" in sys.argv
ALERT_THRESHOLD = constants.ALERT_THRESHOLD

if IS_TEST_MODE:
    try:
        idx = sys.argv.index("--alert-test")
        ALERT_THRESHOLD = float(sys.argv[idx + 1])
        print(f"[TEST] Alert threshold: {ALERT_THRESHOLD}C")
    except (ValueError, IndexError):
        print("ERROR: Syntax: --alert-test <number>")
        sys.exit(1)

# Read directly from sysfs — no subprocess needed
def get_core_temp() -> float:
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return int(f.read()) / 1000.0
    except OSError:
        return 45.0

STATUS_FILE = "/dev/shm/pi-bot/.bot_status.json"

@tasks.loop(seconds=240)
async def sync_bot_presence():
    await client.wait_until_ready()
    try:
        with open(STATUS_FILE) as f:
            status_text = json.load(f).get("text", "Pi Online")
        await client.change_presence(activity=discord.Game(name=status_text))
    except (OSError, json.JSONDecodeError):
        pass

# Track last alert time to avoid spam (cooldown 5 min)
_last_alert_ts = 0.0
ALERTED_SVC_FILE = "/dev/shm/pi-bot/.alerted_services"

@tasks.loop(seconds=60)
async def passive_thermal_monitor():
    global _last_alert_ts
    await client.wait_until_ready()

    # --- Temperature check (with 5-min cooldown) ---
    import time
    temp = get_core_temp()
    if temp >= ALERT_THRESHOLD:
        now = time.monotonic()
        if now - _last_alert_ts >= 300:
            _last_alert_ts = now
            ch = client.get_channel(ALERT_CHANNEL_ID)
            if ch:
                tag = "[TEST INTERCEPT]" if IS_TEST_MODE else "[THERMAL WARNING]"
                await ch.send(
                    f"{tag} Core temp breached threshold!\n"
                    f"Current: {temp:.1f}C (Threshold: {ALERT_THRESHOLD:.1f}C)\n"
                    f"Run /cooldown to reduce heat."
                )
                # Auto-trigger AI diagnosis on overheat (fire-and-forget)
                ai_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "ai_debug.py")
                await asyncio.create_subprocess_exec(
                    "python3", "-u", ai_script, "--auto-error",
                    f"Overheat: core temp {temp:.1f}C breached threshold {ALERT_THRESHOLD:.1f}C. Diagnose heat sources and suggest cooldown.",
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
                )

    # --- Failed services check (alerts on NEW failures + recoveries) ---
    current_failed = set()
    try:
        r = subprocess.run(
            ["systemctl", "list-units", "--state=failed", "--no-legend", "--plain"],
            capture_output=True, text=True, timeout=5
        )
        for line in r.stdout.splitlines():
            parts = line.split()
            if parts and "clamav" not in parts[0]:
                current_failed.add(parts[0])
    except Exception:
        pass

    prev_failed = set()
    try:
        with open(ALERTED_SVC_FILE) as f:
            prev_failed = set(json.load(f))
    except (OSError, json.JSONDecodeError):
        pass

    new_failed = current_failed - prev_failed
    recovered = prev_failed - current_failed

    ch = client.get_channel(ALERT_CHANNEL_ID)
    if ch:
        if new_failed:
            svc_list = "\n".join(f"  | {s}" for s in sorted(new_failed))
            await ch.send(f"**Service Alert** - {len(new_failed)} new failure(s):\n{svc_list}")
            # Auto-run AI diagnosis for newly failed services
            services_str = ", ".join(sorted(new_failed))
            auto_prompt = f"Automated alert: service(s) {services_str} just failed. Review system state and diagnose what went wrong. Suggest fixes."
            script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "ai_debug.py")
            # Fire-and-forget: ai_debug.py --auto-error posts its Auto-Diagnosis
            # to the AI-debugger (REPORT) channel itself; echoing STDOUT here
            # would duplicate the same diagnosis into the news/alert channel.
            try:
                await asyncio.create_subprocess_exec(
                    "python3", "-u", script_path, "--auto-error", auto_prompt,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL
                )
            except Exception:
                pass
        if recovered:
            svc_list = "\n".join(f"  | {s}" for s in sorted(recovered))
            await ch.send(f"**Service Recovered** - {len(recovered)} service(s) back online:\n{svc_list}")

    try:
        with open(ALERTED_SVC_FILE, "w") as f:
            json.dump(sorted(current_failed), f)
    except OSError:
        pass

@client.event
async def on_ready():
    print(f"Bot online as {client.user}")
    os.makedirs("/dev/shm/pi-bot", exist_ok=True)
    if os.path.exists("/home/alon/secure-pi-bot/.skip_autostart"):
        print("AUTOSTART PAUSED (.skip_autostart) -- minimal mode, no monitoring tasks. /bootresume to restore.")
        return
    if not passive_thermal_monitor.is_running():
        passive_thermal_monitor.start()
    if not sync_bot_presence.is_running():
        sync_bot_presence.start()

    # If a manual command rebooted the Pi, announce that scripts have loaded.
    notify_flag = "/home/alon/secure-pi-bot/.reboot_notify"
    if os.path.exists(notify_flag):
        try:
            os.remove(notify_flag)
        except OSError:
            pass
        ch = client.get_channel(COMMAND_CHANNEL_ID)
        if ch:
            try:
                await ch.send("✅ Pi back online — scripts loaded.")
            except Exception:
                pass

@client.event
async def on_message(message):
    if message.author.id == client.user.id:
        return
    if message.author.id != ALLOWED_USER_ID:
        return
    handler = CHANNEL_HANDLERS.get(message.channel.id)
    if not handler:
        return
    if os.path.exists("/dev/shm/pi-bot/.testall_running"):
        await message.channel.send("⏳ /testall is running -- commands paused until it finishes.")
        return
    await handler(client, message)

if __name__ == "__main__":
    client.run(TOKEN)