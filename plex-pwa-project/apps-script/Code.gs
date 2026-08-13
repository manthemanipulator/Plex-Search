// =====================================================================
// Plex Search - Apps Script backend
//
// This project is now a JSON API for the PWA front end (hosted on
// GitHub Pages), instead of serving the UI itself. Everything about how
// your library data gets into the "Inventory" sheet is UNCHANGED - the
// CSV-from-Drive sync, the Sheet structure, the search-matching logic.
//
// New in this version:
//   - doGet returns your inventory + wishlist as JSON instead of HTML.
//   - doPost handles adding/removing wishlist items, protected by a
//     shared secret so a leaked URL can't be used to spam your wishlist.
//   - A "Set API Secret" menu item to generate/store that secret.
//
// One-time setup after pasting this in:
//   1. Run "Plex Tools" > "Set API Secret" from the Sheet menu, enter a
//      long random string. Paste that SAME string into the PWA's
//      app.js CONFIG.API_SECRET.
//   2. Deploy > Manage deployments > Edit (pencil icon) > New version,
//      to publish this code to your existing Web App URL. Copy that
//      URL into app.js CONFIG.API_URL.
// =====================================================================

// 1. Menu, so you don't have to open the script editor to sync
function onOpen() {
  SpreadsheetApp.getUi()
      .createMenu('Plex Tools')
      .addItem('Sync Library Now', 'updatePlexSheet')
      .addItem('Set API Secret', 'promptSetApiSecret')
      .addItem('Set Up Monthly Email Backup', 'createMonthlyEmailTrigger')
      .addToUi();
}

// 2. Nightly Sync Automation (unchanged)
function updatePlexSheet() {
  var fileName = "plex_library_export.csv";
  var files = DriveApp.getFilesByName(fileName);
  if (files.hasNext()) {
    var file = files.next();
    var csvText = file.getBlob().getDataAsString();
    var csvData = Utilities.parseCsv(csvText);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Inventory");
    sheet.clearContents();
    sheet.getRange(1, 1, csvData.length, csvData[0].length).setValues(csvData);
  } else {
    Logger.log("Error: Could not find " + fileName + " in Google Drive.");
  }
}

// 3. Smart Keyword Search (unchanged - kept as a server-side fallback;
// the PWA does this same matching client-side for offline search)
function searchMovie(query) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var invSheet = ss.getSheetByName("Inventory");
  var wishSheet = ss.getSheetByName("Wishlist");

  function isMatch(dbTitle, searchQuery) {
    if (!dbTitle) return false;
    var cleanTitle = dbTitle.toString().toLowerCase().replace(/[^\w\s]/g, '');
    var cleanQuery = searchQuery.toLowerCase().replace(/[^\w\s]/g, '');
    var searchWords = cleanQuery.split(/\s+/);
    return searchWords.every(function(word) {
      return cleanTitle.includes(word);
    });
  }

  var results = [];
  var invData = invSheet.getDataRange().getValues();
  for (var i = 1; i < invData.length; i++) {
    if (isMatch(invData[i][0], query)) {
      var yearStr = (invData[i][1] && invData[i][1] !== 'Unknown') ? " (" + invData[i][1] + ")" : "";
      var type = invData[i][3] || 'Movie';
      results.push({ status: "inventory", exactTitle: invData[i][0] + yearStr, type: type });
    }
  }

  var wishData = wishSheet.getDataRange().getValues();
  for (var j = 1; j < wishData.length; j++) {
    if (isMatch(wishData[j][0], query)) {
      results.push({ status: "wishlist", exactTitle: wishData[j][0] + " (Wishlist)" });
    }
  }

  if (results.length > 0) {
    return { found: true, matches: results, query: query };
  } else {
    return { found: false, query: query };
  }
}

// 4. Fetch the Wishlist (unchanged)
function getWishlist() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Wishlist");
  var data = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) {
      list.push(data[i][0]);
    }
  }
  return list;
}

// 5. Add a Movie to the Wishlist (unchanged)
function addToWishlist(movieTitle) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Wishlist");
  var date = new Date();
  sheet.appendRow([movieTitle, date]);
  return "Added to Wishlist!";
}

// 6. Remove a Movie from the Wishlist (unchanged)
function removeFromWishlist(movieTitle) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Wishlist");
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i > 0; i--) {
    if (data[i][0] === movieTitle) {
      sheet.deleteRow(i + 1);
      return "Removed!";
    }
  }
  return "Not found.";
}

// 7. Get Total Inventory Count (unchanged)
function getInventoryCount() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Inventory");
  var count = sheet.getLastRow() - 1;
  return count > 0 ? count : 0;
}

