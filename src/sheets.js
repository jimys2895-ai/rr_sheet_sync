require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const https = require('https');

const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
const KEY_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'];
const DEFAULT_COLUMN_WIDTH = 130; // pixels; override per column via column.width

// Per-column number formats (set via column.format in writeToSheet).
const COLUMN_NUMBER_FORMATS = {
  currency: { type: 'NUMBER', pattern: '$#,##0.00' },
  percent: { type: 'NUMBER', pattern: '0.0"%"' },
  decimal: { type: 'NUMBER', pattern: '#,##0.0' },
  integer: { type: 'NUMBER', pattern: '0' }, // plain number, no $, decimals, or thousands separator
  wholeComma: { type: 'NUMBER', pattern: '#,##0' }, // whole number with thousands separator, no decimals
  ratio: { type: 'PERCENT', pattern: '0.00%' }, // a stored fraction (0.59) shown as a percent (59.00%)
  date: { type: 'DATE', pattern: 'yyyy-mm-dd' }, // a real date value, sortable and comparable in SUMIFS
};

// Load the Google service-account credentials. Two supported sources, in priority order:
//   1. GOOGLE_SERVICE_ACCOUNT_JSON      — the full JSON key inline (ideal for serverless env vars).
//   2. GOOGLE_SERVICE_ACCOUNT_KEY_FILE  — a path to the JSON key file (local dev, or a Render Secret File).
function normalizeCredentials(credentials) {
  if (!credentials?.private_key) return credentials;
  if (!credentials.private_key.includes('\\n')) return credentials;
  return { ...credentials, private_key: credentials.private_key.replace(/\\n/g, '\n') };
}

function loadCredentials() {
  if (KEY_JSON) {
    try {
      return normalizeCredentials(JSON.parse(KEY_JSON));
    } catch (err) {
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON: ${err.message}`);
    }
  }
  if (KEY_FILE) {
    try {
      if (!fs.existsSync(KEY_FILE)) {
        throw new Error(`file not found at "${KEY_FILE}" — on Render, attach a Secret File named google-service-account.json to this service`);
      }
      return normalizeCredentials(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')));
    } catch (err) {
      throw new Error(`Could not read service-account key file "${KEY_FILE}": ${err.message}`);
    }
  }
  throw new Error(
    'No Google credentials found. Set GOOGLE_SERVICE_ACCOUNT_JSON (inline JSON) '
    + 'or GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path to the JSON key file).',
  );
}

function credentialSourceLabel() {
  if (KEY_JSON) return 'GOOGLE_SERVICE_ACCOUNT_JSON';
  if (KEY_FILE) return `GOOGLE_SERVICE_ACCOUNT_KEY_FILE (${KEY_FILE})`;
  return 'none';
}

const GAXIOS_RETRY_CONFIG = {
  retry: 5,
  noResponseRetries: 5,
  retryDelayMultiplier: 2,
  maxRetryDelay: 15000,
  totalTimeout: 120000,
  httpMethodsToRetry: ['GET', 'POST', 'PUT', 'HEAD', 'OPTIONS', 'DELETE'],
  statusCodesToRetry: [[100, 199], [408, 408], [429, 429], [500, 599]],
};

// Render/cron environments sometimes drop reused HTTPS sockets to Google OAuth.
const HTTPS_AGENT = new https.Agent({ keepAlive: false, maxSockets: 10 });

let _auth = null;
let _sheetsClient = null;
let _driveClient = null;
let _authReady = null;

function resetGoogleClients() {
  _auth = null;
  _sheetsClient = null;
  _driveClient = null;
  _authReady = null;
}

function buildGoogleAuth() {
  const credentials = loadCredentials();
  return new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
    clientOptions: {
      transporterOptions: {
        agent: HTTPS_AGENT,
        timeout: 60000,
      },
      retry: true,
      retryConfig: GAXIOS_RETRY_CONFIG,
    },
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const RETRYABLE_GOOGLE_ERROR = /quota|429|rate limit|premature close|invalid response body|econnreset|etimedout|econnrefused|socket hang up|fetch failed|network|503|502|504|500|oauth2/i;

function isRetryableGoogleError(err) {
  const parts = [err?.message, err?.code, err?.cause?.message, err?.response?.status];
  return RETRYABLE_GOOGLE_ERROR.test(parts.filter(Boolean).join(' '));
}

function isAuthRelatedGoogleError(err) {
  return /token|oauth|premature close|invalid response body/i.test(String(err?.message ?? ''));
}

// Sheets enforces its read/write limits over a rolling ONE-MINUTE window, per service account. Backing
// off 8 or 16 seconds just lands inside the same exhausted window and burns a retry for nothing — the
// only wait that reliably helps is one that outlives the window. Everything else keeps the old escalating
// delay, which suits genuinely transient 5xx.
const QUOTA_WINDOW_MS = 65000;
const isQuotaError = (err) => /quota exceeded|rate limit|resource[_ ]exhausted|too many requests/i
  .test(String(err?.message ?? '') + ' ' + String(err?.cause?.message ?? ''));

async function withGoogleRetry(operation, label = 'Google API', options = {}) {
  // Quota errors get a longer runway than ordinary transients. Each one costs a full 65s window, so five
  // attempts is only about four minutes of patience — and a burst caused by the other crons can outlast
  // that. Ordinary 5xx still gets five, since retrying those for ten minutes helps nobody.
  const maxAttempts = options.maxAttempts ?? 5;
  const quotaMaxAttempts = options.quotaMaxAttempts ?? 8;
  const hardLimit = Math.max(maxAttempts, quotaMaxAttempts);
  for (let attempt = 1; attempt <= hardLimit; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const limit = isQuotaError(err) ? quotaMaxAttempts : maxAttempts;
      if (!isRetryableGoogleError(err) || attempt >= limit) throw err;
      if (isAuthRelatedGoogleError(err)) resetGoogleClients();
      const wait = isQuotaError(err)
        ? QUOTA_WINDOW_MS
        : (options.baseDelayMs ?? 3000) * attempt;
      console.warn(
        `[Sheets] Transient error during ${label} — retry ${attempt}/${limit} in ${wait / 1000}s: ${err.message}`,
      );
      await sleep(wait);
    }
  }
}

// Retry profile for the ops queues. Sheets counts read/write requests per MINUTE per user, and every
// cron here shares one service account — so when several jobs overlap, a whole step can die on
// "Quota exceeded". That is worst for the ops write-back, which is the LAST thing a Force Deliver run
// does: by the time it fires, orders have already been booked and marked delivered in RoseRocket, so
// losing it leaves blank Status/Processed at cells with no record of what the run did. The quota bucket
// refills on a minute boundary, so these waits (10s, 20s, 30s, 40s) are sized to outlast one.
const QUOTA_RETRY = { baseDelayMs: 10000 };

// Prefetch OAuth token once per process (cron job). Fails fast with retries before heavy sync work.
async function ensureGoogleAuth() {
  if (!_authReady) {
    _authReady = withGoogleRetry(async () => {
      console.log(`[Sheets] Authenticating with Google (${credentialSourceLabel()})...`);
      _auth = buildGoogleAuth();
      const client = await _auth.getClient();
      const token = await client.getAccessToken();
      if (!token?.token) throw new Error('Google OAuth returned an empty access token');
      console.log('[Sheets] Google auth ready.');
      return _auth;
    }, 'Google OAuth token', { baseDelayMs: 5000 }).catch(err => {
      _authReady = null;
      _auth = null;
      throw err;
    });
  }
  return _authReady;
}

function getAuth() {
  if (!_auth) _auth = buildGoogleAuth();
  return _auth;
}

async function getSheetsClient() {
  await ensureGoogleAuth();
  if (!_sheetsClient) {
    _sheetsClient = google.sheets({ version: 'v4', auth: getAuth() });
  }
  return _sheetsClient;
}

async function getDriveClient() {
  await ensureGoogleAuth();
  if (!_driveClient) {
    _driveClient = google.drive({ version: 'v3', auth: getAuth() });
  }
  return _driveClient;
}

// Creates a new spreadsheet and returns its ID.
async function createSpreadsheet(title = 'RoseRocket Sync') {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.create({
    requestBody: { properties: { title } },
  });
  const id = response.data.spreadsheetId;
  console.log(`[Sheets] Created new spreadsheet: https://docs.google.com/spreadsheets/d/${id}`);
  return id;
}

// Flattens a nested object into dot-notation keys, arrays become JSON strings.
function flattenObject(obj, prefix = '') {
  if (obj === null || typeof obj !== 'object') return { [prefix]: obj };
  return Object.entries(obj).reduce((acc, [key, val]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(val)) {
      acc[fullKey] = JSON.stringify(val);
    } else if (val && typeof val === 'object') {
      Object.assign(acc, flattenObject(val, fullKey));
    } else {
      acc[fullKey] = val ?? '';
    }
    return acc;
  }, {});
}

// Resolves a configured column's value from a flattened record. Tries (in order):
//   1. exact key            (e.g. "to_city")
//   2. normalized key       (case-insensitive, treating "." and "_" as the same)
//   3. normalized prefix    (e.g. "total_combined" → "total_combined_charge")
// This keeps the sheet resilient to minor field-name drift (nested vs flat, etc.).
function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[._]/g, '');
}

