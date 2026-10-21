#!/usr/bin/env python3
"""AI-assisted Minecraft server diagnostic (/mc debug).

Runs a read-only diagnostic loop through the FreeLLMAPI gateway: the AI picks
from a curated allowlist of LOCAL, READ-ONLY commands (server config, logs,
ports, playit state, system vitals). Every command it runs + its output is
recorded into a transcript. At the end the AI summarizes the likely issue.

SAFEGUARDS (by design):
  * Read-only: every command is from a static allowlist. No stop/restart/write.
  * Local only: no external network probes except ONE DNS resolve of the saved
    tunnel hostname (no connection to the playit relay -- avoids DoS / IP-block).
  * Bounded: max 6 rounds, max 10 tool calls, each output truncated.

Usage:
  python3 mc_debug.py [optional question]
"""
import os
import sys
import json
import time
import socket
import subprocess

MC_DIR = os.path.expanduser("~/mc-server")
SCREEN = "mc"
LOG = os.path.join(MC_DIR, "logs", "latest.log")
TUNNELS_FILE = os.path.join(MC_DIR, ".tunnels")
MAX_ROUNDS = 6
MAX_CALLS = 10
OUT_CAP = 600

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import api_manager  # noqa: E402
import llm_gateway  # noqa: E402
import mc_manage  # noqa: E402

GATEWAY_ERROR = ""


def _run(cmd, timeout=8):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return ((r.stdout or "") + (r.stderr or "")).strip() or "(empty)"
    except subprocess.TimeoutExpired:
        return f"(timed out after {timeout}s)"
    except Exception as e:
        return f"(err: {e})"


def _cat(path, cap=OUT_CAP):
    try:
        with open(path) as f:
            return f.read().strip()[:cap] or "(empty)"
    except OSError as e:
        return f"(err: {e})"


def _exists(p):
    return "yes" if os.path.exists(p) else "no"


def _ports():
    return _run(["sh", "-c", "ss -ltnu 2>/dev/null | grep -E '25565|19132' || echo '(25565/19132 not listening)'"])


def _resolve_tunnel():
    """DNS-only resolve of the saved java tunnel host (no connection to relay).
    Safe: one getent hosts call. Returns the hostname + resolved IPs."""
    try:
        with open(TUNNELS_FILE) as f:
            t = json.load(f)
    except Exception:
        return "(no tunnels saved -- run /mc tunnels set <java> <bedrock>)"
    host = (t.get("java") or "").split(":")[0]
    if not host:
        return "(no java tunnel saved)"
    try:
        ips = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        unique = sorted(set(ai[4][0] for ai in ips))
        return f"{host} -> {', '.join(unique) or '(unresolved)'}"
    except Exception as e:
        return f"{host} -> (DNS failed: {e})"


# Read-only local diagnostic sources. Key = tool arg value.
DIAG = {
    "screen": lambda: "mc screen alive: " + ("yes" if mc_manage.screen_alive() else "no"),
    "paper_jar": lambda: _run(["sh", "-c", "ls -1 " + MC_DIR + "/paper-*.jar 2>/dev/null || echo '(none)'"]),
    "server_props": lambda: _cat(os.path.join(MC_DIR, "server.properties")),
    "paper_global": lambda: _cat(os.path.join(MC_DIR, "config", "paper-global.yml")),
    "paper_world": lambda: _cat(os.path.join(MC_DIR, "paper-world.yml")),
    "log_tail": lambda: _run(["sh", "-c", "tail -n 80 " + LOG + " 2>/dev/null || echo '(no log)'"]),
    "log_errors": lambda: _run(["sh", "-c", "grep -iE 'error|warn|exception|crash|failed|fatal' " + LOG + " 2>/dev/null | tail -n 40 || echo '(no errors found)'"]),
    "plugins": lambda: _run(["sh", "-c", "ls -1 " + MC_DIR + "/plugins/ 2>/dev/null || echo '(none)'"]),
    "geyser_config": lambda: _cat(os.path.join(MC_DIR, "plugins", "Geyser-Spigot", "config.yml")),
    "floodgate_config": lambda: _cat(os.path.join(MC_DIR, "plugins", "floodgate", "config.yml")),
    "start_sh": lambda: _cat(os.path.join(MC_DIR, "start.sh")),
    "eula": lambda: _cat(os.path.join(MC_DIR, "eula.txt"), 100),
    "ops": lambda: _cat(os.path.join(MC_DIR, "ops.json")),
    "heap": lambda: _cat(os.path.join(MC_DIR, ".heap"), 50),
    "tunnels": lambda: _cat(TUNNELS_FILE),
    "auto_restart": lambda: "24/7 marker: " + _exists(os.path.join(MC_DIR, ".auto_restart")),
    "ports": _ports,
    "ip": lambda: _run(["ip", "-br", "addr"]),
    "routes": lambda: _run(["ip", "route", "show"]),
    "temp": lambda: _run(["sh", "-c", "cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk '{printf \"%.1fC\", $1/1000}'"]),
    "mem": lambda: _run(["free", "-m"]),
    "load": lambda: _run(["cat", "/proc/loadavg"]),
    "disk": lambda: _run(["df", "-h", "/"]),
    "java": lambda: _run(["java", "-version"]),
    "procs": lambda: _run(["sh", "-c", "ps aux | grep -E '[j]ava|[p]layit' | awk '{print $1,$2,$3,$4,$11,$12,$13}' | head -n 10 || echo '(none)'"]),
    "playit_service": lambda: _run(["systemctl", "is-active", "playit"]) + " / enabled: " + _run(["systemctl", "is-enabled", "playit"]),
    "playit_proc": lambda: _run(["sh", "-c", "pgrep -a playit || echo '(no playit process)'"]),
    "resolve_tunnel": _resolve_tunnel,  # DNS only, no connection
}


