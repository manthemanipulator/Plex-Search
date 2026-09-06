// =====================================================================
// Media Search - Apps Script backend
// (was "Plex Search" - extended to also cover the Audiobookshelf library)
//
// This project is a JSON API for the PWA front end (hosted on GitHub
// Pages). It owns pulling BOTH library data sources in:
//
//   - Movies/TV ("Inventory" sheet): the CSV your NAS drops in Google
//     Drive gets imported on a schedule, same as before - untouched.
//   - Audiobooks ("Audiobooks" sheet): pushed directly by a script on
//     the Mac Mini that talks to Audiobookshelf's own API and POSTs the
//     result straight to this Web App - no CSV/Drive hop needed, since
//     the Mac Mini can reach the internet directly.
//
// Both reading (library/wishlist) and writing (add/remove) require the
// shared secret set below - doGet on its own returns nothing, so simply
// knowing the Web App URL isn't enough to see or change any data. The
// secret is NOT stored in the PWA's source code (that ships publicly to
// anyone who visits the site) - the app prompts for it once and keeps it
// only in that device's local storage.
//
// One-time setup after pasting this in:
//   1. If you're upgrading from the old Plex-only sheet, add a new tab
//      named exactly "Audiobooks" (Inventory and Wishlist stay as-is).
//   2. Run "Media Tools" > "Set API Secret" if you haven't already -
//      same secret as before, nothing changes here on upgrade.
//   3. Run "Media Tools" > "Set Up Automatic Sync" if you haven't -
//      this is only for the Plex/Drive side; audiobooks sync whenever
//      the Mac Mini script runs, no trigger needed for that half.
//   4. Deploy > Manage deployments > Edit (pencil icon) > New version,
//      to publish this code to your existing Web App URL. The URL
//      itself doesn't change, so app.js's CONFIG.API_URL doesn't need
//      updating unless you're deploying fresh.
//   5. Wishlist entries now carry a "type" (Movie/TV Show/Audiobook/
//      Other) in column C of the Wishlist sheet, written automatically
//      whenever the PWA adds something - no manual sheet setup needed,
//      existing rows with a blank column C just read back as "other".
// =====================================================================

var AUDIOBOOK_SHEET_NAME = 'Audiobooks';
var AUDIOBOOK_HEADERS = ['Title', 'Author', 'Narrator', 'Series', 'SeriesNum',
                          'DurationSec', 'SizeBytes', 'AbsId', 'LastSynced'];

// 1. Menu, so you don't have to open the script editor to sync
function onOpen() {
  SpreadsheetApp.getUi()
      .createMenu('Media Tools')
      .addItem('Sync Plex Library Now', 'updatePlexSheet')
      .addItem('Set API Secret', 'promptSetApiSecret')
      .addItem('Set Up Automatic Plex Sync', 'createLibrarySyncTrigger')
      .addToUi();
}

// 2. Pull the latest CSV from Drive into the Inventory sheet. Runs
// automatically every few hours once "Set Up Automatic Plex Sync" has
// been run (see createLibrarySyncTrigger below) - you can still trigger
// it manually via the menu any time too. Unchanged from before.
function updatePlexSheet() {
  var fileName = "plex_library_export.csv";
  var files = DriveApp.getFilesByName(fileName);
  if (!files.hasNext()) {
    Logger.log("Error: Could not find " + fileName + " in Google Drive.");
    return;
  }

  var file = files.next();
  var csvText = file.getBlob().getDataAsString();
  var csvData = Utilities.parseCsv(csvText);

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Inventory");
  var newRowCount = csvData.length - 1; // minus header row
  var currentRowCount = sheet.getLastRow() - 1;

  // Safety check: refuse to overwrite a healthy library with something
  // that looks badly broken (e.g. the NAS scan failed partway through
  // and wrote a near-empty CSV, or the Drive sync delivered a partial
  // file). Only blocks an update that would shrink the library by more
  // than half - genuinely removing titles is still allowed through.
  if (currentRowCount > 10 && newRowCount < currentRowCount / 2) {
    Logger.log("Refused to update Inventory: new CSV has " + newRowCount +
        " rows vs " + currentRowCount + " currently in the sheet - looks like a bad sync, skipping.");
    return;
  }

  sheet.clearContents();
  sheet.getRange(1, 1, csvData.length, csvData[0].length).setValues(csvData);
  Logger.log("Inventory updated: " + newRowCount + " titles.");
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

// 4. Fetch the Wishlist. Column C is now the item's type (movie/tv/
// audiobook/other) - a blank column C (older rows added before this
// existed) reads back as "other" rather than breaking.
function getWishlist() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Wishlist");
  var data = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) {
      list.push({ title: data[i][0].toString(), type: data[i][2] || "other" });
    }
  }
  return list;
}

