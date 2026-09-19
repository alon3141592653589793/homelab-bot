#!/usr/bin/env python3
"""Mirror a HuggingFace model file to Gofile, STREAMED through RAM.

The model NEVER touches the SD card and NEVER sits whole in RAM. A background
thread downloads the source into one end of an OS pipe; the upload generator
reads the other end and POSTs it to Gofile with chunked transfer-encoding, so
RAM stays ~pipe size (a few MB) no matter how big the file is. sha256 is hashed
on the fly during the download and verified against HuggingFace's LFS oid at
the end. Only a tiny manifest is kept on the Pi.

Usage (Discord / SSH):
  /gofile ollama run hf.co/OBLITERATUS/Qwen3.8-27B-OBLITERATED:Q4_K_M
  python3 gofile_mirror.py ollama run hf.co/OWNER/REPO:TAG
  python3 gofile_mirror.py OWNER/REPO:TAG
  python3 gofile_mirror.py --repo OWNER/REPO --file model.gguf   # legacy explicit

Setup: Gofile token at ~/.secrets/gofile_token (chmod 600). Get it from
https://gofile.io/myprofile. pip3 install --user requests

NOTE: because the upload streams before the full sha256 is known, a corrupt
source upload can't be prevented -- it's detected after the fact. "Vibe
coding": we warn if the post-upload sha mismatches HF's oid.
"""
import os
import sys
import json
import time
import hashlib
import argparse
import threading
import datetime as dt
from datetime import datetime

try:
    import requests
except ImportError:
    print("FAILURE: requests missing. pip3 install --user requests")
    sys.exit(1)

TOKEN_FILE = os.path.expanduser("~/.secrets/gofile_token")
MANIFEST_DIR = "/home/alon/secure-pi-bot/gofile_mirror"
MANIFEST_FILE = os.path.join(MANIFEST_DIR, "manifest.json")
HF_BASE = "https://huggingface.co"
UPLOAD_URL = "https://upload.gofile.io/uploadfile"
CHUNK = 1024 * 1024  # 1 MB -- bounds RAM via the pipe + chunk
MAX_RETRY = 4
BOUNDARY = "----pi-bot-gofile-8b3c1f"

DEFAULT_REPO = "prajjwal1/bert-tiny"
DEFAULT_FILE = "pytorch_model.bin"


def load_token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except OSError:
        print(f"FAILURE: no Gofile token at {TOKEN_FILE} (chmod 600).")
        print("Grab one at https://gofile.io/myprofile and: echo 'TOKEN' > ~/.secrets/gofile_token; chmod 600 ~/.secrets/gofile_token")
        sys.exit(1)


def load_discord_token():
    try:
        from dotenv import load_dotenv
        load_dotenv("/home/alon/secure-pi-bot/.env")
    except Exception:
        pass
    return os.getenv("DISCORD_BOT_TOKEN", "")


def post_channel(channel_id, text, token=None):
    """Post text to a Discord channel (chunked to 1900 chars). Silent on failure."""
    if not channel_id:
        return
    if token is None:
        token = load_discord_token()
    if not token:
        return
    url = f"https://discord.com/api/v10/channels/{int(channel_id)}/messages"
    hdr = {"Authorization": f"Bot {token}", "Content-Type": "application/json"}
    for chunk in [text[i:i + 1900] for i in range(0, len(text), 1900)]:
        try:
            requests.post(url, json={"content": chunk}, headers=hdr, timeout=10)
        except Exception:
            pass


def parse_ref(words):
    """Parse a model ref into (repo, tag_or_file).
    Accepts: 'ollama run hf.co/OWNER/REPO:TAG' | 'OWNER/REPO:TAG' | 'OWNER/REPO FILE'.
    Returns (repo, tag, explicit_file) or (None, None, None)."""
    toks = [t for t in words if t]
    while toks and toks[0].lower() in ("ollama", "run", "pull"):
        toks.pop(0)
    if not toks:
        return None, None, None
    ref = " ".join(toks).strip()
    ref = ref.replace("https://huggingface.co/", "").replace("hf.co/", "")
    if " " in ref:
        repo, fname = ref.split(" ", 1)
        return repo.strip(), fname.strip(), True
    if ":" in ref:
        repo, tag = ref.split(":", 1)
        return repo.strip(), tag.strip(), False
    return ref.strip(), None, None


