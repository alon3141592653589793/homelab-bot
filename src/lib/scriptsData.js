const scripts = [
  {
    id: "main",
    filename: "main.py",
    path: "~/secure-pi-bot/main.py",
    description: "Listener only — receives Discord messages, passes them to the reactive module for dispatch.",
    tags: ["discord", "bot", "listener"],
    code: `import os
import sys
from dotenv import load_dotenv
import discord
from discord.ext import tasks
from modules.reactive import handle_reactive_command

load_dotenv()

TOKEN = os.getenv("DISCORD_BOT_TOKEN")
try:
    ALLOWED_USER_ID = int(os.getenv("ALLOWED_USER_ID", "0"))
    COMMAND_CHANNEL_ID = int(os.getenv("COMMAND_CHANNEL_ID", "0"))
    ALERT_CHANNEL_ID = int(os.getenv("ALERT_CHANNEL_ID", "0"))
except ValueError:
    ALLOWED_USER_ID = 0
    COMMAND_CHANNEL_ID = 0
    ALERT_CHANNEL_ID = 0

if not TOKEN or ALLOWED_USER_ID == 0 or COMMAND_CHANNEL_ID == 0 or ALERT_CHANNEL_ID == 0:
    print("CRITICAL: Environment variables misconfigured.")
    sys.exit(1)

intents = discord.Intents.default()
intents.message_content = True
intents.reactions = True
client = discord.Client(intents=intents)

IS_TEST_MODE = "--alert-test" in sys.argv
ALERT_THRESHOLD = 70.0

if IS_TEST_MODE:
    try:
        idx = sys.argv.index("--alert-test")
        ALERT_THRESHOLD = float(sys.argv[idx + 1])
        print(f"🔧 Testing parameter verified. Alert threshold: {ALERT_THRESHOLD}°C")
    except (ValueError, IndexError):
        print("❌ Invalid --alert-test flag. Syntax: --alert-test <number>")
        sys.exit(1)

def get_core_temperature() -> float:
    try:
        with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
            return float(f.read().strip()) / 1000.0
    except FileNotFoundError:
        return 45.0

@tasks.loop(seconds=60)
async def passive_thermal_monitor():
    await client.wait_until_ready()
    temp = get_core_temperature()
    if temp >= ALERT_THRESHOLD:
        alert_channel = client.get_channel(ALERT_CHANNEL_ID)
        if alert_channel:
            tag = "[TEST INTERCEPT]" if IS_TEST_MODE else "[🚨 THERMAL WARNING]"
            await alert_channel.send(
                f"⚠️ **{tag}** Raspberry Pi core temperature has breached the threshold!\\n"
                f"**Current Core Temp:** \`{temp:.1f}°C\` (Threshold: \`{ALERT_THRESHOLD:.1f}°C\`)\\n"
                f"Execute \`/cooldown\` to reduce heat."
            )

@client.event
async def on_ready():
    print(f"🤖 Bot online as {client.user}")
    if not passive_thermal_monitor.is_running():
        passive_thermal_monitor.start()

@client.event
async def on_message(message):
    if message.author.id == client.user.id:
        return
    if message.channel.id != COMMAND_CHANNEL_ID:
        return
    if message.author.id != ALLOWED_USER_ID:
        return
    await handle_reactive_command(message)

if __name__ == "__main__":
    client.run(TOKEN)
`,
  },
  {
    id: "reactive",
    filename: "reactive.py",
    path: "~/secure-pi-bot/modules/reactive.py",
    description: "Command dispatcher — routes /commands to mini-scripts. Handles ✅/❌ reaction confirmation for /restart and /shutdown.",
    tags: ["dispatcher", "confirmation", "discord"],
    code: `import subprocess
import asyncio
import os

SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")

async def handle_reactive_command(message):
    content = message.content.strip().lower()

    if content == "/status":
        await run_script(message, "status.py", "Querying system status...")
    elif content == "/cooldown":
        await run_script(message, "cooldown.py", "Running thermal cooldown...")
    elif content == "/restart":
        await confirm_and_run(message, "restart.py", "🔄 Reboot", "This will **restart** the Raspberry Pi immediately.")
    elif content == "/shutdown":
        await confirm_and_run(message, "shutdown.py", "🛑 Shutdown", "This will **power off** the Pi. You will need physical access to turn it back on.")
    elif content == "/ramlog":
        await run_script(message, "ram_logger.py", "Logging current RAM snapshot...")
    elif content == "/ramreport":
        await run_script(message, "ram_report.py", "Analyzing RAM usage history...")
    elif content == "/help":
        await message.channel.send(
            "**Available Commands:**\\n"
            "\`/status\` — System metrics\\n"
            "\`/cooldown\` — Stop non-essential services\\n"
            "\`/restart\` — Reboot Pi (requires confirmation)\\n"
            "\`/shutdown\` — Power off Pi (requires confirmation)\\n"
            "\`/ramlog\` — Take a RAM snapshot\\n"
            "\`/ramreport\` — Analyze RAM history\\n"
            "\`/help\` — This message"
        )


async def run_script(message, script_name, status_msg):
    script_path = os.path.join(SCRIPTS_DIR, script_name)
    await message.channel.send(f"⏳ {status_msg}")
    try:
        result = subprocess.run(
            ["python3", script_path],
            capture_output=True, text=True, timeout=30
        )
        output = result.stdout.strip() or result.stderr.strip() or "No output."
        if len(output) > 1900:
            output = output[:1900] + "\\n[truncated]"
        await message.channel.send(output)
    except subprocess.TimeoutExpired:
        await message.channel.send("❌ Script timed out after 30 seconds.")
    except Exception as e:
        await message.channel.send(f"❌ Script error: {e}")


async def confirm_and_run(message, script_name, action_name, description):
    confirm_msg = await message.channel.send(
        f"⚠️ **{action_name} — Confirmation Required**\\n"
        f"{description}\\n\\n"
        f"React with ✅ within 30 seconds to confirm, or ❌ to cancel."
    )
    await confirm_msg.add_reaction("✅")
    await confirm_msg.add_reaction("❌")

    def check(reaction, user):
        return (
            user.id == message.author.id
            and reaction.message.id == confirm_msg.id
            and str(reaction.emoji) in ["✅", "❌"]
        )

    try:
        reaction, user = await message.client.wait_for("reaction_add", timeout=30.0, check=check)
        if str(reaction.emoji) == "✅":
            await message.channel.send(f"✅ {action_name} confirmed. Executing...")
            await run_script(message, script_name, f"Running {script_name}...")
        else:
            await message.channel.send(f"❌ {action_name} cancelled.")
    except asyncio.TimeoutError:
        await message.channel.send(f"⏰ {action_name} timed out. Cancelled.")
`,
  },
  {
    id: "status",
    filename: "status.py",
    path: "~/secure-pi-bot/scripts/status.py",
    description: "System metrics: core temp, CPU load (1s sample), CPU freq GHz, GPU freq MHz, RAM usage, last upgrade.",
    tags: ["status", "hardware", "psutil"],
    code: `import sys
import os
import subprocess

try:
    import psutil
except ImportError:
    print("❌ Failure: dependency 'psutil' missing.")
    sys.exit(1)

cpu_usage = psutil.cpu_percent(interval=1)
ram_percent = psutil.virtual_memory().percent

try:
    with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
        temp = f"{float(f.read().strip()) / 1000.0:.1f}°C"
except FileNotFoundError:
    temp = "Unknown"

try:
    freq = psutil.cpu_freq()
    cpu_ghz = f"{freq.current / 1000:.2f} GHz"
except Exception:
    cpu_ghz = "Unknown"

try:
    gpu_raw = subprocess.run(
        ["vcgencmd", "measure_clock", "core"],
        capture_output=True, text=True
    ).stdout.strip()
    gpu_hz = int(gpu_raw.split("=")[1])
    gpu_mhz = f"{gpu_hz // 1_000_000} MHz"
except Exception:
    gpu_mhz = "Unknown"

try:
    with open("/home/alon/.secrets/last_upgrade.txt", "r") as f:
        last_upgrade = f.read().strip()
except FileNotFoundError:
    last_upgrade = "Unknown"

print(
    f"📊 **Pi Status Metrics**\\n"
    f"**Core Temp:** {temp}\\n"
    f"**CPU Load:** {cpu_usage}%\\n"
    f"**CPU Speed:** {cpu_ghz}\\n"
    f"**GPU Speed:** {gpu_mhz}\\n"
    f"**Memory Usage:** {ram_percent}%\\n"
    f"**Last Upgrade:** {last_upgrade}"
)
`,
  },
  {
    id: "cooldown",
    filename: "cooldown.py",
    path: "~/secure-pi-bot/scripts/cooldown.py",
    description: "Stops non-essential services to reduce thermal load.",
    tags: ["thermal", "services"],
    code: `import subprocess

def main():
    print("🎯 Isolating core services to reduce thermal overhead...")
    target_services = ["nginx", "lightdm", "bluetooth", "cups"]
    stopped_targets = []

    for service in target_services:
        check = subprocess.run(["systemctl", "is-active", service], capture_output=True, text=True)
        if check.stdout.strip() == "active":
            print(f"🛑 Terminating service: {service}")
            subprocess.run(["sudo", "systemctl", "stop", service])
            stopped_targets.append(service)

    if stopped_targets:
        print(f"✅ Suspended services: {', '.join(stopped_targets)}")
    else:
        print("✅ No high-overhead services were active. System minimized.")

if __name__ == "__main__":
    main()
`,
  },
  {
    id: "restart",
    filename: "restart.py",
    path: "~/secure-pi-bot/scripts/restart.py",
    description: "Reboots the Pi. Confirmation is handled by the reactive module before this script is called.",
    tags: ["reboot"],
    code: `import subprocess
print("🔄 Initializing hardware reboot wrapper...")
subprocess.run("sudo /sbin/shutdown -r now", shell=True)
`,
  },
  {
    id: "shutdown",
    filename: "shutdown.py",
    path: "~/secure-pi-bot/scripts/shutdown.py",
    description: "Powers off the Pi. Confirmation is handled by the reactive module before this script is called.",
    tags: ["shutdown"],
    code: `import subprocess
print("🛑 Initializing hardware poweroff wrapper...")
subprocess.run("sudo /sbin/shutdown -h now", shell=True)
`,
  },
  {
    id: "ram-logger",
    filename: "ram_logger.py",
    path: "~/secure-pi-bot/scripts/ram_logger.py",
    description: "Snapshots bot RSS + system RAM to a JSONL log. Use via /ramlog or cron: */5 * * * * python3 ~/secure-pi-bot/scripts/ram_logger.py",
    tags: ["memory", "logging"],
    code: `import os
import sys
import json
from datetime import datetime

LOG_FILE = "/home/alon/secure-pi-bot/logs/ram_usage.jsonl"

try:
    import psutil
except ImportError:
    print("❌ psutil required.")
    sys.exit(1)

os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)

bot_rss_mb = None
for proc in psutil.process_iter(['pid', 'cmdline', 'memory_info']):
    try:
        cmdline = ' '.join(proc.info['cmdline'] or [])
        if 'main.py' in cmdline and 'python' in cmdline.lower():
            bot_rss_mb = proc.info['memory_info'].rss / (1024 * 1024)
            break
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        continue

system_ram = psutil.virtual_memory()

entry = {
    "ts": datetime.now().isoformat(),
    "bot_rss_mb": round(bot_rss_mb, 2) if bot_rss_mb else None,
    "sys_pct": system_ram.percent,
    "sys_used_mb": round(system_ram.used / (1024 * 1024), 1),
    "sys_total_mb": round(system_ram.total / (1024 * 1024), 1),
}

with open(LOG_FILE, "a") as f:
    f.write(json.dumps(entry) + "\\n")

bot_str = f"{entry['bot_rss_mb']} MB" if entry['bot_rss_mb'] else "not found"
print(f"📝 RAM snapshot logged — Bot RSS: {bot_str} | System: {entry['sys_pct']}%")
`,
  },
  {
    id: "ram-report",
    filename: "ram_report.py",
    path: "~/secure-pi-bot/scripts/ram_report.py",
    description: "Analyzes RAM log history. Detects sessions (restarts via time gaps), shows drift and per-session breakdown.",
    tags: ["memory", "analysis"],
    code: `import json
import os
import sys
from datetime import datetime

LOG_FILE = "/home/alon/secure-pi-bot/logs/ram_usage.jsonl"

if not os.path.exists(LOG_FILE):
    print("❌ No RAM log data found. Run /ramlog first or set up cron.")
    sys.exit(0)

entries = []
with open(LOG_FILE, "r") as f:
    for line in f:
        line = line.strip()
        if line:
            entries.append(json.loads(line))

if not entries:
    print("❌ Log file is empty.")
    sys.exit(0)

# Sessions: gap > 5 minutes = restart
sessions = []
current_session = [entries[0]]
for i in range(1, len(entries)):
    prev_t = datetime.fromisoformat(entries[i-1]["ts"])
    curr_t = datetime.fromisoformat(entries[i]["ts"])
    if (curr_t - prev_t).total_seconds() > 300:
        sessions.append(current_session)
        current_session = [entries[i]]
    else:
        current_session.append(entries[i])
sessions.append(current_session)

bot_readings = [e["bot_rss_mb"] for e in entries if e.get("bot_rss_mb") is not None]

print(f"📊 **RAM Analysis Report**")
print(f"**Entries:** {len(entries)} | **Sessions:** {len(sessions)} (restarts: {len(sessions) - 1})")
print(f"**Span:** {entries[0]['ts'][:16]} -> {entries[-1]['ts'][:16]}")
print()

if bot_readings:
    avg = sum(bot_readings) / len(bot_readings)
    drift = bot_readings[-1] - bot_readings[0]
    print(f"**Bot Memory (RSS):**")
    print(f"  Min: {min(bot_readings):.1f} MB | Max: {max(bot_readings):.1f} MB | Avg: {avg:.1f} MB")
    print(f"  Drift: {'+' if drift >= 0 else ''}{drift:.1f} MB")
    if drift > 10:
        print(f"  ⚠️ Possible memory leak — RSS grew {drift:.1f} MB")
    else:
        print(f"  ✅ Memory looks stable")
else:
    print("**Bot Memory:** No readings (bot process not found during logging)")

print()
sys_readings = [e["sys_pct"] for e in entries]
print(f"**System RAM:** Min: {min(sys_readings):.1f}% | Max: {max(sys_readings):.1f}% | Avg: {sum(sys_readings)/len(sys_readings):.1f}%")

if len(sessions) > 1:
    print()
    print(f"**Per-Session Breakdown:**")
    for i, s in enumerate(sessions):
        bot_s = [e["bot_rss_mb"] for e in s if e.get("bot_rss_mb") is not None]
        start = s[0]["ts"][:16]
        end = s[-1]["ts"][:16]
        if bot_s:
            print(f"  #{i+1}: {start} -> {end} | {bot_s[0]:.1f} -> {bot_s[-1]:.1f} MB ({len(s)} pts)")
        else:
            print(f"  #{i+1}: {start} -> {end} | no bot data ({len(s)} pts)")
`,
  },
];

export default scripts;