#!/bin/bash
# Wrapper for plex_export.py - fill in the real values below, then save
# this OUTSIDE the git repo (same reasoning as run_audiobook_export.sh):
# this file holds real secrets, the repo does not.
#
# One-time setup:
#   1. Fill in PLEX_URL, PLEX_TOKEN, APPS_SCRIPT_URL, APPS_SCRIPT_SECRET
#      below (APPS_SCRIPT_URL/SECRET are the SAME values already in
#      run_audiobook_export.sh - copy them from there).
#   2. chmod +x run_plex_export.sh
#   3. Test it by hand first: ./run_plex_export.sh
#      then check the output (and the Inventory tab in the Sheet) before
#      trusting this to cron unattended.
#   4. Add to crontab (crontab -e) once you're happy with it - a few times
#      a day is plenty, since your Plex library doesn't change that often:
#        0 */6 * * * /Users/thompsons/audiobookshelf/scripts/run_plex_export.sh >> "$HOME/plex_export.log" 2>&1
#      (adjust the path to wherever you actually save this script)
#
# This is meant to run ALONGSIDE the existing NAS -> Google Drive -> Apps
# Script trigger path for now, not replace it yet - both write the same
# Inventory columns, so having both running for a while is a safe way to
# confirm this one is reliable before you turn the old one off (delete the
# NAS-side scheduled task, and clear the Apps Script trigger via
# Media Tools > the trigger it created, or just leave it - it's harmless
# to have both, just slightly redundant).

export PLEX_URL="PASTE_YOUR_PLEX_SERVER_URL_HERE"          # e.g. http://192.168.1.50:32400
export PLEX_TOKEN="PASTE_YOUR_PLEX_TOKEN_HERE"
export APPS_SCRIPT_URL="PASTE_YOUR_EXISTING_APPS_SCRIPT_URL_HERE"
export APPS_SCRIPT_SECRET="PASTE_YOUR_EXISTING_APPS_SCRIPT_SECRET_HERE"

python3 /Users/thompsons/audiobookshelf/scripts/plex_export_from_mac_mini.py