function colLetter(idx) {
  let n = idx;
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function resolveFieldValue(flatRecord, field) {
  if (field in flatRecord) return flatRecord[field] ?? '';
  const target = normalizeKey(field);
  let prefixMatch;
  for (const key of Object.keys(flatRecord)) {
    const norm = normalizeKey(key);
    if (norm === target) return flatRecord[key] ?? '';
    if (prefixMatch === undefined && norm.startsWith(target)) prefixMatch = key;
  }
  return prefixMatch !== undefined ? (flatRecord[prefixMatch] ?? '') : '';
}

// Writes records to a named sheet tab. Clears existing data first (full refresh).
//
// Column selection:
//   - options.columns : an ordered array of column definitions. Output is restricted to
//                       exactly these columns, in this order. Two kinds of column:
//                         { header, field }                  → value from the (flattened) record
//                         { header, getLabel, getUrl }       → clickable rich-text link
//                         { header, format }                 → currency | percent on data + totals rows
//                         { header, getTotalFormula }        → custom formula on totals row
//                         { header, getTotalValue }          → static value on totals row
//                         { header, hiddenByDefault }        → hide column (user can unhide in Sheets)
//   - if options.columns is omitted, every flattened field becomes a column (legacy behavior),
//     with options.linkColumns prepended.
function findSheetByTitle(sheetsList, title) {
  const exact = sheetsList.find(s => s.properties.title === title);
  if (exact) return exact;
  const lower = title.toLowerCase();
  return sheetsList.find(s => s.properties.title.toLowerCase() === lower);
}

// Quotes a sheet title for A1 notation (required for names with spaces/punctuation, e.g. dynamic
// manifest nicknames). Internal single quotes are doubled per the Sheets API rule: 'Bob''s tab'!A1.
function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function shouldHideColumnByDefault(column, sheetMeta, colIndex) {
  if (!column.hiddenByDefault) return false;
  // User unhid the column in Sheets — keep it visible on future syncs.
  if (sheetMeta?.columnMetadata?.[colIndex]?.hiddenByUser === false) return false;
  return true;
}

async function writeToSheet(spreadsheetId, tabName, records, options = {}) {
  const { linkColumns = [], columns = null, headerRow = 1 } = options;
  const headerRowIndex = headerRow - 1;
  const sheets = await getSheetsClient();

  // Ensure the tab exists; create it if not. Match case-insensitively so "MO/KS" and "Mo/KS"
  // resolve to the same tab, then rename to the canonical title if needed.
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = findSheetByTitle(meta.data.sheets, tabName);
  let tabId = existing?.properties.sheetId;
  // Column widths are seeded only when a tab is first created; on an existing tab they belong to the
  // user, so the sync leaves them alone and a manual resize survives every refresh.
  const isNewTab = tabId === undefined;

  if (tabId !== undefined && existing.properties.title !== tabName) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: tabId, title: tabName },
            fields: 'title',
          },
        }],
      },
    });
    console.log(`[Sheets] Renamed tab "${existing.properties.title}" → "${tabName}".`);
  }

  if (tabId === undefined) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    tabId = created.data.replies[0].addSheet.properties.sheetId;
    console.log(`[Sheets] Created tab: ${tabName}`);
  }

  // With an explicit column set we still write the header row (so empty regional tabs stay readable).
  // Without one, an empty record set leaves the tab blank as before.
  if (records.length === 0 && !columns) {
    console.log(`[Sheets] No records for "${tabName}" — tab created but left empty.`);
    return;
  }

  const flatRecords = records.map(r => flattenObject(r));

  // Resolve the ordered column set + the indices of any link columns.
  let resolvedColumns;
  if (columns) {
    resolvedColumns = columns;
  } else {
    const dataHeaders = [...new Set(flatRecords.flatMap(r => Object.keys(r)))];
    resolvedColumns = [...linkColumns, ...dataHeaders.map(h => ({ header: h, field: h }))];
  }

  const headers = resolvedColumns.map(c => c.header);
  // getLabel receives the data-row index too, so a column can emit a per-row formula (e.g. =G4*$N$2).
  const rows = records.map((r, i) =>
    resolvedColumns.map(c => (c.getLabel ? (c.getLabel(r, i) ?? '') : resolveFieldValue(flatRecords[i], c.field)))
  );

  // Optional totals row: sum columns get =SUM(); getTotalFormula columns get a custom formula.
  const hasTotalsRow = records.length > 0
    && resolvedColumns.some(c => c.sum || typeof c.getTotalFormula === 'function' || typeof c.getTotalValue === 'function');
  const sheetRows = [headers, ...rows];
  if (hasTotalsRow) {
    const firstDataRow = headerRow + 1;
    const lastDataRow = headerRow + records.length;
    const totalsRow = headerRow + records.length + 1;
    const totalsContext = { totalsRow, firstDataRow, lastDataRow, colLetter, resolvedColumns, records };
    sheetRows.push(resolvedColumns.map((c, idx) => {
      if (typeof c.getTotalValue === 'function') {
        const value = c.getTotalValue(totalsContext);
        return value === '' ? '' : value;
      }
      if (typeof c.getTotalFormula === 'function') {
        return c.getTotalFormula(totalsContext);
      }
      if (c.sum) {
        return `=SUM(${colLetter(idx)}${firstDataRow}:${colLetter(idx)}${lastDataRow})`;
      }
      return '';
    }));
  }

  // Clear the tab then write fresh data (USER_ENTERED so SUM formulas are parsed).
  const tabRef = quoteSheetTitle(tabName);
  const clearRange = headerRow > 1 ? `${tabRef}!A${headerRow}:ZZ` : `${tabRef}!A:ZZ`;
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: clearRange });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabRef}!A${headerRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: sheetRows },
  });

  // Second pass: turn link columns into clickable links (rich-text link, so the visible text
  // stays clean and hovering reveals the RoseRocket URL). Each link column is updated in place
  // at its own column index, leaving the RAW-parsed numeric cells in the other columns untouched.
  const linkColumnEntries = records.length
    ? resolvedColumns.map((c, idx) => ({ c, idx })).filter(({ c }) => typeof c.getUrl === 'function')
    : [];
  const linkRequests = [];

  for (const { c, idx } of linkColumnEntries) {
    const linkRows = records.map(r => {
      const label = String(c.getLabel ? (c.getLabel(r) ?? '') : '');
      const url = c.getUrl(r) || '';
      const cell = { userEnteredValue: { stringValue: label } };
      if (label && url) cell.textFormatRuns = [{ startIndex: 0, format: { link: { uri: url } } }];
      return { values: [cell] };
    });
    linkRequests.push({
      updateCells: {
        rows: linkRows,
        fields: 'userEnteredValue,textFormatRuns',
        start: { sheetId: tabId, rowIndex: headerRow, columnIndex: idx },
      },
    });
  }
  if (linkRequests.length) {
    console.log(`[Sheets] Linked ${linkColumnEntries.length} column(s) on "${tabName}".`);
  }

  // Seed column widths ONLY on a brand-new tab (per-column override via column.width, else default).
  // On an existing tab the widths are the user's — a manual resize must survive the next sync — so we
  // don't touch pixelSize at all. Hidden-by-default columns are still managed either way (that check
  // already respects a user un-hiding a column). Cells are left-aligned so numbers aren't flush-right.
  const sheetMeta = meta.data.sheets.find(s => s.properties.sheetId === tabId);
  const formatRequests = [];
  resolvedColumns.forEach((c, idx) => {
    const properties = {};
    const fields = [];
    if (isNewTab) {
      properties.pixelSize = c.width || DEFAULT_COLUMN_WIDTH;
      fields.push('pixelSize');
    }
    if (shouldHideColumnByDefault(c, sheetMeta, idx)) {
      properties.hiddenByUser = true;
      fields.push('hiddenByUser');
    }
    if (fields.length === 0) return;
    formatRequests.push({
      updateDimensionProperties: {
        range: { sheetId: tabId, dimension: 'COLUMNS', startIndex: idx, endIndex: idx + 1 },
        properties,
        fields: fields.join(','),
      },
    });
  });
  const dataEndRow = records.length > 0
    ? headerRow + records.length + (hasTotalsRow ? 1 : 0)
    : headerRow;
  formatRequests.push({
    repeatCell: {
      range: {
        sheetId: tabId,
        startRowIndex: headerRowIndex,
        endRowIndex: dataEndRow,
        startColumnIndex: 0,
        endColumnIndex: resolvedColumns.length,
      },
      cell: { userEnteredFormat: { horizontalAlignment: 'LEFT' } },
      fields: 'userEnteredFormat.horizontalAlignment',
    },
  });
  // Reset bold across the whole table (header row down to the end of the sheet) BEFORE re-bolding
  // the header and totals rows below. values.clear() wipes cell values but leaves formatting intact,
  // so without this the bold from a previous run's totals row would linger on whatever row now sits
  // at that position — leaving stray bold data rows once the record count changes between runs.
  // Ordering matters: this runs before the header/totals bold requests, which override it.
  formatRequests.push({
    repeatCell: {
      range: {
        sheetId: tabId,
        startRowIndex: headerRowIndex,
        startColumnIndex: 0,
        endColumnIndex: resolvedColumns.length,
      },
      cell: { userEnteredFormat: { textFormat: { bold: false } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  });
  formatRequests.push({
    repeatCell: {
      range: {
        sheetId: tabId,
        startRowIndex: headerRowIndex,
        endRowIndex: headerRowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: resolvedColumns.length,
      },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  });
  if (records.length > 0 && hasTotalsRow) {
    formatRequests.push({
      repeatCell: {
        range: {
          sheetId: tabId,
          startRowIndex: headerRow + records.length,
          endRowIndex: headerRow + records.length + 1,
          startColumnIndex: 0,
          endColumnIndex: resolvedColumns.length,
        },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    });
  }
  // Wrap text on columns marked wrap:true (e.g. Customs with multi-line tag names).
  resolvedColumns.forEach((c, idx) => {
    if (!c.wrap || records.length === 0) return;
    formatRequests.push({
      repeatCell: {
        range: {
          sheetId: tabId,
          startRowIndex: headerRow,
          endRowIndex: headerRow + records.length,
          startColumnIndex: idx,
          endColumnIndex: idx + 1,
        },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat.wrapStrategy',
      },
    });
  });
  // Currency / percent formatting (data rows + totals row).
  resolvedColumns.forEach((c, idx) => {
    if (!c.format || records.length === 0) return;
    const numberFormat = COLUMN_NUMBER_FORMATS[c.format];
    if (!numberFormat) return;
    formatRequests.push({
      repeatCell: {
        range: {
          sheetId: tabId,
          startRowIndex: headerRow,
          endRowIndex: dataEndRow,
          startColumnIndex: idx,
          endColumnIndex: idx + 1,
        },
        cell: { userEnteredFormat: { numberFormat } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  });
  // Columns marked clearBackground carry no fill: strip any background from the header row down each
  // run. A full refresh clears values but not formatting, so a fill applied by an earlier run would
  // otherwise linger on whatever row now sits in its place. Clearing (rather than forcing white) also
  // lets any row banding show through.
  const backgroundRequests = [];
  if (records.length > 0) {
    resolvedColumns.forEach((c, idx) => {
      if (!c.clearBackground) return;
      backgroundRequests.push({
        repeatCell: {
          range: { sheetId: tabId, startRowIndex: headerRow, startColumnIndex: idx, endColumnIndex: idx + 1 },
          cell: {},
          fields: 'userEnteredFormat.backgroundColor',
        },
      });
    });
  }
  const stylingRequests = [...formatRequests, ...backgroundRequests];
  if (stylingRequests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: stylingRequests } });
  }
  if (linkRequests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: linkRequests } });
  }

  console.log(`[Sheets] Wrote ${records.length} rows to tab "${tabName}".`);
}

// --- Conditional formatting propagation --------------------------------------
// The template tab (US Outbound) is the single source of truth for color rules: whatever the planners
// set there in the Sheets UI is mirrored onto every target tab each sync. Column POSITIONS differ
// between the master and the subset tabs (the master has no Miles/RPM but has Nickname), so ranges —
// and $col refs inside custom formulas — are remapped by HEADER NAME rather than copied verbatim.
// Without that, a rule on "Customs" (col H on the master) would land on "Miles" (col H on a subset).

function columnLetterToIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Maps a source column span onto the target layout by header name, coalescing into contiguous ranges.
// Columns with no counterpart on the target (e.g. "Nickname") are dropped.
function remapRangeByHeader(range, sourceHeaders, targetHeaders, targetSheetId) {
  const start = range.startColumnIndex ?? 0;
  const end = range.endColumnIndex ?? sourceHeaders.length;
  const cols = [];
  for (let i = start; i < end; i++) {
    const idx = targetHeaders.indexOf(sourceHeaders[i]);
    if (idx !== -1) cols.push(idx);
  }
  if (cols.length === 0) return [];

  cols.sort((a, b) => a - b);
  const runs = [];
  let runStart = cols[0];
  let prev = cols[0];
  for (let i = 1; i < cols.length; i++) {
    if (cols[i] === prev + 1) { prev = cols[i]; continue; }
    runs.push([runStart, prev]);
    runStart = cols[i];
    prev = cols[i];
  }
  runs.push([runStart, prev]);

  return runs.map(([a, b]) => ({
    ...range,
    sheetId: targetSheetId,
    startColumnIndex: a,
    endColumnIndex: b + 1,
  }));
}

// Best-effort remap of $A-style column refs in a CUSTOM_FORMULA so they follow the same header map
// (this is what makes whole-row rules like =$H2="Customs Hold" survive the column shift).
function remapFormulaColumns(formula, sourceHeaders, targetHeaders) {
  return String(formula).replace(/\$([A-Z]+)/g, (match, letters) => {
    const header = sourceHeaders[columnLetterToIndex(letters)];
    const idx = header ? targetHeaders.indexOf(header) : -1;
    return idx === -1 ? match : `$${colLetter(idx)}`;
  });
}

function remapConditionalRule(rule, sourceHeaders, targetHeaders, targetSheetId) {
  const ranges = (rule.ranges ?? []).flatMap(r =>
    remapRangeByHeader(r, sourceHeaders, targetHeaders, targetSheetId));
  if (ranges.length === 0) return null; // every column it covered is absent on the target

  const copy = JSON.parse(JSON.stringify(rule));
  copy.ranges = ranges;
  const condition = copy.booleanRule?.condition;
  if (condition?.type === 'CUSTOM_FORMULA' && Array.isArray(condition.values)) {
    for (const v of condition.values) {
      if (v?.userEnteredValue) {
        v.userEnteredValue = remapFormulaColumns(v.userEnteredValue, sourceHeaders, targetHeaders);
      }
    }
  }
  return copy;
}

// Mirrors the conditional-format rules from sourceTab onto each target tab. The targets' existing
// rules are replaced, so the source tab remains the single source of truth (edit colors there only).
async function syncConditionalFormats(spreadsheetId, { sourceTab, sourceHeaders, targets }) {
  if (!targets?.length) return;
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(sheetId,title),conditionalFormats)',
    });
    const all = meta.data.sheets ?? [];

    const source = findSheetByTitle(all, sourceTab);
    if (!source) {
      console.warn(`[Sheets] Conditional formats: source tab "${sourceTab}" not found — skipping.`);
      return;
    }
    const sourceRules = source.conditionalFormats ?? [];

    const requests = [];
    let skipped = 0;
    for (const { tabName, headers } of targets) {
      const target = findSheetByTitle(all, tabName);
      if (!target) continue;
      const targetSheetId = target.properties.sheetId;

      // Clear the target's existing rules first (delete from the end so indices stay valid).
      const existing = (target.conditionalFormats ?? []).length;
      for (let i = existing - 1; i >= 0; i--) {
        requests.push({ deleteConditionalFormatRule: { sheetId: targetSheetId, index: i } });
      }
      // Re-add the source rules, remapped to this tab's column layout.
      let index = 0;
      for (const rule of sourceRules) {
        const remapped = remapConditionalRule(rule, sourceHeaders, headers, targetSheetId);
        if (!remapped) { skipped++; continue; }
        requests.push({ addConditionalFormatRule: { rule: remapped, index: index++ } });
      }
    }

    if (requests.length === 0) return;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    console.log(
      `[Sheets] Conditional formats: mirrored ${sourceRules.length} rule(s) from "${sourceTab}" onto `
      + `${targets.length} tab(s)${skipped ? ` (${skipped} skipped — columns not on target)` : ''}.`,
    );
  }, 'sync conditional formats');
}

