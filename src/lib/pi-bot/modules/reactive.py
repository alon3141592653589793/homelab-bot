import os
import json
import time
import signal
import asyncio
import subprocess
from modules.runner import run_script, confirm_and_run

LOGGING_FLAG = "/home/alon/secure-pi-bot/.logging_enabled"
LED_CTL = ["sudo", "-n", "/usr/local/bin/led_ctl"]
GFILE_ACTIVE = "/dev/shm/pi-bot/.gofile_active"
GFILE_KEEP = os.path.expanduser("~/.secrets/gofile_keep.txt")


def _read_active():
    try:
        with open(GFILE_ACTIVE) as f:
            return json.load(f)
    except Exception:
        return None


def _kill_active(active):
    if not active:
        return
    pid = active.get("pid")
    if not pid:
        return
    try:
        os.kill(int(pid), signal.SIGTERM)
    except (ProcessLookupError, ValueError, PermissionError):
        pass
    except Exception:
        pass


def _gofile_repo_from_ref(rest):
    """Normalize 'ollama run hf.co/OWNER/REPO:TAG' -> 'OWNER/REPO'."""
    toks = [t for t in rest.strip().split() if t]
    while toks and toks[0].lower() in ("ollama", "run", "pull"):
        toks.pop(0)
    if not toks:
        return ""
    ref = " ".join(toks).replace("https://huggingface.co/", "").replace("hf.co/", "")
    first = ref.split()[0] if ref.split() else ref
    return first.split(":")[0].strip()


async def confirm_power_action(client, message, action_name, script_name, description):
    """Confirm a reboot/shutdown. If a /gofile download is in flight, offer to
    cancel it or wait for it to finish instead of rebooting mid-download."""
    active = _read_active()
    if active:
        dl = f"{active.get('ref', '?')} (started {active.get('started', '?')})"
        prompt = (f"[{action_name.upper()} - DOWNLOAD IN PROGRESS]\n{description}\n"
                  f"A mirror download is running: {dl}.\n"
                  f"\u2705 Cancel download & {action_name} now\n"
                  f"\u23f3 Wait for it to finish, then {action_name} (up to 30 min)\n"
                  f"\u274c Abort")
        emojis = ["\u2705", "\u23f3", "\u274c"]
        timeout = 120
    else:
        prompt = (f"[{action_name.upper()} - CONFIRMATION REQUIRED]\n{description}\n"
                  f"React with \u2705 to confirm or \u274c to cancel. Timeout: 30s.")
        emojis = ["\u2705", "\u274c"]
        timeout = 30
    cm = await message.channel.send(prompt)
    for e in emojis:
        await cm.add_reaction(e)

    def check(reaction, user):
        return (user.id == message.author.id and reaction.message.id == cm.id
                and str(reaction.emoji) in emojis)

    try:
        reaction, _ = await client.wait_for("reaction_add", timeout=timeout, check=check)
        choice = str(reaction.emoji)
    except asyncio.TimeoutError:
        await message.channel.send(f"{action_name} timed out. Cancelled.")
        return

    if choice == "\u274c":
        await message.channel.send(f"{action_name} cancelled.")
        return

    if active and choice == "\u23f3":
        await message.channel.send(f"Waiting for the download to finish, then {action_name}...")
        deadline = time.time() + 30 * 60
        while time.time() < deadline:
            await asyncio.sleep(30)
            if _read_active() is None:
                break
        if _read_active() is not None:
            await message.channel.send("Download still running after 30 min. Cancelling it and proceeding.")
            _kill_active(_read_active())
            await asyncio.sleep(3)
    elif active and choice == "\u2705":
        await message.channel.send(f"Cancelling download and {action_name}...")
        _kill_active(_read_active())
        await asyncio.sleep(3)

    await message.channel.send(f"{action_name} confirmed. Executing...")
    await run_script(message, script_name, "")

def _led_ctl(mode):
    return subprocess.run(LED_CTL + [mode], capture_output=True, text=True, timeout=10)

