#!/usr/bin/env python3
"""Vision + image generation through the FreeLLMAPI gateway.

  ai_media.py vision <image_url> [question...]   describe / answer about an image
  ai_media.py imagine <prompt...>                generate an image

`imagine` writes the PNG to /dev/shm/pi-bot/imagine.png (RAM, no SD wear) and
prints "IMAGE:<path>" (or "IMAGE_URL:<url>") as its LAST line; the Discord
module uploads that file. Models: FREELLMAPI_VISION_MODEL / FREELLMAPI_IMAGE_MODEL
in .env (default: the gateway's FREELLMAPI_MODEL / "auto"). The model you pick
must actually support images -- check the gateway dashboard's model list.
"""
import os
import sys
import base64

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm_gateway  # noqa: E402

SHM = "/dev/shm/pi-bot"
OUT = os.path.join(SHM, "imagine.png")


def vision(url, question):
    contents = [{"role": "user", "parts": [
        {"text": question or "Describe this image."},
        {"image_url": url},
    ]}]
    resp, model = llm_gateway.chat(contents, max_tokens=700, timeout=90,
                                   model=os.getenv("FREELLMAPI_VISION_MODEL"))
    if not resp:
        print(f"Vision failed: {llm_gateway.LAST_ERROR or 'no response'}\n"
              "(the routed model may not support images -- set FREELLMAPI_VISION_MODEL in .env)")
        return
    parts = resp["candidates"][0]["content"]["parts"]
    print(f"**Vision** model={model}\n" + "".join(p.get("text", "") for p in parts))


def imagine(prompt):
    contents = [{"role": "user", "parts": [{"text": prompt}]}]
    resp, model = llm_gateway.chat(contents, max_tokens=1500, timeout=180, want_image=True,
                                   model=os.getenv("FREELLMAPI_IMAGE_MODEL"))
    if not resp:
        print(f"Image generation failed: {llm_gateway.LAST_ERROR or 'no response'}\n"
              "(set FREELLMAPI_IMAGE_MODEL in .env to a model that can output images)")
        return
    parts = resp["candidates"][0]["content"]["parts"]
    text = "".join(p.get("text", "") for p in parts if "text" in p).strip()
    for p in parts:
        if "inlineData" in p:
            os.makedirs(SHM, exist_ok=True)
            with open(OUT, "wb") as f:
                f.write(base64.b64decode(p["inlineData"]["data"]))
            print(f"**Imagine** model={model}\n{text}\nIMAGE:{OUT}")
            return
        if "imageUrl" in p:
            print(f"**Imagine** model={model}\n{text}\nIMAGE_URL:{p['imageUrl']}")
            return
    print(f"**Imagine** model={model} returned no image (it likely can't output images).\n{text[:500]}")


def main():
    a = sys.argv[1:]
    if len(a) >= 2 and a[0] == "vision":
        vision(a[1], " ".join(a[2:]))
    elif len(a) >= 2 and a[0] == "imagine":
        imagine(" ".join(a[1:]))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()