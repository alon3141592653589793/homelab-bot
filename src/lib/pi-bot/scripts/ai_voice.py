#!/usr/bin/env python3
"""Voice messages through the FreeLLMAPI gateway (OpenAI-compatible audio endpoints).

  ai_voice.py talk <audio_url>     transcribe -> AI answer -> spoken reply
  ai_voice.py say  <text...>       speak the text

Pipeline for `talk`:
  1. download the voice message / audio file (Discord CDN url)
  2. POST /v1/audio/transcriptions   (speech -> text)
  3. POST /v1/chat/completions       (short conversational answer)
  4. POST /v1/audio/speech           (text -> speech)

Output (stdout): text lines, then a LAST line "AUDIO:<path>" when audio was made.
Audio goes to /dev/shm/pi-bot (RAM, no SD wear). No model ids: model "auto" is
used everywhere, so enable at least one transcription model and one speech model
in the gateway dashboard (Models -> Audio).
"""
import os
import sys
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm_gateway  # noqa: E402

SHM = "/dev/shm/pi-bot"
IN_FILE = os.path.join(SHM, "voice_in")
OUT_FILE = os.path.join(SHM, "voice_out.mp3")
MAX_BYTES = 20 * 1024 * 1024
SYSTEM = ("You are the voice of a Raspberry Pi home lab assistant. Reply in at most "
          "3 short, plain spoken sentences. No markdown, no lists, no emojis.")


def _headers():
    return {"Authorization": f"Bearer {llm_gateway._load_key()}"}


def transcribe(audio_url):
    """Returns (text, error)."""
    os.makedirs(SHM, exist_ok=True)
    r = requests.get(audio_url, timeout=60)
    if r.status_code != 200 or len(r.content) > MAX_BYTES:
        return None, f"could not download audio (HTTP {r.status_code}, {len(r.content)} bytes)"
    name = audio_url.split("?")[0].rsplit("/", 1)[-1] or "voice.ogg"
    with open(IN_FILE, "wb") as f:
        f.write(r.content)
    try:
        with open(IN_FILE, "rb") as f:
            t = requests.post(f"{llm_gateway.BASE_URL}/audio/transcriptions",
                              headers=_headers(),
                              files={"file": (name, f)},
                              data={"model": "auto"}, timeout=120)
    finally:
        try:
            os.remove(IN_FILE)
        except OSError:
            pass
    if t.status_code != 200:
        return None, f"transcription HTTP {t.status_code}: {t.text[:250]}"
    text = (t.json().get("text") or "").strip()
    return (text, None) if text else (None, "no speech detected")


def speak(text):
    """Returns (path, error). Writes an mp3 to RAM."""
    os.makedirs(SHM, exist_ok=True)
    r = requests.post(f"{llm_gateway.BASE_URL}/audio/speech",
                      headers=_headers(),
                      json={"model": "auto", "input": text[:1500], "voice": "alloy"},
                      timeout=120)
    if r.status_code != 200:
        return None, f"speech HTTP {r.status_code}: {r.text[:250]}"
    if not r.content:
        return None, "empty audio response"
    with open(OUT_FILE, "wb") as f:
        f.write(r.content)
    return OUT_FILE, None


def answer(question):
    resp, _ = llm_gateway.chat([{"role": "user", "parts": [{"text": question}]}],
                               system=SYSTEM, max_tokens=250, timeout=60)
    if not resp:
        return None
    return "".join(p.get("text", "") for p in resp["candidates"][0]["content"]["parts"]).strip()


def main():
    a = sys.argv[1:]
    if not llm_gateway.configured():
        print("No gateway key saved. Add the unified key first (see setup notes).")
        return
    if len(a) >= 2 and a[0] == "say":
        path, err = speak(" ".join(a[1:]))
        print(f"Voice failed: {err}\n(enable a speech model in the gateway dashboard -> Models -> Audio)" if err else f"AUDIO:{path}")
    elif len(a) >= 2 and a[0] == "talk":
        text, err = transcribe(a[1])
        if err:
            print(f"Could not understand the audio: {err}\n(enable a transcription model in the gateway dashboard -> Models -> Audio)")
            return
        reply = answer(text)
        if not reply:
            print(f"You said: {text}\nAI failed: {llm_gateway.LAST_ERROR or 'no response'}")
            return
        path, err = speak(reply)
        out = f"**You said:** {text}\n**Reply:** {reply}"
        print(out + (f"\n(voice failed: {err})" if err else f"\nAUDIO:{path}"))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()