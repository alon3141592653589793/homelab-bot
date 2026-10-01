#!/usr/bin/env python3
"""Keep-alive + integrity + liveness watch for gofile-mirrored files (cron, 6h).

Three jobs in one pass:

  1. LIVENESS (ALL manifest entries): ping the Gofile content API for each
     file's code. Warn Discord on a NEW death (alive -> dead) and on recovery.
     This catches files that died unnoticed (Gofile purge, inactivity, takedown)
     -- including mirrors you never opted into keep-alive.

  2. KEEP-ALIVE (opted-in entries only): stream the file from Gofile to /dev/null
     so it counts as a download -> resets Gofile free-tier inactivity deletion,
     and re-hash the bytes vs the manifest sha256 -> catches corruption/swap.

  3. WARN: post new deaths, integrity mismatches, and keep-alive resolve
     failures to Discord. Each is state-tracked (state file in /dev/shm) so it
     warns ONCE per transition, not every 6h.

Gofile download resolution (FREE, no premium, no payment):
  Gofile now requires a website token (`wt`, parsed from gofile.io/dist/js/alljs.js)
  on the content API, plus a bearer token (your stored account token, or a free
  anonymous guest token from POST /accounts). The download link itself needs an
  `accountToken` cookie. All API calls go through proxy_pool (rotating exit IPs)
  so the home IP isn't fingerprinted; the large file download is direct (free
  proxies can't carry multi-GB streams reliably). Guest token + wt are cached in
  /dev/shm and refreshed only on failure.

Opt-in list: ~/.secrets/gofile_keep.txt -- one HF repo or direct source URL per
line. Successful mirrors auto-add themselves (gofile_mirror.py). Manage with
  /gofile keep <ref|URL> | /gofile forget <ref|URL> | /gofile keeplist.

Run:
  python3 gofile_keepalive.py            # cron every 6h
"""
import os
import re
import sys
import json
import time
import hashlib
import datetime as dt

try:
    import requests
except ImportError:
    print("FAILURE: requests missing. pip3 install --user requests")
    sys.exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv("/home/alon/secure-pi-bot/.env")
except Exception:
    pass

import proxy_pool

BOT_DIR = "/home/alon/secure-pi-bot"
MANIFEST_FILE = f"{BOT_DIR}/gofile_mirror/manifest.json"
TOKEN_FILE = os.path.expanduser("~/.secrets/gofile_token")
KEEP_FILE = os.path.expanduser("~/.secrets/gofile_keep.txt")
STATE_FILE = "/dev/shm/pi-bot/gofile_keepalive_state.json"
SHM = "/dev/shm/pi-bot"
GUEST_TOKEN_FILE = f"{SHM}/gofile_guest_token"
WT_FILE = f"{SHM}/gofile_wt"
CHUNK = 1024 * 1024
UA = {"User-Agent": "Mozilla/5.0"}
os.makedirs(SHM, exist_ok=True)

BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "")
try:
    CHANNEL_ID = int(os.getenv("REPORT_CHANNEL_ID", "0"))
except ValueError:
    CHANNEL_ID = 0


def load_token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


def discord_post(text):
    if not BOT_TOKEN or not CHANNEL_ID:
        return
    url = f"https://discord.com/api/v10/channels/{CHANNEL_ID}/messages"
    hdr = {"Authorization": f"Bot {BOT_TOKEN}", "Content-Type": "application/json"}
    for chunk in [text[i:i + 1900] for i in range(0, len(text), 1900)]:
        try:
            requests.post(url, json={"content": chunk}, headers=hdr, timeout=10)
        except Exception:
            pass


def load_keep():
    keep = set()
    try:
        with open(KEEP_FILE) as f:
            keep = {l.strip() for l in f if l.strip() and not l.startswith("#")}
    except OSError:
        pass
    return keep


def is_kept(m, keep):
    return (m.get("repo") in keep) or (m.get("source_url") in keep)


# --- Gofile free download-resolution flow (no premium, no payment) ---

