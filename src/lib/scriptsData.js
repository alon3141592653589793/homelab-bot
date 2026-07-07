const scripts = [
  {
    id: "main",
    filename: "main.py",
    path: "~/secure-pi-bot/main.py",
    description: "Listener only — receives Discord messages and passes them to the reactive module.",
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
        print(f"[TEST] Alert threshold set to: {ALERT_THRESHOLD}C")
    except (ValueError, IndexError):
        print("ERROR: Invalid --alert-test flag. Syntax: --alert-test <number>")
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
            tag = "[TEST INTERCEPT]" if IS_TEST_MODE else "[THERMAL WARNING]"
            await alert_channel.send(
                f"{tag} Core temperature breached threshold!\\n"
                f"Current: {temp:.1f}C (Threshold: {ALERT_THRESHOLD:.1f}C)\\n"
                f"Run /cooldown to reduce heat."
            )

@client.event
async def on_ready():
    print(f"Bot online as {client.user}")
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
    await handle_reactive_command(client, message)

if __name__ == "__main__":
    client.run(TOKEN)
`,
  },
  {
    id: "reactive",
    filename: "reactive.py",
    path: "~/secure-pi-bot/modules/reactive.py",
    description: "Thin command router — maps /commands to scripts or confirmation flows. All execution logic is in runner.py.",
    tags: ["router", "dispatcher"],
    code: `from modules.runner import run_script, confirm_and_run

async def handle_reactive_command(client, message):
    content = message.content.strip().lower()

    if content == "/status":
        await run_script(message, "status.py", "Querying system status...")

    elif content == "/cooldown":
        await run_script(message, "cooldown.py", "Running thermal cooldown...")

    elif content == "/restart":
        await confirm_and_run(client, message, "restart.py", "Reboot", "This will restart the Pi immediately.")

    elif content == "/shutdown":
        await confirm_and_run(client, message, "shutdown.py", "Shutdown", "This will power off the Pi. Physical access required to turn it back on.")

    elif content == "/ramlog":
        await run_script(message, "ram_logger.py", "Logging RAM snapshot...")

    elif content == "/ramreport":
        await run_script(message, "ram_report.py", "Analyzing RAM history...")

    elif content == "/profile":
        await run_script(message, "profile_status.py", "Checking current performance profile...")

    elif content == "/setprofile restricted":
        await run_script(message, "set_profile_restricted.py", "Applying restricted profile...")

    elif content == "/setprofile unlimited":
        await run_script(message, "set_profile_unlimited.py", "Applying unlimited profile...")

    elif content == "/help":
        await message.channel.send(
            "Available commands:\\n"
            "/status               - System metrics\\n"
            "/cooldown             - Stop non-essential services\\n"
            "/restart              - Reboot Pi (requires confirmation)\\n"
            "/shutdown             - Power off Pi (requires confirmation)\\n"
            "/ramlog               - Take a RAM snapshot\\n"
            "/ramreport            - Analyze RAM history\\n"
            "/profile              - Show current performance profile\\n"
            "/setprofile restricted - Force restricted profile (600 MHz, powersave)\\n"
            "/setprofile unlimited  - Force unlimited profile (1.7 GHz, schedutil)\\n"
            "/help                 - This message"
        )
`,
  },
  {
    id: "runner",
    filename: "runner.py",
    path: "~/secure-pi-bot/modules/runner.py",
    description: "Execution helpers — run_script runs a subprocess and sends output to Discord; confirm_and_run adds reaction-based confirmation before executing.",
    tags: ["runner", "confirmation", "discord"],
    code: `import subprocess
import asyncio
import os

SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")


async def run_script(message, script_name, status_msg):
    script_path = os.path.join(SCRIPTS_DIR, script_name)
    await message.channel.send(status_msg)
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
        await message.channel.send("Script timed out after 30 seconds.")
    except Exception as e:
        await message.channel.send(f"Script error: {e}")


async def confirm_and_run(client, message, script_name, action_name, description):
    confirm_msg = await message.channel.send(
        f"[{action_name.upper()} - CONFIRMATION REQUIRED]\\n"
        f"{description}\\n\\n"
        f"React with [checkmark] to confirm or [X] to cancel. Timeout: 30 seconds."
    )
    await confirm_msg.add_reaction("\\u2705")
    await confirm_msg.add_reaction("\\u274c")

    def check(reaction, user):
        return (
            user.id == message.author.id
            and reaction.message.id == confirm_msg.id
            and str(reaction.emoji) in ["\\u2705", "\\u274c"]
        )

    try:
        reaction, user = await client.wait_for("reaction_add", timeout=30.0, check=check)
        if str(reaction.emoji) == "\\u2705":
            await message.channel.send(f"{action_name} confirmed. Executing...")
            await run_script(message, script_name, f"Running {script_name}...")
        else:
            await message.channel.send(f"{action_name} cancelled.")
    except asyncio.TimeoutError:
        await message.channel.send(f"{action_name} confirmation timed out. Cancelled.")
`,
  },
  {
    id: "status",
    filename: "status.py",
    path: "~/secure-pi-bot/scripts/status.py",
    description: "Outputs system metrics: core temp, CPU load, CPU freq, GPU freq, RAM usage, last upgrade.",
    tags: ["status", "hardware", "psutil"],
    code: `import sys
import os
import subprocess

try:
    import psutil
except ImportError:
    print("FAILURE: dependency 'psutil' missing.")
    sys.exit(1)

cpu_usage = psutil.cpu_percent(interval=1)
ram_percent = psutil.virtual_memory().percent

try:
    with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
        temp = f"{float(f.read().strip()) / 1000.0:.1f}C"
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
    f"**Pi Status Metrics**\\n"
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
    print("Isolating core services to reduce thermal overhead...")
    target_services = ["nginx", "lightdm", "bluetooth", "cups"]
    stopped = []

    for service in target_services:
        check = subprocess.run(["systemctl", "is-active", service], capture_output=True, text=True)
        if check.stdout.strip() == "active":
            print(f"Stopping service: {service}")
            subprocess.run(["sudo", "systemctl", "stop", service])
            stopped.append(service)

    if stopped:
        print(f"Done. Suspended: {', '.join(stopped)}")
    else:
        print("No high-overhead services were active.")

if __name__ == "__main__":
    main()
`,
  },
  {
    id: "restart",
    filename: "restart.py",
    path: "~/secure-pi-bot/scripts/restart.py",
    description: "Reboots the Pi. Only called after confirmation in runner.py.",
    tags: ["reboot"],
    code: `import subprocess
print("Initializing hardware reboot...")
subprocess.run("sudo /sbin/shutdown -r now", shell=True)
`,
  },
  {
    id: "shutdown",
    filename: "shutdown.py",
    path: "~/secure-pi-bot/scripts/shutdown.py",
    description: "Powers off the Pi. Only called after confirmation in runner.py.",
    tags: ["shutdown"],
    code: `import subprocess
print("Initializing hardware poweroff...")
subprocess.run("sudo /sbin/shutdown -h now", shell=True)
`,
  },
  {
    id: "ram-logger",
    filename: "ram_logger.py",
    path: "~/secure-pi-bot/scripts/ram_logger.py",
    description: "Appends a RAM snapshot to the log file. Use via /ramlog or cron: */5 * * * * python3 ~/secure-pi-bot/scripts/ram_logger.py",
    tags: ["memory", "logging"],
    code: `import os
import sys
import json
from datetime import datetime

LOG_FILE = "/home/alon/secure-pi-bot/logs/ram_usage.jsonl"

try:
    import psutil
except ImportError:
    print("FAILURE: psutil required.")
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
print(f"RAM snapshot logged -- Bot RSS: {bot_str} | System: {entry['sys_pct']}%")
`,
  },
  {
    id: "ram-report",
    filename: "ram_report.py",
    path: "~/secure-pi-bot/scripts/ram_report.py",
    description: "Reads the RAM log, detects sessions via time gaps (restarts), and reports drift, min/max/avg.",
    tags: ["memory", "analysis"],
    code: `import json
import os
import sys
from datetime import datetime

LOG_FILE = "/home/alon/secure-pi-bot/logs/ram_usage.jsonl"

if not os.path.exists(LOG_FILE):
    print("No RAM log found. Run /ramlog first or set up cron.")
    sys.exit(0)

entries = []
with open(LOG_FILE, "r") as f:
    for line in f:
        line = line.strip()
        if line:
            entries.append(json.loads(line))

if not entries:
    print("Log file is empty.")
    sys.exit(0)

# Detect sessions -- gaps > 5 minutes = restart
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

print("RAM Analysis Report")
print(f"Entries: {len(entries)} | Sessions: {len(sessions)} (restarts: {len(sessions) - 1})")
print(f"Span: {entries[0]['ts'][:16]} -> {entries[-1]['ts'][:16]}")
print()

if bot_readings:
    avg = sum(bot_readings) / len(bot_readings)
    drift = bot_readings[-1] - bot_readings[0]
    print("Bot Memory (RSS):")
    print(f"  Min: {min(bot_readings):.1f} MB | Max: {max(bot_readings):.1f} MB | Avg: {avg:.1f} MB")
    print(f"  Drift: {'+' if drift >= 0 else ''}{drift:.1f} MB")
    if drift > 10:
        print(f"  WARNING: Possible memory leak -- RSS grew {drift:.1f} MB")
    else:
        print(f"  OK: Memory looks stable")
else:
    print("Bot Memory: No readings (bot process not found during logging)")

print()
sys_readings = [e["sys_pct"] for e in entries]
print(f"System RAM: Min {min(sys_readings):.1f}% | Max {max(sys_readings):.1f}% | Avg {sum(sys_readings)/len(sys_readings):.1f}%")

if len(sessions) > 1:
    print()
    print("Per-Session Breakdown:")
    for i, s in enumerate(sessions):
        bot_s = [e["bot_rss_mb"] for e in s if e.get("bot_rss_mb") is not None]
        start = s[0]["ts"][:16]
        end = s[-1]["ts"][:16]
        if bot_s:
            print(f"  Session {i+1}: {start} -> {end} | {bot_s[0]:.1f} -> {bot_s[-1]:.1f} MB ({len(s)} pts)")
        else:
            print(f"  Session {i+1}: {start} -> {end} | no bot data ({len(s)} pts)")
`,
  },
  {
    id: "set-profile-restricted",
    filename: "set_profile_restricted.py",
    path: "~/secure-pi-bot/scripts/set_profile_restricted.py",
    description: "Applies restricted profile: 600 MHz max, powersave governor. Physically cannot exceed 60C even at 38C ambient. Also writes a state file so profile_scheduler.py knows a manual override is active.",
    tags: ["performance", "thermal", "cpu"],
    code: `import subprocess
import sys

GOVERNOR = "powersave"
MAX_FREQ = "600000"
STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"
CPU_CORES = 4

def write_sysfs(path, value):
    result = subprocess.run(["sudo", "tee", path], input=value, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"FAILED to write {path}: {result.stderr.strip()}")
        sys.exit(1)

for core in range(CPU_CORES):
    write_sysfs(f"/sys/devices/system/cpu/cpu{core}/cpufreq/scaling_governor", GOVERNOR)
    write_sysfs(f"/sys/devices/system/cpu/cpu{core}/cpufreq/scaling_max_freq", MAX_FREQ)

with open(STATE_FILE, "w") as f:
    f.write("restricted")

print(
    "**Profile: RESTRICTED applied**\\n"
    f"Governor: {GOVERNOR}\\n"
    f"Max freq: {int(MAX_FREQ) // 1000} MHz\\n"
    "Thermal ceiling: physically capped below 60C"
)
`,
  },
  {
    id: "set-profile-unlimited",
    filename: "set_profile_unlimited.py",
    path: "~/secure-pi-bot/scripts/set_profile_unlimited.py",
    description: "Applies unlimited profile: 1.7 GHz max, schedutil governor. Also clears the manual override state file so the scheduler resumes auto-switching.",
    tags: ["performance", "cpu"],
    code: `import subprocess
import sys
import os

GOVERNOR = "schedutil"
MAX_FREQ = "1700000"
STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"
CPU_CORES = 4

def write_sysfs(path, value):
    result = subprocess.run(["sudo", "tee", path], input=value, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"FAILED to write {path}: {result.stderr.strip()}")
        sys.exit(1)

for core in range(CPU_CORES):
    write_sysfs(f"/sys/devices/system/cpu/cpu{core}/cpufreq/scaling_governor", GOVERNOR)
    write_sysfs(f"/sys/devices/system/cpu/cpu{core}/cpufreq/scaling_max_freq", MAX_FREQ)

if os.path.exists(STATE_FILE):
    os.remove(STATE_FILE)

print(
    "**Profile: UNLIMITED applied**\\n"
    f"Governor: {GOVERNOR}\\n"
    f"Max freq: {int(MAX_FREQ) // 1000} MHz\\n"
    "Auto-scheduler override cleared. Scheduler will resume at next cron tick."
)
`,
  },
  {
    id: "profile-status",
    filename: "profile_status.py",
    path: "~/secure-pi-bot/scripts/profile_status.py",
    description: "Reads the current governor and max freq from sysfs and reports the active profile.",
    tags: ["performance", "status"],
    code: `import os

STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"

try:
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor") as f:
        governor = f.read().strip()
except FileNotFoundError:
    governor = "unknown"

try:
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
        max_freq_khz = int(f.read().strip())
except FileNotFoundError:
    max_freq_khz = 0

try:
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq") as f:
        cur_freq_khz = int(f.read().strip())
except FileNotFoundError:
    cur_freq_khz = 0

if max_freq_khz <= 600000:
    profile_name = "RESTRICTED"
else:
    profile_name = "UNLIMITED"

override_active = os.path.exists(STATE_FILE)
override_str = "Manual override active (scheduler paused)" if override_active else "Auto-scheduler active"

print(
    f"**Performance Profile: {profile_name}**\\n"
    f"Governor: {governor}\\n"
    f"Max freq: {max_freq_khz // 1000} MHz\\n"
    f"Current freq: {cur_freq_khz // 1000} MHz\\n"
    f"Scheduler: {override_str}"
)
`,
  },
  {
    id: "profile-scheduler",
    filename: "profile_scheduler.py",
    path: "~/secure-pi-bot/scripts/profile_scheduler.py",
    description: "Auto-switches profiles by time. Restricted 23:00-07:00, unlimited otherwise. Skips if manual override file exists. Add to existing crontab with: crontab -e  then append:  * * * * * python3 ~/secure-pi-bot/scripts/profile_scheduler.py",
    tags: ["performance", "scheduler", "cron"],
    code: `import subprocess
import sys
import os
from datetime import datetime

STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))

