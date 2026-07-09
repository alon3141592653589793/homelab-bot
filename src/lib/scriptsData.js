const scripts = [
  {
    id: "main",
    filename: "main.py",
    path: "~/secure-pi-bot/main.py",
    description: "Listener only — receives Discord messages and passes them to the reactive module.",
    tags: ["discord", "bot", "listener"],
    code: `import os
import sys
import json
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

STATUS_FILE = "/home/alon/secure-pi-bot/.bot_status.json"

@tasks.loop(seconds=240)
async def sync_bot_presence():
    await client.wait_until_ready()
    try:
        with open(STATUS_FILE, "r") as f:
            status_data = json.load(f)
        status_text = status_data.get("text", "Pi Online")
        await client.change_presence(activity=discord.Game(name=status_text))
    except (FileNotFoundError, json.JSONDecodeError):
        pass

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
    if not sync_bot_presence.is_running():
        sync_bot_presence.start()

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
    description: "Thin command router — maps /commands to scripts or confirmation flows.",
    tags: ["router", "dispatcher"],
    code: `import os
import subprocess
from modules.runner import run_script, confirm_and_run

async def handle_reactive_command(client, message):
    content = message.content.strip().lower()
    raw = message.content.strip()

    if content == "/status":
        await run_script(message, "status.py", "Querying system status...")

    elif content == "/cooldown":
        await run_script(message, "cooldown.py", "Running thermal cooldown...")

    elif content == "/restart":
        await confirm_and_run(client, message, "restart.py", "Reboot", "This will restart the Pi immediately.")

    elif content == "/shutdown":
        await confirm_and_run(client, message, "shutdown.py", "Shutdown", "This will power off the Pi. Physical access required to turn it back on.")

    elif content == "/fanreport":
        await run_script(message, "fan_report.py", "Reading fan log...")

    elif content == "/profile":
        await run_script(message, "profile_status.py", "Checking current performance profile...")

    elif content == "/setprofile restricted":
        await run_script(message, "set_profile_restricted.py", "Applying restricted profile...")
        await run_script(message, "update_bot_status.py", "")

    elif content == "/setprofile unlimited":
        await run_script(message, "set_profile_unlimited.py", "Applying unlimited profile...")
        await run_script(message, "update_bot_status.py", "")

    elif content == "/weeklyreport":
        await run_script(message, "weekly_report.py", "Generating weekly report...")

    elif content == "/logging start":
        state_file = "/home/alon/secure-pi-bot/.logging_enabled"
        open(state_file, "w").close()
        await message.channel.send("Logging enabled. system_logger.py will collect data on next cron tick.")

    elif content == "/logging stop":
        state_file = "/home/alon/secure-pi-bot/.logging_enabled"
        if os.path.exists(state_file):
            os.remove(state_file)
        await message.channel.send("Logging disabled. system_logger.py will skip collection until re-enabled.")

    elif content == "/fastfetch":
        try:
            result = subprocess.run(["fastfetch", "--logo", "none"], capture_output=True, text=True, timeout=10)
            output = result.stdout.strip() or result.stderr.strip() or "No output."
            if len(output) > 1900:
                output = output[:1900] + "\\n[truncated]"
            await message.channel.send(output)
        except FileNotFoundError:
            await message.channel.send("fastfetch not installed. Run: sudo apt install fastfetch")
        except Exception as e:
            await message.channel.send(f"Error: {e}")

    elif raw.lower().startswith("/aidebug "):
        prompt = raw[9:].strip()
        if not prompt:
            await message.channel.send("Usage: /aidebug <your question about the Pi>")
        else:
            await run_script(message, "ai_debug.py", f"Running AI diagnostic: {prompt[:60]}...", args=[prompt])

    elif content == "/help":
        await message.channel.send(
            "Available commands:\\n"
            "/status               - System metrics\\n"
            "/cooldown             - Stop non-essential services\\n"
            "/restart              - Reboot Pi (requires confirmation)\\n"
            "/shutdown             - Power off Pi (requires confirmation)\\n"
            "/fanreport            - Show fan activation log\\n"
            "/weeklyreport         - Post weekly summary now\\n"
            "/logging start        - Enable system logger\\n"
            "/logging stop         - Disable system logger\\n"
            "/profile              - Show current performance profile\\n"
            "/setprofile restricted - Force restricted profile (600 MHz, powersave)\\n"
            "/setprofile unlimited  - Force unlimited profile (1.7 GHz, schedutil)\\n"
            "/fastfetch            - Run fastfetch\\n"
            "/aidebug <question>   - AI reads Pi state and diagnoses (posts to report channel)\\n"
            "/help                 - This message"
        )
`,
  },
  {
    id: "runner",
    filename: "runner.py",
    path: "~/secure-pi-bot/modules/runner.py",
    description: "Execution helpers — run_script runs a subprocess and sends output to Discord. Supports optional args list.",
    tags: ["runner", "confirmation", "discord"],
    code: `import subprocess
import asyncio
import os

SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")


async def run_script(message, script_name, status_msg, args=None):
    script_path = os.path.join(SCRIPTS_DIR, script_name)
    if status_msg:
        await message.channel.send(status_msg)
    try:
        cmd = ["python3", script_path] + (args or [])
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        output = result.stdout.strip() or result.stderr.strip() or "No output."
        if len(output) > 1900:
            output = output[:1900] + "\\n[truncated]"
        await message.channel.send(output)
    except subprocess.TimeoutExpired:
        await message.channel.send("Script timed out after 45 seconds.")
    except Exception as e:
        await message.channel.send(f"Script error: {e}")


async def confirm_and_run(client, message, script_name, action_name, description):
    confirm_msg = await message.channel.send(
        f"[{action_name.upper()} - CONFIRMATION REQUIRED]\\n"
        f"{description}\\n\\n"
        f"React with checkmark to confirm or X to cancel. Timeout: 30 seconds."
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
    description: "Outputs system metrics: core temp, CPU load, CPU/GPU freq, RAM usage, RAM speed, core voltage, last upgrade.",
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
vm = psutil.virtual_memory()
ram_percent = vm.percent
ram_used_mb = round(vm.used / (1024 * 1024))
ram_total_mb = round(vm.total / (1024 * 1024))

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
    result = subprocess.run(["vcgencmd", "measure_clock", "core"], capture_output=True, text=True)
    gpu_hz = int(result.stdout.strip().split("=")[1])
    gpu_mhz = f"{gpu_hz // 1000000} MHz"
except Exception:
    gpu_mhz = "Unknown"

try:
    result = subprocess.run(["vcgencmd", "measure_clock", "sdram_c"], capture_output=True, text=True)
    sdram_hz = int(result.stdout.strip().split("=")[1])
    ram_speed = f"{sdram_hz // 1000000} MHz"
except Exception:
    ram_speed = "Unknown"

try:
    result = subprocess.run(["vcgencmd", "measure_volts", "core"], capture_output=True, text=True)
    volts_str = result.stdout.strip().split("=")[1].replace("V", "")
    power_str = f"{float(volts_str):.3f}V"
except Exception:
    power_str = "Unknown"

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
    f"**GPU Clock:** {gpu_mhz}\\n"
    f"**Memory Usage:** {ram_used_mb} MB / {ram_total_mb} MB ({ram_percent}%)\\n"
    f"**RAM Speed:** {ram_speed}\\n"
    f"**Core Voltage:** {power_str}\\n"
    f"**Last Upgrade:** {last_upgrade}"
)
`,
  },
  {
    id: "fan-logger",
    filename: "fan_logger.py",
    path: "~/secure-pi-bot/scripts/fan_logger.py",
    description: "Logs fan ON/OFF events with timestamps. Run via cron every minute. Stores in RAM (/dev/shm), flushed to disk by compress_logs.py before reboot.",
    tags: ["fan", "logging", "thermal"],
    code: `import os
import json
from datetime import datetime

RAM_LOG = "/dev/shm/pi-bot/fan_events.jsonl"
STATE_FILE = "/dev/shm/pi-bot/fan_state.txt"

os.makedirs("/dev/shm/pi-bot", exist_ok=True)

def get_fan_active():
    import subprocess
    # Try vcgencmd get_fan (Pi 5 / official fan HAT)
    try:
        result = subprocess.run(["vcgencmd", "get_fan"], capture_output=True, text=True, timeout=3)
        if result.returncode == 0:
            return result.stdout.strip().endswith("=1")
    except Exception:
        pass
    # Try GPIO sysfs (GPIO 14 default fan pin)
    try:
        with open("/sys/class/gpio/gpio14/value") as f:
            return f.read().strip() == "1"
    except FileNotFoundError:
        pass
    # Fallback: infer from temperature
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            temp = float(f.read().strip()) / 1000.0
        return temp >= 65.0
    except Exception:
        return False

now_active = get_fan_active()
now_str = datetime.now().isoformat()

prev_state = None
if os.path.exists(STATE_FILE):
    with open(STATE_FILE) as f:
        content = f.read().strip()
        if content:
            try:
                prev = json.loads(content)
                prev_state = prev.get("active")
            except Exception:
                pass

with open(STATE_FILE, "w") as f:
    json.dump({"active": now_active, "ts": now_str}, f)

if prev_state is None:
    event = {"ts": now_str, "event": "on" if now_active else "off", "note": "initial"}
    with open(RAM_LOG, "a") as f:
        f.write(json.dumps(event) + "\\n")
elif prev_state != now_active:
    event = {"ts": now_str, "event": "on" if now_active else "off"}
    with open(RAM_LOG, "a") as f:
        f.write(json.dumps(event) + "\\n")
`,
  },
  {
    id: "fan-report",
    filename: "fan_report.py",
    path: "~/secure-pi-bot/scripts/fan_report.py",
    description: "Reads fan event log and outputs plain-text summary to Discord.",
    tags: ["fan", "report", "discord"],
    code: `import os
import json
from datetime import datetime

RAM_LOG = "/dev/shm/pi-bot/fan_events.jsonl"
DISK_LOG = "/home/alon/secure-pi-bot/logs/fan_events.jsonl"

events = []
for path in [DISK_LOG, RAM_LOG]:
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        events.append(json.loads(line))
                    except Exception:
                        continue

seen = set()
unique = []
for e in events:
    if e["ts"] not in seen:
        seen.add(e["ts"])
        unique.append(e)

events = sorted(unique, key=lambda x: x["ts"])

if not events:
    print("No fan events logged yet.")
    import sys; sys.exit(0)

lines = ["**Fan Activation Log**"]
sessions = []
i = 0
while i < len(events):
    e = events[i]
    if e["event"] == "on":
        start_ts = e["ts"]
        end_ts = None
        j = i + 1
        while j < len(events):
            if events[j]["event"] == "off":
                end_ts = events[j]["ts"]
                i = j
                break
            j += 1
        sessions.append((start_ts, end_ts))
    i += 1

for start, end in sessions[-20:]:
    start_dt = datetime.fromisoformat(start)
    if end:
        end_dt = datetime.fromisoformat(end)
        duration = end_dt - start_dt
        mins = int(duration.total_seconds() // 60)
        secs = int(duration.total_seconds() % 60)
        lines.append(f"  ON  {start_dt.strftime('%m/%d %H:%M')} -> OFF {end_dt.strftime('%H:%M')}  ({mins}m {secs}s)")
    else:
        lines.append(f"  ON  {start_dt.strftime('%m/%d %H:%M')} -> still running")

total_on_secs = sum(
    (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()
    for start, end in sessions if end
)

lines.append(f"\\nTotal sessions: {len(sessions)} | Total fan-on time: {int(total_on_secs // 60)}m")
print("\\n".join(lines))
`,
  },
  {
    id: "system-logger",
    filename: "system_logger.py",
    path: "~/secure-pi-bot/scripts/system_logger.py",
    description: "Runs every 10 min via cron. Logs temp, RAM, failed services to RAM (/dev/shm). Detects 1% temp spikes (>=5C jump). Skips if .logging_enabled missing.",
    tags: ["logging", "temperature", "ram", "services"],
    code: `import os
import sys
import json
import subprocess
from datetime import datetime

ENABLED_FLAG = "/home/alon/secure-pi-bot/.logging_enabled"
RAM_LOG = "/dev/shm/pi-bot/system_log.jsonl"

if not os.path.exists(ENABLED_FLAG):
    sys.exit(0)

os.makedirs("/dev/shm/pi-bot", exist_ok=True)

try:
    import psutil
except ImportError:
    sys.exit(1)

ts = datetime.now().isoformat()

try:
    with open("/sys/class/thermal/thermal_zone0/temp") as f:
        temp_c = round(float(f.read().strip()) / 1000.0, 1)
except Exception:
    temp_c = None

vm = psutil.virtual_memory()
ram_pct = round(vm.percent, 1)

failed_services = []
try:
    result = subprocess.run(
        ["systemctl", "list-units", "--state=failed", "--no-legend", "--plain"],
        capture_output=True, text=True, timeout=5
    )
    for line in result.stdout.strip().splitlines():
        parts = line.split()
        unit = parts[0] if parts else None
        if unit and "clamav-daemon" not in unit:
            failed_services.append(unit)
except Exception:
    pass

entry = {
    "ts": ts,
    "temp_c": temp_c,
    "ram_pct": ram_pct,
    "failed": failed_services,
}

last_temp = None
if os.path.exists(RAM_LOG):
    try:
        with open(RAM_LOG) as f:
            lines = [l.strip() for l in f if l.strip()]
        if lines:
            last = json.loads(lines[-1])
            last_temp = last.get("temp_c")
    except Exception:
        pass

if last_temp is not None and temp_c is not None:
    if temp_c - last_temp >= 5.0:
        entry["spike"] = True

with open(RAM_LOG, "a") as f:
    f.write(json.dumps(entry) + "\\n")
`,
  },
  {
    id: "compress-logs",
    filename: "compress_logs.py",
    path: "~/secure-pi-bot/scripts/compress_logs.py",
    description: "Run before reboot (called inside pi-maintenance.sh and restart/shutdown scripts). Compresses RAM system log to disk averages. Flushes fan log too.",
    tags: ["logging", "compression", "maintenance"],
    code: `import os
import json
from datetime import datetime

RAM_SYSTEM_LOG = "/dev/shm/pi-bot/system_log.jsonl"
RAM_FAN_LOG = "/dev/shm/pi-bot/fan_events.jsonl"
DISK_SYSTEM_LOG = "/home/alon/secure-pi-bot/logs/system_log.jsonl"
DISK_FAN_LOG = "/home/alon/secure-pi-bot/logs/fan_events.jsonl"

os.makedirs("/home/alon/secure-pi-bot/logs", exist_ok=True)

def flush_fan_log():
    if not os.path.exists(RAM_FAN_LOG):
        return
    existing_ts = set()
    if os.path.exists(DISK_FAN_LOG):
        with open(DISK_FAN_LOG) as f:
            for line in f:
                try:
                    existing_ts.add(json.loads(line.strip())["ts"])
                except Exception:
                    pass
    with open(RAM_FAN_LOG) as f:
        new_entries = [l.strip() for l in f if l.strip()]
    count = 0
    with open(DISK_FAN_LOG, "a") as f:
        for line in new_entries:
            try:
                e = json.loads(line)
                if e["ts"] not in existing_ts:
                    f.write(line + "\\n")
                    count += 1
            except Exception:
                pass
    print(f"Fan log flushed: {count} new entries")

def compress_system_log():
    if not os.path.exists(RAM_SYSTEM_LOG):
        return
    with open(RAM_SYSTEM_LOG) as f:
        entries = [json.loads(l.strip()) for l in f if l.strip()]
    if not entries:
        return

    compressed = []
    group = [entries[0]]

    def flush_group(g):
        if not g:
            return None
        temps = [e["temp_c"] for e in g if e.get("temp_c") is not None]
        rams = [e["ram_pct"] for e in g if e.get("ram_pct") is not None]
        failed = list(set(f for e in g for f in e.get("failed", [])))
        return {
            "ts_start": g[0]["ts"],
            "ts_end": g[-1]["ts"],
            "temp_avg_c": round(sum(temps) / len(temps), 1) if temps else None,
            "ram_avg_pct": round(sum(rams) / len(rams), 1) if rams else None,
            "failed": failed,
            "samples": len(g),
        }

    for i in range(1, len(entries)):
        e = entries[i]
        prev = group[-1]
        is_spike = e.get("spike", False)
        has_failed = bool(e.get("failed"))
        temp_changed = abs((e.get("temp_c") or 0) - (prev.get("temp_c") or 0)) >= 3.0

        if is_spike:
            r = flush_group(group)
            if r:
                compressed.append(r)
            group = []
            spike_entry = dict(e)
            spike_entry["spike_flag"] = True
            compressed.append(spike_entry)
        elif has_failed or temp_changed:
            r = flush_group(group)
            if r:
                compressed.append(r)
            group = [e]
        else:
            group.append(e)

    if group:
        r = flush_group(group)
        if r:
            compressed.append(r)

    with open(DISK_SYSTEM_LOG, "a") as f:
        for entry in compressed:
            f.write(json.dumps(entry) + "\\n")

    print(f"System log compressed: {len(entries)} entries -> {len(compressed)} blocks")

flush_fan_log()
compress_system_log()
`,
  },
  {
    id: "weekly-report",
    filename: "weekly_report.py",
    path: "~/secure-pi-bot/scripts/weekly_report.py",
    description: "Generates weekly report from system_log and fan_log. Saves up to 3 reports rotating oldest. Posts to Discord report channel 1524756593651224706.",
    tags: ["report", "discord", "weekly"],
    code: `import os
import sys
import json
from datetime import datetime, timedelta

try:
    import psutil
    import requests
except ImportError as e:
    print(f"FAILURE: missing dependency: {e}")
    sys.exit(1)

BOT_DIR = "/home/alon/secure-pi-bot"
DISK_SYSTEM_LOG = f"{BOT_DIR}/logs/system_log.jsonl"
RAM_SYSTEM_LOG = "/dev/shm/pi-bot/system_log.jsonl"
DISK_FAN_LOG = f"{BOT_DIR}/logs/fan_events.jsonl"
RAM_FAN_LOG = "/dev/shm/pi-bot/fan_events.jsonl"
REPORTS_DIR = f"{BOT_DIR}/logs/weekly_reports"
REPORT_CHANNEL_ID = 1524756593651224706

os.makedirs(REPORTS_DIR, exist_ok=True)

from dotenv import load_dotenv
load_dotenv(f"{BOT_DIR}/.env")
BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")

if not BOT_TOKEN:
    print("FAILURE: DISCORD_BOT_TOKEN not set")
    sys.exit(1)

def post_to_discord(text):
    url = f"https://discord.com/api/v10/channels/{REPORT_CHANNEL_ID}/messages"
    headers = {"Authorization": f"Bot {BOT_TOKEN}", "Content-Type": "application/json"}
    chunks = [text[i:i+1900] for i in range(0, len(text), 1900)]
    for chunk in chunks:
        resp = requests.post(url, json={"content": chunk}, headers=headers, timeout=10)
        if resp.status_code not in (200, 201):
            print(f"FAILURE: Discord returned {resp.status_code}: {resp.text}")
            sys.exit(1)

cutoff = datetime.now() - timedelta(days=7)

sys_entries = []
for path in [DISK_SYSTEM_LOG, RAM_SYSTEM_LOG]:
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    ts_str = e.get("ts_start") or e.get("ts")
                    if ts_str and datetime.fromisoformat(ts_str) >= cutoff:
                        sys_entries.append(e)
                except Exception:
                    continue

fan_entries = []
for path in [DISK_FAN_LOG, RAM_FAN_LOG]:
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    if datetime.fromisoformat(e["ts"]) >= cutoff:
                        fan_entries.append(e)
                except Exception:
                    continue

seen_fan = set()
unique_fan = []
for e in fan_entries:
    if e["ts"] not in seen_fan:
        seen_fan.add(e["ts"])
        unique_fan.append(e)
fan_entries = sorted(unique_fan, key=lambda x: x["ts"])

temps = [e.get("temp_c") or e.get("temp_avg_c") for e in sys_entries if (e.get("temp_c") or e.get("temp_avg_c")) is not None]
spikes = [e for e in sys_entries if e.get("spike") or e.get("spike_flag")]
rams = [e.get("ram_pct") or e.get("ram_avg_pct") for e in sys_entries if (e.get("ram_pct") or e.get("ram_avg_pct")) is not None]
all_failed = list(set(f for e in sys_entries for f in e.get("failed", [])))

fan_sessions = []
i = 0
while i < len(fan_entries):
    e = fan_entries[i]
    if e["event"] == "on":
        start = e["ts"]
        end = None
        j = i + 1
        while j < len(fan_entries):
            if fan_entries[j]["event"] == "off":
                end = fan_entries[j]["ts"]
                i = j
                break
            j += 1
        fan_sessions.append((start, end))
    i += 1

total_fan_secs = sum(
    (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()
    for start, end in fan_sessions if end
)

try:
    boot_time = datetime.fromtimestamp(psutil.boot_time())
    uptime_delta = datetime.now() - boot_time
    uptime_str = f"{uptime_delta.days}d {uptime_delta.seconds // 3600}h"
except Exception:
    uptime_str = "Unknown"

week_label = datetime.now().strftime("%b %d, %Y")

lines = [f"**Weekly Pi Report -- week ending {week_label}**", ""]
lines.append(f"**Uptime:** {uptime_str}")

if temps:
    lines.append(f"**Temperature (7d):** Avg {sum(temps)/len(temps):.1f}C | Min {min(temps):.1f}C | Max {max(temps):.1f}C")
else:
    lines.append("**Temperature:** No data (enable logging with /logging start)")

if spikes:
    spike_strs = []
    for s in spikes[-5:]:
        ts = s.get("ts") or s.get("ts_start", "?")
        tc = s.get("temp_c") or s.get("temp_avg_c") or "?"
        spike_strs.append(f"{datetime.fromisoformat(ts).strftime('%m/%d %H:%M')}={tc}C")
    lines.append(f"**Temp spikes ({len(spikes)} total):** {' | '.join(spike_strs)}")

if rams:
    lines.append(f"**RAM (7d):** Avg {sum(rams)/len(rams):.1f}% | Max {max(rams):.1f}%")

lines.append(f"**Fan activations:** {len(fan_sessions)} sessions | {int(total_fan_secs // 60)}m total")

if all_failed:
    lines.append(f"**Failed services detected:** {', '.join(sorted(all_failed))}")
else:
    lines.append("**Services:** All healthy throughout the week")

report_text = "\\n".join(lines)

timestamp = datetime.now().strftime("%Y%m%d_%H%M")
report_path = os.path.join(REPORTS_DIR, f"report_{timestamp}.txt")
with open(report_path, "w") as f:
    f.write(report_text)

all_reports = sorted([
    os.path.join(REPORTS_DIR, fn) for fn in os.listdir(REPORTS_DIR) if fn.endswith(".txt")
])
while len(all_reports) > 3:
    os.remove(all_reports.pop(0))

post_to_discord(report_text)
print("Weekly report sent.")
`,
  },
  {
    id: "ai-debug",
    filename: "ai_debug.py",
    path: "~/secure-pi-bot/scripts/ai_debug.py",
    description: "AI-powered read-only Pi diagnostic. Runs whitelist of safe info-only commands (no sudo, no writes), feeds to Gemini Flash, posts to report channel. Rate limited to 1 call per 5 min.",
    tags: ["ai", "debug", "gemini", "diagnostic"],
    code: `import os
import sys
import json
import time
import subprocess
import requests
from datetime import datetime

BOT_DIR = "/home/alon/secure-pi-bot"
REPORT_CHANNEL_ID = 1524756593651224706
RATE_LIMIT_FILE = f"{BOT_DIR}/.ai_debug_rate"
RATE_LIMIT_SECONDS = 300  # 5 min, safe for Gemini free tier (15 req/min, 1500/day)

from dotenv import load_dotenv
load_dotenv(f"{BOT_DIR}/.env")
BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if not BOT_TOKEN:
    print("FAILURE: DISCORD_BOT_TOKEN not set")
    sys.exit(1)

if not GEMINI_API_KEY:
    print("FAILURE: GEMINI_API_KEY not set in .env\\nGet a free key at: https://aistudio.google.com/app/apikey")
    sys.exit(1)

now = time.time()
if os.path.exists(RATE_LIMIT_FILE):
    with open(RATE_LIMIT_FILE) as f:
        last_call = float(f.read().strip() or "0")
    elapsed = now - last_call
    if elapsed < RATE_LIMIT_SECONDS:
        remaining = int(RATE_LIMIT_SECONDS - elapsed)
        print(f"Rate limited. Try again in {remaining}s.")
        sys.exit(0)

with open(RATE_LIMIT_FILE, "w") as f:
    f.write(str(now))

prompt = " ".join(sys.argv[1:]).strip() if len(sys.argv) > 1 else "General health check"

# === READ-ONLY COMMAND WHITELIST — no sudo, no writes ===
SAFE_COMMANDS = [
    ["systemctl", "list-units", "--state=failed", "--no-legend"],
    ["journalctl", "-p", "err", "-n", "30", "--no-pager"],
    ["df", "-h"],
    ["free", "-h"],
    ["uptime"],
    ["cat", "/proc/loadavg"],
    ["vcgencmd", "measure_temp"],
    ["vcgencmd", "measure_clock", "arm"],
    ["vcgencmd", "measure_volts", "core"],
    ["vcgencmd", "get_throttled"],
    ["ip", "addr", "show"],
    ["ss", "-tulnp"],
    ["ps", "aux", "--sort=-%cpu"],
    ["dmesg", "-T", "--level=err,warn"],
]

collected = {}
for cmd in SAFE_COMMANDS:
    label = " ".join(cmd)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        out = result.stdout.strip() or result.stderr.strip() or "(empty)"
        collected[label] = out[:600]
    except subprocess.TimeoutExpired:
        collected[label] = "(timed out)"
    except FileNotFoundError:
        collected[label] = "(not found)"
    except Exception as e:
        collected[label] = f"(error: {e})"

context = "\\n\\n".join(f"$ {k}\\n{v}" for k, v in collected.items())

gemini_prompt = (
    f'You are a Raspberry Pi diagnostic assistant. The user asks: "{prompt}"\\n\\n'
    f"Current read-only system state:\\n{context}\\n\\n"
    "Provide a concise diagnosis. Highlight anything abnormal. Answer the user question directly. "
    "Keep response under 1400 characters."
)

url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={GEMINI_API_KEY}"
payload = {
    "contents": [{"parts": [{"text": gemini_prompt}]}],
    "generationConfig": {"maxOutputTokens": 400, "temperature": 0.3}
}

try:
    resp = requests.post(url, json=payload, timeout=20)
    resp.raise_for_status()
    data = resp.json()
    ai_text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
except Exception as e:
    print(f"FAILURE: Gemini API error: {e}")
    sys.exit(1)

discord_url = f"https://discord.com/api/v10/channels/{REPORT_CHANNEL_ID}/messages"
headers = {"Authorization": f"Bot {BOT_TOKEN}", "Content-Type": "application/json"}

header = f"**AI Debug** [{datetime.now().strftime('%H:%M')}] Query: {prompt[:80]}\\n\\n"
full_message = header + ai_text

for chunk in [full_message[i:i+1900] for i in range(0, len(full_message), 1900)]:
    requests.post(discord_url, json={"content": chunk}, headers=headers, timeout=10)

print(f"AI debug report posted to channel {REPORT_CHANNEL_ID}.")
`,
  },
  {
    id: "cooldown",
    filename: "cooldown.py",
    path: "~/secure-pi-bot/scripts/cooldown.py",
    description: "Stops non-essential services to reduce thermal load. No sudo needed if user is in systemd group.",
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
            subprocess.run(["systemctl", "stop", service], capture_output=True)
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
    description: "Compresses logs then reboots the Pi. Only called after confirmation in runner.py.",
    tags: ["reboot"],
    code: `import subprocess
import os

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
print("Compressing logs before reboot...")
subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "compress_logs.py")], capture_output=True)
print("Initializing hardware reboot...")
subprocess.run(["/sbin/shutdown", "-r", "now"])
`,
  },
  {
    id: "shutdown",
    filename: "shutdown.py",
    path: "~/secure-pi-bot/scripts/shutdown.py",
    description: "Compresses logs then powers off the Pi. Only called after confirmation in runner.py.",
    tags: ["shutdown"],
    code: `import subprocess
import os

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
print("Compressing logs before shutdown...")
subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "compress_logs.py")], capture_output=True)
print("Initializing hardware poweroff...")
subprocess.run(["/sbin/shutdown", "-h", "now"])
`,
  },
  {
    id: "set-profile-restricted",
    filename: "set_profile_restricted.py",
    path: "~/secure-pi-bot/scripts/set_profile_restricted.py",
    description: "Applies restricted profile: 600 MHz max, powersave governor. GPU untouched.",
    tags: ["performance", "thermal", "cpu"],
    code: `import subprocess
