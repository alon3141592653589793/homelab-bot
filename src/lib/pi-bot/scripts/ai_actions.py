#!/usr/bin/env python3
"""Controlled write-action executor for the AI diagnostic agent.

The AI (ai_debug.py) can request actions via the `act` tool. This module
validates each request against an allowlist, executes it, logs the outcome,
and returns a compact result string to the AI.

Gate: /home/alon/secure-pi-bot/.ai_actions_enabled must exist. Without it,
execute() returns "actions disabled" and does nothing.

Audit: every attempted action is appended to /dev/shm/pi-bot/ai_actions.jsonl.
Max 6 actions per /aidebug session (prevents runaway tool loops).
"""
import os
import json
import subprocess
from datetime import datetime

BOT_DIR = "/home/alon/secure-pi-bot"
SHM = "/dev/shm/pi-bot"
SCRIPTS_DIR = os.path.join(BOT_DIR, "scripts")
ENABLED_FLAG = f"{BOT_DIR}/.ai_actions_enabled"
AUDIT_LOG = f"{SHM}/ai_actions.jsonl"
MAX_CALLS = 6

# Services the AI may restart. Only known, safe-to-restart system services.
RESTARTABLE = {
    "nginx.service", "AdGuardHome.service", "sshd.service",
    "cron.service", "rsyslog.service", "wg-easy.service",
}

ACTIONS = {
    "restart_service": "Restart a systemd service (allowlisted). Args: {\"service\": \"name.service\"}",
    "set_profile": "Apply a CPU profile. Args: {\"profile\": \"restricted\"|\"unlimited\"}",
    "toggle_logging": "Start/stop the system logger. Args: {\"state\": \"on\"|\"off\"}",
    "cooldown": "Stop non-essential services to shed heat. No args.",
}

_call_count = {"n": 0}


def reset_calls():
    _call_count["n"] = 0


def enabled():
    return os.path.exists(ENABLED_FLAG)


def _audit(action, args, result):
    os.makedirs(SHM, exist_ok=True)
    entry = {"ts": datetime.now().isoformat(timespec="seconds"),
             "action": action, "args": args, "result": str(result)[:500]}
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")
    except OSError:
        pass


def _run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return ((r.stdout or "") + (r.stderr or "")).strip()[:500] or "ok"
    except subprocess.TimeoutExpired:
        return f"timed out after {timeout}s"
    except Exception as e:
        return f"error: {e}"


def execute(action, args):
    """Validate + run one action. Returns a result string."""
    if not enabled():
        return "actions disabled (run /aiact on to enable)"
    if _call_count["n"] >= MAX_CALLS:
        return f"action limit reached ({MAX_CALLS} per session)"
    _call_count["n"] += 1
    args = args or {}

    if action == "restart_service":
        svc = str(args.get("service", "")).strip()
        if svc not in RESTARTABLE:
            return f"service '{svc}' not in allowlist: {', '.join(sorted(RESTARTABLE))}"
        out = _run(["systemctl", "restart", svc], timeout=20)
        chk = _run(["systemctl", "is-active", svc], timeout=5)
        result = f"restart {svc}: {out}; now {chk}"
        _audit(action, {"service": svc}, result)
        return result

    if action == "set_profile":
        profile = str(args.get("profile", "")).lower()
        if profile not in ("restricted", "unlimited"):
            return "profile must be 'restricted' or 'unlimited'"
        out = _run(["python3", os.path.join(SCRIPTS_DIR, f"set_profile_{profile}.py")], timeout=15)
        result = f"set_profile {profile}: {out}"
        _audit(action, {"profile": profile}, result)
        return result

    if action == "toggle_logging":
        state = str(args.get("state", "")).lower()
        if state not in ("on", "off"):
            return "state must be 'on' or 'off'"
        flag = f"{BOT_DIR}/.logging_enabled"
        if state == "on":
            open(flag, "w").close()
        else:
            try:
                os.remove(flag)
            except OSError:
                pass
        result = f"logging {state}"
        _audit(action, {"state": state}, result)
        return result

    if action == "cooldown":
        out = _run(["python3", os.path.join(SCRIPTS_DIR, "cooldown.py")], timeout=30)
        result = f"cooldown: {out}"
        _audit(action, {}, result)
        return result

    return f"unknown action: {action}"