// --- Alternating colors (banding) ---------------------------------------------
// Google's "Alternating colors" is a bandedRange — a different mechanism from conditional formatting,
// so it does NOT ride along with syncConditionalFormats. The banding on the source tab (US Outbound)
// is the colour template; every sync we re-create the band on each tab sized to exactly the rows that
// hold data (header → totals row). Row counts change every run, so a fixed range set once in the UI
// would stripe empty rows the moment the data shrinks — this keeps the stripes flush with the data.

// The API returns both the deprecated *Color and the newer *ColorStyle fields; send back only one set.
function sanitizeBandingRowProperties(rowProperties = {}) {
  const out = {};
  for (const key of ['headerColor', 'firstBandColor', 'secondBandColor', 'footerColor']) {
    const styleKey = `${key}Style`;
    if (rowProperties[styleKey]) out[styleKey] = rowProperties[styleKey];
    else if (rowProperties[key]) out[key] = rowProperties[key];
  }
  return out;
}

// The default "Alternating colors" palette — a shaded header row, white / light-grey striped body, and a
// shaded footer (totals) row. Used when a master tab has no banding of its own, so a BRAND-NEW sheet gets
// the correct header/footer/row shading automatically instead of a flat, unstyled grid. Matches the
// long-standing outbound-sheet look; planners can still override by setting their own banding in the UI
// (that becomes the template on the next sync). Grey levels: header 189, footer 222, second band 243.
const DEFAULT_BANDING_ROW_PROPERTIES = {
  headerColorStyle: { rgbColor: { red: 0.7411765, green: 0.7411765, blue: 0.7411765 } },
  firstBandColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } },
  secondBandColorStyle: { rgbColor: { red: 0.9529412, green: 0.9529412, blue: 0.9529412 } },
  footerColorStyle: { rgbColor: { red: 0.87058824, green: 0.87058824, blue: 0.87058824 } },
};

