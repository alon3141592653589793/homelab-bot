import os
import sys
import time
import json
import re
import subprocess
import requests
import api_manager
from datetime import datetime

try:
    import psutil
except ImportError:
    psutil = None

BOT_DIR = "/home/alon/secure-pi-bot"
SHM = "/dev/shm/pi-bot"
RATE_FILE = f"{SHM}/.ai_rate"
CONV_FILE = f"{SHM}/.ai_conversation.json"
SUMMARY_LOG = f"{SHM}/ai_summary_log.jsonl"
RATE_WINDOW = 300            # manual /aidebug cooldown (RAM-backed)
SILENCE = 20 * 60            # idle time before conversation is summarized+cleared

os.makedirs(SHM, exist_ok=True)

from dotenv import load_dotenv
load_dotenv(f"{BOT_DIR}/.env")
DISCORD_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
try:
    REPORT_CHANNEL_ID = int(os.getenv("REPORT_CHANNEL_ID", "0"))
except ValueError:
    REPORT_CHANNEL_ID = 0
try:
    with open("/home/alon/.secrets/gemini_key") as f:
        GEMINI_KEY = f.read().strip()
except OSError:
    print("FAILURE: /home/alon/.secrets/gemini_key not found.")
    sys.exit(1)

MODEL_PRIORITY = [
    "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.1-pro",
    "gemini-3-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite",
]

# ---- Mode parse ----
args = sys.argv[1:]
mode = "manual"
custom_model = None
if args and args[0].lower().startswith("gemini"):
    custom_model = args[0]; args = args[1:]
web = False
if "--web" in args:
    web = True; args = [a for a in args if a != "--web"]
if "--audit" in args:
    mode = "audit"; args = [a for a in args if a != "--audit"]
elif "--auto-error" in args:
    mode = "auto-error"; args = [a for a in args if a != "--auto-error"]
elif "--auto" in args:
    mode = "auto"; args = [a for a in args if a != "--auto"]
prompt = " ".join(args).strip()
if not prompt:
    prompt = {"manual":"Automatic diagnostic","auto":"Automatic diagnostic",
              "auto-error":"Automatic error diagnosis","audit":"Weekly scheduled audit"}[mode]
MODELS = [custom_model] if custom_model else MODEL_PRIORITY
AUTO_MODE = mode in ("auto", "audit", "auto-error")

# ---- Rate limit (skip for auto/audit) ----
now = time.time()
if not AUTO_MODE:
    try:
        with open(RATE_FILE) as f:
            last = float(f.read().strip() or "0")
        if now - last < RATE_WINDOW:
            print(f"Wait {int(RATE_WINDOW - (now - last))}s between /aidebug calls.")
            sys.exit(0)
    except (OSError, ValueError):
        pass
    with open(RATE_FILE, "w") as f:
        f.write(str(now))

# ---- Minifiers ----
def _mhz(s):
    try:
        return f"{int(s)//1000} MHz"
    except ValueError:
        return s

def _throttled(s):
    v = s.split("=")[-1].strip()
    try:
        code = int(v, 0)
    except ValueError:
        return s
    flags = []
    if code & 0x1: flags.append("under-voltage")
    if code & 0x2: flags.append("freq-capped")
    if code & 0x4: flags.append("throttled")
    if code & 0x10000: flags.append("was under-voltage")
    if code & 0x20000: flags.append("was freq-capped")
    if code & 0x40000: flags.append("was throttled")
    return "Throttled: " + (", ".join(flags) if flags else "no")

def minify_disk(s):
    rows = []
    for line in s.splitlines():
        p = line.split()
        if len(p) < 6 or p[0].startswith(("tmpfs", "devtmpfs", "overlay", "loop")):
            continue
        rows.append(f"{p[5]} {p[4]} used ({p[2]}/{p[1]}, {p[3]} free)")
    return "; ".join(rows) or "n/a"