def _get_guest_token(force=False):
    """Free anonymous guest account token (POST /accounts). Cached in /dev/shm."""
    if not force:
        try:
            with open(GUEST_TOKEN_FILE) as f:
                t = f.read().strip()
            if t:
                return t
        except OSError:
            pass
    try:
        r = requests.post("https://api.gofile.io/accounts", headers=UA, timeout=30)
        b = r.json()
        t = (b.get("data") or {}).get("token") if isinstance(b, dict) else None
        if t:
            with open(GUEST_TOKEN_FILE, "w") as f:
                f.write(t)
            return t
    except Exception:
        pass
    return None


def _refresh_website_token():
    """wt is embedded in gofile.io/dist/js/alljs.js as: var fetchData = { wt: "..." }"""
    try:
        r = proxy_pool.get("https://gofile.io/dist/js/alljs.js", headers=UA, timeout=30)
        m = re.search(r'fetchData\s*=\s*\{\s*wt:\s*"([^"]+)"', r.text)
        if m:
            wt = m.group(1)
            with open(WT_FILE, "w") as f:
                f.write(wt)
            return wt
    except Exception:
        pass
    return None


def _get_website_token():
    try:
        with open(WT_FILE) as f:
            wt = f.read().strip()
        if wt:
            return wt
    except OSError:
        pass
    return _refresh_website_token()


def _content_call(code, token, wt):
    try:
        r = proxy_pool.get(
            f"https://api.gofile.io/contents/{code}?wt={wt}&cache=true",
            headers={"Authorization": f"Bearer {token}", **UA},
            timeout=30,
        )
        return r.json()
    except Exception:
        return None


def _content_info(code, tk):
    """Return (body, token) from the Gofile content API using the free
    guest-token + website-token flow. `body` is the parsed JSON (ok or last
    error) or None on network failure. `token` is the bearer used (for the
    download cookie). No premium needed."""
    token = tk or _get_guest_token()
    wt = _get_website_token()
    last = None
    # attempt 1: cached token + cached wt
    if token and wt:
        last = _content_call(code, token, wt)
        if last and last.get("status") == "ok":
            return last, token
    # attempt 2: refresh wt (it rotates)
    wt = _refresh_website_token()
    if token and wt:
        last = _content_call(code, token, wt)
        if last and last.get("status") == "ok":
            return last, token
    # attempt 3: guest token may have expired -> mint a fresh one
    if not tk:
        token = _get_guest_token(force=True)
        if token and wt:
            last = _content_call(code, token, wt)
            if last and last.get("status") == "ok":
                return last, token
    return last, token


def ping_alive(code, tk):
    """True=alive, False=dead (removed), None=transient API error (unknown)."""
    b, _ = _content_info(code, tk)
    if b is None:
        return None
    if b.get("status") == "ok":
        return True
    data = b.get("data") or {}
    if isinstance(data, dict) and data.get("notFound"):
        return False
    st = str(b.get("status", "")).lower().replace("-", "").replace("_", "")
    if "notfound" in st:
        return False
    # rate-limit / auth / waiter / ... -> unknown, don't flip alive/dead or warn
    return None


def resolve_direct(code, tk, filename=None):
    """Resolve a free download URL for the file. Returns (url, token). Raises
    if the file is dead or Gofile changed its flow."""
    b, token = _content_info(code, tk)
    if not b or b.get("status") != "ok":
        raise RuntimeError("Gofile content API failed (free guest+wt flow); file may be dead or Gofile changed its API")
    data = b.get("data") or {}
    children = data.get("children") or []
    if isinstance(children, dict):
        children = list(children.values())
    if not children:
        raise RuntimeError("Gofile content has no files")
    pick = next((c for c in children if filename and c.get("name") == filename), None) or children[0]
    link = pick.get("link")
    if not link:
        raise RuntimeError("Gofile file has no download link")
    return link, token