// 5. Add an item to the Wishlist, now with its type in column C.
function addToWishlist(itemTitle, itemType) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Wishlist");
  var date = new Date();
  sheet.appendRow([itemTitle, date, itemType || "other"]);
  return "Added to Wishlist!";
}

// 6. Remove an item from the Wishlist (unchanged)
function removeFromWishlist(itemTitle) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Wishlist");
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i > 0; i--) {
    if (data[i][0] === itemTitle) {
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

// 8. Get Last Sync Time for the Plex/Inventory side (unchanged)
function getLastSyncTime() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Inventory");
  if (sheet.getLastRow() > 1) {
    var syncTime = sheet.getRange(2, 3).getValue();
    return syncTime ? syncTime.toString() : "Unknown";
  }
  return "Never";
}

// 8b. Same idea, for the Audiobooks sheet. Column 9 is LastSynced there
// (see AUDIOBOOK_HEADERS above), vs column 3 for Inventory.
function getAudiobookLastSyncTime() {
  var sheet = getOrCreateAudiobookSheet_();
  if (sheet.getLastRow() > 1) {
    var syncTime = sheet.getRange(2, 9).getValue();
    return syncTime ? syncTime.toString() : "Unknown";
  }
  return "Never";
}

// Creates the Audiobooks sheet with headers if it doesn't exist yet, so
// upgrading from the old Plex-only spreadsheet doesn't require manually
// adding the tab first - the first sync (or even just opening the PWA)
// sets it up automatically.
function getOrCreateAudiobookSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(AUDIOBOOK_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(AUDIOBOOK_SHEET_NAME);
    sheet.getRange(1, 1, 1, AUDIOBOOK_HEADERS.length).setValues([AUDIOBOOK_HEADERS]);
  }
  return sheet;
}

// 9. Full data dump - the payload for the PWA's getData API response.
// Includes audiobooks alongside inventory, and wishlist entries now
// carry their type instead of being plain title strings.
function getOfflineData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var invSheet = ss.getSheetByName("Inventory");
  var wishSheet = ss.getSheetByName("Wishlist");
  var absSheet = getOrCreateAudiobookSheet_();

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

  var audiobooks = [];
  if (absSheet.getLastRow() > 1) {
    var absData = absSheet.getDataRange().getValues();
    for (var k = 1; k < absData.length; k++) {
      if (!absData[k][0]) continue;
      audiobooks.push({
        title: absData[k][0].toString(),
        author: absData[k][1] ? absData[k][1].toString() : '',
        narrator: absData[k][2] ? absData[k][2].toString() : '',
        series: absData[k][3] ? absData[k][3].toString() : '',
        seriesNum: absData[k][4] ? absData[k][4].toString() : '',
        durationSec: absData[k][5] ? Number(absData[k][5]) : 0,
        sizeBytes: absData[k][6] ? Number(absData[k][6]) : 0,
        absId: absData[k][7] ? absData[k][7].toString() : ''
      });
    }
  }

  var wishlist = [];
  if (wishSheet.getLastRow() > 1) {
    var wishData = wishSheet.getDataRange().getValues();
    for (var j = 1; j < wishData.length; j++) {
      if (wishData[j][0]) {
        wishlist.push({ title: wishData[j][0].toString(), type: wishData[j][2] || "other" });
      }
    }
  }

  return {
    inventory: inventory,
    audiobooks: audiobooks,
    wishlist: wishlist,
    syncTime: getLastSyncTime(),
    audiobookSyncTime: getAudiobookLastSyncTime()
  };
}

// 9b. Overwrite the Audiobooks sheet from a direct push (the Mac Mini's
// export script calls this via doPost's "syncAudiobooks" action). Same
// shrink-guard safety check as the Plex CSV import, so a buggy/partial
// run on the Mac Mini can't silently wipe out a good sync.
function syncAudiobooksFromPush_(audiobooks) {
  var sheet = getOrCreateAudiobookSheet_();
  var currentRowCount = Math.max(sheet.getLastRow() - 1, 0);
  var newRowCount = audiobooks.length;

  if (currentRowCount > 10 && newRowCount < currentRowCount / 2) {
    var msg = "Refused to update Audiobooks: push has " + newRowCount +
        " rows vs " + currentRowCount + " currently in the sheet - looks like a bad sync, skipping.";
    Logger.log(msg);
    return { ok: false, error: msg };
  }
  if (newRowCount === 0 && currentRowCount > 0) {
    var msg2 = "Refused to update Audiobooks: push had 0 rows - leaving existing data untouched.";
    Logger.log(msg2);
    return { ok: false, error: msg2 };
  }

  var now = new Date();
  var rows = audiobooks.map(function(b) {
    return [
      b.title || '', b.author || '', b.narrator || '', b.series || '',
      b.seriesNum || '', b.durationSec || 0, b.sizeBytes || 0, b.absId || '', now
    ];
  });

  sheet.clearContents();
  sheet.getRange(1, 1, 1, AUDIOBOOK_HEADERS.length).setValues([AUDIOBOOK_HEADERS]);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, AUDIOBOOK_HEADERS.length).setValues(rows);
  }
  Logger.log("Audiobooks updated: " + rows.length + " books.");
  return { ok: true, count: rows.length };
}

