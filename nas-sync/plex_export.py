import csv
import os
import sys
from datetime import datetime
from plexapi.server import PlexServer

# --- Configuration ---
baseurl = 'http://127.0.0.1:32400'
token = 'REDACTED_PLEX_TOKEN'
csv_file_path = '/volume1/Data/Python/plex_library_export.csv'

# Names of your Plex library sections, in case yours differ from the defaults
movie_section_name = 'Movies'
tv_section_name = 'TV Shows'

# Refuse to overwrite the existing CSV if the new scan comes back with
# fewer than this fraction of the titles currently on disk. Catches a
# partial/failed scan (Plex hiccup, renamed section, etc.) before it
# silently wipes out a good file - genuinely removing that many titles
# on purpose is rare enough that this is a safe default.
MIN_FRACTION_OF_EXISTING = 0.5


def count_existing_rows(path):
    if not os.path.exists(path):
        return 0
    with open(path, newline='', encoding='utf-8') as f:
        return max(sum(1 for _ in csv.reader(f)) - 1, 0)  # minus header


def main():
    current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    print("Connecting to Plex...")
    plex = PlexServer(baseurl, token)
    library_data = []
    section_errors = []

    # --- Movies ---
    try:
        print(f"Scanning '{movie_section_name}' library...")
        movies = plex.library.section(movie_section_name).search()
        for video in movies:
            library_data.append({
                'Title': video.title,
                'Year': video.year if video.year else 'Unknown',
                'Last Synced': current_time,
                'Type': 'Movie'
            })
        print(f"  Found {len(movies)} movies.")
    except Exception as e:
        print(f"  Skipped movies: {e}")
        section_errors.append(f"movies: {e}")

    # --- TV Shows ---
    try:
        print(f"Scanning '{tv_section_name}' library...")
        shows = plex.library.section(tv_section_name).search()
        for show in shows:
            library_data.append({
                'Title': show.title,
                'Year': show.year if show.year else 'Unknown',
                'Last Synced': current_time,
                'Type': 'TV Show'
            })
        print(f"  Found {len(shows)} TV shows.")
    except Exception as e:
        print(f"  Skipped TV shows: {e}")
        section_errors.append(f"TV shows: {e}")

    existing_count = count_existing_rows(csv_file_path)
    new_count = len(library_data)

    # Safety check: don't let a bad scan silently overwrite a good file.
    if existing_count > 10 and new_count < existing_count * MIN_FRACTION_OF_EXISTING:
        print(
            f"REFUSING TO WRITE: new scan found {new_count} titles vs "
            f"{existing_count} currently in the CSV - this looks like a "
            f"failed/partial scan, not a real library change. Leaving the "
            f"existing file untouched."
        )
        sys.exit(1)

    if new_count == 0:
        print("REFUSING TO WRITE: scan found 0 titles across both sections. Leaving the existing file untouched.")
        sys.exit(1)

    # 'Type' was added as a new 4th column. 'Last Synced' stays column C so the
    # Apps Script's getLastSyncTime() (which reads row 2, column 3) still works.
    csv_columns = ['Title', 'Year', 'Last Synced', 'Type']

    with open(csv_file_path, 'w', newline='', encoding='utf-8') as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=csv_columns)
        writer.writeheader()
        for data in library_data:
            writer.writerow(data)

    print(f"Success! {new_count} titles exported to {csv_file_path}")

    # Both sections failing outright (e.g. Plex unreachable) but somehow
    # still producing rows shouldn't happen, but if a section genuinely
    # errored while the other succeeded, surface that as a non-fatal
    # warning - the file's still valid, just incomplete - so a
    # scheduler-level notification can catch it if one's ever wired up.
    if section_errors:
        print("WARNING: one or more sections had errors and were skipped: " + "; ".join(section_errors))
        sys.exit(2)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"An error occurred: {e}")
        sys.exit(1)
