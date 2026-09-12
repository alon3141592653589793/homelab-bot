#!/usr/bin/env python3
"""Show deploy status: when the GitHub repo was last updated and when /sync
last ran. Triggered by /syncinfo (alias /deployinfo).

Option A: the repo IS ~/secure-pi-bot (the bot code lives under src/lib/pi-bot/
and is mirrored to the runtime paths by /sync). There is no separate deploy dir
or .deploy_repo file anymore."""
import os
import json
import subprocess
from datetime import datetime

REPO_DIR = "/home/alon/secure-pi-bot"
STATE_FILE = os.path.join(REPO_DIR, ".deploy_state.json")


def git(args, timeout=10):
    try:
        r = subprocess.run(["git", "-C", REPO_DIR] + args, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


L = ["**/syncinfo**  " + datetime.now().strftime("%H:%M:%S")]
remote_url = git(["remote", "get-url", "origin"])
L.append("Repo: " + (remote_url or "(origin not set)"))

local_head = git(["rev-parse", "--short", "HEAD"])
last_subj = git(["log", "-1", "--format=%s"])
last_rel = git(["log", "-1", "--format=%cr"])
if local_head:
    L.append(f"Last commit (local): {local_head} | {last_subj or '?'}")
    if last_rel:
        L.append(f"  committed {last_rel} ago")
else:
    L.append("Last commit (local): (none -- not a clone?)")

if remote_url:
    try:
        r = subprocess.run(["git", "ls-remote", remote_url, "HEAD"], capture_output=True, text=True, timeout=12)
        if r.returncode == 0 and r.stdout:
            remote_head = r.stdout.split()[0][:7]
            if local_head and remote_head.startswith(local_head):
                L.append(f"Remote HEAD {remote_head}: repo matches local (up to date)")
            else:
                L.append(f"Remote HEAD {remote_head}: NEWER commits on GitHub since last /sync")
        else:
            L.append("Remote check: unavailable (offline / private repo)")
    except Exception:
        L.append("Remote check: timed out")

try:
    with open(STATE_FILE) as f:
        st = json.load(f)
except (OSError, ValueError):
    st = {}

if st:
    L.append(f"Last /sync run : {st.get('last_run', '?')}  [{st.get('last_run_mode', '?')}]")
    if st.get("last_apply"):
        L.append(f"Last apply    : {st['last_apply']}  ok={st.get('last_apply_ok')}")
else:
    L.append("Last /sync run : (never)")

print("\n".join(L))