// tabs: [{ tabName, rowCount, columnCount }] — rowCount is the full written block (header + data +
// totals), or 0 for a tab with no data (which gets no stripes at all). Pass `palette` to force an
// explicit header/band/footer colour set (e.g. the trip-history sheet's blue) instead of copying a
// source tab or falling back to the grey default.
async function syncBanding(spreadsheetId, { sourceTab, tabs, palette }) {
  if (!tabs?.length) return;
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(sheetId,title),bandedRanges)',
    });
    const all = meta.data.sheets ?? [];

    // An explicit palette wins; otherwise prefer the master tab's own banding as the colour template,
    // falling back to the built-in default so a fresh sheet still gets standard header/footer/row shading.
    const source = sourceTab ? findSheetByTitle(all, sourceTab) : null;
    const template = source?.bandedRanges?.[0];
    const usingDefault = !palette && !template?.rowProperties;
    const rowProperties = palette
      ? palette
      : usingDefault
        ? DEFAULT_BANDING_ROW_PROPERTIES
        : sanitizeBandingRowProperties(template.rowProperties);
    if (usingDefault) {
      console.log(
        `[Sheets] Banding: "${sourceTab}" has no "Alternating colors" of its own — applying the built-in default palette.`,
      );
    }

    const requests = [];
    let striped = 0;
    // startRowIndex lets a tab keep rows above the table out of the band — the Summary tabs put an
    // editable "OO Cut" config cell on row 1, which must not be painted as part of the striped table.
    for (const { tabName, rowCount, columnCount, startRowIndex = 0 } of tabs) {
      const target = findSheetByTitle(all, tabName);
      if (!target) continue;
      const sheetId = target.properties.sheetId;

      // Drop whatever band is there, then re-add one sized to this tab's data.
      for (const band of target.bandedRanges ?? []) {
        requests.push({ deleteBanding: { bandedRangeId: band.bandedRangeId } });
      }
      if (!rowCount || rowCount <= 1) continue; // header-only / empty tab → no stripes

      requests.push({
        addBanding: {
          bandedRange: {
            range: {
              sheetId,
              startRowIndex,
              endRowIndex: startRowIndex + rowCount,
              startColumnIndex: 0,
              endColumnIndex: columnCount,
            },
            rowProperties,
          },
        },
      });
      striped++;
    }

    if (requests.length === 0) return;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    const paletteLabel = palette
      ? 'explicit palette'
      : usingDefault
        ? 'built-in default palette'
        : `template from "${sourceTab}"`;
    console.log(
      `[Sheets] Banding: alternating colors sized to the data on ${striped} tab(s) (${paletteLabel}).`,
    );
  }, 'sync banding');
}

