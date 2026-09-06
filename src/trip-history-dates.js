require('dotenv').config();
const {
  getTripHistorySheetId, updateTab, updateByDriverTab, updateCompareTab, TRIP_TABS,
} = require('./trip-history');
const { fetchMasterTripsSince, masterTripFinishedAt, fetchDriverTypes } = require('./roserocket');

// One-off backfill of the trip-history **Date** column.
//
// Rows archived before that column existed carry only a "Week N" label — no year, no month — so they
// cannot support month-by-month or year-over-year analysis, and sorting by week alone interleaves years
// once the archive crosses a January. This fills the blank Date cells from RoseRocket's manifest list.
//
//   npm run trip-history:dates                    # back to TRIP_HISTORY_DATES_FROM (default 2025-11-01)
//   npm run trip-history:dates -- 2026-01-01
//   npm run trip-history:dates -- --overwrite     # also REPLACE dates already on the sheet
//
// Safe to re-run: by default it only ever fills a BLANK Date, so a value already on the sheet — including
// a hand-correction — is left untouched. Trips completed after the sync started writing dates already
// have one and are skipped. --overwrite drops that guard; it exists for re-running against a corrected
// source and will discard manual edits to the Date column.
//
// Date source, in order: `lkl_completed_at` — when the manifest's LAST STOP actually completed — then
// `completed_at`. The distinction matters: `completed_at` is the administrative close-out, and CET closes
// manifests in batches, so several trips finished on different days share one close-out timestamp. Using
// it put ~14% of trips in the wrong ISO week, contradicting the "Week N" label already on the sheet.
// `lkl_completed_at` tracks the real haul and agrees with the week the sync computed from the inbound
// order's completion.
const DEFAULT_FROM = process.env.TRIP_HISTORY_DATES_FROM || '2025-11-01';

function resolveFrom(arg) {
  if (!arg) return DEFAULT_FROM;
  if (/^\d+$/.test(arg)) return new Date(Date.now() - Number(arg) * 86400000).toISOString().slice(0, 10);
  return arg;
}

async function backfillTripDates(sheetId, { from = DEFAULT_FROM, overwrite = false } = {}) {
  const sinceMs = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(sinceMs)) throw new Error(`Unreadable start date: "${from}"`);
  console.log(`[TripDates] Listing manifests completed since ${from}…`);

  const trips = await fetchMasterTripsSince(undefined, { sinceMs });
  const dateByManifest = new Map();
  for (const t of trips) {
    const fullId = String(t?.full_id ?? '').trim();
    const at = t?.lkl_completed_at || masterTripFinishedAt(t) || t?.completed_at;
    if (fullId && at) dateByManifest.set(fullId, String(at).slice(0, 10));
  }
  console.log(`[TripDates] ${dateByManifest.size} manifest(s) carry a completion date.`);
  if (!dateByManifest.size) return { filled: 0 };

  const driverTypes = await fetchDriverTypes();
  let filled = 0;
  const driverSets = [];
  for (const { tab, kind } of TRIP_TABS) {
    const res = await updateTab(sheetId, tab, kind, driverTypes, [], { dateByManifest, overwriteDates: overwrite });
    filled += res.filledDates;
    driverSets.push(res.drivers);
  }
  await updateByDriverTab(sheetId, driverTypes, driverSets);
  await updateCompareTab(sheetId, driverTypes, driverSets);
  console.log(
    `[TripDates] Done — ${filled} date(s) ${overwrite ? 'written' : 'backfilled'} across ${TRIP_TABS.length} tabs.`,
  );
  return { filled };
}

if (require.main === module) {
  const sheetId = getTripHistorySheetId();
  if (!sheetId) {
    console.error('[TripDates] GOOGLE_TRIP_HISTORY_SHEET_ID not set.');
    process.exit(1);
  }
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  backfillTripDates(sheetId, {
    from: resolveFrom(args[0]),
    overwrite: process.argv.includes('--overwrite'),
  })
    .then(() => process.exit(0))
    .catch((err) => { console.error(`[TripDates] Failed: ${err.message}`); process.exit(1); });
}

module.exports = { backfillTripDates };
