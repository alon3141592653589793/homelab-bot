"""Discord handlers for /talk (voice message in -> voice reply) and /say (text -> voice)."""
import os
import asyncio
import subprocess
import discord

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "ai_voice.py")
AUDIO_EXT = (".ogg", ".oga", ".mp3", ".wav", ".m4a", ".webm", ".mp4", ".flac", ".mpeg", ".mpga")


def _run(args, timeout):
    r = subprocess.run(["python3", "-u", SCRIPT] + args, capture_output=True, text=True, timeout=timeout)
    return (r.stdout or r.stderr or "No output.").strip()


def _audio_url(message):
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


async def handle_voice_command(client, message):
    """Returns True if the message was /talk or /say."""
    raw = message.content.strip()
    low = raw.lower()

    if low.startswith("/talk"):
        url = _audio_url(message)
        if not url:
            await message.channel.send("Usage: record a voice message (or attach an audio file) and send it with `/talk` as the message text.")
            return True
        await message.channel.send("Listening...")
        try:
            out = await asyncio.to_thread(_run, ["talk", url], 240)
        except subprocess.TimeoutExpired:
            await message.channel.send("Timed out.")
            return True
        await _send_result(message, out)
        return True

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