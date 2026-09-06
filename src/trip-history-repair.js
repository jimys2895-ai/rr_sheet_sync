require('dotenv').config();
const { repairTripHistory, getTripHistorySheetId } = require('./trip-history');

// Removes "hollow" rows from the trip-history archive — rows carrying a Manifest ID but no city and no
// revenue. Those appear when a run archives a manifest while its RoseRocket /stops fetch is failing:
// everything except the manifest's own mileage comes from the stops, so the row lands almost empty AND
// blocks the trip forever, because the de-dup treats any archived manifest as done.
//
//   npm run trip-history:repair            # dry run — lists what it would remove
//   npm run trip-history:repair -- --apply # actually remove them
//
// After applying, re-run the sync or the backfill and the trips are archived properly.
async function run() {
  const sheetId = getTripHistorySheetId();
  if (!sheetId) {
    console.error('[TripHistory] GOOGLE_TRIP_HISTORY_SHEET_ID not set.');
    process.exit(1);
  }
  await repairTripHistory(sheetId, { apply: process.argv.includes('--apply') });
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[TripHistory] Repair failed: ${err.message}`);
      process.exit(1);
    });
}