def resolve_file(repo, rev, tag, explicit_file):
    """Find the file in the HF repo tree. Returns (filename, size, lfs_sha).
    If explicit_file given, match it exactly. Else match tag as a substring
    (case-insensitive), preferring .gguf > .safetensors > .bin."""
    try:
        r = requests.get(f"{HF_BASE}/api/models/{repo}/tree/{rev}", timeout=30)
        r.raise_for_status()
        entries = r.json()
    except Exception as e:
        print(f"FAILURE: could not list HF repo {repo} ({e}).")
        return None, None, None

    if explicit_file:
        for e in entries:
            if e.get("path") == tag:
                lfs = e.get("lfs") or {}
                return e.get("path"), e.get("size"), lfs.get("oid")
        print(f"FAILURE: file '{tag}' not found in {repo}.")
        return None, None, None

    if tag:
        tl = tag.lower()
        cands = [e for e in entries if isinstance(e, dict) and tl in e.get("path", "").lower()]
    else:
        cands = [e for e in entries if isinstance(e, dict)]
    if not cands:
        print(f"FAILURE: no file matching '{tag}' in {repo}.")
        return None, None, None
    for ext in (".gguf", ".safetensors", ".bin"):
        for e in cands:
            p = e.get("path", "")
            if p.lower().endswith(ext):
                lfs = e.get("lfs") or {}
                return p, e.get("size"), lfs.get("oid")
    # fallback: first candidate with an extension
    for e in cands:
        p = e.get("path", "")
        if "." in os.path.basename(p):
            lfs = e.get("lfs") or {}
            return p, e.get("size"), lfs.get("oid")
    print(f"FAILURE: could not resolve a real file in {repo} for '{tag}'.")
    return None, None, None