def minify_mem(s):
    out = {}
    for line in s.splitlines():
        p = line.split()
        if p and p[0] == "Mem:" and len(p) >= 4:
            out["RAM"] = f"{p[2]}/{p[1]} used"
        elif p and p[0] == "Swap:" and len(p) >= 4:
            out["Swap"] = f"{p[2]}/{p[1]}"
    return "; ".join(f"{k}:{v}" for k, v in out.items()) or "n/a"

def minify_ps(s):
    rows = []
    for line in s.splitlines():
        p = line.split()
        if len(p) < 4:
            continue
        if p[1] == "ps":
            continue  # skip the ps snapshot itself — it shows a transient self-spike
        try:
            cpu = float(p[2]); mem = float(p[3])
        except ValueError:
            continue
        if cpu >= 10 or mem >= 5:
            rows.append(f"{p[1]}({p[0]}) {cpu}%cpu {mem}%mem")
    return "; ".join(rows) or "no heavy procs"

def minify_ip(s):
    rows = []
    for line in s.splitlines():
        if " inet " in line:
            rows.append(line.strip().split("inet ")[1].split()[0])
    return "; ".join(rows) or "n/a"

def minify_ss(s):
    rows = []
    for line in s.splitlines():
        p = line.split()
        if len(p) >= 5 and p[0] == "LISTEN":
            rows.append(f"{p[3]} {p[4]}")
    return "; ".join(rows) or "no listeners"

def _jsonl_tail(path, n=80):
    if not os.path.exists(path):
        return ""
    try:
        with open(path) as f:
            lines = [l.strip() for l in f if l.strip()]
    except OSError:
        return ""
    if not lines:
        return ""
    out = []
    for l in lines[-n:]:
        try:
            out.append(json.dumps(json.loads(l), separators=(",", ":")))
        except json.JSONDecodeError:
            out.append(l)
    return "\n".join(out)

def minify_sys_log(raw):
    s = (_jsonl_tail("/dev/shm/pi-bot/system_log.jsonl", 80)
         or _jsonl_tail("/home/alon/secure-pi-bot/logs/system_log.jsonl", 80))
    return s or "(no system_log yet)"

def minify_fan_log(raw):
    s = (_jsonl_tail("/dev/shm/pi-bot/fan_events.jsonl", 80)
         or _jsonl_tail("/home/alon/secure-pi-bot/logs/fan_events.jsonl", 80))
    return s or "(no fan_log yet)"

def psutil_resources(raw):
    if not psutil:
        return "(psutil unavailable)"
    vm = psutil.virtual_memory()
    parts = [f"RAM {vm.used//(1024**2)}/{vm.total//(1024**2)}M used ({vm.percent:.0f}%)"]
    sm = psutil.swap_memory()
    parts.append(f"Swap {sm.used//(1024**2)}/{sm.total//(1024**2)}M")
    for part in psutil.disk_partitions(all=False):
        if part.fstype == "tmpfs" or part.device.startswith("/dev/loop"):
            continue
        try:
            u = psutil.disk_usage(part.mountpoint)
        except OSError:
            continue
        parts.append(f"{part.mountpoint} {u.percent:.0f}% ({u.used/(1024**3):.1f}/{u.total/(1024**3):.1f}G)")
    parts.append(f"CPU {psutil.cpu_percent(interval=0.3)}%")
    return "; ".join(parts)

def psutil_procs(raw):
    if not psutil:
        return "(psutil unavailable)"
    procs = []
    for p in psutil.process_iter():
        try:
            procs.append((p, p.name(), p.pid))
            p.cpu_percent()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    time.sleep(0.2)
    rows = []
    for p, name, pid in procs:
        try:
            cpu = p.cpu_percent()
            mem = p.memory_percent()
            if cpu >= 10 or mem >= 5:
                rows.append(f"{name}({pid}) {cpu:.0f}%cpu {mem:.0f}%mem")
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return "; ".join(rows) or "no heavy procs"

