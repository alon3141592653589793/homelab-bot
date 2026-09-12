import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import api_manager

try:
    import gspread
except ImportError as e:
    print(f"FAILURE: {e} (pip3 install --user gspread)")
    sys.exit(1)

KEY = "/home/alon/.secrets/gcp_service_account.json"
SHEET_ID_FILE = "/home/alon/.secrets/gsheets_log_id.txt"

if os.getenv("PI_TEST_MODE"):
    print("[TEST MODE] outage drain skipped -- no replay to Sheets.")
    sys.exit(0)

# --- Sheets: re-append queued rows to whatever worksheet the payload names ---
def handle_sheets(item):
    p = item["payload"]
    try:
        api_manager.rate_limit("gsheets")
        gc = gspread.service_account(filename=KEY)
        sh = gc.open_by_key(open(SHEET_ID_FILE).read().strip())
        try:
            ws = sh.worksheet(p["ws"])
        except gspread.WorksheetNotFound:
            # Create the missing worksheet with enough cols for the queued rows.
            ncols = max(len(r) for r in p["rows"]) if p["rows"] else 6
            ws = sh.add_worksheet(p["ws"], rows=1, cols=ncols + 2)
        ws.append_rows(p["rows"], value_input_option="RAW")
        return True
    except Exception:
        return False

drained = api_manager.drain_outage("gsheets", handle_sheets)
print(f"Drained from outage buffer: {drained} sheets rows.")