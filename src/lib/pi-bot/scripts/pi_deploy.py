#!/usr/bin/env python3
"""Self-deploy (Option A): the repo IS the source of truth.

The bot's real .py files live in the repo under src/lib/pi-bot/ (mirroring the
Pi runtime layout: main.py, scripts/, modules/). /sync does:

  1. git fetch + reset --hard origin/main   (pull the latest repo)
  2. mirror src/lib/pi-bot/{main.py,scripts,modules} -> ~/secure-pi-bot/...
  3. install root-owned files from deploy_manifest.txt (only changed ones)
  4. reboot so the bot reloads the new code

One repo, one path. .env and untracked files are never deleted (git reset --hard
only touches tracked files; the mirror only writes main.py/scripts/modules).

Usage:
  python3 pi_deploy.py               # pull, mirror, install root, REBOOT
  python3 pi_deploy.py --no-reboot   # same, no reboot
  python3 pi_deploy.py --dry-run     # fetch + show what would change, no write
"""
import os
import sys
import json
import shutil
import hashlib
import subprocess
import tempfile
from datetime import datetime

REPO_DIR = "/home/alon/secure-pi-bot"
PI_SRC = os.path.join(REPO_DIR, "src/lib/pi-bot")
MANIFEST = os.path.join(PI_SRC, "deploy_manifest.txt")
SHM = "/dev/shm/pi-bot"
ROOT_LIST = os.path.join(SHM, ".deploy_root_list")
STATE_FILE = os.path.join(REPO_DIR, ".deploy_state.json")
REF = "origin/main"

# runtime targets (mirrored from repo src/lib/pi-bot -> repo root)
MIRRORS = [("main.py", "main.py"), ("scripts", "scripts"), ("modules", "modules")]


def write_state(upd):
    try:
        st = {}
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                st = json.load(f)
        st.update(upd)
        with open(STATE_FILE, "w") as f:
            json.dump(st, f)
    except OSError:
        pass


def git(args, check=True):
    # Never prompt interactively -- the bot runs /sync with no tty.
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "Never"
    return subprocess.run(["git", "-C", REPO_DIR] + args, check=check,
                          capture_output=True, text=True, env=env)


def fhash(p):
    try:
        with open(p, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:12]
    except OSError:
        return "(missing)"


def collect_runtime_hashes():
    h = {}
    for rel in ["main.py"]:
        p = os.path.join(REPO_DIR, rel)
        if os.path.exists(p):
            h[rel] = fhash(p)
    for sub in ["scripts", "modules"]:
        d = os.path.join(REPO_DIR, sub)
        if os.path.isdir(d):
            for root, _, files in os.walk(d):
                if "__pycache__" in root:
                    continue
                for fn in files:
                    if fn.endswith((".py", ".sh")):
                        p = os.path.join(root, fn)
                        h[os.path.relpath(p, REPO_DIR)] = fhash(p)
    return h


def mirror_tree(src_dir, dst_dir):
    for name in os.listdir(src_dir):
        s = os.path.join(src_dir, name)
        d = os.path.join(dst_dir, name)
        if os.path.isdir(s):
            if not os.path.exists(d):
                os.makedirs(d)
            mirror_tree(s, d)
        elif os.path.isfile(s):
            if not os.path.exists(dst_dir):
                os.makedirs(dst_dir)
            shutil.copy2(s, d)


def _rel_set(src_dir, exts=(".py", ".sh")):
    """Relative paths of tracked-script files under src_dir."""
    out = set()
    if not os.path.isdir(src_dir):
        return out
    for root, _, files in os.walk(src_dir):
        if "__pycache__" in root:
            continue
        for fn in files:
            if fn.endswith(exts):
                p = os.path.join(root, fn)
                out.add(os.path.relpath(p, src_dir))
    return out


def prune_tree(src_dir, dst_dir):
    """Remove .py/.sh files in dst_dir that no longer exist in src_dir.
    Only touches script files (never logs, __pycache__, .env, etc.).
    Returns a sorted list of removed relative paths."""
    removed = []
    expected = _rel_set(src_dir)
    if not os.path.isdir(dst_dir):
        return removed
    for root, _, files in os.walk(dst_dir):
        if "__pycache__" in root:
            continue
        for fn in files:
            if not fn.endswith((".py", ".sh")):
                continue
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, dst_dir)
            if rel not in expected:
                try:
                    os.remove(p)
                    removed.append(rel)
                except OSError:
                    pass
    # sweep up directories that are now empty (bottom-up), but never dst_dir itself
    for root, dirs, files in os.walk(dst_dir, topdown=False):
        if root == dst_dir or "__pycache__" in root:
            continue
        if not dirs and not files:
            try:
                os.rmdir(root)
            except OSError:
                pass
    return sorted(removed)


def load_manifest():
    items = []
    if not os.path.exists(MANIFEST):
        return items
    with open(MANIFEST) as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) == 2:
                items.append((parts[0].strip(), parts[1].strip()))
    return items


