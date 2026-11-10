// Dispatcher-activity sheet: every order whose requested pick-up falls in the last 60 days, with who
// handled it — CSR, dispatcher, sales rep — and when and by whom it was first made. Rebuilt once a day
// by its own cron job (1:00 AM Pacific). The "data" tab is replaced wholesale, so nothing typed into it
// survives a run. Unlike the other sheets it carries no "Last synced" stamp — the client asked for none.
//
// Rows come from both orgs' order lists — CE Logistics and all of CE Trucking. Neither login can see the
// other org's orders, so each order's legs, manifest and commissionees are read with the login of the
// org it was listed under.
//
// Dispatcher and Sales Rep are exactly the Commission Sheet's "Dispatcher" and "On commission".
// "First made" is the order's own created_at / user_id: an order that starts life as a quick quote is
// created at that moment, as a draft, so these are the quote's date and author (CEL-STCF-208: 09/18,
// Matthew Pratt — what RoseRocket's Activity log shows). RoseRocket has no API for the Activity log.
//
//   node src/dispatcher-activity.js            rebuild the sheet
//   node src/dispatcher-activity.js --dry-run  build the rows and compare them with the sheet; write nothing
require('dotenv').config();
const axios = require('axios');
const { getToken } = require('./auth');
const {
  fetchOrdersForOrg,
  fetchOrderLegs,
  fetchOrderCommissionees,
  fetchMasterTrip,
  client,
  SYNC_ORG_URL,
  CELOGISTICS_ORG_URL,
} = require('./roserocket');
const {
  resolveCustomerName,
  resolveOnCommission,
  resolveDispatcher,
  finalDeliveryLeg,
} = require('./invoice-sent-report');
const { writeToSheetWithRetry, readTabValues, syncBanding } = require('./sheets');

const TAB = 'data';
const WINDOW_DAYS = 60;
// Orders are created before their pick-up, sometimes weeks before, so the list is read back further than
// the window and then filtered on the pick-up date.
const CREATED_LOOKBACK_DAYS = 150;
const CONCURRENCY = 6;
const API_BASE = process.env.ROSEROCKET_BASE_URL ?? 'https://network.roserocket.com'; // as roserocket.js
const TIMEZONE = process.env.REPORT_TIMEZONE || 'America/Toronto';

const COLUMNS = [
  { header: 'ID', getLabel: (r) => r.id, width: 120 },
  { header: 'Status', getLabel: (r) => r.status, width: 100 },
  { header: 'Customer Name', getLabel: (r) => r.customer, width: 220 },
  { header: 'Pick Up Requested', getLabel: (r) => r.pickup, width: 120 },
  { header: 'CSR', getLabel: (r) => r.csr, width: 140 },
  { header: 'Dispatcher', getLabel: (r) => r.dispatcher, width: 140 },
  { header: 'Sales Rep', getLabel: (r) => r.salesRep, width: 140 },
  { header: 'Order Created Date', getLabel: (r) => r.created, width: 130 },
  { header: 'Who Created the Order', getLabel: (r) => r.createdBy, width: 160 },
];

function sheetId() {
  const v = String(process.env.GOOGLE_DISPATCHER_ACTIVITY_SHEET_ID ?? '').trim();
  return v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] ?? v;
}

// "YYYY-MM-DD" of a timestamp in Eastern time, or '' when there is none — RoseRocket's own "no date"
// is 0001-01-01.
function easternDay(value) {
  const d = value instanceof Date ? value : new Date(value ?? '');
  if (!value || Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1971) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// The first and last Eastern day of the window, today included.
function windowDays(now = new Date()) {
  const [y, m, d] = easternDay(now).split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, d - (WINDOW_DAYS - 1))).toISOString().slice(0, 10);
  return { first, last: easternDay(now) };
}

