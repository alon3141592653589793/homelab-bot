import aiDebugEntry from "./scripts/aiDebugEntry";
import apiFailReportEntry from "./scripts/apiFailReportEntry";
import testAllEntry from "./scripts/testAllEntry";
import setupEntry from "./scripts/setupEntry";
import crontabEntry from "./scripts/crontabEntry";
import apiManagerEntry from "./scripts/apiManagerEntry";

const scripts = [
  {
    id: "main",
    filename: "main.py",
    path: "~/secure-pi-bot/main.py",
    description: "Bot entry point. Thermal monitoring (60s), failed services alerts (60s), presence sync (240s).",
    tags: ["discord", "bot", "listener"],
    code: `import os
import sys
import json
import asyncio
import subprocess
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

if not TOKEN or not ALLOWED_USER_ID or not COMMAND_CHANNEL_ID or not ALERT_CHANNEL_ID:
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
                    f"{tag} Core temp breached threshold!\\n"
                    f"Current: {temp:.1f}C (Threshold: {ALERT_THRESHOLD:.1f}C)\\n"
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
            svc_list = "\\n".join(f"  | {s}" for s in sorted(new_failed))
            await ch.send(f"**Service Alert** - {len(new_failed)} new failure(s):\\n{svc_list}")
            # Auto-run AI diagnosis for newly failed services
            services_str = ", ".join(sorted(new_failed))
            auto_prompt = f"Automated alert: service(s) {services_str} just failed. Review system state and diagnose what went wrong. Suggest fixes."
            script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "ai_debug.py")
            try:
                proc = await asyncio.create_subprocess_exec(
                    "python3", "-u", script_path, "--auto-error", auto_prompt,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=180)
                output = stdout.decode().strip()
                if output:
                    if len(output) > 1900:
                        output = output[:1897] + "..."
                    await ch.send(output)
            except asyncio.TimeoutError:
                pass
            except Exception:
                pass
        if recovered:
            svc_list = "\\n".join(f"  | {s}" for s in sorted(recovered))
            await ch.send(f"**Service Recovered** - {len(recovered)} service(s) back online:\\n{svc_list}")
    
    try:
        with open(ALERTED_SVC_FILE, "w") as f:
            json.dump(sorted(current_failed), f)
    except OSError:
        pass

@client.event
async def on_ready():
    print(f"Bot online as {client.user}")
    os.makedirs("/dev/shm/pi-bot", exist_ok=True)
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
    description: "Command router. Maps Discord /commands to scripts.",
    tags: ["router", "dispatcher"],
    code: `import os
import subprocess
from modules.runner import run_script, confirm_and_run

LOGGING_FLAG = "/home/alon/secure-pi-bot/.logging_enabled"

async def handle_reactive_command(client, message):
    content = message.content.strip().lower()
    raw = message.content.strip()

    if content == "/status":
        await run_script(message, "status.py", "Querying system status...")

    elif content == "/cooldown":
        await run_script(message, "cooldown.py", "Running thermal cooldown...")

    elif content in ("/restart", "/reboot"):
        await confirm_and_run(client, message, "restart.py", "Reboot", "This will restart the Pi immediately.")

    elif content == "/shutdown":
        await confirm_and_run(client, message, "shutdown.py", "Shutdown", "This will power off the Pi. Physical access required to turn it back on.")

    elif content == "/fanreport":
        await run_script(message, "fan_report.py", "Reading fan log...")

    elif content == "/apifails":
        await run_script(message, "api_fail_report.py", "Reading API failure log (last 7d)...")

    elif content == "/lynis":
        await run_script(message, "lynis_report.py", "Running Lynis audit (this can take a couple minutes)...", timeout=240)

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

    elif content == "/weeklyreport stop":
        open("/home/alon/secure-pi-bot/.weekly_report_disabled", "w").close()
        await message.channel.send("Weekly report disabled. Scheduled reports will not run.")

    elif content == "/weeklyreport start":
        try:
            os.remove("/home/alon/secure-pi-bot/.weekly_report_disabled")
        except FileNotFoundError:
            pass
        await message.channel.send("Weekly report enabled. Next scheduled report will run normally.")

    elif content == "/logging start":
        open(LOGGING_FLAG, "w").close()
        await message.channel.send("Logging enabled.")

    elif content == "/logging stop":
        try:
            os.remove(LOGGING_FLAG)
        except FileNotFoundError:
            pass
        await message.channel.send("Logging disabled.")

    elif content == "/fastfetch":
        try:
            result = subprocess.run(
                ["fastfetch", "--logo", "none"],
                capture_output=True, text=True, timeout=10
            )
            output = (result.stdout or result.stderr or "No output.").strip()[:1900]
            await message.channel.send(output)
        except FileNotFoundError:
            await message.channel.send("fastfetch not installed. Run: sudo apt install fastfetch")
        except Exception as e:
            await message.channel.send(f"Error: {e}")

    elif content == "/updates stop":
        open("/home/alon/secure-pi-bot/.updates_disabled", "w").close()
        await message.channel.send("Automatic updates PAUSED. The weekly maintenance (Sun 03:00) will skip apt upgrade + reboot (logs, audit, service-check still run). /updates start to resume.")

    elif content == "/updates start":
        try:
            os.remove("/home/alon/secure-pi-bot/.updates_disabled")
        except FileNotFoundError:
            pass
        await message.channel.send("Automatic updates RESUMED. Next weekly maintenance (Sun 03:00) will run apt upgrade + reboot as normal.")

    elif raw.lower().startswith("/aidebug "):
        rest = raw[9:].strip()
        if rest:
            # Tokens are passed individually so the script can consume model
            # and on-demand tool prefixes (e.g. "gemini-3.5-flash lynis")
            await run_script(message, "ai_debug.py", "Thinking...", args=rest.split(), timeout=300)
        else:
            await message.channel.send("Usage: /aidebug <question>\\nOptional model prefix: /aidebug [gemini-2.5-flash] <question>")

    elif content == "/testall":
        await run_script(message, "test_all.py", "Running full test suite -> #testing...", timeout=1800)

    elif content == "/help":
        await message.channel.send(
            "Available commands:\\n"
            "/status               - System metrics\\n"
            "/cooldown             - Stop non-essential services\\n"
            "/restart              - Reboot Pi (requires confirmation)\\n"
            "/shutdown             - Power off Pi (requires confirmation)\\n"
            "/fanreport            - Show fan activation log\\n"
            "/apifails             - API call failure rate (last 7 days)\\n"
            "/lynis                - Run Lynis security audit now\\n"
            "/weeklyreport         - Post weekly summary now\\n"
            "/weeklyreport stop    - Disable scheduled weekly reports\\n"
            "/weeklyreport start   - Re-enable scheduled weekly reports\\n"
            "/logging start|stop   - Toggle system logger\\n"
            "/profile              - Show CPU performance profile\\n"
            "/setprofile restricted|unlimited  - Switch CPU profile\\n"
            "/fastfetch            - Run fastfetch\\n"
            "/updates start|stop   - Pause or resume automatic apt upgrade + reboot\\n"
            "/aidebug <question>   - Conversational AI diagnostic\\n"
            "/help                 - This message"
        )
`,
  },
  {
    id: "runner",
    filename: "runner.py",
    path: "~/secure-pi-bot/modules/runner.py",
    description: "Execution helpers. run_script runs a subprocess and sends output to Discord.",
    tags: ["runner", "confirmation", "discord"],
    code: `import subprocess
import asyncio
import os

SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")


async def run_script(message, script_name, status_msg, args=None, timeout=45):
    script_path = os.path.join(SCRIPTS_DIR, script_name)
    if status_msg:
        await message.channel.send(status_msg)
    try:
        cmd = ["python3", "-u", script_path] + (args or [])
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        output = (result.stdout or result.stderr or "No output.").strip()
        if len(output) > 1900:
            output = output[:1897] + "..."
        await message.channel.send(output)
    except subprocess.TimeoutExpired:
        await message.channel.send(f"Script timed out after {timeout} seconds.")
    except Exception as e:
        await message.channel.send(f"Script error: {e}")


async def confirm_and_run(client, message, script_name, action_name, description):
    confirm_msg = await message.channel.send(
        f"[{action_name.upper()} - CONFIRMATION REQUIRED]\\n"
        f"{description}\\n"
        f"React with ✅ to confirm or ❌ to cancel. Timeout: 30s."
    )
    await confirm_msg.add_reaction("\\u2705")
    await confirm_msg.add_reaction("\\u274c")

    def check(reaction, user):
        return (
            user.id == message.author.id
            and reaction.message.id == confirm_msg.id
            and str(reaction.emoji) in ("\\u2705", "\\u274c")
        )

    try:
        reaction, _ = await client.wait_for("reaction_add", timeout=30.0, check=check)
        if str(reaction.emoji) == "\\u2705":
            await message.channel.send(f"{action_name} confirmed. Executing...")
            await run_script(message, script_name, "")
        else:
            await message.channel.send(f"{action_name} cancelled.")
    except asyncio.TimeoutError:
        await message.channel.send(f"{action_name} timed out. Cancelled.")
`,
  },
  {
    id: "status",
    filename: "status.py",
    path: "~/secure-pi-bot/scripts/status.py",
    description: "System metrics: temp, CPU, GPU, RAM, profile, IP, uptime, current time. No voltage. 0.5s CPU interval.",
    tags: ["status", "hardware", "psutil"],
    code: `import sys
import subprocess
from datetime import datetime

try:
    import psutil
except ImportError:
    print("FAILURE: psutil missing. pip3 install psutil")
    sys.exit(1)

def sysfs(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None

def vcgencmd(arg):
    try:
        r = subprocess.run(["vcgencmd"] + arg.split(), capture_output=True, text=True, timeout=3)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None

# Temperature
raw_temp = sysfs("/sys/class/thermal/thermal_zone0/temp")
temp = f"{int(raw_temp) / 1000:.1f}C" if raw_temp else "Unknown"

# CPU — 0.5s interval
cpu_pct = psutil.cpu_percent(interval=0.5)
freq = psutil.cpu_freq()
cpu_ghz = f"{freq.current / 1000:.2f} GHz" if freq else "Unknown"

# GPU
gpu_raw = vcgencmd("measure_clock core")
gpu_mhz = f"{int(gpu_raw.split('=')[1]) // 1_000_000} MHz" if gpu_raw else "Unknown"

# RAM
vm = psutil.virtual_memory()
ram_str = f"{vm.used // (1024*1024)} MB / {vm.total // (1024*1024)} MB ({vm.percent}%)"

# RAM speed — vcgencmd can't measure SDRAM on Pi 4 (returns 0)
# Try get_config, then detect by Pi model from device tree
ram_speed = "N/A"
config_raw = vcgencmd("get_config sdram_freq")
if config_raw:
    try:
        val = int(config_raw.split("=")[1])
        if val > 0:
            ram_speed = f"{val} MHz"
    except (ValueError, IndexError):
        pass
if ram_speed == "N/A":
    model_raw = (sysfs("/proc/device-tree/model") or "").split(chr(0))[0].strip()
    if "Pi 5" in model_raw:
        ram_speed = "4267 MHz"
    elif "Pi 4" in model_raw:
        ram_speed = "3200 MHz"
    elif "Pi Zero 2" in model_raw or "Pi 3" in model_raw:
        ram_speed = "450 MHz"
    elif "Pi Zero" in model_raw:
        ram_speed = "400 MHz"

# Profile
try:
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
        max_khz = int(f.read().strip())
    profile = "Restricted" if max_khz <= 600000 else "Unlimited"
except OSError:
    profile = "Unknown"

# IP
try:
    r = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3)
    ip = r.stdout.strip().split()[0] if r.stdout.strip() else "Unknown"
except Exception:
    ip = "Unknown"

# Uptime
try:
    boot_dt = datetime.fromtimestamp(psutil.boot_time())
    d = datetime.now() - boot_dt
    uptime = f"{d.days}d {d.seconds//3600}h {(d.seconds%3600)//60}m"
except Exception:
    uptime = "Unknown"

# Current time
now_str = datetime.now().strftime("%H:%M:%S")

# Last upgrade
last_upgrade = sysfs("/home/alon/.secrets/last_upgrade.txt") or "Unknown"

print(
    f"**Pi Status** — {now_str}\\n"
    f"Temp: {temp} | CPU: {cpu_pct}% {cpu_ghz}\\n"
    f"GPU: {gpu_mhz} | Profile: {profile}\\n"
    f"RAM: {ram_str} | RAM Speed: {ram_speed}\\n"
    f"IP: {ip} | Uptime: {uptime}\\n"
    f"Last Upgrade: {last_upgrade}"
)
`,
  },
  {
    id: "fan-logger",
    filename: "fan_logger.py",
    path: "~/secure-pi-bot/scripts/fan_logger.py",
    description: "Logs fan ON/OFF transitions to /dev/shm (RAM). 60s boot delay. No SD writes. Flushed by compress_logs.py before reboot. Caps at 2000 lines.",
    tags: ["fan", "logging", "thermal"],
    code: `import os
import json
from datetime import datetime

PIBOT_DIR = "/dev/shm/pi-bot"
RAM_LOG = f"{PIBOT_DIR}/fan_events.jsonl"
STATE_FILE = f"{PIBOT_DIR}/fan_state.txt"
MAX_LINES = 2000

# Wait 60s after boot — fan behavior is erratic during early boot
try:
    with open("/proc/uptime") as f:
        uptime = float(f.read().split()[0])
    if uptime < 60:
        raise SystemExit(0)
except OSError:
    pass

# If the RAM dir doesn't exist yet the bot hasn't started — skip silently
if not os.path.isdir(PIBOT_DIR):
    raise SystemExit(0)

def get_fan_active() -> bool:
    import subprocess
    # vcgencmd get_fan — Pi 5 / official fan HAT
    try:
        r = subprocess.run(["vcgencmd", "get_fan"], capture_output=True, text=True, timeout=3)
        if r.returncode == 0:
            return r.stdout.strip().endswith("=1")
    except Exception:
        pass
    # GPIO sysfs (GPIO 14 default fan pin)
    try:
        with open("/sys/class/gpio/gpio14/value") as f:
            return f.read().strip() == "1"
    except OSError:
        pass
    # Fallback: temperature inference
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return int(f.read()) >= 65000
    except OSError:
        return False

now_active = get_fan_active()
now_str = datetime.now().isoformat(timespec="seconds")

# Read previous state (tiny JSON in RAM)
prev_state = None
try:
    with open(STATE_FILE) as f:
        prev_state = json.load(f).get("active")
except (OSError, json.JSONDecodeError):
    pass

# Write new state
with open(STATE_FILE, "w") as f:
    json.dump({"active": now_active, "ts": now_str}, f)

# Only append to log on state change (or first run)
if prev_state is None or prev_state != now_active:
    note = "initial" if prev_state is None else None
    event = {"ts": now_str, "event": "on" if now_active else "off"}
    if note:
        event["note"] = note

    # Cap log size to avoid unbounded RAM growth
    try:
        with open(RAM_LOG) as f:
            existing = f.readlines()
    except OSError:
        existing = []

    if len(existing) >= MAX_LINES:
        existing = existing[MAX_LINES // 2:]  # drop oldest half

    existing.append(json.dumps(event) + "\\n")
    with open(RAM_LOG, "w") as f:
        f.writelines(existing)
`,
  },
  {
    id: "fan-report",
    filename: "fan_report.py",
    path: "~/secure-pi-bot/scripts/fan_report.py",
    description: "Reads fan event log (RAM + disk) and outputs plain-text summary for Discord.",
    tags: ["fan", "report", "discord"],
    code: `import os
import json
import sys
from datetime import datetime

RAM_LOG = "/dev/shm/pi-bot/fan_events.jsonl"
DISK_LOG = "/home/alon/secure-pi-bot/logs/fan_events.jsonl"

events = []
seen = set()
for path in (DISK_LOG, RAM_LOG):
    if not os.path.exists(path):
        continue
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
                if e["ts"] not in seen:
                    seen.add(e["ts"])
                    events.append(e)
            except (json.JSONDecodeError, KeyError):
                continue

events.sort(key=lambda x: x["ts"])

if not events:
    print("No fan events logged yet.")
    sys.exit(0)

# Build sessions: on -> off pairs
sessions = []
i = 0
while i < len(events):
    if events[i]["event"] == "on":
        start = events[i]["ts"]
        end = None
        for j in range(i + 1, len(events)):
            if events[j]["event"] == "off":
                end = events[j]["ts"]
                i = j
                break
        sessions.append((start, end))
    i += 1

lines = [f"**Fan Log** ({len(sessions)} sessions)"]
for start, end in sessions[-20:]:
    s = datetime.fromisoformat(start)
    if end:
        e = datetime.fromisoformat(end)
        secs = (e - s).total_seconds()
        lines.append(f"  {s.strftime('%m/%d %H:%M')} -> {e.strftime('%H:%M')} ({int(secs//60)}m{int(secs%60):02d}s)")
    else:
        lines.append(f"  {s.strftime('%m/%d %H:%M')} -> running")

total = sum(
    (datetime.fromisoformat(e) - datetime.fromisoformat(s)).total_seconds()
    for s, e in sessions if e
)
lines.append(f"Total fan-on: {int(total // 60)}m")
print("\\n".join(lines))
`,
  },
  {
    id: "lynis-report",
    filename: "lynis_report.py",
    path: "~/secure-pi-bot/scripts/lynis_report.py",
    description: "Manual Lynis security audit invoked by /lynis. Surfaces warnings (W:), suggestions (S:), hardening index, and test count from a quick scan. Self-contained 180s internal timeout (outer runner gets 240s).",
    tags: ["audit", "security", "lynis", "discord"],
    code: `import subprocess
from datetime import datetime

try:
    r = subprocess.run(
        ["lynis", "audit", "system", "--quick", "--no-colors"],
        capture_output=True, text=True, timeout=180
    )
    out = (r.stdout or r.stderr or "").strip()
except FileNotFoundError:
    print("FAILURE: lynis not installed. Run: sudo apt install lynis")
    raise SystemExit(0)
except subprocess.TimeoutExpired:
    print("FAILURE: lynis timed out after 180s")
    raise SystemExit(0)

lines = out.splitlines()
interesting = []
for ln in lines:
    s = ln.strip()
    if s.startswith("W:") or s.startswith("S:") or "Hardening index" in s or "Tests performed" in s:
        interesting.append(s)

ts = datetime.now().strftime("%H:%M")
header = f"**Lynis Report** [{ts}]"
if not interesting:
    print(f"{header}\\nNo warnings or suggestions found.\\n\\n{out[-1500:]}")
else:
    body = "\\n".join(interesting)
    if len(body) > 1800:
        body = body[:1800]
    print(f"{header}\\n{body}")
`,
  },
  {
    id: "system-logger",
    filename: "system_logger.py",
    path: "~/secure-pi-bot/scripts/system_logger.py",
    description: "10-min cron logger. Temp to RAM. Warns on 90%+ RAM and disk I/O spikes. No continuous RAM logging. Failed services handled by bot.",
    tags: ["logging", "temperature", "warnings"],
    code: `import os
import sys
import json
from datetime import datetime

ENABLED_FLAG = "/home/alon/secure-pi-bot/.logging_enabled"
PIBOT_DIR = "/dev/shm/pi-bot"
RAM_LOG = f"{PIBOT_DIR}/system_log.jsonl"
DISK_IO_STATE = f"{PIBOT_DIR}/.disk_io_state"
MAX_LINES = 1500

if not os.path.exists(ENABLED_FLAG):
    sys.exit(0)

os.makedirs(PIBOT_DIR, exist_ok=True)

try:
    import psutil
except ImportError:
    sys.exit(1)

ts = datetime.now().isoformat(timespec="seconds")

# Temp — direct sysfs read
try:
    with open("/sys/class/thermal/thermal_zone0/temp") as f:
        temp_c = round(int(f.read()) / 1000.0, 1)
except OSError:
    temp_c = None

# RAM — only flag at 90%+ (not logged every tick)
vm = psutil.virtual_memory()
ram_warning = vm.percent >= 90.0

# Disk I/O spike — compare with last reading (>5 MB/s avg = spike)
disk_warning = False
current_io = psutil.disk_io_counters()
if current_io:
    if os.path.exists(DISK_IO_STATE):
        try:
            with open(DISK_IO_STATE) as f:
                prev = json.load(f)
            delta = (current_io.read_bytes + current_io.write_bytes) - (prev["read_bytes"] + prev["write_bytes"])
            elapsed = (datetime.now() - datetime.fromisoformat(prev["ts"])).total_seconds()
            if elapsed > 0 and (delta / elapsed) / (1024 * 1024) > 5:
                disk_warning = True
        except Exception:
            pass
    with open(DISK_IO_STATE, "w") as f:
        json.dump({"read_bytes": current_io.read_bytes, "write_bytes": current_io.write_bytes, "ts": ts}, f)

# Build entry — temp + warnings only (no continuous RAM)
entry = {"ts": ts, "temp_c": temp_c}
if ram_warning:
    entry["ram_warning"] = True
    entry["ram_pct"] = round(vm.percent, 1)
if disk_warning:
    entry["disk_spike"] = True

# Temp spike detection — seek to end for last line
last_temp = None
if os.path.exists(RAM_LOG):
    try:
        with open(RAM_LOG, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 512))
            tail = f.read().decode(errors="ignore")
            last_line = [l for l in tail.splitlines() if l.strip()][-1] if tail.strip() else None
            if last_line:
                last_temp = json.loads(last_line).get("temp_c")
    except Exception:
        pass

if last_temp is not None and temp_c is not None and temp_c - last_temp >= 5.0:
    entry["spike"] = True

# Cap log size
try:
    with open(RAM_LOG) as f:
        lines = f.readlines()
except OSError:
    lines = []

if len(lines) >= MAX_LINES:
    lines = lines[MAX_LINES // 2:]

lines.append(json.dumps(entry) + "\\n")
with open(RAM_LOG, "w") as f:
    f.writelines(lines)
`,
  },
  {
    id: "compress-logs",
    filename: "compress_logs.py",
    path: "~/secure-pi-bot/scripts/compress_logs.py",
    description: "Called before reboot. Triggers log_sync.py to flush RAM logs to Google Sheets (NO SD writes). Thin wrapper — syncing logic lives in log_sync.py.",
    tags: ["logging", "compression", "maintenance"],
    code: `import os
import subprocess

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))

# Before reboot — flush any unsynced RAM logs to Google Sheets (NO SD writes).
# Delta-sync + service-account auth live in log_sync.py.
r = subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "log_sync.py")],
                   capture_output=True, text=True, timeout=120)
