"""Discord handlers for /vision and /imagine (FreeLLMAPI vision + image output)."""
import os
import asyncio
import subprocess
import discord

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "ai_media.py")

MEDIA_HELP = (
    "/vision <question>   - attach an image (or paste an image URL first) and ask about it\n"
    "/imagine <prompt>    - generate an image"
)


def _run(args, timeout):
    r = subprocess.run(["python3", "-u", SCRIPT] + args, capture_output=True, text=True, timeout=timeout)
    return (r.stdout or r.stderr or "No output.").strip()


async def handle_media_command(client, message):
    """Returns True if the message was /vision or /imagine."""
    raw = message.content.strip()
    low = raw.lower()
    if low.startswith("/vision"):
        rest = raw[7:].strip()
        url = message.attachments[0].url if message.attachments else ""
        if not url and rest.split()[:1] and rest.split()[0].startswith("http"):
            url, rest = rest.split()[0], " ".join(rest.split()[1:])
        if not url:
            await message.channel.send("Usage: attach an image and send `/vision <question>` (or `/vision <image-url> <question>`).")
            return True
        await message.channel.send("Looking at the image...")
        try:
            out = await asyncio.to_thread(_run, ["vision", url] + rest.split(), 120)
        except subprocess.TimeoutExpired:
            out = "Timed out."
        await message.channel.send(out[:1900])
        return True

    if low.startswith("/imagine"):
        prompt = raw[8:].strip()
        if not prompt:
            await message.channel.send("Usage: /imagine <prompt>")
            return True
        await message.channel.send("Generating image...")
        try:
            out = await asyncio.to_thread(_run, ["imagine"] + prompt.split(), 200)
        except subprocess.TimeoutExpired:
            await message.channel.send("Timed out.")
            return True
        lines = out.splitlines()
        last = lines[-1] if lines else ""
        text = "\n".join(lines[:-1]) if last.startswith(("IMAGE:", "IMAGE_URL:")) else out
        if last.startswith("IMAGE:") and os.path.exists(last[6:]):
            await message.channel.send(text[:1900], file=discord.File(last[6:]))
        elif last.startswith("IMAGE_URL:"):
            await message.channel.send((text + "\n" + last[10:])[:1900])
        else:
            await message.channel.send(text[:1900])
        return True
    return False