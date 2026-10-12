"""Discord handler for /llm -- control the self-hosted FreeLLMAPI gateway.

Secrets (/llm addkey, /llm token, /llm unified) carry a credential in the
message text, so the user's message is DELETED immediately (needs the bot's
Manage Messages permission; if it can't, we tell the user to delete it).
"""
from modules.runner import run_script

LLM_HELP = (
    "**FreeLLMAPI gateway (/llm)**\n"
    "/llm status                    - service, reachability, key state, model\n"
    "/llm start | stop | restart    - control the gateway service\n"
    "/llm log [N]                   - last N journal lines\n"
    "/llm keys                      - list provider keys (ids, platform, health)\n"
    "/llm addkey <platform> <key>   - add + validate a provider key (msg auto-deleted)\n"
    "/llm rmkey <platform> [id]     - remove a provider key\n"
    "/llm testkey <platform> [id]   - re-check stored key(s)\n"
    "/llm token <dashboard-token>   - save dashboard session token (needed for key cmds)\n"
    "/llm unified <key>             - save the unified API key the bot uses\n"
    "/llm model [auto|auto:fast|auto:smart|<id>] - show/set routing model\n"
    "/llm on | off                  - use the gateway / use Gemini only\n"
    "Platforms: groq, google, cerebras, openrouter, mistral, ... (see dashboard Keys page)"
)

SECRET_SUBCMDS = ("addkey", "token", "unified")

SLOW = {"start": 60, "stop": 60, "restart": 90, "addkey": 90, "testkey": 120,
        "keys": 60, "rmkey": 60}


async def handle_llm_command(client, message):
    """Returns True if the message was an /llm command (handled)."""
    raw = message.content.strip()
    parts = raw.split()
    if not parts or parts[0].lower() != "/llm":
        return False

    sub = parts[1].lower() if len(parts) > 1 else "status"

    if sub == "help":
        await message.channel.send(LLM_HELP)
        return True

    if sub in SECRET_SUBCMDS:
        try:
            await message.delete()
            note = ""
        except Exception:
            note = "\n(Couldn't auto-delete your message -- delete it yourself; it contains a secret.)"
    else:
        note = ""

    timeout = SLOW.get(sub, 20)
    status = {
        "start": "Starting FreeLLMAPI...", "stop": "Stopping FreeLLMAPI...",
        "restart": "Restarting FreeLLMAPI...", "addkey": "Adding + validating key...",
        "testkey": "Testing key(s)...", "keys": "Listing keys...",
    }.get(sub, "")
    await run_script(message, "llm_ctl.py", status, args=parts[1:] or ["status"], timeout=timeout)
    if note:
        await message.channel.send(note.strip())
    return True