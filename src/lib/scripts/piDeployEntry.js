const entry = {
  id: "pi-deploy",
  filename: "pi_deploy.py",
  path: "~/secure-pi-bot/scripts/pi_deploy.py",
  description: "Self-deploy (simple): pull the existing secure-pi-bot repo directly into ~/secure-pi-bot, VERIFY every change by sha256 hash, report old->new hash for each updated file, then reboot so the bot reloads the new code. One repo, one path -- just a git fetch + reset --hard to origin/<branch>. Root-owned files (/etc/..., /usr/local/bin/...) are NOT touched by /sync (change those by hand). .env and other untracked files are never deleted (git reset --hard only touches tracked files; aborts if .env is tracked to protect secrets). Triggered by Discord /sync (or /sync no-reboot / /sync dry-run). Records last-run state for /syncinfo.",
  tags: ["deploy", "github", "sync", "self-update", "reboot", "verify"],
  code: `#!/usr/bin/env python3
"""
Self-deploy (simple): pull the existing secure-pi-bot repo directly into
~/secure-pi-bot, verify every change by sha256 hash, report old->new hash
for each updated file, then reboot so the bot reloads the new code.

One repo, one path -- this is just a git pull of your existing project repo.
Root-owned files (/etc/..., /usr/local/bin/...) are NOT touched by /sync;
change those by hand when needed. .env and other untracked files are never
deleted (git reset --hard only touches tracked files).

Config (one line each):
  ~/secure-pi-bot/.deploy_repo    -> git URL of the existing repo
  ~/secure-pi-bot/.deploy_branch  -> branch (optional; default = repo default)

Usage:
  python3 pi_deploy.py               # pull, verify, REBOOT
  python3 pi_deploy.py --no-reboot   # pull, verify, no reboot
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

    if dry_run:
        print("[DRY-RUN] new commits since last sync:")
        r = git(["log", "--oneline", "HEAD.." + ref], check=False)
        print(r.stdout.strip() or "(none -- already up to date)")
        if changed:
            print("[DRY-RUN] files that would change (" + str(len(changed)) + "):")
            for rel in changed:
                print("  - " + rel + "  (current hash: " + fhash(rel) + ")")
        else:
            print("[DRY-RUN] no tracked files would change.")
        print("[DRY-RUN] nothing written.")
        return

    # Snapshot current hashes of the files that will change, THEN apply.
    old_hashes = {rel: fhash(rel) for rel in changed}

    git(["reset", "--hard", ref])
    print("Updated " + DEPLOY_DIR + " to " + ref)

    # Verify: report old -> new hash for every file that was supposed to change.
    if changed:
        print("Hash verification (" + str(len(changed)) + " file(s) diff vs HEAD):")
        actually = 0
        for rel in changed:
            oh = old_hashes[rel]
            nh = fhash(rel)
            if oh == nh:
                print("  = " + rel + "  " + oh + " (no change)")
            else:
                print("  + " + rel + "  " + oh + " -> " + nh)
                actually += 1
        print(str(actually) + "/" + str(len(changed)) + " files actually changed on disk.")
    else:
        print("No tracked files changed (already up to date).")

    write_state({"last_apply": datetime.now().isoformat(timespec="seconds"), "last_apply_ok": True})

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