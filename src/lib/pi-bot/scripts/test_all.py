import os
import sys
import subprocess
import time
from datetime import datetime

BOT_DIR = "/home/alon/secure-pi-bot"
SCRIPTS_DIR = f"{BOT_DIR}/scripts"
SHM = "/dev/shm/pi-bot"
SKIP = {"restart.py", "shutdown.py"}
TEST_CHANNEL = os.getenv("TESTING_CHANNEL_ID", "")
LOCK_FILE = f"{SHM}/.testall_running"
# Every test subprocess runs with PI_TEST_MODE=1 so network-writing scripts
# skip their real external sends and only exercise local logic.
TEST_ENV = {**os.environ, "PI_TEST_MODE": "1"}

from dotenv import load_dotenv
load_dotenv(f"{BOT_DIR}/.env")
TOKEN = os.getenv("DISCORD_BOT_TOKEN", "")

os.makedirs(SHM, exist_ok=True)

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

# Local state the tests mutate -- snapshotted before, restored after.
SNAPSHOT_FILES = [
    f"{SHM}/system_log.jsonl",
    f"{SHM}/fan_events.jsonl",
    f"{SHM}/fan_state.txt",
    f"{SHM}/.bot_status.json",
    f"{SHM}/api_calls.jsonl",
    f"{SHM}/.ai_rate",
    f"{SHM}/.ai_conversation.json",
    f"{SHM}/ai_summary_log.jsonl",
    f"{SHM}/.disk_io_state",
    f"{SHM}/.log_sync_state.json",
]
PROFILE_OVERRIDE = f"{BOT_DIR}/.profile_override"
LOGGING_FLAG = f"{BOT_DIR}/.logging_enabled"
COOLDOWN_SERVICES = ["nginx", "lightdm", "bluetooth", "cups"]

def snapshot():
    snap = {}
    for path in SNAPSHOT_FILES + [PROFILE_OVERRIDE, LOGGING_FLAG]:
        if os.path.exists(path):
            try:
                with open(path, "rb") as f:
                    snap[path] = f.read()
            except OSError:
                pass
    active = [s for s in COOLDOWN_SERVICES
              if subprocess.run(["systemctl", "is-active", "--quiet", s]).returncode == 0]
    snap["__active_services__"] = active
    return snap

def restore(snap):
    os.makedirs(SHM, exist_ok=True)
    for path in SNAPSHOT_FILES + [PROFILE_OVERRIDE, LOGGING_FLAG]:
        if path in snap:
            try:
                with open(path, "wb") as f:
                    f.write(snap[path])
            except OSError:
                pass
        elif os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
    restart_failed = []
    for svc in snap.get("__active_services__", []):
        r = subprocess.run(["systemctl", "start", svc], capture_output=True)
        if r.returncode != 0:
            restart_failed.append(svc)
    # Re-apply the CPU profile via the single writer (honors restored override).
    subprocess.run(["python3", f"{SCRIPTS_DIR}/profile_scheduler.py"], capture_output=True)
    if restart_failed:
        post(f"[RESTORE] could not restart: {', '.join(restart_failed)}")

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

def run_tests():
    start = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    post(f"=== /testall START {start} ===\n"
         f"Target: {'#testing ' + TEST_CHANNEL if TEST_CHANNEL else '(stdout only -- set TESTING_CHANNEL_ID)'}\n"
         f"Skipping (destructive): {', '.join(sorted(SKIP))}\n"
         f"State snapshot taken -- local changes will be reverted; cloud writes skipped (PI_TEST_MODE).")
    passed = failed = skipped = 0
    results = []
    for fname, argsets, timeout in TESTS:
        if fname in SKIP:
            skipped += 1
            continue
        path = os.path.join(SCRIPTS_DIR, fname)
        for args in argsets:
            argstr = " ".join(args)
            post(f"\n--- TEST: {fname} {argstr}".strip())
            cmd = ["python3", "-u", path] + args
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=TEST_ENV)
                out = (r.stdout or "").strip()
                err = (r.stderr or "").strip()
                combined = out + (("\n[stderr]\n" + err) if err else "")
                ok = r.returncode == 0 and "FAILURE" not in combined
                status = "PASS" if ok else f"FAIL(rc={r.returncode})"
                post(f"cmd: python3 {fname} {argstr}\n{status}\n{combined[:1700]}")
                passed += 1 if ok else 0
                failed += 0 if ok else 1
                results.append((fname, argstr, status))
            except subprocess.TimeoutExpired:
                post(f"cmd: python3 {fname} {argstr}\nTIMEOUT after {timeout}s")
                failed += 1
                results.append((fname, argstr, "TIMEOUT"))
            except FileNotFoundError:
                post(f"cmd: python3 {fname} {argstr}\nSKIP (file not found on disk)")
                skipped += 1
                results.append((fname, argstr, "MISSING"))
            time.sleep(2)  # thermal pause between runs
    return passed, failed, skipped, results

def main():
    if os.path.exists(LOCK_FILE):
        age = time.time() - os.path.getmtime(LOCK_FILE)
        if age < 35 * 60:
            post("=== /testall ABORTED: another /testall is already running ===")
            sys.exit(0)
        try:
            os.remove(LOCK_FILE)
        except OSError:
            pass
    snap = snapshot()
    open(LOCK_FILE, "w").close()
    try:
        passed, failed, skipped, results = run_tests()
    finally:
        restore(snap)
        try:
            os.remove(LOCK_FILE)
        except OSError:
            pass
    end = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    summary = f"\n=== /testall DONE {end} ===\nPassed: {passed} | Failed: {failed} | Skipped: {skipped}\n"
    for fname, argstr, status in results:
        summary += f"  {fname} [{argstr}]: {status}\n"
    summary += "Local state restored: profile, services, RAM logs. Discord/Sheets/Drive writes were skipped (PI_TEST_MODE)."
    post(summary)

if __name__ == "__main__":
    main()