def psutil_ports(raw):
    if not psutil:
        return "(psutil unavailable)"
    try:
        conns = psutil.net_connections(kind="inet")
    except (psutil.AccessDenied, PermissionError):
        return "(listening ports require root)"
    rows = []
    for c in conns:
        if c.status == psutil.CONN_LISTEN:
            laddr = f"{c.laddr.ip}:{c.laddr.port}" if c.laddr else "?"
            rows.append(f"{laddr} pid={c.pid}")
    return "; ".join(rows) or "no listeners"

def params_view(raw):
    BOT = "/home/alon/secure-pi-bot"; SHM = "/dev/shm/pi-bot"
    def ex(p): return os.path.exists(p)
    def rf(p, d=""):
        try:
            with open(p) as f: return f.read().strip()
        except OSError: return d
    out = []
    out.append("updates_reboot=" + ("DISABLED" if ex(f"{BOT}/.updates_disabled") else "enabled"))
    out.append("logger=" + ("ON" if ex(f"{BOT}/.logging_enabled") else "off"))
    out.append("weekly_report=" + ("DISABLED" if ex(f"{BOT}/.weekly_report_disabled") else "enabled"))
    out.append("maintenance=" + ("DISABLED" if ex(f"{BOT}/.maintenance_disabled") else "enabled"))
    ov = rf(f"{BOT}/.profile_override").lower()
    out.append("cpu_profile_override=" + (ov if ov in ("restricted", "unlimited") else "auto"))
    try:
        with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq") as f:
            out.append("max_freq=" + str(int(f.read().strip()) // 1000) + "MHz")
    except OSError:
        pass
    out.append("testall=" + ("IN_PROGRESS" if ex(f"{SHM}/.testall_running") else "idle"))
    out.append("thermal_alert=70C")
    return "; ".join(out)

INFO = {
    "system_status": (["systemctl", "is-system-running"], None),
    "running_services": (["systemctl", "list-units", "--type=service", "--state=running", "--no-legend"],
                         lambda s: "; ".join(l.split()[0] for l in s.splitlines() if l.strip())[:1500]),
    "timers": (["systemctl", "list-timers", "--all", "--no-legend"], None),
    "temp": (["vcgencmd", "measure_temp"], None),
    "throttled": (["vcgencmd", "get_throttled"], _throttled),
    "clock_arm": (["vcgencmd", "measure_clock", "arm"], None),
    "clock_core": (["vcgencmd", "measure_clock", "core"], None),
    "cpu_freq": (["cat", "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"], _mhz),
    "cpu_gov": (["cat", "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"], None),
    "resources": (["true"], psutil_resources),
    "parameters": (["true"], params_view),
    "load": (["cat", "/proc/loadavg"], None),
    "processes": (["true"], psutil_procs),
    "network": (["ip", "addr", "show"], minify_ip),
    "routes": (["ip", "route", "show"], None),
    "listening": (["true"], psutil_ports),
    "uname": (["uname", "-a"], None),
    "uptime": (["uptime"], None),
    "crontab": (["crontab", "-l"], None),
    "bot_state": (["ls", "-la", "/dev/shm/pi-bot/"], None),
    "log_system": (["true"], minify_sys_log),
    "log_fan": (["true"], minify_fan_log),
    "log_maintenance": (["sh", "-c", "tail -n 60 /dev/shm/pi-bot/maintenance.log 2>/dev/null"], None),
    "log_outage": (['sh', '-c', 'for f in /home/alon/secure-pi-bot/outage/*.jsonl; do echo "== $f =="; tail -n 20 "$f"; done 2>/dev/null'], None),
    "journal_errors": (["journalctl", "-p", "err", "-n", "20", "--no-pager"], None),
    "kernel": (["dmesg", "-T", "--level=err,warn", "-n", "15"], None),
    "lynis": (["lynis", "audit", "system", "--quick", "--no-colors"], "heavy"),
    "lynis_full": (["lynis", "audit", "system", "--no-colors"], "heavy"),
}

# Non-sensitive settings files the AI may read (curated; never secrets/env).
SAFE_SETTINGS = {
    "maintenance_script": "/usr/local/bin/pi-maintenance.sh",
    "audit_script": "/usr/local/bin/pi-audit.sh",
    "polkit_rules": "/etc/polkit-1/rules.d/49-pi-bot.rules",
    "udev_rules": "/etc/udev/rules.d/99-cpufreq.rules",
}

TOOL_NAMES = sorted(list(INFO.keys()) + list(SAFE_SETTINGS.keys()))

def fetch_source(src):
    if src in SAFE_SETTINGS:
        try:
            with open(SAFE_SETTINGS[src]) as f:
                return f.read()[:6000]
        except OSError as e:
            return f"(err: {e})"
    info = INFO.get(src)
    if not info:
        return f"(unknown source: {src})"
    cmd, m = info
    timeout = 180 if m == "heavy" else 6
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        raw = (r.stdout or r.stderr or "(empty)").strip()
    except Exception as e:
        return f"(err: {e})"
    if m == "heavy":
        return raw[:6000]
    if callable(m):
        return m(raw)
    return raw[:1200]

SVC_NAME_RE = re.compile(r"^[A-Za-z0-9@._\-]+$")

def handle_inspect_service(service, action, lines=50):
    if not service or not SVC_NAME_RE.match(service):
        return "(invalid service name)"
    action = (action or "status").lower()
    if action in ("status", "is-active", "is-enabled"):
        try:
            r = subprocess.run(["systemctl", action, "--no-pager", service],
                               capture_output=True, text=True, timeout=10)
            return (r.stdout or r.stderr or "(empty)").strip()[:1500]
        except Exception as e:
            return f"(err: {e})"
    if action == "logs":
        n = max(1, min(int(lines or 50), 200))
        try:
            r = subprocess.run(["journalctl", "-u", service, "-n", str(n),
                                "--no-pager", "--no-hostname"],
                               capture_output=True, text=True, timeout=15)
            return (r.stdout or r.stderr or "(empty)").strip()[:1500]
        except Exception as e:
            return f"(err: {e})"
    return f"(unknown action: {action})"

def red_flags():
    flags = []
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            t = int(f.read()) / 1000.0
        if t >= 70: flags.append(f"HIGH TEMP {t:.1f}C")
        elif t >= 60: flags.append(f"WARM {t:.1f}C")
        else: flags.append(f"temp {t:.1f}C")
    except OSError:
        pass
    if psutil:
        vm = psutil.virtual_memory()
        if vm.percent >= 90: flags.append(f"HIGH RAM {vm.percent:.0f}%")
        elif vm.percent >= 80: flags.append(f"ELEVATED RAM {vm.percent:.0f}%")
        for part in psutil.disk_partitions(all=False):
            if part.fstype == "tmpfs" or part.device.startswith("/dev/loop"):
                continue
            try:
                u = psutil.disk_usage(part.mountpoint)
            except OSError:
                continue
            if u.percent >= 90:
                flags.append(f"HIGH DISK {part.mountpoint} {u.percent:.0f}%")
    try:
        la = os.getloadavg()[0]
        cores = os.cpu_count() or 4
        if la > cores * 0.8:
            flags.append(f"HIGH LOAD {la:.2f}/{cores}c")
    except OSError:
        pass
    try:
        r = subprocess.run(["systemctl", "list-units", "--state=failed", "--no-legend", "--plain"],
                            capture_output=True, text=True, timeout=5)
        fams = [l.split()[0] for l in r.stdout.splitlines() if l.strip() and "clamav" not in l.split()[0]]
        if fams:
            flags.append("FAILED: " + " ".join(fams))
    except Exception:
        pass
    return flags

def build_context(audit):
    r = red_flags()
    out = ["RED FLAGS: " + (" | ".join(r) if r else "none")]
    if audit:
        out.append("FULL SYSTEM INFO (minified):")
        for name in INFO:
            if name == "lynis":
                continue
            out.append(f"$ {name}\n{fetch_source(name)}")
    return "\n".join(out)

# ---- Gemini call + tool loop ----
TOOL_DECL = [{"name": "get_info",
              "description": "Fetch a read-only diagnostic source by name. Call only when you need more detail than the context already gives. 'lynis' = quick audit; 'lynis_full' = COMPLETE audit (much longer).",
              "parameters": {"type": "object",
                             "properties": {"source": {"type": "string", "enum": TOOL_NAMES}},
                             "required": ["source"]}},
             {"name": "inspect_service",
              "description": "Read-only deep-dive on one specific systemd service: systemctl status / is-active / is-enabled, or recent journalctl logs. Use ONLY when the context flags a SPECIFIC failed service.",
              "parameters": {"type": "object",
                             "properties": {
                               "service": {"type": "string", "description": "systemd unit name (e.g. nginx.service)"},
                               "action": {"type": "string", "enum": ["status","is-active","is-enabled","logs"]},
                               "lines": {"type": "integer", "description": "recent journal lines (only for action=logs)", "minimum": 1, "maximum": 200}
                             },
                             "required": ["service","action"]}}]
TOOLS = [{"functionDeclarations": TOOL_DECL}]

SYS_INSTRUCT = ("You are the Pi diagnostic assistant for a Raspberry Pi home lab. "
                "Give a concise diagnosis citing exact metric values (temps, percentages, "
                "error strings, service names). Call get_info(source) for a read-only "
                "diagnostic only when the provided context lacks the detail you need. "
                "Call inspect_service(service, action) only to deep-dive a specific failed "
                "service the context already named. Never suggest destructive actions.")

def call_gemini(contents, models, use_tools=True, web=False, max_tokens=800, system=None):
    for model in models:
        payload = {"contents": contents, "generationConfig": {"maxOutputTokens": max_tokens, "temperature": 0.2}}
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        if web:
            payload["tools"] = [{"google_search": {}}]
        elif use_tools:
            payload["tools"] = TOOLS
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_KEY}"
        try:
            api_manager.rate_limit("gemini")
            resp = requests.post(url, json=payload, timeout=60)
            if resp.status_code in (429, 503):
                time.sleep(1.5); continue
            if resp.status_code == 400 and (use_tools or web):
                continue
            resp.raise_for_status()
            api_manager.record("gemini", True)
            return resp.json(), model
        except Exception:
            continue
    api_manager.record("gemini", False)
    return None, None

def gemini_text(prompt_text, models, max_tokens=300):
    resp, m = call_gemini([{"role": "user", "parts": [{"text": prompt_text}]}], models, use_tools=False, max_tokens=max_tokens)
    if not resp:
        return None, m
    parts = resp.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts if "text" in p).strip(), m