def stream_to_gofile(source_url, token, fname, folder_id=None, size_acc=None):
    """Download source_url and upload to Gofile in one streamed pass.
    RAM stays ~pipe size. Returns (sha256_hex, bytes, gofile_response_dict) or
    raises on fatal error. size_acc (a [int] list) is mutated live so an
    external progress reporter can read bytes-so-far."""
    sha = hashlib.sha256()
    if size_acc is None:
        size_acc = [0]
    dl_error = {}

    try:
        import fcntl
    except ImportError:
        fcntl = None

    r_fd, w_fd = os.pipe()
    if fcntl:
        try:
            # enlarge the kernel pipe buffer (~1MB) for throughput
            fcntl.fcntl(r_fd, 1031, 1 << 20)  # F_SETPIPE_SZ
        except OSError:
            pass
    r = os.fdopen(r_fd, "rb")
    w = os.fdopen(w_fd, "wb")
    stop = threading.Event()

    def downloader():
        try:
            with requests.get(source_url, stream=True, timeout=120) as resp:
                resp.raise_for_status()
                for chunk in resp.iter_content(chunk_size=CHUNK):
                    if stop.is_set():
                        break
                    if not chunk:
                        continue
                    sha.update(chunk)
                    size_acc[0] += len(chunk)
                    try:
                        w.write(chunk)
                    except (BrokenPipeError, OSError):
                        break
        except Exception as e:
            dl_error["e"] = e
        finally:
            try:
                w.close()
            except OSError:
                pass

    t = threading.Thread(target=downloader, daemon=True)
    t.start()

    def body_gen():
        parts = []
        if folder_id:
            parts.append(f"--{BOUNDARY}\r\n".encode())
            parts.append(b'Content-Disposition: form-data; name="folderId"\r\n\r\n')
            parts.append(f"{folder_id}\r\n".encode())
        parts.append(f"--{BOUNDARY}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="file"; filename="{fname}"\r\n'.encode())
        parts.append(b"Content-Type: application/octet-stream\r\n\r\n")
        for p in parts:
            yield p
        while True:
            chunk = r.read(CHUNK)
            if not chunk:
                break
            yield chunk
        yield f"\r\n--{BOUNDARY}--\r\n".encode()

    headers = {"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        up = requests.post(UPLOAD_URL, headers=headers, data=body_gen(), timeout=14400)
        up.raise_for_status()
        try:
            body = up.json()
        except Exception:
            body = {}
        if body.get("status") != "ok":
            raise RuntimeError(f"Gofile rejected upload: {body}")
        return sha.hexdigest(), size_acc[0], body["data"]
    finally:
        stop.set()
        try:
            r.close()
        except OSError:
            pass
        t.join(timeout=30)
        if dl_error.get("e") and not stop.is_set():
            raise dl_error["e"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ref", nargs="*", help="model ref, e.g. 'ollama run hf.co/OWNER/REPO:TAG'")
    ap.add_argument("--repo", default=None)
    ap.add_argument("--file", default=None)
    ap.add_argument("--rev", default="main")
    ap.add_argument("--folder", default=None, help="Gofile folder id to upload into")
    ap.add_argument("--retry", default=str(MAX_RETRY))
    ap.add_argument("--progress", type=int, default=None, help="progress report interval in minutes (Discord)")
    ap.add_argument("--channel", default=None, help="Discord channel id to report to")
    args = ap.parse_args()

    token = load_token()
    os.makedirs(MANIFEST_DIR, exist_ok=True)
    channel = args.channel
    dtoken = load_discord_token() if channel else None

    def report(text):
        # When driven from Discord (--channel), post to the channel and keep
        # stdout quiet (one final line for run_script). When run from SSH, just
        # print to stdout.
        if channel:
            post_channel(channel, text, dtoken)
        else:
            print(text)

    if args.repo and args.file:
        repo, filename, rev = args.repo, args.file, args.rev
    else:
        repo, tag, explicit = parse_ref(args.ref)
        if not repo:
            report("Usage: /gofile [minutes] ollama run hf.co/OWNER/REPO:TAG  (or OWNER/REPO:TAG)")
            sys.exit(1)
        filename, hf_size, hf_sha = resolve_file(repo, args.rev, tag, explicit)
        if not filename:
            sys.exit(1)
        rev = args.rev

    source_url = f"{HF_BASE}/{repo}/resolve/{rev}/{filename}"
    hf_sha = None
    hf_size = None
    try:
        mr = requests.get(f"{HF_BASE}/api/models/{repo}/tree/{rev}", timeout=30)
        if mr.status_code == 200:
            for e in mr.json():
                if e.get("path") == filename:
                    lfs = e.get("lfs") or {}
                    hf_sha = lfs.get("oid")
                    hf_size = e.get("size")
                    break
    except Exception:
        pass

    report(f"Mirroring {repo}/{filename} -> Gofile (streamed, RAM-only)")
    report(f"Size: {hf_size} bytes" if hf_size else "Size: (unknown)")

    t0 = time.time()
    size_acc = [0]
    stop_ev = threading.Event()

    # periodic progress reporter: only when a --progress interval (minutes) is given
    if channel and args.progress:
        def progress_loop():
            interval = max(1, args.progress) * 60
            while not stop_ev.wait(interval):
                got = size_acc[0]
                elapsed = time.time() - t0
                rate = got / elapsed if elapsed else 0
                line = f"[gofile] {got/1e6:.1f} MB / {elapsed/60:.1f} min ({rate/1e6:.2f} MB/s)"
                if hf_size and rate > 0:
                    eta = (hf_size - got) / rate
                    line += f"  ETA {eta/60:.0f} min  ({100*got/hf_size:.0f}%)"
                post_channel(channel, line, dtoken)
        threading.Thread(target=progress_loop, daemon=True).start()

    try:
        local_sha, total, gf = stream_to_gofile(source_url, token, filename, folder_id=args.folder, size_acc=size_acc)
    except Exception as e:
        stop_ev.set()
        report(f"FAILURE: mirror failed -> {e}")
        sys.exit(1)
    stop_ev.set()

    elapsed = time.time() - t0
    rate = (total / 1e6 / elapsed) if elapsed else 0
    gf_md5 = gf.get("md5")
    page = gf.get("downloadPage")
    if hf_sha and local_sha == hf_sha:
        verify = "OK -- matches HuggingFace LFS sha256"
    elif hf_sha:
        verify = f"MISMATCH -- HF {hf_sha[:16]}... vs ours {local_sha[:16]}... (source may be corrupt)"
    else:
        verify = "(no LFS sha256 from HF; uploaded as-is)"

    summary = (
        f"Done: {total/1e6:.1f} MB in {elapsed/60:.1f} min ({rate:.1f} MB/s)\n"
        f"Link: {page}\n"
        f"sha256: {local_sha}\n"
        f"Verify: {verify}"
    )
    report(summary)

    manifest = {}
    if os.path.exists(MANIFEST_FILE):
        try:
            with open(MANIFEST_FILE) as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}
    manifest[f"{repo}/{filename}"] = {
        "repo": repo, "file": filename, "rev": rev,
        "source_url": source_url,
        "gofile_id": gf.get("id"), "gofile_code": gf.get("code"),
        "gofile_page": page, "gofile_parent": gf.get("parentFolder"),
        "md5_gofile": gf_md5, "sha256": local_sha, "size": total,
        "mirrored_at": datetime.now().isoformat(timespec="seconds"),
        "last_verified": None, "downloads": 0,
    }
    try:
        with open(MANIFEST_FILE, "w") as f:
            json.dump(manifest, f, indent=2)
    except OSError:
        pass
    if channel:
        print("Done — summary posted in channel.")


if __name__ == "__main__":
    main()