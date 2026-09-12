import os
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
SHEET_STATE = f"{SHM}/.weekly_sheet_state.json"
os.makedirs(SHM, exist_ok=True)
TEST_MODE = bool(os.getenv("PI_TEST_MODE"))
FORCE = "--force" in sys.argv  # manual /weeklyreport bypasses day/idempotency guards

# --- Israel local time (true time when online, Pi clock fallback) ---
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
    # Day-of-week guard (Monday in Israel time)
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
    (datetime.fromisoformat(e) - datetime.fromisoformat(s)).total_seconds() if e
    else (now - datetime.fromisoformat(s)).total_seconds()
    for s, e in fan_sessions
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

report = "\n".join(lines)
if TEST_MODE:
    print(f"[TEST MODE] weekly report built ({len(report)} chars) -- Discord+Sheets send skipped, state not persisted.")
    print(report)
    sys.exit(0)

# --- Send to Discord (best-effort; failure no longer aborts Drive sync) ---
discord_ok = post(report)

# --- Sync to Google Sheets: append a new row to the 'Weekly Reports' worksheet
WR_KEY = "/home/alon/.secrets/gcp_service_account.json"
WR_SHEET_ID_FILE = "/home/alon/.secrets/gsheets_log_id.txt"
WR_WS = "Weekly Reports"
WR_HEADERS = ["ts", "week", "uptime", "temp_avg_c", "temp_min_c", "temp_max_c", "fan_sessions", "fan_minutes", "spikes", "report"]
try:
    import gspread
except ImportError:
    gspread = None
WR_READY = gspread is not None and os.path.exists(WR_KEY) and os.path.exists(WR_SHEET_ID_FILE)

def sync_to_sheet(report_text):
    if not WR_READY:
        return False, "gspread lib/keys/sheet-id unavailable"
    try:
        gc = gspread.service_account(filename=WR_KEY)
        sh = gc.open_by_key(open(WR_SHEET_ID_FILE).read().strip())
        try:
            ws = sh.worksheet(WR_WS)
        except gspread.WorksheetNotFound:
            ws = sh.add_worksheet(WR_WS, rows=1, cols=len(WR_HEADERS))
            ws.append_row(WR_HEADERS)
    except Exception as e:
        return False, str(e)
    tavg = tmin = tmax = ""
    if temps:
        tavg = round(sum(temps) / len(temps), 1)
        tmin = min(temps); tmax = max(temps)
    week_label = now.strftime("%G-W%V")
    spikes_str = "; ".join(
        f"{datetime.fromisoformat(s.get('ts') or s.get('ts_start','')).strftime('%m/%d')}={s.get('temp_c') or s.get('temp_avg_c')}"
        for s in (spikes[-10:] if spikes else [])
    )
    row = [now.isoformat(timespec="seconds"), week_label, uptime, tavg, tmin, tmax,
           len(fan_sessions), int(total_fan_s // 60), spikes_str, report_text[:4000]]
    try:
        api_manager.rate_limit("gsheets")
        ws.append_row(row, value_input_option="RAW")
        api_manager.record("gsheets", True)
        # Roll the window: keep the most recent 50 rows (header stays at row 1).
        data = [r for r in ws.get_all_values() if r and r[0]]
        if len(data) > 50:
            ws.delete_rows(2, len(data) - 50 + 1)
        return True, WR_WS
    except Exception as e:
        api_manager.record("gsheets", False)
        return False, str(e)

sheet_ok, sheet_msg = sync_to_sheet(report)
if not sheet_ok:
    # Failed append -> queue for outage_drain (payload shaped for handle_sheets).
    api_manager.queue_outage("gsheets", "rows", {
        "ws": WR_WS,
        "rows": [[now.isoformat(timespec="seconds"), now.strftime("%G-W%V"), uptime,
                  (round(sum(temps)/len(temps),1) if temps else ""),
                  (min(temps) if temps else ""), (max(temps) if temps else ""),
                  len(fan_sessions), int(total_fan_s//60),
                  "; ".join(f"{datetime.fromisoformat(s.get('ts') or s.get('ts_start','')).strftime('%m/%d')}={s.get('temp_c') or s.get('temp_avg_c')}" for s in (spikes[-10:] if spikes else [])),
                  report[:4000]]]
    })

# --- Sheet-fail tracking: warn Discord if the sync fails for > 1 day ---
ds = {}
try:
    if os.path.exists(SHEET_STATE):
        with open(SHEET_STATE) as f:
            ds = json.load(f)
except (OSError, ValueError):
    pass
if sheet_ok:
    ds = {"fail_since": None}
else:
    if not ds.get("fail_since"):
        ds["fail_since"] = now.isoformat()
        ds["err"] = str(sheet_msg)[:200]
    age = (now - datetime.fromisoformat(ds["fail_since"])).total_seconds()
    if age > 86400:
        post(f"**Weekly report Sheet sync warning** [{now.strftime('%H:%M')}] -- failing for >1 day ({int(age//3600)}h). Last error: {ds.get('err','')}")
try:
    with open(SHEET_STATE, "w") as f:
        json.dump(ds, f)
except OSError:
    pass

# --- Mark this Israel ISO-week posted (only if at least one channel succeeded) ---
if discord_ok or sheet_ok:
    state["week"] = this_week
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
    except OSError:
        pass
else:
    print("Weekly report: both Discord and Sheets failed; not marking week posted (will retry next eligible run).")

print("Weekly report sent.")