// =====================================================================
// 10. Web App entry points - JSON API for the PWA and the Mac Mini script
// =====================================================================

// GET <web-app-url> -> deliberately serves nothing. Reading your library
// and wishlist requires the same secret as writing now (see doPost's
// "getData" action below), so a bare GET - which anyone with the URL
// could send, no secret needed - can't leak anything.
function doGet(e) {
  return jsonResponse_({ ok: false, error: "Use POST with your API secret to read or write data." });
}

// POST <web-app-url> with JSON body:
//   { action: "getData",                                    secret: "..." }
//   { action: "add",    title: "Some Movie", type: "movie",  secret: "..." }
//   { action: "remove", title: "Some Movie",                 secret: "..." }
//   { action: "syncAudiobooks", audiobooks: [...],           secret: "..." }
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ ok: false, error: "Invalid JSON body" });
  }

  var expectedSecret = PropertiesService.getScriptProperties().getProperty('API_SECRET');
  if (!expectedSecret) {
    return jsonResponse_({ ok: false, error: "No API secret configured. Run 'Set API Secret' from the Media Tools menu first." });
  }
  if (body.secret !== expectedSecret) {
    return jsonResponse_({ ok: false, error: "Unauthorized" });
  }

  if (body.action === 'getData') {
    var data = getOfflineData();
    data.ok = true;
    return jsonResponse_(data);
  }

  if (body.action === 'syncAudiobooks') {
    if (!Array.isArray(body.audiobooks)) {
      return jsonResponse_({ ok: false, error: "Missing or invalid 'audiobooks' array" });
    }
    return jsonResponse_(syncAudiobooksFromPush_(body.audiobooks));
  }

  if (!body.title) {
    return jsonResponse_({ ok: false, error: "Missing title" });
  }

  if (body.action === 'add') {
    addToWishlist(body.title, body.type);
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

// One-time setup: stores the shared secret the PWA (and the Mac Mini
// export script) must send with every request. Run via the "Set API
// Secret" menu item - it'll prompt you for a value right in the Sheet UI.
// Unchanged from before - if you already set this for Plex Search,
// nothing to do here, the same secret covers audiobooks too.
function promptSetApiSecret() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt(
      'Set API Secret',
      'Enter a long random string (e.g. mash the keyboard, or use a password generator). ' +
      'Nothing to paste into app.js - the PWA will prompt for this the next time you tap ' +
      'Sync Now and remember it in the browser. Do set this same value as APPS_SCRIPT_SECRET ' +
      'in the Mac Mini\'s audiobookshelf_export.py environment.',
      ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() == ui.Button.OK) {
    var secret = response.getResponseText().trim();
    if (!secret) {
      ui.alert('Secret was empty - nothing saved.');
      return;
    }
    PropertiesService.getScriptProperties().setProperty('API_SECRET', secret);
    ui.alert('API secret saved. The PWA will prompt for it next time you tap Sync Now - just ' +
             'set the same value as APPS_SCRIPT_SECRET for the Mac Mini export script.');
  }
}

// One-time setup: creates a recurring trigger that automatically pulls
// the latest Plex CSV from Drive into the Inventory sheet. Only affects
// the Plex/Drive half - audiobooks sync whenever the Mac Mini script
// runs (driven by cron/launchd over there, not a Sheet-side trigger).
// Safe to re-run (clears any existing trigger for this function first).
function createLibrarySyncTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'updatePlexSheet') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('updatePlexSheet')
      .timeBased()
      .everyHours(6)
      .create();

  Logger.log('Automatic library sync trigger created (runs updatePlexSheet every 6 hours).');
  try {
    SpreadsheetApp.getUi().alert(
        'Automatic sync is set up. Your Inventory sheet will refresh from the latest CSV on ' +
        'Drive every 6 hours on its own - no more manual "Sync Plex Library Now" clicks needed.');
  } catch (e) {
    // Running from the script editor rather than the sheet UI - no dialog available, that's fine.
  }
}
