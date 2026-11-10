require('dotenv').config();
const {
  getTripHistorySheetId, collectCandidates, resolveManifest, manifestKey,
  updateTab, updateByDriverTab, updateCompareTab, TRIP_TABS, OUTBOUND_TAB, INBOUND_TAB, ROUNDER_TAB,
} = require('./trip-history');
const { fetchOrdersForOrg, fetchDriverTypes, client } = require('./roserocket');
const { readTabValues } = require('./sheets');

// One-off: put fuel into trips archived BEFORE fuel was part of trip revenue.
//
// Since 9 Nov 2026 a newly archived trip's O/B and I/B Revenue is freight + fuel, with the fuel in the
// hidden Fuel column. Trips archived before that kept the freight-only Revenue they were written with,
// and the client asked for all of October to be brought in line. For each such trip:
//
//   O/B, I/B  Revenue = the archived Revenue + the trip's fuel, Fuel = that fuel. OO Rev and RPM are
//             worked on Revenue − Fuel, so they stay exactly what they were — no paid figure moves.
//   Rounder   Revenue = RoseRocket's on-manifest revenue as it stands today (it already includes fuel;
//             the client keeps the Rounder on RoseRocket's figure) — but ONLY on trips that carry fuel.
//             RoseRocket's figure has moved since archiving on many fuel-free trips too (rates corrected,
//             charges added at invoicing), and the client chose to leave those as archived.
//
// A leg archived with $0 Revenue (its orders were missing at the time) takes today's freight instead of
// the archived 0, so the row doesn't end up showing fuel alone.
//
// Miles, Notes, Date and every other field are left alone. The trip and its orders are resolved by the
// same code that archives new trips, so the fuel is exactly what a new trip would carry.
//
//   npm run trip-history:fuel -- 2026-10-01           # dry run — lists every change, writes nothing
//   npm run trip-history:fuel -- 2026-10-01 --apply
//
// Pause the trip-history cron while applying: it rewrites the same tabs every 30 minutes.
const FUEL_LIVE_FROM = '2026-11-10'; // trips finishing from here on were archived with fuel already
const ORDER_LOOKBACK_DAYS = 45; // orders are created before the trip runs; read back this far before `from`

const round2 = (n) => Math.round(n * 100) / 100;
const serialToDay = (v) => {
  if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  return String(v ?? '').slice(0, 10);
};
const tripIdOf = (cell) => String(cell ?? '').match(/manifests\/([0-9a-f-]{36})/i)?.[1] ?? null;

// The archived rows to revise on one tab: Date in [from, FUEL_LIVE_FROM) and, on the leg tabs, no fuel yet.
async function targetRows(sheetId, tab, from) {
  const grid = await readTabValues(sheetId, `'${tab}'`, { valueRenderOption: 'FORMULA' });
  const hIdx = grid.findIndex((r) => Array.isArray(r) && r.includes('Manifest ID'));
  const h = grid[hIdx] ?? [];
  const col = (c) => h.indexOf(c);
  const rows = new Map();
  for (const r of grid.slice(hIdx + 1)) {
    const key = manifestKey(r[col('Manifest ID')]);
    const tripId = tripIdOf(r[col('Manifest ID')]);
    const day = serialToDay(r[col('Date')]);
    if (!key || !tripId || day < from || day >= FUEL_LIVE_FROM) continue;
    if (col('Fuel') >= 0 && String(r[col('Fuel')] ?? '').trim() !== '') continue;
    rows.set(key, { tripId, revenue: Number(r[col('Revenue')]) || 0, day });
  }
  return rows;
}