out = (r.stdout or "").strip()
err = (r.stderr or "").strip()
if err:
    print(f"Log sync warning: {err}")
print(out or "Logs synced to Google Sheets.")
`,
  },
  {
    id: "weekly-report",
    filename: "weekly_report.py",
    path: "~/secure-pi-bot/scripts/weekly_report.py",
    description: "Weekly report: temp, fan. No RAM or failed services (handled by bot). Can be disabled via /weeklyreport stop.",
    tags: ["report", "discord", "weekly"],
    code: `import os
import sys
import json
from datetime import datetime, timedelta

try:
    import psutil
    import requests
except ImportError as e:
    print(f"FAILURE: {e}")
    sys.exit(1)

BOT_DIR = "/home/alon/secure-pi-bot"
REPORT_CHANNEL_ID = 1524756593651224706

os.makedirs("/dev/shm/pi-bot", exist_ok=True)

if os.path.exists(f"{BOT_DIR}/.weekly_report_disabled"):
    print("Weekly report disabled. Use /weeklyreport start to re-enable.")
    sys.exit(0)

from dotenv import load_dotenv
load_dotenv(f"{BOT_DIR}/.env")
BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
if not BOT_TOKEN:
    print("FAILURE: DISCORD_BOT_TOKEN not set")
    sys.exit(1)

