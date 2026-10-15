#!/usr/bin/env python3
"""Compact, bounded persistent memory for the AI diagnostic agent.

Stores structured notes in /dev/shm (RAM — cleared on reboot) with a strict
size cap. The AI reads relevant notes at session start and can add new ones
via the remember/recall tools.

Structure: a JSON file with a list of note objects:
  {"ts": "...", "category": "...", "text": "..."}
Categories: fact, issue, fix, note
Max 50 notes, 300 chars per note.
"""
import os
import sys
import json
from datetime import datetime

SHM = "/dev/shm/pi-bot"
MEM_FILE = f"{SHM}/ai_memory.json"
MAX_NOTES = 50
MAX_TEXT = 300
CATEGORIES = ("fact", "issue", "fix", "note")


def _load():
    try:
        with open(MEM_FILE) as f:
            data = json.load(f)
            if isinstance(data, list):
                return data
    except (OSError, json.JSONDecodeError):
        pass
    return []


def _save(notes):
    os.makedirs(SHM, exist_ok=True)
    with open(MEM_FILE, "w") as f:
        json.dump(notes[-MAX_NOTES:], f, separators=(",", ":"))


def add_note(category, text):
    category = category if category in CATEGORIES else "note"
    text = (text or "").strip()[:MAX_TEXT]
    if not text:
        return "empty note"
    notes = _load()
    notes.append({"ts": datetime.now().isoformat(timespec="seconds"),
                  "category": category, "text": text})
    _save(notes)
    return f"note saved ({category}, {len(notes)} total)"


def get_notes(category=None, limit=10):
    notes = _load()
    if category and category in CATEGORIES:
        notes = [n for n in notes if n["category"] == category]
    if not isinstance(limit, int) or limit < 1:
        limit = 10
    return notes[-limit:]


def summary():
    """Compact one-line summary for context injection."""
    notes = _load()
    if not notes:
        return ""
    by_cat = {}
    for n in notes:
        by_cat.setdefault(n["category"], []).append(n["text"])
    parts = []
    for cat in CATEGORIES:
        if cat in by_cat:
            parts.append(f"{cat}({len(by_cat[cat])}): " + "; ".join(by_cat[cat][-3:]))
    return " | ".join(parts)[:800]


def clear():
    try:
        os.remove(MEM_FILE)
    except OSError:
        pass
    return "memory cleared"


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "--show":
        notes = _load()
        if not notes:
            print("(memory empty)")
        else:
            for n in notes:
                print(f"[{n['category']}] {n['ts']} {n['text']}")
    elif a and a[0] == "--clear":
        print(clear())
    else:
        s = summary()
        print(s or "(memory empty)")