async function backfillTripFuel(sheetId, { from, apply = false }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error(`Unreadable start date: "${from}"`);
  const targets = {};
  for (const tab of [OUTBOUND_TAB, INBOUND_TAB, ROUNDER_TAB]) targets[tab] = await targetRows(sheetId, tab, from);
  const trips = new Map();
  for (const rows of Object.values(targets)) for (const [key, r] of rows) trips.set(r.tripId, key);
  console.log(`[TripFuel] ${trips.size} trip(s) archived between ${from} and ${FUEL_LIVE_FROM} without fuel.`);

  const sinceDays = Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86400000) + ORDER_LOOKBACK_DAYS;
  const orders = await fetchOrdersForOrg(undefined, { sinceDays });
  const ordersById = new Map(orders.map((o) => [o.id, o]));
  const candidates = await collectCandidates(orders, ordersById, Date.parse(`${from}T00:00:00Z`));
  const api = await client();
  const stopCache = new Map();

  const revisions = { [OUTBOUND_TAB]: new Map(), [INBOUND_TAB]: new Map(), [ROUNDER_TAB]: new Map() };
  const notFound = [];
  const freightMoved = [];
  let fuelTotal = 0;
  for (const [tripId, key] of trips) {
    const candidate = candidates.get(tripId);
    if (!candidate) { notFound.push(key); continue; }
    let m;
    try {
      m = await resolveManifest(api, tripId, candidate, ordersById, stopCache);
    } catch (err) {
      notFound.push(`${key} (${err.message})`);
      continue;
    }
    let hasFuel = false;
    for (const [tab, fuel, rev] of [[OUTBOUND_TAB, m.obFuel, m.obRev], [INBOUND_TAB, m.ibFuel, m.ibRev]]) {
      const row = targets[tab].get(key);
      if (!row || !(fuel > 0)) continue;
      hasFuel = true;
      const freight = row.revenue > 0 ? row.revenue : round2(rev - fuel);
      revisions[tab].set(key, { Revenue: round2(freight + fuel), Fuel: fuel });
      fuelTotal += fuel;
      if (!(row.revenue > 0)) freightMoved.push(`${key} ${tab}: archived $0 — today's freight ${freight} used`);
      // For the record only: today's freight differs from what was archived (a rate changed afterwards).
      else if (Math.abs((rev - fuel) - row.revenue) > 0.01) freightMoved.push(`${key} ${tab}: archived ${row.revenue}, today ${round2(rev - fuel)} (archived kept)`);
    }
    const rd = targets[ROUNDER_TAB].get(key);
    if (hasFuel && rd && Number.isFinite(m.rounderRev) && Math.abs(m.rounderRev - rd.revenue) > 0.005) {
      revisions[ROUNDER_TAB].set(key, { Revenue: m.rounderRev, _was: rd.revenue });
    }
  }

  for (const tab of [OUTBOUND_TAB, INBOUND_TAB, ROUNDER_TAB]) {
    const rev = revisions[tab];
    console.log(`[TripFuel] ${tab}: ${rev.size} of ${targets[tab].size} row(s) change.`);
    for (const [key, r] of [...rev].slice(0, 400)) {
      const was = tab === ROUNDER_TAB ? r._was : targets[tab].get(key).revenue;
      console.log(`[TripFuel]   ${tab} ${key}: Revenue ${was} → ${r.Revenue}${r.Fuel ? ` (fuel ${r.Fuel})` : ''}`);
    }
  }
  console.log(`[TripFuel] Fuel added to O/B + I/B: $${round2(fuelTotal)}.`);
  if (notFound.length) console.log(`[TripFuel] Not resolvable (left as is): ${notFound.length} — ${notFound.slice(0, 20).join(', ')}`);
  if (freightMoved.length) console.log(`[TripFuel] Freight differs from what was archived: ${freightMoved.length} — ${freightMoved.slice(0, 20).join(' ; ')}`);
  if (!apply) {
    console.log('[TripFuel] Dry run — nothing written. Pass --apply to write these changes.');
    return { revisions };
  }

  for (const rev of Object.values(revisions)) for (const r of rev.values()) delete r._was;
  const driverTypes = await fetchDriverTypes();
  const driverSets = [];
  for (const { tab, kind } of TRIP_TABS) {
    const res = await updateTab(sheetId, tab, kind, driverTypes, [], { revisionsByManifest: revisions[tab] });
    driverSets.push(res.drivers);
  }
  await updateByDriverTab(sheetId, driverTypes, driverSets);
  await updateCompareTab(sheetId, driverTypes, driverSets);
  console.log('[TripFuel] Done — changes written.');
  return { revisions };
}

if (require.main === module) {
  const sheetId = getTripHistorySheetId();
  if (!sheetId) {
    console.error('[TripFuel] GOOGLE_TRIP_HISTORY_SHEET_ID not set.');
    process.exit(1);
  }
  const from = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!from) {
    console.error('[TripFuel] Give the first trip date, e.g. npm run trip-history:fuel -- 2026-10-01');
    process.exit(1);
  }
  backfillTripFuel(sheetId, { from, apply: process.argv.includes('--apply') })
    .then(() => process.exit(0))
    .catch((err) => { console.error(`[TripFuel] Failed: ${err.message}`); process.exit(1); });
}

module.exports = { backfillTripFuel };