def seed_context():
    """Initial snapshot so the AI has immediate signal without tool calls."""
    lines = ["=== INITIAL SNAPSHOT ==="]
    for k in ("screen", "paper_jar", "ports", "playit_service", "playit_proc",
              "java", "temp", "mem", "load", "tunnels", "auto_restart"):
        lines.append(f"[{k}] {DIAG[k]()}")
    return "\n".join(lines)


TOOL_DECL = [{
    "name": "run_diag",
    "description": ("Run ONE read-only, local Minecraft/Pi diagnostic and return its output. "
                    "Sources: " + ", ".join(sorted(DIAG.keys())) +
                    ". Use these to gather evidence about the server, playit, ports, and system."),
    "parameters": {"type": "object",
                   "properties": {"source": {"type": "string", "enum": sorted(DIAG.keys())}},
                   "required": ["source"]},
}]
TOOLS = [{"functionDeclarations": TOOL_DECL}]

SYS_INSTRUCT = (
    "You are a Minecraft server diagnostician for a Raspberry Pi home lab running "
    "Paper + Geyser + Floodgate behind playit.gg tunnels. The server is reported "
    "unreachable. Diagnose the likely cause using ONLY the run_diag(source) tool "
    "(read-only, local). Check: is the mc screen alive? is 25565/19132 listening? "
    "is the playit service active? do logs show a crash? is Java correct? is RAM "
    "exhausted? are the tunnels saved + resolvable? Be efficient: the initial "
    "snapshot already gives you the key signals -- only call run_diag for details "
    "the snapshot lacks. After gathering evidence, give: (1) LIKELY CAUSE in one "
    "line, (2) EVIDENCE citing exact values, (3) SUGGESTED FIX (do NOT execute "
    "anything -- you cannot). If the server is listening and playit is active but "
    "the player still can't connect, say the issue is likely the CLIENT network "
    "(school/work wifi blocking the playit relay), not the Pi. Never suggest "
    "destructive actions."
)


def diag_loop(question):
    global GATEWAY_ERROR
    transcript = []  # [(source, output)]
    calls = 0
    contents = [{"role": "user", "parts": [{"text": question}]}]
    used = None
    for _ in range(MAX_ROUNDS):
        resp, used = llm_gateway.chat(contents, tools=TOOLS, system=SYS_INSTRUCT, max_tokens=900)
        if not resp:
            GATEWAY_ERROR = llm_gateway.LAST_ERROR or "unknown error"
            return None, transcript, used
        parts = resp.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        fn = [p for p in parts if "functionCall" in p]
        if not fn:
            text = "".join(p.get("text", "") for p in parts if "text" in p).strip()
            return text, transcript, used
        contents.append({"role": "model", "parts": parts})
        fr = []
        for p in fn:
            if calls >= MAX_CALLS:
                fr.append({"functionResponse": {"name": "run_diag",
                           "response": {"result": "(call limit reached -- stop gathering and summarize)"}}})
                continue
            src = p["functionCall"].get("args", {}).get("source", "")
            if src not in DIAG:
                out = f"(unknown source: {src})"
            else:
                try:
                    out = DIAG[src]()[:OUT_CAP]
                except Exception as e:
                    out = f"(err: {e})"
            calls += 1
            transcript.append((src, out))
            fr.append({"functionResponse": {"name": "run_diag", "response": {"source": src, "result": out}}})
        contents.append({"role": "user", "parts": fr})
    return None, transcript, used


def main():
    question = " ".join(sys.argv[1:]).strip() or "The Minecraft server is unreachable for players. Diagnose the likely cause."
    if not llm_gateway.configured():
        print("**/mc debug** -- FreeLLMAPI gateway not configured. Run /llm unified <key> first (see /llm help).")
        return
    api_manager.rate_limit("freellmapi")
    ctx = seed_context()
    text, transcript, model = diag_loop(question + "\n\n" + ctx)
    api_manager.record("freellmapi", bool(text))

    out = ["**/mc debug**  model=" + (model or "?")]
    out.append("\n=== COMMANDS RUN ===")
    if not transcript:
        out.append("(none -- AI used the initial snapshot only)")
    for src, res in transcript:
        out.append(f"\n$ run_diag {src}\n{res}")
    out.append("\n=== AI DIAGNOSIS ===")
    if text:
        out.append(text)
    else:
        out.append(f"(no response -- {(GATEWAY_ERROR or 'all models failed')[:500]}\nTip: check /llm status and provider keys.)")
    print("\n".join(out))


if __name__ == "__main__":
    main()