DISCORD_URL = f"https://discord.com/api/v10/channels/{REPORT_CHANNEL_ID}/messages"
DISCORD_HEADERS = {"Authorization": f"Bot {BOT_TOKEN}", "Content-Type": "application/json"}

def post(text):
    for chunk in [text[i:i+1900] for i in range(0, len(text), 1900)]:
        r = requests.post(DISCORD_URL, json={"content": chunk}, headers=DISCORD_HEADERS, timeout=10)
        if r.status_code not in (200, 201):
            print(f"FAILURE: Discord {r.status_code}: {r.text}")
            sys.exit(1)

cutoff = datetime.now() - timedelta(days=7)

def load_jsonl_since(paths, ts_key_candidates):
    out = []
    seen = set()
    for path in paths:
        if not os.path.exists(path):
            continue
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    ts_str = next((e[k] for k in ts_key_candidates if k in e), None)
                    if not ts_str or ts_str in seen:
                        continue
                    if datetime.fromisoformat(ts_str) >= cutoff:
                        seen.add(ts_str)
                        out.append(e)
                except Exception:
                    continue
    return out

sys_entries = load_jsonl_since(
    [f"{BOT_DIR}/logs/system_log.jsonl", "/dev/shm/pi-bot/system_log.jsonl"],
    ["ts_start", "ts"]
)
fan_entries = sorted(
    load_jsonl_since(
        [f"{BOT_DIR}/logs/fan_events.jsonl", "/dev/shm/pi-bot/fan_events.jsonl"],
        ["ts"]
    ),
    key=lambda x: x["ts"]
)

