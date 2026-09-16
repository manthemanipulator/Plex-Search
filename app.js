// =====================================================================
// Media Search PWA - app logic
// (was "Plex Search" - now also searches your Audiobookshelf library)
//
// Fill in CONFIG below after you've deployed the Apps Script backend.
// =====================================================================

const CONFIG = {
  // Your Apps Script Web App URL, e.g.
  // "https://script.google.com/macros/s/AKfycb.../exec"
  // Safe to leave as a plain constant here - useless without the secret
  // below, which is deliberately NOT stored in this file (see
  // getStoredSecret/ensureSecret). This file is served as-is to anyone
  // who visits the site, public repo or not, so anything that actually
  // grants access can't live here.
  API_URL: "https://script.google.com/macros/s/AKfycby66-WJTUbG_Q2rWJLiMgUanH1uQKo7oB3G78HZw1PHbNkoc_-ankCkr7FldRkfWX7n/exec",

  // Base URL of your Audiobookshelf server, no trailing slash - used to
  // build "Open in Audiobookshelf" links on audiobook results, e.g.
  // "http://192.168.1.50:13378" on home wifi, or your Tailscale address
  // once that's set up. This is just a link destination, not a secret -
  // fine to leave as a plain constant same as API_URL above.
  ABS_URL: "https://pnw-pi.tail32b8be.ts.net"
};

const STORAGE_KEYS = {
  inventory: "plex.inventory",
  audiobooks: "plex.audiobooks",
  wishlist: "plex.wishlist",
  pendingQueue: "plex.pendingQueue",
  lastSync: "plex.lastSync",
  librarySyncTime: "plex.librarySyncTime",
  audiobookSyncTime: "plex.audiobookSyncTime",
  apiSecret: "plex.apiSecret"
};

// How stale either side's sync data can get before the UI flags it as
// suspicious rather than just informational.
const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 2 days

let state = {
  inventory: [],
  audiobooks: [],
  wishlist: [],
  pendingQueue: [],
  // When THIS APP last successfully talked to the Apps Script API - proves
  // connectivity, but says nothing about how fresh the data itself is.
  lastSync: null,
  // When the Inventory sheet was last actually refreshed from your NAS's
  // CSV (read from the Sheet's own "Last Synced" column via the API's
  // syncTime field). If your NAS pipeline breaks, this timestamp freezes
  // even while `lastSync` above keeps updating every time you open the
  // app - that's the distinction that actually matters.
  librarySyncTime: null,
  // Same idea, for the Audiobooks sheet - set whenever the Mac Mini
  // export script last successfully pushed data in.
  audiobookSyncTime: null
};

let isSyncing = false;
let mode = "search"; // "search" (type to find something) or "wishlist" (browse everything on it)
let typeFilter = "all"; // "all" | "video" | "audiobook" - only applies in search mode

// What a wishlist entry can be tagged as - lets you tell apart "The
// Martian (movie)" from "The Martian (audiobook)" at a glance instead of
// wishlist items all looking identical. tagClass reuses the exact same
// color classes as library results (see CSS), so a wishlist "Movie" tag
// and an owned "Movie" tag read as the same category at a glance.
const WISH_TYPES = [
  { key: "movie", label: "Movie", tagClass: "movie" },
  { key: "tv", label: "TV Show", tagClass: "tv" },
  { key: "audiobook", label: "Audiobook", tagClass: "book" },
  { key: "other", label: "Other", tagClass: "otherType" }
];

function wishTypeMeta(key) {
  return WISH_TYPES.find((t) => t.key === key) || WISH_TYPES[WISH_TYPES.length - 1];
}

// Tracks whether the most recent real sync attempt (not just an early
// return for being offline/unconfigured) actually succeeded. Drives the
// app-sync status dot. null = no attempt made yet this session.
let lastSyncOk = null;

// ---------------------------------------------------------------------
// Local storage helpers
// ---------------------------------------------------------------------

// Wishlist entries used to be plain title strings; they're now
// {title, type} objects so each entry can carry what kind of thing it is.
// Anything still stored/returned in the old shape gets upgraded here
// rather than dropped, so nobody's existing wishlist disappears on update.
function normalizeWishlistEntry(w) {
  return typeof w === "string" ? { title: w, type: "other" } : w;
}

