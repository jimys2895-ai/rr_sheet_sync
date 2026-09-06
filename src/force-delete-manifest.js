require('dotenv').config();
const { findMasterTripForForceDelete, forceDeleteManifest, getForceDeliverOrgRoutes } = require('./roserocket');
const { ensureTabWithHeaders, readTabValues, writeTabValues, applyColumnDropdown } = require('./sheets');

const TAB_NAME = 'Force Delete Manifest';
const HEADERS = ['Manifest ID', 'Status', 'Processed at', 'Info', 'Error'];
const STATUS_QUEUE = ['pending', 'retry'];
const STATUS_RESULTS = ['done', 'error'];
const STATUS_DROPDOWN = ['', ...STATUS_QUEUE, ...STATUS_RESULTS];
const PENDING = new Set(['', ...STATUS_QUEUE]);

function formatApiError(err) {
  const data = err.response?.data;
  if (typeof data === 'string') return data.trim();
  if (data?.error_message) return data.error_message;
  if (data?.errors?.[0]?.message) return data.errors[0].message;
  if (data?.message) return Array.isArray(data.message) ? data.message.join('; ') : data.message;
  if (data?.error) return String(data.error);
  return err.message;
}

function isPending(status) {
  return PENDING.has(String(status ?? '').trim().toLowerCase());
}

// Reads the Force Delete Manifest tab on the ops spreadsheet, deletes linked eManifests
// and writes Status / Processed at / Info / Error back to the sheet.
async function processForceDeleteManifest(spreadsheetId) {
  console.log(`\n[ForceDeleteManifest] Ops sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
  for (const { prefix, orgUrl } of getForceDeliverOrgRoutes()) {
    console.log(`[ForceDeleteManifest] ${prefix}M* manifests → ${orgUrl}`);
  }
  await ensureTabWithHeaders(spreadsheetId, TAB_NAME, HEADERS);
  await applyColumnDropdown(spreadsheetId, TAB_NAME, HEADERS, {
    column: 'Status',
    values: STATUS_DROPDOWN,
  });

  const values = await readTabValues(spreadsheetId, TAB_NAME);
  if (values.length <= 1) {
    console.log('[ForceDeleteManifest] No queue rows — add a Manifest ID and choose Status "pending" from the dropdown.');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  const header = values[0];
  const col = name => header.indexOf(name);
  const manifestCol = col('Manifest ID') !== -1 ? col('Manifest ID') : col('Manifest CETM#');
  const statusCol = col('Status');
  const atCol = col('Processed at');
  const infoCol = col('Info');
  const errCol = col('Error');
  if (manifestCol === -1 || statusCol === -1) {
    throw new Error(`[ForceDeleteManifest] Tab "${TAB_NAME}" is missing required columns. Expected: ${HEADERS.join(', ')}`);
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const now = () => new Date().toISOString();

  for (let r = 1; r < values.length; r++) {
    const row = values[r] ?? [];
    while (row.length < header.length) row.push('');

    const manifestId = String(row[manifestCol] ?? '').trim();
    if (!manifestId) continue;

    const status = String(row[statusCol] ?? '').trim();
    if (!isPending(status)) continue;

    processed++;
    console.log(`[ForceDeleteManifest] Processing ${manifestId} (row ${r + 1})...`);

    try {
      const found = await findMasterTripForForceDelete(manifestId);
      if (!found) {
        row[statusCol] = 'error';
        row[atCol] = now();
        if (infoCol !== -1) row[infoCol] = '';
        if (errCol !== -1) row[errCol] = `Manifest not found: ${manifestId}`;
        failed++;
        console.log(`[ForceDeleteManifest]   Not found: ${manifestId}`);
        continue;
      }

      const { trip, orgUrl } = found;
      console.log(`[ForceDeleteManifest]   Org: ${orgUrl}`);

      const { deletedEmanifests } = await forceDeleteManifest(trip, orgUrl);
      row[statusCol] = 'done';
      row[atCol] = now();
      if (infoCol !== -1) {
        row[infoCol] = deletedEmanifests
          ? `Deleted ${deletedEmanifests} eManifest(s) + manifest`
          : 'Deleted manifest';
      }
      if (errCol !== -1) row[errCol] = '';
      succeeded++;
      console.log(`[ForceDeleteManifest]   Deleted ${trip.full_id} (${deletedEmanifests} eManifest(s))`);
    } catch (err) {
      row[statusCol] = 'error';
      row[atCol] = now();
      if (infoCol !== -1) row[infoCol] = '';
      if (errCol !== -1) row[errCol] = formatApiError(err);
      failed++;
      console.error(`[ForceDeleteManifest]   Failed ${manifestId}: ${row[errCol]}`);
    }

    values[r] = row;
  }

  await writeTabValues(spreadsheetId, TAB_NAME, values);
  console.log(`[ForceDeleteManifest] Finished — processed ${processed}, succeeded ${succeeded}, failed ${failed}.`);
  return { processed, succeeded, failed };
}

module.exports = { processForceDeleteManifest, TAB_NAME, HEADERS, STATUS_QUEUE, STATUS_DROPDOWN };
