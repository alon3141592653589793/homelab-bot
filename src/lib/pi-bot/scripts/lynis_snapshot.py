import os
import sys
import json
import glob
import re
import subprocess
from datetime import datetime

try:
    import gspread
except ImportError:
    gspread = None

import requests as httpreq
import api_manager

KEY_FILE = "/home/alon/.secrets/gcp_service_account.json"
SHEET_ID_FILE = "/home/alon/.secrets/gsheets_log_id.txt"
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = "/home/alon/secure-pi-bot/logs"
PREFIX = "lynis_snapshot_"
# Sheets cells cap ~50000 chars; keep raw lynis safely truncated for a cell.
MAX_RAW = 4000
WS_TITLE = "Lynis Snapshots"
HEADERS = ["ts", "score", "prev_score", "changed", "ai_analysis", "lynis_raw_truncated"]

os.makedirs(LOG_DIR, exist_ok=True)
SHEETS_READY = gspread is not None and os.path.exists(KEY_FILE) and os.path.exists(SHEET_ID_FILE)

def _sheet():
    gc = gspread.service_account(filename=KEY_FILE)
    sh = gc.open_by_key(open(SHEET_ID_FILE).read().strip())
    try:
        return sh.worksheet(WS_TITLE)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(WS_TITLE, rows=1, cols=len(HEADERS))
        ws.append_row(HEADERS)
        return ws

def lynis_score(text):
    m = re.search(r'Hardening index\s*:\s*(\d+)', text)
    return int(m.group(1)) if m else None

def run_ai_diff(prev, cur):
    """AI explains the diff -- may use Google Search (--web) for unknown warning codes."""
    prompt = ("Weekly Lynis security audit output changed. Compare and explain what changed -- "
              "new warnings, removed warnings, hardening-index delta -- and what each likely means "
              "for the Pi (for better or worse). Use web search to look up any unfamiliar warning "
              "codes. Cite specific lines.\n\n=== PREVIOUS ===\n" + (prev or "(none)")[:8000]
              + "\n\n=== CURRENT ===\n" + cur[:8000])
    try:
        p = subprocess.run(["python3", "-u", os.path.join(SCRIPTS_DIR, "ai_debug.py"),
                            "--auto", "--web", prompt],
                           capture_output=True, text=True, timeout=180)
        return (p.stdout or "").strip() or "(no AI output)"
    except Exception as e:
        return f"(AI diff failed: {e})"

def post_discord(text):
    if os.getenv("PI_TEST_MODE"):
        return
    from dotenv import load_dotenv
    load_dotenv("/home/alon/secure-pi-bot/.env")
    tok = os.getenv("DISCORD_BOT_TOKEN")
    try:
        ch_id = int(os.getenv("REPORT_CHANNEL_ID", "0"))
    except ValueError:
        ch_id = 0
    if not tok or not ch_id:
        return
    for chunk in [text[i:i+1900] for i in range(0, len(text), 1900)]:
        try:
            httpreq.post(f"https://discord.com/api/v10/channels/{ch_id}/messages",
                         headers={"Authorization": f"Bot {tok}"}, json={"content": chunk}, timeout=10)
        except Exception:
            pass

# Use --quick: versioning only needs the Hardening index + warnings, and the
# full audit hangs for 3-5+ min on a Pi. Quick run is ~30-60s.
try:
    r = subprocess.run(["lynis", "audit", "system", "--quick", "--no-colors"],
                       capture_output=True, text=True, timeout=180)
    output = (r.stdout or r.stderr or "").strip()
except FileNotFoundError:
    print("FAILURE: lynis not installed")
    sys.exit(1)
except subprocess.TimeoutExpired:
    print("FAILURE: lynis timed out (180s)")
    sys.exit(1)

score = lynis_score(output)
ts = datetime.now().strftime("%Y-%m-%d %H:%M")

if score is None:
    msg = "Lynis output has no 'Hardening index' line -- cannot compare. No snapshot saved."
    post_discord(f"**Lynis warning** [{ts}]\n{msg}")
    print(msg)
    sys.exit(1)