// --- Column widths across the nickname tabs -----------------------------------
// Nickname tabs are VOLATILE: rename a manifest ("GA - 07/17*" -> "GA - 07/17") and the old tab is
// deleted and rebuilt carrying only the code defaults. So the planners' widths must be CAPTURED FROM
// THE PREVIOUS STATE — read the first nickname tab's widths BEFORE the sync writes anything — and then
// re-applied to every nickname tab at the end. Reading them afterwards is too late: by then the tab
// has already been rebuilt and the widths are gone (which is what reset them to defaults).

// Reads the column widths of the first tab that isn't one of skipTabs, in tab order — i.e. the first
// nickname tab (the one right after Summary) as it exists RIGHT NOW. Returns null when there is none
// or the widths aren't readable.
async function readFirstTabColumnWidths(spreadsheetId, { skipTabs = [], columnCount }) {
  return withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    // Metadata only — the fields mask excludes rowData, so no cell values come back.
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: true,
      fields: 'sheets(properties(sheetId,title,index),data(columnMetadata(pixelSize)))',
    });
    const skip = new Set(skipTabs.map((t) => String(t).toLowerCase()));
    const ordered = [...(meta.data.sheets ?? [])].sort(
      (a, b) => (a.properties.index ?? 0) - (b.properties.index ?? 0),
    );
    const first = ordered.find((s) => !skip.has(String(s.properties.title).toLowerCase()));
    if (!first) return null;

    const cm = first.data?.[0]?.columnMetadata ?? [];
    const widths = Array.from({ length: columnCount }, (_, i) => cm[i]?.pixelSize);
    if (widths.some((px) => !Number.isFinite(px) || px <= 0)) return null;
    return { tabName: first.properties.title, widths };
  }, 'read first nickname tab widths');
}

// Applies a captured width set to every named tab (including a tab that was just rebuilt, so it gets
// its widths back). A width that already matches isn't rewritten.
async function applyColumnWidths(spreadsheetId, { tabs, widths }) {
  if (!tabs?.length || !widths?.length) return;
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: true,
      fields: 'sheets(properties(sheetId,title),data(columnMetadata(pixelSize)))',
    });
    const all = meta.data.sheets ?? [];

    const requests = [];
    for (const tabName of tabs) {
      const s = findSheetByTitle(all, tabName);
      if (!s) continue;
      const sheetId = s.properties.sheetId;
      const current = s.data?.[0]?.columnMetadata ?? [];
      widths.forEach((pixelSize, idx) => {
        if (!Number.isFinite(pixelSize) || pixelSize <= 0) return;
        if (current[idx]?.pixelSize === pixelSize) return; // already matches — don't send a no-op
        requests.push({
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: idx, endIndex: idx + 1 },
            properties: { pixelSize },
            fields: 'pixelSize',
          },
        });
      });
    }

    if (requests.length === 0) return;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    console.log(
      `[Sheets] Column widths: applied the pre-sync widths to ${tabs.length} nickname tab(s) `
      + `(${requests.length} column update(s)).`,
    );
  }, 'apply column widths');
}

// Deletes any sheet whose title is not in the keepTitles list (e.g. the default "Sheet1" / "Hoja 1").
async function removeUnwantedSheets(spreadsheetId, keepTitles) {
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const all = meta.data.sheets;
    const keepLower = new Set(keepTitles.map(t => t.toLowerCase()));
    const toDelete = all.filter(s => !keepLower.has(s.properties.title.toLowerCase()));

    if (toDelete.length === 0 || toDelete.length === all.length) return;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: toDelete.map(s => ({ deleteSheet: { sheetId: s.properties.sheetId } })),
      },
    });
    console.log(`[Sheets] Removed default sheet(s): ${toDelete.map(s => s.properties.title).join(', ')}`);
  }, 'remove unwanted tabs');
}