function loadLocalData() {
  try {
    state.inventory = JSON.parse(localStorage.getItem(STORAGE_KEYS.inventory) || "[]");
    state.audiobooks = JSON.parse(localStorage.getItem(STORAGE_KEYS.audiobooks) || "[]");
    state.wishlist = (JSON.parse(localStorage.getItem(STORAGE_KEYS.wishlist) || "[]")).map(normalizeWishlistEntry);
    state.pendingQueue = JSON.parse(localStorage.getItem(STORAGE_KEYS.pendingQueue) || "[]");
    state.lastSync = localStorage.getItem(STORAGE_KEYS.lastSync) || null;
    state.librarySyncTime = localStorage.getItem(STORAGE_KEYS.librarySyncTime) || null;
    state.audiobookSyncTime = localStorage.getItem(STORAGE_KEYS.audiobookSyncTime) || null;
  } catch (err) {
    console.error("Failed to load cached data, starting fresh.", err);
    state = { inventory: [], audiobooks: [], wishlist: [], pendingQueue: [], lastSync: null, librarySyncTime: null, audiobookSyncTime: null };
  }
}

function saveLocalData() {
  localStorage.setItem(STORAGE_KEYS.inventory, JSON.stringify(state.inventory));
  localStorage.setItem(STORAGE_KEYS.audiobooks, JSON.stringify(state.audiobooks));
  localStorage.setItem(STORAGE_KEYS.wishlist, JSON.stringify(state.wishlist));
  localStorage.setItem(STORAGE_KEYS.pendingQueue, JSON.stringify(state.pendingQueue));
  if (state.lastSync) localStorage.setItem(STORAGE_KEYS.lastSync, state.lastSync);
  if (state.librarySyncTime) localStorage.setItem(STORAGE_KEYS.librarySyncTime, state.librarySyncTime);
  if (state.audiobookSyncTime) localStorage.setItem(STORAGE_KEYS.audiobookSyncTime, state.audiobookSyncTime);
}

// A sync timestamp older than STALE_THRESHOLD_MS gets flagged in the UI.
// Parsing is defensive - if the value isn't a recognizable date (format
// varies slightly depending on whether Sheets auto-converted a CSV
// timestamp string to a real Date cell), we just skip the flag rather
// than show something wrong. Shared by both the movies/TV and audiobook
// timestamps.
function isTimestampStale(value) {
  if (!value) return false;
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return false;
  return Date.now() - parsed.getTime() > STALE_THRESHOLD_MS;
}

// The Sheet hands back timestamps as a full JS Date().toString(), e.g.
// "Wed Sep 09 2026 16:43:21 GMT-0700 (Pacific Daylight Time)" - technically
// readable, but it's a lot of text for "when did this last update." This
// shortens anything parseable down to "Sep 9, 4:43 PM" for display. Falls
// back to the original string untouched if it isn't a recognizable date,
// same defensive stance as isTimestampStale above - never hide data just
// because it didn't parse.
function formatTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

// ---------------------------------------------------------------------
// Search matching - identical logic to the original Apps Script version,
// runs entirely client-side so it works with zero connectivity.
// ---------------------------------------------------------------------

function isMatch(searchableText, query) {
  if (!searchableText) return false;
  const cleanText = searchableText.toString().toLowerCase().replace(/[^\w\s]/g, "");
  const cleanQuery = query.toLowerCase().replace(/[^\w\s]/g, "");
  const words = cleanQuery.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.every((w) => cleanText.includes(w));
}

// Audiobooks match on title, author, narrator, and series together - so
// searching "Sanderson" finds his books even when the title itself
// doesn't contain it, same way you'd search Audiobookshelf itself.
function audiobookSearchable(item) {
  return [item.title, item.author, item.narrator, item.series].filter(Boolean).join(" ");
}

function isInWishlist(title) {
  const clean = title.trim().toLowerCase();
  return state.wishlist.some((w) => w.title.trim().toLowerCase() === clean);
}

function isPending(title) {
  const clean = title.trim().toLowerCase();
  return state.pendingQueue.some((item) => item.title.trim().toLowerCase() === clean);
}

// ---------------------------------------------------------------------
// Wishlist actions (optimistic local update + queue for sync)
// ---------------------------------------------------------------------

