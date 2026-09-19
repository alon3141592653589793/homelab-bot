#!/usr/bin/env python3
"""Free rotating proxy pool for outbound HTTP calls.

Goal: route small API calls (HuggingFace metadata, Gemini, Google, Gofile
content API, ...) through rotating free proxies so the Pi's home IP isn't
fingerprinted and rate-limits spread across many exit IPs. Large model
transfers stay direct -- free proxies can't reliably move 15GB -- this pool
is for small, latency-tolerant calls.

State lives in /dev/shm so every cron'd script shares one pool without
re-fetching. A refresh job (cron every 6h) re-pulls a fresh free list and
tests candidates.

Usage from other scripts:
    import proxy_pool
    r = proxy_pool.get(url, timeout=20, headers=...)   # tries proxies, then direct
    s = proxy_pool.session()                           # requests.Session w/ a live proxy

CLI:
    python3 proxy_pool.py --status      # show alive/dead + age
    python3 proxy_pool.py --refresh     # force re-fetch + test (slow, ~1-2 min)
"""
import os
import sys
import json
import time
import random
import threading

try:
    import requests
except ImportError:
    print("requests missing. pip3 install --user requests")
    sys.exit(1)

SHM = "/dev/shm/pi-bot"
POOL_FILE = os.path.join(SHM, "proxy_pool.json")
MANUAL_FILE = os.path.expanduser("~/.secrets/proxy_list.txt")  # optional: your own, one per line
FREE_LIST_URLS = [
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
]
TIMEOUT_TEST = 6
MAX_ALIVE = 60
REFRESH_MIN = 360  # 6h
_lock = threading.Lock()


def _ensure_dir():
    try:
        os.makedirs(SHM, exist_ok=True)
    except OSError:
        pass


def _load():
    try:
        with open(POOL_FILE) as f:
            return json.load(f)
    except Exception:
        return {"proxies": [], "fetched": 0, "dead": []}


def _save(d):
    _ensure_dir()
    try:
        with open(POOL_FILE, "w") as f:
            json.dump(d, f)
    except OSError:
        pass


def _fetch_free_list():
    out = []
    for url in FREE_LIST_URLS:
        try:
            r = requests.get(url, timeout=20)
            if r.status_code == 200:
                for line in r.text.splitlines():
                    line = line.strip()
                    if line and ":" in line and not line.startswith("#"):
                        out.append(line if line.startswith("http") else f"http://{line}")
        except Exception:
            continue
    return out


def _load_manual():
    try:
        with open(MANUAL_FILE) as f:
            return [l.strip() for l in f if l.strip() and not l.startswith("#")]
    except OSError:
        return []


def _test(proxy):
    try:
        r = requests.get("https://www.google.com/generate_204",
                         proxies={"http": proxy, "https": proxy}, timeout=TIMEOUT_TEST)
        return r.status_code in (204, 200)
    except Exception:
        return False


def refresh(force=False, test=True):
    """Rebuild the pool. With test=True, validate candidates (slow ~1-2 min).
    force=False only refreshes if older than REFRESH_MIN."""
    with _lock:
        d = _load()
        age = time.time() - d.get("fetched", 0)
        if not force and d.get("proxies") and age < REFRESH_MIN * 60:
            return d
        cands = _load_manual() + _fetch_free_list()
        random.shuffle(cands)
        alive = []
        if test:
            for p in cands[:140]:
                if len(alive) >= MAX_ALIVE:
                    break
                if _test(p):
                    alive.append(p)
        else:
            alive = cands[:MAX_ALIVE]
        d = {"proxies": alive, "fetched": time.time(), "dead": [],
             "source": "free+manual" if _load_manual() else "free"}
        _save(d)
        return d


def status():
    d = _load()
    return {"alive": len(d.get("proxies", [])),
            "dead": len(d.get("dead", [])),
            "age_min": int((time.time() - d.get("fetched", 0)) / 60) if d.get("fetched") else None}


def _pick():
    d = _load()
    ps = [p for p in d.get("proxies", []) if p not in d.get("dead", [])]
    return random.choice(ps) if ps else None


def _mark_dead(proxy):
    if not proxy:
        return
    d = _load()
    if proxy not in d.get("dead", []):
        d.setdefault("dead", []).append(proxy)
        d["proxies"] = [p for p in d.get("proxies", []) if p != proxy]
        _save(d)


def session():
    """A requests.Session with a live proxy, or a plain session (direct) if empty."""
    s = requests.Session()
    p = _pick()
    if p:
        s.proxies.update({"http": p, "https": p})
    return s


def get(url, timeout=20, **kw):
    """GET with proxy rotation; falls back to direct if all proxies fail."""
    d = _load()
    ps = [p for p in d.get("proxies", []) if p not in d.get("dead", [])]
    for p in ps[:5]:
        try:
            r = requests.get(url, proxies={"http": p, "https": p}, timeout=timeout, **kw)
            if r.status_code < 500:
                return r
        except Exception:
            _mark_dead(p)
    return requests.get(url, timeout=timeout, **kw)


def main():
    args = sys.argv[1:]
    if "--status" in args:
        s = status()
        print(f"Proxy pool: {s['alive']} alive, {s['dead']} dead")
        print(f"Age: {s['age_min']} min" if s["age_min"] is not None else "Not built yet. Run /proxy refresh.")
        return
    if "--refresh" in args:
        print("Refreshing proxy pool (fetching + testing, ~1-2 min)...")
        d = refresh(force=True, test=True)
        print(f"Done. {len(d.get('proxies', []))} alive proxies.")
        return
    refresh(force=False, test=False)


if __name__ == "__main__":
    main()