// Reads user-entered notes and returns a Map of rowKey -> note text.
// Notes are matched by the value in the `keyHeader` column (e.g. the order's "Order ID"). The
// keyHeader must match the sheet's header text exactly — a mismatch reads zero notes and wipes them.
// options.sourceTabs — only read these tabs (default: all). Use ['US Outbound'] so erasures
// on the master tab are not resurrected from stale copies on regional tabs.
// Empty cells are stored as '' so a cleared note stays cleared after sync.
async function readNotesByKey(spreadsheetId, keyHeader, noteHeader, options = {}) {
  const { sourceTabs = null } = options;
  const sheets = await getSheetsClient();
  const notes = new Map();
  const tabFilter = sourceTabs
    ? new Set(sourceTabs.map(t => t.toLowerCase()))
    : null;

  let meta;
  try {
    meta = await sheets.spreadsheets.get({ spreadsheetId });
  } catch {
    return notes;
  }

  for (const sheet of meta.data.sheets) {
    const title = sheet.properties.title;
    if (tabFilter && !tabFilter.has(title.toLowerCase())) continue;

    let values;
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!A1:ZZ` });
      values = res.data.values || [];
    } catch {
      continue;
    }
    if (values.length < 2) continue;

    // The header is NOT always row 1. A tab carrying an editable config cell above its table — the OO Cut
    // rate on the Summary tabs — keeps its headers on row 2. So find the header by looking for the columns
    // themselves rather than assuming a position. This also makes the migration safe: the sync that first
    // introduces the config row still reads the old row-1 layout, instead of reading zero notes and
    // wiping every one of them on the write that follows.
    const headerIdx = values.findIndex(
      (row) => Array.isArray(row) && row.includes(keyHeader) && row.includes(noteHeader),
    );
    if (headerIdx === -1) continue;
    const header = values[headerIdx];
    const keyIdx = header.indexOf(keyHeader);
    const noteIdx = header.indexOf(noteHeader);

    for (let r = headerIdx + 1; r < values.length; r++) {
      const row = values[r];
      const key = String(row[keyIdx] ?? '').trim();
      if (!key || key.startsWith('=')) continue; // skip blank / totals formula rows
      const note = String(row[noteIdx] ?? '').trim();
      notes.set(key, note);
    }
  }

  return notes;
}

// --- Per-key cell colours (Summary notes) -------------------------------------
// A planner's note colour has to follow its MANIFEST, not its row: the Summary is sorted by lane name,
// so adding or removing one manifest shifts every row beneath it. We therefore read the colours keyed by
// the row's manifest BEFORE the refresh and re-apply them to wherever that manifest lands afterwards.
// The Notes column is marked clearBackground, so each run wipes the column's fills first and only the
// colours resolved here come back — a manifest that dropped off takes its colour with it.

// Google reports an unset fill as white, so white/transparent is treated as "no colour". Without this we
// would stamp white over the row banding on every unhighlighted row.
function isDefaultCellColor(rgb) {
  if (!rgb) return true;
  const { red = 0, green = 0, blue = 0, alpha = 1 } = rgb;
  if (alpha === 0) return true;
  return red === 1 && green === 1 && blue === 1;
}

// Normalizes to a plain rgb object. We deliberately read/write only `backgroundColor` (not the newer
// `backgroundColorStyle`) so this stays symmetric with the clearBackground wipe, which clears that field.
function cellBackgroundRgb(userEnteredFormat) {
  const rgb =
    userEnteredFormat?.backgroundColorStyle?.rgbColor ?? userEnteredFormat?.backgroundColor;
  return isDefaultCellColor(rgb) ? null : rgb;
}

// Returns Map<keyColumnValue, rgbColor> for the rows of `tabName` that carry an explicit fill in the
// colorHeader column. Missing tab/headers (e.g. the first run before the column exists) yields an empty
// map rather than throwing, so a fresh sheet simply has no colours to restore.
async function readColumnColorsByKey(spreadsheetId, tabName, { keyHeader, colorHeader }) {
  return withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    let res;
    try {
      res = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`${quoteSheetTitle(tabName)}!A1:ZZ`],
        includeGridData: true,
        fields:
          'sheets(data(rowData(values(formattedValue,userEnteredFormat(backgroundColor,backgroundColorStyle)))))',
      });
    } catch {
      return new Map();
    }
    const rows = res.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
    if (rows.length < 2) return new Map();

    // Header row located by content, not position — see readNotesByKey. A config cell above the table
    // shifts the headers down, and assuming row 1 would silently drop every preserved colour.
    const textOf = (row) => (row.values ?? []).map(v => String(v.formattedValue ?? '').trim());
    const headerIdx = rows.findIndex((row) => {
      const cells = textOf(row);
      return cells.includes(keyHeader) && cells.includes(colorHeader);
    });
    if (headerIdx === -1) return new Map();
    const header = textOf(rows[headerIdx]);
    const keyIdx = header.indexOf(keyHeader);
    const colorIdx = header.indexOf(colorHeader);

    const colors = new Map();
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const cells = rows[r].values ?? [];
      const key = String(cells[keyIdx]?.formattedValue ?? '').trim();
      if (!key || key.startsWith('=')) continue; // blank / totals formula row
      const rgb = cellBackgroundRgb(cells[colorIdx]?.userEnteredFormat);
      if (rgb) colors.set(key, rgb);
    }
    return colors;
  }, `read "${tabName}" note colours`);
}

// Paints one column's cells: `cells` is [{ rowIndex, color }] with a 0-based rowIndex.
async function applyCellColors(spreadsheetId, tabName, { columnIndex, cells }) {
  if (!cells?.length || columnIndex < 0) return;
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    const tabId = await getTabId(spreadsheetId, tabName);
    if (tabId === undefined) return;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: cells.map(({ rowIndex, color }) => ({
          repeatCell: {
            range: {
              sheetId: tabId,
              startRowIndex: rowIndex,
              endRowIndex: rowIndex + 1,
              startColumnIndex: columnIndex,
              endColumnIndex: columnIndex + 1,
            },
            cell: { userEnteredFormat: { backgroundColor: color } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        })),
      },
    });
    console.log(`[Sheets] Restored ${cells.length} note colour(s) on "${tabName}".`);
  }, `apply "${tabName}" note colours`);
}

// Renames existing tabs in place — used to migrate old tab titles to new ones without deleting and
// recreating them (which would drop any manual formatting or user-entered filter values on the tab).
// `renames` is [{ from, to }]. A rename is skipped when the `from` tab is absent or a `to` tab already
// exists, so it's safe to run every sync (a no-op once the migration is done).
async function renameTabs(spreadsheetId, renames = []) {
  if (!renames.length) return;
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const all = meta.data.sheets ?? [];
    const titles = new Set(all.map((s) => s.properties.title));
    const requests = [];
    for (const { from, to } of renames) {
      if (from === to || !titles.has(from) || titles.has(to)) continue;
      const sheet = all.find((s) => s.properties.title === from);
      if (!sheet) continue;
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: sheet.properties.sheetId, title: to },
          fields: "title",
        },
      });
      titles.delete(from);
      titles.add(to);
    }
    if (requests.length === 0) return;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    console.log(`[Sheets] Renamed ${requests.length} tab(s) to their new titles.`);
  }, "rename tabs");
}

// Orders the sheet tabs left-to-right to match orderedTitles (titles not present are ignored).
async function reorderSheets(spreadsheetId, orderedTitles) {
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    for (let targetIndex = 0; targetIndex < orderedTitles.length; targetIndex++) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId });
      const match = findSheetByTitle(meta.data.sheets, orderedTitles[targetIndex]);
      if (!match) continue;
      const { sheetId, index: currentIndex } = match.properties;
      if (currentIndex === targetIndex) continue;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: { sheetId, index: targetIndex },
              fields: 'index',
            },
          }],
        },
      });
    }
  }, 'reorder tabs');
}

// --- Ops sheet helpers (read/write without full refresh) -----------------------

async function getTabId(spreadsheetId, tabName) {
  return withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existing = findSheetByTitle(meta.data.sheets, tabName);
    return existing?.properties.sheetId;
  }, `look up tab "${tabName}"`, QUOTA_RETRY);
}

// The first Sheets call each ops queue makes. When the read quota was exhausted this threw before the
// queue was even read, so Force Delete Manifest skipped a perfectly valid row without touching it.
async function ensureTabWithHeaders(spreadsheetId, tabName, headers) {
  return withGoogleRetry(
    () => ensureTabWithHeadersOnce(spreadsheetId, tabName, headers),
    `ensure ops tab "${tabName}"`,
    QUOTA_RETRY,
  );
}

async function ensureTabWithHeadersOnce(spreadsheetId, tabName, headers) {
  const sheets = await getSheetsClient();
  let tabId = await getTabId(spreadsheetId, tabName);

  if (tabId === undefined) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    tabId = created.data.replies[0].addSheet.properties.sheetId;
    console.log(`[Sheets] Created ops tab: ${tabName}`);
  }

  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A1:ZZ1` });
  const row = current.data.values?.[0] ?? [];
  const headersMatch = row.length === headers.length
    && headers.every((h, i) => String(row[i] ?? '').trim() === h);
  if (!headersMatch) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: tabId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: headers.length,
              },
              cell: {
                userEnteredFormat: {
                  horizontalAlignment: 'LEFT',
                  textFormat: { bold: true },
                },
              },
              fields: 'userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat.bold',
            },
          },
          ...headers.map((_, idx) => ({
            updateDimensionProperties: {
              range: { sheetId: tabId, dimension: 'COLUMNS', startIndex: idx, endIndex: idx + 1 },
              properties: { pixelSize: idx === 0 ? 160 : idx === 3 ? 320 : 140 },
              fields: 'pixelSize',
            },
          })),
        ],
      },
    });
    console.log(`[Sheets] Wrote headers on ops tab "${tabName}".`);
  }
}

// valueRenderOption defaults to FORMATTED_VALUE (what a reader sees). Pass 'UNFORMATTED_VALUE' when the
// values will be written straight back — e.g. the trip-history read-modify-write, which must re-emit the
// existing rows as raw numbers so a currency string doesn't round-trip through the locale parser.
async function readTabValues(spreadsheetId, tabName, { valueRenderOption } = {}) {
  return withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A1:ZZ`,
      ...(valueRenderOption ? { valueRenderOption } : {}),
    });
    return res.data.values || [];
  }, `read "${tabName}"`);
}

async function writeTabValues(spreadsheetId, tabName, values) {
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteSheetTitle(tabName)}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  }, `write "${tabName}"`, QUOTA_RETRY);
}

async function writeTabRange(spreadsheetId, tabName, a1Range, values, valueInputOption = 'USER_ENTERED') {
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteSheetTitle(tabName)}!${a1Range}`,
      valueInputOption,
      requestBody: { values },
    });
  }, `write "${tabName}!${a1Range}"`, QUOTA_RETRY);
}