// 7b. Get a breakdown of Movies vs TV Shows (unchanged)
function getLibraryCounts() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Inventory");
  var counts = { movies: 0, tvShows: 0, total: 0 };
  if (sheet.getLastRow() <= 1) return counts;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var type = data[i][3] || 'Movie';
    if (type === 'TV Show') {
      counts.tvShows++;
    } else {
      counts.movies++;
    }
    counts.total++;
  }
  return counts;
}

// 8. Get Last Sync Time (unchanged)
function getLastSyncTime() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Inventory");
  if (sheet.getLastRow() > 1) {
    var syncTime = sheet.getRange(2, 3).getValue();
    return syncTime ? syncTime.toString() : "Unknown";
  }
  return "Never";
}

// 9. Full data dump - now the payload for BOTH the PWA's doGet API
// response and the "Save Offline Copy"/monthly-email HTML snapshot.
function getOfflineData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var invSheet = ss.getSheetByName("Inventory");
  var wishSheet = ss.getSheetByName("Wishlist");

  var inventory = [];
  if (invSheet.getLastRow() > 1) {
    var invData = invSheet.getDataRange().getValues();
    for (var i = 1; i < invData.length; i++) {
      if (!invData[i][0]) continue;
      inventory.push({
        title: invData[i][0].toString(),
        year: (invData[i][1] && invData[i][1] !== 'Unknown') ? invData[i][1].toString() : '',
        type: invData[i][3] || 'Movie'
      });
    }
  }

  var wishlist = [];
  if (wishSheet.getLastRow() > 1) {
    var wishData = wishSheet.getDataRange().getValues();
    for (var j = 1; j < wishData.length; j++) {
      if (wishData[j][0]) wishlist.push(wishData[j][0].toString());
    }
  }

  return { inventory: inventory, wishlist: wishlist, syncTime: getLastSyncTime() };
}

// =====================================================================
// 10. Web App entry points - JSON API for the PWA
// =====================================================================

// GET <web-app-url> -> { inventory: [...], wishlist: [...], syncTime: "..." }
function doGet(e) {
  var data = getOfflineData();
  return jsonResponse_(data);
}

// POST <web-app-url> with JSON body:
//   { action: "add",    title: "Some Movie", secret: "..." }
//   { action: "remove", title: "Some Movie", secret: "..." }
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ ok: false, error: "Invalid JSON body" });
  }

  var expectedSecret = PropertiesService.getScriptProperties().getProperty('API_SECRET');
  if (!expectedSecret) {
    return jsonResponse_({ ok: false, error: "No API secret configured. Run 'Set API Secret' from the Plex Tools menu first." });
  }
  if (body.secret !== expectedSecret) {
    return jsonResponse_({ ok: false, error: "Unauthorized" });
  }

  if (!body.title) {
    return jsonResponse_({ ok: false, error: "Missing title" });
  }

  if (body.action === 'add') {
    addToWishlist(body.title);
    return jsonResponse_({ ok: true });
  } else if (body.action === 'remove') {
    var result = removeFromWishlist(body.title);
    return jsonResponse_({ ok: true, result: result });
  }

  return jsonResponse_({ ok: false, error: "Unknown action: " + body.action });
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
}

// One-time setup: stores the shared secret the PWA must send with every
// write request. Run via the "Set API Secret" menu item - it'll prompt
// you for a value right in the Sheet UI.
function promptSetApiSecret() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt(
      'Set API Secret',
      'Enter a long random string (e.g. mash the keyboard, or use a password generator). ' +
      'Paste this EXACT same string into the PWA\'s app.js as CONFIG.API_SECRET.',
      ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() == ui.Button.OK) {
    var secret = response.getResponseText().trim();
    if (!secret) {
      ui.alert('Secret was empty - nothing saved.');
      return;
    }
    PropertiesService.getScriptProperties().setProperty('API_SECRET', secret);
    ui.alert('API secret saved. Now paste the same value into app.js.');
  }
}

// =====================================================================
// 11. Optional legacy fallback: monthly emailed offline snapshot.
// Not required once the PWA is set up (the PWA syncs continuously
// whenever you have signal), but harmless to leave running as a
// belt-and-suspenders backup.
// =====================================================================

