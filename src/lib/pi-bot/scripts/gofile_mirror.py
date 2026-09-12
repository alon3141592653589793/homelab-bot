#!/usr/bin/env python3
"""
Mirror a HuggingFace model file to Gofile (cloud-to-cloud, via Pi RAM staging).
The model NEVER touches the Pi's SD card -- it lands in /dev/shm (tmpfs), is
verified, uploaded, then wiped. Only a tiny manifest is kept on the Pi.

Anti-censorship: if the source host removes the file, the verified Gofile copy
(pre-share link) survives.

Setup:
  - Gofile token at ~/.secrets/gofile_token (chmod 600). Get it from
    https://gofile.io/myprofile  (guest or email account).
  - pip3 install --user requests

Usage (defaults to a ~17MB tiny BERT so you can test the whole pipeline):
  python3 gofile_mirror.py
  python3 gofile_mirror.py --repo gpt2 --file model.safetensors --rev main
"""
import os
import sys
import json
import time
import shutil
import hashlib
import argparse
from datetime import datetime

try:
    import requests
except ImportError:
    print("FAILURE: requests missing. pip3 install --user requests")
    sys.exit(1)

TOKEN_FILE = os.path.expanduser("~/.secrets/gofile_token")
STAGING_DIR = "/dev/shm/pi-bot/gofile_staging"
MANIFEST_DIR = "/home/alon/secure-pi-bot/gofile_mirror"
MANIFEST_FILE = os.path.join(MANIFEST_DIR, "manifest.json")
HF_BASE = "https://huggingface.co"
UPLOAD_URL = "https://upload.gofile.io/uploadfile"
CHUNK = 1024 * 1024  # 1 MB streaming buffer -- keeps RAM use tiny
MAX_RETRY = 4

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


def hf_meta(repo, filename, rev="main"):
    """Return (size, sha256) for a file in an HF repo, from the tree API.
    LFS files carry lfs.oid == the content's sha256 (what we verify against)."""
    r = requests.get(f"{HF_BASE}/api/models/{repo}/tree/{rev}", timeout=30)
    r.raise_for_status()
    for e in r.json():
        if e.get("path") == filename:
            lfs = e.get("lfs") or {}
            return e.get("size"), lfs.get("oid")
    raise SystemExit(f"FAILURE: '{filename}' not found in {repo} (rev {rev}).")


def resumable_download(url, dest):
    """HTTP-Range resumable download into dest (tmpfs). Streams in 1MB chunks so
    RAM stays ~1MB. Returns (sha256, md5, size)."""
    sha = hashlib.sha256()
    md5 = hashlib.md5()
    have = 0
    if os.path.exists(dest):
        have = os.path.getsize(dest)
        with open(dest, "rb") as f:
            while True:
                b = f.read(CHUNK)
                if not b:
                    break
                sha.update(b)
                md5.update(b)
    headers = {"Range": f"bytes={have}-"} if have else {}
    with requests.get(url, headers=headers, stream=True, timeout=60) as r:
        r.raise_for_status()
        # If the server ignored Range (returned 200, not 206), restart from 0
        # instead of appending a second copy.
        if have and r.status_code == 200:
            have = 0
            sha = hashlib.sha256()
            md5 = hashlib.md5()
        cr = r.headers.get("Content-Range", "")
        total = (int(cr.split("/")[-1]) if "/" in cr else int(r.headers.get("Content-Length", 0)))
        mode = "ab" if (have and r.status_code == 206) else "wb"
        with open(dest, mode) as f:
            recv = have
            last = time.time()
            for chunk in r.iter_content(chunk_size=CHUNK):
                if not chunk:
                    continue
                f.write(chunk)
                sha.update(chunk)
                md5.update(chunk)
                recv += len(chunk)
                if time.time() - last > 5:
                    pct = (100 * recv / total) if total else 0
                    print(f"  {recv/1e6:.1f}/{total/1e6:.1f}MB ({pct:.0f}%)", flush=True)
                    last = time.time()
    return sha.hexdigest(), md5.hexdigest(), os.path.getsize(dest)


def upload_to_gofile(path, token, folder_id=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    fname = os.path.basename(path)
    with open(path, "rb") as f:
        files = {"file": (fname, f, "application/octet-stream")}
        data = {"folderId": folder_id} if folder_id else {}
        r = requests.post(UPLOAD_URL, headers=headers, files=files, data=data, timeout=14400)
    r.raise_for_status()
    try:
        body = r.json()
    except Exception:
        body = {}
    if body.get("status") != "ok":
        raise SystemExit(f"FAILURE: Gofile rejected upload: {body}")
    return body["data"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--file", default=DEFAULT_FILE)
    ap.add_argument("--rev", default="main")
    ap.add_argument("--retry", default=str(MAX_RETRY))
    args = ap.parse_args()
    retries = int(args.retry)

    token = load_token()
    source_url = f"{HF_BASE}/{args.repo}/resolve/{args.rev}/{args.file}"
    os.makedirs(STAGING_DIR, exist_ok=True)
    os.makedirs(MANIFEST_DIR, exist_ok=True)

    size, hf_sha = hf_meta(args.repo, args.file, args.rev)
    print(f"Source: {args.repo}/{args.file}  size={size}  sha256={hf_sha or '?'}")

    dest = os.path.join(STAGING_DIR, args.file.replace("/", "_"))
    local_sha = None
    local_md5 = None
    for attempt in range(1, retries + 1):
        local_sha, local_md5, local_size = resumable_download(source_url, dest)
        if hf_sha:
            if local_sha == hf_sha:
                break
            print(f"  sha MISMATCH (attempt {attempt}/{retries}); re-downloading.")
            try:
                os.remove(dest)
            except OSError:
                pass
        else:
            print("  no LFS sha256 from HF; trusting locally-computed sha.")
            break
    else:
        print("FAILURE: source download failed sha verification after retries.")
        sys.exit(1)

    print(f"Source verified. sha256={local_sha[:16]}... uploading {local_size/1e6:.1f}MB to Gofile...")
    gf = upload_to_gofile(dest, token)
    gf_md5 = gf.get("md5")
    if gf_md5 and gf_md5 != local_md5:
        print(f"  WARNING: Gofile md5 ({gf_md5}) != staged ({local_md5}); upload integrity suspect.")
    page = gf.get("downloadPage")
    print(f"Uploaded. id={gf.get('id')}  code={gf.get('code')}  page={page}  md5={gf_md5}")

    manifest = {}
    if os.path.exists(MANIFEST_FILE):
        try:
            with open(MANIFEST_FILE) as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}
    manifest[f"{args.repo}/{args.file}"] = {
        "repo": args.repo, "file": args.file, "rev": args.rev,
        "source_url": source_url,
        "gofile_id": gf.get("id"), "gofile_code": gf.get("code"),
        "gofile_page": page, "gofile_parent": gf.get("parentFolder"),
        "md5_gofile": gf_md5, "sha256": local_sha, "size": local_size,
        "mirrored_at": datetime.now().isoformat(timespec="seconds"),
        "last_verified": None, "downloads": 0,
    }
    with open(MANIFEST_FILE, "w") as f:
        json.dump(manifest, f, indent=2)

    shutil.rmtree(STAGING_DIR, ignore_errors=True)  # never keep the model on the Pi
    print(f"OK. Verified mirror recorded. Share: {page}")
    print(f"Manifest: {MANIFEST_FILE}")


if __name__ == "__main__":
    main()