function addToWishlistLocal(title, type) {
  if (isInWishlist(title)) return;
  const wishType = wishTypeMeta(type).key; // falls back to "other" for anything unrecognized
  state.wishlist.push({ title: title, type: wishType });
  state.pendingQueue.push({ action: "add", title: title, type: wishType, ts: new Date().toISOString() });
  saveLocalData();
  render();
  syncNow(); // fire and forget - will just re-queue if offline
}

function removeFromWishlistLocal(title) {
  const clean = title.trim().toLowerCase();
  state.wishlist = state.wishlist.filter((w) => w.title.trim().toLowerCase() !== clean);
  state.pendingQueue.push({ action: "remove", title: title, ts: new Date().toISOString() });
  saveLocalData();
  render();
  syncNow();
}

// ---------------------------------------------------------------------
// API secret - deliberately NOT a source-code constant. It's asked for
// once and kept only in this device's localStorage, so it never ships as
// part of the site anyone visiting the URL (or browsing the public repo)
// automatically receives.
// ---------------------------------------------------------------------

function getStoredSecret() {
  return localStorage.getItem(STORAGE_KEYS.apiSecret) || null;
}

function ensureSecret() {
  let secret = getStoredSecret();
  if (secret) return secret;
  secret = window.prompt(
    "Enter your Media Search API secret (the value you set via " +
    "'Set API Secret' in the Google Sheet's Media Tools menu):"
  );
  if (secret) {
    secret = secret.trim();
    if (secret) localStorage.setItem(STORAGE_KEYS.apiSecret, secret);
  }
  return secret || null;
}

function forgetStoredSecret() {
  localStorage.removeItem(STORAGE_KEYS.apiSecret);
}

// ---------------------------------------------------------------------
// Sync with the Apps Script API
// ---------------------------------------------------------------------