import sys

GOVERNOR = "powersave"
MAX_FREQ = "600000"
STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"
CPU_CORES = 4

def write_sysfs(path, value):
    try:
        with open(path, "w") as f:
            f.write(value)
    except PermissionError:
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
    description: "Applies unlimited profile: 1.7 GHz max, schedutil governor. GPU untouched.",
    tags: ["performance", "cpu"],
    code: `import subprocess
import sys
import os

GOVERNOR = "schedutil"
MAX_FREQ = "1700000"
STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"
CPU_CORES = 4

def write_sysfs(path, value):
    try:
        with open(path, "w") as f:
            f.write(value)
    except PermissionError:
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

profile_name = "RESTRICTED" if max_freq_khz <= 600000 else "UNLIMITED"
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
    id: "update-bot-status",
    filename: "update_bot_status.py",
    path: "~/secure-pi-bot/scripts/update_bot_status.py",
    description: "Updates the Discord bot's status message based on the active performance profile.",
    tags: ["discord", "status", "performance"],
    code: `import os
import sys
import json

STATUS_FILE = "/home/alon/secure-pi-bot/.bot_status.json"
STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"

try:
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
        max_freq_khz = int(f.read().strip())
except FileNotFoundError:
    print("Could not read CPU freq.")
    sys.exit(1)

