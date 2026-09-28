#!/usr/bin/env python3
"""Check which Gofile-mirrored files are still alive (no download).

Reads gofile_mirror/manifest.json and pings the Gofile content API for each
entry's gofile_code. Prints alive / dead / unknown counts + per-file status.
Used by the Discord  /gofile check  command.
"""
import os
import sys
import json

try:
    import requests
except ImportError:
    print("FAILURE: requests missing. pip3 install --user requests")
    sys.exit(1)

import proxy_pool

MANIFEST_FILE = "/home/alon/secure-pi-bot/gofile_mirror/manifest.json"
TOKEN_FILE = os.path.expanduser("~/.secrets/gofile_token")


def load_token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


def check_code(code, tk):
    """True = alive, False = dead/removed, None = API error (unknown)."""
    headers = {"Authorization": f"Bearer {tk}"} if tk else {}
    try:
        r = proxy_pool.get(f"https://api.gofile.io/contents/{code}",
                           headers=headers, timeout=30)
        b = r.json()
        return b.get("status") == "ok"
    except Exception:
        return None


def _fmt_size(n):
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "?"
    if n >= 1e9:
        return f"{n/1e9:.1f}GB"
    if n >= 1e6:
        return f"{n/1e6:.1f}MB"
    if n >= 1e3:
        return f"{n/1e3:.0f}KB"
    return f"{n:.0f}B"


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
    alive, dead, unknown = [], [], []
    for key, m in manifest.items():
        code = m.get("gofile_code")
        if not code:
            unknown.append(f"{key}  (no gofile_code in manifest)")
            continue
        line = f"{key}  [{code}]  {_fmt_size(m.get('size'))}  last verified: {m.get('last_verified', 'never')}"
        res = check_code(code, tk)
        if res is True:
            alive.append(line)
        elif res is False:
            dead.append(line)
        else:
            unknown.append(line)
    out = [f"=== Gofile mirror status ({len(manifest)} entries) ===",
           f"ALIVE: {len(alive)} | DEAD: {len(dead)} | UNKNOWN: {len(unknown)}"]
    if alive:
        out.append("\n-- ALIVE --")
        out.extend(alive)
    if dead:
        out.append("\n-- DEAD (re-mirror with /gofile) --")
        out.extend(dead)
    if unknown:
        out.append("\n-- UNKNOWN (API error; retry later) --")
        out.extend(unknown)
    print("\n".join(out))


if __name__ == "__main__":
    main()