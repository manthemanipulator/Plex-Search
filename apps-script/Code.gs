// =====================================================================
// Plex Search - Apps Script backend
//
// This project is a JSON API for the PWA front end (hosted on GitHub
// Pages). It also owns pulling your library data in: the CSV your NAS
// drops in Google Drive gets automatically imported into the
// "Inventory" sheet on a schedule, no manual steps required once set up.
//
// Both reading (library/wishlist) and writing (add/remove) require the
// shared secret set below - doGet on its own returns nothing, so simply
// knowing the Web App URL isn't enough to see or change any data. The
// secret is NOT stored in the PWA's source code (that ships publicly to
// anyone who visits the site) - the app prompts for it once and keeps it
// only in that device's local storage.
//
// One-time setup after pasting this in:
//   1. Run "Plex Tools" > "Set API Secret" from the Sheet menu, enter a
//      long random string. You'll be prompted for this SAME string the
//      first time you open the PWA.
//   2. Run "Plex Tools" > "Set Up Automatic Sync" once, so the Inventory
//      sheet refreshes from Drive on its own instead of needing a
//      manual "Sync Library Now" click.
//   3. Deploy > Manage deployments > Edit (pencil icon) > New version,
//      to publish this code to your existing Web App URL. Copy that
//      URL into app.js CONFIG.API_URL.
// =====================================================================

// 1. Menu, so you don't have to open the script editor to sync
function onOpen() {
  SpreadsheetApp.getUi()
      .createMenu('Plex Tools')
      .addItem('Sync Library Now', 'updatePlexSheet')
      .addItem('Set API Secret', 'promptSetApiSecret')
      .addItem('Set Up Automatic Sync', 'createLibrarySyncTrigger')
      .addToUi();
}

// 2. Pull the latest CSV from Drive into the Inventory sheet. Runs
// automatically every few hours once "Set Up Automatic Sync" has been
// run (see createLibrarySyncTrigger below) - you can still trigger it
// manually via the menu any time too.
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

// 9. Full data dump - the payload for the PWA's doGet API response.
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

// GET <web-app-url> -> deliberately serves nothing. Reading your library
// and wishlist requires the same secret as writing now (see doPost's
// "getData" action below), so a bare GET - which anyone with the URL
// could send, no secret needed - can't leak anything.
function doGet(e) {
  return jsonResponse_({ ok: false, error: "Use POST with your API secret to read or write data." });
}

// POST <web-app-url> with JSON body:
//   { action: "getData",                       secret: "..." }
//   { action: "add",    title: "Some Movie",    secret: "..." }
//   { action: "remove", title: "Some Movie",    secret: "..." }
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

  if (body.action === 'getData') {
    var data = getOfflineData();
    data.ok = true;
    return jsonResponse_(data);
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

// One-time setup: creates a recurring trigger that automatically pulls
// the latest CSV from Drive into the Inventory sheet, so this doesn't
// depend on remembering to click "Sync Library Now" yourself. Run once
// via the Plex Tools menu; safe to re-run (clears any existing trigger
// for this function first, so it won't double up).
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
        'Drive every 6 hours on its own - no more manual "Sync Library Now" clicks needed.');
  } catch (e) {
    // Running from the script editor rather than the sheet UI - no dialog available, that's fine.
  }
}
