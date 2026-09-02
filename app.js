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
  ABS_URL: "http://192.168.68.11:13378"
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

// Tracks whether the most recent real sync attempt (not just an early
// return for being offline/unconfigured) actually succeeded. Drives the
// app-sync status dot. null = no attempt made yet this session.
let lastSyncOk = null;

// ---------------------------------------------------------------------
// Local storage helpers
// ---------------------------------------------------------------------

function loadLocalData() {
  try {
    state.inventory = JSON.parse(localStorage.getItem(STORAGE_KEYS.inventory) || "[]");
    state.audiobooks = JSON.parse(localStorage.getItem(STORAGE_KEYS.audiobooks) || "[]");
    state.wishlist = JSON.parse(localStorage.getItem(STORAGE_KEYS.wishlist) || "[]");
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
  return state.wishlist.some((w) => w.trim().toLowerCase() === clean);
}

function isPending(title) {
  const clean = title.trim().toLowerCase();
  return state.pendingQueue.some((item) => item.title.trim().toLowerCase() === clean);
}

// ---------------------------------------------------------------------
// Wishlist actions (optimistic local update + queue for sync)
// ---------------------------------------------------------------------

function addToWishlistLocal(title) {
  if (isInWishlist(title)) return;
  state.wishlist.push(title);
  state.pendingQueue.push({ action: "add", title: title, ts: new Date().toISOString() });
  saveLocalData();
  render();
  syncNow(); // fire and forget - will just re-queue if offline
}

function removeFromWishlistLocal(title) {
  const clean = title.trim().toLowerCase();
  state.wishlist = state.wishlist.filter((w) => w.trim().toLowerCase() !== clean);
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
    state.wishlist = fresh.wishlist || [];
    // fresh.syncTime / fresh.audiobookSyncTime come from each sheet's own
    // "last synced" column, NOT from this fetch happening successfully -
    // they only advance when the respective source pipeline (NAS CSV,
    // Mac Mini push) actually wrote new data.
    if (fresh.syncTime) state.librarySyncTime = fresh.syncTime;
    if (fresh.audiobookSyncTime) state.audiobookSyncTime = fresh.audiobookSyncTime;
    state.lastSync = new Date().toLocaleString();
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

  const lastSyncEl = document.getElementById("lastSync");
  if (lastSyncEl) {
    lastSyncEl.textContent = state.lastSync ? "App synced: " + state.lastSync : "App never synced yet";
  }

  const libraryEl = document.getElementById("libraryUpdated");
  if (libraryEl) {
    libraryEl.textContent = state.librarySyncTime
      ? "Movies/TV data from: " + state.librarySyncTime
      : "Movies/TV data from: unknown";
    libraryEl.className = isTimestampStale(state.librarySyncTime) ? "stale" : "";
  }

  const audiobookEl = document.getElementById("audiobookUpdated");
  if (audiobookEl) {
    audiobookEl.textContent = state.audiobookSyncTime
      ? "Audiobook data from: " + state.audiobookSyncTime
      : "Audiobook data from: unknown";
    audiobookEl.className = isTimestampStale(state.audiobookSyncTime) ? "stale" : "";
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

function toggleDetailsPanel() {
  const panel = document.getElementById("detailsPanel");
  const btn = document.getElementById("menuBtn");
  if (!panel || !btn) return;
  const nowHidden = panel.classList.toggle("hidden");
  btn.setAttribute("aria-expanded", String(!nowHidden));
  if (!nowHidden) refreshAppBuildLine(); // just opened - get a fresh read each time
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

function renderCounts() {
  const countEl = document.getElementById("count");
  if (countEl) {
    const movieCount = state.inventory.filter((item) => item.type !== "TV Show").length;
    const tvCount = state.inventory.length - movieCount;
    const bookCount = state.audiobooks.length;
    countEl.textContent = movieCount + " movies, " + tvCount + " TV, " + bookCount + " audiobooks";
  }
  const toggleBtn = document.getElementById("modeToggle");
  if (toggleBtn) {
    toggleBtn.textContent = mode === "wishlist" ? "Back to Search" : "View Wishlist (" + state.wishlist.length + ")";
  }
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
  // opts: { title, sub, tagClass, tagText, wishlistTitle, openUrl }
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

  const tag = document.createElement("span");
  tag.className = "tag " + opts.tagClass;
  tag.textContent = opts.tagText;
  div.appendChild(tag);

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
  renderCounts();
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
    .filter((title) => !query || isMatch(title, query))
    .slice()
    .sort((a, b) => a.localeCompare(b));

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
  items.forEach((title) => {
    const pending = isPending(title);
    const row = makeResultRow({
      title: title + (pending ? " (pending sync)" : ""),
      tagClass: "wish",
      tagText: "Wishlist",
      wishlistTitle: title
    });
    resultsEl.appendChild(row);
  });
}

// Type-to-search against your library (movies/TV + audiobooks, per the
// active filter chip) and the wishlist - a checkmark-style tag if you
// already have it, or a button to add it to the wishlist if nothing
// matched at all.
function renderSearchMode(query, resultsEl, emptyEl) {
  if (!query) {
    emptyEl.style.display = "none";
    return;
  }

  const matches = [];

  if (typeFilter !== "audiobook") {
    state.inventory.forEach((item) => {
      if (isMatch(item.title, query)) {
        matches.push({
          title: item.title + (item.year ? " (" + item.year + ")" : ""),
          tagClass: item.type === "TV Show" ? "tv" : "movie",
          tagText: item.type === "TV Show" ? "TV" : "Movie",
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
          tagClass: "book",
          tagText: "Audiobook",
          wishlistTitle: null,
          openUrl: openUrl
        });
      }
    });
  }

  state.wishlist.forEach((title) => {
    if (isMatch(title, query)) {
      const pending = isPending(title);
      matches.push({
        title: title + (pending ? " (pending sync)" : ""),
        tagClass: "wish",
        tagText: "Wishlist",
        wishlistTitle: title
      });
    }
  });

  if (matches.length === 0) {
    emptyEl.style.display = "block";
    const msg = document.createElement("div");
    msg.textContent = "No matches in your library or wishlist.";
    emptyEl.appendChild(msg);

    const addBtn = document.createElement("button");
    addBtn.className = "addBtn";
    addBtn.textContent = 'Add "' + query + '" to Wishlist';
    addBtn.addEventListener("click", () => {
      addToWishlistLocal(query);
      document.getElementById("q").value = "";
      render();
    });
    emptyEl.appendChild(addBtn);
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

  document.getElementById("q").addEventListener("input", render);
  document.getElementById("syncBtn").addEventListener("click", syncNow);
  document.getElementById("modeToggle").addEventListener("click", toggleMode);
  document.querySelectorAll(".filterChip").forEach((btn) => {
    btn.addEventListener("click", () => setTypeFilter(btn.dataset.filter));
  });

  const menuBtn = document.getElementById("menuBtn");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let this same click immediately re-trigger the outside-click-closes handler below
    toggleDetailsPanel();
  });
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("detailsPanel");
    if (!panel || panel.classList.contains("hidden")) return;
    if (panel.contains(e.target)) return; // clicks inside the panel shouldn't close it
    panel.classList.add("hidden");
    menuBtn.setAttribute("aria-expanded", "false");
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