async function postToApi(payload) {
  const res = await fetch(CONFIG.API_URL, {
    method: "POST",
    // text/plain avoids a CORS preflight request, which Apps Script Web
    // Apps don't handle by default. The server still JSON.parse()s the
    // body regardless of the declared content type.
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// Fetching your library/wishlist goes through the same authenticated
// POST path as writes now, instead of an open GET anyone with the URL
// could read - see the "getData" action added to doPost in Code.gs.
async function fetchLatestData(secret) {
  return postToApi({ action: "getData", secret: secret });
}

async function syncNow() {
  if (isSyncing) return;
  if (!navigator.onLine) {
    setStatus("Offline - " + state.pendingQueue.length + " change(s) queued");
    return;
  }
  if (!CONFIG.API_URL || CONFIG.API_URL.indexOf("PASTE_YOUR") === 0) {
    setStatus("Not configured yet - set API_URL in app.js");
    return;
  }

  const secret = ensureSecret();
  if (!secret) {
    setStatus("API secret needed to sync - tap Sync Now to enter it");
    return;
  }

  isSyncing = true;
  setStatus("Syncing...");

  try {
    // Flush the pending queue in order. Stop on the first failure so we
    // don't silently drop or reorder anything - it'll retry next sync.
    while (state.pendingQueue.length > 0) {
      const item = state.pendingQueue[0];

      // Defensive: a queued item with no title can't ever be synced, and
      // without this it would retry the exact same broken item forever,
      // permanently blocking every future sync behind a "Missing title"
      // error. Drop it locally and move on instead.
      if (!item.title) {
        console.error("Dropping malformed pending queue item (no title):", item);
        state.pendingQueue.shift();
        saveLocalData();
        continue;
      }

      const result = await postToApi({
        action: item.action,
        title: item.title,
        type: item.type, // only meaningful for "add"; Code.gs ignores it on "remove"
        secret: secret
      });
      if (!result.ok) {
        console.error("Sync item rejected by server:", item, result.error);
        lastSyncOk = false;
        if (result.error === "Unauthorized") {
          // Wrong/stale secret - forget it so the next attempt re-prompts
          // instead of failing silently forever.
          forgetStoredSecret();
          setStatus("Wrong API secret - tap Sync Now to re-enter it");
        } else {
          setStatus("Sync error: " + (result.error || "unknown"));
        }
        isSyncing = false;
        return;
      }
      state.pendingQueue.shift();
      saveLocalData();
    }

    // Pull the freshest inventory/audiobooks/wishlist now that our writes landed.
    const fresh = await fetchLatestData(secret);
    if (!fresh.ok && fresh.error) {
      lastSyncOk = false;
      if (fresh.error === "Unauthorized") {
        forgetStoredSecret();
        setStatus("Wrong API secret - tap Sync Now to re-enter it");
      } else {
        setStatus("Sync error: " + fresh.error);
      }
      isSyncing = false;
      return;
    }
    state.inventory = fresh.inventory || [];
    state.audiobooks = fresh.audiobooks || [];
    // .map(normalizeWishlistEntry) is defensive: if Code.gs hasn't been
    // redeployed with the type-aware version yet, the Sheet still hands
    // back plain title strings - this keeps that case from breaking.
    state.wishlist = (fresh.wishlist || []).map(normalizeWishlistEntry);
    // fresh.syncTime / fresh.audiobookSyncTime come from each sheet's own
    // "last synced" column, NOT from this fetch happening successfully -
    // they only advance when the respective source pipeline (NAS CSV,
    // Mac Mini push) actually wrote new data.
    if (fresh.syncTime) state.librarySyncTime = fresh.syncTime;
    if (fresh.audiobookSyncTime) state.audiobookSyncTime = fresh.audiobookSyncTime;
    // Stored raw (not pre-formatted) so formatTimestamp() can shorten it
    // for display the same way it shortens the two Sheet-provided
    // timestamps above - one formatting path instead of two.
    state.lastSync = new Date().toISOString();
    lastSyncOk = true;
    saveLocalData();
    render();
    setStatus("Synced");
  } catch (err) {
    console.error("Sync failed:", err);
    lastSyncOk = false;
    setStatus("Sync failed - will retry (" + state.pendingQueue.length + " queued)");
  } finally {
    isSyncing = false;
  }
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;

  // Mirrors the same text as a subtitle under the "Sync Now" menu row, so
  // you can see it's working (or why it isn't) without having to drill
  // into About.
  const menuSyncStatusEl = document.getElementById("menuSyncStatus");
  if (menuSyncStatusEl) menuSyncStatusEl.textContent = text;

  // Each row's label (in the markup) already says what the value is, so
  // these just hold the (shortened) timestamp itself now - no more
  // "Movies/TV data from: <full sentence>" repeated for every row.
  const lastSyncEl = document.getElementById("lastSync");
  if (lastSyncEl) {
    lastSyncEl.textContent = state.lastSync ? formatTimestamp(state.lastSync) : "Never";
  }

  const libraryEl = document.getElementById("libraryUpdated");
  if (libraryEl) {
    libraryEl.textContent = state.librarySyncTime ? formatTimestamp(state.librarySyncTime) : "Unknown";
    libraryEl.classList.toggle("stale", isTimestampStale(state.librarySyncTime));
  }

  const audiobookEl = document.getElementById("audiobookUpdated");
  if (audiobookEl) {
    audiobookEl.textContent = state.audiobookSyncTime ? formatTimestamp(state.audiobookSyncTime) : "Unknown";
    audiobookEl.classList.toggle("stale", isTimestampStale(state.audiobookSyncTime));
  }

  updateStatusDots();
}

// Two dots replace the old wall of status text: one for whether the app
// itself is syncing OK (accounts for being offline too), one for whether
// EITHER side's library data is stale/missing. Full detail lives in the
// dropdown panel behind the hamburger button.
function updateStatusDots() {
  const appDot = document.getElementById("appSyncDot");
  if (appDot) {
    let cls = "neutral";
    if (!navigator.onLine) {
      cls = "neutral"; // can't sync right now, but that's expected, not an error
    } else if (!state.lastSync || lastSyncOk === false) {
      cls = "bad";
    } else if (lastSyncOk === true) {
      cls = "ok";
    }
    appDot.className = "statusDot " + cls;
  }

  const libraryDot = document.getElementById("librarySyncDot");
  if (libraryDot) {
    const bad = !state.librarySyncTime || isTimestampStale(state.librarySyncTime) ||
                !state.audiobookSyncTime || isTimestampStale(state.audiobookSyncTime);
    libraryDot.className = "statusDot " + (bad ? "bad" : "ok");
  }
}

// The hamburger opens #menuPanel showing three rows (Sync Now / Wishlist /
// About). About swaps in a second "screen" (#aboutPanel) inside the same
// popover rather than opening anything separate - showMenuListView/
// showAboutView flip between the two, and the panel always resets to the
// list view each time it's freshly opened.
function showMenuListView() {
  const list = document.getElementById("menuList");
  const about = document.getElementById("aboutPanel");
  if (list) list.classList.remove("hidden");
  if (about) about.classList.add("hidden");
}

function showAboutView() {
  const list = document.getElementById("menuList");
  const about = document.getElementById("aboutPanel");
  if (list) list.classList.add("hidden");
  if (about) about.classList.remove("hidden");
  refreshAppBuildLine(); // fresh read each time About is actually opened
}

function closeMenuPanel() {
  const panel = document.getElementById("menuPanel");
  const btn = document.getElementById("menuBtn");
  if (!panel || !btn) return;
  panel.classList.add("hidden");
  btn.setAttribute("aria-expanded", "false");
}

function toggleMenuPanel() {
  const panel = document.getElementById("menuPanel");
  const btn = document.getElementById("menuBtn");
  if (!panel || !btn) return;
  const nowHidden = panel.classList.toggle("hidden");
  btn.setAttribute("aria-expanded", String(!nowHidden));
  if (!nowHidden) showMenuListView(); // just opened - always start at the top-level list
}

// Asks whichever service worker is ACTUALLY controlling this page right
// now for its own CACHE_NAME, rather than trusting a version number
// hardcoded in this file - app.js itself could be the stale cached copy,
// so it can't be a trustworthy witness about its own freshness. This is
// how you tell "did my phone actually pick up the latest push" apart from
// "the site changed but this device is still on an old cached version."
function getActiveServiceWorkerVersion() {
  function askController() {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        navigator.serviceWorker.removeEventListener("message", onMessage);
        resolve(null);
      }, 1500);
      function onMessage(event) {
        if (event.data && event.data.type === "VERSION") {
          clearTimeout(timeoutId);
          navigator.serviceWorker.removeEventListener("message", onMessage);
          resolve(event.data.version);
        }
      }
      navigator.serviceWorker.addEventListener("message", onMessage);
      navigator.serviceWorker.controller.postMessage({ type: "GET_VERSION" });
    });
  }

  return new Promise((resolve) => {
    if (!("serviceWorker" in navigator)) {
      resolve("service workers not supported in this browser");
      return;
    }
    if (navigator.serviceWorker.controller) {
      askController().then((v) => resolve(v || "no response - try reloading"));
      return;
    }

    // No controller yet is expected for a brief moment right after a
    // fresh install/update, before the new service worker's
    // self.clients.claim() has actually taken effect - it doesn't
    // require a manual reload, just a moment. Poll for up to ~3 seconds
    // before actually telling the user to reload.
    navigator.serviceWorker.ready.then(() => {
      let attempts = 0;
      (function tryAgain() {
        if (navigator.serviceWorker.controller) {
          askController().then((v) => resolve(v || "no response - try reloading"));
          return;
        }
        attempts++;
        if (attempts >= 6) {
          resolve("no service worker controlling this page yet - try reloading");
          return;
        }
        setTimeout(tryAgain, 500);
      })();
    });
  });
}

