require('dotenv').config();
const { findOrderForForceDeliver, forceCancelOrder, getForceDeliverOrgRoutes } = require('./roserocket');
const { ensureTabWithHeaders, readTabValues, writeTabValues, applyColumnDropdown } = require('./sheets');

const TAB_NAME = 'Force Cancel';
const HEADERS = ['Order ID', 'Status', 'Processed at', 'Info', 'Error'];
const STATUS_QUEUE = ['pending', 'retry'];
const STATUS_RESULTS = ['done', 'error'];
const STATUS_DROPDOWN = ['', ...STATUS_QUEUE, ...STATUS_RESULTS];
const PENDING = new Set(['', ...STATUS_QUEUE]);
// Already-terminal states: cancelling again would be a no-op, so the row is reported as done instead.
const ALREADY_CANCELLED = new Set(['cancelled', 'canceled']);

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

// A real order ID carries hyphens (CET-CEL1-10, CEL-VIL-45); a consolidated/manifest number does not
// (CELM21756, CETM27933). Used only to make the "not found" message more helpful.
function looksConsolidated(id) {
  return !String(id ?? '').includes('-');
}

// Reads the Force Cancel tab on the ops spreadsheet, cancels each queued order in RoseRocket, and writes
// Status / Processed at / Info / Error back.
//
// This exists because the RoseRocket UI cannot cancel a MULTI-STOP order — its cancel button fails with
// "cannot operate on stop via the multi-stop order API. Use the child_orders API". The platform cancel
// endpoint has no such restriction (RoseRocket documents it as cancelling "a single order or consolidated
// order"), so queueing the order here does what the screen refuses to. Those same orders are also missing
// from the order search endpoint entirely, which is why the lookup falls back to the Legs module.
//
// Cancelling is PERMANENT — treat this queue the same way as Force Delete Manifest.
async function processForceCancel(spreadsheetId) {
  console.log(`\n[ForceCancel] Ops sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
  for (const { prefix, orgUrl } of getForceDeliverOrgRoutes()) {
    console.log(`[ForceCancel] ${prefix}-* orders → ${orgUrl}`);
  }
  await ensureTabWithHeaders(spreadsheetId, TAB_NAME, HEADERS);
  await applyColumnDropdown(spreadsheetId, TAB_NAME, HEADERS, {
    column: 'Status',
    values: STATUS_DROPDOWN,
  });

  const values = await readTabValues(spreadsheetId, TAB_NAME);
  if (values.length <= 1) {
    console.log('[ForceCancel] No queue rows — add an Order ID and choose Status "pending" from the dropdown.');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  const header = values[0];
  const col = name => header.indexOf(name);
  const orderCol = col('Order ID');
  const statusCol = col('Status');
  const atCol = col('Processed at');
  const infoCol = col('Info');
  const errCol = col('Error');
  if (orderCol === -1 || statusCol === -1) {
    throw new Error(`[ForceCancel] Tab "${TAB_NAME}" is missing required columns. Expected: ${HEADERS.join(', ')}`);
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
    console.log(`[ForceCancel] Processing ${orderId} (row ${r + 1})...`);

    try {
      const found = await findOrderForForceDeliver(orderId);
      if (!found) {
        row[statusCol] = 'error';
        row[atCol] = now();
        if (infoCol !== -1) row[infoCol] = '';
        // A consolidated order's own number (e.g. CELM21756) is NOT searchable in RoseRocket — only its
        // stops are. Queueing it therefore looks like a typo, so say what to do instead: enter a stop's
        // Order ID and the cancel escalates to the consolidated parent on its own, taking every stop.
        if (errCol !== -1) row[errCol] = looksConsolidated(orderId)
          ? `Order not found: ${orderId}. A consolidated/manifest number is not searchable — enter one of its stop Order IDs instead (e.g. CET-CEL1-10); cancelling a stop cancels the whole consolidated order.`
          : `Order not found: ${orderId}`;
        failed++;
        console.log(`[ForceCancel]   Not found: ${orderId}`);
        continue;
      }

      const { order, orgUrl } = found;
      console.log(`[ForceCancel]   Org: ${orgUrl}`);

      const state = String(order.order_state_id ?? '').toLowerCase();
      if (ALREADY_CANCELLED.has(state)) {
        row[statusCol] = 'done';
        row[atCol] = now();
        if (infoCol !== -1) row[infoCol] = `Already ${order.order_state_id}`;
        if (errCol !== -1) row[errCol] = '';
        succeeded++;
        console.log(`[ForceCancel]   Already ${order.order_state_id}: ${order.full_id}`);
        continue;
      }

      const result = await forceCancelOrder(order, orgUrl);
      row[statusCol] = 'done';
      row[atCol] = now();
      if (infoCol !== -1) {
        // Say plainly when the cancel had to go through the consolidated parent: that cancels EVERY stop
        // on it, so the operator should not be surprised to find a sibling order cancelled too.
        const via = `consolidated order ${result.targetFullId} (this was stop ${result.sequence ?? '?'})`;
        row[infoCol] = result.consolidated
          ? result.alreadyCancelled
            ? `Already cancelled via ${via}`
            : `Cancelled via ${via} — ALL stops on it are cancelled`
          : `Cancelled (was ${order.order_state_id}${result.state ? `, now ${result.state}` : ''})`;
      }
      if (errCol !== -1) row[errCol] = '';
      succeeded++;
      console.log(
        `[ForceCancel]   Cancelled ${order.full_id}` +
          (result.consolidated ? ` via consolidated order ${result.targetFullId} (all stops)` : ''),
      );
    } catch (err) {
      row[statusCol] = 'error';
      row[atCol] = now();
      if (infoCol !== -1) row[infoCol] = '';
      if (errCol !== -1) row[errCol] = formatApiError(err);
      failed++;
      console.error(`[ForceCancel]   Failed ${orderId}: ${row[errCol]}`);
    }

    values[r] = row;
  }

  await writeTabValues(spreadsheetId, TAB_NAME, values);
  console.log(`[ForceCancel] Finished — processed ${processed}, succeeded ${succeeded}, failed ${failed}.`);
  return { processed, succeeded, failed };
}

module.exports = { processForceCancel, TAB_NAME, HEADERS, STATUS_QUEUE, STATUS_DROPDOWN };
