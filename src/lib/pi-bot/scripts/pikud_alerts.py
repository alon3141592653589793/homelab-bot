#!/usr/bin/env python3
"""Home Front Command (Pikud HaOref) alert monitor for the Pi bot.

Polls the official Oref realtime alert feeds (no API key) and posts NEW
alerts to the configured command channel. Optional location filter (Hebrew
area/city) so you only get alerts touching your area.

Feeds (free, public, require a Referer header):
  active : https://www.oref.org.il/WarningMessages/Alert/alerts.json
  history: https://www.oref.org.il/WarningMessages/History/AlertsHistory.json

CLI:
  python3 pikud_alerts.py                     # cron: post new alerts (location-filtered)
  python3 pikud_alerts.py --show             # print current active alerts + your location
  python3 pikud_alerts.py --set-location <pl> # set filter, e.g. "ramat gan" or Hebrew "רמת גן"
  python3 pikud_alerts.py --set-location off  # clear filter (post all Israel)
"""
import os
import sys
import json

try:
    import requests
except ImportError:
    print("requests missing. pip3 install --user requests")
    sys.exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv("/home/alon/secure-pi-bot/.env")
except Exception:
    pass

SHM = "/dev/shm/pi-bot"
LOC_FILE = os.path.expanduser("~/.secrets/pikud_location.txt")
SEEN_FILE = os.path.join(SHM, "pikud_seen.json")
HEADERS = {"Referer": "https://www.oref.org.il",
           "User-Agent": "Mozilla/5.0",
           "Accept": "application/json"}
ACTIVE_URL = "https://www.oref.org.il/WarningMessages/Alert/alerts.json"
HISTORY_URL = "https://www.oref.org.il/WarningMessages/History/AlertsHistory.json"

# English -> Hebrew city/area map so "/setlocation ramat gan" works against
# the Hebrew-only Oref feed. For anything else, type the Hebrew name directly.
CITY_HE = {
    "ramat gan": "רמת גן", "tel aviv": "תל אביב", "tel aviv yafo": "תל אביב-יפו",
    "jerusalem": "ירושלים", "haifa": "חיפה", "beer sheva": "באר שבע",
    "beersheba": "באר שבע", "netanya": "נתניה", "rishon lezion": "ראשון לציון",
    "petah tikva": "פתח תקווה", "ashdod": "אשדוד", "ashkelon": "אשקלון",
    "rehovot": "רחובות", "bat yam": "בת ים", "herzliya": "הרצליה",
    "kfar saba": "כפר סבא", "bnei brak": "בני ברק", "beni brak": "בני ברק",
    "ramat hasharon": "רמת השרון", "givatayim": "גבעתיים", "modiin": "מודיעין",
    "ariel": "אריאל", "hod hasharon": "הוד השרון", "raanana": "רעננה",
    "nahariya": "נהריה", "kiryat shmona": "קרית שמונה", "tiberias": "טבריה",
    "afula": "עפולה", "gedera": "גדרה", "yavne": "יבנה", "lod": "לוד",
    "ramla": "רמלה", "hadera": "חדרה", "akko": "עכו", "carmel": "כרמל",
}


def normalize_location(raw):
    raw = (raw or "").strip()
    low = raw.lower()
    if low.startswith("israel "):
        raw = raw[len("israel "):]
        low = raw.lower().strip()
    if low in ("", "off", "none", "clear", "all", "כל הארץ"):
        return ""
    if low in CITY_HE:
        return CITY_HE[low]
    return raw  # assume Hebrew / already correct


def get_location():
    try:
        with open(LOC_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


def fetch_active():
    try:
        r = requests.get(ACTIVE_URL, headers=HEADERS, timeout=15)
        if r.status_code == 200 and r.text.strip():
            return r.json()
    except Exception:
        pass
    return {}


def matches(loc, alert):
    if not loc:
        return True
    areas = alert.get("data", [])
    if isinstance(areas, str):
        areas = [areas]
    return any(loc in a for a in areas)


def load_seen():
    try:
        with open(SEEN_FILE) as f:
            return json.load(f).get("ids", [])
    except Exception:
        return []


def save_seen(ids):
    try:
        os.makedirs(SHM, exist_ok=True)
        with open(SEEN_FILE, "w") as f:
            json.dump({"ids": ids[-200:]}, f)
    except OSError:
        pass


def post_alert(alert, loc):
    token = os.getenv("DISCORD_BOT_TOKEN", "")
    ch = os.getenv("COMMAND_CHANNEL_ID", "")
    if not token or not ch:
        return
    areas = alert.get("data", [])
    if isinstance(areas, str):
        areas = [areas]
    text = (f"🚨 {alert.get('title', 'Alert')}\n"
            f"Category: {alert.get('cat', '?')}\n"
            f"Areas: {', '.join(str(a) for a in areas[:25])}\n"
            f"{alert.get('desc', '')}\n"
            f"(filter: {loc or 'ALL Israel'})")
    url = f"https://discord.com/api/v10/channels/{int(ch)}/messages"
    hdr = {"Authorization": f"Bot {token}", "Content-Type": "application/json"}
    for c in [text[i:i + 1900] for i in range(0, len(text), 1900)]:
        try:
            requests.post(url, json={"content": c}, headers=hdr, timeout=10)
        except Exception:
            pass


def monitor():
    loc = get_location()
    if not loc:
        # No location set -> stay silent (set one with /setlocation <place>).
        return
    active = fetch_active()
    if not active or not active.get("id"):
        return
    aid = active.get("id")
    if not matches(loc, active):
        return
    seen = load_seen()
    if aid in seen:
        return
    post_alert(active, loc)
    seen.append(aid)
    save_seen(seen)


def show():
    loc = get_location()
    active = fetch_active()
    print(f"Location filter: {loc or 'ALL (no filter)'}")
    if not active or not active.get("id"):
        print("No active alerts right now.")
        return
    areas = active.get("data", [])
    if isinstance(areas, str):
        areas = [areas]
    print(f"Active alert: {active.get('title', '?')} (cat {active.get('cat', '?')})")
    print(f"Areas: {', '.join(str(a) for a in areas)}")
    print(f"Matches your location: {'YES' if matches(loc, active) else 'no'}")
    if active.get("desc"):
        print(active["desc"])


def set_location(raw):
    loc = normalize_location(raw)
    try:
        os.makedirs(os.path.dirname(LOC_FILE), exist_ok=True)
    except OSError:
        pass
    if loc:
        try:
            with open(LOC_FILE, "w") as f:
                f.write(loc)
            print(f"Location set to: {loc}\nOnly alerts touching this area will be posted. /setlocation off to clear.")
        except OSError as e:
            print(f"Could not write location: {e}")
    else:
        try:
            os.remove(LOC_FILE)
        except OSError:
            pass
        print("Location filter cleared. All alerts across Israel will be posted.")


def main():
    args = sys.argv[1:]
    if "--show" in args:
        show()
        return
    if "--set-location" in args:
        i = args.index("--set-location")
        set_location(" ".join(args[i + 1:]))
        return
    monitor()


if __name__ == "__main__":
    main()