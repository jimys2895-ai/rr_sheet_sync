require('dotenv').config();
const { findOrderForForceDeliver, forceDeliverOrder, getForceDeliverOrgRoutes } = require('./roserocket');
const { ensureTabWithHeaders, readTabValues, writeTabValues, applyColumnDropdown } = require('./sheets');

const TAB_NAME = 'Force Deliver';
const HEADERS = ['Order ID', 'Status', 'Processed at', 'Info', 'Error'];
// Queue values — pick one from the Status dropdown to process a row.
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

// Reads the Force Deliver tab on the ops spreadsheet, marks pending orders as Delivered
// in RoseRocket, and writes Status / Processed at / Info / Error back to the sheet.
async function processForceDeliver(spreadsheetId) {
  console.log(`\n[ForceDeliver] Ops sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
  for (const { prefix, orgUrl } of getForceDeliverOrgRoutes()) {
    console.log(`[ForceDeliver] ${prefix}-* orders → ${orgUrl}`);
  }
  await ensureTabWithHeaders(spreadsheetId, TAB_NAME, HEADERS);
  await applyColumnDropdown(spreadsheetId, TAB_NAME, HEADERS, {
    column: 'Status',
    values: STATUS_DROPDOWN,
  });

  const values = await readTabValues(spreadsheetId, TAB_NAME);
  if (values.length <= 1) {
    console.log('[ForceDeliver] No queue rows — add an Order ID and choose Status "pending" from the dropdown.');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  const header = values[0];
  const col = name => header.indexOf(name);
  const orderCol = col('Order ID') !== -1 ? col('Order ID') : col('Order ID/CET#');
  const statusCol = col('Status');
  const atCol = col('Processed at');
  const infoCol = col('Info');
  const errCol = col('Error');
  if (orderCol === -1 || statusCol === -1) {
    throw new Error(`[ForceDeliver] Tab "${TAB_NAME}" is missing required columns. Expected: ${HEADERS.join(', ')}`);
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const now = () => new Date().toISOString();

  for (let r = 1; r < values.length; r++) {
    const row = values[r] ?? [];
    while (row.length < header.length) row.push('');

    const orderId = String(row[orderCol] ?? '').trim();
    if (!orderId) continue;

    const status = String(row[statusCol] ?? '').trim();
    if (!isPending(status)) continue;

    processed++;
    console.log(`[ForceDeliver] Processing ${orderId} (row ${r + 1})...`);

    try {
      const found = await findOrderForForceDeliver(orderId);
      if (!found) {
        row[statusCol] = 'error';
        row[atCol] = now();
        if (infoCol !== -1) row[infoCol] = '';
        if (errCol !== -1) row[errCol] = `Order not found: ${orderId}`;
        failed++;
        console.log(`[ForceDeliver]   Not found: ${orderId}`);
        continue;
      }

      const { order, orgUrl } = found;
      console.log(`[ForceDeliver]   Org: ${orgUrl}`);

      const state = String(order.order_state_id ?? '').toLowerCase();
      if (state === 'delivered' || state === 'archived') {
        row[statusCol] = 'done';
        row[atCol] = now();
        if (infoCol !== -1) row[infoCol] = `Already ${order.order_state_id}`;
        if (errCol !== -1) row[errCol] = '';
        succeeded++;
        console.log(`[ForceDeliver]   Already ${order.order_state_id}: ${order.full_id}`);
        continue;
      }

      await forceDeliverOrder(order, orgUrl);
      row[statusCol] = 'done';
      row[atCol] = now();
      if (infoCol !== -1) row[infoCol] = 'Marked delivered';
      if (errCol !== -1) row[errCol] = '';
      succeeded++;
      console.log(`[ForceDeliver]   Marked delivered: ${order.full_id}`);
    } catch (err) {
      row[statusCol] = 'error';
      row[atCol] = now();
      if (infoCol !== -1) row[infoCol] = '';
      if (errCol !== -1) row[errCol] = formatApiError(err);
      failed++;
      console.error(`[ForceDeliver]   Failed ${orderId}: ${row[errCol]}`);
    }

    values[r] = row;
  }

  await writeTabValues(spreadsheetId, TAB_NAME, values);
  console.log(`[ForceDeliver] Finished — processed ${processed}, succeeded ${succeeded}, failed ${failed}.`);
  return { processed, succeeded, failed };
}

module.exports = { processForceDeliver, TAB_NAME, HEADERS, STATUS_QUEUE, STATUS_DROPDOWN };