# Stats
temps = [e.get("temp_c") or e.get("temp_avg_c") for e in sys_entries]
temps = [t for t in temps if t is not None]
spikes = [e for e in sys_entries if e.get("spike") or e.get("spike_flag")]

# Fan sessions
fan_sessions = []
i = 0
while i < len(fan_entries):
    if fan_entries[i]["event"] == "on":
        start = fan_entries[i]["ts"]
        end = next((fan_entries[j]["ts"] for j in range(i+1, len(fan_entries)) if fan_entries[j]["event"] == "off"), None)
        fan_sessions.append((start, end))
        if end:
            i = next(j for j in range(i+1, len(fan_entries)) if fan_entries[j]["ts"] == end)
    i += 1

total_fan_s = sum(
    (datetime.fromisoformat(e) - datetime.fromisoformat(s)).total_seconds()
    for s, e in fan_sessions if e
)

try:
    boot = datetime.fromtimestamp(psutil.boot_time())
    d = datetime.now() - boot
    uptime = f"{d.days}d {d.seconds//3600}h"
except Exception:
    uptime = "Unknown"

week = datetime.now().strftime("%b %d, %Y")
lines = [f"**Weekly Pi Report -- {week}**", f"Uptime: {uptime}"]

lines.append(
    f"Temp (7d): Avg {sum(temps)/len(temps):.1f}C | Min {min(temps):.1f}C | Max {max(temps):.1f}C"
    if temps else "Temp: No data (enable with /logging start)"
)

if spikes:
    sp = " | ".join(
        f"{datetime.fromisoformat(s.get('ts') or s.get('ts_start','')).strftime('%m/%d %H:%M')}={s.get('temp_c') or s.get('temp_avg_c')}C"
        for s in spikes[-5:]
    )
    lines.append(f"Spikes ({len(spikes)}): {sp}")

lines.append(f"Fan: {len(fan_sessions)} sessions | {int(total_fan_s//60)}m total")

report = "\\n".join(lines)

post(report)
print("Weekly report sent.")
`,
  },
  aiDebugEntry,
  apiFailReportEntry,
  testAllEntry,
  {
    id: "cooldown",
    filename: "cooldown.py",
    path: "~/secure-pi-bot/scripts/cooldown.py",
    description: "Stops non-essential services. Uses systemctl without sudo (works if alon is in the 'adm' group or has polkit rules).",
    tags: ["thermal", "services"],
    code: `import subprocess

TARGETS = ["nginx", "lightdm", "bluetooth", "cups"]

stopped = []
for svc in TARGETS:
    r = subprocess.run(["systemctl", "is-active", "--quiet", svc])
    if r.returncode == 0:  # active
        subprocess.run(["systemctl", "stop", svc], capture_output=True)
        stopped.append(svc)

if stopped:
    print(f"Stopped: {', '.join(stopped)}")
else:
    print("No target services were active.")
`,
  },
  {
    id: "restart",
    filename: "restart.py",
    path: "~/secure-pi-bot/scripts/restart.py",
    description: "Logs then reboots via systemctl (polkit rule grants permission, no sudo). Requires /etc/polkit-1/rules.d/49-pi-bot.rules.",
    tags: ["reboot"],
    code: `import subprocess, os, json
from datetime import datetime
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = "/dev/shm/pi-bot/command_log.jsonl"

print("Flushing logs...")
subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "compress_logs.py")], capture_output=True)

# Wait for any in-flight critical cloud ops (Drive/Sheets sync) before rebooting
import api_manager
api_manager.wait_critical()

# Use systemctl reboot — goes through polkit (no sudo, no password prompt)
result = subprocess.run(["systemctl", "reboot"], capture_output=True, text=True, timeout=10)
if result.returncode != 0:
    err = result.stderr.strip() or result.stdout.strip() or "unknown error"
    print(f"FAILED to reboot: {err}")
    # Log to RAM
    try:
        os.makedirs("/dev/shm/pi-bot", exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps({"ts": datetime.now().isoformat(timespec="seconds"), "cmd": "restart", "status": "failed", "error": err}) + "\\n")
    except OSError:
        pass
else:
    print("Rebooting...")
    try:
        os.makedirs("/dev/shm/pi-bot", exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps({"ts": datetime.now().isoformat(timespec="seconds"), "cmd": "restart", "status": "ok"}) + "\\n")
    except OSError:
        pass
`,
  },
  {
    id: "shutdown",
    filename: "shutdown.py",
    path: "~/secure-pi-bot/scripts/shutdown.py",
    description: "Logs then powers off via systemctl (polkit rule grants permission, no sudo). Requires /etc/polkit-1/rules.d/49-pi-bot.rules.",
    tags: ["shutdown"],
    code: `import subprocess, os, json
from datetime import datetime
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = "/dev/shm/pi-bot/command_log.jsonl"

print("Flushing logs...")
subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "compress_logs.py")], capture_output=True)

# Wait for any in-flight critical cloud ops before power off
import api_manager
api_manager.wait_critical()

# Use systemctl poweroff — goes through polkit (no sudo, no password prompt)
result = subprocess.run(["systemctl", "poweroff"], capture_output=True, text=True, timeout=10)
if result.returncode != 0:
    err = result.stderr.strip() or result.stdout.strip() or "unknown error"
    print(f"FAILED to power off: {err}")
    try:
        os.makedirs("/dev/shm/pi-bot", exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps({"ts": datetime.now().isoformat(timespec="seconds"), "cmd": "shutdown", "status": "failed", "error": err}) + "\\n")
    except OSError:
        pass
else:
    print("Powering off...")
    try:
        os.makedirs("/dev/shm/pi-bot", exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps({"ts": datetime.now().isoformat(timespec="seconds"), "cmd": "shutdown", "status": "ok"}) + "\\n")
    except OSError:
        pass
`,
  },
  {
    id: "set-profile-restricted",
    filename: "set_profile_restricted.py",
    path: "~/secure-pi-bot/scripts/set_profile_restricted.py",
    description: "Restricted profile: 600 MHz, powersave. Writes sysfs directly (works if alon owns the cpufreq files via udev rule). Falls back to sudo tee only if needed.",
    tags: ["performance", "thermal", "cpu"],
    code: `import subprocess, sys, os

