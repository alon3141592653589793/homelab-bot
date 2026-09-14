#!/usr/bin/env python3
"""Manual /nmap -- scan the whole local WiFi network (host discovery) and
report a clean host list to Discord.

Detects the local subnet from the default route, runs `nmap -sn` (ping/host
discovery only -- fast, no port scan). Uses `sudo -n nmap` so ARP + MAC +
vendor are available; if the sudoers entry isn't set up it falls back to
plain nmap (no ARP/MAC) with a note.

Dependencies: nmap (sudo apt install nmap). For full results (MAC/vendor)
add a sudoers entry (see setup-notes.txt):
    alon ALL=(root) NOPASSWD: /usr/bin/nmap
"""
import os
import sys
import re
import subprocess


def detect_subnet():
    """Return '<a.b.c.0>/24' from the default route's src IP, else the first
    non-default route's prefix, else None."""
    try:
        r = subprocess.run(["ip", "route"], capture_output=True, text=True, timeout=5)
        for line in r.stdout.splitlines():
            if line.startswith("default"):
                m = re.search(r"src (\d+\.\d+\.\d+\.\d+)", line)
                if m:
                    parts = m.group(1).split(".")
                    return ".".join(parts[:3]) + ".0/24"
        for line in r.stdout.splitlines():
            if "/" in line and not line.startswith("default"):
                m = re.match(r"(\d+\.\d+\.\d+\.\d+/\d+)", line)
                if m:
                    return m.group(1)
    except Exception:
        pass
    return None


def run_nmap(subnet, timing="-T4", extra=None):
    """Run a host-discovery scan. Returns (text, used_sudo) or (None, False) if
    nmap isn't installed."""
    args = extra or []
    for prefix in (["sudo", "-n"], []):
        try:
            r = subprocess.run(prefix + ["nmap", "-sn", timing] + args + [subnet],
                               capture_output=True, text=True, timeout=180)
        except FileNotFoundError:
            return None, False
        except subprocess.TimeoutExpired:
            return "TIMEOUT: scan took too long.", False
        if prefix and r.returncode != 0 and "is not in the sudoers" in (r.stderr or ""):
            continue  # fall back to plain nmap
        return r.stdout if r.returncode == 0 else (r.stdout + "\n" + (r.stderr or "")).strip(), bool(prefix)
    return "", False


def parse_hosts(text):
    hosts = []
    cur = {}
    for line in text.splitlines():
        m = re.match(r"Nmap scan report for (\S+)(?: \(([^)]+)\))?", line)
        if m:
            if cur:
                hosts.append(cur)
            cur = {"ip": m.group(1), "hostname": m.group(2) or "", "mac": "", "vendor": ""}
        mac = re.match(r"MAC Address: ([0-9A-Fa-f:]{17})(?: \(([^)]+)\))?", line)
        if mac and cur:
            cur["mac"] = mac.group(1)
            cur["vendor"] = mac.group(2) or ""
    if cur:
        hosts.append(cur)
    summary = ""
    sm = re.search(r"Nmap done:.*\((\d+) host(?:s)? up\)", text)
    if sm:
        summary = sm.group(0)
    return hosts, summary


def main():
    subnet = detect_subnet()
    if not subnet:
        print("FAILURE: could not detect local subnet.")
        sys.exit(1)
    print("Scanning {} ...".format(subnet))
    out, used_sudo = run_nmap(subnet)
    if out is None:
        print("FAILURE: nmap not installed. Run: sudo apt install nmap")
        sys.exit(1)
    hosts, summary = parse_hosts(out)
    if not hosts:
        print("No hosts found (or nmap needs root for ARP -- add sudoers entry for nmap).")
        print("--- raw ---")
        print(out[:1900])
        return
    print("Found {} host(s) on {}:".format(len(hosts), subnet))
    for h in hosts:
        line = "- {}".format(h["ip"])
        if h["hostname"]:
            line += "  {}".format(h["hostname"])
        if h["mac"]:
            line += "  [{}]".format(h["mac"])
        if h["vendor"]:
            line += "  ({})".format(h["vendor"])
        print(line)
    if summary:
        print(summary)
    if not used_sudo:
        print("[note] ran without sudo (no ARP/MAC) -- add sudoers entry for nmap.")


if __name__ == "__main__":
    main()