#!/usr/bin/env python3
"""AI-assisted Minecraft server diagnostic (/mc debug).

Runs a read-only diagnostic loop through the FreeLLMAPI gateway: the AI picks
from a curated allowlist of LOCAL, READ-ONLY commands (server config, logs,
ports, playit state, system vitals). Every command it runs + its output is
recorded into a transcript. At the end the AI summarizes the likely issue.

SAFEGUARDS (by design):
  * Read-only: every command is from a static allowlist. No stop/restart/write.
  * Local only: no external probes except ONE DNS resolve and ONE bounded 5s TCP
    connect to the saved java tunnel endpoint (tests the relay actually forwards).
  * Bounded: max 6 rounds, max 10 tool calls, each output truncated.

Usage:
  python3 mc_debug.py [optional question]
"""
import os
import re
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


def _probe_tunnel():
    """Bounded TCP probe of the saved java tunnel endpoint (ONE connect, 5s).
    A successful TCP handshake means the playit relay accepts the connection and
    forwards to the local server; refused/timeout means the saved address is wrong
    or the tunnel is dead. This is the key connectivity test."""
    try:
        with open(TUNNELS_FILE) as f:
            t = json.load(f)
    except Exception:
        return "(no tunnels saved -- run /mc tunnels set <java> <bedrock>)"
    java = (t.get("java") or "").strip()
    if not java or ":" not in java:
        return "(no java tunnel saved)"
    host, _, port = java.rpartition(":")
    try:
        port = int(port)
    except ValueError:
        return f"(bad java tunnel port: {java})"
    t0 = time.time()
    try:
        with socket.create_connection((host, port), timeout=5):
            return f"TCP {host}:{port} -> CONNECTED in {time.time()-t0:.1f}s (relay forwards OK)"
    except ConnectionRefusedError:
        return f"TCP {host}:{port} -> REFUSED (saved address wrong or tunnel down -- check the playit dashboard for the real public port)"
    except socket.timeout:
        return f"TCP {host}:{port} -> TIMEOUT after 5s (tunnel dead or address wrong)"
    except Exception as e:
        return f"TCP {host}:{port} -> err: {e}"


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
    "playit_log": lambda: _run(["journalctl", "-u", "playit", "-n", "40", "--no-pager"]),
    "chunky": lambda: _run(["sh", "-c", "grep -iE 'chunky' " + LOG + " 2>/dev/null | tail -n 20 || echo '(no chunky lines)'"]),
    "resolve_tunnel": _resolve_tunnel,  # DNS only, no connection
    "probe_tunnel": _probe_tunnel,      # bounded 5s TCP test of the saved java endpoint
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
    "unreachable. Diagnose using ONLY the run_diag(source) tool (read-only, local). "
    "Key checks: mc screen alive? 25565/19132 listening? playit service active? "
    "logs show a crash? Java correct? RAM exhausted? "
    "CONNECTIVITY: run probe_tunnel to TCP-test the saved java endpoint. "
    "CONNECTED => the relay accepts connections AND forwards to the local server -- "
    "the saved tunnel address is CORRECT; do NOT claim the port is wrong even if it "
    "looks like the local port. REFUSED/TIMEOUT => the saved address is wrong or the "
    "tunnel is dead; tell the user to open the playit dashboard, copy the REAL public "
    "java tunnel address (host + assigned port), and re-save with "
    "/mc tunnels set <java-addr:port> <bedrock-addr:port>. "
    "If probe CONNECTED but the player STILL cannot join, the tunnel is NOT the "
    "problem -- investigate in order: "
    "(1) LOW RAM starving logins under load: check mem + load. If available RAM is "
    "very low (say <500MB) AND load is high, the server thread is starved and the MC "
    "login handshake times out even though the TCP socket opened. Suggest pausing "
    "Chunky pre-gen (/mc cmd chunky pause) and/or raising heap only if free RAM allows. "
    "(2) CHUNKY pre-generation hammering the Pi: check chunky -- if a task is running, "
    "suggest pausing it while players connect (/mc cmd chunky pause). "
    "(3) WRONG ADDRESS or EDITION on the player's side: Java players must use the java "
    "tunnel address, Bedrock players the bedrock tunnel address -- a Java client cannot "
    "join via the bedrock address and vice versa. Confirm the player used the exact "
    "address from /mc ip. "
    "(4) the player's network (only if 1-3 are ruled out). "
    "Be efficient: the initial snapshot gives the key signals; only call run_diag for "
    "details it lacks. After gathering evidence, give: (1) LIKELY CAUSE in one line, "
    "(2) EVIDENCE citing exact values, (3) SUGGESTED FIX (do NOT execute -- you cannot). "
    "Never suggest destructive actions."
)


_INVOKE_RE = re.compile(r"<invoke\b[^>]*>.*?</invoke>", re.DOTALL | re.IGNORECASE)
_INVOKE_NAME_RE = re.compile(r'name\s*=?\s*["\']?([A-Za-z0-9_.\-]+)', re.IGNORECASE)
_PARAM_RE = re.compile(
    r'<parameter\b[^>]*?name\s*=?\s*["\']?([A-Za-z0-9_.\-]+)["\']?[^>]*>(.*?)</parameter>',
    re.DOTALL | re.IGNORECASE)


def _parse_text_invokes(text):
    """Some free models (e.g. dots-3-note-preview) emit tool calls as raw text
    like <invoke name="run_diag"><parameter name="source">chunky</parameter>
    </invoke> instead of in the OpenAI tool_calls field. Parse those into Gemini
    functionCall parts so the diag loop keeps gathering evidence instead of
    dumping the raw XML as a fake 'diagnosis'."""
    parts = []
    for block in _INVOKE_RE.findall(text or ""):
        nm = _INVOKE_NAME_RE.search(block)
        if not nm:
            continue
        args = {}
        for pm in _PARAM_RE.finditer(block):
            args[pm.group(1)] = pm.group(2).strip()
        parts.append({"functionCall": {"name": nm.group(1), "args": args}})
    return parts


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
            # Some free models emit tool calls as raw <invoke> text instead of
            # in the OpenAI tool_calls field. Parse them so the loop keeps
            # gathering evidence instead of dumping raw XML as a "diagnosis".
            text = "".join(p.get("text", "") for p in parts if "text" in p)
            parsed = _parse_text_invokes(text)
            if parsed:
                parts = parsed
                fn = parsed
            else:
                return text.strip(), transcript, used
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