import os
import subprocess
from modules.runner import run_script, confirm_and_run

LOGGING_FLAG = "/home/alon/secure-pi-bot/.logging_enabled"
LED_CTL = ["sudo", "-n", "/usr/local/bin/led_ctl"]

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
        await message.channel.send("LEDs forced OFF until reboot (dark for your sleep). /leds auto to resume." if r.returncode == 0 else "LEDs set off but couldn't apply now -- need /usr/local/bin/led_ctl in sudoers (see setup). They'll apply on the next pi-leds poll if the daemon runs.")

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
            "\n== Advanced ==\n"
            "/aidebug <question>   - Conversational AI diagnostic (optional: model prefix)\n"
            "/sync                 - Pull latest from the repo, reboot\n"
            "/sync no-reboot       - Same, but skip the reboot\n"
            "/sync dry-run         - Fetch + list what would change (no write, no reboot)\n"
            "/syncinfo             - When GitHub repo was last updated + when /sync last ran\n"
            "\nSide channels: #adguard -> /adguard help | #vpn -> /vpn help\n"
            "/help                 - This message"
        )
        for i in range(0, len(help_text), 1900):
            await message.channel.send(help_text[i:i + 1900])