# Skip if manual override is active
if os.path.exists(STATE_FILE):
    sys.exit(0)

hour = datetime.now().hour
is_night = hour >= 23 or hour < 7

try:
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
        current_max = int(f.read().strip())
except FileNotFoundError:
    sys.exit(1)

currently_restricted = current_max <= 600000

# Only apply if a change is needed
if is_night and not currently_restricted:
    subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "set_profile_restricted.py")])
elif not is_night and currently_restricted:
    subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "set_profile_unlimited.py")])
    # Re-write the override file that set_profile_unlimited cleared, since this was auto not manual
    # Actually: set_profile_unlimited removes override, which is correct for auto-triggered too
`,
  },
  {
    id: "oneshot",
    filename: "one-time-setup.txt",
    path: null,
    description: "One-time setup commands — run these once to deploy scripts and configure the crontab. Copy each block individually.",
    tags: ["setup", "one-time", "reference"],
    code: `# ============================================================
# STEP 1 — Restore pi-maintenance.sh (if overwritten)
# ============================================================
echo 'IyEvYmluL2Jhc2gKIyBNYXN0ZXIgTWFpbnRlbmFuY2UgU2NyaXB0IC0gTG9nZ2VkICYgU2hhYmJhdC1GcmVlCgpMT0dfRklMRT0iL3Zhci9sb2cvcGktbWFpbnRlbmFuY2UubG9nIgpRVUVVRT0iL2hvbWUvYWxvbi9zY3JpcHRzL2xvZ3MvbnRmeV9xdWV1ZS50eHQiCm1rZGlyIC1wIC9ob21lL2Fsb24vc2NyaXB0cy9sb2dzCgojIFN0cnVjdHVyYWwgT3BTZWMgY2hlY2sgbGlua2VkIGRpcmVjdGx5IHRvIHlvdXIgRGlzY29yZCBib3QgdG9nZ2xlCmlmIFsgLWYgL2hvbWUvYWxvbi9zZWN1cmUtcGktYm90Ly5tYWludGVuYW5jZV9kaXNhYmxlZCBdOyB0aGVuCiAgICBlY2hvICJbJChkYXRlICcrJVktJW0tJWQgJUg6JU06JVMnKV0gTWFpbnRlbmFuY2UgZGlzYWJsZWQgdmlhIERpc2NvcmQgdG9nZ2xlIGZpbGUuIEFib3J0aW5nIGV4ZWN1dGlvbiBwaXBlbGluZS4iID4+ICIkTE9HX0ZJTEUiCiAgICBleGl0IDAKZmkKCmxvZ19tc2coKSB7CiAgICBlY2hvICJbJChkYXRlICcrJVktJW0tJWQgJUg6JU06JVMnKV0gJDEiID4+ICIkTE9HX0ZJTEUiCn0KCmxvZ19tc2cgIi0tLSBTVEFSVElORyBNQUlOVEVOQU5DRSBDWUNMRSAtLS0iCmVjaG8gIi0tLSBEQUlMWSBQSSBSRVBPUlQgKCQoZGF0ZSAnKyVZLSVtLSVkJykpIC0tLSIgPiAiJFFVRVVFIgoKIyAxLiBBZEd1YXJkIEhvbWUgQ29yZSAmIEZpbHRlcnMgVXBkYXRlCmxvZ19tc2cgIlVwZ3JhZGluZyBBZEd1YXJkIEhvbWUgQ29yZS4uLiIKL29wdC9BZEd1YXJkSG9tZS9BZEd1YXJkSG9tZSAtcyB1cGdyYWRlID4+ICIkTE9HX0ZJTEUiIDI+JjEKCiMgMi4gT1MgVXBkYXRlcyAoa2VybmVsLCBzb2Z0d2FyZSwgZXZlcnl0aGluZykKbG9nX21zZyAiU3RhcnRpbmcgYXB0LWdldCB1cGRhdGUuLi4iCnN1ZG8gYXB0LWdldCB1cGRhdGUgLXkgPj4gIiRMT0dfRklMRSIgMj4mMQpsb2dfbXNnICJTdGFydGluZyBhcHQtZ2V0IGZ1bGwtdXBncmFkZS4uLiIKc3VkbyBhcHQtZ2V0IGZ1bGwtdXBncmFkZSAteSA+PiAiJExPR19GSUxFIiAyPiYxCmxvZ19tc2cgIlJlbW92aW5nIHVudXNlZCBwYWNrYWdlcy4uLiIKc3VkbyBhcHQtZ2V0IGF1dG9yZW1vdmUgLXkgPj4gIiRMT0dfRklMRSIgMj4mMQplY2hvICJPUyBVcGRhdGVzOiBTVUNDRVNTIiA+PiAiJFFVRVVFIgoKIyBPcFNlYy1zYWZlIGZsYXQtZmlsZSB0aW1lc3RhbXAgdG9rZW4gZm9yIHVzZXItc3BhY2UgZGFlbW9ucwpta2RpciAtcCAvaG9tZS9hbG9uLy5zZWNyZXRzCmRhdGUgJyslWS0lbS0lZCAlSDolTTolUycgPiAvaG9tZS9hbG9uLy5zZWNyZXRzL2xhc3RfdXBncmFkZS50eHQKY2hvd24gYWxvbjphbG9uIC9ob21lL2Fsb24vLnNlY3JldHMvbGFzdF91cGdyYWRlLnR4dAoKIyAzLiBTZWN1cml0eSBBdWRpdCAoU2tpcCBpZiAtLXF1aWNrIGlzIHBhc3NlZCkKaWYgW1sgIiQxIiA9PSAiLS1xdWljayIgXV07IHRoZW4KICAgIGxvZ19tc2cgIlNLSVBQSU5HIFNlY3VyaXR5IEF1ZGl0ICgtLXF1aWNrIGZsYWcgZGV0ZWN0ZWQpIgogICAgZWNobyAiQXVkaXQ6IFNLSVBQRUQgKFF1aWNrIFRlc3QpIiA+PiAiJFFVRVVFIgplbHNlCiAgICBsb2dfbXNnICJUcmlnZ2VyaW5nIGxvY2FsIHNlY3VyaXR5IGF1ZGl0IHNjcmlwdC4uLiIKICAgIHN1ZG8gL3Vzci9sb2NhbC9iaW4vcGktYXVkaXQuc2ggPj4gIiRMT0dfRklMRSIgMj4mMQogICAgZWNobyAiQXVkaXQ6IENPTVBMRVRFRCIgPj4gIiRRVUVVRSIKZmkKCiMgNC4gU2VydmljZSBIZWFsdGggQ2hlY2sKbG9nX21zZyAiQ2hlY2tpbmcgc3lzdGVtZCBzZXJ2aWNlIGhlYWx0aC4uLiIKRkFJTEVEPSQoc3lzdGVtY3RsIGxpc3QtdW5pdHMgLS1zdGF0ZT1mYWlsZWQgLS1uby1sZWdlbmQgLS1wbGFpbiB8IGdyZXAgLXYgImNsYW1hdi1kYWVtb24iIHwgYXdrICd7cHJpbnQgJDF9JykKaWYgWyAhIC16ICIkRkFJTEVEIiBdOyB0aGVuCiAgICBlY2hvICJGQUlMRUQgQVBQUzogJEZBSUxFRCIgPj4gIiRRVUVVRSIKICAgIGxvZ19tc2cgIkNSSVRJQ0FMOiBGYWlsZWQgc2VydmljZXMgZGV0ZWN0ZWQ6ICRGQUlMRUQiCmVsc2UKICAgIGVjaG8gIkFsbCBTeXN0ZW0gU2VydmljZXM6IE9LIiA+PiAiJFFVRVVFIgogICAgbG9nX21zZyAiQWxsIHNlcnZpY2VzIGhlYWx0aHkuIgpmaQoKIyA1LiBEZWxpdmVyeSAmIEZpbmFsIFN5bmMKbG9nX21zZyAiU3luY2luZyBmaWxlc3lzdGVtLi4uIgpzeW5jID4+ICIkTE9HX0ZJTEUiIDI+JjEKL3Vzci9sb2NhbC9iaW4vbnRmeS1xdWV1ZS5zaCA+PiAiJExPR19GSUxFIiAyPiYxCgojIDYuIFVuY29uZGl0aW9uYWwgUmVib290CmxvZ19tc2cgIk1haW50ZW5hbmNlIGNvbXBsZXRlLiBSZWJvb3RpbmcgaW4gNjAgc2Vjb25kcy4iCnN1ZG8gc2h1dGRvd24gLXIgKzEgIlNjaGVkdWxlZCBEYWlseSBNYWludGVuYW5jZSBSZWJvb3QiID4+ICIkTE9HX0ZJTEUiIDI+JjEK' | base64 -d | sudo tee /usr/local/bin/pi-maintenance.sh > /dev/null