def stream_and_hash(url, token=None):
    sha = hashlib.sha256()
    got = 0
    headers = dict(UA)
    if token:
        headers["Cookie"] = f"accountToken={token}"
    with requests.get(url, stream=True, timeout=120, headers=headers) as r:
        r.raise_for_status()
        for chunk in r.iter_content(chunk_size=CHUNK):
            if chunk:
                sha.update(chunk)
                got += len(chunk)
    return sha.hexdigest(), got


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(st):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(st, f, indent=2)
    except OSError:
        pass


def main():
    if not os.path.exists(MANIFEST_FILE):
        print("No mirror manifest yet. Run gofile_mirror.py first.")
        return
    with open(MANIFEST_FILE) as f:
        manifest = json.load(f)
    if not manifest:
        print("Manifest is empty. Nothing mirrored yet.")
        return
    tk = load_token()
    keep = load_keep()
    state = load_state()
    now = dt.datetime.now().isoformat(timespec="seconds")
    warnings = []

    # --- 1. LIVENESS ping for ALL entries (cheap; catches unnoticed deaths) ---
    for key, m in manifest.items():
        code = m.get("gofile_code")
        if not code:
            continue
        alive = ping_alive(code, tk)
        s = state.setdefault(code, {})
        prev_alive = s.get("alive")
        if alive is True:
            if prev_alive is False:
                warnings.append(f"✅ Recovered: {key} [{code}] is alive again on Gofile.")
            s["alive"] = True
        elif alive is False:
            if prev_alive is not False:
                warnings.append(
                    f"⚠️ Gofile file DIED: {key} [{code}] -- no longer on Gofile "
                    f"(purged/inactivity/takedown). Re-mirror with  /gofile  to restore."
                )
            s["alive"] = False
        else:
            # transient API error: keep the previous alive/dead state, don't warn
            if "alive" not in s:
                s["alive"] = None

    # --- 2. KEEP-ALIVE stream + integrity for opted-in entries only ---
    for key, m in manifest.items():
        if not is_kept(m, keep):
            continue
        code = m.get("gofile_code")
        if not code:
            continue
        # if liveness already says dead, skip the stream (saves bandwidth + errors)
        if state.get(code, {}).get("alive") is False:
            continue
        try:
            url, dl_token = resolve_direct(code, tk, m.get("file"))
            sha, got = stream_and_hash(url, dl_token)
            ok = (sha == m.get("sha256"))
            m["last_verified"] = now
            m["downloads"] = int(m.get("downloads", 0)) + 1
            s = state.setdefault(code, {})
            if ok:
                print(f"{key}: pulled {got/1e6:.1f}MB  sha OK  download #{m['downloads']}")
                if s.get("mismatch"):
                    warnings.append(f"✅ Integrity restored: {key} [{code}] sha256 matches again.")
                    s["mismatch"] = False
                if s.get("keep_fail"):
                    s["keep_fail"] = False  # resolved OK -> keep-alive healthy
            else:
                print(f"{key}: INTEGRITY MISMATCH (stored {sha[:12]}... != manifest {m['sha256'][:12]}...)")
                if not s.get("mismatch"):
                    warnings.append(
                        f"⚠️ Integrity mismatch: {key} [{code}] -- Gofile bytes don't match "
                        f"the manifest sha256 (corrupted/swapped). Re-mirror with  /gofile."
                    )
                    s["mismatch"] = True
        except Exception as e:
            print(f"{key}: keep-alive stream FAILED -> {e}")
            s = state.setdefault(code, {})
            if not s.get("keep_fail"):
                warnings.append(
                    f"⚠️ Keep-alive can't reach {key} [{code}] -- resolve/download failed "
                    f"({str(e)[:80]}). It may die from inactivity if this persists."
                )
                s["keep_fail"] = True

    save_state(state)
    try:
        with open(MANIFEST_FILE, "w") as f:
            json.dump(manifest, f, indent=2)
    except OSError:
        pass

    if warnings:
        discord_post(f"**[Gofile watch]** {now}\n" + "\n".join(warnings))
        print("\n".join(warnings))
    print("keepalive done." + (" Issues above." if warnings else " All verified."))


if __name__ == "__main__":
    main()