/**
 * Google Sheets service-account test (OAuth token + one read).
 * Usage: node test-google-auth.js
 */
require('dotenv').config();
const { getCommissionSheetId } = require('./src/sync');
const { ensureGoogleAuth, readTabValues } = require('./src/sheets');

async function run() {
  console.log('Testing Google service-account credentials...');
  try {
    await ensureGoogleAuth();
    const sheetId = getCommissionSheetId();
    if (sheetId) {
      const values = await readTabValues(sheetId, 'Commission Lookup');
      console.log(`✓ Read Commission Lookup tab (${values.length} row(s)).`);
    } else {
      console.log('✓ Token OK (GOOGLE_COMMISSION_SHEET_ID not set — skipped sheet read).');
    }
    process.exit(0);
  } catch (err) {
    console.error('✗ Google auth failed:', err.message);
    process.exit(1);
  }
}

run();