async function clearTabRange(spreadsheetId, tabName, a1Range) {
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${tabName}!${a1Range}`,
    });
  }, `clear "${tabName}!${a1Range}"`);
}

async function ensureTab(spreadsheetId, tabName, { index } = {}) {
  return withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    let tabId = await getTabId(spreadsheetId, tabName);
    if (tabId !== undefined) return tabId;

    const properties = { title: tabName };
    if (index !== undefined) properties.index = index;

    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties } }] },
    });
    tabId = created.data.replies[0].addSheet.properties.sheetId;
    console.log(`[Sheets] Created tab: ${tabName}`);
    return tabId;
  }, `ensure tab "${tabName}"`);
}

// Append-only write for the trip-history archive: never clears existing data. Ensures the tab exists,
// seeds the header row when the tab is empty (or its first row doesn't match), then appends `rows`
// after the last row. USER_ENTERED so =HYPERLINK() cells and dates parse. Returns the number appended.
async function appendRowsToTab(spreadsheetId, tabName, headers, rows, { index } = {}) {
  await ensureTab(spreadsheetId, tabName, { index });
  const existing = await readTabValues(spreadsheetId, tabName);
  const headerRow = existing[0] ?? [];
  const headerMatches =
    headerRow.length === headers.length &&
    headers.every((h, i) => String(headerRow[i] ?? '').trim() === h);
  if (!headerMatches) {
    await writeTabRange(spreadsheetId, tabName, 'A1', [headers], 'RAW');
  }
  if (!rows.length) return 0;
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${quoteSheetTitle(tabName)}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
  }, `append ${rows.length} row(s) to "${tabName}"`);
  return rows.length;
}

async function moveTabToIndex(spreadsheetId, tabName, targetIndex) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const match = findSheetByTitle(meta.data.sheets, tabName);
  const sheetId = match?.properties.sheetId;
  if (sheetId === undefined || match.properties.index === targetIndex) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: { sheetId, index: targetIndex },
          fields: 'index',
        },
      }],
    },
  });
}

async function setSheetHidden(spreadsheetId, tabName, hidden = true) {
  const sheets = await getSheetsClient();
  const tabId = await getTabId(spreadsheetId, tabName);
  if (tabId === undefined) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: { sheetId: tabId, hidden },
          fields: 'hidden',
        },
      }],
    },
  });
}

// Applies a pick-from-list dropdown to a single cell (0-based row/column indices).
async function applyCellDropdown(spreadsheetId, tabName, { rowIndex, columnIndex, values, alignLeft = false }) {
  const sheets = await getSheetsClient();
  const tabId = await getTabId(spreadsheetId, tabName);
  if (tabId === undefined) return;

  const range = {
    sheetId: tabId,
    startRowIndex: rowIndex,
    endRowIndex: rowIndex + 1,
    startColumnIndex: columnIndex,
    endColumnIndex: columnIndex + 1,
  };

  const requests = [{
    setDataValidation: {
      range,
      rule: {
        condition: {
          type: 'ONE_OF_LIST',
          values: values.map(v => ({ userEnteredValue: String(v) })),
        },
        showCustomUi: true,
        strict: false,
      },
    },
  }];

  if (alignLeft) {
    requests.unshift({
      repeatCell: {
        range,
        cell: { userEnteredFormat: { horizontalAlignment: 'LEFT' } },
        fields: 'userEnteredFormat.horizontalAlignment',
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

// Text dropdown for filter cells (e.g. ON/OFF) — stores plain text, left-aligned, like On commission.
async function applyFilterDropdownCell(spreadsheetId, tabName, { rowIndex, columnIndex, value, values }) {
  await withGoogleRetry(async () => {
    const sheets = await getSheetsClient();
    const tabId = await getTabId(spreadsheetId, tabName);
    if (tabId === undefined) return;

    const cellValue = String(value);
    const range = {
      sheetId: tabId,
      startRowIndex: rowIndex,
      endRowIndex: rowIndex + 1,
      startColumnIndex: columnIndex,
      endColumnIndex: columnIndex + 1,
    };

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range,
              cell: {
                userEnteredValue: { stringValue: cellValue },
                userEnteredFormat: {
                  horizontalAlignment: 'LEFT',
                  numberFormat: { type: 'TEXT' },
                },
              },
              fields: 'userEnteredValue,userEnteredFormat.horizontalAlignment,userEnteredFormat.numberFormat',
            },
          },
          {
            setDataValidation: {
              range,
              rule: {
                condition: {
                  type: 'ONE_OF_LIST',
                  values: values.map(v => ({ userEnteredValue: String(v) })),
                },
                showCustomUi: true,
                strict: true,
              },
            },
          },
        ],
      },
    });
  }, `filter dropdown on "${tabName}"`);
}

// Applies a pick-from-list dropdown to one column (e.g. Force Deliver Status).
async function applyColumnDropdown(spreadsheetId, tabName, headers, opts) {
  await withGoogleRetry(
    () => applyColumnDropdownOnce(spreadsheetId, tabName, headers, opts),
    `dropdown on "${tabName}"`,
    QUOTA_RETRY,
  );
}

async function applyColumnDropdownOnce(spreadsheetId, tabName, headers, { column, values, startRow = 1, endRow = 500 }) {
  const sheets = await getSheetsClient();
  const tabId = await getTabId(spreadsheetId, tabName);
  if (tabId === undefined) return;

  const colIdx = headers.indexOf(column);
  if (colIdx === -1) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        setDataValidation: {
          range: {
            sheetId: tabId,
            startRowIndex: startRow,
            endRowIndex: endRow,
            startColumnIndex: colIdx,
            endColumnIndex: colIdx + 1,
          },
          rule: {
            condition: {
              type: 'ONE_OF_LIST',
              values: values.map(v => ({ userEnteredValue: String(v) })),
            },
            showCustomUi: true,
            // Allow script-written values (done/error) even if the list changes later.
            strict: false,
          },
        },
      }],
    },
  });
}

// Removes default tabs on the ops spreadsheet (keeps only the named tabs).
async function removeUnwantedOpsSheets(spreadsheetId, keepTitles) {
  await removeUnwantedSheets(spreadsheetId, keepTitles);
}

async function writeToSheetWithRetry(spreadsheetId, tabName, records, options = {}) {
  await withGoogleRetry(
    () => writeToSheet(spreadsheetId, tabName, records, options),
    `write "${tabName}"`,
    { baseDelayMs: 8000 },
  );
}

// --- Native Google Sheets "Table" -------------------------------------------
// Wraps a written range in a real Table object (the Format ▸ Convert to table feature) so the header
// gets per-column filter/sort dropdowns and the user can drill down (e.g. one driver, or OO vs CD).
// The Table survives the sync's clear+rewrite but its range does NOT auto-grow, so this re-sizes it to
// the current row count each run. A Table supplies its own alternating row colors, so any pre-existing
// banded range is removed and the palette is applied to the Table instead. The range covers the header
// + data rows only — the config row above it and the totals row below it stay outside the Table.

// A Table name must be unique per spreadsheet and letters/digits/underscore only.
const tableName = (tabName) => `Trip_${String(tabName).replace(/[^A-Za-z0-9]/g, '') || 'Tab'}`;

async function syncTable(spreadsheetId, tabName, opts = {}) {
  const { headerRowIndex = 1, dataRowCount = 0, columns = [], palette = null, freeze = true } = opts;
  if (dataRowCount <= 0) return; // a Table needs at least one data row
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title),tables,bandedRanges,basicFilter)',
  });
  const sh = findSheetByTitle(meta.data.sheets, tabName);
  if (!sh) return;
  const sheetId = sh.properties.sheetId;
  const endColumnIndex = columns.length;
  const totalsRowIndex = headerRowIndex + 1 + dataRowCount; // the SUBTOTAL row, just below the Table
  const existing = (sh.tables ?? [])[0];
  const requests = [];

  // Strip banded ranges ONLY when first creating the Table — those are the legacy custom bands. Once the
  // Table exists it owns its row colors via its OWN internal banded range; deleting that destroys it.
  if (!existing) {
    for (const b of sh.bandedRanges ?? []) requests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
    if (sh.basicFilter) requests.push({ clearBasicFilter: { sheetId } });
  }

  const range = {
    sheetId,
    startRowIndex: headerRowIndex,
    endRowIndex: headerRowIndex + 1 + dataRowCount,
    startColumnIndex: 0,
    endColumnIndex,
  };
  // A Table's columnType drives how its cells DISPLAY (it overrides any userEnteredFormat inside the
  // Table's range), so the format has to be chosen here: CURRENCY renders $#,##0.00; DOUBLE renders the
  // value's own digits (whole-number columns are pre-rounded so they show no decimals); everything else
  // is TEXT. The totals row sits outside the Table and keeps the number format writeToSheet gave it.
  const columnType = (c) => {
    if (c.format === 'currency') return 'CURRENCY';
    if (c.format === 'date') return 'DATE';
    if (['decimal', 'integer', 'wholeComma', 'ratio'].includes(c.format)) return 'DOUBLE';
    return 'TEXT';
  };
  const columnProperties = columns.map((c, i) => ({
    columnIndex: i,
    columnName: c.header,
    columnType: columnType(c),
  }));
  const table = { name: tableName(tabName), range, columnProperties };
  if (palette) {
    table.rowsProperties = {
      headerColorStyle: palette.headerColorStyle,
      firstBandColorStyle: palette.firstBandColorStyle,
      secondBandColorStyle: palette.secondBandColorStyle,
    };
  }
  if (existing) {
    table.tableId = existing.tableId;
    table.name = existing.name; // keep the user-visible name stable
    requests.push({
      updateTable: {
        table,
        fields: 'range,columnProperties' + (palette ? ',rowsProperties' : ''),
      },
    });
  } else {
    requests.push({ addTable: { table } });
  }

  // Reset cell backgrounds across header→totals so the Table's bands show through (a stale footer fill
  // from a previous run would otherwise linger on whatever row now sits there), then paint the totals
  // (footer) row and freeze the config + header rows.
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: headerRowIndex, endRowIndex: totalsRowIndex + 1, startColumnIndex: 0, endColumnIndex },
      cell: {},
      fields: 'userEnteredFormat.backgroundColor',
    },
  });
  if (palette?.footerColorStyle) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: totalsRowIndex, endRowIndex: totalsRowIndex + 1, startColumnIndex: 0, endColumnIndex },
        cell: { userEnteredFormat: { backgroundColor: palette.footerColorStyle.rgbColor } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
  }
  if (freeze) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: headerRowIndex + 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
  }
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  // Google quirk: when a Table's header is NOT on row 1, addTable inserts a phantom duplicate cell into
  // the header row (shifting the real headers right). Overwrite the header row with the correct values —
  // plus trailing blanks to wipe the phantom — right after CREATING the table (updateTable doesn't do it).
  if (!existing) {
    const headers = columns.map((c) => c.header);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteSheetTitle(tabName)}!A${headerRowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[...headers, '', '']] },
    });
  }
}

// Writes a small labelled config cell on row 1 (above a headerRow:2 Table) and formats it. Because
// writeToSheet clears only from row 2 down, this row is preserved between syncs — so a value the caller
// read back and passes here round-trips the planner's manual edits. Any leftover cells on row 1 (e.g. an
// old header from a pre-Table layout) are cleared first.
async function setConfigCell(spreadsheetId, tabName, opts = {}) {
  const { label, value, numberFormat = null } = opts;
  const sheets = await getSheetsClient();
  const tabRef = quoteSheetTitle(tabName);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tabRef}!A1:ZZ1` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabRef}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[label, value]] },
  });
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
  const sh = findSheetByTitle(meta.data.sheets, tabName);
  if (!sh) return;
  const sheetId = sh.properties.sheetId;
  const requests = [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: 'LEFT' } },
        fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.horizontalAlignment',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'LEFT',
            ...(numberFormat ? { numberFormat } : {}),
          },
        },
        fields: 'userEnteredFormat.horizontalAlignment' + (numberFormat ? ',userEnteredFormat.numberFormat' : ''),
      },
    },
  ];
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