def diag_loop(context, question, models, max_rounds=4, tools=True, system=SYS_INSTRUCT, max_tokens=800):
    contents = [{"role": "user", "parts": [{"text": f"{question}\n\nContext:\n{context}"}]}]
    used = None
    for _ in range(max_rounds):
        resp, used = call_gemini(contents, models, use_tools=tools, system=system, max_tokens=max_tokens)
        if not resp:
            if tools:
                return diag_loop(context, question, models, max_rounds=1, tools=False, system=system, max_tokens=max_tokens)
            return None, used
        parts = resp.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        fn = [p for p in parts if "functionCall" in p]
        if not fn:
            return "".join(p.get("text", "") for p in parts if "text" in p).strip(), used
        contents.append({"role": "model", "parts": parts})
        fr = []
        for p in fn:
            if p["functionCall"]["name"] == "get_info":
                src = p["functionCall"].get("args", {}).get("source", "")
                fr.append({"functionResponse": {"name": "get_info", "response": {"source": src, "result": fetch_source(src)}}})
            elif p["functionCall"]["name"] == "inspect_service":
                a = p["functionCall"].get("args", {})
                svc = str(a.get("service", ""))
                act = str(a.get("action", "status"))
                lns = a.get("lines", 50)
                try:
                    lns = int(lns)
                except (TypeError, ValueError):
                    lns = 50
                fr.append({"functionResponse": {"name": "inspect_service",
                          "response": {"service": svc, "action": act,
                                       "result": handle_inspect_service(svc, act, lns)}}})
        contents.append({"role": "user", "parts": fr})
    return None, used

