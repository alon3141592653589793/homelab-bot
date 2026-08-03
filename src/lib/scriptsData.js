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
                    "python3", "-u", script_path, "--auto", auto_prompt,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
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

    elif raw.lower().startswith("/aidebug "):
        rest = raw[9:].strip()
        if rest:
            await run_script(message, "ai_debug.py", "Thinking...", args=rest.split(" ", 1) if rest.startswith("gemini-") else [rest])
        else:
            await message.channel.send("Usage: /aidebug <question>\\nOptional: /aidebug gemini-3.5-flash <question>")

    elif content == "/help":
        await message.channel.send(
            "Available commands:\\n"
            "/status               - System metrics\\n"
            "/cooldown             - Stop non-essential services\\n"
            "/restart              - Reboot Pi (requires confirmation)\\n"
            "/shutdown             - Power off Pi (requires confirmation)\\n"
            "/fanreport            - Show fan activation log\\n"
            "/weeklyreport         - Post weekly summary now\\n"
            "/weeklyreport stop    - Disable scheduled weekly reports\\n"
            "/weeklyreport start   - Re-enable scheduled weekly reports\\n"
            "/logging start|stop   - Toggle system logger\\n"
            "/profile              - Show CPU performance profile\\n"
            "/setprofile restricted|unlimited  - Switch CPU profile\\n"
            "/fastfetch            - Run fastfetch\\n"
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


async def run_script(message, script_name, status_msg, args=None):
    script_path = os.path.join(SCRIPTS_DIR, script_name)
    if status_msg:
        await message.channel.send(status_msg)
    try:
        cmd = ["python3", "-u", script_path] + (args or [])
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        output = (result.stdout or result.stderr or "No output.").strip()
        if len(output) > 1900:
            output = output[:1897] + "..."
        await message.channel.send(output)
    except subprocess.TimeoutExpired:
        await message.channel.send("Script timed out after 45 seconds.")
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
    description: "Called before reboot. Compresses RAM system log to disk (averages stable blocks, keeps spikes). Flushes fan log. Streaming, low RAM use.",
    tags: ["logging", "compression", "maintenance"],
    code: `import os
import json

RAM_SYSTEM_LOG = "/dev/shm/pi-bot/system_log.jsonl"
RAM_FAN_LOG = "/dev/shm/pi-bot/fan_events.jsonl"
DISK_SYSTEM_LOG = "/home/alon/secure-pi-bot/logs/system_log.jsonl"
DISK_FAN_LOG = "/home/alon/secure-pi-bot/logs/fan_events.jsonl"

os.makedirs("/home/alon/secure-pi-bot/logs", exist_ok=True)

def flush_fan_log():
    if not os.path.exists(RAM_FAN_LOG):
        return 0
    # Load existing timestamps from disk to avoid duplicates
    existing_ts = set()
    if os.path.exists(DISK_FAN_LOG):
        with open(DISK_FAN_LOG) as f:
            for line in f:
                try:
                    existing_ts.add(json.loads(line)["ts"])
                except Exception:
                    pass
    count = 0
    with open(DISK_FAN_LOG, "a") as out:
        with open(RAM_FAN_LOG) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    if e["ts"] not in existing_ts:
                        out.write(line + "\\n")
                        count += 1
                except Exception:
                    pass
    return count

def compress_system_log():
    if not os.path.exists(RAM_SYSTEM_LOG):
        return 0, 0

    def flush_group(g):
        if not g:
            return None
        temps = [e["temp_c"] for e in g if e.get("temp_c") is not None]
        rams = [e["ram_pct"] for e in g if e.get("ram_pct") is not None]
        failed = list({f for e in g for f in e.get("failed", [])})
        block = {
            "ts_start": g[0]["ts"],
            "ts_end": g[-1]["ts"],
            "temp_avg_c": round(sum(temps) / len(temps), 1) if temps else None,
            "ram_avg_pct": round(sum(rams) / len(rams), 1) if rams else None,
            "samples": len(g),
        }
        if failed:
            block["failed"] = failed
        return block

    # Stream through RAM log, compress on the fly
    in_count = 0
    out_blocks = []
    group = []
    prev_temp = None

    with open(RAM_SYSTEM_LOG) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            in_count += 1

            is_spike = e.get("spike", False)
            has_failed = bool(e.get("failed"))
            temp_changed = abs((e.get("temp_c") or 0) - (prev_temp or 0)) >= 3.0 if prev_temp else False

            if is_spike:
                b = flush_group(group)
                if b:
                    out_blocks.append(b)
                group = []
                spike = dict(e)
                spike["spike_flag"] = True
                out_blocks.append(spike)
            elif has_failed or temp_changed:
                b = flush_group(group)
                if b:
                    out_blocks.append(b)
                group = [e]
            else:
                group.append(e)

            prev_temp = e.get("temp_c")

    b = flush_group(group)
    if b:
        out_blocks.append(b)

    with open(DISK_SYSTEM_LOG, "a") as out:
        for block in out_blocks:
            out.write(json.dumps(block) + "\\n")

    return in_count, len(out_blocks)

fan_count = flush_fan_log()
in_c, out_c = compress_system_log()
print(f"Logs flushed: {fan_count} fan events | system log {in_c} -> {out_c} blocks")
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
REPORTS_DIR = f"{BOT_DIR}/logs/weekly_reports"
REPORT_CHANNEL_ID = 1524756593651224706

os.makedirs(REPORTS_DIR, exist_ok=True)

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

# Save (keep 3)
ts = datetime.now().strftime("%Y%m%d_%H%M")
with open(f"{REPORTS_DIR}/report_{ts}.txt", "w") as f:
    f.write(report)
saved = sorted(f"{REPORTS_DIR}/{fn}" for fn in os.listdir(REPORTS_DIR) if fn.endswith(".txt"))
for old in saved[:-3]:
    os.remove(old)

post(report)
print("Weekly report sent.")
`,
  },
  {
    id: "ai-debug",
    filename: "ai_debug.py",
    path: "~/secure-pi-bot/scripts/ai_debug.py",
    description: "Conversational AI diagnostic. Remembers context within session. After 20min silence, summarizes conversation to log. Reads Pi state via hardcoded read-only commands.",
    tags: ["ai", "debug", "gemini", "diagnostic", "conversation"],
    code: `import os
import sys
import time
import json
import subprocess
import requests
from datetime import datetime

BOT_DIR = "/home/alon/secure-pi-bot"
RATE_LIMIT_FILE = "/dev/shm/pi-bot/.ai_rate"
RATE_LIMIT_SECS = 10
CONV_FILE = "/dev/shm/pi-bot/.ai_conversation.json"
SUMMARY_LOG = f"{BOT_DIR}/logs/ai_summary_log.jsonl"
SILENCE_THRESHOLD = 20 * 60

MODEL_PRIORITY = [
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro",
    "gemini-3-flash",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
]

from dotenv import load_dotenv
load_dotenv(f"{BOT_DIR}/.env")

try:
    with open("/home/alon/.secrets/gemini_key") as f:
        GEMINI_KEY = f.read().strip()
except OSError:
    print("FAILURE: /home/alon/.secrets/gemini_key not found.")
    sys.exit(1)

os.makedirs("/dev/shm/pi-bot", exist_ok=True)

# Parse args — --auto skips rate limit (used by automated service alerts)
args = sys.argv[1:]
is_auto = "--auto" in args
args = [a for a in args if a != "--auto"]
custom_model = None
if args and "gemini" in args[0].lower():
    custom_model = args[0]
    args = args[1:]
prompt = " ".join(args).strip() or "Automatic service failure diagnosis"
models_to_try = [custom_model] if custom_model else MODEL_PRIORITY

# Minimal rate limit — prevents accidental double-fire only (skip for --auto)
now = time.time()
if not is_auto:
    try:
        with open(RATE_LIMIT_FILE) as f:
            last = float(f.read().strip() or "0")
        if now - last < RATE_LIMIT_SECS:
            print(f"Wait {int(RATE_LIMIT_SECS - (now - last))}s between commands.")
            sys.exit(0)
    except OSError:
        pass
    with open(RATE_LIMIT_FILE, "w") as f:
        f.write(str(now))

def call_gemini(prompt_text, models, max_tokens=350):
    payload = {
        "contents": [{"parts": [{"text": prompt_text}]}],
        "generationConfig": {"maxOutputTokens": max_tokens, "temperature": 0.2}
    }
    for model in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_KEY}"
        try:
            resp = requests.post(url, json=payload, timeout=20)
            if resp.status_code in (429, 503):
                continue
            resp.raise_for_status()
            text = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
            return text, model
        except Exception:
            continue
    return None, None

# === Conversation management ===
def load_conversation():
    try:
        with open(CONV_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"messages": [], "last_activity": 0}

def save_conversation(conv):
    with open(CONV_FILE, "w") as f:
        json.dump(conv, f)

conversation = load_conversation()

# If 20+ min of silence, summarize and clear previous conversation
if conversation["messages"] and (now - conversation.get("last_activity", 0)) > SILENCE_THRESHOLD:
    conv_text = ""
    for msg in conversation["messages"]:
        role = "User" if msg["role"] == "user" else "AI"
        conv_text += f"{role}: {msg['text'][:300]}\\n"
    summary_prompt = (
        "Summarize this Raspberry Pi diagnostic conversation. "
        "Include key findings, issues found, and recommendations. Max 600 chars.\\n\\n"
        f"{conv_text}"
    )
    summary, _ = call_gemini(summary_prompt, MODEL_PRIORITY, max_tokens=200)
    if summary:
        os.makedirs(f"{BOT_DIR}/logs", exist_ok=True)
        entry = {"ts": datetime.now().isoformat(timespec="seconds"), "summary": summary, "messages": len(conversation["messages"])}
        with open(SUMMARY_LOG, "a") as f:
            f.write(json.dumps(entry) + "\\n")
        print(f"📝 **Conversation Summary** [{datetime.now().strftime('%H:%M')}]\\n{summary}\\n\\n--- New conversation ---\\n\\n")
    conversation = {"messages": [], "last_activity": 0}

# === READ-ONLY WHITELIST — no sudo, no writes, no shell=True ===
# The AI NEVER decides what commands run. This list is hardcoded in Python.
# subprocess.run() with a list (not a string) makes shell injection impossible.
# The AI only receives the TEXT OUTPUT of these commands — it cannot execute anything.
# All commands are read-only: query, list, cat, measure, show. None modify the system.
SAFE_COMMANDS = [
    # --- Service health ---
    ["systemctl", "is-system-running"],
    ["systemctl", "list-units", "--state=failed", "--no-legend"],
    ["systemctl", "list-units", "--type=service", "--state=running", "--no-legend"],
    ["systemctl", "list-timers", "--all", "--no-legend"],
    # --- Logs & kernel messages ---
    ["journalctl", "-p", "err", "-n", "20", "--no-pager"],
    ["dmesg", "-T", "--level=err,warn", "-n", "15"],
    # --- CPU & hardware ---
    ["vcgencmd", "measure_temp"],
    ["vcgencmd", "get_throttled"],
    ["vcgencmd", "measure_clock", "arm"],
    ["vcgencmd", "measure_clock", "core"],
    ["cat", "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"],
    ["cat", "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"],
    ["cat", "/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq"],
    # --- Memory & disk ---
    ["free", "-h"],
    ["df", "-h", "--output=source,size,used,avail,pcent,target"],
    ["cat", "/proc/loadavg"],
    # --- Processes ---
    ["ps", "-eo", "pid,comm,%cpu,%mem", "--sort=-%cpu", "--no-header"],
    # --- Network ---
    ["ip", "addr", "show"],
    ["ip", "route", "show"],
    ["ss", "-tln"],
    # --- System info ---
    ["uname", "-a"],
    ["uptime"],
    # --- Cron & schedules ---
    ["crontab", "-l"],
    # --- Bot-specific state ---
    ["ls", "-la", "/dev/shm/pi-bot/"],
    ["wc", "-l", "/dev/shm/pi-bot/system_log.jsonl", "/dev/shm/pi-bot/fan_events.jsonl"],
    ["du", "-sh", "/home/alon/secure-pi-bot/logs/"],
]

collected = {}
for cmd in SAFE_COMMANDS:
    label = " ".join(cmd)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=6)
        collected[label] = (r.stdout or r.stderr or "(empty)").strip()[:500]
    except Exception as e:
        collected[label] = f"(err: {e})"

system_context = "\\n\\n".join(f"$ {k}\\n{v}" for k, v in collected.items())

# Build prompt with conversation context
conv_context = ""
if conversation["messages"]:
    conv_context = "Previous conversation:\\n"
    for msg in conversation["messages"][-6:]:
        role = "User" if msg["role"] == "user" else "Assistant"
        conv_context += f"{role}: {msg['text'][:300]}\\n"
    conv_context += "\\n"

gemini_prompt = (
    f"Raspberry Pi diagnostic assistant in a conversation. "
    f'User asks: "{prompt}"\\n\\n'
    f"{conv_context}"
    f"Current system state (read-only):\\n{system_context}\\n\\n"
    "Give a concise, conversational diagnosis. You MUST reference specific command outputs you reviewed "
    "and cite exact values you found (temps, percentages, error messages, etc). "
    "Do NOT just say 'I ran a check' — list what each command showed. "
    "Flag anything abnormal with the exact values. "
    "If this is a follow-up, reference previous context naturally."
)

ai_text, used_model = call_gemini(gemini_prompt, models_to_try, max_tokens=800)

if not ai_text:
    print("FAILURE: All Gemini models failed or unavailable.")
    sys.exit(1)

# Save to conversation
conversation["messages"].append({"role": "user", "text": prompt, "ts": datetime.now().isoformat()})
conversation["messages"].append({"role": "assistant", "text": ai_text})
conversation["last_activity"] = time.time()
save_conversation(conversation)

# Build compact command output for the user
cmd_lines = []
for cmd_label, cmd_output in collected.items():
    short = cmd_output[:150].replace("\\n", " | ")
    cmd_lines.append(f"  {cmd_label}: {short}")
cmd_summary = "\\n".join(cmd_lines)

print(f"**AI Debug** [{datetime.now().strftime('%H:%M')}] model: {used_model}\\n{ai_text}\\n\\n**Commands reviewed:**\\n{cmd_summary}")
`,
  },
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