# ============================================================
# STEP 2 — Make it executable
# ============================================================
sudo chmod +x /usr/local/bin/pi-maintenance.sh


# ============================================================
# STEP 3 — Verify the file looks correct
# ============================================================
sudo cat /usr/local/bin/pi-maintenance.sh


# ============================================================
# STEP 4 — Add all crontab entries (non-destructive, appends)
# ============================================================
(crontab -l 2>/dev/null; printf "* * * * * python3 /home/alon/secure-pi-bot/scripts/profile_scheduler.py\\n*/5 * * * * python3 /home/alon/secure-pi-bot/scripts/ram_logger.py\\n0 3 * * * sudo /usr/local/bin/pi-maintenance.sh >> /var/log/pi-maintenance.log 2>&1\\n") | crontab -


# ============================================================
# STEP 5 — Verify crontab
# ============================================================
crontab -l
`,
  },
  {
    id: "maintenance",
    filename: "pi-maintenance.sh",
    path: "/usr/local/bin/pi-maintenance.sh",
    description: "Master maintenance script. Runs nightly at 3am: AdGuard update, full OS upgrade, security audit, service health check, ntfy report, then reboots. Skips if .maintenance_disabled toggle exists.",
    tags: ["maintenance", "bash", "cron"],
    code: `#!/bin/bash