def load_conv():
    try:
        with open(CONV_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"messages": [], "last": 0}

def save_conv(c):
    with open(CONV_FILE, "w") as f:
        json.dump(c, f)

def post_discord(text):
    if os.getenv("PI_TEST_MODE") or not DISCORD_TOKEN:
        return
    for chunk in [text[i:i+1900] for i in range(0, len(text), 1900)]:
        try:
            requests.post(f"https://discord.com/api/v10/channels/{REPORT_CHANNEL_ID}/messages",
                          headers={"Authorization": f"Bot {DISCORD_TOKEN}"}, json={"content": chunk}, timeout=10)
        except Exception:
            pass

ts = datetime.now().strftime("%H:%M")
final_text = None
used_model = None

if mode == "manual":
    conv = load_conv()
    if conv["messages"] and (now - conv.get("last", 0)) > SILENCE:
        ct = "".join(f"{'U' if m['role']=='user' else 'A'}: {m['text'][:300]}\n" for m in conv["messages"])
        summ, _ = gemini_text(f"Summarize this Pi diagnostic chat in <300 chars:\n{ct}", MODELS)
        if summ:
            with open(SUMMARY_LOG, "a") as f:
                f.write(json.dumps({"ts": datetime.now().isoformat(timespec="seconds"), "summary": summ, "n": len(conv["messages"])}) + "\n")
            print(f"Observation: previous conversation summarized -> log.\n")
        conv = {"messages": [], "last": 0}
    conv_ctx = ""
    if conv["messages"]:
        conv_ctx = "Previous conversation:\n"
        for m in conv["messages"][-6:]:
            conv_ctx += f"{'U' if m['role']=='user' else 'A'}: {m['text'][:300]}\n"
        conv_ctx += "\n"
    final_text, used_model = diag_loop(conv_ctx + build_context(audit=False), prompt, MODELS, max_tokens=600)
    if final_text:
        conv["messages"].append({"role": "user", "text": prompt})
        conv["messages"].append({"role": "assistant", "text": final_text})
        conv["last"] = time.time()
        save_conv(conv)