GOVERNOR = "powersave"
MAX_FREQ = "600000"
STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"

def write_sysfs(path, value):
    try:
        with open(path, "w") as f:
            f.write(value)
        return True
    except PermissionError:
        r = subprocess.run(["sudo", "tee", path], input=value, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"FAILED {path}: {r.stderr.strip()}")
            sys.exit(1)

for core in range(4):
    base = f"/sys/devices/system/cpu/cpu{core}/cpufreq"
    write_sysfs(f"{base}/scaling_governor", GOVERNOR)
    write_sysfs(f"{base}/scaling_max_freq", MAX_FREQ)

with open(STATE_FILE, "w") as f:
    f.write("restricted")

print(f"Profile: RESTRICTED | Governor: {GOVERNOR} | Max: {int(MAX_FREQ)//1000} MHz")
`,
  },
  {
    id: "set-profile-unlimited",
    filename: "set_profile_unlimited.py",
    path: "~/secure-pi-bot/scripts/set_profile_unlimited.py",
    description: "Unlimited profile: 1.7 GHz, schedutil. Clears override so scheduler resumes.",
    tags: ["performance", "cpu"],
    code: `import subprocess, sys, os

GOVERNOR = "schedutil"
MAX_FREQ = "1700000"
STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"

def write_sysfs(path, value):
    try:
        with open(path, "w") as f:
            f.write(value)
    except PermissionError:
        r = subprocess.run(["sudo", "tee", path], input=value, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"FAILED {path}: {r.stderr.strip()}")
            sys.exit(1)

for core in range(4):
    base = f"/sys/devices/system/cpu/cpu{core}/cpufreq"
    write_sysfs(f"{base}/scaling_governor", GOVERNOR)
    write_sysfs(f"{base}/scaling_max_freq", MAX_FREQ)

try:
    os.remove(STATE_FILE)
except FileNotFoundError:
    pass

print(f"Profile: UNLIMITED | Governor: {GOVERNOR} | Max: {int(MAX_FREQ)//1000} MHz")
`,
  },
  {
    id: "profile-status",
    filename: "profile_status.py",
    path: "~/secure-pi-bot/scripts/profile_status.py",
    description: "Reports active CPU profile by reading sysfs directly.",
    tags: ["performance", "status"],
    code: `import os

STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"

def sysfs(path, default="unknown"):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default

governor = sysfs("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
max_khz = int(sysfs("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq", "0"))
cur_khz = int(sysfs("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "0"))

profile = "RESTRICTED" if max_khz <= 600000 else "UNLIMITED"
sched = "Manual override (scheduler paused)" if os.path.exists(STATE_FILE) else "Auto-scheduler active"

print(
    f"Profile: {profile} | Governor: {governor}\\n"
    f"Max: {max_khz//1000} MHz | Current: {cur_khz//1000} MHz\\n"
    f"Scheduler: {sched}"
)
`,
  },
  {
    id: "update-bot-status",
    filename: "update_bot_status.py",
    path: "~/secure-pi-bot/scripts/update_bot_status.py",
    description: "Writes bot presence status to /dev/shm (RAM, not SD). main.py reads it every 4 min.",
    tags: ["discord", "status", "performance"],
    code: `import os, sys, json

# Write to RAM — not SD card
STATUS_FILE = "/dev/shm/pi-bot/.bot_status.json"
STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"

try:
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
        max_khz = int(f.read().strip())
except OSError:
    sys.exit(1)

if max_khz <= 600000:
    text = "Resting | 600 MHz | Powersave"
else:
    text = "Active | 1.7 GHz | Schedutil"

if os.path.exists(STATE_FILE):
    text += " (manual)"

os.makedirs("/dev/shm/pi-bot", exist_ok=True)
with open(STATUS_FILE, "w") as f:
    json.dump({"text": text}, f)

print(f"Status: {text}")
`,
  },
  {
    id: "profile-scheduler",
    filename: "profile_scheduler.py",
    path: "~/secure-pi-bot/scripts/profile_scheduler.py",
    description: "Runs every minute via cron. Switches CPU profile by time. Instant exit if no change needed — minimal overhead.",
    tags: ["performance", "scheduler", "cron"],
    code: `import subprocess, sys, os
from datetime import datetime

STATE_FILE = "/home/alon/secure-pi-bot/.profile_override"
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))

# Skip instantly if manual override active
if os.path.exists(STATE_FILE):
    sys.exit(0)

hour = datetime.now().hour
want_restricted = hour >= 23 or hour < 7

try:
    with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
        is_restricted = int(f.read()) <= 600000
except OSError:
    sys.exit(1)

# Only act if state needs to change
if want_restricted and not is_restricted:
    subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "set_profile_restricted.py")], capture_output=True)
elif not want_restricted and is_restricted:
    subprocess.run(["python3", os.path.join(SCRIPTS_DIR, "set_profile_unlimited.py")], capture_output=True)
`,
  },
  {
    id: "maintenance",
    filename: "pi-maintenance.sh",
    path: "/usr/local/bin/pi-maintenance.sh",
    description: "Daily maintenance — flush logs, AdGuard, audit (Sun), service check. apt update+full-upgrade+autoremove + reboot only on Sun (DOW 7), CPU-throttled to 600 MHz/powersave + nice/ionice + thermal gates between steps. Skipped when .updates_disabled is set via /updates stop, but logs/audit/service-check still run daily.",
    tags: ["maintenance", "bash", "cron", "thermal", "throttled"],
    code: `#!/bin/bash
# Master Maintenance Script — full nightly, CPU-throttled to stay cool

LOG_FILE="/dev/shm/pi-bot/maintenance.log"
QUEUE="/home/alon/scripts/logs/ntfy_queue.txt"
mkdir -p /home/alon/scripts/logs
mkdir -p /dev/shm/pi-bot

[ -f /home/alon/secure-pi-bot/.maintenance_disabled ] && {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Maintenance disabled." >> "$LOG_FILE"
    exit 0
}

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; }

# --- Thermal gate (temp in milli-degrees) ---
TEMP_ZONE="/sys/class/thermal/thermal_zone0/temp"
COOL_BELOW=55000     # wait until under 55C between steps
MAX_WAIT_SEC=1800    # cap per-step thermal wait at 30 min

cur_temp() { cat "$TEMP_ZONE" 2>/dev/null || echo 0; }

wait_for_cool() {
    local waited=0
    while [ "$waited" -lt "$MAX_WAIT_SEC" ]; do
        local t=$(cur_temp)
        [ "$t" -eq 0 ] && return 0
        [ "$t" -lt "$COOL_BELOW" ] && return 0
        log "Thermal gate: $((t/1000))C — waiting 30s..."
        sleep 30
        waited=$((waited + 30))
    done
    log "Thermal gate: max wait reached, proceeding anyway"
}

# --- CPU throttle: cap ALL cores to 600 MHz / powersave for the whole window.
# THIS is how heat is kept down — NOT by skipping work. Everything still runs.
# Reboot at the end resets clocks; profile_scheduler (cron) restores governor.
throttle_cpu() {
    for core in 0 1 2 3; do
        echo powersave > /sys/devices/system/cpu/cpu$core/cpufreq/scaling_governor 2>/dev/null
        echo 600000   > /sys/devices/system/cpu/cpu$core/cpufreq/scaling_max_freq 2>/dev/null
    done
    log "CPU throttled to 600 MHz / powersave"
}

# Lowest CPU + idle-IO priority. apt told to keep old conffiles so full-upgrade
# never blocks on an interactive prompt during the automated run.
NICE="nice -n 19 ionice -c 3"
APT_OPTS="-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef -o Acquire::Retries=3"

log "--- MAINTENANCE START (full nightly, throttled) ---"
echo "--- Pi Report ($(date '+%Y-%m-%d')) ---" > "$QUEUE"

