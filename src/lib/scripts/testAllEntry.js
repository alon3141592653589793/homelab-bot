const entry = {
  id: "test-all",
  filename: "test_all.py",
  path: "~/secure-pi-bot/scripts/test_all.py",
  description: "Full test harness invoked by /testall. Runs every project script (except restart.py / shutdown.py) one by one with edge-case argument variations, exactly as the bot runs them (python3 -u <script> <args>), and streams each command line + stdout/stderr + PASS/FAIL to a dedicated #testing Discord channel (TESTING_CHANNEL_ID env). 2s thermal pause between runs. ai_debug gets both an --auto-error trigger and a manual question; weekly_report + lynis_report + lynis_snapshot + log_sync run for real (they hit their normal channels/APIs by design — 'the code that runs is the same as normal'). Prints a final summary table.",
  tags: ["test", "discord", "harness", "diagnostic"],
  code: `import os
import sys
import subprocess
import time
from datetime import datetime

BOT_DIR = "/home/alon/secure-pi-bot"
SCRIPTS_DIR = f"{BOT_DIR}/scripts"
SKIP = {"restart.py", "shutdown.py"}
TEST_CHANNEL = os.getenv("TESTING_CHANNEL_ID", "")

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

start = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
post(f"=== /testall START {start} ===\\n"
     f"Target: {'#testing ' + TEST_CHANNEL if TEST_CHANNEL else '(stdout only — set TESTING_CHANNEL_ID)'}\\n"
     f"Skipping (destructive): {', '.join(sorted(SKIP))}\\n")

passed = failed = skipped = 0
results = []

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

end = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
summary = f"\\n=== /testall END {end} ===\\nPassed: {passed} | Failed: {failed} | Skipped: {skipped}\\n"
for fname, argstr, status in results:
    summary += f"  {fname} [{argstr}]: {status}\\n"
post(summary)
`,
};

export default entry;