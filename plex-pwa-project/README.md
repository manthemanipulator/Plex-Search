# Plex Search PWA — Setup Walkthrough

This folder has everything from the rebuild plan, ready to deploy:

```
plex-pwa-project/
├── apps-script/
│   └── Code.gs              ← paste into your existing Apps Script project
└── pwa/
    ├── index.html            ← the app UI
    ├── app.js                ← search, offline cache, sync logic
    ├── manifest.json          ← makes it installable
    ├── service-worker.js      ← makes it work offline
    ├── icon-192.png
    └── icon-512.png
```

Do the steps in order — the Apps Script side first, since the PWA needs its URL and secret to talk to it.

## Part 1 — Update your Apps Script project (~10 minutes)

1. Open your existing Plex Search Google Sheet, then **Extensions → Apps Script**.
2. Select all the existing code in the editor and delete it, then paste in the contents of `apps-script/Code.gs`.
3. Save (Ctrl/Cmd+S).
4. Reload the Google Sheet in your browser. You should see a **Plex Tools** menu appear (same as before, plus one new item).
5. Click **Plex Tools → Set API Secret**. Enter a long random string — mash the keyboard, or use a password generator, doesn't need to be memorable, just long (20+ characters is plenty). Click OK. This gets stored in the script's properties and is what stops a random person from writing to your wishlist if they ever guessed your web app URL.
6. **Keep that string handy** — you'll paste it into `app.js` in Part 2.
7. In the Apps Script editor, click **Deploy → Manage deployments**. Click the pencil/edit icon on your existing web app deployment.
8. Under "Version," choose **New version**, then click **Deploy**. This publishes the updated code (the JSON API) to your existing URL.
9. Copy the **Web app URL** shown (looks like `https://script.google.com/macros/s/AKfycb.../exec`). You'll need this too.

If you don't have an existing deployment (starting fresh), use **Deploy → New deployment**, type = Web app, execute as "Me", who has access = "Anyone", then Deploy.

## Part 2 — Configure the PWA (~2 minutes)

1. Open `pwa/app.js` in any text editor.
2. Near the top, find the `CONFIG` block and fill in the two values from Part 1:

   ```js
   const CONFIG = {
     API_URL: "https://script.google.com/macros/s/AKfycb.../exec",
     API_SECRET: "the-long-random-string-you-set"
   };
   ```
3. Save the file.

## Part 3 — Host it on GitHub Pages (~10 minutes)

1. Create a new GitHub repository (e.g. `plex-search`). Public is simplest — Pages on private repos needs a paid GitHub plan on some account tiers.
2. Upload the contents of the `pwa/` folder to the repo (not the folder itself — the files `index.html`, `app.js`, `manifest.json`, `service-worker.js`, and both icons should sit at the repo root, or all together in one subfolder like `/docs`).
   - Easiest path if you're not comfortable with git command line: on the repo's GitHub page, click **Add file → Upload files**, drag in all 6 files from `pwa/`, commit.
3. Go to the repo's **Settings → Pages**.
4. Under "Build and deployment," set Source to **Deploy from a branch**, branch = `main`, folder = `/ (root)` (or `/docs` if you put the files there). Save.
5. GitHub will give you a URL after a minute or two, like `https://yourusername.github.io/plex-search/`. Open it in a browser to confirm the app loads and the search box appears.

## Part 4 — Install it on your phone (~1 minute)

1. On your phone, open the GitHub Pages URL from Part 3 in Safari (iPhone) or Chrome (Android).
2. Safari: tap the Share icon → **Add to Home Screen**. Chrome: tap the ⋮ menu → **Add to Home Screen** / **Install app**.
3. You now have an app icon. Opening it launches full-screen, no browser chrome — and once it's loaded once with signal, it'll keep opening even with none.

## Part 5 — Test it before you actually need it

1. With signal, open the app once so it can do its first sync (you'll see the status line say "Synced" and a title/wishlist count appear).
2. Turn on Airplane Mode. **Fully close the app** (swipe it away, don't just background it), then reopen it. Confirm it still opens and search still works against your library.
3. While still in Airplane Mode, search for something not in your library and tap **Add to Wishlist**. Confirm it shows up in the wishlist search results, tagged (pending sync).
4. Turn Airplane Mode off. Within a few seconds (or tap **Sync Now** to force it) confirm the "(pending sync)" tag disappears and the title shows up in your actual Google Sheet's Wishlist tab.
5. Optional: leave the app untouched for a day or two, then check whether "Last synced" reflects that honestly rather than looking falsely current.

## Updating it later

- **Changed `app.js`, `index.html`, or CSS?** Before uploading the new version to GitHub, bump the `CACHE_NAME` value at the top of `service-worker.js` (e.g. `plex-search-v1` → `plex-search-v2`). This forces phones to fetch the new files instead of serving the old cached version forever. Push the updated files, then reopen the app on your phone with signal once to pick up the update.
- **Changed anything in `Code.gs`?** Repeat step 7–8 from Part 1 (Deploy → Manage deployments → edit → New version) — editing the script alone doesn't republish it.

## Troubleshooting

- **"Not configured yet" status message** — you forgot to fill in `CONFIG.API_URL` / `CONFIG.API_SECRET` in `app.js` before uploading it.
- **"Sync error: Unauthorized"** — the secret in `app.js` doesn't match what's stored in the Sheet. Re-run "Set API Secret" and re-copy it carefully (watch for trailing spaces).
- **Sync just hangs / never succeeds even with signal** — open the Apps Script editor's **Executions** log (left sidebar) to see if `doGet`/`doPost` are being hit and whether they're erroring. Also double check the deployment in Part 1 step 7–8 was actually redeployed as a *new version*, not just saved.
- **App doesn't show "Add to Home Screen" as a full-screen install** — some browsers only offer this after you've visited the page a couple of times, or need `manifest.json` to load successfully first (check for a console error).