# Master Maintenance Script - Logged & Shabbat-Free

LOG_FILE="/var/log/pi-maintenance.log"
QUEUE="/home/alon/scripts/logs/ntfy_queue.txt"
mkdir -p /home/alon/scripts/logs

# Structural OpSec check linked directly to your Discord bot toggle
if [ -f /home/alon/secure-pi-bot/.maintenance_disabled ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Maintenance disabled via Discord toggle file. Aborting execution pipeline." >> "$LOG_FILE"
    exit 0
fi

log_msg() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log_msg "--- STARTING MAINTENANCE CYCLE ---"
echo "--- DAILY PI REPORT ($(date '+%Y-%m-%d')) ---" > "$QUEUE"

# 1. AdGuard Home Core & Filters Update
log_msg "Upgrading AdGuard Home Core..."
/opt/AdGuardHome/AdGuardHome -s upgrade >> "$LOG_FILE" 2>&1

# 2. OS Updates (kernel, software, everything)
log_msg "Starting apt-get update..."
sudo apt-get update -y >> "$LOG_FILE" 2>&1
log_msg "Starting apt-get full-upgrade..."
sudo apt-get full-upgrade -y >> "$LOG_FILE" 2>&1
log_msg "Removing unused packages..."
sudo apt-get autoremove -y >> "$LOG_FILE" 2>&1
echo "OS Updates: SUCCESS" >> "$QUEUE"

# OpSec-safe flat-file timestamp token for user-space daemons
mkdir -p /home/alon/.secrets
date '+%Y-%m-%d %H:%M:%S' > /home/alon/.secrets/last_upgrade.txt
chown alon:alon /home/alon/.secrets/last_upgrade.txt

# 3. Security Audit (Skip if --quick is passed)
if [[ "$1" == "--quick" ]]; then
    log_msg "SKIPPING Security Audit (--quick flag detected)"
    echo "Audit: SKIPPED (Quick Test)" >> "$QUEUE"
else
    log_msg "Triggering local security audit script..."
    sudo /usr/local/bin/pi-audit.sh >> "$LOG_FILE" 2>&1
    echo "Audit: COMPLETED" >> "$QUEUE"
fi

# 4. Service Health Check
log_msg "Checking systemd service health..."
FAILED=$(systemctl list-units --state=failed --no-legend --plain | grep -v "clamav-daemon" | awk '{print $1}')
if [ ! -z "$FAILED" ]; then
    echo "FAILED APPS: $FAILED" >> "$QUEUE"
    log_msg "CRITICAL: Failed services detected: $FAILED"
else
    echo "All System Services: OK" >> "$QUEUE"
    log_msg "All services healthy."
fi

# 5. Delivery & Final Sync
log_msg "Syncing filesystem..."
sync >> "$LOG_FILE" 2>&1
/usr/local/bin/ntfy-queue.sh >> "$LOG_FILE" 2>&1

# 6. Unconditional Reboot
log_msg "Maintenance complete. Rebooting in 60 seconds."
sudo shutdown -r +1 "Scheduled Daily Maintenance Reboot" >> "$LOG_FILE" 2>&1
`,
  },
  {
    id: "crontab",
    filename: "crontab.txt",
    path: null,
    description: "Full crontab for alon. To apply: copy the lines below, run 'crontab -e', and paste. Or pipe directly: (crontab -l; cat crontab.txt) | crontab -",
    tags: ["cron", "reference"],
    code: `# Pi Crontab — alon
# Apply with: crontab -e

# --- Performance Profile Auto-Switcher ---
# Switches to restricted (600 MHz) at 23:00, unlimited (1.7 GHz) at 07:00
# Skips if manual override is active via Discord /setprofile command
* * * * * python3 /home/alon/secure-pi-bot/scripts/profile_scheduler.py

# --- RAM Usage Logger ---
# Logs bot RSS + system RAM every 5 minutes to jsonl log
*/5 * * * * python3 /home/alon/secure-pi-bot/scripts/ram_logger.py

# --- Nightly Maintenance + Reboot ---
# Full OS upgrade (kernel + software), AdGuard update, audit, service check, then reboot
# Runs at 03:00 daily. Skips if .maintenance_disabled toggle file exists.
0 3 * * * sudo /usr/local/bin/pi-maintenance.sh >> /var/log/pi-maintenance.log 2>&1
`,
  },
];

export default scripts;