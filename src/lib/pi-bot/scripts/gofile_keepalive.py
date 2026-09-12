#!/usr/bin/env python3
"""
Keep-alive + integrity re-check for gofile-mirrored model files.

  - Streams each mirrored file from Gofile to /dev/null (NOT to disk) so:
      (1) it counts as download traffic -> resets Gofile free-tier inactivity
          deletion (free files die after ~10-30 days without a download).
      (2) we re-hash the bytes and compare to the manifest sha256 -> catches
          corruption / swap on Gofile's side.

Free-tier note: Gofile's content-listing API is premium-only, so resolving the
direct download URL is best-effort (premium API first, then a share-page
scrape). If the scrape can't find the link, go Premium.

Run:
  python3 gofile_keepalive.py            # verify + traffic one pass
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

MANIFEST_FILE = "/home/alon/secure-pi-bot/gofile_mirror/manifest.json"
TOKEN_FILE = os.path.expanduser("~/.secrets/gofile_token")
CHUNK = 1024 * 1024
UA = {"User-Agent": "Mozilla/5.0"}


def load_token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


def resolve_direct(code, tk):
    """Return a direct download URL for content 'code'. Premium API first;
    fall back to scraping the share page for a store-*.gofile.io link."""
    headers = {"Authorization": f"Bearer {tk}"} if tk else {}
    try:
        r = requests.get(f"https://api.gofile.io/contents/{code}", headers=headers, timeout=30)
        b = r.json()
        if b.get("status") == "ok":
            d = b["data"]
            for k in ("directLink", "downloadPage", "url"):
                v = d.get(k) if isinstance(d, dict) else None
                if isinstance(v, str) and v.startswith("http") and "gofile.io/d/" not in v:
                    return v
    except Exception:
        pass
    # Free fallback: scrape the share page HTML for a store-* CDN url.
    p = requests.get(f"https://gofile.io/d/{code}", headers=UA, timeout=30)
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


def main():
    if not os.path.exists(MANIFEST_FILE):
        print("No mirror manifest yet. Run gofile_mirror.py first.")
        return
    with open(MANIFEST_FILE) as f:
        manifest = json.load(f)
    tk = load_token()
    any_fail = False
    for key, m in manifest.items():
        try:
            url = resolve_direct(m["gofile_code"], tk)
            sha, got = stream_and_hash(url)
            ok = (sha == m["sha256"])
            m["last_verified"] = dt.datetime.now().isoformat(timespec="seconds")
            m["downloads"] = int(m.get("downloads", 0)) + 1
            tag = "OK" if ok else "MISMATCH"
            print(f"{key}: pulled {got/1e6:.1f}MB  sha {tag}  download #{m['downloads']}")
            if not ok:
                any_fail = True
                print(f"  INTEGRITY FAIL: stored {sha[:12]}... != manifest {m['sha256'][:12]}...; re-run gofile_mirror.py to re-mirror.")
        except Exception as e:
            print(f"{key}: keep-alive FAILED -> {e}")
            any_fail = True
    with open(MANIFEST_FILE, "w") as f:
        json.dump(manifest, f, indent=2)
    print("keepalive done." + (" Issues above." if any_fail else " All verified."))


if __name__ == "__main__":
    main()