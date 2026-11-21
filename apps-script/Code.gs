/**
 * Backend for the book review site (Google Apps Script web app).
 *
 * Setup: open the Google Sheet > Extensions > Apps Script, replace the code
 * with this file, then Deploy > Manage deployments > edit your existing web app
 * deployment > New version. (Keep "Execute as: Me" and "Who has access: Anyone"
 * so the URL in app.js keeps working.)
 *
 * The script is driven by the sheet's header row, so your existing columns keep
 * working. Missing "id" and "updatedAt" columns are added automatically, and
 * old rows get an id the first time the list is requested.
 *
 *   GET  ?action=list           -> JSON array of reviews
 *   POST action=add|update      -> upsert by id (add is idempotent)
 *   POST action=delete          -> remove the row with that id
 */

var SHEET_NAME = ''; // leave blank to use the first sheet
var FIELDS = ['id', 'Title', 'CoverURL', 'Author', 'Rating', 'Format', 'Start Date', 'End Date', 'Summary', 'Thoughts', 'Quotes', 'updatedAt'];
var MAX_CELL = 20000; // cap text length per cell

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
}

// Make sure every field has a header column; returns {header: columnIndex(1-based)}
function ensureHeaders_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  if (headers.every(function (h) { return h === ''; })) headers = [];
  FIELDS.forEach(function (f) {
    if (headers.indexOf(f) === -1) {
      headers.push(f);
      sheet.getRange(1, headers.length).setValue(f);
    }
  });
  var map = {};
  headers.forEach(function (h, i) { if (h) map[h] = i + 1; });
  return map;
}

function cellText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}

// Stop text that starts with = + - @ from being evaluated as a formula by Sheets
function safe_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function rowToObj_(row, map) {
  var o = {};
  FIELDS.forEach(function (f) { o[f] = map[f] ? cellText_(row[map[f] - 1]) : ''; });
  return o;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'list';
  if (action !== 'list') return json_({ error: 'unknown action' });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet_();
    var map = ensureHeaders_(sheet);
    var last = sheet.getLastRow();
    if (last < 2) return json_([]);
    var values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
    var out = [];
    values.forEach(function (row, i) {
      if (row.every(function (c) { return c === ''; })) return;
      // Backfill ids on legacy rows so the site can refer to them
      if (!row[map.id - 1]) {
        row[map.id - 1] = Utilities.getUuid();
        sheet.getRange(i + 2, map.id).setValue(row[map.id - 1]);
      }
      out.push(rowToObj_(row, map));
    });
    return json_(out);
  } finally {
    lock.releaseLock();
  }
}

function doPost(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || 'add'; // old clients send no action: treat as add
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet_();
    var map = ensureHeaders_(sheet);
    var last = sheet.getLastRow();
    var data = last >= 2 ? sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues() : [];

    // Find the row (1-based sheet row) for this review
    var rowNum = 0;
    if (p.id) {
      for (var i = 0; i < data.length; i++) {
        if (String(data[i][map.id - 1]) === p.id) { rowNum = i + 2; break; }
      }
    }

    if (action === 'delete') {
      if (rowNum) sheet.deleteRow(rowNum);
      return json_({ ok: true });
    }

    // Legacy row (no id yet) that matches this review: adopt it instead of duplicating
    if (!rowNum && action === 'update') {
      for (var j = 0; j < data.length; j++) {
        if (!data[j][map.id - 1] &&
            cellText_(data[j][map.Title - 1]).toLowerCase() === String(p.Title || '').toLowerCase() &&
            cellText_(data[j][map.Author - 1]).toLowerCase() === String(p.Author || '').toLowerCase()) {
          rowNum = j + 2; break;
        }
      }
    }

    var width = sheet.getLastColumn();
    var row = rowNum ? sheet.getRange(rowNum, 1, 1, width).getValues()[0] : new Array(width).fill('');
    FIELDS.forEach(function (f) {
      if (p[f] !== undefined && map[f]) row[map[f] - 1] = safe_(String(p[f]).slice(0, MAX_CELL));
    });
    if (!row[map.id - 1]) row[map.id - 1] = p.id || Utilities.getUuid();
    if (!row[map.updatedAt - 1]) row[map.updatedAt - 1] = new Date().toISOString();

    if (rowNum) sheet.getRange(rowNum, 1, 1, width).setValues([row]);
    else sheet.appendRow(row);
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}
