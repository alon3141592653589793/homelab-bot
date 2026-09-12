import subprocess
import asyncio
import os

SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")


async def run_script(message, script_name, status_msg, args=None, timeout=45):
    script_path = os.path.join(SCRIPTS_DIR, script_name)
    if status_msg:
        await message.channel.send(status_msg)
    try:
        cmd = ["python3", "-u", script_path] + (args or [])
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        output = (result.stdout or result.stderr or "No output.").strip()
        if len(output) > 1900:
            output = output[:1897] + "..."
        await message.channel.send(output)
    except subprocess.TimeoutExpired:
        await message.channel.send(f"Script timed out after {timeout} seconds.")
    except Exception as e:
        await message.channel.send(f"Script error: {e}")


async def confirm_and_run(client, message, script_name, action_name, description):
    confirm_msg = await message.channel.send(
        f"[{action_name.upper()} - CONFIRMATION REQUIRED]\n"
        f"{description}\n"
        f"React with ✅ to confirm or ❌ to cancel. Timeout: 30s."
    )
    await confirm_msg.add_reaction("\u2705")
    await confirm_msg.add_reaction("\u274c")

    def check(reaction, user):
        return (
            user.id == message.author.id
            and reaction.message.id == confirm_msg.id
            and str(reaction.emoji) in ("\u2705", "\u274c")
        )

    try:
        reaction, _ = await client.wait_for("reaction_add", timeout=30.0, check=check)
        if str(reaction.emoji) == "\u2705":
            await message.channel.send(f"{action_name} confirmed. Executing...")
            await run_script(message, script_name, "")
        else:
            await message.channel.send(f"{action_name} cancelled.")
    except asyncio.TimeoutError:
        await message.channel.send(f"{action_name} timed out. Cancelled.")