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


def ping_alive(code, tk):
    """True=alive, False=dead (removed), None=transient API error (unknown)."""
    headers = {"Authorization": f"Bearer {tk}"} if tk else {}
    try:
        r = proxy_pool.get(f"https://api.gofile.io/contents/{code}", headers=headers, timeout=30)
        b = r.json()
    except Exception:
        return None
    status = b.get("status")
    if status == "ok":
        return True
    if isinstance(status, str) and "notfound" in status.lower().replace("-", "").replace("_", ""):
        return False
    # any other status (rate-limit, auth-needed, waiter, ...) -> unknown, don't
    # flip the alive/dead state and don't false-warn.
    return None


def resolve_direct(code, tk):
    headers = {"Authorization": f"Bearer {tk}"} if tk else {}
    try:
        r = proxy_pool.get(f"https://api.gofile.io/contents/{code}", headers=headers, timeout=30)
        b = r.json()
        if b.get("status") == "ok":
            d = b["data"]
            for k in ("directLink", "downloadPage", "url"):
                v = d.get(k) if isinstance(d, dict) else None
                if isinstance(v, str) and v.startswith("http") and "gofile.io/d/" not in v:
                    return v
    except Exception:
        pass
    p = proxy_pool.get(f"https://gofile.io/d/{code}", headers=UA, timeout=30)
    p.raise_for_status()
    m = (re.search(r'(https?://store-\d+\.gofile\.io/[^"\'<>\s]+)', p.text)
         or re.search(r'(https?://[a-z0-9.-]+\.gofile\.io/download/[^"\'<>\s]+)', p.text))
    if m:
        return m.group(1)
    raise RuntimeError("cannot resolve Gofile direct link (free scrape failed; premium needed?)")


def stream_and_hash(url):
    sha = hashlib.sha256()
    got = 0
    with requests.get(url, stream=True, timeout=120, headers=UA) as r:
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
            if prev_alive is None and "alive" not in s:
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
            url = None
            for attempt in range(2):
                try:
                    url = resolve_direct(code, tk)
                    break
                except Exception:
                    if attempt == 0:
                        time.sleep(3)
                        continue
                    raise
            sha, got = stream_and_hash(url)
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