# 0. Throttle CPU + flush RAM logs
throttle_cpu
log "Flushing RAM logs..."
python3 /home/alon/secure-pi-bot/scripts/compress_logs.py >> "$LOG_FILE" 2>&1
wait_for_cool

# 1. AdGuard
log "AdGuard upgrade..."
/opt/AdGuardHome/AdGuardHome -s upgrade >> "$LOG_FILE" 2>&1
wait_for_cool

UPDATES_LOCK="/home/alon/secure-pi-bot/.updates_disabled"
UPDATES_DOW="7"   # weekly apt+reboot day (1=Mon..7=Sun)

# 2. OS Updates — full cycle, throttled (only on $UPDATES_DOW; skipped if /updates stop)
if [ -f "$UPDATES_LOCK" ] || [ "$(date +%u)" != "$UPDATES_DOW" ]; then
    log "OS Updates: SKIPPED (.updates_disabled set, or not weekly DOW $UPDATES_DOW)"
    echo "OS Updates: PAUSED (weekly DOW $UPDATES_DOW)" >> "$QUEUE"
else
    log "apt update..."
    $NICE apt-get update -y >> "$LOG_FILE" 2>&1
    wait_for_cool
    log "apt full-upgrade (throttled, auto-resolve conffiles)..."
    $NICE apt-get $APT_OPTS full-upgrade -y >> "$LOG_FILE" 2>&1
    wait_for_cool
    log "apt autoremove..."
    $NICE apt-get $APT_OPTS autoremove -y >> "$LOG_FILE" 2>&1
    echo "OS Updates: FULL (throttled, weekly DOW $UPDATES_DOW)" >> "$QUEUE"

    mkdir -p /home/alon/.secrets
    date '+%Y-%m-%d %H:%M:%S' > /home/alon/.secrets/last_upgrade.txt
    chown alon:alon /home/alon/.secrets/last_upgrade.txt
fi
wait_for_cool

# 3. Security Audit — once a week (Sunday), throttled
if [ "$(date +%u)" = "7" ]; then
    log "Security audit (weekly Sunday)..."
    $NICE /usr/local/bin/pi-audit.sh >> "$LOG_FILE" 2>&1
    echo "Audit: COMPLETED (weekly Sun)" >> "$QUEUE"
else
    log "Audit: skipped (weekly — runs Sunday)"
    echo "Audit: SKIPPED (weekly Sun)" >> "$QUEUE"
fi
wait_for_cool

# 4. Service Health
FAILED=$(systemctl list-units --state=failed --no-legend --plain | grep -v clamav | awk '{print $1}')
if [[ -n "$FAILED" ]]; then
    echo "FAILED: $FAILED" >> "$QUEUE"
    log "CRITICAL: $FAILED"
else
    echo "Services: OK" >> "$QUEUE"
fi

# 5. Sync + Notify
sync
/usr/local/bin/ntfy-queue.sh >> "$LOG_FILE" 2>&1

# 6. Reboot — only when updates ran (weekly). Resets CPU clocks; profile_scheduler restores governor within 1 min.
if [ -f "$UPDATES_LOCK" ] || [ "$(date +%u)" != "$UPDATES_DOW" ]; then
    log "Reboot: SKIPPED (no updates ran this pass)"
    echo "Reboot: SKIPPED" >> "$QUEUE"
else
    python3 -c "import sys; sys.path.insert(0,'/home/alon/secure-pi-bot/scripts'); import api_manager; api_manager.wait_critical()"
    log "Rebooting in 60s."
    shutdown -r +1 "Scheduled Maintenance Reboot" >> "$LOG_FILE" 2>&1
fi
`,
  },
  {
    id: "pi-audit",
    filename: "pi-audit.sh",
    path: "/usr/local/bin/pi-audit.sh",
    description: "Weekly (Sunday) security audit called by pi-maintenance.sh. Runs ClamAV + Rkhunter under nice/ionice (Lynis disabled for now — re-enable in step 3). NO apt upgrades or reboot (maintenance owns those). Aborts if .maintenance_disabled lock is set. Replaces the legacy pi-audit Go binary.",
    tags: ["audit", "security", "bash", "maintenance"],
    code: `#!/bin/bash
# Security audit — ClamAV + Rkhunter + Lynis, throttled under nice/ionice.
# Called nightly by pi-maintenance.sh at 03:00 (inherits root — no sudo here).
# NO OS upgrades or reboots — pi-maintenance.sh owns those.
# Refuses to run while the maintenance_disabled lock is set.

TS() { date '+%Y-%m-%d %H:%M:%S'; }
LOCK="/home/alon/secure-pi-bot/.maintenance_disabled"
QUEUE="/home/alon/scripts/logs/ntfy_queue.txt"

[ -f "$LOCK" ] && { echo "[$(TS)] Audit: maintenance_disabled lock set — abort."; exit 0; }

NICE="nice -n 19 ionice -c 3"
FOUND=0

echo "[$(TS)] --- AUDIT START ---"

# 1. ClamAV — report infections only, drop LibClamAV warnings
CLAM=$( { $NICE clamscan -r --infected --quiet /home /var/www /tmp; } 2>&1 | grep -iv 'LibClamAV Warning' )
if [ -n "$CLAM" ]; then
  echo "[$(TS)] [!] CRITICAL: VIRUS FOUND"
  echo "$CLAM"
  echo "CRITICAL: Virus detected (ClamAV)" >> "$QUEUE"
  FOUND=1
fi

# 2. Rkhunter — refresh file property DB, then check for warnings
rkhunter --propupd >/dev/null 2>&1
RK=$(rkhunter --check --sk --no-colors 2>/dev/null | grep -i warning | grep -iv 'No warnings')
if [ -n "$RK" ]; then
  echo "[$(TS)] [!] CRITICAL: ROOTKIT WARNING"
  echo "$RK"
  echo "CRITICAL: Rootkit warning (Rkhunter)" >> "$QUEUE"
  FOUND=1
fi

# 3. Lynis — DISABLED for now (re-enable by uncommenting the block below)
#LY=$(lynis audit system --quick 2>/dev/null | grep -i warning | grep -iv 'pgrep')
#if [ -n "$LY" ]; then
#  echo "[$(TS)] [!] CRITICAL: SYSTEM VULNERABILITY"
#  echo "$LY"
#  echo "CRITICAL: Vulnerabilities (Lynis)" >> "$QUEUE"
#  FOUND=1
#fi

[ "$FOUND" -eq 0 ] && echo "[$(TS)] Audit: clean (ClamAV + Rkhunter; Lynis disabled)"
`,
  },
  crontabEntry,
  {
    id: "lynis-snapshot",
    filename: "lynis_snapshot.py",
    path: "~/secure-pi-bot/scripts/lynis_snapshot.py",
    description: "Weekly Lynis audit saved to Google Drive as versioned plain-text files (keeps last 4; older deleted). Compares against the newest Drive version (Drive is the source of truth — reboots safe). On a detected change, auto-runs ai_debug --auto --web (Gemini google_search grounding) to explain what changed for better/worse and POSTS that analysis to Discord; the full text (Lynis + analysis) is uploaded to Drive and shared with your email. If the service-account key is missing, falls back to local SD-card text files with the same keep-4 rotation. Rate-limited via api_manager.",
    tags: ["lynis", "audit", "gdrive", "versioning", "ai", "web-search"],
    code: `import os
import sys
import json
import glob
import subprocess
import hashlib
import re
from datetime import datetime

try:
    from google.oauth2 import service_account
    from google.auth.transport import requests as gauth_requests
except ImportError:
    service_account = None

import requests as httpreq
import api_manager

KEY_FILE = "/home/alon/.secrets/gcp_service_account.json"
SHARE_EMAIL_FILE = "/home/alon/.secrets/gdrive_share_email.txt"
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = "/home/alon/secure-pi-bot/logs"
PREFIX = "lynis_snapshot_"
MAX_VERSIONS = 4
REPORT_CHANNEL_ID = 1524756593651224706

os.makedirs(LOG_DIR, exist_ok=True)
DRIVE_READY = service_account is not None and os.path.exists(KEY_FILE)
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
CREDS = service_account.Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES) if DRIVE_READY else None

