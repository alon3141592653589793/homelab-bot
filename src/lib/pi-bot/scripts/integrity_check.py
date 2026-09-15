#!/usr/bin/env python3
"""Monthly script-integrity check vs GitHub (origin/main).

Verifies that every script file /sync deployed to the Pi runtime still
byte-matches the canonical version on GitHub. A file is flagged if its
on-disk content differs from origin/main, or if it is missing entirely.

Two ways to run:
  manual    /integrity  (reactive.py -> run_script)   prints a summary, always.
  scheduled cron 1st-of-month 03:30 with --post      prints to the log AND
            posts a warning to the ALERT channel ONLY on mismatch/unreachable.

The checked set = the files pi_deploy mirrors (main.py + scripts/ + modules/)
plus the root-owned files listed in deploy_manifest.txt -- i.e. exactly what
/sync deploys. .env / ~/.secrets / generated state are NEVER compared (they
legitimately differ locally).

Method: `git fetch origin main`, then for each deployed file
  git show origin/main:<repo-path>  -> sha256  vs  the on-disk runtime file.
State -> /dev/shm/pi-bot/.integrity_state.json (read by /parameters).
"""
import os
import sys
import json
import hashlib
import subprocess
from datetime import datetime

REPO_DIR = "/home/alon/secure-pi-bot"
PI_SRC = os.path.join(REPO_DIR, "src/lib/pi-bot")
MANIFEST = os.path.join(PI_SRC, "deploy_manifest.txt")
SHM = "/dev/shm/pi-bot"
STATE_FILE = os.path.join(SHM, ".integrity_state.json")
REF = "origin/main"
EXTS = (".py", ".sh")

sys.path.insert(0, os.path.join(REPO_DIR, "scripts"))


def _git_env():
    e = os.environ.copy()
    e["GIT_TERMINAL_PROMPT"] = "0"
    e["GCM_INTERACTIVE"] = "Never"
    return e


def git_text(args, timeout=15):
    try:
        return subprocess.run(["git", "-C", REPO_DIR] + args,
                              capture_output=True, text=True, env=_git_env(), timeout=timeout)
    except subprocess.TimeoutExpired:
        return None


def git_bytes(args, timeout=10):
    try:
        return subprocess.run(["git", "-C", REPO_DIR] + args,
                              capture_output=True, env=_git_env(), timeout=timeout)
    except subprocess.TimeoutExpired:
        return None


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def save_state(st):
    try:
        os.makedirs(SHM, exist_ok=True)
        with open(STATE_FILE, "w") as f:
            json.dump(st, f)
    except OSError:
        pass


def disp(p):
    if p.startswith(REPO_DIR + "/"):
        return "~/" + p[len(REPO_DIR) + 1:]
    return p


def load_manifest_pairs():
    """Root-owned (repo_src, abs_target) pairs from deploy_manifest.txt."""
    pairs = []
    if not os.path.exists(MANIFEST):
        return pairs
    try:
        with open(MANIFEST) as f:
            for line in f:
                line = line.rstrip("\n")
                if not line.strip() or line.lstrip().startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) == 2:
                    src, tgt = parts[0].strip(), parts[1].strip()
                    if tgt and tgt != "@crontab" and tgt.startswith("/"):
                        pairs.append((src, tgt))
    except OSError:
        pass
    return pairs


def collect_pairs():
    """(repo_path, runtime_path) for every deployed script file. Returns
    (pairs, ok) -- ok=False means we couldn't enumerate from origin/main."""
    pairs = []
    r = git_text(["ls-tree", "-r", "--name-only", REF,
                  "src/lib/pi-bot/main.py",
                  "src/lib/pi-bot/scripts",
                  "src/lib/pi-bot/modules"], timeout=15)
    if r is None or r.returncode != 0:
        return pairs, False
    for rp in r.stdout.splitlines():
        rp = rp.strip()
        if not rp or not rp.endswith(EXTS):
            continue
        rel = rp[len("src/lib/pi-bot/"):]  # main.py | scripts/x | modules/x
        pairs.append((rp, os.path.join(REPO_DIR, rel)))
    for src, tgt in load_manifest_pairs():
        if src.endswith(EXTS):
            pairs.append((src, tgt))
    return pairs, True


