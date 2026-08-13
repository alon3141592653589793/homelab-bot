const entry = {
  id: "api-manager",
  filename: "api_manager.py",
  path: "~/secure-pi-bot/scripts/api_manager.py",
  description: "Cross-script API coordinator shared by every script that calls an external API. rate_limit(provider) serializes calls across processes via flock on /dev/shm, so two scripts hitting the same provider near-simultaneously never exceed that provider's per-second budget. critical_op() holds a shutdown-sensitive lock that restart/shutdown/maintenance wait on before rebooting. queue_outage()/drain_outage() write pending payloads to an SD-card buffer when a cloud call fails, so outage_drain.py replays them later. record(provider, ok)/api_fail_week() keep a 7-day rolling RAM log of API call outcomes, surfaced by api_fail_report.py (/apifails). Also a small with_retry() backoff helper.",
  tags: ["api", "ratelimit", "outage", "shutdown", "shared"],
  code: `import os
import time
import json
import fcntl
import contextlib

SHM = "/dev/shm/pi-bot"
MGR_LOCK = f"{SHM}/.api_manager.lock"
CRITICAL_LOCK = f"{SHM}/.critical_ops.lock"
# Dedicated lock for the outage buffer, SEPARATE from MGR_LOCK. drain_outage
# holds this while reading/clearing the buffer, then RELEASES it before
# calling handlers (which call rate_limit -> MGR_LOCK). Sharing MGR_LOCK here
# caused a re-entrant deadlock: drain held MGR_LOCK, the handler called
# rate_limit which blocked on MGR_LOCK forever, so the lock was never
# released and EVERY other script hung on rate_limit.
OUTAGE_LOCK = f"{SHM}/.outage.lock"
OUTAGE_DIR = "/home/alon/secure-pi-bot/outage"

os.makedirs(SHM, exist_ok=True)
os.makedirs(OUTAGE_DIR, exist_ok=True)

# Min seconds between consecutive calls to each provider (enforced across
# every process that imports this module).
API_LIMITS = {"gemini": 1.0, "gsheets": 0.4, "gdrive": 0.25}


def rate_limit(provider, min_gap=None):
    """Serialize a call across processes so two scripts firing the same
    provider near-simultaneously stay under its per-second budget."""
    gap = min_gap if min_gap is not None else API_LIMITS.get(provider, 0.25)
    stamp = f"{SHM}/.api_last_{provider}"
    lockf = open(MGR_LOCK, "a")
    fcntl.flock(lockf, fcntl.LOCK_EX)
    try:
        last = 0.0
        try:
            with open(stamp) as f:
                last = float(f.read().strip() or "0")
        except (OSError, ValueError):
            pass
        wait = gap - (time.time() - last)
        if wait > 0:
            time.sleep(wait)
        with open(stamp, "w") as f:
            f.write(str(time.time()))
    finally:
        fcntl.flock(lockf, fcntl.LOCK_UN)
        lockf.close()


@contextlib.contextmanager
def critical_op():
    """Lock held while a shutdown-sensitive operation runs. restart /
    shutdown / maintenance call wait_critical() before rebooting so an
    in-flight log sync or Drive upload finishes first."""
    lockf = open(CRITICAL_LOCK, "a")
    fcntl.flock(lockf, fcntl.LOCK_EX)
    try:
        yield
    finally:
        fcntl.flock(lockf, fcntl.LOCK_UN)
        lockf.close()


def wait_critical(max_wait=60):
    """Block until no script holds the critical-op lock, or max_wait passes.
    True = lock was free, False = timed out (proceed anyway)."""
    deadline = time.time() + max_wait
    lockf = open(CRITICAL_LOCK, "a")
    try:
        while time.time() < deadline:
            try:
                fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(lockf, fcntl.LOCK_UN)
                return True
            except BlockingIOError:
                time.sleep(2)
        return False
    finally:
        lockf.close()


def queue_outage(provider, kind, payload):
    """Append a pending item to the SD-card outage buffer for later retry."""
    lockf = open(OUTAGE_LOCK, "a")
    fcntl.flock(lockf, fcntl.LOCK_EX)
    try:
        with open(f"{OUTAGE_DIR}/{provider}.jsonl", "a") as f:
            f.write(json.dumps({"kind": kind, "payload": payload, "ts": time.time()}) + "\\n")
    finally:
        fcntl.flock(lockf, fcntl.LOCK_UN)
        lockf.close()


def drain_outage(provider, handle):
    """Replay each buffered item through handle(item)->bool. Successful items
    are removed; failures stay queued. Returns count drained.

    Locking: reads + clears the buffer under OUTAGE_LOCK, then RELEASES the
    lock before calling handlers (which call rate_limit -> MGR_LOCK). Failed
    items are re-appended under OUTAGE_LOCK. This avoids the re-entrant
    deadlock that happened when drain held MGR_LOCK while a handler tried to
    acquire MGR_LOCK via rate_limit -- which blocked forever and pinned the
    lock so every other script hung.
    """
    path = f"{OUTAGE_DIR}/{provider}.jsonl"
    if not os.path.exists(path):
        return 0
    lockf = open(OUTAGE_LOCK, "a")
    fcntl.flock(lockf, fcntl.LOCK_EX)
    try:
        items = []
        with open(path) as f:
            for ln in f:
                ln = ln.strip()
                if ln:
                    try:
                        items.append(json.loads(ln))
                    except json.JSONDecodeError:
                        continue
        # Clear the buffer now (under the lock). Items that fail to drain
        # below are re-appended; items appended by queue_outage during
        # processing land in the cleared file and are preserved.
        open(path, "w").close()
    finally:
        fcntl.flock(lockf, fcntl.LOCK_UN)
        lockf.close()
    # Handlers run OUTSIDE any lock so they can call rate_limit freely.
    remaining, drained = [], 0
    for it in items:
        try:
            if handle(it):
                drained += 1
                continue
        except Exception:
            pass
        remaining.append(it)
    if remaining:
        lockf = open(OUTAGE_LOCK, "a")
        fcntl.flock(lockf, fcntl.LOCK_EX)
        try:
            with open(path, "a") as f:
                for it in remaining:
                    f.write(json.dumps(it) + "\\n")
        finally:
            fcntl.flock(lockf, fcntl.LOCK_UN)
            lockf.close()
    return drained


def with_retry(fn, retries=3, base=1.0):
    """Call fn with exponential backoff; raises the last exception on failure."""
    last = None
    for i in range(retries):
        try:
            return fn()
        except Exception as e:
            last = e
            if i < retries - 1:
                time.sleep(base * (2 ** i))
    raise last


WEEK_SECONDS = 7 * 86400
API_LOG = f"{SHM}/api_calls.jsonl"


def record(provider, ok):
    """Append one API call outcome to the RAM log, pruning entries older
    than a week. Called by every script after an external API call so the
    /apifails command can report a 7-day failure rate per provider."""
    lockf = open(MGR_LOCK, "a")
    fcntl.flock(lockf, fcntl.LOCK_EX)
    try:
        lines = []
        try:
            with open(API_LOG) as f:
                lines = [l.strip() for l in f if l.strip()]
        except OSError:
            pass
        cutoff = time.time() - WEEK_SECONDS
        kept = []
        for l in lines:
            try:
                if json.loads(l).get("ts", 0) >= cutoff:
                    kept.append(l)
            except (json.JSONDecodeError, ValueError):
                continue
        kept.append(json.dumps({"ts": time.time(), "provider": provider, "ok": bool(ok)}))
        if len(kept) > 5000:
            kept = kept[-5000:]
        with open(API_LOG, "w") as f:
            f.write("\\n".join(kept) + "\\n")
    finally:
        fcntl.flock(lockf, fcntl.LOCK_UN)
        lockf.close()


def api_fail_week():
    """Return {provider: {ok, fail}} for the last 7 days from the RAM log."""
    cutoff = time.time() - WEEK_SECONDS
    stats = {}
    try:
        with open(API_LOG) as f:
            for l in f:
                l = l.strip()
                if not l:
                    continue
                try:
                    e = json.loads(l)
                except json.JSONDecodeError:
                    continue
                if e.get("ts", 0) < cutoff:
                    continue
                p = e.get("provider", "?")
                s = stats.setdefault(p, {"ok": 0, "fail": 0})
                if e.get("ok"):
                    s["ok"] += 1
                else:
                    s["fail"] += 1
    except OSError:
        pass
    return stats
`,
};

export default entry;