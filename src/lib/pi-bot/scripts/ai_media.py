#!/usr/bin/env python3
"""Vision + image generation through the FreeLLMAPI gateway (no model ids needed).

  ai_media.py vision <image_url> [question...]   describe / answer about an image
  ai_media.py imagine <prompt...>                generate an image

The gateway does the model selection itself and keeps its catalog current:
  * vision: any chat request containing an image is routed ONLY to vision-capable
    models (model "auto"); if none is enabled it answers 422 no_vision_model.
  * imagine: POST /v1/images/generations routes across its image-model pool
    (dashboard -> Models -> Image tab: enable the ones you want).

`imagine` writes the PNG to /dev/shm/pi-bot/imagine.png (RAM, no SD wear) and
prints "IMAGE:<path>" (or "IMAGE_URL:<url>") as its LAST line; the Discord
module uploads that file.
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
    # model="auto": the gateway restricts itself to vision-capable models.
    resp, model = llm_gateway.chat(contents, max_tokens=700, timeout=90, model="auto")
    if not resp:
        err = llm_gateway.LAST_ERROR or "no response"
        hint = ("\nEnable a vision model in the gateway dashboard (Fallback Chain -> models with the Vision badge)."
                if "no_vision_model" in err else "")
        print(f"Vision failed: {err}{hint}")
        return
    parts = resp["candidates"][0]["content"]["parts"]
    print(f"**Vision** model={model}\n" + "".join(p.get("text", "") for p in parts))


def imagine(prompt):
    img, model = llm_gateway.generate_image(prompt)
    if not img:
        print(f"Image generation failed: {llm_gateway.LAST_ERROR or 'no response'}\n"
              "(enable image models in the gateway dashboard -> Models -> Image tab)")
        return
    if "data" in img:
        os.makedirs(SHM, exist_ok=True)
        with open(OUT, "wb") as f:
            f.write(base64.b64decode(img["data"]))
        print(f"**Imagine** model={model}\nIMAGE:{OUT}")
    else:
        print(f"**Imagine** model={model}\nIMAGE_URL:{img['url']}")


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