function refreshAppBuildLine() {
  const el = document.getElementById("appBuild");
  if (!el) return;
  getActiveServiceWorkerVersion().then((version) => {
    el.textContent = "App build: " + version;
  });
}

function formatDuration(seconds) {
  seconds = Math.round(Number(seconds) || 0);
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h && m) return h + "h " + m + "m";
  if (h) return h + "h";
  return m + "m";
}

// The old always-visible "830 movies, 33 TV Shows, 76 audiobooks" text
// line is gone - it was redundant with the big stat tiles shown on the
// idle search screen (see renderIdleTiles). All that's left to keep live
// here is the Wishlist row inside the menu, which doubles as the mode
// toggle (its label flips to "Back to Search" once you're in wishlist
// mode, same behavior the old modeToggle button had).
function updateMenuWishlistItem() {
  const label = document.getElementById("menuWishlistLabel");
  const sub = document.getElementById("menuWishlistCount");
  if (!label || !sub) return;
  if (mode === "wishlist") {
    label.textContent = "Back to Search";
    sub.textContent = "";
  } else {
    label.textContent = "Wishlist";
    sub.textContent = state.wishlist.length + (state.wishlist.length === 1 ? " item" : " items");
  }
}

// Clicking the "Media Search" title is a shortcut back to the main search
// screen - closes the menu/about popover if it's open, and drops out of
// Wishlist mode if that's where you were. Reuses toggleMode() rather than
// duplicating its mode-switch logic, since with only two modes "make sure
// we're on search" and "toggle off wishlist" are the same operation.
function goToSearch() {
  closeMenuPanel();
  if (mode !== "search") toggleMode();
}

