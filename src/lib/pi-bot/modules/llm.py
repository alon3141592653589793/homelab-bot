"""Discord handler for /llm -- control the self-hosted FreeLLMAPI gateway.

Secrets (/llm unified) carry a credential in the
message text, so the user's message is DELETED immediately (needs the bot's
Manage Messages permission; if it can't, we tell the user to delete it).
"""
from modules.runner import run_script

LLM_HELP = (
    "**FreeLLMAPI gateway (/llm)**\n"
    "/llm status                    - service, reachability, key state, model\n"
    "/llm start | stop | restart    - control the gateway service\n"
    "/llm log [N]                   - last N journal lines\n"
    "/llm unified <key>             - save the unified API key the bot uses\n"
    "/llm model [auto|auto:fast|auto:smart|<id>] - show/set routing model\n"
    "/llm on | off                  - use the gateway / use Gemini only\n"
    "Provider keys are managed in the web dashboard (Keys page)."
)

SECRET_SUBCMDS = ("unified",)

SLOW = {"start": 60, "stop": 60, "restart": 90}


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
        "restart": "Restarting FreeLLMAPI...",
    }.get(sub, "")
    await run_script(message, "llm_ctl.py", status, args=parts[1:] or ["status"], timeout=timeout)
    if note:
        await message.channel.send(note.strip())
    return True