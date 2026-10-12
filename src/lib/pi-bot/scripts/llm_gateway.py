"""FreeLLMAPI gateway client (https://github.com/tashfeenahmed/freellmapi).

FreeLLMAPI is a self-hosted OpenAI-compatible router that pools the free tiers
of ~34 LLM providers behind ONE endpoint (/v1/chat/completions) and one
"unified key". ai_debug.py uses it for ALL normal AI calls (no direct-Gemini
fallback; only the --web search mode still talks to Gemini directly).

Config (the unified key is required; without it ai_debug reports the error):
  ~/.secrets/freellmapi_key   unified key from the FreeLLMAPI dashboard (chmod 600)
  FREELLMAPI_URL (.env)       default http://127.0.0.1:3001/v1
  FREELLMAPI_MODEL (.env)     default "auto"  (or auto:fast / auto:smart / model id)

The rest of ai_debug speaks Gemini's {contents, candidates, functionCall} shape,
so this module converts Gemini <-> OpenAI both ways. ai_debug stays unchanged
apart from one extra attempt inside call_gemini().
"""
import os
import json
import time
import requests

try:
    from dotenv import load_dotenv
    load_dotenv("/home/alon/secure-pi-bot/.env")
except ImportError:
    pass

KEY_FILE = "/home/alon/.secrets/freellmapi_key"
BASE_URL = os.getenv("FREELLMAPI_URL", "http://127.0.0.1:3001/v1").rstrip("/")
MODEL = os.getenv("FREELLMAPI_MODEL", "auto")


def _load_key():
    try:
        with open(KEY_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


def configured():
    return bool(_load_key())


def _clean_schema(s):
    """Gemini schemas are OpenAI-compatible JSON schema; just deep-copy."""
    return json.loads(json.dumps(s))


def _to_openai_tools(tools):
    out = []
    for t in tools or []:
        for d in t.get("functionDeclarations", []):
            out.append({"type": "function", "function": {
                "name": d["name"],
                "description": d.get("description", ""),
                "parameters": _clean_schema(d.get("parameters", {"type": "object", "properties": {}})),
            }})
    return out


def _to_openai_messages(contents, system=None):
    """Gemini contents -> OpenAI messages. Tool-call ids are synthesized as
    call_<n> and matched back to responses by order."""
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    pending = []  # ids of tool calls awaiting a response
    n = 0
    for c in contents:
        parts = c.get("parts", [])
        role = c.get("role", "user")
        if role == "model":
            text = "".join(p.get("text", "") for p in parts if "text" in p)
            calls = []
            for p in parts:
                if "functionCall" in p:
                    n += 1
                    cid = f"call_{n}"
                    pending.append(cid)
                    calls.append({"id": cid, "type": "function", "function": {
                        "name": p["functionCall"]["name"],
                        "arguments": json.dumps(p["functionCall"].get("args", {})),
                    }})
            m = {"role": "assistant", "content": text or None}
            if calls:
                m["tool_calls"] = calls
            msgs.append(m)
        else:
            resps = [p for p in parts if "functionResponse" in p]
            if resps:
                for p in resps:
                    cid = pending.pop(0) if pending else f"call_{n}"
                    msgs.append({"role": "tool", "tool_call_id": cid,
                                 "content": json.dumps(p["functionResponse"].get("response", {}))})
            else:
                msgs.append({"role": "user",
                             "content": "".join(p.get("text", "") for p in parts if "text" in p)})
    return msgs


def _to_gemini_response(data):
    """OpenAI chat completion -> Gemini-shaped {'candidates':[{'content':{'parts':[...]}}]}."""
    msg = data["choices"][0]["message"]
    parts = []
    if msg.get("content"):
        parts.append({"text": msg["content"]})
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function", {})
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {}
        parts.append({"functionCall": {"name": fn.get("name", ""), "args": args}})
    if not parts:
        raise ValueError("empty completion")
    return {"candidates": [{"content": {"role": "model", "parts": parts}}]}


LAST_ERROR = ""


def chat(contents, tools=None, system=None, max_tokens=800, timeout=60):
    """Returns (gemini_shaped_response, served_model_label) or (None, None).
    Raises nothing: any failure -> (None, None); the reason is left in
    LAST_ERROR so the caller can show it."""
    global LAST_ERROR
    LAST_ERROR = ""
    key = _load_key()
    if not key:
        LAST_ERROR = "no unified key (/llm unified <key>)"
        return None, None
    payload = {
        "model": MODEL,
        "messages": _to_openai_messages(contents, system),
        "max_tokens": max_tokens,
        "temperature": 0.2,
    }
    oa_tools = _to_openai_tools(tools)
    if oa_tools:
        payload["tools"] = oa_tools
    # Free upstream providers are flaky (empty completions / 5xx). Retry a few
    # times with a short pause; the router picks a different provider each time.
    for attempt in range(3):
        try:
            r = requests.post(f"{BASE_URL}/chat/completions",
                              headers={"Authorization": f"Bearer {key}"},
                              json=payload, timeout=timeout)
            if r.status_code != 200:
                LAST_ERROR = f"HTTP {r.status_code}: {r.text[:300]}"
                if r.status_code in (429, 500, 502, 503, 504):
                    time.sleep(2 * (attempt + 1))
                    continue
                return None, None
            data = r.json()
            resp = _to_gemini_response(data)
            served = data.get("model") or r.headers.get("x-routed-via") or MODEL
            return resp, f"freellmapi:{served}"
        except Exception as e:
            LAST_ERROR = f"{type(e).__name__}: {str(e)[:200]}"
            time.sleep(2 * (attempt + 1))
    return None, None