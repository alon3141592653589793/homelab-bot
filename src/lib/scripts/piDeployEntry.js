const entry = {
  id: "pi-deploy",
  filename: "pi_deploy.py",
  path: "~/secure-pi-bot/scripts/pi_deploy.py",
  description: "Self-deploy: pull the pi-bot repo from GitHub, overwrite every script + config to its target path, apply root-owned configs (sudoers/polkit/udev/crontab/systemd) via the pi_deploy_root helper, then reboot. Repo layout == filesystem layout (home/... -> /home/..., usr/local/bin/... -> /usr/local/bin/..., etc/... -> /etc/..., crontab.txt -> crontab). git reset --hard is used so the repo is the source of truth (local Pi edits are overwritten). Triggered by Discord /sync (or /sync no-reboot). First-time bootstrap needs manual root (copy pi_deploy_root.sh to /usr/local/bin + add the sudoers line) -- see setup-notes.",
  tags: ["deploy", "github", "sync", "self-update", "reboot"],
  code: `#!/usr/bin/env python3
"""
Self-deploy: pull the pi-bot repo from GitHub, copy every script + config to
its target path, apply root-owned configs, then reboot. Triggered by the
Discord /sync command (or run by hand).

Repo layout == filesystem layout:
  home/alon/secure-pi-bot/... -> /home/alon/secure-pi-bot/...  (alon-owned)
  usr/local/bin/...           -> /usr/local/bin/...            (root)
  etc/systemd/system/...      -> /etc/systemd/system/...        (root)
  etc/sudoers.d/...            -> /etc/sudoers.d/...             (root)
  etc/polkit-1/rules.d/...    -> /etc/polkit-1/rules.d/...      (root)
  etc/udev/rules.d/...        -> /etc/udev/rules.d/...          (root)
  crontab.txt                 -> alon's crontab                 (root)

Config (one line each):
  ~/secure-pi-bot/.deploy_repo -> git URL
  ~/secure-pi-bot/.deploy_dir  -> local clone path (default ~/pi-deploy)

git reset --hard -> local edits on the Pi are OVERWRITTEN; the repo is the
source of truth. First-time bootstrap needs manual root (see setup-notes):
copy pi_deploy_root.sh to /usr/local/bin and add the sudoers line.

Usage:
  python3 pi_deploy.py                # pull, apply, REBOOT
  python3 pi_deploy.py --no-reboot    # pull, apply, no reboot (verify via SSH before rebooting)
  python3 pi_deploy.py --dry-run      # pull + list what would change, NO write, no reboot

Safe-test order: --dry-run -> --no-reboot -> verify SSH still works -> full run.
The root helper auto-snapshots /etc/sudoers.d, alon's crontab, pi-leds service,
polkit + udev rules to ~/.deploy_backups/<ts> BEFORE overwriting.
"""
import os
import sys
import subprocess
import json
from datetime import datetime

DEPLOY_REPO_FILE = "/home/alon/secure-pi-bot/.deploy_repo"
DEPLOY_DIR_FILE = "/home/alon/secure-pi-bot/.deploy_dir"
DEFAULT_DEPLOY_DIR = os.path.expanduser("~/pi-deploy")
ROOT_HELPER = ["sudo", "-n", "/usr/local/bin/pi_deploy_root"]
DEPLOY_STATE = "/home/alon/secure-pi-bot/.deploy_state.json"


def write_state(update):
    try:
        st = {}
        if os.path.exists(DEPLOY_STATE):
            with open(DEPLOY_STATE) as f:
                st = json.load(f)
        st.update(update)
        with open(DEPLOY_STATE, "w") as f:
            json.dump(st, f)
    except OSError:
        pass


def read_cfg(path, default=None):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def run(cmd):
    print("$ " + " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True)


def main():
    no_reboot = "--no-reboot" in sys.argv
    dry_run = "--dry-run" in sys.argv
    repo = read_cfg(DEPLOY_REPO_FILE)
    deploy_dir = read_cfg(DEPLOY_DIR_FILE, DEFAULT_DEPLOY_DIR)
    if not repo:
        print("FAILURE: set the repo URL first:")
        print("  echo 'https://github.com/you/pi-deploy.git' > ~/secure-pi-bot/.deploy_repo")
        sys.exit(1)

    mode = "dry-run" if dry_run else ("apply (no-reboot)" if no_reboot else "apply + reboot")
    write_state({"last_run": datetime.now().isoformat(timespec="seconds"), "last_run_mode": mode})

    # 1. Clone or fast-forward pull.
    if not os.path.isdir(os.path.join(deploy_dir, ".git")):
        run(["git", "clone", repo, deploy_dir])
    else:
        run(["git", "-C", deploy_dir, "fetch", "--force", "origin"])
        run(["git", "-C", deploy_dir, "reset", "--hard", "origin/HEAD"])
    print("Repo up to date at " + deploy_dir)

    if dry_run:
        print("[DRY-RUN] would apply these repo paths (no write, no reboot):")
        for top in ("home", "usr/local/bin", "etc/systemd/system", "etc/sudoers.d", "etc/polkit-1/rules.d", "etc/udev/rules.d"):
            base = os.path.join(deploy_dir, top)
            if os.path.isdir(base):
                for root, _, files in os.walk(base):
                    for fn in files:
                        print("  " + os.path.relpath(os.path.join(root, fn), deploy_dir))
        if os.path.isfile(os.path.join(deploy_dir, "crontab.txt")):
            print("  crontab.txt -> alon crontab")
        print("[DRY-RUN] nothing written. Next: --no-reboot (apply, keep session) then a full run to reboot.")
        return

    # 2. User-owned files (home/ tree) -- alon can write these directly.
    #    No --delete: only overwrite/add, never wipe unrelated Pi files.
    src_home = os.path.join(deploy_dir, "home")
    if os.path.isdir(src_home):
        subprocess.run(["rsync", "-a", src_home + "/", "/home/"], check=True)
        print("Copied home/ tree -> /home/")

    # 3. Root-owned files + crontab + services + reboot -> root helper.
    cmd = ROOT_HELPER + [deploy_dir]
    if no_reboot:
        cmd.append("--no-reboot")
    r = subprocess.run(cmd, capture_output=True, text=True)
    print((r.stdout or "").strip())
    if r.returncode != 0:
        print("ROOT HELPER FAILED:")
        print((r.stderr or "").strip())
        write_state({"last_apply": datetime.now().isoformat(timespec="seconds"), "last_apply_ok": False})
        sys.exit(1)
    write_state({"last_apply": datetime.now().isoformat(timespec="seconds"), "last_apply_ok": True})


if __name__ == "__main__":
    main()
`,
};

export default entry;