const entry = {
  id: "lynis-snapshot",
  filename: "lynis_snapshot.py",
  path: "~/secure-pi-bot/scripts/lynis_snapshot.py",
  description: "Weekly Lynis snapshot to Google Drive (versioned, keep last 4). Change detection is now SCORE-ONLY: extracts the Lynis 'Hardening index' integer and saves a new version only when the score changes (first run = baseline). On a change, runs ai_debug --auto --web (Gemini + google_search grounding) to explain the diff and POSTS the analysis to Discord; the full snapshot (Lynis output + analysis) uploads to Drive and is shared with your email. Falls back to local SD-card text files (keep 4) when the service-account key is missing. Removes the old allowlist normalizer + small-fingerprint guard + monthly canary -- one number is all that matters. Rate-limited via api_manager.",
  tags: ["lynis", "audit", "gdrive", "versioning", "ai", "web-search", "score"],
  code: `import os
import sys
import json
import glob
import re
import subprocess
from datetime import datetime

try:
    from google.oauth2 import service_account
    from google.auth.transport import requests as gauth_requests
except ImportError:
    service_account = None

import requests as httpreq
import api_manager

KEY_FILE = "/home/alon/.secrets/gcp_service_account.json"
SHARE_EMAIL_FILE = "/home/alon/.secrets/gdrive_share_email.txt"
PARENT_FOLDER_FILE = "/home/alon/.secrets/gdrive_uploads_folder_id.txt"
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = "/home/alon/secure-pi-bot/logs"
PREFIX = "lynis_snapshot_"

os.makedirs(LOG_DIR, exist_ok=True)
# Service accounts have NO storage quota -- uploads MUST land inside a real
# user-owned folder shared (as Editor) with this service account. Read its ID
# from gdrive_uploads_folder_id.txt; without it the upload 403s.
def _load_parent_id():
    try:
        return open(PARENT_FOLDER_FILE).read().strip() or None
    except OSError:
        return None
PARENT_FOLDER = _load_parent_id()
DRIVE_READY = service_account is not None and os.path.exists(KEY_FILE)
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
CREDS = service_account.Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES) if DRIVE_READY else None

def drive(method, url, **kw):
    api_manager.rate_limit("gdrive")
    if not CREDS.valid or CREDS.expired:
        CREDS.refresh(gauth_requests.Request())
    headers = {"Authorization": f"Bearer {CREDS.token}"}
    headers.update(kw.pop("headers", {}))
    r = httpreq.request(method, url, headers=headers, timeout=30, **kw)
    api_manager.record("gdrive", r.status_code < 400)
    return r

def lynis_score(text):
    # Lynis prints: "  Hardening index : 64 [##############   ]"
    m = re.search(r'Hardening index\\s*:\\s*(\\d+)', text)
    return int(m.group(1)) if m else None

def run_ai_diff(prev, cur):
    """AI explains the diff -- may use Google Search (--web) for unknown warning codes."""
    prompt = ("Weekly Lynis security audit output changed. Compare and explain what changed -- "
              "new warnings, removed warnings, hardening-index delta -- and what each likely means "
              "for the Pi (for better or worse). Use web search to look up any unfamiliar warning "
              "codes. Cite specific lines.\\n\\n=== PREVIOUS ===\\n" + (prev or "(none)")[:8000]
              + "\\n\\n=== CURRENT ===\\n" + cur[:8000])
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
fname = f"{PREFIX}{datetime.now().strftime('%Y%m%d_%H%M')}.txt"

if score is None:
    msg = "Lynis output has no 'Hardening index' line -- cannot compare. No snapshot saved."
    post_discord(f"**Lynis warning** [{ts}]\\n{msg}")
    print(msg)
    sys.exit(1)

if os.getenv("PI_TEST_MODE"):
    print(f"[TEST MODE] Lynis score={score} -- Drive upload + Discord post skipped.")
    sys.exit(0)

# Stored file format: "<header>\\n<raw lynis>\\n\\n=== AI CHANGE ANALYSIS ===\\n<analysis>\\n"
def _extract_output(body):
    marker = "\\n=== AI CHANGE ANALYSIS ==="
    pre = body.split(marker)[0]
    nl = pre.find("\\n")
    return pre[nl + 1:].rstrip("\\n") if nl != -1 else pre

# --- SD-card fallback (until service-account key is configured) ---
if not DRIVE_READY:
    files = sorted(glob.glob(f"{LOG_DIR}/{PREFIX}*.txt"))
    prev_body = open(files[-1]).read() if files else None
    prev_raw = _extract_output(prev_body) if prev_body else None
    prev_score = lynis_score(prev_raw) if prev_raw else None
    if prev_score is not None and prev_score == score:
        print(f"Lynis unchanged (score={score}, SD fallback -- no new version).")
        sys.exit(0)
    analysis = "(baseline run -- first snapshot)" if prev_raw is None else run_ai_diff(prev_raw, output)
    body = f"=== LYNIS SNAPSHOT {ts} ===\\n{output}\\n\\n=== AI CHANGE ANALYSIS ===\\n{analysis}\\n"
    with open(os.path.join(LOG_DIR, fname), "w") as f:
        f.write(body)
    for old in files[:-3]:
        try:
            os.remove(old)
        except OSError:
            pass
    if prev_raw is not None:
        post_discord(f"**Lynis change analysis (SD fallback)** [{ts}] -- score {prev_score} -> {score}\\n{analysis}")
    print(f"Lynis {'changed' if prev_raw is not None else 'baseline'} -> {fname} (SD fallback, kept last 4 locally). score={score}")
    sys.exit(0)

# --- Drive path (keys configured) ---
def list_snapshots():
    q_parts = [f"name contains '{PREFIX}'", "trashed=false"]
    if PARENT_FOLDER:
        q_parts.append(f"'{PARENT_FOLDER}' in parents")
    r = drive("GET", "https://www.googleapis.com/drive/v3/files",
              params={"q": " and ".join(q_parts), "orderBy": "createdTime desc",
                      "fields": "files(id,name,createdTime)", "pageSize": 20})
    return r.json().get("files", []) if r.status_code == 200 else []

def download_text(fid):
    r = drive("GET", f"https://www.googleapis.com/drive/v3/files/{fid}", params={"alt": "media"})
    return r.text if r.status_code == 200 else ""

snaps = list_snapshots()
prev_score = None
prev_raw = None
if snaps:
    prev = download_text(snaps[0]["id"])
    prev_raw = _extract_output(prev)
    prev_score = lynis_score(prev_raw) if prev_raw else None
    if prev_score is not None and prev_score == score:
        print(f"Lynis unchanged -- no new version (score={score}, {len(snaps)} snapshots on Drive).")
        sys.exit(0)

analysis = run_ai_diff(prev_raw, output) if prev_raw is not None else "(baseline run -- first snapshot on Drive, nothing to diff against)"
body = f"=== LYNIS SNAPSHOT {ts} ===\\n{output}\\n\\n=== AI CHANGE ANALYSIS ===\\n{analysis}\\n"
meta = {"name": fname, "mimeType": "text/plain"}
if PARENT_FOLDER:
    meta["parents"] = [PARENT_FOLDER]
multipart = {"metadata": (fname + ".meta", json.dumps(meta), "application/json; charset=UTF-8"),
             "file": (fname, body, "text/plain")}
r = drive("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", files=multipart)
if r.status_code not in (200, 201):
    api_manager.queue_outage("gdrive", "upload", {"fname": fname, "body": body})
    print(f"FAILURE: Drive upload {r.status_code} ({r.text[:200]}) -- queued to outage buffer.")
    sys.exit(1)
file_id = r.json()["id"]

if os.path.exists(SHARE_EMAIL_FILE):
    email = open(SHARE_EMAIL_FILE).read().strip()
    if email:
        drive("POST", f"https://www.googleapis.com/drive/v3/files/{file_id}/permissions",
              json={"type": "user", "emailAddress": email, "role": "reader"})

to_delete = snaps[3:]
for old in to_delete:
    drive("DELETE", f"https://www.googleapis.com/drive/v3/files/{old['id']}")

if snaps:
    post_discord(f"**Lynis change analysis** [{ts}] -- score {prev_score} -> {score}\\n{analysis}")
print(f"Lynis {'changed' if snaps else 'baseline'} -> uploaded {fname} to Drive (score {prev_score} -> {score}); removed {len(to_delete)} old version(s).")
`,
};

export default entry;