elif mode == "audit":
    context = build_context(audit=True)
    main_review, used_model = diag_loop(context, "Weekly system audit. Summarize health, list concerns with exact values, recommend actions.", MODELS, max_tokens=1500)
    lyn = fetch_source("lynis")
    sec_review, _ = diag_loop(f"Previous audit:\n{main_review or ''}\n\nLYNIS (heavy) output:\n{lyn}",
                             "Given the weekly audit and this Lynis output, review security posture for the week; note whether things improved or worsened, citing specific warnings.", MODELS, max_rounds=3, max_tokens=1000)
    final_text = (main_review or "(no audit)") + "\n\n=== LYNIS WEEKLY REVIEW ===\n" + (sec_review or "(no review)")
    post_discord(f"**Weekly AI Audit** [{ts}]\n{final_text}")

elif mode == "auto":
    if web:
        resp, used_model = call_gemini([{"role": "user", "parts": [{"text": prompt}]}], MODELS, use_tools=False, web=True, max_tokens=1000)
        if resp:
            parts = resp.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            final_text = "".join(p.get("text", "") for p in parts if "text" in p).strip()
    else:
        final_text, used_model = diag_loop("", prompt, MODELS)

elif mode == "auto-error":
    focused = build_context(audit=False)
    final_text, used_model = diag_loop(focused, f"Automatic error diagnosis. Trigger: {prompt}. Identify root cause and likely fix, citing exact values. If the trigger names a specific failed service, call inspect_service(service, 'status' or 'logs') for its details before concluding.", MODELS)
    post_discord(f"**Auto-Diagnosis** [{ts}] trigger: {prompt}\n{final_text}")

if final_text:
    print(f"**AI Debug** [{ts}] mode={mode} model={used_model}\n{final_text}")
else:
    print(f"**AI Debug** [{ts}] mode={mode} — no response (all models failed).")