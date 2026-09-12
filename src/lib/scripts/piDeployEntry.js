const entry = {
  id: "pi-deploy",
  filename: "pi_deploy.py",
  path: "~/secure-pi-bot/scripts/pi_deploy.py",
  description: "Self-deploy: pull the existing secure-pi-bot repo into ~/secure-pi-bot, VERIFY every change by sha256 hash, report old->new hash for each updated file, THEN install any root-owned files listed in deploy_manifest.txt that changed in the pull (via pi_deploy_root.sh), then reboot. One repo, one path -- git fetch + reset --hard to origin/<branch>. .env and untracked files are never deleted (aborts if .env is tracked). Triggered by Discord /sync (or /sync no-reboot / /sync dry-run). Records state for /syncinfo.",
  tags: ["deploy", "github", "sync", "self-update", "reboot", "verify", "root"],
  code: `#!/usr/bin/env python3
"""
Self-deploy: pull the existing secure-pi-bot repo into ~/secure-pi-bot, verify
every change by sha256 hash, install any root-owned files listed in
deploy_manifest.txt that changed in the pull (via pi_deploy_root.sh), then
reboot so the bot reloads the new code.

One repo, one path -- this is just a git pull of your existing project repo.
Files that need to live OUTSIDE ~/secure-pi-bot (/usr/local/bin/*, /etc/...,
crontab) are listed in ~/secure-pi-bot/deploy_manifest.txt; only the ones that
CHANGED in the pull are reinstalled (idempotent + safe). .env and other
untracked files are never deleted (git reset --hard only touches tracked files).

Config (one line each):
  ~/secure-pi-bot/.deploy_repo    -> git URL of the existing repo
  ~/secure-pi-bot/.deploy_branch  -> branch (optional; default = repo default)

Usage:
  python3 pi_deploy.py               # pull, verify, install root, REBOOT
  python3 pi_deploy.py --no-reboot   # same, no reboot
  python3 pi_deploy.py --dry-run     # fetch + show what would change, no write
"""
import os
import sys
import json
import hashlib
import subprocess
from datetime import datetime

DEPLOY_DIR = "/home/alon/secure-pi-bot"
REPO_FILE = os.path.join(DEPLOY_DIR, ".deploy_repo")
BRANCH_FILE = os.path.join(DEPLOY_DIR, ".deploy_branch")
STATE_FILE = os.path.join(DEPLOY_DIR, ".deploy_state.json")
MANIFEST = os.path.join(DEPLOY_DIR, "deploy_manifest.txt")
SHM = "/dev/shm/pi-bot"
ROOT_LIST = os.path.join(SHM, ".deploy_root_list")


def write_state(update):
    try:
        st = {}
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                st = json.load(f)
        st.update(update)
        with open(STATE_FILE, "w") as f:
            json.dump(st, f)
    except OSError:
        pass


def read_cfg(path, default=None):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def git(args, check=True):
    return subprocess.run(["git", "-C", DEPLOY_DIR] + args, check=check,
                          capture_output=True, text=True)


def resolve_ref():
    branch = read_cfg(BRANCH_FILE)
    if branch:
        return "origin/" + branch
    r = git(["symbolic-ref", "refs/remotes/origin/HEAD"], check=False)
    if r.returncode == 0 and r.stdout.strip():
        return r.stdout.strip().replace("refs/remotes/", "")
    return "origin/main"


def fhash(rel):
    p = os.path.join(DEPLOY_DIR, rel)
    try:
        with open(p, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:12]
    except OSError:
        return "(missing)"


def load_manifest():
    items = []
    if not os.path.exists(MANIFEST):
        return items
    with open(MANIFEST) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 1)
            if len(parts) == 2:
                items.append((parts[0], parts[1]))
    return items


def main():
    no_reboot = "--no-reboot" in sys.argv
    dry_run = "--dry-run" in sys.argv
    repo = read_cfg(REPO_FILE)
    if not repo:
        print("FAILURE: set the repo URL first:")
        print("  echo 'https://github.com/you/secure-pi-bot.git' > ~/secure-pi-bot/.deploy_repo")
        sys.exit(1)

    # Turn the dir into a clone if it isn't one yet (preserves untracked files).
    if not os.path.isdir(os.path.join(DEPLOY_DIR, ".git")):
        git(["init"], check=False)
    r = git(["remote", "get-url", "origin"], check=False)
    if r.returncode != 0:
        git(["remote", "add", "origin", repo], check=False)
    elif r.stdout.strip() != repo:
        git(["remote", "set-url", "origin", repo], check=False)

    # Safety: never let a tracked .env get overwritten (would wipe live secrets).
    r = git(["ls-files", "--error-unmatch", ".env"], check=False)
    if r.returncode == 0:
        print("FAILURE: .env is tracked in the repo -- git reset --hard would overwrite your live secrets.")
        print("Add .env to .gitignore, commit, push, then /sync again.")
        sys.exit(1)

    mode = "dry-run" if dry_run else ("pull (no-reboot)" if no_reboot else "pull + reboot")
    write_state({"last_run": datetime.now().isoformat(timespec="seconds"), "last_run_mode": mode})

    git(["fetch", "--force", "origin"])
    git(["remote", "set-head", "origin", "-a"], check=False)
    ref = resolve_ref()

    # Capture which tracked files differ between current HEAD and the remote ref.
    diff = git(["diff", "--name-only", "HEAD.." + ref], check=False)
    changed = [ln for ln in diff.stdout.splitlines() if ln.strip()]

    # Manifest: root-owned files to install outside ~/secure-pi-bot.
    manifest = load_manifest()
    changed_set = set(changed)
    root_changed = [(s, t) for (s, t) in manifest if s in changed_set]

    if dry_run:
        print("[DRY-RUN] new commits since last sync:")
        r = git(["log", "--oneline", "HEAD.." + ref], check=False)
        print(r.stdout.strip() or "(none -- already up to date)")
        if changed:
            print("[DRY-RUN] user files that would change (" + str(len(changed)) + "):")
            for rel in changed:
                print("  - " + rel + "  (current hash: " + fhash(rel) + ")")
        else:
            print("[DRY-RUN] no user files would change.")
        if root_changed:
            print("[DRY-RUN] root-owned files that would be installed (" + str(len(root_changed)) + "):")
            for s, t in root_changed:
                print("  - " + s + " -> " + t)
        print("[DRY-RUN] nothing written.")
        return

    # Snapshot current hashes of the user files that will change, THEN apply.
    old_hashes = {rel: fhash(rel) for rel in changed}
    git(["reset", "--hard", ref])
    print("Updated " + DEPLOY_DIR + " to " + ref)

    # Verify: report old -> new hash for every user file that was supposed to change.
    if changed:
        print("Hash verification (" + str(len(changed)) + " user file(s) diff vs HEAD):")
        actually = 0
        for rel in changed:
            oh = old_hashes[rel]
            nh = fhash(rel)
            if oh == nh:
                print("  = " + rel + "  " + oh + " (no change)")
            else:
                print("  + " + rel + "  " + oh + " -> " + nh)
                actually += 1
        print(str(actually) + "/" + str(len(changed)) + " user files actually changed on disk.")
    else:
        print("No user files changed (already up to date).")

    # --- Install root-owned files listed in the manifest (only changed ones) ---
    root_failed = False
    if not manifest:
        print("No deploy_manifest.txt -- skipping root-owned installs.")
    elif not root_changed:
        print("No root-owned files in the manifest changed (" + str(len(manifest)) + " listed).")
    else:
        os.makedirs(SHM, exist_ok=True)
        with open(ROOT_LIST, "w") as lf:
            for s, t in root_changed:
                lf.write(s + "\\t" + t + "\\n")
        print("Installing root-owned files (" + str(len(root_changed)) + "):")
        r = subprocess.run(["sudo", "-n", "/usr/local/bin/pi_deploy_root", DEPLOY_DIR, ROOT_LIST],
                           capture_output=True, text=True, timeout=120)
        print((r.stdout or "").strip())
        if r.returncode != 0:
            root_failed = True
            print("ROOT INSTALL FAILED (exit " + str(r.returncode) + "): " + (r.stderr or "").strip())

    write_state({"last_apply": datetime.now().isoformat(timespec="seconds"), "last_apply_ok": not root_failed})

    if root_failed:
        print("Aborting reboot -- fix the root install error and /sync again.")
        return
    if no_reboot:
        print("Skipping reboot (--no-reboot). Restart the bot by hand to load the new code.")
    else:
        print("Rebooting in 3s...")
        subprocess.Popen(["sh", "-c", "sleep 3; systemctl reboot"], start_new_session=True)


if __name__ == "__main__":
    main()
`,
};

export default entry;