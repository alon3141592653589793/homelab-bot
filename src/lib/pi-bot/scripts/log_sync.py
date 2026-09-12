import os
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
                f.write(json.dumps(r) + "\n")
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
                f.write(json.dumps(r) + "\n")
st["last_fan_ts"] = new_max_f

save_state(st)
dest = f"sheet {SHEET_ID}" if CLOUD_READY else "SD (keys not yet configured)"
print(f"Synced {len(sys_rows)} system + {len(fan_rows)} fan rows to {dest}")