if os.getenv("PI_TEST_MODE"):
    print(f"[TEST MODE] Lynis score={score} -- Sheet append + Discord post skipped.")
    sys.exit(0)

# --- SD-card fallback (until service-account key / sheet ID are configured) ---
if not SHEETS_READY:
    files = sorted(glob.glob(f"{LOG_DIR}/{PREFIX}*.txt"))
    prev_body = open(files[-1]).read() if files else None
    # strip header line to recover just the raw lynis block + analysis
    if prev_body:
        pre = prev_body.split("\n\n=== AI CHANGE ANALYSIS ===")[0]
        nl = pre.find("\n")
        prev_raw = pre[nl + 1:].rstrip("\n") if nl != -1 else pre
    else:
        prev_raw = None
    prev_score = lynis_score(prev_raw) if prev_raw else None
    if prev_score is not None and prev_score == score:
        print(f"Lynis unchanged (score={score}, SD fallback -- no new version).")
        sys.exit(0)
    analysis = "(baseline run -- first snapshot)" if prev_raw is None else run_ai_diff(prev_raw, output)
    body = (f"=== LYNIS SNAPSHOT {ts} ===\n{output}\n\n"
            f"=== AI CHANGE ANALYSIS ===\n{analysis}\n")
    with open(os.path.join(LOG_DIR, f"{PREFIX}{datetime.now().strftime('%Y%m%d_%H%M')}.txt"), "w") as f:
        f.write(body)
    for old in files[:-3]:
        try:
            os.remove(old)
        except OSError:
            pass
    if prev_raw is not None:
        post_discord(f"**Lynis change analysis (SD fallback)** [{ts}] -- score {prev_score} -> {score}\n{analysis}")
    print(f"Lynis {'changed' if prev_raw is not None else 'baseline'} (SD fallback, kept last 4 locally). score={score}")
    sys.exit(0)

# --- Sheets path (keys + sheet ID configured) ---
ws = _sheet()
rows = ws.get_all_values()
data = [r for r in rows[1:] if r and r[0]]
prev_score = None
prev_raw = None
if data:
    last = data[-1]
    if len(last) > 5 and last[1]:
        try:
            prev_score = int(last[1])
        except ValueError:
            prev_score = None
        prev_raw = last[5] or ""
    if prev_score is not None and prev_score == score:
        print(f"Lynis unchanged -- no new row (score={score}, {len(data)} snapshots in sheet).")
        sys.exit(0)

analysis = run_ai_diff(prev_raw, output) if prev_raw else "(baseline run -- first snapshot in sheet, nothing to diff against)"
changed = "Y" if prev_raw else "baseline"
new_row = [ts, score, prev_score if prev_score is not None else "", changed, analysis, output[:MAX_RAW]]

api_manager.rate_limit("gsheets")
try:
    ws.append_row(new_row, value_input_option="RAW")
    api_manager.record("gsheets", True)
except Exception as e:
    api_manager.record("gsheets", False)
    # Payload shaped for outage_drain handle_sheets: {"ws": <title>, "rows": [[...]]}
    api_manager.queue_outage("gsheets", "rows", {"ws": WS_TITLE, "rows": [new_row]})
    print(f"FAILURE: Sheets append ({e}) -- queued to outage buffer.")
    sys.exit(1)

# Trim to the most recent 50 snapshots (roll the window; keep header at row 1).
extra = len(data) - 50 + 1  # +1 because we just added one, so keep last 50 incl. this one
if extra > 0:
    try:
        ws.delete_rows(2, 1 + extra)
    except Exception:
        pass

if prev_raw:
    post_discord(f"**Lynis change analysis** [{ts}] -- score {prev_score} -> {score}\n{analysis}")
print(f"Lynis {'changed' if prev_raw else 'baseline'} -> appended row to '{WS_TITLE}' (score {prev_score} -> {score}); {len(data)+1} snapshots in sheet.")