def drive(method, url, **kw):
    api_manager.rate_limit("gdrive")
    if not CREDS.valid or CREDS.expired:
        CREDS.refresh(gauth_requests.Request())
    headers = {"Authorization": f"Bearer {CREDS.token}"}
    headers.update(kw.pop("headers", {}))
    r = httpreq.request(method, url, headers=headers, timeout=30, **kw)
    api_manager.record("gdrive", r.status_code < 400)
    return r

def normalize_lynis(text):
    # Strip "long execution: N.N seconds" timing warnings — they vary every
    # run even when nothing on the system changed, so a no-change rerun
    # must NOT be saved as a new Drive version. Score, warnings, suggestions,
    # and all findings are kept.
    out = []
    for line in text.splitlines():
        if "had a long execution:" in line and "seconds" in line:
            continue
        out.append(line)
    return "\\n".join(out)

try:
    r = subprocess.run(["lynis", "audit", "system", "--no-colors"],
                       capture_output=True, text=True, timeout=300)
    output = (r.stdout or r.stderr or "").strip()
except FileNotFoundError:
    print("FAILURE: lynis not installed"); sys.exit(1)
except subprocess.TimeoutExpired:
    print("FAILURE: lynis timed out"); sys.exit(1)

digest = hashlib.sha256(normalize_lynis(output).encode()).hexdigest()
ts = datetime.now().strftime("%Y-%m-%d %H:%M")
fname = f"{PREFIX}{datetime.now().strftime('%Y%m%d_%H%M')}.txt"

def run_ai_diff(prev, cur):
    """AI explains the diff — may use Google Search (--web) for unknown warning codes."""
    prompt = ("Weekly Lynis security audit output changed. Compare and explain what changed — "
              "new warnings, removed warnings, hardening-index delta — and what each likely means "
              "for the Pi (for better or worse). Use web search to look up any unfamiliar warning "
              "codes. Cite specific lines.\\n\\n=== PREVIOUS ===\\n" + prev[:8000]
              + "\\n\\n=== CURRENT ===\\n" + cur[:8000])
    try:
        p = subprocess.run(["python3", "-u", os.path.join(SCRIPTS_DIR, "ai_debug.py"),
                            "--auto", "--web", prompt],
                           capture_output=True, text=True, timeout=180)
        return (p.stdout or "").strip() or "(no AI output)"
    except Exception as e:
        return f"(AI diff failed: {e})"

def post_discord(text):
    from dotenv import load_dotenv
    load_dotenv("/home/alon/secure-pi-bot/.env")
    tok = os.getenv("DISCORD_BOT_TOKEN")
    if not tok:
        return
    for chunk in [text[i:i+1900] for i in range(0, len(text), 1900)]:
        try:
            httpreq.post(f"https://discord.com/api/v10/channels/{REPORT_CHANNEL_ID}/messages",
                         headers={"Authorization": f"Bot {tok}"}, json={"content": chunk}, timeout=10)
        except Exception:
            pass

# --- SD-card fallback (until service-account key is configured) ---
def _extract_output(body):
    marker = "\\n=== AI CHANGE ANALYSIS ==="
    pre = body.split(marker)[0]
    nl = pre.find("\\n")
    raw = pre[nl + 1:] if nl != -1 else pre
    return raw.rstrip("\\n")

if not DRIVE_READY:
    files = sorted(glob.glob(f"{LOG_DIR}/{PREFIX}*.txt"))
    prev_body = open(files[-1]).read() if files else None
    prev_raw = _extract_output(prev_body) if prev_body else None
    if prev_raw and hashlib.sha256(normalize_lynis(prev_raw).encode()).hexdigest() == digest:
        print("Lynis unchanged (SD fallback — no new version).")
        sys.exit(0)
    analysis = "(baseline run — first snapshot)" if not prev_raw else run_ai_diff(prev_raw, output)
    body = f"=== LYNIS SNAPSHOT {ts} ===\\n{output}\\n\\n=== AI CHANGE ANALYSIS ===\\n{analysis}\\n"
    with open(os.path.join(LOG_DIR, fname), "w") as f:
        f.write(body)
    for old in files[:-3]:
        try:
            os.remove(old)
        except OSError:
            pass
    if prev_raw:
        post_discord(f"**Lynis change analysis (SD fallback)** [{ts}]\\n{analysis}")
    print(f"Lynis {'changed' if prev_raw else 'baseline'} -> {fname} (SD fallback, kept last 4 locally).")
    sys.exit(0)

# --- Drive path (keys configured) ---
def list_snapshots():
    r = drive("GET", "https://www.googleapis.com/drive/v3/files",
              params={"q": f"name contains '{PREFIX}' and trashed=false", "orderBy": "createdTime desc",
                      "fields": "files(id,name,createdTime)", "pageSize": 20})
    return r.json().get("files", []) if r.status_code == 200 else []

def download_text(fid):
    r = drive("GET", f"https://www.googleapis.com/drive/v3/files/{fid}", params={"alt": "media"})
    return r.text if r.status_code == 200 else ""

snaps = list_snapshots()
if snaps:
    prev = download_text(snaps[0]["id"])
    prev_raw = _extract_output(prev)
    if hashlib.sha256(normalize_lynis(prev_raw).encode()).hexdigest() == digest:
        print(f"Lynis unchanged — no new version. ({len(snaps)} snapshots on Drive.)")
        sys.exit(0)
    analysis = run_ai_diff(prev_raw, output)
else:
    analysis = "(baseline run — first snapshot on Drive, nothing to diff against)"

body = f"=== LYNIS SNAPSHOT {ts} ===\\n{output}\\n\\n=== AI CHANGE ANALYSIS ===\\n{analysis}\\n"
meta = {"name": fname, "mimeType": "text/plain"}
multipart = {"metadata": (fname + ".meta", json.dumps(meta), "application/json; charset=UTF-8"),
             "file": (fname, body, "text/plain")}
r = drive("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", files=multipart)
if r.status_code not in (200, 201):
    api_manager.queue_outage("gdrive", "upload", {"fname": fname, "body": body})
    print(f"FAILURE: Drive upload {r.status_code} ({r.text[:200]}) — queued to outage buffer.")
    sys.exit(1)
file_id = r.json()["id"]

if os.path.exists(SHARE_EMAIL_FILE):
    email = open(SHARE_EMAIL_FILE).read().strip()
    if email:
        drive("POST", f"https://www.googleapis.com/drive/v3/files/{file_id}/permissions",
              json={"type": "user", "emailAddress": email, "role": "reader"})

newest_three = snaps[:3]
to_delete = snaps[3:]
for old in to_delete:
    drive("DELETE", f"https://www.googleapis.com/drive/v3/files/{old['id']}")

if snaps:
    post_discord(f"**Lynis change analysis** [{ts}]\\n{analysis}")
print(f"Lynis {('changed' if snaps else 'baseline')} -> uploaded {fname} to Drive; "
      f"kept {1 + len(newest_three)} of {MAX_VERSIONS}, removed {len(to_delete)}.")
`,
  },
  apiManagerEntry,
  {
    id: "outage-drain",
    filename: "outage_drain.py",
    path: "~/secure-pi-bot/scripts/outage_drain.py",
    description: "Every 5 min cron. Replays the SD-card outage buffers: re-appends queued Sheets rows and re-uploads queued Drive files, sharing each new Drive file with your email. Successful items are removed from the buffer; failures stay queued for the next run. Only runs when providers are reachable.",
    tags: ["outage", "gsheets", "gdrive", "cron"],
    code: `import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import api_manager

try:
    import gspread
    from google.oauth2 import service_account
    from google.auth.transport import requests as gauth_requests
    import requests as httpreq
except ImportError as e:
    print(f"FAILURE: {e} (pip3 install --user gspread google-auth)")
    sys.exit(1)

