require('dotenv').config();
const { syncTripHistory, getTripHistorySheetId } = require('./trip-history');

// ONE-OFF backfill of the trip-history archive.
//
// The regular cron looks back TRIP_HISTORY_SINCE_DAYS (60) — enough to catch trips as they finish, and
// cheap enough to run every 30 minutes. This script runs the SAME archive logic over a much wider
// window so the sheet can be filled back to the start of the year in a single pass. It is deliberately
// NOT on a schedule: reaching back to January means paging every order created since then (~8,700) and
// resolving several hundred manifests, which is far too much work to repeat every half hour.
//
//   npm run trip-history:backfill                 # back to BACKFILL_FROM (default 2026-01-01)
//   npm run trip-history:backfill -- 2026-03-01   # back to a specific date
//   npm run trip-history:backfill -- 180          # or a plain number of days
//
// Safe to stop and re-run. Rows are written in batches as the run progresses, and every manifest already
// on the Rounder tab is skipped, so a second run picks up where the first left off instead of starting
// over or duplicating anything. Nothing is written back to RoseRocket — this only fills the sheet.
const DEFAULT_FROM = process.env.TRIP_HISTORY_BACKFILL_FROM || '2026-01-01';
const FLUSH_EVERY = parseInt(process.env.TRIP_HISTORY_BACKFILL_FLUSH ?? '25', 10);

// Accepts a plain day count ("180") or a calendar date ("2026-01-01") and returns the day count the
// archive window needs. A day is added so the start date itself is inside the window.
function sinceDaysFromArg(arg) {
  const raw = String(arg ?? DEFAULT_FROM).trim();
  const asDays = Number(raw);
  if (Number.isFinite(asDays) && asDays > 0 && !raw.includes('-')) {
    return { sinceDays: Math.ceil(asDays), label: `${Math.ceil(asDays)} day(s) back` };
  }
  const ms = Date.parse(`${raw.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`Could not read "${raw}" as a date (YYYY-MM-DD) or a number of days.`);
  }
  const sinceDays = Math.ceil((Date.now() - ms) / 86400000) + 1;
  if (sinceDays <= 0) throw new Error(`"${raw}" is in the future.`);
  return { sinceDays, label: `${raw.slice(0, 10)} (${sinceDays} day(s) back)` };
}

async function run() {
  const sheetId = getTripHistorySheetId();
  if (!sheetId) {
    console.error('[TripHistory] GOOGLE_TRIP_HISTORY_SHEET_ID not set.');
    process.exit(1);
  }
  const { sinceDays, label } = sinceDaysFromArg(process.argv[2]);
  console.log(`[TripHistory] BACKFILL to ${label} — this takes a while; it writes as it goes.`);
  const result = await syncTripHistory(sheetId, { sinceDays, flushEvery: FLUSH_EVERY });
  console.log(
    `[TripHistory] Backfill complete: ${result.archived} manifest(s) added, ${result.skipped} skipped.`,
  );
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[TripHistory] Backfill failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { sinceDaysFromArg };