def compare(pairs):
    ok, divergent, missing = 0, [], []
    for repo_path, runtime_path in pairs:
        gc = git_bytes(["show", "{}:{}".format(REF, repo_path)], timeout=10)
        if gc is None or gc.returncode != 0:
            continue  # canonical version not on origin -- skip
        canon = hashlib.sha256(gc.stdout).hexdigest()[:12]
        try:
            with open(runtime_path, "rb") as f:
                on_disk = hashlib.sha256(f.read()).hexdigest()[:12]
        except OSError:
            missing.append(runtime_path)
            continue
        if on_disk != canon:
            divergent.append(runtime_path)
        else:
            ok += 1
    return ok, divergent, missing


def post_alert(text):
    try:
        import api_manager
        api_manager.rate_limit("discord")
    except Exception:
        pass
    from dotenv import load_dotenv
    try:
        import requests
    except ImportError:
        return False
    load_dotenv(os.path.join(REPO_DIR, ".env"))
    token = os.getenv("DISCORD_BOT_TOKEN")
    ch = os.getenv("ALERT_CHANNEL_ID")
    if not token or not ch:
        return False
    url = "https://discord.com/api/v10/channels/{}/messages".format(int(ch))
    hdr = {"Authorization": "Bot {}".format(token), "Content-Type": "application/json"}
    sent_ok = True
    for chunk in [text[i:i + 1900] for i in range(0, len(text), 1900)]:
        try:
            rr = requests.post(url, json={"content": chunk}, headers=hdr, timeout=10)
            if rr.status_code not in (200, 201):
                sent_ok = False
        except Exception:
            sent_ok = False
    try:
        import api_manager
        api_manager.record("discord", sent_ok)
    except Exception:
        pass
    return sent_ok


def main():
    post = "--post" in sys.argv
    ts = now_iso()

    fr = git_text(["fetch", "--quiet", "origin", "main"], timeout=20)
    if fr is None or fr.returncode != 0:
        msg = "[INTEGRITY] {} -- could NOT reach GitHub (fetch failed); check skipped.".format(ts)
        save_state({"last_run": ts, "result": "unreachable", "checked": 0,
                    "divergent": [], "missing": []})
        print(msg)
        if post:
            post_alert(msg)
        return

    pairs, ok_tree = collect_pairs()
    if not ok_tree or not pairs:
        msg = "[INTEGRITY] {} -- could not enumerate scripts from {}.".format(ts, REF)
        save_state({"last_run": ts, "result": "error", "checked": 0,
                    "divergent": [], "missing": []})
        print(msg)
        if post:
            post_alert(msg)
        return

    ok, divergent, missing = compare(pairs)
    total = len(pairs)

    if not divergent and not missing:
        save_state({"last_run": ts, "result": "ok", "checked": total,
                    "divergent": [], "missing": []})
        print("[INTEGRITY] {} -- all {} deployed script(s) match GitHub ({}).".format(ts, total, REF))
        return

    save_state({"last_run": ts, "result": "mismatch", "checked": total,
                "divergent": divergent, "missing": missing})
    lines = ["[INTEGRITY WARNING] {} -- {} of {} deployed script(s) differ from GitHub ({}):".format(
        ts, len(divergent) + len(missing), total, REF)]
    for p in divergent:
        lines.append("  ! modified: {}".format(disp(p)))
    for p in missing:
        lines.append("  x missing : {}".format(disp(p)))
    lines.append("Run /sync to re-deploy the canonical files from GitHub.")
    body = "\n".join(lines)
    print(body)
    if post:
        post_alert(body)


if __name__ == "__main__":
    main()