"""Discord handlers for voice messages and /say (text -> voice).

Auto-listen: any voice message or audio file sent in the command channel is
heard automatically — no command needed (Discord sends voice messages as
their own message with no text, so a /talk prefix can't ride along).
/say <text>: Pi speaks the text back as an audio message.
"""
import os
import asyncio
import subprocess
import discord

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "ai_voice.py")
AUDIO_EXT = (".ogg", ".oga", ".mp3", ".wav", ".m4a", ".webm", ".mp4", ".flac", ".mpeg", ".mpga")


def _run(args, timeout):
    r = subprocess.run(["python3", "-u", SCRIPT] + args, capture_output=True, text=True, timeout=timeout)
    return (r.stdout or r.stderr or "No output.").strip()


def has_audio_attachment(message):
    """Returns the audio attachment's url, or "" if none."""
    for a in message.attachments:
        if (a.content_type or "").startswith("audio") or a.filename.lower().endswith(AUDIO_EXT):
            return a.url
    return ""


async def _send_result(message, out):
    lines = out.splitlines()
    last = lines[-1] if lines else ""
    has_audio = last.startswith("AUDIO:") and os.path.exists(last[6:])
    text = "\n".join(lines[:-1]) if last.startswith("AUDIO:") else out
    if has_audio:
        await message.channel.send(text[:1900] or None, file=discord.File(last[6:], filename="reply.mp3"))
    else:
        await message.channel.send(text[:1900])


async def auto_listen(client, message):
    """Hear a voice message / audio recording and reply with voice."""
    url = has_audio_attachment(message)
    if not url:
        return False
    await message.channel.send("Listening...")
    try:
        out = await asyncio.to_thread(_run, ["talk", url], 240)
    except subprocess.TimeoutExpired:
        await message.channel.send("Timed out.")
        return True
    await _send_result(message, out)
    return True


async def handle_voice_command(client, message):
    """Returns True if the message was /say."""
    raw = message.content.strip()
    low = raw.lower()

    if low.startswith("/say"):
        text = raw[4:].strip()
        if not text:
            await message.channel.send("Usage: /say <text>")
            return True
        try:
            out = await asyncio.to_thread(_run, ["say"] + text.split(), 180)
        except subprocess.TimeoutExpired:
            await message.channel.send("Timed out.")
            return True
        await _send_result(message, out)
        return True
    return False