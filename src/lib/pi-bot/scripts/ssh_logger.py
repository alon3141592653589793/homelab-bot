#!/usr/bin/env python3
"""SSH connection event logger (cron, every minute).

Writes a RAM log line for every SSH outcome the Pi's sshd reports:
  login      -- "Accepted <method> for <user> from <ip>"
  fail       -- "Failed <method> for [invalid user] <user> from <ip>",
                "Connection closed by ... [preauth]",
                "maximum authentication attempts exceeded for <user> from <ip>"
  disconnect -- "Disconnected from user <user> <ip>"

Reads /var/log/auth.log (rsyslog), tracking the last byte offset in /dev/shm
so each run only processes NEW lines. State + log live in RAM (/dev/shm) to
minimize SD-card wear. New events are also posted to the report Discord channel
(one compact message per run; failures are counted so a brute-force scan
doesn't spam).

If auth.log isn't readable, posts ONE hint (to add the user to the adm group:
`sudo usermod -aG adm alon`) and exits -- no spam, no silent no-op.
"""
import os
import re
import json
import subprocess
from datetime import datetime

SHM = "/dev/shm/pi-bot"
LOG = f"{SHM}/ssh_log.jsonl"
OFFSET_FILE = f"{SHM}/.ssh_log_offset"
PERM_WARN = f"{SHM}/.ssh_log_perm_warned"
MAX_LINES = 2000
AUTH_LOG = "/var/log/auth.log"

try:
    from dotenv import load_dotenv
    load_dotenv("/home/alon/secure-pi-bot/.env")
except Exception:
    pass

BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "")
try:
    CHANNEL_ID = int(os.getenv("REPORT_CHANNEL_ID", "0"))
except ValueError:
    CHANNEL_ID = 0


def discord_post(text):
    if not BOT_TOKEN or not CHANNEL_ID:
        return
    url = f"https://discord.com/api/v10/channels/{CHANNEL_ID}/messages"
    hdr = {"Authorization": f"Bot {BOT_TOKEN}", "Content-Type": "application/json"}
    try:
        import requests
    except ImportError:
        return
    for chunk in [text[i:i + 1900] for i in range(0, len(text), 1900)]:
        try:
            requests.post(url, json={"content": chunk}, headers=hdr, timeout=10)
        except Exception:
            pass


# sshd line classifiers (order matters: most specific first).
# Each returns (kind, user, ip) or None.
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
            user = groups[0] or ""
            return kind, user, groups[1], ""
        if kind == "fail":
            # both fail patterns put user/ip in the last two groups
            user = groups[-2] if len(groups) >= 2 else ""
            ip = groups[-1] if groups else ""
            return kind, user, ip, ""
    return None


def read_offset():
    try:
        with open(OFFSET_FILE) as f:
            return int(f.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def write_offset(v):
    try:
        with open(OFFSET_FILE, "w") as f:
            f.write(str(v))
    except OSError:
        pass


def append_log(entries):
    try:
        with open(LOG) as f:
            lines = f.readlines()
    except OSError:
        lines = []
    if len(lines) >= MAX_LINES:
        lines = lines[MAX_LINES // 2:]
    lines.extend(json.dumps(e) + "\n" for e in entries)
    try:
        with open(LOG, "w") as f:
            f.writelines(lines)
    except OSError:
        pass


def main():
    os.makedirs(SHM, exist_ok=True)

    # Permission check -- one-time hint, then exit cleanly.
    if not os.access(AUTH_LOG, os.R_OK):
        if not os.path.exists(PERM_WARN):
            try:
                open(PERM_WARN, "w").close()
            except OSError:
                pass
            discord_post(
                f"⚠️ ssh_logger can't read {AUTH_LOG}. Add the bot user to the "
                f"adm group so it can watch SSH logins/failures:\n"
                f"  sudo usermod -aG adm alon   (then reboot or `newgrp adm`)"
            )
        return

    size = os.path.getsize(AUTH_LOG)
    offset = read_offset()
    # log rotated (shrunk) -> start from the top
    if offset > size:
        offset = 0

    new_lines = []
    try:
        with open(AUTH_LOG, "rb") as f:
            f.seek(offset)
            chunk = f.read(size - offset)
    except OSError:
        return
    write_offset(size)

    if not chunk:
        return

    entries = []
    summary = {"login": [], "fail": [], "disconnect": []}
    now = datetime.now().isoformat(timespec="seconds")

    for raw in chunk.decode(errors="replace").splitlines():
        if " sshd[" not in raw:
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
        if kind in summary:
            summary[kind].append((user, ip))

    if not entries:
        return

    append_log(entries)

    # One compact Discord digest per run (failures counted, not one-per-line).
    parts = []
    if summary["login"]:
        for user, ip in summary["login"]:
            parts.append(f"✅ SSH login: {user} @ {ip}")
    if summary["disconnect"]:
        for user, ip in summary["disconnect"]:
            tag = user or "?"
            parts.append(f"🔌 SSH disconnect: {tag} @ {ip}")
    if summary["fail"]:
        ips = sorted({ip for _, ip in summary["fail"]})
        parts.append(
            f"❌ SSH failed attempts: {len(summary['fail'])} from {len(ips)} IP(s) "
            f"-> {', '.join(ips[:5])}"
        )
    if parts:
        discord_post("**[SSH]** " + now + "\n" + "\n".join(parts))


if __name__ == "__main__":
    main()