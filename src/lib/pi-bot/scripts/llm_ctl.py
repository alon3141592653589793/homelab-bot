#!/usr/bin/env python3
"""Control the self-hosted FreeLLMAPI gateway from Discord (/llm ...).

No Docker: FreeLLMAPI runs as the USER systemd service 'freellmapi.service'
(Node 20+, installed in ~/freellmapi). Provider keys are managed through the
project's own CLI (`npx freellmapi keys ...`), which authenticates with a
dashboard session token stored at ~/.secrets/freellmapi_dash_token.

Sub-commands:
  status                       service state + reachability + key/model counts
  start | stop | restart       control the service
  log [N]                      last N lines of the service journal
  keys                         list provider keys (ids, platform, state)
  addkey <platform> <key>      add + validate a provider key
  rmkey <platform> [id]        remove a provider key
  testkey <platform> [id]      re-check stored key(s)
  token <dashboard-token>      save the dashboard session token (for keys cmds)
  unified <key>                save the unified API key (what ai_debug uses)
  model [auto|auto:fast|auto:smart|<id>]   show/set routing model
  on | off                     enable/disable the gateway for the bot
                               (off = /aidebug is unavailable)
"""
import os
import re
import sys
import json
import subprocess
import urllib.request

HOME = os.path.expanduser("~")
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(HOME, "secure-pi-bot", ".env"))
except ImportError:
    pass
INSTALL_DIR = os.path.join(HOME, "freellmapi")
SECRETS = os.path.join(HOME, ".secrets")
UNIFIED_FILE = os.path.join(SECRETS, "freellmapi_key")
UNIFIED_OFF = UNIFIED_FILE + ".disabled"
TOKEN_FILE = os.path.join(SECRETS, "freellmapi_dash_token")
BOT_ENV = os.path.join(HOME, "secure-pi-bot", ".env")
URL = os.getenv("FREELLMAPI_URL", "http://127.0.0.1:3001/v1").rstrip("/")
ROOT_URL = URL[:-3] if URL.endswith("/v1") else URL
SERVICE = "freellmapi.service"
PLATFORM_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,40}$")
ID_RE = re.compile(r"^\d{1,9}$")


def run(cmd, timeout=60, env=None):
    try:
        e = dict(os.environ)
        # The bot's environment has no user session bus, so `systemctl --user`
        # failed with "Failed to connect to bus". Point it at the lingering user bus.
        uid = os.getuid()
        e.setdefault("XDG_RUNTIME_DIR", f"/run/user/{uid}")
        e.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{uid}/bus")
        e.update(env or {})
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=e)
        return ((r.stdout or "") + (r.stderr or "")).strip(), r.returncode
    except subprocess.TimeoutExpired:
        return f"timed out after {timeout}s", 124
    except FileNotFoundError as ex:
        return f"not found: {ex.filename}", 127
    except Exception as ex:
        return f"error: {ex}", 1