# Use systemctl poweroff — goes through polkit (no sudo, no password prompt)
result = subprocess.run(["systemctl", "poweroff"], capture_output=True, text=True, timeout=10)
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
    description: "Nightly maintenance: compress logs, OS upgrade, audit, service check, reboot. No unnecessary sudo (runs as root via cron).",
    tags: ["maintenance", "bash", "cron"],
    code: `#!/bin/bash
# Master Maintenance Script

LOG_FILE="/var/log/pi-maintenance.log"
QUEUE="/home/alon/scripts/logs/ntfy_queue.txt"
mkdir -p /home/alon/scripts/logs

[ -f /home/alon/secure-pi-bot/.maintenance_disabled ] && {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Maintenance disabled." >> "$LOG_FILE"
    exit 0
}

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; }

log "--- MAINTENANCE START ---"
echo "--- DAILY PI REPORT ($(date '+%Y-%m-%d')) ---" > "$QUEUE"

# 0. Flush RAM logs to disk before anything restarts
log "Flushing RAM logs..."
python3 /home/alon/secure-pi-bot/scripts/compress_logs.py >> "$LOG_FILE" 2>&1

# 1. AdGuard
log "AdGuard upgrade..."
/opt/AdGuardHome/AdGuardHome -s upgrade >> "$LOG_FILE" 2>&1

# 2. OS Updates
log "OS update..."
apt-get update -y >> "$LOG_FILE" 2>&1
apt-get full-upgrade -y >> "$LOG_FILE" 2>&1
apt-get autoremove -y >> "$LOG_FILE" 2>&1
echo "OS Updates: SUCCESS" >> "$QUEUE"

mkdir -p /home/alon/.secrets
date '+%Y-%m-%d %H:%M:%S' > /home/alon/.secrets/last_upgrade.txt
chown alon:alon /home/alon/.secrets/last_upgrade.txt

# 3. Security Audit
if [[ "$1" == "--quick" ]]; then
    log "SKIPPING audit (--quick)"
    echo "Audit: SKIPPED" >> "$QUEUE"
else
    log "Security audit..."
    /usr/local/bin/pi-audit.sh >> "$LOG_FILE" 2>&1
    echo "Audit: COMPLETED" >> "$QUEUE"
fi

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

# 6. Reboot
log "Rebooting in 60s."
shutdown -r +1 "Scheduled Maintenance Reboot" >> "$LOG_FILE" 2>&1
`,
  },
  {
    id: "crontab",
    filename: "crontab.txt",
    path: null,
    description: "Full crontab. Apply with: crontab -e",
    tags: ["cron", "reference"],
    code: `# Pi Crontab -- alon
# Apply: crontab -e

# CPU profile auto-switcher (instant exit if no change needed)
* * * * * python3 /home/alon/secure-pi-bot/scripts/profile_scheduler.py

# System logger: temp, RAM, failed services every 10 min
# Only active if .logging_enabled exists (/logging start|stop)
*/10 * * * * python3 /home/alon/secure-pi-bot/scripts/system_logger.py

# Fan event logger every minute (instant exit if /dev/shm/pi-bot missing)
* * * * * python3 /home/alon/secure-pi-bot/scripts/fan_logger.py

# Weekly report every Monday 09:00
0 9 * * 1 python3 /home/alon/secure-pi-bot/scripts/weekly_report.py

# Nightly maintenance + reboot 03:00 (compress_logs runs inside)
0 3 * * * /usr/local/bin/pi-maintenance.sh >> /var/log/pi-maintenance.log 2>&1
`,
  },
  {
    id: "setup",
    filename: "setup-notes.txt",
    path: null,
    description: "Setup guide: API key storage, log2ram config, crontab, permissions.",
    tags: ["setup", "reference"],
    code: `# ============================================================
# API KEY STORAGE (secure, not in .env)
# ============================================================
# The Gemini key is stored at ~/.secrets/gemini_key
# - Owned by alon, readable only by alon (chmod 600)
# - Never in .env, never in a world-readable file
# - Never logged or printed by any script

mkdir -p /home/alon/.secrets
echo 'YOUR_GEMINI_KEY_HERE' > /home/alon/.secrets/gemini_key
chmod 600 /home/alon/.secrets/gemini_key
chmod 700 /home/alon/.secrets
# Get key at: https://aistudio.google.com/app/apikey

# ============================================================
# LOG2RAM CONFIG (if already installed)
# ============================================================
# Our logs go to /dev/shm/pi-bot which is tmpfs by default.
# If you have log2ram, you can optionally map it:
# Edit /etc/log2ram.conf:
#   SIZE=40M
#   PATH_DISK=/var/log:/home/alon/secure-pi-bot/logs
# Then restart: sudo systemctl restart log2ram
# But /dev/shm is already RAM — log2ram not required for our setup.

# ============================================================
# UDEV RULE — allow alon to write cpufreq without sudo
# ============================================================
# This eliminates ALL sudo usage from profile scripts:
echo 'SUBSYSTEM=="cpu", ACTION=="add", RUN+="/bin/chmod -R a+w /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor /sys/devices/system/cpu/cpu*/cpufreq/scaling_max_freq"' | sudo tee /etc/udev/rules.d/99-cpufreq.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
# After this, set_profile_restricted.py and set_profile_unlimited.py need NO sudo at all.

# ============================================================
# POLKIT RULE — allow alon to reboot/poweroff without sudo
# ============================================================
# This lets /restart, /reboot, and /shutdown work from the Discord bot
# without sudo or any password prompt. systemctl reboot/poweroff go
# through polkit (same mechanism desktop environments use).
sudo tee /etc/polkit-1/rules.d/49-pi-bot.rules << 'POLKIT'
polkit.addRule(function(action, subject) {
    if ((action.id == "org.freedesktop.login1.reboot" ||
         action.id == "org.freedesktop.login1.power-off" ||
         action.id == "org.freedesktop.login1.reboot-multiple-sessions" ||
         action.id == "org.freedesktop.login1.power-off-multiple-sessions") &&
        subject.user == "alon") {
        return polkit.Result.YES;
    }
});
POLKIT
sudo systemctl restart polkit

# ============================================================
# DIRECTORIES + LOGGING ENABLE
# ============================================================
mkdir -p /home/alon/secure-pi-bot/logs/weekly_reports
mkdir -p /dev/shm/pi-bot
touch /home/alon/secure-pi-bot/.logging_enabled

# ============================================================
# PYTHON DEPENDENCIES
# ============================================================
pip3 install --user requests psutil python-dotenv

# ============================================================
# CRONTAB
# ============================================================
crontab - << 'EOF'
* * * * * python3 /home/alon/secure-pi-bot/scripts/profile_scheduler.py
*/10 * * * * python3 /home/alon/secure-pi-bot/scripts/system_logger.py
* * * * * python3 /home/alon/secure-pi-bot/scripts/fan_logger.py
0 9 * * 1 python3 /home/alon/secure-pi-bot/scripts/weekly_report.py
0 3 * * * /usr/local/bin/pi-maintenance.sh >> /var/log/pi-maintenance.log 2>&1
EOF

crontab -l

# ============================================================
# WHAT CHANGED FROM PREVIOUS VERSION
# ============================================================
# Security:
#   - Gemini API key moved to ~/.secrets/gemini_key (chmod 600)
#   - No secrets in .env except Discord token
#   - udev rule eliminates cpufreq sudo
#   - Polkit rule replaces sudoers for reboot/shutdown (no sudo at all)
#   - Thermal alert cooldown (5 min) prevents spam flooding
#
# SD card writes:
#   - bot_status.json -> /dev/shm (RAM)
#   - rate limit file -> /dev/shm (RAM)
#   - All logging in /dev/shm, only flushed on reboot
#
# Power:
#   - profile_scheduler exits instantly if no change needed
#   - fan_logger exits instantly if /dev/shm/pi-bot missing
#   - maintenance.sh no longer calls sudo unnecessarily
#
# Performance:
#   - system_logger reads last log line via seek (no full file load)
#   - compress_logs streams line by line (no full file in memory)
#   - status.py reads sysfs directly instead of subprocess where possible
`,
  },
];

export default scripts;