const scripts = [
  {
    id: "bot",
    filename: "bot.py",
    title: "Discord Bot — Remote Pi Control",
    description: "Main Discord bot that listens for commands to control the Raspberry Pi remotely via a Discord server.",
    tags: ["discord", "bot", "remote-control"],
    code: `import discord
from discord.ext import commands
import subprocess
import os
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.getenv("DISCORD_BOT_TOKEN")  # YOUR_DISCORD_BOT_TOKEN
GUILD_ID = int(os.getenv("DISCORD_GUILD_ID", "0"))  # YOUR_DISCORD_GUILD_ID
ALLOWED_ROLES = ["pi-admin", "pi-user"]

intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix="!", intents=intents)


def is_authorized(ctx):
    """Check if user has an allowed role."""
    if not ctx.guild:
        return False
    user_roles = [role.name.lower() for role in ctx.author.roles]
    return any(role in user_roles for role in ALLOWED_ROLES)


@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} (ID: {bot.user.id})")
    print(f"Connected to guild ID: {GUILD_ID}")
    print("------")


@bot.command(name="ping")
async def ping(ctx):
    """Check if the bot is alive."""
    latency = round(bot.latency * 1000)
    await ctx.send(f"Pong! Latency: {latency}ms")


@bot.command(name="run")
@commands.check(is_authorized)
async def run_command(ctx, *, command: str):
    """Run a shell command on the Pi. Requires pi-admin or pi-user role."""
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True,
            text=True, timeout=30
        )
        output = result.stdout or result.stderr
        if len(output) > 1900:
            output = output[:1900] + "...\\n[output truncated]"
        await ctx.send(f"\`\`\`\\n{output}\\n\`\`\`")
    except subprocess.TimeoutExpired:
        await ctx.send("Command timed out after 30 seconds.")
    except Exception as e:
        await ctx.send(f"Error: {e}")


@bot.command(name="status")
@commands.check(is_authorized)
async def status(ctx):
    """Get system status: CPU temp, memory, disk."""
    try:
        temp = subprocess.run(
            ["vcgencmd", "measure_temp"], capture_output=True, text=True
        ).stdout.strip()
        mem = subprocess.run(
            ["free", "-h"], capture_output=True, text=True
        ).stdout.strip()
        disk = subprocess.run(
            ["df", "-h", "/"], capture_output=True, text=True
        ).stdout.strip()

        msg = f"**CPU Temp:** {temp}\\n"
        msg += f"**Memory:**\\n\`\`\`\\n{mem}\\n\`\`\`\\n"
        msg += f"**Disk:**\\n\`\`\`\\n{disk}\\n\`\`\`"
        await ctx.send(msg)
    except Exception as e:
        await ctx.send(f"Error fetching status: {e}")


@bot.command(name="reboot")
@commands.has_role("pi-admin")
async def reboot(ctx):
    """Reboot the Pi. Requires pi-admin role."""
    await ctx.send("Rebooting Pi...")
    subprocess.run(["sudo", "reboot"])


@bot.command(name="shutdown")
@commands.has_role("pi-admin")
async def shutdown(ctx):
    """Shutdown the Pi. Requires pi-admin role."""
    await ctx.send("Shutting down Pi...")
    subprocess.run(["sudo", "shutdown", "-h", "now"])


@run_command.error
@status.error
async def auth_error(ctx, error):
    if isinstance(error, commands.CheckFailure):
        await ctx.send(
            "You don't have permission. "
            f"Required roles: {', '.join(ALLOWED_ROLES)}"
        )


@reboot.error
@shutdown.error
async def admin_error(ctx, error):
    if isinstance(error, commands.MissingRole):
        await ctx.send("This command requires the 'pi-admin' role.")


if __name__ == "__main__":
    bot.run(TOKEN)
`
  },
  {
    id: "system-monitor",
    filename: "system_monitor.py",
    title: "System Monitor",
    description: "Monitors Pi system health — CPU temperature, memory usage, disk space, and sends alerts via Discord webhook.",
    tags: ["monitoring", "system", "discord"],
    code: `import subprocess
import time
import json
import requests
import os
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")  # YOUR_DISCORD_WEBHOOK_URL
CHECK_INTERVAL = 300  # seconds (5 minutes)
CPU_TEMP_THRESHOLD = 75.0  # celsius
MEM_THRESHOLD = 90.0  # percent
DISK_THRESHOLD = 90.0  # percent


def get_cpu_temp():
    """Returns CPU temperature in celsius."""
    try:
        result = subprocess.run(
            ["vcgencmd", "measure_temp"],
            capture_output=True, text=True
        )
        temp_str = result.stdout.strip()
        return float(temp_str.split("=")[1].split("'")[0])
    except Exception:
        return None


def get_memory_usage():
    """Returns memory usage percentage."""
    try:
        result = subprocess.run(
            ["free", "-m"], capture_output=True, text=True
        )
        lines = result.stdout.strip().split("\\n")
        mem_line = lines[1].split()
        total = float(mem_line[1])
        used = float(mem_line[2])
        return (used / total) * 100
    except Exception:
        return None


def get_disk_usage():
    """Returns disk usage percentage for root partition."""
    try:
        result = subprocess.run(
            ["df", "-h", "/"], capture_output=True, text=True
        )
        lines = result.stdout.strip().split("\\n")
        usage_pct = lines[1].split()[-2].replace("%", "")
        return float(usage_pct)
    except Exception:
        return None


def get_uptime():
    """Returns system uptime as a readable string."""
    try:
        result = subprocess.run(
            ["uptime", "-p"], capture_output=True, text=True
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def send_discord_alert(title, description, color=0xFFA500):
    """Send an embed alert to Discord via webhook."""
    if not WEBHOOK_URL or WEBHOOK_URL == "YOUR_DISCORD_WEBHOOK_URL":
        print(f"[ALERT] {title}: {description}")
        return

    embed = {
        "title": title,
        "description": description,
        "color": color,
        "timestamp": datetime.utcnow().isoformat(),
        "footer": {"text": "Pi System Monitor"}
    }

    try:
        requests.post(
            WEBHOOK_URL,
            json={"embeds": [embed]},
            timeout=10
        )
    except Exception as e:
        print(f"Failed to send Discord alert: {e}")


def check_system():
    """Run all health checks and alert if thresholds exceeded."""
    alerts = []

    temp = get_cpu_temp()
    if temp and temp >= CPU_TEMP_THRESHOLD:
        alerts.append(f"CPU temperature is {temp}°C")

    mem = get_memory_usage()
    if mem and mem >= MEM_THRESHOLD:
        alerts.append(f"Memory usage is {mem:.1f}%")

    disk = get_disk_usage()
    if disk and disk >= DISK_THRESHOLD:
        alerts.append(f"Disk usage is {disk:.1f}%")

    if alerts:
        send_discord_alert(
            "Pi System Alert",
            "\\n".join(f"- {a}" for a in alerts),
            color=0xFF0000
        )


def log_health():
    """Log current health status to console."""
    temp = get_cpu_temp()
    mem = get_memory_usage()
    disk = get_disk_usage()
    uptime = get_uptime()

    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] "
          f"Temp: {temp}°C | Mem: {mem:.1f}% | "
          f"Disk: {disk:.1f}% | Uptime: {uptime}")


if __name__ == "__main__":
    print("Starting Pi System Monitor...")
    print(f"Check interval: {CHECK_INTERVAL}s")
    print(f"Temp threshold: {CPU_TEMP_THRESHOLD}°C")
    print(f"Memory threshold: {MEM_THRESHOLD}%")
    print(f"Disk threshold: {DISK_THRESHOLD}%")

    while True:
        check_system()
        log_health()
        time.sleep(CHECK_INTERVAL)
`
  },
  {
    id: "gpio-control",
    filename: "gpio_control.py",
    title: "GPIO Control Utilities",
    description: "Helper functions for controlling GPIO pins — LEDs, relays, sensors. Used by other scripts to interact with Pi hardware.",
    tags: ["gpio", "hardware", "utilities"],
    code: `import RPi.GPIO as GPIO
import time
from typing import Optional, List


# Pin numbering mode — use BCM (Broadcom) by default
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)


class PinController:
    """
    Simple GPIO pin controller.
    Usage:
        led = PinController(17, mode="out")
        led.on()
        led.off()
        led.blink(times=5, interval=0.5)
        led.cleanup()
    """

    def __init__(self, pin: int, mode: str = "out",
                 initial: bool = False):
        self.pin = pin
        self.mode = mode

        if mode == "out":
            GPIO.setup(pin, GPIO.OUT, initial=initial)
        elif mode == "in":
            GPIO.setup(pin, GPIO.IN,
                       pull_up_down=GPIO.PUD_UP)
        else:
            raise ValueError("Mode must be 'in' or 'out'")

    def on(self):
        """Set pin HIGH."""
        GPIO.output(self.pin, GPIO.HIGH)

    def off(self):
        """Set pin LOW."""
        GPIO.output(self.pin, GPIO.LOW)

    def toggle(self):
        """Toggle pin state."""
        GPIO.output(self.pin,
                    not GPIO.input(self.pin))

    def read(self) -> bool:
        """Read pin state (True = HIGH)."""
        return bool(GPIO.input(self.pin))

    def blink(self, times: int = 3,
              interval: float = 0.5):
        """Blink the pin on/off."""
        for _ in range(times):
            self.on()
            time.sleep(interval)
            self.off()
            time.sleep(interval)

    def cleanup(self):
        """Reset pin to default state."""
        GPIO.cleanup(self.pin)


class RelayController(PinController):
    """
    Relay controller — extends PinController.
    Active-low relay: writing LOW activates it.
    """

    def __init__(self, pin: int, active_low: bool = True):
        super().__init__(pin, mode="out",
                         initial=not active_low)
        self.active_low = active_low

    def activate(self):
        """Turn relay ON."""
        if self.active_low:
            self.off()
        else:
            self.on()

    def deactivate(self):
        """Turn relay OFF."""
        if self.active_low:
            self.on()
        else:
            self.off()


class ButtonSensor:
    """
    Simple button/push-switch sensor.
    Usage:
        btn = ButtonSensor(22)
        if btn.is_pressed():
            print("Button pressed!")
    """

    def __init__(self, pin: int):
        self.pin = pin
        GPIO.setup(pin, GPIO.IN,
                   pull_up_down=GPIO.PUD_UP)

    def is_pressed(self) -> bool:
        """Returns True if button is currently pressed."""
        return not GPIO.input(self.pin)

    def wait_for_press(self, timeout: Optional[float] = None):
        """Block until button is pressed."""
        start = time.time()
        while not self.is_pressed():
            if timeout and (time.time() - start) > timeout:
                raise TimeoutError("Button press timed out")
            time.sleep(0.01)


def cleanup_all():
    """Clean up all GPIO pins."""
    GPIO.cleanup()


# Example usage
if __name__ == "__main__":
    try:
        led = PinController(17)
        led.blink(times=5, interval=0.3)

        btn = ButtonSensor(22)
        print("Press the button...")
        btn.wait_for_press(timeout=10)
        print("Button pressed!")

    except KeyboardInterrupt:
        print("\\nExiting...")
    finally:
        cleanup_all()
`
  },
  {
    id: "scheduler",
    filename: "task_scheduler.py",
    title: "Task Scheduler",
    description: "Simple cron-like scheduler for running Python functions on a schedule. Used for periodic automation tasks.",
    tags: ["scheduling", "automation", "utilities"],
    code: `import time
import threading
from datetime import datetime, timedelta
from typing import Callable, Dict, List


class TaskScheduler:
    """
    Lightweight task scheduler for Raspberry Pi automation.

    Usage:
        sched = TaskScheduler()

        @sched.every(minutes=5)
        def check_sensors():
            print("Checking sensors...")

        @sched.daily_at("08:00")
        def morning_report():
            print("Good morning!")

        sched.start()  # Runs in background thread
    """

    def __init__(self):
        self._tasks: List[Dict] = []
        self._running = False
        self._thread: threading.Thread = None

    def every(self, seconds: int = 0, minutes: int = 0,
              hours: int = 0):
        """Decorator: run a function on a fixed interval."""
        interval = seconds + minutes * 60 + hours * 3600

        def decorator(func: Callable):
            self._tasks.append({
                "func": func,
                "type": "interval",
                "interval": interval,
                "last_run": None,
            })
            return func
        return decorator

    def daily_at(self, time_str: str):
        """Decorator: run a function daily at a specific time."""
        def decorator(func: Callable):
            self._tasks.append({
                "func": func,
                "type": "daily",
                "time_str": time_str,
                "last_run": None,
            })
            return func
        return decorator

    def _should_run(self, task: Dict) -> bool:
        """Check if a task is due to run."""
        now = datetime.now()

        if task["type"] == "interval":
            if task["last_run"] is None:
                return True
            elapsed = (now - task["last_run"]).total_seconds()
            return elapsed >= task["interval"]

        elif task["type"] == "daily":
            target = datetime.strptime(
                task["time_str"], "%H:%M"
            ).time()
            today_target = datetime.combine(
                now.date(), target
            )
            if now < today_target:
                return False
            if task["last_run"] is None:
                return True
            return task["last_run"].date() < now.date()

        return False

    def _loop(self):
        """Main scheduler loop — runs in background thread."""
        while self._running:
            now = datetime.now()
            for task in self._tasks:
                if self._should_run(task):
                    try:
                        task["func"]()
                    except Exception as e:
                        print(
                            f"Scheduler error in "
                            f"{task['func'].__name__}: {e}"
                        )
                    task["last_run"] = now
            time.sleep(1)  # 1-second resolution

    def start(self):
        """Start the scheduler in a background thread."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._loop, daemon=True
        )
        self._thread.start()
        print("Scheduler started.")

    def stop(self):
        """Stop the scheduler."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)
        print("Scheduler stopped.")


# Example usage
if __name__ == "__main__":
    sched = TaskScheduler()

    @sched.every(seconds=10)
    def heartbeat():
        """Log a heartbeat every 10 seconds."""
        print(
            f"Heartbeat: "
            f"{datetime.now().strftime('%H:%M:%S')}"
        )

    @sched.daily_at("09:00")
    def daily_report():
        """Run daily report at 9 AM."""
        print("Generating daily report...")

    sched.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        sched.stop()
        print("Scheduler stopped. Goodbye!")
`
  },
  {
    id: "env-template",
    filename: ".env.example",
    title: "Environment Variables Template",
    description: "Template .env file listing all required environment variables. Copy to .env and fill in your values.",
    tags: ["config", "security"],
    code: `# ============================================
# Pi Lab — Environment Variables
# Copy this file to .env and fill in values
# NEVER commit .env to GitHub!
# ============================================

# --- Discord Bot ---
DISCORD_BOT_TOKEN=YOUR_DISCORD_BOT_TOKEN_HERE
DISCORD_GUILD_ID=YOUR_DISCORD_GUILD_ID_HERE

# --- Discord Webhooks ---
DISCORD_WEBHOOK_URL=YOUR_DISCORD_WEBHOOK_URL_HERE

# --- AI / LLM API Keys (future) ---
OPENAI_API_KEY=YOUR_OPENAI_API_KEY_HERE
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY_HERE

# --- Network ---
PI_HOSTNAME=raspberrypi
PI_LOCAL_IP=192.168.x.x

# --- GPIO Pin Map (add your pin assignments) ---
# LED_PIN=17
# RELAY_PIN=23
# BUTTON_PIN=22
# SENSOR_TRIGGER=24
# SENSOR_ECHO=25
`
  }
];

export default scripts;