function emailMonthlyOfflineCopy() {
  var data = getOfflineData();
  var html = buildOfflineHtml_(data.inventory, data.wishlist, data.syncTime);
  var blob = Utilities.newBlob(html, 'text/html', 'Plex_Offline_Search.html');
  var email = Session.getActiveUser().getEmail();

  MailApp.sendEmail({
    to: email,
    subject: 'Plex Offline Search - Monthly Backup (' + data.inventory.length + ' titles)',
    body: 'Attached is this month\'s offline snapshot of your Plex library: ' +
          data.inventory.length + ' titles, ' + data.wishlist.length + ' on the wishlist.\n\n' +
          'This is a legacy backup - if the Plex Search PWA is set up and syncing, ' +
          'you likely don\'t need this file, but it costs nothing to keep as a fallback.\n\n' +
          'Last library sync: ' + data.syncTime,
    attachments: [blob]
  });
}

function createMonthlyEmailTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'emailMonthlyOfflineCopy') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('emailMonthlyOfflineCopy')
      .timeBased()
      .onMonthDay(1)
      .atHour(6)
      .create();

  Logger.log('Monthly offline-copy email trigger created.');
  try {
    SpreadsheetApp.getUi().alert('Monthly email backup is set up. You\'ll get a fresh offline copy by email on the 1st of every month.');
  } catch (e) {
    // Running from the script editor rather than the sheet UI - no dialog available, that's fine.
  }
}

function buildOfflineHtml_(inventory, wishlist, syncTime) {
  var invJson = JSON.stringify(inventory).replace(/</g, '\\u003c');
  var wishJson = JSON.stringify(wishlist).replace(/</g, '\\u003c');

  return '<!DOCTYPE html>' +
'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Plex Offline Search</title><style>' +
'body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;padding:16px;background:#111;color:#eee;}' +
'h1{font-size:20px;} #meta{color:#888;font-size:13px;margin-bottom:16px;}' +
'input{width:100%;box-sizing:border-box;padding:12px;font-size:16px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;}' +
'.result{padding:10px 12px;margin-top:8px;border-radius:8px;background:#1e1e1e;}' +
'.tag{display:inline-block;font-size:11px;padding:2px 6px;border-radius:4px;margin-left:6px;vertical-align:middle;}' +
'.tv{background:#2a4d69;color:#bcd;} .movie{background:#4d2a2a;color:#dbc;} .wish{background:#4d472a;color:#ddc;}' +
'#empty{color:#888;margin-top:16px;}' +
'</style></head><body>' +
'<h1>Plex Offline Search</h1>' +
'<div id="meta">Snapshot from last sync: ' + syncTime + '</div>' +
'<input id="q" type="text" placeholder="Search movies &amp; TV shows..." autofocus>' +
'<div id="count" style="margin-top:8px;color:#888;font-size:13px;"></div>' +
'<div id="results"></div>' +
'<div id="empty" style="display:none;">No matches in your library or wishlist.</div>' +
'<script>' +
'var inventory = ' + invJson + ';' +
'var wishlist = ' + wishJson + ';' +
'function isMatch(title, query) {' +
'  if (!title) return false;' +
'  var cleanTitle = title.toLowerCase().replace(/[^\\w\\s]/g, "");' +
'  var cleanQuery = query.toLowerCase().replace(/[^\\w\\s]/g, "");' +
'  var words = cleanQuery.split(/\\s+/).filter(Boolean);' +
'  if (words.length === 0) return false;' +
'  return words.every(function(w) { return cleanTitle.indexOf(w) !== -1; });' +
'}' +
'var q = document.getElementById("q");' +
'var resultsEl = document.getElementById("results");' +
'var emptyEl = document.getElementById("empty");' +
'var countEl = document.getElementById("count");' +
'countEl.textContent = inventory.length + " titles in library, " + wishlist.length + " on wishlist";' +
'q.addEventListener("input", function() {' +
'  var query = q.value.trim();' +
'  resultsEl.innerHTML = "";' +
'  if (!query) { emptyEl.style.display = "none"; return; }' +
'  var matches = [];' +
'  inventory.forEach(function(item) {' +
'    if (isMatch(item.title, query)) matches.push({ text: item.title + (item.year ? " (" + item.year + ")" : ""), tagClass: item.type === "TV Show" ? "tv" : "movie", tagText: item.type === "TV Show" ? "TV" : "Movie" });' +
'  });' +
'  wishlist.forEach(function(title) {' +
'    if (isMatch(title, query)) matches.push({ text: title, tagClass: "wish", tagText: "Wishlist" });' +
'  });' +
'  emptyEl.style.display = matches.length ? "none" : "block";' +
'  matches.forEach(function(m) {' +
'    var div = document.createElement("div");' +
'    div.className = "result";' +
'    div.textContent = m.text;' +
'    var tag = document.createElement("span");' +
'    tag.className = "tag " + m.tagClass;' +
'    tag.textContent = m.tagText;' +
'    div.appendChild(tag);' +
'    resultsEl.appendChild(div);' +
'  });' +
'});' +
'</script></body></html>';
}
