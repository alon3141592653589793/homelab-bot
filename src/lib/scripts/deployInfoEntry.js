const entry = {
  id: "deploy-info",
  filename: "deploy_info.py",
  path: "~/secure-pi-bot/scripts/deploy_info.py",
  description: "Shows deploy status: when the GitHub repo was last updated (local last commit + whether the remote HEAD has newer commits since the last /sync) and when /sync last ran (last run + last successful apply, from .deploy_state.json which pi_deploy.py writes). Triggered by /syncinfo (alias /deployinfo).",
  tags: ["deploy", "github", "sync", "status", "discord"],
  code: `#!/usr/bin/env python3
"""Show deploy status: when the GitHub repo was last updated and when /sync
last ran. Triggered by /syncinfo (alias /deployinfo)."""
import os
import json
import subprocess
from datetime import datetime

BOT = "/home/alon/secure-pi-bot"
REPO_FILE = f"{BOT}/.deploy_repo"
DIR_FILE = f"{BOT}/.deploy_dir"
STATE_FILE = f"{BOT}/.deploy_state.json"

def read_cfg(p, default=None):
    try:
        with open(p) as f:
            return f.read().strip()
    except OSError:
        return default

def git(args, cwd=None, timeout=10):
    try:
        r = subprocess.run(["git"] + args, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None

repo = read_cfg(REPO_FILE)
deploy_dir = read_cfg(DIR_FILE, os.path.expanduser("~/pi-deploy"))

L = ["**/syncinfo**  " + datetime.now().strftime("%H:%M:%S")]
L.append(f"Repo: {repo or '(not set: ~/secure-pi-bot/.deploy_repo missing)'}")

if os.path.isdir(os.path.join(deploy_dir, ".git")):
    local_head = git(["rev-parse", "--short", "HEAD"], cwd=deploy_dir)
    last_subj = git(["log", "-1", "--format=%s"], cwd=deploy_dir)
    last_rel = git(["log", "-1", "--format=%cr"], cwd=deploy_dir)
    L.append(f"Last commit (local): {local_head or '?'} | {last_subj or '?'}")
    if last_rel:
        L.append(f"  committed {last_rel} ago")
    if repo:
        try:
            r = subprocess.run(["git", "ls-remote", repo, "HEAD"], capture_output=True, text=True, timeout=12)
            if r.returncode == 0 and r.stdout:
                remote_head = r.stdout.split()[0][:7]
                if local_head and remote_head.startswith(local_head):
                    L.append(f"Remote HEAD {remote_head}: repo matches local (up to date)")
                else:
                    L.append(f"Remote HEAD {remote_head}: NEWER commits on GitHub since last /sync")
            else:
                L.append("Remote check: unavailable (private repo / offline / bad URL)")
        except Exception:
            L.append("Remote check: timed out")
else:
    L.append(f"Clone not found at {deploy_dir} (run /sync first)")

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

print("\\n".join(L))
`,
};

export default entry;