// "2026-11-09" → "11/9/2026", the sheet's own date style; written USER_ENTERED it lands as a real date.
function usDate(day) {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

// The requested pick-up is stored as the pick-up location's local wall time with no zone
// ("2026-11-06T00:00:00"), so its date is taken as written — converting it shifts midnight pick-ups a
// day back. A value that does carry a zone is read in the location's own.
function pickupDay(order) {
  const raw = String(order.pickup_start_at ?? order.pickup_end_at ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || raw.startsWith('0001-')) return '';
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return raw.slice(0, 10);
  const d = new Date(raw);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: order.from_timezone || TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// Loads that never ran: the client's own list leaves out cancelled orders and quotes not yet booked.
const EXCLUDED_STATES = new Set(['cancelled', 'canceled', 'quoted', 'draft']);

// A user's name, read with a plain request: our API client treats a 403 as a dead token and logs in
// again, and a user who belongs to the other org answers 403. Tries the order's own org first.
async function userName(userId, orgUrl, cache) {
  if (!userId) return '';
  if (!cache.has(userId)) {
    cache.set(userId, (async () => {
      for (const org of [orgUrl, CELOGISTICS_ORG_URL, SYNC_ORG_URL].filter((o, i, a) => o && a.indexOf(o) === i)) {
        try {
          const token = await getToken(org);
          const res = await axios.get(`/api/v1/users/${userId}`, {
            baseURL: API_BASE,
            headers: { Authorization: `Bearer ${token}` },
            timeout: 20000,
          });
          const p = res.data?.data?.user?.profile ?? {};
          const name = [p.first_name, p.last_name].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
          if (name) return name;
        } catch {
          // try the next org
        }
      }
      return '';
    })());
  }
  return cache.get(userId);
}

// RoseRocket names carry stray runs of spaces ("Karen  Huizinga").
const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

async function buildRow({ order, orgUrl }, caches) {
  const api = await client(orgUrl);
  const [legs, commissionees, createdBy] = await Promise.all([
    fetchOrderLegs(api, order.id).catch(() => []),
    fetchOrderCommissionees(api, order.id).catch(() => []),
    userName(order.user_id, orgUrl, caches.users),
  ]);
  const finalLeg = finalDeliveryLeg(legs);
  const finalTrip = finalLeg?.master_trip_id ? await fetchMasterTrip(api, finalLeg.master_trip_id, caches.trips) : null;
  return {
    id: String(order.full_id ?? '').trim(),
    status: String(order.order_state_id ?? '').trim(),
    customer: tidy(resolveCustomerName(order)),
    pickup: usDate(pickupDay(order)),
    csr: tidy(order.csr_name),
    dispatcher: tidy(resolveDispatcher(order, finalTrip)),
    salesRep: resolveOnCommission(order, commissionees).split('\n').map(tidy).join('\n'),
    created: usDate(easternDay(order.created_at)),
    createdBy,
    sortKey: `${pickupDay(order)} ${order.created_at ?? ''}`,
  };
}

async function buildRows() {
  const { first, last } = windowDays();
  const inWindow = [];
  const seen = new Set();
  for (const orgUrl of [CELOGISTICS_ORG_URL, SYNC_ORG_URL].filter((o, i, a) => o && a.indexOf(o) === i)) {
    const orders = await fetchOrdersForOrg(orgUrl, { sinceDays: CREATED_LOOKBACK_DAYS });
    const kept = orders.filter((o) => {
      const day = pickupDay(o);
      return o.full_id && !seen.has(o.id) && day >= first && day <= last
        && !EXCLUDED_STATES.has(String(o.order_state_id ?? '').toLowerCase());
    });
    kept.forEach((o) => seen.add(o.id));
    inWindow.push(...kept.map((order) => ({ order, orgUrl })));
    console.log(`[DispatcherActivity] ${new URL(orgUrl).hostname.split('.')[0]}: ${kept.length} of ${orders.length} order(s) have a pick-up between ${first} and ${last}.`);
  }

  const caches = { trips: new Map(), users: new Map() };
  const rows = [];
  for (let i = 0; i < inWindow.length; i += CONCURRENCY) {
    const batch = inWindow.slice(i, i + CONCURRENCY);
    const built = await Promise.all(batch.map((entry) => buildRow(entry, caches).catch((err) => {
      console.warn(`[DispatcherActivity] Skipped ${entry.order.full_id}: ${err.message}`);
      return null;
    })));
    rows.push(...built.filter(Boolean));
    if ((i / CONCURRENCY) % 25 === 24 || i + CONCURRENCY >= inWindow.length) {
      console.log(`[DispatcherActivity] Built ${rows.length}/${inWindow.length} row(s).`);
    }
  }
  // Newest pick-up first, as the client's own list was.
  rows.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return rows;
}

// Dry run: how the built rows line up with what is on the sheet now. Statuses drift between runs, so
// only the ID set, customer and pick-up date are expected to match an earlier export.
async function compareWithSheet(id, rows) {
  const current = (await readTabValues(id, TAB)) ?? [];
  const theirs = new Map(current.slice(1).filter((r) => r[0]).map((r) => [String(r[0]).trim(), r]));
  const ours = new Map(rows.map((r) => [r.id, r]));
  const onlyTheirs = [...theirs.keys()].filter((k) => !ours.has(k));
  const onlyOurs = rows.filter((r) => !theirs.has(r.id));
  const mismatch = { status: [], customer: [], pickup: [] };
  for (const [k, t] of theirs) {
    const o = ours.get(k);
    if (!o) continue;
    if (String(t[1] ?? '') !== o.status) mismatch.status.push(`${k}: "${t[1]}" → "${o.status}"`);
    if (String(t[2] ?? '').trim() !== o.customer) mismatch.customer.push(`${k}: "${t[2]}" → "${o.customer}"`);
    if (String(t[3] ?? '') !== o.pickup) mismatch.pickup.push(`${k}: "${t[3]}" → "${o.pickup}"`);
  }
  const byStatus = (list) => Object.entries(list.reduce((m, s) => ((m[s] = (m[s] || 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', ');
  console.log(`[DryRun] sheet ${theirs.size} row(s), built ${rows.length}; in both ${theirs.size - onlyTheirs.length}`);
  console.log(`[DryRun] only on the sheet: ${onlyTheirs.length} — e.g. ${onlyTheirs.slice(0, 8).join(', ')}`);
  console.log(`[DryRun]   their status / pick-up: ${byStatus(onlyTheirs.map((k) => `${theirs.get(k)[1]}@${theirs.get(k)[3]}`)).slice(0, 400)}`);
  console.log(`[DryRun] only built: ${onlyOurs.length} — by status: ${byStatus(onlyOurs.map((r) => r.status))}`);
  console.log(`[DryRun]   e.g. ${onlyOurs.slice(0, 8).map((r) => `${r.id} ${r.status} ${r.pickup}`).join(' | ')}`);
  for (const [field, list] of Object.entries(mismatch)) {
    console.log(`[DryRun] ${field} differs on ${list.length}${list.length ? ' — e.g. ' + list.slice(0, 5).join(' ; ') : ''}`);
  }
  const blank = (f) => rows.filter((r) => !r[f]).length;
  console.log(`[DryRun] blank cells: CSR ${blank('csr')}, Dispatcher ${blank('dispatcher')}, Sales Rep ${blank('salesRep')}, Created ${blank('created')}, Who Created ${blank('createdBy')}`);
  for (const r of rows.filter((x) => ['CEL-STCF-208', 'CET-ROY2-6090'].includes(x.id)).concat(rows.slice(0, 3))) {
    console.log(`[DryRun] sample ${COLUMNS.map((c) => `${c.header}=${c.getLabel(r)}`).join(' | ')}`);
  }
}

async function runDispatcherActivity({ dryRun = false } = {}) {
  const id = sheetId();
  if (!id) throw new Error('GOOGLE_DISPATCHER_ACTIVITY_SHEET_ID not set');
  if (!CELOGISTICS_ORG_URL) throw new Error('ROSEROCKET_CELOGISTICS_ORG_URL not set');

  const rows = await buildRows();
  if (dryRun) {
    await compareWithSheet(id, rows);
    return rows;
  }
  await writeToSheetWithRetry(id, TAB, rows, { columns: COLUMNS });
  console.log(`[DispatcherActivity] Wrote ${rows.length} row(s) to "${TAB}".`);
  try {
    await syncBanding(id, {
      keepOwnColors: true,
      tabs: [{ tabName: TAB, rowCount: rows.length ? rows.length + 1 : 0, columnCount: COLUMNS.length, footer: false }],
    });
  } catch (err) {
    console.warn(`[DispatcherActivity] Could not apply row shading (${err.message}).`);
  }
  return rows;
}

module.exports = { runDispatcherActivity, buildRows, windowDays, usDate, easternDay, pickupDay };

if (require.main === module) {
  runDispatcherActivity({ dryRun: process.argv.includes('--dry-run') })
    .then(() => { console.log('Done'); process.exit(0); })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
