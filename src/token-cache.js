// Shared RoseRocket token cache.
//
// Every cron run is a fresh container, so the token a run obtains — valid for 30 minutes — used to be
// thrown away when the run ended, and the next run logged in again. Across the outbound, inbound,
// commission and trip-history jobs that came to ~32 logins an hour on one RoseRocket account, where ~4
// would do. On 14 Oct RoseRocket started answering "Too many login attempts" and every sync stopped.
//
// Runs now share the token through a small PRIVATE spreadsheet (ROSEROCKET_TOKEN_CACHE_SHEET_ID): a blank
// sheet shared with the integration's Google service account and with no one else — never one of the
// client-facing sheets. Its first tab is used, whatever it is called. Anyone able to read it already
// has the integration's own access, and a token in it is dead within 30 minutes regardless.
//
// Fail-open throughout: no sheet configured, no Google credentials, a slow or failed read — the caller
// simply logs in as it always did. A broken cache must never be the reason a sync fails.
//
// Layout: one row per org — org slug | token | expiresAt (epoch ms) | updatedAt (ISO).
const RANGE = 'A1:D20'; // no tab name: the spreadsheet's first tab, so the sheet's locale doesn't matter
const HEADER = ['org', 'token', 'expiresAt', 'updatedAt'];
const TIMEOUT_MS = 15000;

const cacheSheetId = () => String(process.env.ROSEROCKET_TOKEN_CACHE_SHEET_ID ?? '').trim();
const isConfigured = () => cacheSheetId() !== '';

// Loaded lazily: auth.js is required by every script, and not every one of them needs Google at all.
let clientPromise = null;
function sheetsClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { google } = require('googleapis');
      const { ensureGoogleAuth } = require('./sheets');
      const auth = await ensureGoogleAuth();
      return google.sheets({ version: 'v4', auth });
    })().catch((err) => { clientPromise = null; throw err; });
  }
  return clientPromise;
}

const withTimeout = (p) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
]);

async function readRows() {
  const sheets = await sheetsClient();
  const res = await withTimeout(sheets.spreadsheets.values.get({
    spreadsheetId: cacheSheetId(), range: RANGE, valueRenderOption: 'UNFORMATTED_VALUE',
  }));
  return (res.data.values ?? []).slice(1); // drop the header
}

// The cached entry for an org, or null. Never throws.
async function readSharedToken(slug) {
  if (!isConfigured()) return null;
  try {
    const row = (await readRows()).find((r) => String(r[0] ?? '') === slug);
    if (!row || !row[1]) return null;
    return { token: String(row[1]), expiresAt: Number(row[2]) || 0 };
  } catch (err) {
    console.warn(`[Auth] Shared token cache unreadable (${err.message}) — logging in directly.`);
    return null;
  }
}

// Stores the token for an org, replacing that org's row. Best effort; never throws.
async function writeSharedToken(slug, entry) {
  if (!isConfigured()) return;
  try {
    const rows = (await readRows()).filter((r) => String(r[0] ?? '') && String(r[0]) !== slug);
    rows.push([slug, entry.token, entry.expiresAt, new Date().toISOString()]);
    const sheets = await sheetsClient();
    await withTimeout(sheets.spreadsheets.values.update({
      spreadsheetId: cacheSheetId(), range: RANGE, valueInputOption: 'RAW',
      requestBody: { values: [HEADER, ...rows, ...Array(Math.max(0, 19 - rows.length)).fill(['', '', '', ''])] },
    }));
  } catch (err) {
    console.warn(`[Auth] Could not update the shared token cache (${err.message}) — next run will log in.`);
  }
}

module.exports = { readSharedToken, writeSharedToken, isConfigured };
