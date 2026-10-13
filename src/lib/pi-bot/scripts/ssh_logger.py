#!/usr/bin/env python3
"""SSH connection event logger (cron, every minute).

Writes a RAM log line for every SSH outcome the Pi's sshd reports:
  login      -- "Accepted <method> for <user> from <ip>"
  fail       -- "Failed <method> for [invalid user] <user> from <ip>",
                "Connection closed by ... [preauth]",
                "maximum authentication attempts exceeded for <user> from <ip>"
  disconnect -- "Disconnected from user <user> <ip>"

Source of lines (auto-detected every run):
  1. /var/log/auth.log (rsyslog) when it exists and is readable. Byte offset
     is tracked in /dev/shm so each run only processes NEW lines.
  2. journald (`journalctl -u ssh`) when auth.log doesn't exist (newer Pi OS
     has no rsyslog). Cursor is tracked in /dev/shm.

State + log live in RAM (/dev/shm) to minimize SD-card wear. New events are
also posted to the report Discord channel (one compact message per run).

If NEITHER source is usable, ONE diagnostic message is posted that says
exactly WHY (file missing / permission / group not active in this session /
journal not readable), with the matching fix. The "already warned" marker is
stored on disk (not RAM) keyed by the cause, so it does NOT repeat on every
boot -- it only re-alerts when the cause changes, or after it recovered and
broke again. Full diagnostics always go to /dev/shm/pi-bot/ssh_logger.log
(cron stdout) for /logs ssh_logger.
"""
import os
import re
import grp
import json
import pwd
import subprocess
import traceback
from datetime import datetime

SHM = "/dev/shm/pi-bot"
LOG = f"{SHM}/ssh_log.jsonl"
OFFSET_FILE = f"{SHM}/.ssh_log_offset"
CURSOR_FILE = f"{SHM}/.ssh_journal_cursor"
# On DISK on purpose: /dev/shm is wiped every reboot, which made the same
# warning fire on every boot. Tiny file, written only when the cause changes.
WARN_STATE = "/home/alon/secure-pi-bot/.ssh_logger_warned"
MAX_LINES = 2000
AUTH_LOG = "/var/log/auth.log"


def dbg(msg):
    """Diagnostic line to cron stdout (-> /dev/shm/pi-bot/ssh_logger.log)."""
    print(f"[{datetime.now().isoformat(timespec='seconds')}] ssh_logger: {msg}", flush=True)


try:
    from dotenv import load_dotenv
    load_dotenv("/home/alon/secure-pi-bot/.env")
except Exception as e:
    dbg(f"dotenv not loaded: {type(e).__name__}: {e}")

BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "")
try:
    CHANNEL_ID = int(os.getenv("REPORT_CHANNEL_ID", "0"))
except ValueError:
    CHANNEL_ID = 0


def discord_post(text):
    if not BOT_TOKEN or not CHANNEL_ID:
        dbg("discord_post skipped: DISCORD_BOT_TOKEN / REPORT_CHANNEL_ID not set")
        return
    url = f"https://discord.com/api/v10/channels/{CHANNEL_ID}/messages"
    hdr = {"Authorization": f"Bot {BOT_TOKEN}", "Content-Type": "application/json"}
    try:
        import requests
    except ImportError:
        dbg("discord_post skipped: 'requests' module not installed")
        return
    for chunk in [text[i:i + 1900] for i in range(0, len(text), 1900)]:
        try:
            r = requests.post(url, json={"content": chunk}, headers=hdr, timeout=10)
            if r.status_code >= 300:
                dbg(f"discord_post HTTP {r.status_code}: {r.text[:200]}")
        except Exception as e:
            dbg(f"discord_post failed: {type(e).__name__}: {e}")