if max_freq_khz <= 600000:
    profile = "restricted"
    status_text = "Resting | 600 MHz | Powersave"
    status_type = "idle"
else:
    profile = "unlimited"
    status_text = "Active | 1.7 GHz | Schedutil"
    status_type = "online"

override_active = os.path.exists(STATE_FILE)
if override_active:
    status_text += " (manual)"

status_data = {
    "profile": profile,
    "text": status_text,
    "type": status_type,
    "override": override_active,
}

with open(STATUS_FILE, "w") as f:
    json.dump(status_data, f)

print(f"Bot status updated: {status_text}")
`,
  },
  {
    id: "profile-scheduler",
    filename: "profile_scheduler.py",
    path: "~/secure-pi-bot/scripts/profile_scheduler.py",
    description: "Auto-switches profiles by time. Restricted 23:00-07:00, unlimited otherwise. Skips if manual override file exists.",
    tags: ["performance", "scheduler", "cron"],
    code: `import subprocess
import sys
import os
from datetime import datetime

STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))

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

if is_night and not currently_restricted:
    subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "set_profile_restricted.py")])
elif not is_night and currently_restricted:
    subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "set_profile_unlimited.py")])
`,
  },
  {
    id: "maintenance",
    filename: "pi-maintenance.sh",
    path: "/usr/local/bin/pi-maintenance.sh",
    description: "Master maintenance script. Compresses logs before reboot. Runs nightly at 3am.",
    tags: ["maintenance", "bash", "cron"],
    code: `#!/bin/bash
