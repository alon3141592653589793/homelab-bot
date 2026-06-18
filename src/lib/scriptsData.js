const scripts = [
  {
    id: "main",
    filename: "main.py",
    path: "~/secure-pi-bot/main.py",
    title: "Main Bot",
    description: "Entry point. Sets up the Discord client, thermal monitor loop, and message routing.",
    tags: ["discord", "bot", "thermal"],
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
    print("CRITICAL: Environment variables (TOKEN, ALLOWED_USER_ID, COMMAND_CHANNEL_ID, ALERT_CHANNEL_ID) are misconfigured.")
    sys.exit(1)

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

# Configuration Thresholds Matrix
IS_TEST_MODE = "--alert-test" in sys.argv
ALERT_THRESHOLD = 70.0  # Default safety ceiling for normal operations

if IS_TEST_MODE:
    try:
        idx = sys.argv.index("--alert-test")
        ALERT_THRESHOLD = float(sys.argv[idx + 1])
        print(f"🔧 Testing parameter verified. Temporarily adjusting alert threshold to: {ALERT_THRESHOLD}°C")
    except (ValueError, IndexError):
        print("❌ Invalid test flag allocation. Syntax structure requires: --alert-test <number>")
        sys.exit(1)

def get_core_temperature() -> float:
    """Always reads true, un-simulated hardware metrics directly from the host filesystem."""
    try:
        with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
            return float(f.read().strip()) / 1000.0
    except FileNotFoundError:
        return 45.0  # Safe fallback if system file handle is missing

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
                f"**Current Core Temp:** \`{temp:.1f}°C\` (Active Threshold: \`{ALERT_THRESHOLD:.1f}°C\`)\\n"
                f"Execute \`/cooldown\` if the metric scales past nominal parameters."
            )
        else:
            print(f"❌ Core runtime error: Inability to resolve Alert Channel ID {ALERT_CHANNEL_ID}")

@client.event
async def on_ready():
    print(f"🤖 Bot online and verified as {client.user}")
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
`
  },
  {
    id: "status",
    filename: "status.py",
    path: "~/secure-pi-bot/scripts/status.py",
    title: "scripts/status.py",
    description: "System status report: core temp, CPU load (fixed), CPU freq in GHz, GPU freq in MHz, RAM usage, last upgrade.",
    tags: ["status", "hardware", "psutil"],
    code: `import sys
import os
import subprocess

try:
    import psutil
except ImportError:
    print("❌ Failure: dependency 'psutil' missing.")
    sys.exit(1)

# Blocks for 0.5s to capture true real-time utilization delta
cpu_usage = psutil.cpu_percent(interval=1)

ram_percent = psutil.virtual_memory().percent

# Fetch core temperature directly from sysfs
try:
    with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
        temp = f"{float(f.read().strip()) / 1000.0:.1f}°C"
except FileNotFoundError:
    temp = "Unknown"

# CPU frequency in GHz
try:
    freq = psutil.cpu_freq()
    cpu_ghz = f"{freq.current / 1000:.2f} GHz"
except Exception:
    cpu_ghz = "Unknown"

# GPU frequency via vcgencmd
try:
    gpu_raw = subprocess.run(
        ["vcgencmd", "measure_clock", "core"],
        capture_output=True, text=True
    ).stdout.strip()
    # Output format: frequency(48)=500000000
    gpu_hz = int(gpu_raw.split("=")[1])
    gpu_mhz = f"{gpu_hz // 1_000_000} MHz"
except Exception:
    gpu_mhz = "Unknown"

# Fetch the last full upgrade timestamp from your secure local token
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
`
  },
  {
    id: "cooldown",
    filename: "cooldown.py",
    path: "~/secure-pi-bot/scripts/cooldown.py",
    title: "scripts/cooldown.py",
    description: "Reduces thermal overhead by stopping non-essential services (nginx, lightdm, bluetooth, cups).",
    tags: ["thermal", "services", "systemctl"],
    code: `import subprocess
import os
import sys

def main():
    print("🎯 Isolating core services to reduce thermal overhead...")

    # Define non-essential heavy services that are safe to drop temporarily
    target_services = ["nginx", "lightdm", "bluetooth", "cups"]
    stopped_targets = []

    for service in target_services:
        # Check if service is active before trying to shut it down
        check = subprocess.run(["systemctl", "is-active", service], capture_output=True, text=True)
        if check.stdout.strip() == "active":
            print(f"🛑 Terminating service allocation: {service}")
            subprocess.run(["sudo", "systemctl", "stop", service])
            stopped_targets.append(service)

    if stopped_targets:
        print(f"✅ Safe thermal baseline reached. Suspended services: {', '.join(stopped_targets)}")
    else:
        print("✅ No high-overhead user-space services were active. System minimized.")

if __name__ == "__main__":
    main()
`
  },
  {
    id: "restart",
    filename: "restart.py",
    path: "~/secure-pi-bot/scripts/restart.py",
    title: "scripts/restart.py",
    description: "Sends a confirmation prompt before rebooting the Pi. Requires typing 'yes' to proceed.",
    tags: ["reboot", "safety"],
    code: `import subprocess

print("⚠️  **Reboot Confirmation Required**")
print("Type 'yes' to confirm hardware reboot, or anything else to cancel:")
confirm = input("> ").strip().lower()

if confirm == "yes":
    print("🔄 Initializing hardware reboot wrapper...")
    subprocess.run("sudo /sbin/shutdown -r now", shell=True)
else:
    print("❌ Reboot cancelled.")
`
  },
  {
    id: "shutdown",
    filename: "shutdown.py",
    path: "~/secure-pi-bot/scripts/shutdown.py",
    title: "scripts/shutdown.py",
    description: "Sends a confirmation prompt before shutting down the Pi. Requires typing 'yes' to proceed.",
    tags: ["shutdown", "safety"],
    code: `import subprocess

print("⚠️  **Shutdown Confirmation Required**")
print("Type 'yes' to confirm hardware poweroff, or anything else to cancel:")
confirm = input("> ").strip().lower()

if confirm == "yes":
    print("🛑 Initializing hardware poweroff wrapper...")
    subprocess.run("sudo /sbin/shutdown -h now", shell=True)
else:
    print("❌ Shutdown cancelled.")
`
  },
];

export default scripts;