// Shows/hides the little "x" inside the search box - only worth having
// once there's actually something typed to clear.
function updateClearButton() {
  const input = document.getElementById("q");
  const btn = document.getElementById("clearSearchBtn");
  if (!input || !btn) return;
  btn.classList.toggle("visible", input.value.length > 0);
}

function clearSearch() {
  const input = document.getElementById("q");
  if (!input) return;
  input.value = "";
  updateClearButton();
  render();
  input.focus();
}

function toggleMode() {
  mode = mode === "search" ? "wishlist" : "search";
  const input = document.getElementById("q");
  const filterRow = document.getElementById("filterRow");
  input.placeholder = mode === "wishlist" ? "Filter wishlist (optional)..." : "Search movies, TV & audiobooks...";
  if (filterRow) filterRow.classList.toggle("hidden", mode === "wishlist");
  render();
}

function setTypeFilter(value) {
  typeFilter = value;
  document.querySelectorAll(".filterChip").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === value);
  });
  render();
}

function makeResultRow(opts) {
  // opts: { title, sub, tags: [{tagClass, tagText}, ...], wishlistTitle, openUrl }
  const div = document.createElement("div");
  div.className = "result";

  const main = document.createElement("div");
  main.className = "resultMain";
  const titleEl = document.createElement("span");
  titleEl.className = "resultTitle";
  titleEl.textContent = opts.title;
  main.appendChild(titleEl);
  if (opts.sub) {
    const subEl = document.createElement("span");
    subEl.className = "resultSub";
    subEl.textContent = opts.sub;
    main.appendChild(subEl);
  }
  div.appendChild(main);

  // Most rows have one tag (Movie/TV Show/Audiobook); wishlist rows get
  // two - the type tag plus the gold "Wishlist" tag - so this is a list
  // now instead of a single tagClass/tagText pair.
  (opts.tags || []).forEach((t) => {
    const tag = document.createElement("span");
    tag.className = "tag " + t.tagClass;
    tag.textContent = t.tagText;
    div.appendChild(tag);
  });

  if (opts.openUrl) {
    const openBtn = document.createElement("a");
    openBtn.className = "openBtn";
    openBtn.textContent = "Open";
    openBtn.href = opts.openUrl;
    openBtn.target = "_blank";
    openBtn.rel = "noopener";
    div.appendChild(openBtn);
  }

  if (opts.wishlistTitle) {
    const removeBtn = document.createElement("button");
    removeBtn.className = "removeBtn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeFromWishlistLocal(opts.wishlistTitle));
    div.appendChild(removeBtn);
  }

  return div;
}

function render() {
  updateMenuWishlistItem();
  const query = document.getElementById("q").value.trim();
  const resultsEl = document.getElementById("results");
  const emptyEl = document.getElementById("empty");
  resultsEl.innerHTML = "";
  emptyEl.innerHTML = "";

  if (mode === "wishlist") {
    renderWishlistMode(query, resultsEl, emptyEl);
  } else {
    renderSearchMode(query, resultsEl, emptyEl);
  }
}

// Browse (and optionally filter) everything currently on the wishlist,
// with a Remove button on each row - this is the "what did I already add?"
// view, independent of the search box. Not affected by the movies/TV vs
// audiobooks filter chips, since wishlist entries aren't typed.
function renderWishlistMode(query, resultsEl, emptyEl) {
  const items = state.wishlist
    .filter((w) => !query || isMatch(w.title, query))
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title));

  if (items.length === 0) {
    emptyEl.style.display = "block";
    const msg = document.createElement("div");
    msg.textContent = query
      ? 'No wishlist items match "' + query + '".'
      : "Your wishlist is empty.";
    emptyEl.appendChild(msg);
    return;
  }

  emptyEl.style.display = "none";
  items.forEach((w) => {
    const pending = isPending(w.title);
    const meta = wishTypeMeta(w.type);
    const row = makeResultRow({
      title: w.title + (pending ? " (pending sync)" : ""),
      tags: [
        { tagClass: meta.tagClass, tagText: meta.label },
        { tagClass: "wish", tagText: "Wishlist" }
      ],
      wishlistTitle: w.title
    });
    resultsEl.appendChild(row);
  });
}