async def handle_reactive_command(client, message):
    content = message.content.strip().lower()
    raw = message.content.strip()

    if content == "/test":
        await run_script(message, "test_reply.py", "Testing deploy pipeline...")

    elif content == "/nmap":
        await run_script(message, "net_scan.py", "Scanning the local WiFi network (this can take a minute)...", timeout=180)

    elif content == "/status":
        await run_script(message, "status.py", "Querying system status...")

    elif content == "/cooldown":
        await run_script(message, "cooldown.py", "Running thermal cooldown...")

    elif content in ("/restart", "/reboot"):
        await confirm_power_action(client, message, "Reboot", "restart.py", "This will restart the Pi immediately.")

    elif content == "/shutdown":
        await confirm_power_action(client, message, "Shutdown", "shutdown.py", "This will power off the Pi. Physical access required to turn it back on.")

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

    elif raw.lower().startswith("/gofile keep "):
        repo = _gofile_repo_from_ref(raw[len("/gofile keep "):])
        if not repo:
            await message.channel.send("Usage: /gofile keep <ref>\nExample: /gofile keep hf.co/OWNER/REPO:Q4_K_M")
        else:
            try:
                os.makedirs(os.path.dirname(GFILE_KEEP), exist_ok=True)
                cur = set()
                try:
                    with open(GFILE_KEEP) as f:
                        cur = {l.strip() for l in f if l.strip()}
                except OSError:
                    pass
                cur.add(repo)
                with open(GFILE_KEEP, "w") as f:
                    f.write("\n".join(sorted(cur)) + "\n")
                await message.channel.send(f"Opted in to keep-alive: {repo}\nThe 6h cron will fake-download it from Gofile so it isn't deleted. /gofile forget {repo} to stop.")
            except OSError as e:
                await message.channel.send(f"Could not write keep list: {e}")

    elif raw.lower().startswith("/gofile forget "):
        repo = _gofile_repo_from_ref(raw[len("/gofile forget "):])
        if not repo:
            await message.channel.send("Usage: /gofile forget <ref>")
        else:
            cur = set()
            try:
                with open(GFILE_KEEP) as f:
                    cur = {l.strip() for l in f if l.strip()}
            except OSError:
                pass
            cur.discard(repo)
            try:
                with open(GFILE_KEEP, "w") as f:
                    f.write("\n".join(sorted(cur)) + ("\n" if cur else ""))
                await message.channel.send(f"Stopped maintaining: {repo}")
            except OSError as e:
                await message.channel.send(f"Could not update keep list: {e}")

    elif content == "/gofile keeplist":
        try:
            with open(GFILE_KEEP) as f:
                kept = [l.strip() for l in f if l.strip()]
            await message.channel.send("Maintained models:\n" + ("\n".join(kept) if kept else "(none)"))
        except OSError:
            await message.channel.send("No models opted in for keep-alive yet.")

    elif raw.lower().startswith("/setlocation "):
        loc = raw[len("/setlocation "):].strip()
        await run_script(message, "pikud_alerts.py", "", args=["--set-location", loc], timeout=15)

    elif content == "/alerts":
        await run_script(message, "pikud_alerts.py", "", args=["--show"], timeout=20)

    elif content in ("/proxy", "/proxy status"):
        await run_script(message, "proxy_pool.py", "", args=["--status"], timeout=15)

    elif content == "/proxy refresh":
        await run_script(message, "proxy_pool.py", "Refreshing proxy pool (testing candidates, ~1-2 min)...", args=["--refresh"], timeout=240)

    elif raw.lower().startswith("/gofile "):
        tokens = raw[len("/gofile "):].strip().split()
        progress = None
        if tokens and tokens[0].isdigit():
            progress = tokens.pop(0)
        if not tokens:
            await message.channel.send("Usage: /gofile [minutes] <model>\nExample: /gofile 10 ollama run hf.co/OBLITERATUS/Qwen3.8-27B-OBLITERATED:Q4_K_M\n(minutes = progress report interval; always reports start/fail/done)")
        else:
            args = []
            if progress is not None:
                args += ["--progress", progress]
            args += ["--channel", str(message.channel.id)]
            args += tokens
            await run_script(message, "gofile_mirror.py", "", args=args, timeout=10800)

    elif raw.lower().startswith("/aidebug "):
        rest = raw[9:].strip()
        if rest:
            # Tokens are passed individually so the script can consume model
            # and on-demand tool prefixes (e.g. "gemini-3.5-flash lynis")
            await run_script(message, "ai_debug.py", "Thinking...", args=rest.split(), timeout=300)
        else:
            await message.channel.send("Usage: /aidebug <question>\nOptional model prefix: /aidebug [gemini-2.5-flash] <question>")

    elif content == "/boot":
        await run_script(message, "boot_diag.py", "Checking boot/reboot history...", timeout=30)

    elif content in ("/parameters", "/params", "/paramters"):
        await run_script(message, "params.py", "Listing current parameters...", timeout=15)

    elif content in ("/sync", "/sync no-reboot", "/sync config", "/sync dry-run"):
        if content == "/sync":
            await run_script(message, "pi_deploy.py", "Pulling latest from the repo, then rebooting...", timeout=300)
        elif content == "/sync dry-run":
            await run_script(message, "pi_deploy.py", "Dry-run: fetching + listing what would change (no write, no reboot)...", args=["--dry-run"], timeout=120)
        else:
            await run_script(message, "pi_deploy.py", "Pulling latest from the repo (no reboot)...", args=["--no-reboot"], timeout=300)

    elif content in ("/syncinfo", "/deployinfo"):
        await run_script(message, "deploy_info.py", "Checking deploy status...", timeout=30)

    elif content == "/bootpause":
        await run_script(message, "boot_pause.py", "Pausing lab autostart for next boot...")

    elif content == "/bootresume":
        await run_script(message, "boot_resume.py", "Resuming lab autostart...")

    elif content == "/leds off":
        r = _led_ctl("off")
        await message.channel.send("LEDs forced OFF until reboot (dark for your sleep). /leds auto to resume." if r.returncode == 0 else "Couldn't apply -- the one-time sudoers rule for /usr/local/bin/led_ctl isn't set. Run the 'LED CONTROL -- root helper + sudoers' block in setup-notes.txt (3 lines), then /leds off again.")

    elif content == "/leds on":
        r = _led_ctl("on")
        await message.channel.send("LEDs forced ON until reboot. /leds auto to resume." if r.returncode == 0 else "LEDs set on but couldn't apply now -- need /usr/local/bin/led_ctl in sudoers (see setup).")

    elif content == "/leds auto":
        r = _led_ctl("auto")
        await message.channel.send("LEDs back to automatic schedule (off 22:00-10:00 for your sleep; on for SSH + 1h grace)." if r.returncode == 0 else "LEDs back to auto but couldn't write override -- need /usr/local/bin/led_ctl in sudoers (see setup).")

    elif content in ("/leds", "/leds status"):
        await run_script(message, "led_status.py", "Reading LED state...", timeout=10)

    elif content == "/diag":
        await run_script(message, "netdiag.py", "Running network diagnostics...", timeout=30)

    elif content == "/diskhealth":
        await run_script(message, "disk_health.py", "Checking SD card health...", timeout=20)

    elif content == "/integrity":
        await run_script(message, "integrity_check.py", "Verifying deployed scripts vs GitHub...", timeout=60)

    elif content == "/logs" or raw.lower().startswith("/logs "):
        await run_script(message, "log_tail.py", "", args=raw.split()[1:], timeout=15)

    elif content == "/help":
        help_text = (
            "Available commands:\n"
            "\n== System & Power ==\n"
            "/test                 - Pipeline check (returns 8)\n"
            "/nmap                 - Scan the whole WiFi network (host discovery)\n"
            "/status               - Temp/CPU/RAM/IP/uptime\n"
            "/fastfetch            - Pretty system summary\n"
            "/restart (/reboot)    - Reboot Pi (requires confirmation)\n"
            "/shutdown             - Power off Pi (requires confirmation)\n"
            "/cooldown             - Stop non-essential services to shed heat\n"
            "\n== Thermal / Fan / LEDs ==\n"
            "/fanreport            - Show fan activation log\n"
            "/leds on|off|auto     - Lights on/off until reboot (off = dark for your sleep) / auto\n"
            "/leds                 - Show LED mode + SSH grace state\n"
            "\n== Diagnostics ==\n"
            "/diag                 - Network + SSH + WiFi diagnostics\n"
            "/boot                 - Boot/reboot history + skip-cause diagnosis\n"
            "/diskhealth           - SD card health (dmesg, read-only, smart)\n"
            "/integrity            - Verify deployed scripts match GitHub (origin/main)\n"
            "/logs <name> [n]      - Tail any log file (/logs to list)\n"
            "\n== Security ==\n"
            "/lynis                - Run Lynis security audit now\n"
            "\n== Reports & API ==\n"
            "/weeklyreport         - Post weekly summary now\n"
            "/weeklyreport start|stop - Enable/disable scheduled weekly reports\n"
            "/apifails             - API call failure rate (last 7 days)\n"
            "\n== Config / Profile / Toggles ==\n"
            "/parameters           - Current toggle/setting values (aliases /params, /paramters)\n"
            "/profile              - Show CPU performance profile\n"
            "/setprofile restricted|unlimited  - Switch CPU profile\n"
            "/logging start|stop   - Toggle system logger\n"
            "/updates start|stop   - Pause or resume automatic apt upgrade + reboot\n"
            "/bootpause            - Skip ALL lab autostart on next boot (cron off, bot minimal)\n"
            "/bootresume           - Restore crontab + clear skip flag (then /restart)\n"
            "\n== Alerts & Location ==\n"
            "/alerts                - Current Home Front Command alerts + your location filter\n"
            "/setlocation <place|off> - Alert area filter, e.g. ramat gan (or Hebrew); off = all Israel\n"
            "\n== Proxy ==\n"
            "/proxy                 - Proxy pool status\n"
            "/proxy refresh         - Re-fetch + test free proxies\n"
            "\n== Gofile keep-alive ==\n"
            "/gofile keep <ref>     - Opt a mirror into auto keep-alive (fake-download every 6h)\n"
            "/gofile forget <ref>   - Stop maintaining a mirror\n"
            "/gofile keeplist       - List maintained mirrors\n"
            "\n== Advanced ==\n"
            "/aidebug <question>   - Conversational AI diagnostic (optional: model prefix)\n"
            "/sync                 - Pull latest from the repo, reboot\n"
            "/sync no-reboot       - Same, but skip the reboot\n"
            "/sync dry-run         - Fetch + list what would change (no write, no reboot)\n"
            "/gofile [min] <model>  - Mirror a HF model to Gofile (streamed, RAM-only). [min] = progress interval. e.g. /gofile 10 ollama run hf.co/OWNER/REPO:Q4_K_M\n"
            "/syncinfo             - When GitHub repo was last updated + when /sync last ran\n"
            "\nSide channels: #adguard -> /adguard help | #vpn -> /vpn help\n"
            "/help                 - This message"
        )
        for i in range(0, len(help_text), 1900):
            await message.channel.send(help_text[i:i + 1900])