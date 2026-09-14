#!/usr/bin/env python3
"""Automatic stealthy network scan -- every 50 hours.

Runs from cron (hourly); self-gates so it only actually scans when >= 50h have
passed since the last scan. Uses polite timing (-T2) and host discovery only
(-sn) to stay quiet. Every scan is saved to logs/net_scans/. If a host shows
up that was NOT present in any of the last 5 scans, it is reported to Discord
and logged. All scans are persisted as JSONL.

Dependencies: nmap (sudo apt install nmap) + sudoers entry (see setup-notes.txt).
Set NETSCAN_CHANNEL_ID (or reuse REPORT_CHANNEL_ID) in .env for alerts.
"""
import os
import sys
import json
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import net_scan  # reuse detect_subnet / run_nmap / parse_hosts

BOT_DIR = "/home/alon/secure-pi-bot"
LOG_DIR = "{}/logs/net_scans".format(BOT_DIR)
LOG_FILE = "{}/net_scans.jsonl".format(LOG_DIR)
STATE_FILE = "{}/.net_scan_state.json".format(BOT_DIR)
os.makedirs(LOG_DIR, exist_ok=True)

INTERVAL = timedelta(hours=50)
KEEP_SCANS = 5


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(st):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(st, f)
    except OSError:
        pass


def append_log(entry):
    try:
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def post_discord(text):
    from dotenv import load_dotenv
    try:
        import requests
    except ImportError:
        return False
    load_dotenv("{}/.env".format(BOT_DIR))
    token = os.getenv("DISCORD_BOT_TOKEN")
    ch = os.getenv("NETSCAN_CHANNEL_ID") or os.getenv("REPORT_CHANNEL_ID")
    if not token or not ch:
        print("NETSCAN: no Discord token/channel -- skipping alert.")
        return False
    url = "https://discord.com/api/v10/channels/{}/messages".format(int(ch))
    hdr = {"Authorization": "Bot {}".format(token), "Content-Type": "application/json"}
    ok = True
    for chunk in [text[i:i + 1900] for i in range(0, len(text), 1900)]:
        try:
            r = requests.post(url, json={"content": chunk}, headers=hdr, timeout=10)
            if r.status_code not in (200, 201):
                ok = False
        except Exception as e:
            print("NETSCAN: discord post failed: {}".format(e))
            ok = False
    return ok


def main():
    st = load_state()
    last_run = st.get("last_run")
    if last_run:
        try:
            age = datetime.now() - datetime.fromisoformat(last_run)
        except ValueError:
            age = timedelta(hours=999)
        if age < INTERVAL:
            return  # not time yet

    subnet = net_scan.detect_subnet()
    if not subnet:
        print("NETSCAN: could not detect subnet.")
        return

    out, used_sudo = net_scan.run_nmap(subnet, timing="-T2")
    if out is None:
        print("NETSCAN: nmap not installed. Run: sudo apt install nmap")
        return
    hosts, summary = net_scan.parse_hosts(out)
    current_ips = sorted({h["ip"] for h in hosts})

    prior_scans = st.get("scans", [])  # list of {ts, ips}
    known = set()
    for s in prior_scans:
        known.update(s.get("ips", []))
    new_ips = [ip for ip in current_ips if ip not in known]

    ts = now_iso()
    entry = {
        "ts": ts,
        "subnet": subnet,
        "hosts_up": len(hosts),
        "ips": current_ips,
        "new_ips": new_ips,
        "stealth": True,
        "sudo": used_sudo,
        "summary": summary,
    }
    append_log(entry)

    # report new hosts only if we have history to compare against
    if prior_scans and new_ips:
        body = ["[NETSCAN] New device(s) on {} @ {}".format(subnet, ts)]
        for h in hosts:
            if h["ip"] in new_ips:
                line = "- {}".format(h["ip"])
                if h["hostname"]:
                    line += "  {}".format(h["hostname"])
                if h["mac"]:
                    line += "  [{}]".format(h["mac"])
                if h["vendor"]:
                    line += "  ({})".format(h["vendor"])
                body.append(line)
        body.append("(not seen in the last {} scans)".format(KEEP_SCANS))
        post_discord("\n".join(body))
        print("NETSCAN: reported {} new host(s).".format(len(new_ips)))
    else:
        print("NETSCAN: {} hosts, {} new. Logged.".format(len(hosts), len(new_ips)))

    # roll the window: keep last KEEP_SCANS (including this one)
    prior_scans.append({"ts": ts, "ips": current_ips})
    st["scans"] = prior_scans[-KEEP_SCANS:]
    st["last_run"] = ts
    save_state(st)


if __name__ == "__main__":
    main()