KEY = "/home/alon/.secrets/gcp_service_account.json"
SHEET_ID_FILE = "/home/alon/.secrets/gsheets_log_id.txt"
SHARE_EMAIL_FILE = "/home/alon/.secrets/gdrive_share_email.txt"

def _drive_token():
    creds = service_account.Credentials.from_service_account_file(
        KEY, scopes=["https://www.googleapis.com/auth/drive.file"])
    if not creds.valid or creds.expired:
        creds.refresh(gauth_requests.Request())
    return creds.token

def _share(file_id):
    if not os.path.exists(SHARE_EMAIL_FILE):
        return
    email = open(SHARE_EMAIL_FILE).read().strip()
    if not email:
        return
    api_manager.rate_limit("gdrive")
    try:
        httpreq.request("POST",
            f"https://www.googleapis.com/drive/v3/files/{file_id}/permissions",
            headers={"Authorization": f"Bearer {_drive_token()}"},
            json={"type": "user", "emailAddress": email, "role": "reader"},
            timeout=30)
    except Exception:
        pass

# --- Sheets: re-append queued rows ---
def handle_sheets(item):
    p = item["payload"]
    try:
        api_manager.rate_limit("gsheets")
        gc = gspread.service_account(filename=KEY)
        sh = gc.open_by_key(open(SHEET_ID_FILE).read().strip())
        try:
            ws = sh.worksheet(p["ws"])
        except gspread.WorksheetNotFound:
            ws = sh.add_worksheet(p["ws"], rows=1, cols=len(p["rows"][0]) + 2)
        ws.append_rows(p["rows"], value_input_option="RAW")
        return True
    except Exception:
        return False

# --- Drive: re-upload queued files ---
def handle_drive(item):
    p = item["payload"]
    try:
        meta = {"name": p["fname"], "mimeType": "text/plain"}
        api_manager.rate_limit("gdrive")
        r = httpreq.request("POST",
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
            headers={"Authorization": f"Bearer {_drive_token()}"},
            files={"metadata": ("meta", json.dumps(meta), "application/json; charset=UTF-8"),
                   "file": ("file", p["body"], "text/plain")},
            timeout=30)
        if r.status_code in (200, 201):
            _share(r.json()["id"])
            return True
        return False
    except Exception:
        return False

d1 = api_manager.drain_outage("gsheets", handle_sheets)
d2 = api_manager.drain_outage("gdrive", handle_drive)
print(f"Drained from outage buffer: {d1} sheets + {d2} drive items.")
`,
  },
  {
    id: "log-sync",
    filename: "log_sync.py",
    path: "~/secure-pi-bot/scripts/log_sync.py",
    description: "Syncs RAM logs (system_log + fan_events) to Google Sheets via a GCP service account. Delta-sync by timestamp so RAM rotation is safe. Called every 30 min (cron) and at reboot (compress_logs.py). When the service-account keys are missing, it falls back to SD-card JSONL so logging keeps working until the keys are set up.",
    tags: ["logging", "gsheets", "sync", "ram"],
    code: `import os
import sys
import json

try:
    import gspread
except ImportError:
    gspread = None

SHM_DIR = "/dev/shm/pi-bot"
import api_manager
SYS_LOG = f"{SHM_DIR}/system_log.jsonl"
FAN_LOG = f"{SHM_DIR}/fan_events.jsonl"
STATE_FILE = f"{SHM_DIR}/.log_sync_state.json"
KEY_FILE = "/home/alon/.secrets/gcp_service_account.json"
SHEET_ID_FILE = "/home/alon/.secrets/gsheets_log_id.txt"
LOG_DIR = "/home/alon/secure-pi-bot/logs"
DISK_SYS = f"{LOG_DIR}/system_log.jsonl"
DISK_FAN = f"{LOG_DIR}/fan_events.jsonl"

os.makedirs(LOG_DIR, exist_ok=True)
CLOUD_READY = gspread is not None and os.path.exists(KEY_FILE) and os.path.exists(SHEET_ID_FILE)
sh = SHEET_ID = None
if CLOUD_READY:
    try:
        SHEET_ID = open(SHEET_ID_FILE).read().strip()
        gc = gspread.service_account(filename=KEY_FILE)
        sh = gc.open_by_key(SHEET_ID)
    except Exception:
        # Auth/network/sheet-not-shared failure: fall back to SD-card JSONL
        # so this run still flushes RAM logs instead of crashing with no write.
        CLOUD_READY = False
        SHEET_ID = None

def ensure_sheet(title, headers):
    try:
        return sh.worksheet(title)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title, rows=1, cols=len(headers))
        ws.append_row(headers)
        return ws

def load_state():
    default = {"last_sys_ts": "", "last_fan_ts": ""}
    try:
        with open(STATE_FILE) as f:
            return {**default, **json.load(f)}
    except (OSError, json.JSONDecodeError):
        return default

def save_state(st):
    with open(STATE_FILE, "w") as f:
        json.dump(st, f)

def read_lines(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [l.strip() for l in f if l.strip()]

# --- System log (delta by timestamp — rotation-safe) ---
st = load_state()
sys_ws = ensure_sheet("System Log", ["ts", "temp_c", "ram_pct", "ram_warning", "disk_spike", "spike", "failed"]) if CLOUD_READY else None
last_sys = st["last_sys_ts"]
sys_rows = []
new_max = last_sys
for line in read_lines(SYS_LOG):
    try:
        e = json.loads(line)
    except json.JSONDecodeError:
        continue
    ts = e.get("ts") or e.get("ts_start") or ""
    if ts and (not last_sys or ts > last_sys):
        sys_rows.append([
            ts,
            e.get("temp_c") if e.get("temp_c") is not None else e.get("temp_avg_c", ""),
            e.get("ram_pct") if e.get("ram_pct") is not None else e.get("ram_avg_pct", ""),
            "Y" if e.get("ram_warning") else "",
            "Y" if e.get("disk_spike") else "",
            "Y" if (e.get("spike") or e.get("spike_flag")) else "",
            ",".join(e.get("failed", [])),
        ])
        if ts > new_max:
            new_max = ts
if sys_rows:
    if CLOUD_READY:
        api_manager.rate_limit("gsheets")
        try:
            with api_manager.critical_op():
                sys_ws.append_rows(sys_rows, value_input_option="RAW")
            api_manager.record("gsheets", True)
        except Exception:
            api_manager.record("gsheets", False)
            api_manager.queue_outage("gsheets", "rows", {"ws": "System Log", "rows": sys_rows})
    else:
        with open(DISK_SYS, "a") as f:
            for r in sys_rows:
                f.write(json.dumps(r) + "\\n")
st["last_sys_ts"] = new_max

# --- Fan events (delta by timestamp) ---
fan_ws = ensure_sheet("Fan Events", ["ts", "event", "note"]) if CLOUD_READY else None
last_fan = st["last_fan_ts"]
fan_rows = []
new_max_f = last_fan
for line in read_lines(FAN_LOG):
    try:
        e = json.loads(line)
    except json.JSONDecodeError:
        continue
    ts = e.get("ts", "")
    if ts and (not last_fan or ts > last_fan):
        fan_rows.append([ts, e.get("event", ""), e.get("note", "")])
        if ts > new_max_f:
            new_max_f = ts
if fan_rows:
    if CLOUD_READY:
        api_manager.rate_limit("gsheets")
        try:
            with api_manager.critical_op():
                fan_ws.append_rows(fan_rows, value_input_option="RAW")
            api_manager.record("gsheets", True)
        except Exception:
            api_manager.record("gsheets", False)
            api_manager.queue_outage("gsheets", "rows", {"ws": "Fan Events", "rows": fan_rows})
    else:
        with open(DISK_FAN, "a") as f:
            for r in fan_rows:
                f.write(json.dumps(r) + "\\n")
st["last_fan_ts"] = new_max_f

save_state(st)
dest = f"sheet {SHEET_ID}" if CLOUD_READY else "SD (keys not yet configured)"
print(f"Synced {len(sys_rows)} system + {len(fan_rows)} fan rows to {dest}")
`,
  },
  setupEntry,
];

export default scripts;