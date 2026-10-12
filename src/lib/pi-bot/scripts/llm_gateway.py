"""FreeLLMAPI gateway client (https://github.com/tashfeenahmed/freellmapi).

FreeLLMAPI is a self-hosted OpenAI-compatible router that pools the free tiers
of ~34 LLM providers behind ONE endpoint (/v1/chat/completions) and one
"unified key". ai_debug.py tries it FIRST (far more free requests than a single
Gemini key) and falls back to direct Gemini when it is unconfigured/down.

Config (all optional -- if the key is missing the gateway is simply skipped):
  ~/.secrets/freellmapi_key   unified key from the FreeLLMAPI dashboard (chmod 600)
  FREELLMAPI_URL (.env)       default http://127.0.0.1:3001/v1
  FREELLMAPI_MODEL (.env)     default "auto"  (or auto:fast / auto:smart / model id)

The rest of ai_debug speaks Gemini's {contents, candidates, functionCall} shape,
so this module converts Gemini <-> OpenAI both ways. ai_debug stays unchanged
apart from one extra attempt inside call_gemini().
"""
import os
import json
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


def chat(contents, tools=None, system=None, max_tokens=800, timeout=60):
    """Returns (gemini_shaped_response, served_model_label) or (None, None).
    Raises nothing: any failure -> (None, None) so the caller falls back."""
    key = _load_key()
    if not key:
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
    try:
        r = requests.post(f"{BASE_URL}/chat/completions",
                          headers={"Authorization": f"Bearer {key}"},
                          json=payload, timeout=timeout)
        if r.status_code != 200:
            return None, None
        data = r.json()
        resp = _to_gemini_response(data)
        served = data.get("model") or r.headers.get("x-routed-via") or MODEL
        return resp, f"freellmapi:{served}"
    except Exception:
        return None, None