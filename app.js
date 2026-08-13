// =====================================================================
// Plex Search PWA - app logic
//
// Fill in CONFIG below after you've deployed the Apps Script backend.
// =====================================================================

const CONFIG = {
  // Your Apps Script Web App URL, e.g.
  // "https://script.google.com/macros/s/AKfycb.../exec"
  API_URL: "https://script.google.com/macros/s/AKfycby66-WJTUbG_Q2rWJLiMgUanH1uQKo7oB3G78HZw1PHbNkoc_-ankCkr7FldRkfWX7n/exec",

  // Must exactly match the secret you set via the "Set API Secret" menu
  // item in the Google Sheet.
  API_SECRET: "k9F7#mP2$xL5!vR8*qN4&zT1"
};

const STORAGE_KEYS = {
  inventory: "plex.inventory",
  wishlist: "plex.wishlist",
  pendingQueue: "plex.pendingQueue",
  lastSync: "plex.lastSync"
};

let state = {
  inventory: [],
  wishlist: [],
  pendingQueue: [],
  lastSync: null
};

let isSyncing = false;
let mode = "search"; // "search" (type to find something) or "wishlist" (browse everything on it)

// ---------------------------------------------------------------------
// Local storage helpers
// ---------------------------------------------------------------------

function loadLocalData() {
  try {
    state.inventory = JSON.parse(localStorage.getItem(STORAGE_KEYS.inventory) || "[]");
    state.wishlist = JSON.parse(localStorage.getItem(STORAGE_KEYS.wishlist) || "[]");
    state.pendingQueue = JSON.parse(localStorage.getItem(STORAGE_KEYS.pendingQueue) || "[]");
    state.lastSync = localStorage.getItem(STORAGE_KEYS.lastSync) || null;
  } catch (err) {
    console.error("Failed to load cached data, starting fresh.", err);
    state = { inventory: [], wishlist: [], pendingQueue: [], lastSync: null };
  }
}

function saveLocalData() {
  localStorage.setItem(STORAGE_KEYS.inventory, JSON.stringify(state.inventory));
  localStorage.setItem(STORAGE_KEYS.wishlist, JSON.stringify(state.wishlist));
  localStorage.setItem(STORAGE_KEYS.pendingQueue, JSON.stringify(state.pendingQueue));
  if (state.lastSync) localStorage.setItem(STORAGE_KEYS.lastSync, state.lastSync);
}

// ---------------------------------------------------------------------
// Search matching - identical logic to the original Apps Script version,
// runs entirely client-side so it works with zero connectivity.
// ---------------------------------------------------------------------

function isMatch(title, query) {
  if (!title) return false;
  const cleanTitle = title.toString().toLowerCase().replace(/[^\w\s]/g, "");
  const cleanQuery = query.toLowerCase().replace(/[^\w\s]/g, "");
  const words = cleanQuery.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.every((w) => cleanTitle.includes(w));
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

async function fetchLatestData() {
  const res = await fetch(CONFIG.API_URL, { method: "GET" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
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

  isSyncing = true;
  setStatus("Syncing...");

  try {
    // Flush the pending queue in order. Stop on the first failure so we
    // don't silently drop or reorder anything - it'll retry next sync.
    while (state.pendingQueue.length > 0) {
      const item = state.pendingQueue[0];
      const result = await postToApi({
        action: item.action,
        title: item.title,
        secret: CONFIG.API_SECRET
      });
      if (!result.ok) {
        console.error("Sync item rejected by server:", item, result.error);
        setStatus("Sync error: " + (result.error || "unknown"));
        isSyncing = false;
        return;
      }
      state.pendingQueue.shift();
      saveLocalData();
    }

    // Pull the freshest inventory/wishlist now that our writes landed.
    const fresh = await fetchLatestData();
    state.inventory = fresh.inventory || [];
    state.wishlist = fresh.wishlist || [];
    state.lastSync = new Date().toLocaleString();
    saveLocalData();
    render();
    setStatus("Synced");
  } catch (err) {
    console.error("Sync failed:", err);
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
    lastSyncEl.textContent = state.lastSync ? "Last synced: " + state.lastSync : "Never synced yet";
  }
  const onlineEl = document.getElementById("onlineDot");
  if (onlineEl) {
    onlineEl.className = navigator.onLine ? "dot online" : "dot offline";
  }
}

function renderCounts() {
  const countEl = document.getElementById("count");
  if (countEl) {
    countEl.textContent = state.inventory.length + " titles in library, " + state.wishlist.length + " on wishlist";
  }
  const toggleBtn = document.getElementById("modeToggle");
  if (toggleBtn) {
    toggleBtn.textContent = mode === "wishlist" ? "Back to Search" : "View Wishlist (" + state.wishlist.length + ")";
  }
}

function toggleMode() {
  mode = mode === "search" ? "wishlist" : "search";
  const input = document.getElementById("q");
  input.placeholder = mode === "wishlist" ? "Filter wishlist (optional)..." : "Search movies & TV shows...";
  render();
}

function makeResultRow(text, tagClass, tagText, wishlistTitle) {
  const div = document.createElement("div");
  div.className = "result";

  const textEl = document.createElement("span");
  textEl.textContent = text;
  div.appendChild(textEl);

  const tag = document.createElement("span");
  tag.className = "tag " + tagClass;
  tag.textContent = tagText;
  div.appendChild(tag);

  if (wishlistTitle) {
    const removeBtn = document.createElement("button");
    removeBtn.className = "removeBtn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeFromWishlistLocal(wishlistTitle));
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
// view, independent of the search box.
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
    const row = makeResultRow(title + (pending ? " (pending sync)" : ""), "wish", "Wishlist", title);
    resultsEl.appendChild(row);
  });
}

// Type-to-search against both your library and wishlist - the original
// behavior: a checkmark-style tag if you already have it, or a button to
// add it to the wishlist if nothing matched at all.
function renderSearchMode(query, resultsEl, emptyEl) {
  if (!query) {
    emptyEl.style.display = "none";
    return;
  }

  const matches = [];

  state.inventory.forEach((item) => {
    if (isMatch(item.title, query)) {
      matches.push({
        text: item.title + (item.year ? " (" + item.year + ")" : ""),
        tagClass: item.type === "TV Show" ? "tv" : "movie",
        tagText: item.type === "TV Show" ? "TV" : "Movie",
        wishlistTitle: null
      });
    }
  });

  state.wishlist.forEach((title) => {
    if (isMatch(title, query)) {
      const pending = isPending(title);
      matches.push({
        text: title + (pending ? " (pending sync)" : ""),
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
    resultsEl.appendChild(makeResultRow(m.text, m.tagClass, m.tagText, m.wishlistTitle));
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
  }

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