def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def write_secret(path, value):
    os.makedirs(SECRETS, mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(value.strip() + "\n")
    os.chmod(path, 0o600)


def svc(action):
    return run(["systemctl", "--user", action, SERVICE], timeout=60)


def installed():
    return os.path.isdir(os.path.join(INSTALL_DIR, "server"))


def reachable():
    try:
        with urllib.request.urlopen(ROOT_URL + "/", timeout=4) as r:
            return r.status < 500
    except Exception as e:
        # an HTTP error response still means the server is up
        return hasattr(e, "code")


def cli(args, timeout=45):
    """Run the FreeLLMAPI CLI. Token is passed via the ENVIRONMENT, never argv,
    so it can't show up in `ps`. A provider key (addkey) is the one exception:
    the CLI only takes it via --key or a TTY prompt."""
    tok = read(TOKEN_FILE)
    if not tok:
        return ("No dashboard token saved (this is NOT the unified key -- /aidebug works without it; "
                "it's only needed to list/add/remove provider keys from Discord).\n"
                "Easier: open the dashboard (ssh -p 54321 -L 3001:127.0.0.1:3001 alon@<pi>, then http://127.0.0.1:3001) "
                "and add provider keys on its Keys page.\n"
                "Or: sign in there, copy localStorage 'freellmapi_dashboard_token', then:  /llm token <token>"), 1
    env = {"FREELLMAPI_URL": ROOT_URL, "FREELLMAPI_DASHBOARD_TOKEN": tok}
    return run(["npx", "--yes", "freellmapi"] + args, timeout=timeout, env=env)


def need_installed():
    if installed():
        return True
    print(f"FreeLLMAPI is not installed at {INSTALL_DIR}.")
    print("See setup-notes.txt -> 'FREELLMAPI (no Docker)'.")
    return False


def set_env_var(name, value):
    """Upsert NAME=value in the bot .env (not secret: model/url only)."""
    lines = []
    try:
        with open(BOT_ENV) as f:
            lines = f.read().splitlines()
    except OSError:
        pass
    out, done = [], False
    for ln in lines:
        if ln.startswith(name + "="):
            out.append(f"{name}={value}")
            done = True
        else:
            out.append(ln)
    if not done:
        out.append(f"{name}={value}")
    with open(BOT_ENV, "w") as f:
        f.write("\n".join(out) + "\n")


def main():
    a = sys.argv[1:]
    cmd = a[0].lower() if a else "status"
    rest = a[1:]

    if cmd == "status":
        out, _ = run(["systemctl", "--user", "is-active", SERVICE], timeout=10)
        print(f"installed: {'yes' if installed() else 'NO'}  ({INSTALL_DIR})")
        print(f"service:   {out or 'unknown'}")
        print(f"reachable: {'yes' if reachable() else 'no'}  ({ROOT_URL})")
        on = os.path.exists(UNIFIED_FILE)
        off = os.path.exists(UNIFIED_OFF)
        print(f"bot uses gateway: {'ON' if on else ('OFF (disabled)' if off else 'OFF (no unified key)')}")
        print(f"unified key: {'saved' if (on or off) else 'missing'} | dashboard token: {'saved' if read(TOKEN_FILE) else 'missing'}")
        print(f"model: {os.getenv('FREELLMAPI_MODEL', 'auto')}")
    elif cmd in ("start", "stop", "restart"):
        if need_installed():
            out, rc = svc(cmd)
            print(out or f"{cmd}: ok" if rc == 0 else f"{cmd} failed:\n{out}")
    elif cmd == "log":
        n = 30
        if rest and rest[0].isdigit():
            n = max(1, min(int(rest[0]), 100))
        out, _ = run(["journalctl", "--user", "-u", SERVICE, "-n", str(n),
                      "--no-pager", "--no-hostname"], timeout=15)
        print(out[-1800:] or "(no log)")
    elif cmd == "keys":
        out, rc = cli(["keys", "list"])
        print(out[-1800:] or "(no keys)")
    elif cmd == "addkey":
        if len(rest) < 2 or not PLATFORM_RE.match(rest[0]):
            print("Usage: /llm addkey <platform> <provider-key>\nExample: /llm addkey groq gsk_xxx\n(platforms: groq, google, cerebras, openrouter, mistral, ...)")
            return
        out, rc = cli(["keys", "add", rest[0], "--key", rest[1]], timeout=60)
        # never echo the key back
        print((out.replace(rest[1], "***") or "done")[-1500:])
    elif cmd == "rmkey":
        if not rest or not PLATFORM_RE.match(rest[0]) or (len(rest) > 1 and not ID_RE.match(rest[1])):
            print("Usage: /llm rmkey <platform> [id]   (ids from /llm keys)")
            return
        args = ["keys", "remove", rest[0]] + (["--id", rest[1]] if len(rest) > 1 else [])
        out, rc = cli(args)
        print(out[-1500:] or "removed")
    elif cmd == "testkey":
        if not rest or not PLATFORM_RE.match(rest[0]) or (len(rest) > 1 and not ID_RE.match(rest[1])):
            print("Usage: /llm testkey <platform> [id]")
            return
        args = ["keys", "test", rest[0]] + (["--id", rest[1]] if len(rest) > 1 else [])
        out, rc = cli(args, timeout=90)
        print(out[-1500:] or ("healthy" if rc == 0 else "check failed"))
    elif cmd == "token":
        if not rest:
            print("Usage: /llm token <dashboard-session-token>\nGet it: open the dashboard, sign in, DevTools > Application > Local Storage > freellmapi_dashboard_token")
            return
        write_secret(TOKEN_FILE, rest[0])
        print("dashboard token saved (chmod 600). /llm keys to verify.")
    elif cmd == "unified":
        if not rest:
            print("Usage: /llm unified <freellmapi-unified-key>   (Keys page header in the dashboard)")
            return
        write_secret(UNIFIED_FILE, rest[0])
        if os.path.exists(UNIFIED_OFF):
            os.remove(UNIFIED_OFF)
        print("unified key saved -- ai_debug now uses the gateway for all AI calls.")
    elif cmd == "model":
        if not rest:
            print(f"model: {os.getenv('FREELLMAPI_MODEL', 'auto')}  (options: auto | auto:fast | auto:smart | auto:reliable | <model id>)")
            return
        m = rest[0]
        if not re.match(r"^[A-Za-z0-9_.:/\-]{1,80}$", m):
            print("invalid model id")
            return
        set_env_var("FREELLMAPI_MODEL", m)
        print(f"model set to '{m}' in .env -- used by the NEXT ai_debug run (no restart needed).")
    elif cmd == "on":
        if os.path.exists(UNIFIED_OFF) and not os.path.exists(UNIFIED_FILE):
            os.rename(UNIFIED_OFF, UNIFIED_FILE)
            print("gateway ENABLED for the bot.")
        elif os.path.exists(UNIFIED_FILE):
            print("gateway already enabled.")
        else:
            print("no unified key saved yet: /llm unified <key>")
    elif cmd == "off":
        if os.path.exists(UNIFIED_FILE):
            os.rename(UNIFIED_FILE, UNIFIED_OFF)
            print("gateway DISABLED for the bot -- /aidebug will not work until you /llm on.")
        else:
            print("gateway already disabled.")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()