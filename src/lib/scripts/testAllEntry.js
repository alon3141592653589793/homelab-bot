const entry = {
  id: "test-all",
  filename: "test_all.py",
  path: "~/secure-pi-bot/scripts/test_all.py",
  description: "Full test harness invoked by /testall. Runs every project script (except restart.py / shutdown.py) one by one with edge-case argument variations, exactly as the bot runs them (python3 -u <script> <args>), and streams each command line + stdout/stderr + PASS/FAIL to a dedicated #testing Discord channel (TESTING_CHANNEL_ID env). 2s thermal pause between runs. ai_debug gets both an --auto-error trigger and a manual question; weekly_report + lynis_report + lynis_snapshot + log_sync run for real (they hit their normal channels/APIs by design — 'the code that runs is the same as normal'). STATE: snapshots the CPU profile override marker, the active cooldown-target services, and the /dev/shm bot-status file BEFORE running and restores them in a finally block (external side effects — Discord posts, Drive uploads, Sheets appends, Gemini calls — cannot be rolled back). LOCK: creates /dev/shm/pi-bot/.testall_running on start and clears it on finish; the Discord bot pauses all other commands while the lock exists. Prints a final summary table + a clear DONE line when finished.",
  tags: ["test", "discord", "harness", "diagnostic", "snapshot", "restore", "lock"],
  code: `import os
import sys
import json
import subprocess
import time
from datetime import datetime

BOT_DIR = "/home/alon/secure-pi-bot"
SCRIPTS_DIR = f"{BOT_DIR}/scripts"
SHM = "/dev/shm/pi-bot"
LOCK_FILE = f"{SHM}/.testall_running"
STATE_FILE = f"{SHM}/.testall_state.json"
OVERRIDE_MARKER = f"{BOT_DIR}/.profile_override"
BOT_STATUS_FILE = f"{SHM}/.bot_status.json"
COOLDOWN_TARGETS = ["nginx", "lightdm", "bluetooth", "cups"]
SKIP = {"restart.py", "shutdown.py"}
TEST_CHANNEL = os.getenv("TESTING_CHANNEL_ID", "")

# Reuse the single sysfs writer to restore the CPU profile at the end.
sys.path.insert(0, SCRIPTS_DIR)
import cpu_profile

from dotenv import load_dotenv
load_dotenv(f"{BOT_DIR}/.env")
TOKEN = os.getenv("DISCORD_BOT_TOKEN", "")

try:
    import requests
except ImportError:
    requests = None

def post(text):
    text = (text or "(no output)").strip()
    print(text)
    if not requests or not TEST_CHANNEL or not TOKEN:
        return
    for i in range(0, len(text), 1900):
        try:
            requests.post(f"https://discord.com/api/v10/channels/{TEST_CHANNEL}/messages",
                headers={"Authorization": f"Bot {TOKEN}"},
                json={"content": text[i:i+1900]}, timeout=15)
        except Exception:
            pass

def snapshot_state():
    """Capture local state testall may mutate so we can restore it after.
    External side effects (Discord posts, Drive uploads, Sheets appends,
    Gemini calls) are NOT reversible and are left as-is."""
    os.makedirs(SHM, exist_ok=True)
    state = {"marker_existed": os.path.exists(OVERRIDE_MARKER), "override": None,
            "active_services": [], "bot_status": None}
    if state["marker_existed"]:
        try:
            with open(OVERRIDE_MARKER) as f:
                state["override"] = f.read().strip()
        except OSError:
            pass
    for svc in COOLDOWN_TARGETS:
        if subprocess.run(["systemctl", "is-active", "--quiet", svc],
                          capture_output=True).returncode == 0:
            state["active_services"].append(svc)
    if os.path.exists(BOT_STATUS_FILE):
        try:
            with open(BOT_STATUS_FILE) as f:
                state["bot_status"] = f.read()
        except OSError:
            pass
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)
    return state

def restore_state(state):
    """Undo local state changes. Returns a human-readable list of what was restored."""
    restored = []
    if state.get("marker_existed"):
        try:
            with open(OVERRIDE_MARKER, "w") as f:
                f.write(state.get("override") or "restricted")
            restored.append("profile override restored")
        except OSError:
            pass
    else:
        try:
            os.remove(OVERRIDE_MARKER)
            restored.append("profile override cleared")
        except FileNotFoundError:
            pass
    try:
        cpu_profile.apply(cpu_profile.desired_target())
    except Exception:
        pass
    restarted = []
    for svc in state.get("active_services", []):
        if subprocess.run(["systemctl", "is-active", "--quiet", svc],
                          capture_output=True).returncode != 0:
            subprocess.run(["systemctl", "start", svc], capture_output=True)
            if subprocess.run(["systemctl", "is-active", "--quiet", svc],
                              capture_output=True).returncode == 0:
                restarted.append(svc)
    if restarted:
        restored.append("restarted: " + ", ".join(restarted))
    if state.get("bot_status") is not None:
        try:
            with open(BOT_STATUS_FILE, "w") as f:
                f.write(state["bot_status"])
        except OSError:
            pass
    elif os.path.exists(BOT_STATUS_FILE):
        try:
            os.remove(BOT_STATUS_FILE)
        except OSError:
            pass
    return restored

# Claim the lock so the Discord bot ignores other commands while we run.
# Cleared in the finally block below (and belt-and-braces by the bot's waiter).
os.makedirs(SHM, exist_ok=True)
open(LOCK_FILE, "w").write(datetime.now().isoformat(timespec="seconds"))

# (filename, [list of arg-lists to exercise edge cases], timeout seconds)
TESTS = [
    ("status.py", [[]], 15),
    ("fan_report.py", [[]], 10),
    ("api_fail_report.py", [[]], 10),
    ("profile_status.py", [[]], 5),
    ("cooldown.py", [[]], 20),
    ("set_profile_restricted.py", [[]], 10),
    ("set_profile_unlimited.py", [[]], 10),
    ("update_bot_status.py", [[]], 5),
    ("profile_scheduler.py", [[]], 5),
    ("system_logger.py", [[]], 15),
    ("fan_logger.py", [[]], 5),
    ("compress_logs.py", [[]], 60),
    ("log_sync.py", [[]], 120),
    ("outage_drain.py", [[]], 30),
    ("weekly_report.py", [[]], 40),
    ("lynis_report.py", [[]], 240),
    ("ai_debug.py", [
        ["--auto-error", "test: /testall synthetic trigger"],
        ["hello from /testall — edge case: plain manual prompt"],
    ], 300),
    ("lynis_snapshot.py", [[]], 240),
]

state = snapshot_state()
start = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
post(f"=== /testall START {start} ===\\n"
     f"Target: {'#testing ' + TEST_CHANNEL if TEST_CHANNEL else '(stdout only — set TESTING_CHANNEL_ID)'}\\n"
     f"Skipping (destructive): {', '.join(sorted(SKIP))}\\n"
     f"State snapshot saved (CPU profile, services, bot status) — restored on finish.\\n")

passed = failed = skipped = 0
results = []

try:
    for fname, argsets, timeout in TESTS:
        if fname in SKIP:
            skipped += 1
            continue
        path = os.path.join(SCRIPTS_DIR, fname)
        for args in argsets:
            argstr = " ".join(args)
            post(f"\\n--- TEST: {fname} {argstr}".strip())
            cmd = ["python3", "-u", path] + args
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
                out = (r.stdout or "").strip()
                err = (r.stderr or "").strip()
                combined = out + (("\\n[stderr]\\n" + err) if err else "")
                ok = r.returncode == 0 and "FAILURE" not in combined
                status = "PASS" if ok else f"FAIL(rc={r.returncode})"
                post(f"cmd: python3 {fname} {argstr}\\n{status}\\n{combined[:1700]}")
                passed += 1 if ok else 0
                failed += 0 if ok else 1
                results.append((fname, argstr, status))
            except subprocess.TimeoutExpired:
                post(f"cmd: python3 {fname} {argstr}\\nTIMEOUT after {timeout}s")
                failed += 1
                results.append((fname, argstr, "TIMEOUT"))
            except FileNotFoundError:
                post(f"cmd: python3 {fname} {argstr}\\nSKIP (file not found on disk)")
                skipped += 1
                results.append((fname, argstr, "MISSING"))
            time.sleep(2)  # thermal pause between runs
except Exception as e:
    post(f"\\n!! /testall aborted early: {e}")
finally:
    restored = restore_state(state)
    end = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    summary = f"\\n=== /testall END {end} ===\\nPassed: {passed} | Failed: {failed} | Skipped: {skipped}\\n"
    for fname, argstr, status in results:
        summary += f"  {fname} [{argstr}]: {status}\\n"
    if restored:
        summary += "\\nRestored: " + "; ".join(restored) + "\\n"
    summary += "\\n✅ /testall DONE — test mode over, commands resumed."
    post(summary)
    try:
        os.remove(LOCK_FILE)
    except FileNotFoundError:
        pass
`,
};

export default entry;