# sshd line classifiers (order matters: most specific first).
_PATTERNS = [
    (re.compile(r"Accepted (\S+) for (\S+) from ([0-9a-fA-F:.]+) port"), "login"),
    (re.compile(r"Failed (\S+) for (?:invalid user )?(\S+) from ([0-9a-fA-F:.]+) port"), "fail"),
    (re.compile(r"maximum authentication attempts exceeded for (\S+) from ([0-9a-fA-F:.]+) port"), "fail"),
    (re.compile(r"Connection closed by (?:authenticating user (\S+) )?([0-9a-fA-F:.]+) port \d+ \[preauth\]"), "fail"),
    (re.compile(r"Disconnected from (?:user (\S+) )?([0-9a-fA-F:.]+) port"), "disconnect"),
]


def classify(line):
    for pat, kind in _PATTERNS:
        m = pat.search(line)
        if not m:
            continue
        groups = m.groups()
        if kind == "login":
            return kind, groups[1], groups[2], groups[0]   # method
        if kind == "disconnect":
            return kind, groups[0] or "", groups[1], ""
        if kind == "fail":
            user = groups[-2] if len(groups) >= 2 else ""
            ip = groups[-1] if groups else ""
            return kind, user, ip, ""
    return None


def read_file(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def write_file(path, value):
    try:
        with open(path, "w") as f:
            f.write(str(value))
    except OSError as e:
        dbg(f"cannot write {path}: {e}")


def append_log(entries):
    try:
        with open(LOG) as f:
            lines = f.readlines()
    except OSError:
        lines = []
    if len(lines) >= MAX_LINES:
        lines = lines[MAX_LINES // 2:]
    lines.extend(json.dumps(e) + "\n" for e in entries)
    write_file(LOG, "".join(lines))


# ---------------------------------------------------------------- diagnosis
def user_in_adm_db(user):
    """Is `user` in adm according to /etc/group (what a fresh login gets)?"""
    try:
        return user in grp.getgrnam("adm").gr_mem
    except KeyError:
        return False


def process_has_adm():
    """Does THIS process currently hold the adm group?"""
    try:
        return grp.getgrnam("adm").gr_gid in os.getgroups()
    except KeyError:
        return False


def diagnose_auth_log():
    """Return (usable, cause_key, human_explanation_with_fix)."""
    me = pwd.getpwuid(os.getuid()).pw_name
    if not os.path.exists(AUTH_LOG):
        return False, "missing", (
            f"{AUTH_LOG} does not exist (this Pi OS likely logs sshd to journald only). "
            f"Falling back to journald."
        )
    if os.access(AUTH_LOG, os.R_OK):
        return True, "ok", ""
    try:
        st = os.stat(AUTH_LOG)
        owner = f"{pwd.getpwuid(st.st_uid).pw_name}:{grp.getgrgid(st.st_gid).gr_name} {oct(st.st_mode & 0o777)}"
    except Exception:
        owner = "unknown"
    if user_in_adm_db(me) and not process_has_adm():
        return False, "group_inactive", (
            f"{me} IS in the adm group, but this cron session doesn't have it active yet "
            f"(group membership only applies to NEW sessions). Fix: reboot the Pi once "
            f"(/restart). If it persists after a reboot, check `id` as {me} and that cron "
            f"was started after the usermod."
        )
    if not user_in_adm_db(me):
        return False, "not_in_adm", (
            f"{me} is NOT in the adm group (file is {owner}). "
            f"Fix: `sudo usermod -aG adm {me}` then reboot. (Re-running pi-system-fixes.sh does this too.)"
        )
    return False, "perm_other", (
        f"{AUTH_LOG} ({owner}) is unreadable for {me} even though the adm group looks right. "
        f"Check `ls -l {AUTH_LOG}` and `id`; an ACL, AppArmor or a custom umask may be involved."
    )


def warn_once(cause_key, text):
    """Post `text` only when the cause differs from the last one we warned about."""
    last = read_file(WARN_STATE)
    if last == cause_key:
        dbg(f"already warned about '{cause_key}' (suppressed). {text}")
        return
    write_file(WARN_STATE, cause_key)
    dbg(f"WARN {cause_key}: {text}")
    discord_post(f"⚠️ ssh_logger [{cause_key}]: {text}")


def clear_warn():
    if os.path.exists(WARN_STATE):
        try:
            os.remove(WARN_STATE)
            dbg("recovered: cleared warn state")
        except OSError as e:
            dbg(f"cannot clear warn state: {e}")


# ------------------------------------------------------------------ readers
def read_auth_log_lines():
    size = os.path.getsize(AUTH_LOG)
    try:
        offset = int(read_file(OFFSET_FILE, "0") or 0)
    except ValueError:
        offset = 0
    if offset > size:   # log rotated
        dbg(f"auth.log shrank ({offset} -> {size}); assuming rotation, reading from top")
        offset = 0
    try:
        with open(AUTH_LOG, "rb") as f:
            f.seek(offset)
            chunk = f.read(size - offset)
    except OSError as e:
        dbg(f"read of {AUTH_LOG} failed: {type(e).__name__}: {e}")
        return None
    write_file(OFFSET_FILE, size)
    return chunk.decode(errors="replace").splitlines()


def read_journal_lines():
    """New sshd lines from journald since the saved cursor. None on error."""
    cursor = read_file(CURSOR_FILE)
    cmd = ["journalctl", "-u", "ssh", "-u", "sshd", "--no-pager", "-o", "short", "--show-cursor"]
    cmd += ["--after-cursor", cursor] if cursor else ["--since", "-2min"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except FileNotFoundError:
        warn_once("no_journalctl", "journalctl not found and auth.log is missing: no SSH log source available.")
        return None
    except subprocess.TimeoutExpired:
        dbg("journalctl timed out after 20s")
        return None
    if r.returncode != 0:
        err = (r.stderr or r.stdout).strip()[:300]
        dbg(f"journalctl exit {r.returncode}: {err}")
        warn_once("journal_unreadable",
                  f"cannot read journald as this user (exit {r.returncode}): {err}. "
                  f"Fix: `sudo usermod -aG systemd-journal,adm alon` then reboot.")
        return None
    lines = []
    for ln in r.stdout.splitlines():
        if ln.startswith("-- cursor:"):
            write_file(CURSOR_FILE, ln.split(":", 1)[1].strip())
        else:
            lines.append(ln)
    return lines


# --------------------------------------------------------------------- main
def process(lines):
    entries = []
    summary = {"login": [], "fail": [], "disconnect": []}
    now = datetime.now().isoformat(timespec="seconds")
    for raw in lines:
        if "sshd" not in raw:
            continue
        res = classify(raw)
        if not res:
            continue
        kind, user, ip, extra = res
        msg = raw.split("sshd[", 1)[-1] if "sshd[" in raw else raw
        entry = {"ts": now, "kind": kind, "user": user, "ip": ip, "msg": msg.strip()}
        if kind == "login":
            entry["method"] = extra
        entries.append(entry)
        summary[kind].append((user, ip))
    if not entries:
        return
    append_log(entries)
    parts = []
    for user, ip in summary["login"]:
        parts.append(f"✅ SSH login: {user} @ {ip}")
    for user, ip in summary["disconnect"]:
        parts.append(f"🔌 SSH disconnect: {user or '?'} @ {ip}")
    if summary["fail"]:
        ips = sorted({ip for _, ip in summary["fail"]})
        parts.append(f"❌ SSH failed attempts: {len(summary['fail'])} from {len(ips)} IP(s) -> {', '.join(ips[:5])}")
    if parts:
        discord_post("**[SSH]** " + now + "\n" + "\n".join(parts))


def main():
    os.makedirs(SHM, exist_ok=True)

    usable, cause, why = diagnose_auth_log()
    if usable:
        lines = read_auth_log_lines()
        source = "auth.log"
    else:
        dbg(f"auth.log unusable [{cause}]: {why}")
        if cause == "missing":
            lines = read_journal_lines()
            source = "journald"
        else:
            # auth.log exists but we can't read it. Try journald before nagging.
            lines = read_journal_lines()
            source = "journald"
            if lines is None:
                warn_once(cause, why)
                return
            dbg("auth.log unreadable but journald works -> using journald (no warning needed)")

    if lines is None:
        return
    clear_warn()
    dbg(f"source={source} new_lines={len(lines)}")
    process(lines)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        dbg("UNEXPECTED ERROR:\n" + traceback.format_exc())