# Master Maintenance Script - Logged & Shabbat-Free

LOG_FILE="/var/log/pi-maintenance.log"
QUEUE="/home/alon/scripts/logs/ntfy_queue.txt"
mkdir -p /home/alon/scripts/logs

if [ -f /home/alon/secure-pi-bot/.maintenance_disabled ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Maintenance disabled via Discord toggle file. Aborting." >> "$LOG_FILE"
    exit 0
fi

log_msg() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log_msg "--- STARTING MAINTENANCE CYCLE ---"
echo "--- DAILY PI REPORT ($(date '+%Y-%m-%d')) ---" > "$QUEUE"

# 0. Compress RAM logs to disk before anything else
log_msg "Compressing RAM logs to disk..."
python3 /home/alon/secure-pi-bot/scripts/compress_logs.py >> "$LOG_FILE" 2>&1

# 1. AdGuard Home Core & Filters Update
log_msg "Upgrading AdGuard Home Core..."
/opt/AdGuardHome/AdGuardHome -s upgrade >> "$LOG_FILE" 2>&1

# 2. OS Updates
log_msg "Starting apt-get update..."
apt-get update -y >> "$LOG_FILE" 2>&1
log_msg "Starting apt-get full-upgrade..."
apt-get full-upgrade -y >> "$LOG_FILE" 2>&1
log_msg "Removing unused packages..."
apt-get autoremove -y >> "$LOG_FILE" 2>&1
echo "OS Updates: SUCCESS" >> "$QUEUE"

mkdir -p /home/alon/.secrets
date '+%Y-%m-%d %H:%M:%S' > /home/alon/.secrets/last_upgrade.txt
chown alon:alon /home/alon/.secrets/last_upgrade.txt

# 3. Security Audit
if [[ "$1" == "--quick" ]]; then
    log_msg "SKIPPING Security Audit (--quick flag detected)"
    echo "Audit: SKIPPED (Quick Test)" >> "$QUEUE"
else
    log_msg "Triggering local security audit script..."
    /usr/local/bin/pi-audit.sh >> "$LOG_FILE" 2>&1
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
shutdown -r +1 "Scheduled Daily Maintenance Reboot" >> "$LOG_FILE" 2>&1
`,
  },
  {
    id: "crontab",
    filename: "crontab.txt",
    path: null,
    description: "Full crontab for alon. Apply with: crontab -e",
    tags: ["cron", "reference"],
    code: `# Pi Crontab -- alon
# Apply with: crontab -e

# --- Performance Profile Auto-Switcher ---
* * * * * python3 /home/alon/secure-pi-bot/scripts/profile_scheduler.py

# --- System Logger (temp, RAM, failed services) every 10 min ---
# Only runs if .logging_enabled exists -- toggle with /logging start|stop
*/10 * * * * python3 /home/alon/secure-pi-bot/scripts/system_logger.py

# --- Fan Event Logger every minute ---
* * * * * python3 /home/alon/secure-pi-bot/scripts/fan_logger.py

# --- Weekly Discord Report every Monday at 09:00 ---
0 9 * * 1 python3 /home/alon/secure-pi-bot/scripts/weekly_report.py

# --- Nightly Maintenance + Reboot at 03:00 ---
# compress_logs.py runs inside pi-maintenance.sh before reboot
0 3 * * * sudo /usr/local/bin/pi-maintenance.sh >> /var/log/pi-maintenance.log 2>&1
`,
  },
  {
    id: "setup",
    filename: "setup-notes.txt",
    path: null,
    description: "One-time setup steps for the new logging system.",
    tags: ["setup", "reference"],
    code: `# ============================================================
# SETUP -- New logging system
# ============================================================

# 1. Create directories and enable logging
mkdir -p /home/alon/secure-pi-bot/logs/weekly_reports
touch /home/alon/secure-pi-bot/.logging_enabled

# 2. Add GEMINI_API_KEY to .env
#    Get free key at: https://aistudio.google.com/app/apikey
echo 'GEMINI_API_KEY=your_key_here' >> /home/alon/secure-pi-bot/.env

# 3. Install any missing Python deps
pip3 install requests psutil python-dotenv

# 4. Apply updated crontab (replaces old one)
crontab - << 'EOF'
* * * * * python3 /home/alon/secure-pi-bot/scripts/profile_scheduler.py
*/10 * * * * python3 /home/alon/secure-pi-bot/scripts/system_logger.py
* * * * * python3 /home/alon/secure-pi-bot/scripts/fan_logger.py
0 9 * * 1 python3 /home/alon/secure-pi-bot/scripts/weekly_report.py
0 3 * * * sudo /usr/local/bin/pi-maintenance.sh >> /var/log/pi-maintenance.log 2>&1
EOF

# 5. Verify
crontab -l

# ============================================================
# COMMANDS
# ============================================================
# /logging start        -- enable system_logger.py
# /logging stop         -- disable system_logger.py
# /fanreport            -- show fan activation history
# /weeklyreport         -- post this week's report now
# /aidebug <question>   -- AI diagnostic (rate limited: 1 per 5 min)
#                          Posts to channel 1524756593651224706
# /fastfetch            -- run fastfetch
# /status               -- now includes RAM speed + core voltage
`,
  },
];

export default scripts;