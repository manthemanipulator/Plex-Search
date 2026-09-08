#!/usr/bin/env python3
"""
organize_log.csv -> Media Search sheet ("Organize Log" tab).

Mirrors organize_audiobooks.py's own append-only change log into its own
tab in the same spreadsheet the Plex/audiobook search already uses, purely
so everything lives in one file to look through. This is one-way and
read-only from the Sheet's perspective - the PWA never sees this tab, it's
not part of getData at all (see Code.gs's getOfflineData, which
deliberately leaves it out).

organize_log.csv only ever grows (organize_audiobooks.py never rewrites or
deletes a line once written), so this script just re-reads the whole file
and re-pushes it every time - simplest thing that works, and cheap even
once the log is a few thousand rows.

Required environment variables (don't hardcode these here - this file
lives in a git repo):
  APPS_SCRIPT_URL    the SAME Web App URL as app.js's CONFIG.API_URL /
                      audiobookshelf_export.py's APPS_SCRIPT_URL
  APPS_SCRIPT_SECRET the SAME secret already used for the other two syncs

Usage:
    python3 push_organize_log.py "/Volumes/Data-1/AudioBooks_Sorted/organize_log.csv"

Run it manually first to check the output, then call it from cron (or
tack it onto the end of run_audiobook_organize.sh, right after
organize_audiobooks.py finishes, so the log gets mirrored every night
right after anything new is added to it). Same as audiobookshelf_export.py,
put the actual secret value in a small wrapper script that isn't committed
to this repo - never in a crontab line or a file that gets pushed to
GitHub.
"""

import csv
import json
import os
import sys
import urllib.error
import urllib.request

APPS_SCRIPT_URL = os.environ.get("APPS_SCRIPT_URL")
APPS_SCRIPT_SECRET = os.environ.get("APPS_SCRIPT_SECRET")


def read_log_rows(csv_path):
    with open(csv_path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def push_to_sheet(rows):
    payload = json.dumps({
        "action": "syncOrganizeLog",
        "secret": APPS_SCRIPT_SECRET,
        "rows": rows,
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
        ("APPS_SCRIPT_URL", APPS_SCRIPT_URL), ("APPS_SCRIPT_SECRET", APPS_SCRIPT_SECRET),
    ] if not val]
    if missing:
        print("ERROR: missing required environment variable(s): " + ", ".join(missing))
        sys.exit(1)

    if len(sys.argv) < 2:
        print("usage: push_organize_log.py <path to organize_log.csv>")
        sys.exit(1)
    csv_path = sys.argv[1]

    if not os.path.exists(csv_path):
        # Nothing organized yet (or the log hasn't been backfilled/created)
        # - not an error, just nothing to push this run.
        print(f"No log file at {csv_path} yet - nothing to push.")
        return

    rows = read_log_rows(csv_path)
    print(f"Read {len(rows)} row(s) from {csv_path}.")
    if not rows:
        print("Log file is empty - leaving the Sheet untouched.")
        return

    print("Pushing to Apps Script...")
    result = push_to_sheet(rows)
    if not result.get("ok"):
        print("ERROR from Apps Script: %s" % result.get("error", "unknown error"))
        sys.exit(1)

    print("Success! %d row(s) synced." % result.get("count", len(rows)))


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
