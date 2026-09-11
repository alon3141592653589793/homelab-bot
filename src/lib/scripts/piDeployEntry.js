const entry = {
  id: "pi-deploy",
  filename: "pi_deploy.py",
  path: "~/secure-pi-bot/scripts/pi_deploy.py",
  description: "Self-deploy: pull the pi-bot repo from GitHub, overwrite every script + config to its target path, apply root-owned configs (sudoers/polkit/udev/crontab/systemd) via the pi_deploy_root helper, then reboot. Repo layout == filesystem layout (home/... -> /home/..., usr/local/bin/... -> /usr/local/bin/..., etc/... -> /etc/..., crontab.txt -> crontab). git reset --hard is used so the repo is the source of truth (local Pi edits are overwritten). Triggered by Discord /sync (or /sync no-reboot). First-time bootstrap needs manual root (copy pi_deploy_root.sh to /usr/local/bin + add the sudoers line) -- see setup-notes. Safe-test order: --dry-run (validate, write nothing) -> --no-reboot (apply, stay up to fix if needed) -> /sync (full reboot).",
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
  python3 pi_deploy.py --no-reboot    # pull, apply, no reboot
  python3 pi_deploy.py --dry-run      # pull, report plan, WRITE NOTHING
"""
import os
import sys
import subprocess

DEPLOY_REPO_FILE = "/home/alon/secure-pi-bot/.deploy_repo"
DEPLOY_DIR_FILE = "/home/alon/secure-pi-bot/.deploy_dir"
DEFAULT_DEPLOY_DIR = os.path.expanduser("~/pi-deploy")
ROOT_HELPER = ["sudo", "-n", "/usr/local/bin/pi_deploy_root"]


def read_cfg(path, default=None):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def run(cmd):
    print("$ " + " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True)


def list_changes(src_root, dest_root):
    """Print new (+) and changed (~) files when syncing src_root into dest_root."""
    import filecmp
    for dirpath, _, files in os.walk(src_root):
        for fn in files:
            s = os.path.join(dirpath, fn)
            rel = os.path.relpath(s, src_root)
            d = os.path.join(dest_root, rel)
            if not os.path.exists(d):
                print("  + " + rel)
            elif not filecmp.cmp(s, d, shallow=False):
                print("  ~ " + rel)


def main():
    no_reboot = "--no-reboot" in sys.argv
    dry_run = "--dry-run" in sys.argv
    repo = read_cfg(DEPLOY_REPO_FILE)
    deploy_dir = read_cfg(DEPLOY_DIR_FILE, DEFAULT_DEPLOY_DIR)
    if not repo:
        print("FAILURE: set the repo URL first:")
        print("  echo 'https://github.com/you/pi-deploy.git' > ~/secure-pi-bot/.deploy_repo")
        sys.exit(1)

    # 1. Clone or fast-forward pull.
    if not os.path.isdir(os.path.join(deploy_dir, ".git")):
        run(["git", "clone", repo, deploy_dir])
    else:
        run(["git", "-C", deploy_dir, "fetch", "--force", "origin"])
        run(["git", "-C", deploy_dir, "reset", "--hard", "origin/HEAD"])
    print("Repo up to date at " + deploy_dir)

    tag = "[DRY-RUN] " if dry_run else ""

    # 2. User-owned files (home/ tree) -- alon can write these directly.
    #    No --delete: only overwrite/add, never wipe unrelated Pi files.
    src_home = os.path.join(deploy_dir, "home")
    if os.path.isdir(src_home):
        if dry_run:
            print(tag + "Would sync home/ -> /home/ (changed/added):")
            list_changes(src_home, "/home")
        else:
            subprocess.run(["rsync", "-a", src_home + "/", "/home/"], check=True)
            print("Copied home/ tree -> /home/")

    # 3. Root-owned files + crontab + services + reboot -> root helper.
    cmd = ROOT_HELPER + [deploy_dir]
    if no_reboot or dry_run:
        cmd.append("--no-reboot")
    if dry_run:
        cmd.append("--dry-run")
    r = subprocess.run(cmd, capture_output=True, text=True)
    print((r.stdout or "").strip())
    if r.returncode != 0:
        print("ROOT HELPER FAILED:")
        print((r.stderr or "").strip())
        sys.exit(1)
    if dry_run:
        print(tag + "Nothing written. Re-run without --dry-run to apply; add --no-reboot to skip the reboot.")


if __name__ == "__main__":
    main()
`,
};

export default entry;