// Writes "Last synced <local time>" beside a tab's config cells.
//
// Every one of these sheets is a live mirror with no visible sign of its own freshness, which is exactly
// how a sync could stop for two and a half days before a person noticed the rows looked old. A stamp the
// planners can see turns that into something obvious at a glance instead of something inferred from
// version history.
//
// Written as TEXT: left to itself Sheets parses a timestamp into a serial and renders it however the
// locale feels, which is precisely the sort of quiet reinterpretation this is meant to guard against.
async function stampLastSynced(spreadsheetId, tabName, options = {}) {
  const {
    cell = 'D1',
    label = 'Last synced',
    timeZone = process.env.REPORT_TIMEZONE || 'America/Toronto',
  } = options;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  const stamp = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
  const col = cell.replace(/\d+/g, '');
  const rowNum = cell.replace(/\D+/g, '');
  const nextCol = String.fromCharCode(col.charCodeAt(col.length - 1) + 1);
  const range = `${col}${rowNum}:${nextCol}${rowNum}`;
  try {
    await writeTabRange(spreadsheetId, tabName, range, [[label, `'${stamp}`]]);
  } catch (err) {
    // Never fail a sync over its own freshness marker.
    console.warn(`[Sheets] Could not stamp "${tabName}!${range}": ${err.message}`);
    return null;
  }
  return stamp;
}

module.exports = {
  createSpreadsheet,
  stampLastSynced,
  writeToSheet,
  writeToSheetWithRetry,
  ensureGoogleAuth,
  withGoogleRetry,
  sleep,
  removeUnwantedSheets,
  reorderSheets,
  renameTabs,
  readNotesByKey,
  ensureTabWithHeaders,
  ensureTab,
  appendRowsToTab,
  moveTabToIndex,
  readTabValues,
  writeTabValues,
  writeTabRange,
  clearTabRange,
  applyCellDropdown,
  applyFilterDropdownCell,
  applyColumnDropdown,
  setSheetHidden,
  removeUnwantedOpsSheets,
  flattenObject,
  resolveFieldValue,
  syncConditionalFormats,
  syncBanding,
  syncTable,
  setConfigCell,
  readFirstTabColumnWidths,
  applyColumnWidths,
  readColumnColorsByKey,
  applyCellColors,
};

