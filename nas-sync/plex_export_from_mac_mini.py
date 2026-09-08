#!/usr/bin/env python3
"""
Plex -> Media Search sync, run from the MAC MINI (not the NAS).

IMPORTANT: this is a NEW, separate script from nas-sync/plex_export.py,
which already exists in this repo and runs directly on the NAS as a
Task Scheduler job (writing plex_library_export.csv locally there, which
then syncs to Google Drive and gets imported by Code.gs's updatePlexSheet
on a timer). That script is untouched - keep it running until this one is
proven reliable.

This script instead talks to Plex's own API straight from the Mac Mini
and POSTs the result directly to the Apps Script backend (same pattern as
audiobookshelf_export.py) - no CSV, no Google Drive hop, no NAS-side
scheduled task, once you're happy with it. Both write the same 4
Inventory columns (Title, Year, Last Synced, Type), so it's safe to run
this alongside the NAS one for a while before retiring that one.

Deliberately uses plain urllib instead of the `plexapi` package (which the
NAS-side script uses) so there's nothing extra to install on the Mac Mini -
same minimal-dependency approach as audiobookshelf_export.py.

Required environment variables (don't hardcode these - this file lives in
a git repo):
  PLEX_URL            e.g. "http://192.168.1.50:32400" (no trailing slash).
                       The NAS-side script connects to Plex via
                       127.0.0.1:32400 because it runs ON the same NAS as
                       Plex - from the Mac Mini you need Plex's real
                       network address instead (its LAN IP, or a Tailscale
                       address if the NAS has Tailscale too).
  PLEX_TOKEN           your Plex X-Plex-Token. Worth checking first
                       whether one is already set as an environment
                       variable in the NAS's Task Scheduler job that runs
                       the existing plex_export.py - if so, reuse that
                       same value rather than generating a new one. If you
                       can't find it, see "How to get your Plex token"
                       below.
  APPS_SCRIPT_URL      the SAME Web App URL as the other two sync scripts
  APPS_SCRIPT_SECRET   the SAME secret already used for the other syncs

How to get your Plex token (if the NAS Task Scheduler job doesn't have one
you can reuse):
  1. Open Plex's web app (app.plex.tv, or your server's own web UI) and
     log in.
  2. Open any movie or show, click the "..." (more) button, and choose
     "Get Info". On the info panel, click "View XML" (older UI) or look
     for a similar raw-data link (exact wording varies by Plex version).
  3. That opens a new tab whose URL ends in "...&X-Plex-Token=XXXXXXXX".
     Copy just that XXXXXXXX value - that's your token.
  Treat it like a password (it grants full access to your Plex account/
  server) - same handling as ABS_API_KEY: put it in a small wrapper shell
  script that's NEVER committed to git, never hardcoded here.

Run it manually first to check the output, then schedule it via cron in a
wrapper script with the real secrets in it - same pattern as
run_audiobook_export.sh.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlencode

PLEX_URL = os.environ.get("PLEX_URL", "").rstrip("/")
PLEX_TOKEN = os.environ.get("PLEX_TOKEN")
APPS_SCRIPT_URL = os.environ.get("APPS_SCRIPT_URL")
APPS_SCRIPT_SECRET = os.environ.get("APPS_SCRIPT_SECRET")

# Plex library "type" -> the label the Inventory sheet already uses (see
# plex_library_export.csv's existing Type column, and the NAS-side
# plex_export.py's movie_section_name/tv_section_name). Any section type
# not listed here (music, photos, etc.) is skipped entirely. Using Plex's
# own section "type" field rather than matching section names by string
# means this doesn't care what you've actually named your libraries,
# unlike the NAS-side script's 'Movies'/'TV Shows' name matching.
TYPE_LABELS = {"movie": "Movie", "show": "TV Show"}


def plex_request(path, params=None):
    params = dict(params or {})
    params["X-Plex-Token"] = PLEX_TOKEN
    url = PLEX_URL + path + "?" + urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def find_library_sections():
    """Returns a list of (key, plex_type) for every Movie/TV Show library
    section - skips music, photos, or anything else you might have."""
    data = plex_request("/library/sections")
    directories = data.get("MediaContainer", {}).get("Directory", [])
    sections = [(d.get("key"), d.get("type")) for d in directories if d.get("type") in TYPE_LABELS]
    if not sections:
        raise RuntimeError(
            "Plex returned no Movie or TV Show library sections at all - "
            "check PLEX_URL/PLEX_TOKEN, or that your libraries are actually named/typed as expected."
        )
    return sections


def fetch_section_items(key):
    data = plex_request("/library/sections/%s/all" % key)
    return data.get("MediaContainer", {}).get("Metadata", [])


def build_titles():
    titles = []
    for key, plex_type in find_library_sections():
        label = TYPE_LABELS[plex_type]
        for item in fetch_section_items(key):
            titles.append({
                "title": item.get("title") or "(untitled)",
                "year": item.get("year") or "",
                "type": label,
            })
    return titles


def push_to_sheet(titles):
    payload = json.dumps({
        "action": "syncInventory",
        "secret": APPS_SCRIPT_SECRET,
        "titles": titles,
    }).encode("utf-8")
    req = urllib.request.Request(
        APPS_SCRIPT_URL, data=payload,
        headers={"Content-Type": "text/plain;charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    missing = [name for name, val in [
        ("PLEX_URL", PLEX_URL), ("PLEX_TOKEN", PLEX_TOKEN),
        ("APPS_SCRIPT_URL", APPS_SCRIPT_URL), ("APPS_SCRIPT_SECRET", APPS_SCRIPT_SECRET),
    ] if not val]
    if missing:
        print("ERROR: missing required environment variable(s): " + ", ".join(missing))
        sys.exit(1)

    print("Connecting to Plex at %s ..." % PLEX_URL)
    titles = build_titles()
    print("Fetched %d titles." % len(titles))
    if not titles:
        print("REFUSING TO PUSH: Plex returned 0 titles - leaving the Sheet untouched.")
        sys.exit(1)

    print("Pushing to Apps Script...")
    result = push_to_sheet(titles)
    if not result.get("ok"):
        print("ERROR from Apps Script: %s" % result.get("error", "unknown error"))
        sys.exit(1)

    print("Success! %d titles synced." % result.get("count", len(titles)))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        print("HTTP error talking to %s: %s %s" % (e.url, e.code, e.reason))
        try:
            print(e.read().decode("utf-8", "replace"))
        except Exception:
            pass
        sys.exit(1)
    except urllib.error.URLError as e:
        print("Network error: %s" % e.reason)
        sys.exit(1)
    except Exception as e:
        print("An error occurred: %s" % e)
        sys.exit(1)