// Fills the space below the search box before you've typed anything -
// previously just blank. Four big, tappable tiles: Movies/TV/Audiobooks
// jump the filter chip and refocus the search box (a nudge toward typing,
// since this app is search-only and doesn't browse full lists), Wishlist
// jumps straight into wishlist mode, same as the header button.
function renderIdleTiles(resultsEl) {
  const movieCount = state.inventory.filter((item) => item.type !== "TV Show").length;
  const tvCount = state.inventory.length - movieCount;
  const bookCount = state.audiobooks.length;
  const wishCount = state.wishlist.length;

  const tiles = [
    { num: movieCount, label: "Movies", filter: "video" },
    { num: tvCount, label: "TV Shows", filter: "video" },
    { num: bookCount, label: "Audiobooks", filter: "audiobook" },
    { num: wishCount, label: "Wishlist", action: "wishlist" }
  ];

  const grid = document.createElement("div");
  grid.className = "statGrid";
  tiles.forEach((t) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "statCard";

    const num = document.createElement("span");
    num.className = "statNum";
    num.textContent = t.num;
    card.appendChild(num);

    const label = document.createElement("span");
    label.className = "statLabel";
    label.textContent = t.label;
    card.appendChild(label);

    card.addEventListener("click", () => {
      if (t.action === "wishlist") {
        toggleMode();
      } else {
        setTypeFilter(t.filter);
        document.getElementById("q").focus();
      }
    });
    grid.appendChild(card);
  });
  resultsEl.appendChild(grid);

  const hint = document.createElement("div");
  hint.className = "idleHint";
  hint.textContent = "Start typing above to search your library.";
  resultsEl.appendChild(hint);
}