def main():
    no_reboot = "--no-reboot" in sys.argv
    dry_run = "--dry-run" in sys.argv

    if not os.path.isdir(os.path.join(REPO_DIR, ".git")):
        print("FAILURE: ~/secure-pi-bot is not a git clone.")
        sys.exit(1)
    if not os.path.isdir(PI_SRC):
        print("FAILURE: src/lib/pi-bot not found -- is origin pointing at the homelab-bot repo?")
        sys.exit(1)

    # safety: never let a tracked .env get overwritten by reset --hard
    r = git(["ls-files", "--error-unmatch", ".env"], check=False)
    if r.returncode == 0:
        print("FAILURE: .env is tracked in the repo -- reset --hard would wipe live secrets.")
        print("Add .env to .gitignore, commit, push, then /sync again.")
        sys.exit(1)

    mode = "dry-run" if dry_run else ("pull (no-reboot)" if no_reboot else "pull + reboot")
    write_state({"last_run": datetime.now().isoformat(timespec="seconds"), "last_run_mode": mode})

    try:
        git(["fetch", "--force", "origin"])
    except subprocess.CalledProcessError as e:
        print("FAILURE: git fetch failed (auth or network).")
        print("  " + (e.stderr or "").strip())
        sys.exit(1)
    git(["remote", "set-head", "origin", "-a"], check=False)

    diff = git(["diff", "--name-only", "HEAD.." + REF], check=False)
    changed = [ln for ln in diff.stdout.splitlines() if ln.strip()]

    if dry_run:
        print("[DRY-RUN] commits since HEAD:")
        r = git(["log", "--oneline", "HEAD.." + REF], check=False)
        print(r.stdout.strip() or "(none -- already up to date)")
        if changed:
            print("[DRY-RUN] repo files changed (" + str(len(changed)) + "):")
            for c in changed:
                print("  - " + c)
        else:
            print("[DRY-RUN] repo already up to date.")
        print("[DRY-RUN] nothing written.")
        return

    old_hashes = collect_runtime_hashes()
    git(["reset", "--hard", REF])
    print("Updated repo to " + REF)

    # mirror src/lib/pi-bot -> runtime (repo root)
    print("Mirroring src/lib/pi-bot -> ~/secure-pi-bot ...")
    for src_rel, dst_rel in MIRRORS:
        s = os.path.join(PI_SRC, src_rel)
        d = os.path.join(REPO_DIR, dst_rel)
        if os.path.isdir(s):
            if not os.path.exists(d):
                os.makedirs(d)
            mirror_tree(s, d)
            rm = prune_tree(s, d)
            for rel in rm:
                print("  - " + os.path.join(dst_rel, rel) + "  (removed)")
        elif os.path.isfile(s):
            shutil.copy2(s, d)
    print("Mirrored main.py, scripts/, modules/.")

    new_hashes = collect_runtime_hashes()
    n = 0
    for rel in sorted(set(list(old_hashes.keys()) + list(new_hashes.keys()))):
        oh = old_hashes.get(rel, "(new)")
        nh = new_hashes.get(rel, "(removed)")
        if oh != nh:
            print("  + " + rel + "  " + oh + " -> " + nh)
            n += 1
    print(str(n) + " runtime file(s) changed.")

    # install root-owned files from manifest (only those changed in the pull)
    manifest = load_manifest()
    changed_set = set(changed)
    root_changed = [(s, t) for (s, t) in manifest if s in changed_set]
    root_failed = False
    if not manifest:
        print("No deploy_manifest.txt -- skipping root installs.")
    elif not root_changed:
        print("No root-owned files changed (" + str(len(manifest)) + " listed).")
    else:
        os.makedirs(SHM, exist_ok=True)
        with open(ROOT_LIST, "w") as lf:
            for s, t in root_changed:
                lf.write(s + "\t" + t + "\n")
        print("Installing root files (" + str(len(root_changed)) + "):")
        r = subprocess.run(["sudo", "-n", "/usr/local/bin/pi_deploy_root", REPO_DIR, ROOT_LIST],
                           capture_output=True, text=True, timeout=120)
        print((r.stdout or "").strip())
        if r.returncode != 0:
            root_failed = True
            print("ROOT INSTALL FAILED (exit " + str(r.returncode) + "): " + (r.stderr or "").strip())

    write_state({"last_apply": datetime.now().isoformat(timespec="seconds"), "last_apply_ok": not root_failed})

    if root_failed:
        print("Aborting reboot -- fix the root install error and /sync again.")
        return

    # Apply crontab as alon (no root needed -- crontab(1) for your own user
    # needs no sudo). Always applied (idempotent); crontab(1) requires a
    # trailing newline so normalize it. Moved out of the root installer so a
    # crontab update never has to overwrite /usr/local/bin/pi_deploy_root.
    cron_src = os.path.join(REPO_DIR, "src/lib/pi-bot/crontab.txt")
    if os.path.isfile(cron_src):
        with open(cron_src) as f:
            cron = f.read()
        if not cron.strip():
            print("crontab.txt is empty -- skipping crontab apply.")
        else:
            if not cron.endswith("\n"):
                cron += "\n"
            fd, tmpc = tempfile.mkstemp(suffix=".cron")
            try:
                with os.fdopen(fd, "w") as tf:
                    tf.write(cron)
                r = subprocess.run(["crontab", tmpc], capture_output=True, text=True, timeout=30)
                if r.returncode == 0:
                    print("Applied crontab (alon).")
                else:
                    print("Crontab apply FAILED: " + (r.stderr or "").strip())
            finally:
                try:
                    os.unlink(tmpc)
                except OSError:
                    pass

    if no_reboot:
        print("Skipping reboot (--no-reboot). Restart the bot by hand to load the new code.")
    else:
        # Drop a flag so main.py announces "scripts loaded" when the bot comes back.
        try:
            open(os.path.expanduser("~/secure-pi-bot/.reboot_notify"), "w").close()
        except OSError:
            pass
        print("Rebooting in 3s...")
        subprocess.Popen(["sh", "-c", "sleep 3; systemctl reboot"], start_new_session=True)


if __name__ == "__main__":
    main()