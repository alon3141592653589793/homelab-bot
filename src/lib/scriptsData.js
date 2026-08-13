import aiDebugEntry from "./scripts/aiDebugEntry";
import apiFailReportEntry from "./scripts/apiFailReportEntry";
import testAllEntry from "./scripts/testAllEntry";
import setupEntry from "./scripts/setupEntry";
import crontabEntry from "./scripts/crontabEntry";
import apiManagerEntry from "./scripts/apiManagerEntry";
import profileEntries from "./scripts/profileEntries";
import adguardHandlerEntry from "./scripts/adguardHandlerEntry";
import vpnHandlerEntry from "./scripts/vpnHandlerEntry";
import wireguardSetupEntry from "./scripts/wireguardSetupEntry";
import bootDiagEntry from "./scripts/bootDiagEntry";
import paramsEntry from "./scripts/paramsEntry";
import systemFixesEntry from "./scripts/systemFixesEntry";
import lynisSnapshotEntry from "./scripts/lynisSnapshotEntry";

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
from modules.adguard import handle_adguard_command
from modules.vpn import handle_vpn_command

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
    if os.path.exists("/dev/shm/pi-bot/.testall_running"):
        await message.channel.send("⏳ /testall is running -- commands paused until it finishes.")
        return
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
        await run_script(message, "weekly_report.py", "Generating weekly report...", args=["--force"])

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

    elif content == "/boot":
        await run_script(message, "boot_diag.py", "Checking boot/reboot history...", timeout=30)

    elif content in ("/parameters", "/params", "/paramters"):
        await run_script(message, "params.py", "Listing current parameters...", timeout=15)

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
            "/testall              - Run full test suite (posts to #testing)\\n"
            "/boot                 - Boot/reboot history + skip-cause diagnosis\\n"
            "/parameters           - List current toggle/setting values\\n"
            "Side channels         - #adguard -> /adguard help  |  #vpn -> /vpn help\\n"
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
            except json.JSONDecodeError:
                continue
            if not isinstance(e, dict) or "ts" not in e:
                continue
            if e["ts"] not in seen:
                seen.add(e["ts"])
                events.append(e)

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
    description: "Weekly report (Israel-time keyed, ISO-week idempotent): temp, fan. Posts to Discord + syncs a versioned copy to Google Drive (keep last 4); warns Discord if Drive sync fails >1 day. Day-of-week gate (Monday, Israel time) uses worldtimeapi -> system-clock fallback, not the Pi clock. Manual /weeklyreport uses --force to bypass guards. Can be disabled via /weeklyreport stop.",
    tags: ["report", "discord", "weekly"],
    code: `import os
import sys
import json
import time
import api_manager
from datetime import datetime, timedelta

try:
    import psutil
    import requests
except ImportError as e:
    print(f"FAILURE: {e}")
    sys.exit(1)

BOT_DIR = "/home/alon/secure-pi-bot"
SHM = "/dev/shm/pi-bot"
STATE_FILE = f"{SHM}/.weekly_report_state.json"
DRIVE_STATE = f"{SHM}/.weekly_drive_state.json"
os.makedirs(SHM, exist_ok=True)
TEST_MODE = bool(os.getenv("PI_TEST_MODE"))
FORCE = "--force" in sys.argv  # manual /weeklyreport bypasses day/idempotency guards

# --- Israel local time (true time when online, Pi clock fallback) ---
# The Pi's onboard clock drifts, so day-of-week gating uses Israel time from
# a network time API when reachable, falling back to the system clock -> Asia/Jerusalem.
def israel_now():
    try:
        import urllib.request
        with urllib.request.urlopen("http://worldtimeapi.org/api/timezone/Asia/Jerusalem", timeout=5) as r:
            return datetime.fromisoformat(json.load(r)["datetime"])
    except Exception:
        pass
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Asia/Jerusalem"))
    except Exception:
        from datetime import timezone
        return datetime.now(timezone(timedelta(hours=3)))

def iso_week(dt):
    return dt.strftime("%G-W%V")  # ISO week id, stable across year boundaries

if os.path.exists(f"{BOT_DIR}/.weekly_report_disabled"):
    print("Weekly report disabled. Use /weeklyreport start to re-enable.")
    sys.exit(0)

now = israel_now()
this_week = iso_week(now)
state = {}
if not TEST_MODE and not FORCE:
    try:
        with open(STATE_FILE) as f:
            state = json.load(f)
    except (OSError, ValueError):
        pass
    # Idempotency: skip if already posted this Israel ISO-week
    if state.get("week") == this_week:
        sys.exit(0)
    # Day-of-week guard (Monday in Israel time) -- the Pi clock drifts when
    # unpowered, so we bind the weekly boundary to the Israel weekday, which
    # is fetched from the network with a system-clock fallback.
    if now.isoweekday() != 1:
        sys.exit(0)

from dotenv import load_dotenv
load_dotenv(f"{BOT_DIR}/.env")
BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
if not BOT_TOKEN:
    print("FAILURE: DISCORD_BOT_TOKEN not set")
    sys.exit(1)
try:
    REPORT_CHANNEL_ID = int(os.getenv("REPORT_CHANNEL_ID", "0"))
except ValueError:
    REPORT_CHANNEL_ID = 0

DISCORD_URL = f"https://discord.com/api/v10/channels/{REPORT_CHANNEL_ID}/messages"
DISCORD_HEADERS = {"Authorization": f"Bot {BOT_TOKEN}", "Content-Type": "application/json"}

def post(text):
    import time
    ok = True
    for chunk in [text[i:i+1900] for i in range(0, len(text), 1900)]:
        for attempt in range(4):
            r = requests.post(DISCORD_URL, json={"content": chunk}, headers=DISCORD_HEADERS, timeout=10)
            if r.status_code in (200, 201):
                break
            if r.status_code == 429 and attempt < 3:
                # Respect Discord's Retry-After (cap 15s) so a rate-limit no
                # longer aborts the whole weekly report — up to 3 retries.
                time.sleep(min(float(r.headers.get("Retry-After", 2)) + 1, 15))
                continue
            print(f"FAILURE: Discord {r.status_code}: {r.text}")
            ok = False
            return ok
    return ok

cutoff = now - timedelta(days=7)

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

week = now.strftime("%b %d, %Y")
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
drive_body = f"=== WEEKLY REPORT {now.isoformat(timespec='seconds')} ===\\n{report}\\n"

if TEST_MODE:
    print(f"[TEST MODE] weekly report built ({len(report)} chars) -- Discord+Drive send skipped, state not persisted.")
    print(report)
    sys.exit(0)

# --- Send to Discord (best-effort; failure no longer aborts Drive sync) ---
discord_ok = post(report)

# --- Sync to Google Drive (versioned, keep last 4) ---
KEY = "/home/alon/.secrets/gcp_service_account.json"
SHARE_EMAIL_FILE = "/home/alon/.secrets/gdrive_share_email.txt"
UPLOADS_FOLDER_FILE = "/home/alon/.secrets/gdrive_uploads_folder_id.txt"
DRIVE_READY = False
try:
    from google.oauth2 import service_account
    from google.auth.transport import requests as gauth_requests
    DRIVE_READY = os.path.exists(KEY)
except ImportError:
    DRIVE_READY = False

def sync_to_drive(body):
    if not DRIVE_READY:
        return False, "Drive keys/lib unavailable"
    try:
        # drive.file cannot reach UI-shared folders (404). Use full drive scope
        # so the weekly report uploads into the shared "pi" folder.
        creds = service_account.Credentials.from_service_account_file(
            KEY, scopes=["https://www.googleapis.com/auth/drive"])
        if not creds.valid or creds.expired:
            creds.refresh(gauth_requests.Request())
    except Exception as e:
        return False, str(e)
    header = {"Authorization": f"Bearer {creds.token}"}
    fname = f"weekly_report_{now.strftime('%Y%m%d_%H%M')}.txt"
    meta = {"name": fname, "mimeType": "text/plain"}
    # Service accounts have no storage quota -- upload into the user-owned
    # shared folder (gdrive_uploads_folder_id.txt) so it lands in your Drive.
    try:
        parent = open(UPLOADS_FOLDER_FILE).read().strip()
        if parent:
            meta["parents"] = [parent]
    except OSError:
        pass
    files = {"metadata": (fname + ".meta", json.dumps(meta), "application/json; charset=UTF-8"),
             "file": (fname, body, "text/plain")}
    try:
        api_manager.rate_limit("gdrive")
        r = requests.post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
                          headers=header, files=files, timeout=30)
        api_manager.record("gdrive", r.status_code < 400)
        if r.status_code not in (200, 201):
            return False, f"{r.status_code} {r.text[:120]}"
        fid = r.json()["id"]
        if os.path.exists(SHARE_EMAIL_FILE):
            email = open(SHARE_EMAIL_FILE).read().strip()
            if email:
                api_manager.rate_limit("gdrive")
                requests.post(f"https://www.googleapis.com/drive/v3/files/{fid}/permissions",
                              headers=header,
                              json={"type": "user", "emailAddress": email, "role": "reader"},
                              timeout=30)
        # keep last 4 versions (scoped to the shared folder when set)
        q = "name contains 'weekly_report_' and trashed=false"
        try:
            parent = open(UPLOADS_FOLDER_FILE).read().strip()
            if parent:
                q += f" and '{parent}' in parents"
        except OSError:
            pass
        api_manager.rate_limit("gdrive")
        lst = requests.get("https://www.googleapis.com/drive/v3/files", headers=header, timeout=30,
                           params={"q": q, "orderBy": "createdTime desc", "fields": "files(id,name)",
                                   "pageSize": 20})
        if lst.status_code == 200:
            for old in lst.json().get("files", [])[4:]:
                requests.delete(f"https://www.googleapis.com/drive/v3/files/{old['id']}",
                                headers=header, timeout=20)
        return True, fname
    except Exception as e:
        return False, str(e)

drive_ok, drive_msg = sync_to_drive(drive_body)
if not drive_ok:
    api_manager.queue_outage("gdrive", "weekly_report",
        {"fname": f"weekly_report_{now.strftime('%Y%m%d_%H%M')}.txt", "body": drive_body})

# --- Drive-fail tracking: warn Discord if failing for > 1 day ---
ds = {}
try:
    if os.path.exists(DRIVE_STATE):
        with open(DRIVE_STATE) as f:
            ds = json.load(f)
except (OSError, ValueError):
    pass
if drive_ok:
    ds = {"fail_since": None}
else:
    if not ds.get("fail_since"):
        ds["fail_since"] = now.isoformat()
        ds["err"] = str(drive_msg)[:200]
    age = (now - datetime.fromisoformat(ds["fail_since"])).total_seconds()
    if age > 86400:
        post(f"**Weekly report Drive sync warning** [{now.strftime('%H:%M')}] -- failing for >1 day ({int(age//3600)}h). Last error: {ds.get('err','')}")
try:
    with open(DRIVE_STATE, "w") as f:
        json.dump(ds, f)
except OSError:
    pass

# --- Mark this Israel ISO-week posted (only if at least one channel succeeded) ---
if discord_ok or drive_ok:
    state["week"] = this_week
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
    except OSError:
        pass
else:
    print("Weekly report: both Discord and Drive failed; not marking week posted (will retry next eligible run).")

print("Weekly report sent.")
`,
  },
  aiDebugEntry,
  apiFailReportEntry,
  testAllEntry,
  adguardHandlerEntry,
  vpnHandlerEntry,
  wireguardSetupEntry,
  bootDiagEntry,
  paramsEntry,
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
  ...profileEntries,
  {
    id: "maintenance",
    filename: "pi-maintenance.sh",
    path: "/usr/local/bin/pi-maintenance.sh",
    description: "Daily maintenance — flush logs, AdGuard, audit (Sun), service check. apt update+full-upgrade+autoremove + reboot only on Sun (DOW 7), CPU-throttled to 600 MHz/powersave + nice/ionice + thermal gates between steps. Skipped when .updates_disabled is set via /updates stop, but logs/audit/service-check still run daily.",
    tags: ["maintenance", "bash", "cron", "thermal", "throttled"],
    code: `#!/bin/bash
# Master Maintenance Script — full nightly, CPU-throttled to stay cool

LOG_FILE="/dev/shm/pi-bot/maintenance.log"
DISK_LOG="/home/alon/secure-pi-bot/logs/maintenance.log"
QUEUE="/home/alon/scripts/logs/ntfy_queue.txt"
mkdir -p /home/alon/scripts/logs /home/alon/secure-pi-bot/logs /dev/shm/pi-bot

[ -f /home/alon/secure-pi-bot/.maintenance_disabled ] && {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Maintenance disabled." >> "$LOG_FILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Maintenance disabled." >> "$DISK_LOG"
    exit 0
}

# log() writes both RAM (realtime) AND disk (survives reboot -> lets /boot
# tell whether a past maintenance run skipped or issued the reboot).
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$DISK_LOG"; }

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
    touch /dev/shm/pi-bot/.maintenance_throttle
    python3 /home/alon/secure-pi-bot/scripts/cpu_profile.py throttle
    log "CPU throttled to 600 MHz / powersave (maintenance marker set)"
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
    log "Issuing scheduled maintenance reboot via systemctl reboot (polkit-authorized; works as alon or root)."
    # shutdown -r +1 needs root and could silently no-op if cron runs as the user;
    # systemctl reboot goes through polkit (same path the bot's /restart uses),
    # so the weekly reboot actually happens instead of being skipped on perms.
    systemctl reboot >> "$LOG_FILE" 2>&1
fi

# Release the maintenance throttle marker so the profile scheduler restores
# the normal profile (on Sun, /dev/shm also clears on reboot — belt+braces).
rm -f /dev/shm/pi-bot/.maintenance_throttle
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
  lynisSnapshotEntry,
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

if os.getenv("PI_TEST_MODE"):
    print("[TEST MODE] outage drain skipped -- no replay to Sheets/Drive.")
    sys.exit(0)

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

if bool(os.getenv("PI_TEST_MODE")):
    def _tc(p):
        if not os.path.exists(p):
            return 0
        n = 0
        with open(p) as _f:
            for _ln in _f:
                if _ln.strip():
                    n += 1
        return n
    _dest = f"sheet {SHEET_ID}" if CLOUD_READY else "SD (keys not configured)"
    print(f"[TEST MODE] would sync {_tc(SYS_LOG)} system + {_tc(FAN_LOG)} fan rows to {_dest} -- no writes, state unchanged.")
    sys.exit(0)

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
  systemFixesEntry,
];

export default scripts;