// Type-to-search against your library (movies/TV + audiobooks, per the
// active filter chip) and the wishlist - a checkmark-style tag if you
// already have it, or a button to add it to the wishlist if nothing
// matched at all.
function renderSearchMode(query, resultsEl, emptyEl) {
  if (!query) {
    emptyEl.style.display = "none";
    renderIdleTiles(resultsEl);
    return;
  }

  const matches = [];

  if (typeFilter !== "audiobook") {
    state.inventory.forEach((item) => {
      if (isMatch(item.title, query)) {
        matches.push({
          title: item.title + (item.year ? " (" + item.year + ")" : ""),
          tags: [{ tagClass: item.type === "TV Show" ? "tv" : "movie", tagText: item.type === "TV Show" ? "TV" : "Movie" }],
          wishlistTitle: null
        });
      }
    });
  }

  if (typeFilter !== "video") {
    state.audiobooks.forEach((item) => {
      if (isMatch(audiobookSearchable(item), query)) {
        const subParts = [];
        if (item.author) subParts.push(item.author);
        if (item.series) subParts.push(item.series + (item.seriesNum ? " #" + item.seriesNum : ""));
        if (item.narrator) subParts.push("narr. " + item.narrator);
        const dur = formatDuration(item.durationSec);
        if (dur) subParts.push(dur);

        let openUrl = null;
        if (item.absId && CONFIG.ABS_URL && CONFIG.ABS_URL.indexOf("PASTE_YOUR") !== 0) {
          openUrl = CONFIG.ABS_URL.replace(/\/$/, "") + "/item/" + encodeURIComponent(item.absId);
        }

        matches.push({
          title: item.title,
          sub: subParts.join(" · "),
          tags: [{ tagClass: "book", tagText: "Audiobook" }],
          wishlistTitle: null,
          openUrl: openUrl
        });
      }
    });
  }

  state.wishlist.forEach((w) => {
    if (isMatch(w.title, query)) {
      const pending = isPending(w.title);
      const meta = wishTypeMeta(w.type);
      matches.push({
        title: w.title + (pending ? " (pending sync)" : ""),
        tags: [
          { tagClass: meta.tagClass, tagText: meta.label },
          { tagClass: "wish", tagText: "Wishlist" }
        ],
        wishlistTitle: w.title
      });
    }
  });

  if (matches.length === 0) {
    emptyEl.style.display = "block";
    const msg = document.createElement("div");
    msg.textContent = "No matches in your library or wishlist.";
    emptyEl.appendChild(msg);

    // Ask what kind of thing this is right when it's added, instead of
    // every wishlist entry looking the same - this is what tells "The
    // Martian (movie)" apart from "The Martian (audiobook)" later.
    const label = document.createElement("div");
    label.className = "addPrompt";
    label.textContent = 'Add "' + query + '" to Wishlist as:';
    emptyEl.appendChild(label);

    const btnRow = document.createElement("div");
    btnRow.className = "addBtnRow";
    WISH_TYPES.forEach((t) => {
      const btn = document.createElement("button");
      btn.className = "addTypeBtn " + t.tagClass;
      btn.textContent = t.label;
      btn.addEventListener("click", () => {
        addToWishlistLocal(query, t.key);
        document.getElementById("q").value = "";
        render();
      });
      btnRow.appendChild(btn);
    });
    emptyEl.appendChild(btnRow);
    return;
  }

  emptyEl.style.display = "none";
  matches.forEach((m) => {
    resultsEl.appendChild(makeResultRow(m));
  });
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

function init() {
  loadLocalData();
  render();
  setStatus(navigator.onLine ? "Ready" : "Offline");

  document.getElementById("appTitle").addEventListener("click", goToSearch);
  document.getElementById("appTitle").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault(); // stop Space from also scrolling the page
      goToSearch();
    }
  });

  document.getElementById("q").addEventListener("input", () => {
    updateClearButton();
    render();
  });
  document.getElementById("clearSearchBtn").addEventListener("click", clearSearch);
  updateClearButton(); // in case the browser restored a typed value on reload
  document.querySelectorAll(".filterChip").forEach((btn) => {
    btn.addEventListener("click", () => setTypeFilter(btn.dataset.filter));
  });

  // Sync stays open afterward so you can watch "Syncing..." resolve into
  // "Synced" (or an error) right there in the menu; Wishlist swaps the
  // whole main screen so the menu closes to get out of the way; About
  // swaps to the second "screen" inside the same popover instead of
  // closing.
  document.getElementById("menuSyncBtn").addEventListener("click", syncNow);
  document.getElementById("menuWishlistBtn").addEventListener("click", () => {
    toggleMode();
    closeMenuPanel();
  });
  document.getElementById("menuAboutBtn").addEventListener("click", showAboutView);
  document.getElementById("aboutBackBtn").addEventListener("click", showMenuListView);

  const menuBtn = document.getElementById("menuBtn");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let this same click immediately re-trigger the outside-click-closes handler below
    toggleMenuPanel();
  });
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("menuPanel");
    if (!panel || panel.classList.contains("hidden")) return;
    if (panel.contains(e.target)) return; // clicks inside the panel shouldn't close it
    closeMenuPanel();
  });

  window.addEventListener("online", () => {
    setStatus("Back online - syncing...");
    syncNow();
  });
  window.addEventListener("offline", () => {
    setStatus("Offline - " + state.pendingQueue.length + " change(s) queued");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch((err) => {
      console.error("Service worker registration failed:", err);
    });
    // Fires when a newly-activated service worker takes over the page
    // (e.g. right after an update finishes installing) - refresh the
    // build line so it doesn't keep showing the version that was active
    // when the page first loaded.
    navigator.serviceWorker.addEventListener("controllerchange", refreshAppBuildLine);
  }
  refreshAppBuildLine();

  // Ask the browser not to evict this app's storage (cached library,
  // wishlist, and any not-yet-synced pending queue) under low-storage
  // pressure. Chrome/Android honors this fairly reliably; iOS WebKit
  // (which is what every iOS browser runs on, Chrome included) has
  // historically been inconsistent about it - this can't hurt, but
  // isn't a guarantee there either.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then((granted) => {
      console.log(granted
        ? "Storage persistence granted - less likely to be evicted under storage pressure."
        : "Storage persistence not granted - browser may still evict data if the device runs low on space.");
    }).catch((err) => {
      console.error("Storage persistence request failed:", err);
    });
  }

  if (navigator.onLine) syncNow();
}

document.addEventListener("DOMContentLoaded", init);
