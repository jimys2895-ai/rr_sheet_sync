require('dotenv').config();
const axios = require('axios');
const { getToken, invalidateToken } = require('./auth');

const BASE_URL           = process.env.ROSEROCKET_BASE_URL ?? 'https://network.roserocket.com';
const SYNC_ORG_URL       = (process.env.ROSEROCKET_ORG_URL ?? '').replace(/\/+$/, '');
// Force Deliver routes by order-ID prefix (CEL → logistics, CET → trucking).
const CELOGISTICS_ORG_URL = (
  process.env.ROSEROCKET_CELOGISTICS_ORG_URL ?? ''
).replace(/\/+$/, '');

const FORCE_DELIVER_ROUTES = [
  { prefix: 'CEL', orgUrl: CELOGISTICS_ORG_URL },
  { prefix: 'CET', orgUrl: SYNC_ORG_URL },
].filter(r => r.orgUrl);
// Customer-scoped order actions (mark_delivered) use the platform host, not network.
const PLATFORM_URL     = process.env.ROSEROCKET_PLATFORM_URL ?? 'https://platform.roserocket.com';
// Recent date window: pull orders created within the last N days. Default 30 (~1 month).
const SINCE_DAYS = parseInt(process.env.ROSEROCKET_SINCE_DAYS ?? '30', 10);
// Optional hard safety cap on rows fetched (0 = unlimited). The date window is the primary bound;
// this only guards against a runaway pull. Default 0 — set ROSEROCKET_MAX_ORDERS to re-enable.
const MAX_ORDERS = parseInt(process.env.ROSEROCKET_MAX_ORDERS ?? '0', 10);

// The Authorization header is resolved PER REQUEST, not baked in when the client is built.
//
// RoseRocket tokens live 30 minutes. Freezing one into the axios instance meant any job that outran that
// — the trip-history backfill, a slow commission sync — went on presenting a dead token for the rest of
// the run. Every call 401'd, and because callers here swallow errors (fetchMasterTripStops returns [],
// resolveOrdersForHistory returns null) the failures were invisible: the backfill archived 34 trips with
// no stops, so blank cities, blank revenue and no O/B or I/B row at all. Reading the token through
// getToken on each request means a refresh anywhere in the process is picked up immediately, and a 401
// forces a re-login and one retry rather than silently returning nothing.
async function client(orgUrl = SYNC_ORG_URL) {
  const instance = axios.create({
    baseURL: BASE_URL,
    headers: { 'Content-Type': 'application/json' },
  });
  instance.interceptors.request.use(async (config) => {
    config.headers.Authorization = `Bearer ${await getToken(orgUrl)}`;
    return config;
  });
  instance.interceptors.response.use(undefined, async (error) => {
    const status = error.response?.status;
    const config = error.config;
    if ((status === 401 || status === 403) && config && !config._rrRetriedAfterAuth) {
      config._rrRetriedAfterAuth = true;
      console.warn(`[Auth] ${status} from ${config.url} — refreshing token and retrying once.`);
      invalidateToken(orgUrl);
      return instance.request(config);
    }
    throw error;
  });
  return instance;
}

function toTime(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// Paginated GET. Stops early when:
//   - maxRecords is reached (0 = unlimited), or
//   - a row older than sinceMs is seen (requires results sorted newest-first by dateFn's field).
async function paginate(api, path, params = {}, extractFn, { maxRecords = 0, sinceMs = null, dateFn = null } = {}) {
  const records = [];
  const limit = 500;
  let offset = 0;
  let page = 1;
  let reachedOld = false;

  while (true) {
    const pageLimit = maxRecords > 0 ? Math.min(limit, maxRecords - records.length) : limit;
    const res  = await api.get(path, { params: { ...params, limit: pageLimit, offset } });
    const rows = extractFn(res.data);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      if (sinceMs !== null && dateFn) {
        const t = toTime(dateFn(row));
        if (t !== null && t < sinceMs) { reachedOld = true; break; }
      }
      records.push(row);
      if (maxRecords > 0 && records.length >= maxRecords) break;
    }

    const total = res.data?.data?.total ?? res.data?.total ?? null;
    const cap   = maxRecords > 0 ? `/${maxRecords} cap` : '';
    if (total !== null) {
      console.log(`[RoseRocket]   page ${page}: ${records.length}/${total}${cap}`);
    } else {
      console.log(`[RoseRocket]   page ${page}: +${rows.length}${cap}`);
    }

    if (reachedOld) {
      console.log(`[RoseRocket]   Reached date cutoff — stopping early.`);
      break;
    }
    if (maxRecords > 0 && records.length >= maxRecords) {
      console.log(`[RoseRocket]   Reached ${maxRecords}-record cap — stopping early.`);
      break;
    }
    if (rows.length < pageLimit) break;
    if (total !== null && offset + rows.length >= total) break;
    offset += rows.length;
    page++;
  }

  return records;
}

async function fetchOrdersForOrg(orgUrl = SYNC_ORG_URL, { sinceDays = SINCE_DAYS, maxRecords = MAX_ORDERS } = {}) {
  const api = await client(orgUrl);
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  console.log(`[RoseRocket] Fetching orders since ${new Date(sinceMs).toISOString()} (last ${sinceDays} day(s))...`);
  const records = await paginate(
    api,
    '/api/v1/orders',
    { sort: 'created_at desc' },
    d => d?.data?.orders ?? d?.orders ?? [],
    { maxRecords, sinceMs, dateFn: o => o.created_at }
  );
  const within = records.filter(o => {
    const t = toTime(o.created_at);
    return t === null || t >= sinceMs;
  });
  const seen = new Set();
  const deduped = within.filter(o => {
    const key = o.id ?? o.full_id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length < within.length) {
    console.log(`[RoseRocket] Removed ${within.length - deduped.length} duplicate order(s) from API pages.`);
  }
  console.log(`[RoseRocket] Orders fetched within window: ${deduped.length}`);
  return deduped;
}

async function fetchOrders() {
  return fetchOrdersForOrg(SYNC_ORG_URL);
}

// Normalizes a person's name for matching (lowercase, single-spaced) — RoseRocket stores driver names
// with stray double spaces, so the manifest name and the user record won't compare equal without this.
function normalizePersonKey(name) {
  return String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Maps each driver's normalized "First Last" name to their RoseRocket driver type
// ("owner-operator" | "company-driver"). The trip-history sheet uses it to flag owner-operators. Drivers
// live among the org's users (role Driver, with a profile_driver_type), so this walks the users list.
// A driver can hold MORE THAN ONE user record — typically an old company-driver account left inactive
// beside their current owner-operator one. Keying by name and letting the last record win therefore let a
// dead profile mask the live one: Robert Bronowicki showed as CD on the trip-history sheet because his
// inactive company-driver record happened to come after his active owner-operator one. Collect every
// record per name and pick the ACTIVE, undeleted one; fall back to whatever exists if none is active, so
// a driver whose records are all inactive still reports a type.
const isLiveUserRecord = (u) =>
  String(u?.user_status_id ?? '').toLowerCase() === 'active' && !u?.deleted_at;

async function fetchDriverTypes(orgUrl = SYNC_ORG_URL) {
  const api = await client(orgUrl);
  const byName = new Map();
  const limit = 100;
  for (let offset = 0; offset < 5000; offset += limit) {
    let rows;
    try {
      const res = await api.get('/api/v1/users', { params: { limit, offset } });
      rows = res.data?.data?.users ?? res.data?.data ?? [];
    } catch {
      break;
    }
    if (!rows.length) break;
    for (const u of rows) {
      if (!u.profile_driver_type) continue;
      const key = normalizePersonKey(`${u.profile_first_name ?? ''} ${u.profile_last_name ?? ''}`);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(u);
    }
    if (rows.length < limit) break;
  }

  const map = new Map();
  let duplicates = 0;
  for (const [key, users] of byName) {
    const live = users.filter(isLiveUserRecord);
    if (users.length > 1) duplicates++;
    map.set(key, (live[0] ?? users[users.length - 1]).profile_driver_type);
  }
  console.log(
    `[RoseRocket] Driver types: ${map.size} drivers` +
      (duplicates ? ` (${duplicates} with more than one profile — active one used).` : '.'),
  );
  return map;
}

async function fetchOrdersByState(orgUrl, stateId, { sinceDays } = {}) {
  // RoseRocket's list API accepts order_state_id but does not filter results — apply client-side.
  const orders = await fetchOrdersForOrg(orgUrl, { sinceDays });
  const filtered = orders.filter(o => String(o.order_state_id) === stateId);
  console.log(`[RoseRocket] ${stateId}: ${filtered.length} of ${orders.length} orders in window`);
  return filtered;
}

// --- US Outbound / Inbound ---------------------------------------------------
// Outbound: destination USA. Inbound: USA → Canada specifically (an order that both starts in the US
// AND ends in Canada), so a domestic US→US move never lands on the inbound sheet. Both are restricted
// to status "Booked" or "In-Transit". RoseRocket's UI labels the internal `dispatched` state "Booked".
const US_COUNTRIES = new Set(['US', 'USA', 'United States']);
const CA_COUNTRIES = new Set(['CA', 'CAN', 'Canada']);
const US_ACTIVE_STATES = new Set(['dispatched', 'in-transit']);

// Derives the US Outbound subset from already-fetched orders (destination USA + Booked/In-Transit).
function filterUSOutbound(orders) {
  const subset = orders.filter(o => US_COUNTRIES.has(o.to_country) && US_ACTIVE_STATES.has(o.order_state_id));
  console.log(`[RoseRocket] US Outbound (to USA + Booked/In-Transit): ${subset.length} of ${orders.length} orders`);
  return subset;
}

// Derives the US Inbound subset — orders travelling USA → Canada, Booked/In-Transit.
function filterUSInbound(orders) {
  const subset = orders.filter(o =>
    US_COUNTRIES.has(o.from_country)
    && CA_COUNTRIES.has(o.to_country)
    && US_ACTIVE_STATES.has(o.order_state_id));
  console.log(`[RoseRocket] US Inbound (USA → Canada + Booked/In-Transit): ${subset.length} of ${orders.length} orders`);
  return subset;
}

// Outbound sheet: once an order's DELIVERY leg reaches one of these RoseRocket leg statuses, the
// freight is loaded for (or has completed) final delivery, so it drops off the sheet even though the
// order is still "In Transit". "loaded_terminal" is the "LDT" badge; "delivered_destination" means
// delivered.
const HIDE_DELIVERY_LEG_LABELS = new Set(['loaded_terminal', 'delivered_destination']);
// Inbound sheet: the mirror of LDT. Once the PICKUP leg is unloaded at the terminal — the "UT" badge
// (status_v2 "unloaded", status_v2_label "unloaded_terminal") — the inbound haul is complete and the
// order drops off the inbound sheet.
const HIDE_PICKUP_LEG_LABELS = new Set(['unloaded_terminal']);
// A direct full-load run never passes through the terminal: one `pickup_delivery` leg carries the freight
// from the US shipper straight to the Canadian consignee, so it finishes at "delivered_destination" and
// never reads "unloaded_terminal". Those trips are complete all the same, so the trip-history archive
// counts this label too (opt-in via allowDirectDelivery). The LIVE inbound sheet deliberately does NOT —
// it keeps the terminal-only rule it has always used, so nothing about which orders it shows changes.
const DIRECT_DELIVERY_LEG_LABELS = new Set(['delivered_destination']);
const LEG_FETCH_CONCURRENCY = parseInt(process.env.ROSEROCKET_LEG_FETCH_CONCURRENCY ?? '12', 10);

// Whether an order should drop off its sheet because its relevant leg is complete. Outbound keys off
// the final DELIVERY leg reaching LDT/delivered. Inbound keys off the FIRST pickup leg (lowest
// sequential_id) reaching UT: that leg is the US cross-border collection, and once it is unloaded at
// the terminal the inbound haul is done — even when the order carries extra later legs (a second
// pickup/delivery for an onward domestic move) that are still pending. Checking the LAST pickup leg
// missed exactly those multi-leg orders, leaving them stuck on the inbound sheet.
function orderLegComplete(legs, manifestSide = 'delivery', { allowDirectDelivery = false } = {}) {
  if (manifestSide === 'pickup') {
    const firstPickup = (legs ?? [])
      .filter((l) => String(l.trip_type_id ?? '').includes('pickup'))
      .sort((a, b) => (a.sequential_id || 0) - (b.sequential_id || 0))[0];
    if (!firstPickup) return false;
    if (HIDE_PICKUP_LEG_LABELS.has(firstPickup.status_v2_label)) return true;
    return allowDirectDelivery && DIRECT_DELIVERY_LEG_LABELS.has(firstPickup.status_v2_label);
  }
  const finalDelivery = (legs ?? [])
    .filter((l) => l.trip_type_id === 'delivery')
    .sort((a, b) => (b.sequential_id || 0) - (a.sequential_id || 0))[0];
  return !!finalDelivery && HIDE_DELIVERY_LEG_LABELS.has(finalDelivery.status_v2_label);
}

async function fetchOrderLegs(api, orderId) {
  const res = await api.get(`/api/v1/orders/${orderId}/legs`);
  return res.data?.data?.legs ?? res.data?.legs ?? res.data?.data ?? [];
}

async function fetchOrderQuotes(api, orderId) {
  const res = await api.get(`/api/v1/orders/${orderId}/quotes`);
  return res.data?.data?.quotes ?? res.data?.quotes ?? [];
}

async function fetchOrderCommissionees(api, orderId) {
  const res = await api.get(`/api/v1/orders/${orderId}/commissionees`);
  return res.data?.data ?? [];
}

async function fetchMasterTrip(api, tripId, cache = new Map()) {
  if (!tripId) return null;
  if (cache.has(tripId)) return cache.get(tripId);
  try {
    const res = await api.get(`/api/v1/master_trips/${tripId}`);
    const trip = res.data?.data?.master_trip ?? res.data?.data ?? null;
    cache.set(tripId, trip);
    return trip;
  } catch {
    cache.set(tripId, null);
    return null;
  }
}

function primaryQuote(quotes) {
  if (!quotes?.length) return null;
  return quotes.find(q => q.quote_status_id === 'dispatch-success') ?? quotes[0];
}

// Freight line-haul only — excludes fuel, accessorials (waiting time, tailgate, etc.).
function freightRateFromQuote(quote) {
  if (!quote) return null;
  const direct = Number(quote.freight_cost);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct * 100) / 100;
  const total = (quote.quote_items ?? [])
    .filter(i => String(i?.quote_item_type_id ?? '').toLowerCase().startsWith('freight'))
    .reduce((sum, i) => sum + (Number(i.total_amount) || 0), 0);
  return total > 0 ? Math.round(total * 100) / 100 : null;
}

function quoteCurrency(quote, order) {
  return String(
    quote?.cost_currency_id
    ?? order?.dispatched_quote_cost_currency_id
    ?? order?.total_value_currency_id
    ?? 'cad',
  ).toLowerCase();
}

function cadFxRateFromQuote(quote) {
  const total = Number(quote?.total_cost ?? 0);
  const fx = Number(quote?.fx_total_cost ?? 0);
  if (total > 0 && fx > 0 && total !== fx) return fx / total;
  return null;
}

// The outbound/inbound sheet Rate is always shown in CAD.
function freightRateCadFromQuote(quote, order) {
  const freight = freightRateFromQuote(quote);
  if (freight == null) return null;
  const currency = quoteCurrency(quote, order);
  if (currency === 'cad') return freight;
  const fxRate = cadFxRateFromQuote(quote)
    ?? (() => {
      const n = parseFloat(process.env.USD_TO_CAD_RATE ?? '');
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
  if (!fxRate) return null;
  return Math.round(freight * fxRate * 100) / 100;
}

// The outbound/inbound sheet's manifest is the line-haul one — the manifest on the DELIVERY (D) leg.
// A pickup leg's manifest is the local driver doing the pickup, so it is deliberately ignored:
// an order with no delivery-leg manifest resolves to none rather than falling back to the local run.
function pickManifestTripId(legs) {
  const delivery = (legs ?? [])
    .filter(l => l?.master_trip_id && l.trip_type_id === 'delivery')
    .sort((a, b) => (b.sequential_id || 0) - (a.sequential_id || 0))[0];
  return delivery?.master_trip_id ?? null;
}

// The INBOUND line-haul rides the PICKUP legs: the truck collects at several US stops and runs the
// freight to Canada, where a separate local manifest does the final delivery. Resolving the manifest
// from the delivery leg (as outbound does) therefore lands on that Canadian final-mile manifest — which
// carries no nickname or trigger tag — so the planners' tagged line-haul was invisible. Take the FIRST
// pickup leg's manifest instead. `pickup_delivery` legs count as pickups too.
function pickManifestTripIdForPickup(legs) {
  const pickup = (legs ?? [])
    .filter(l => l?.master_trip_id && String(l.trip_type_id ?? '').includes('pickup'))
    .sort((a, b) => (a.sequential_id || 0) - (b.sequential_id || 0))[0];
  return pickup?.master_trip_id ?? null;
}

// Direction-aware manifest resolution: 'delivery' (outbound) or 'pickup' (inbound).
function pickManifestTripIdFor(legs, manifestSide = 'delivery') {
  return manifestSide === 'pickup'
    ? pickManifestTripIdForPickup(legs)
    : pickManifestTripId(legs);
}

function manifestLabelFromTrip(trip) {
  if (!trip) return '';
  return String(trip.nickname ?? trip.message ?? '').trim();
}

// The manifest's driver. Prefer the master trip's own driver_user_name; fall back to the primary
// manifest assignee, then the partner carrier name for a brokered (no in-house driver) manifest.
// RoseRocket occasionally stores names with doubled spaces, so collapse whitespace.
function driverNameFromTrip(trip) {
  if (!trip) return '';
  const direct = String(trip.driver_user_name ?? '').replace(/\s+/g, ' ').trim();
  if (direct) return direct;
  const assignees = Array.isArray(trip.manifest_assignees) ? trip.manifest_assignees : [];
  const primary = assignees.find((a) => a?.is_primary) ?? assignees[0];
  const assigneeName = String(primary?.full_name ?? '').replace(/\s+/g, ' ').trim();
  if (assigneeName) return assigneeName;
  return String(trip.partner_carrier_name ?? '').trim();
}

function pickLegByType(legs, tripType) {
  const matches = (legs ?? []).filter(l => l.trip_type_id === tripType);
  if (!matches.length) return null;
  if (tripType === 'delivery') {
    return matches.sort((a, b) => (b.sequential_id || 0) - (a.sequential_id || 0))[0];
  }
  return matches.sort((a, b) => (a.sequential_id || 0) - (b.sequential_id || 0))[0];
}

function formatRequestedDate(raw, timeZone = 'America/Toronto') {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function schedulingFromLegs(legs, order) {
  const pickupLeg = pickLegByType(legs, 'pickup');
  const deliveryLeg = pickManifestDeliveryLeg(legs, pickManifestTripId(legs));
  const pickupAt = pickupLeg?.from_start_at ?? order.pickup_start_at ?? pickupLeg?.from_end_at ?? order.pickup_end_at;
  const deliveryAt = deliveryLeg?.to_start_at ?? deliveryLeg?.to_end_at ?? order.delivery_start_at ?? order.delivery_end_at;
  return {
    pickupRequested: formatRequestedDate(
      pickupAt,
      pickupLeg?.from_timezone ?? order.from_timezone,
    ),
    deliveryRequested: formatRequestedDate(
      deliveryAt,
      deliveryLeg?.to_timezone ?? order.to_timezone,
    ),
    // Sort keys for orders with no manifest: outbound orders by delivery, inbound by pickup, so each
    // sheet runs in the same direction as the City/State/Zip it shows.
    deliverySortMs: toTime(deliveryAt),
    pickupSortMs: toTime(pickupAt),
  };
}

const METERS_PER_MILE = 1609.344;

function manifestMilesFromTrip(trip) {
  const miles = Number(trip?.estimated_miles);
  if (Number.isFinite(miles) && miles > 0) return Math.round(miles * 10) / 10;
  const meters = Number(trip?.estimated_distance);
  if (Number.isFinite(meters) && meters > 0) return Math.round((meters / METERS_PER_MILE) * 10) / 10;
  return null;
}

// A manifest stop's role. The start/return yard stops are marked type_id='terminal' (they hold the
// load/unload tasks for the whole run and every task shares one location type, so they can't be told
// apart by location alone) — those are skipped. For a real customer stop RoseRocket tags each task with
// leg_location_type: 'origin' = a pickup, 'destination' = a delivery. task_type_id is not reliably
// present in the stops response, so leg_location_type is the signal used.
//
// 'exchange' is a customer stop holding BOTH — the truck drops its outbound load and reloads at the same
// address, the client's "picks up at the same location, delivers back there". RoseRocket sometimes files
// that as two stops (…D-Huntley, P-Huntley…) and sometimes merges it into ONE stop with a destination
// task and an origin task. The merged form used to fall through to 'terminal', which hid the entire US
// turnaround: the trip showed no US delivery at all, so it had no outbound leg and only half its miles.
// Naming the role keeps both filings equivalent — an exchange stop IS the turn.
function manifestStopRole(stop) {
  if (String(stop?.type_id ?? '').toLowerCase() === 'terminal') return 'terminal';
  const locs = [
    ...new Set(
      (stop?.tasks ?? [])
        .map((t) => String(t?.leg_location_type ?? '').toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (locs.length === 1 && locs[0] === 'origin') return 'pickup';
  if (locs.length === 1 && locs[0] === 'destination') return 'delivery';
  if (locs.includes('origin') && locs.includes('destination')) return 'exchange';
  return 'terminal';
}

// An exchange stop counts as both ends: it closes the outbound run and opens the inbound one.
const isDeliverySideStop = (stop) => ['delivery', 'exchange'].includes(manifestStopRole(stop));
const isPickupSideStop = (stop) => ['pickup', 'exchange'].includes(manifestStopRole(stop));

function orderedStops(stops) {
  return [...(stops ?? [])]
    .filter((s) => Number.isFinite(Number(s?.ordinal)))
    .sort((a, b) => a.ordinal - b.ordinal);
}

// THE TURN: the stop where the truck finishes its outbound freight and goes empty, i.e. where the
// outbound leg ends and the inbound leg begins. Everything at or before it belongs to the outbound run;
// everything after it belongs to the inbound run. It is the LAST US DELIVERY BEFORE THE LAST PICKUP.
//
// Two details, each forced by a real manifest shape:
//
// "before the LAST pickup" rather than before the FIRST pickup (the original rule), because:
//   - The full-load round trip (no terminal at all): P(Woodstock ON) D(Huntley IL) P(Huntley IL)
//     D(Woodstock ON). The run OPENS with a pickup, so no delivery precedes it, the turn collapsed to the
//     last delivery of the whole trip, and the outbound and inbound segments each claimed the ENTIRE
//     manifest — both tabs showed the full mileage and half the true RPM.
//   - A yard run with a delivery interleaved among the pickups (T D D D P P D P P P T): the truck is not
//     empty until that interleaved delivery is made, so the turn belongs there, not before the pickups.
// Anchoring on the LAST pickup keeps the original guard intact: a stray delivery tacked on AFTER the
// return (…P T D) still sits past the last pickup and is correctly ignored.
//
// "US delivery", because a delivery back in CANADA is the END of the inbound haul, not the end of the
// outbound one. Without that, a one-way US→CA move (P Saint Paul MN → D Mississauga ON) turned its whole
// 910 miles into an OUTBOUND leg — the exact opposite of the direction it ran. A manifest with no US
// delivery has no outbound leg at all, so this returns null and the whole run counts as inbound.
//
// On the ordinary yard shape — every (US) delivery before every pickup — all of this picks the same stop
// the original rule did, so nothing about those manifests changes.
function isUsStop(stop) {
  return US_COUNTRIES.has(String(stop?.country ?? '').trim());
}

function manifestTurnOrdinal(stops) {
  const ordered = orderedStops(stops);
  const usDeliveryOrds = ordered
    .filter((s) => isDeliverySideStop(s) && isUsStop(s))
    .map((s) => s.ordinal);
  if (!usDeliveryOrds.length) return null;
  const pickupOrds = ordered
    .filter(isPickupSideStop)
    .map((s) => s.ordinal);
  const lastPickup = pickupOrds.length ? Math.max(...pickupOrds) : Infinity;
  // An exchange stop is its own turn, so a turn candidate that IS the last pickup still qualifies.
  const deliveriesBefore = usDeliveryOrds.filter((o) => o <= lastPickup);
  return deliveriesBefore.length ? Math.max(...deliveriesBefore) : Math.max(...usDeliveryOrds);
}

// Inbound-leg mileage: the distance driven collecting inbound freight and hauling it home, not the whole
// manifest. The meter starts at the turn (see manifestTurnOrdinal), runs through every pickup, and ENDS
// at our facility — the return terminal where the freight is unloaded in Guelph. So it includes the final
// pickup → terminal return leg (client's revised decision). A pure-inbound manifest has no delivery/empty
// point, so it starts at the FIRST pickup instead. Each stop carries next_distance (metres to the
// following stop), so the segment is the sum of next_distance from the start stop up to — but not
// including — the ending facility stop. The facility is the last terminal stop at or after the last
// pickup (the return yard), falling back to the last stop overall. Returns null when the manifest has no
// pickups after the turn (a one-way delivery run has no inbound leg) or no usable distances, so the
// caller can fall back to the full-manifest miles.
function inboundManifestMiles(stops) {
  const ordered = orderedStops(stops);
  const pickupOrds = ordered
    .filter(isPickupSideStop)
    .map((s) => s.ordinal);
  if (!pickupOrds.length) return null;
  const turn = manifestTurnOrdinal(stops);
  const start = turn ?? Math.min(...pickupOrds);
  const lastPickup = Math.max(...pickupOrds);
  // End at our facility: the return terminal reached after the last pickup, else the final stop.
  const terminalAfter = ordered
    .filter((s) => s.ordinal >= lastPickup && manifestStopRole(s) === 'terminal')
    .map((s) => s.ordinal);
  const end = terminalAfter.length
    ? Math.min(...terminalAfter)
    : Math.max(...ordered.map((s) => s.ordinal));
  let meters = 0;
  for (const s of ordered) {
    if (s.ordinal < start || s.ordinal >= end) continue;
    const d = Number(s.next_distance);
    if (Number.isFinite(d) && d > 0) meters += d;
  }
  if (meters <= 0) return null;
  return Math.round((meters / METERS_PER_MILE) * 10) / 10;
}

// Outbound-leg mileage: the delivery run, from the first stop out to the turn (where the truck goes
// empty). Together with inboundManifestMiles it splits the whole manifest — outbound miles + inbound
// miles = the full round trip. Sums next_distance from the first stop up to (not including) the turn.
// Null when the manifest has no deliveries (a pure-inbound run has no outbound leg).
function outboundManifestMiles(stops) {
  const turn = manifestTurnOrdinal(stops);
  if (turn == null) return null;
  let meters = 0;
  for (const s of orderedStops(stops)) {
    if (s.ordinal >= turn) continue;
    const d = Number(s.next_distance);
    if (Number.isFinite(d) && d > 0) meters += d;
  }
  if (meters <= 0) return null;
  return Math.round((meters / METERS_PER_MILE) * 10) / 10;
}

// When the truck's inbound haul unloaded at the terminal — the trip-finish date. It's the first pickup
// leg's delivered_at (that leg is the US collection that ends at the terminal), falling back to its
// terminal-arrival time. Drives the "Completed" week on the trip-history archive.
function inboundUnloadedAt(legs) {
  const firstPickup = (legs ?? [])
    .filter((l) => String(l.trip_type_id ?? '').includes('pickup'))
    .sort((a, b) => (a.sequential_id || 0) - (b.sequential_id || 0))[0];
  return firstPickup?.delivered_at ?? firstPickup?.to_arrive_at ?? null;
}

function milesFromLegs(legs) {
  if (!legs?.length) return null;
  let total = 0;
  for (const leg of legs) {
    const d = Number(leg?.distance);
    if (Number.isFinite(d) && d > 0) total += d;
  }
  if (total > 0) return Math.round(total * 10) / 10;
  return null;
}

function pickManifestDeliveryLeg(legs, tripId) {
  const onManifest = (legs ?? []).filter(l =>
    l.trip_type_id === 'delivery' && (!tripId || l.master_trip_id === tripId),
  );
  if (onManifest.length) {
    return onManifest.sort((a, b) => (b.sequential_id || 0) - (a.sequential_id || 0))[0];
  }
  return pickLegByType(legs, 'delivery');
}

// Fetches a manifest's stops once and caches the raw array, so a single call serves both the stop
// ordinals (row ordering) and the inbound-mileage segment (which needs each stop's next_distance/role).
async function fetchMasterTripStops(api, tripId, cache = new Map()) {
  if (!tripId) return [];
  if (cache.has(tripId)) return cache.get(tripId);
  try {
    const res = await api.get(`/api/v1/master_trips/${tripId}/stops`);
    const stops = res.data?.data?.stops ?? [];
    cache.set(tripId, stops);
    return stops;
  } catch {
    cache.set(tripId, []);
    return [];
  }
}

// Position of each stop along the run, as a RANK rather than the raw ordinal.
//
// RoseRocket hands out DUPLICATE ordinals: a stop added to a live manifest keeps the number of the stop
// it follows until the run is re-sequenced. CETM27996 carried both Aurora and Bedford Park at ordinal 13,
// and comparing ordinals alone made "the last pickup" a coin toss — it fell to alphabetical order and
// picked Aurora, when Bedford Park is plainly last (its next hop is the 482-mile run home to Guelph;
// Aurora's is 31 miles to Bedford Park, and it is scheduled five hours earlier).
//
// Ranking the stops in route order breaks that tie by scheduled arrival, so the sequence reflects the
// order the truck actually reaches them. Callers only ever compare these values, never read them as stop
// numbers, so a dense rank is a drop-in for the ordinal — and it fixes row ordering on the lane tabs at
// the same time, which had the same coin toss.
function stopOrdinalsFromStops(stops) {
  const scheduledAt = (s) =>
    Date.parse(s?.schedule_start_at ?? s?.created_at ?? '') || 0;
  const ordered = [...(stops ?? [])].sort((a, b) => {
    const byOrdinal = (Number(a?.ordinal) || 0) - (Number(b?.ordinal) || 0);
    return byOrdinal !== 0 ? byOrdinal : scheduledAt(a) - scheduledAt(b);
  });
  return new Map(ordered.map((s, rank) => [s.id, rank]));
}

async function fetchMasterTripStopOrdinals(api, tripId, cache = new Map()) {
  return stopOrdinalsFromStops(await fetchMasterTripStops(api, tripId, cache));
}

function deliverySequenceForOrder(legs, tripId, stopOrdinals) {
  const delivery = pickManifestDeliveryLeg(legs, tripId);
  if (!delivery?.to_stop_id) return null;
  const ord = stopOrdinals.get(delivery.to_stop_id);
  return Number.isFinite(ord) ? ord : null;
}

// Mirror of pickManifestDeliveryLeg for the PICKUP side — the earliest pickup leg riding this manifest.
// The inbound sheet is ordered by where the truck COLLECTS (US origins), not where it drops in Canada.
function pickManifestPickupLeg(legs, tripId) {
  const onManifest = (legs ?? []).filter(l =>
    String(l.trip_type_id ?? '').includes('pickup') && (!tripId || l.master_trip_id === tripId),
  );
  if (onManifest.length) {
    return onManifest.sort((a, b) => (a.sequential_id || 0) - (b.sequential_id || 0))[0];
  }
  return pickLegByType(legs, 'pickup');
}

// The ordinal of this order's PICKUP stop on the manifest (its position in the collection run).
function pickupSequenceForOrder(legs, tripId, stopOrdinals) {
  const pickup = pickManifestPickupLeg(legs, tripId);
  if (!pickup?.from_stop_id) return null;
  const ord = stopOrdinals.get(pickup.from_stop_id);
  return Number.isFinite(ord) ? ord : null;
}

function orderManifestContextFromLegs(
  legs,
  trip,
  tags = [],
  deliverySequence = null,
  pickupSequence = null,
  milesOverride = null,
) {
  const tripInfo = trip ? manifestInfoFromTrip(trip, tags) : null;
  const legMiles = milesFromLegs(legs);
  // milesOverride carries the inbound-leg miles for the inbound sheet (last delivery → last pickup).
  // It falls back to the full-manifest miles when the segment can't be computed (stops missing, etc.).
  const estimatedMiles = milesOverride ?? tripInfo?.estimatedMiles ?? legMiles ?? null;
  return {
    nickname: tripInfo?.nickname ?? '',
    fullId: tripInfo?.fullId ?? '',
    tripId: tripInfo?.tripId ?? '',
    driver: tripInfo?.driver ?? '',
    // Manifest lifecycle: planning → assigned → moving → completed → bill-approved. ("dispatched" exists
    // in the API but this org never uses it.) The inbound master tab drops un-nicknamed manifests once
    // they reach "moving".
    status: String(trip?.master_trip_status_id ?? trip?.derived_status ?? '').toLowerCase(),
    tags: tripInfo?.tags ?? (Array.isArray(tags) ? tags : []),
    estimatedMiles,
    // "Rounder" = the whole round-trip manifest, shown alongside the inbound-leg figures on the inbound
    // Summary. rounderMiles is the full manifest miles; rounderRate (the whole-trip revenue) is filled in
    // after the fact for inbound — it needs every order on the manifest, not just this one (see
    // attachRounderRevenue). CAD.
    rounderMiles: tripInfo?.estimatedMiles ?? null,
    rounderRate: null,
    // Outbound orders by the manifest's delivery stops; inbound by its pickup stops (see sortSheetOrders).
    deliverySequence,
    pickupSequence,
  };
}

// Whole-trip ("rounder") revenue per manifest: the sum of every leg's revenue for legs riding that
// manifest, across ALL its orders — outbound deliveries and inbound pickups alike. RoseRocket does not
// expose a manifest-level revenue total, and the order-level totals over-count orders that span more
// than one manifest, so this walks the manifest's own legs. It is a best-effort figure and will not tie
// exactly to the manifest screen's Total Revenue (RoseRocket allocates by weight). The manifest's orders
// come from its stop tasks; legs are fetched once per order and cached.
async function rounderRevenueByTrip(api, tripIds, stopCache = new Map()) {
  const byTrip = new Map();
  const legCache = new Map();
  const getLegs = async (orderId) => {
    if (legCache.has(orderId)) return legCache.get(orderId);
    const legs = await fetchOrderLegs(api, orderId).catch(() => []);
    legCache.set(orderId, legs);
    return legs;
  };
  for (const tripId of tripIds) {
    if (!tripId) continue;
    const stops = await fetchMasterTripStops(api, tripId, stopCache);
    const orderIds = [
      ...new Set(
        stops.flatMap((s) => (s.tasks ?? []).map((t) => t.order_id).filter(Boolean)),
      ),
    ];
    let revenue = 0;
    for (let i = 0; i < orderIds.length; i += LEG_FETCH_CONCURRENCY) {
      const batch = await Promise.all(
        orderIds.slice(i, i + LEG_FETCH_CONCURRENCY).map(getLegs),
      );
      for (const legs of batch) {
        for (const l of legs) {
          if (l.master_trip_id !== tripId) continue;
          revenue += Number(l.actual_revenue ?? 0) || Number(l.estimated_revenue ?? 0);
        }
      }
    }
    byTrip.set(tripId, Math.round(revenue * 100) / 100);
  }
  return byTrip;
}

async function fetchMasterTripTags(api, tripId, cache = new Map()) {
  if (!tripId) return [];
  if (cache.has(tripId)) return cache.get(tripId);
  try {
    const res = await api.get(`/api/v1/master_trips/${tripId}/tags`);
    const tags = res.data?.data ?? res.data ?? [];
    cache.set(tripId, tags);
    return tags;
  } catch {
    cache.set(tripId, []);
    return [];
  }
}

// Looks up an org tag's UUID by its display name (e.g. "US I/B"). Resolving by name keeps the
// auto-tag logic in step with the same trigger-tag names the sheets use, instead of hard-coding a
// per-org UUID. The org's tag list is small and rarely changes, so it's fetched once and cached.
async function resolveTagIdByName(api, name, cache = {}) {
  const key = String(name ?? '').trim();
  if (!key) return null;
  if (cache.tags === undefined) {
    try {
      const res = await api.get('/api/v1/tags', { params: { limit: 300 } });
      cache.tags = res.data?.data?.tags ?? res.data?.tags ?? res.data?.data ?? [];
    } catch {
      cache.tags = [];
    }
  }
  const hit = (cache.tags ?? []).find((t) => String(t?.name ?? '').trim() === key);
  return hit?.id ?? null;
}

// Adds an org tag to a manifest. RoseRocket wants a bare { tag_id } body (the {tags:[…]} shape 500s).
async function addManifestTag(api, tripId, tagId) {
  return api.post(`/api/v1/master_trips/${tripId}/tags`, { tag_id: tagId });
}

// When an outbound leg is loaded at the terminal (LDT) the truck is committed to its US run and will
// collect inbound freight next, so the manifest is flagged US I/B to surface those pickups on the
// inbound sheet — the mirror of UT dropping an order off it. This tags each given manifest when it
// (a) already carries the outbound trigger tag and (b) is not already tagged inbound. Idempotent and
// additive: it never removes a tag and never re-adds an existing one.
async function autoTagInboundOnLdt(
  tripIds,
  { outboundTagName = 'US O/B', inboundTagName = 'US I/B' } = {},
) {
  const ids = [...(tripIds ?? [])];
  if (ids.length === 0) return { added: 0, skipped: 0 };
  const api = await client();
  const orgTagCache = {};
  const inboundTagId = await resolveTagIdByName(api, inboundTagName, orgTagCache);
  if (!inboundTagId) {
    console.warn(`[AutoTag] Tag "${inboundTagName}" not found in org — skipping auto-tag.`);
    return { added: 0, skipped: ids.length };
  }
  const tagCache = new Map();
  let added = 0;
  let skipped = 0;
  for (const tripId of ids) {
    try {
      const tags = await fetchMasterTripTags(api, tripId, tagCache);
      const names = new Set(tags.map((t) => String(t?.name ?? '').trim()));
      if (!names.has(outboundTagName)) { skipped++; continue; } // not an outbound manifest
      if (names.has(inboundTagName)) { skipped++; continue; } // already flagged inbound
      await addManifestTag(api, tripId, inboundTagId);
      added++;
      console.log(`[AutoTag] Added "${inboundTagName}" to manifest ${tripId} (outbound at LDT).`);
    } catch (err) {
      skipped++;
      console.warn(`[AutoTag] ${tripId}: could not tag — ${err.response?.status ?? ''} ${err.message}`);
    }
  }
  console.log(`[AutoTag] Added "${inboundTagName}" to ${added} manifest(s); ${skipped} skipped.`);
  return { added, skipped };
}

// --- Manifest-list source (trip-history tag trigger) --------------------------
// The master_trips LIST rows already carry `manifest_tags`, the driver, the mileage and the status, so a
// manifest can be judged — tagged? finished? — without a single per-manifest call. That is what lets the
// trip-history archive pick up a manifest by its tag even when none of its orders came back in the order
// window (an order ages out by created_at long before an old trip stops being worth archiving).

function manifestTagsFromTrip(trip) {
  const tags = trip?.manifest_tags ?? trip?.tags ?? [];
  return Array.isArray(tags) ? tags : [];
}

function manifestTagNamesFromTrip(trip) {
  return manifestTagsFromTrip(trip)
    .map((t) => String(t?.name ?? t ?? '').trim())
    .filter(Boolean);
}

// A manifest is still on the road while it is planning/assigned/moving; anything past that (completed,
// bill-created, bill-approved, and whatever billing states RoseRocket adds later) is a finished trip.
// Testing for "not active" rather than listing the finished states keeps a new billing status from
// silently freezing trips out of the archive forever.
const MASTER_TRIP_ACTIVE_STATUSES = new Set(['planning', 'assigned', 'moving', 'dispatched']);

// When the manifest itself finished, or null while it is still running. Used as the completion signal
// for a manifest that has no US→CA order to date it from (see trip-history).
function masterTripFinishedAt(trip) {
  const status = String(trip?.master_trip_status_id ?? trip?.derived_status ?? '').toLowerCase();
  if (!status || MASTER_TRIP_ACTIVE_STATUSES.has(status)) return null;
  return trip?.completed_at || null;
}

// Pages the manifest list newest-first, stopping once the rows predate `sinceMs`. Returns the raw list
// rows (each with manifest_tags), NOT full master-trip objects.
async function fetchMasterTripsSince(orgUrl = SYNC_ORG_URL, { sinceMs, maxRecords = 20000 } = {}) {
  const api = await client(orgUrl);
  const limit = 250;
  const trips = [];
  for (let offset = 0; offset < maxRecords; offset += limit) {
    let rows;
    try {
      const res = await api.get('/api/v1/master_trips', {
        params: { limit, offset, sort: 'created_at desc' },
      });
      const data = res.data?.data;
      rows = Array.isArray(data) ? data : (data?.master_trips ?? []);
    } catch (err) {
      console.warn(`[RoseRocket] Manifest list page at offset ${offset} failed: ${err.message}`);
      break;
    }
    if (!rows.length) break;
    let reachedOld = false;
    for (const t of rows) {
      const created = toTime(t?.created_at);
      if (sinceMs != null && created !== null && created < sinceMs) { reachedOld = true; break; }
      trips.push(t);
    }
    if (reachedOld || rows.length < limit) break;
  }
  console.log(`[RoseRocket] Manifests listed within window: ${trips.length}`);
  return trips;
}

// The manifest context the sheets use, built straight from a manifest LIST row instead of from an
// order's legs — same shape as orderManifestContextFromLegs so both sources feed the archive alike.
function manifestContextFromTrip(trip) {
  const info = manifestInfoFromTrip(trip, manifestTagsFromTrip(trip));
  if (!info) return null;
  return {
    ...info,
    estimatedMiles: info.estimatedMiles,
    rounderMiles: info.estimatedMiles,
    rounderRate: null,
    deliverySequence: null,
    pickupSequence: null,
  };
}

function manifestInfoFromTrip(trip, tags = []) {
  if (!trip) return null;
  const nickname = manifestLabelFromTrip(trip);
  const fullId = String(trip.full_id ?? '').trim();
  const tripId = String(trip.id ?? '').trim();
  const driver = driverNameFromTrip(trip);
  const estimatedMiles = manifestMilesFromTrip(trip);
  const tagList = Array.isArray(tags) ? tags : [];
  if (!nickname && !fullId && !tripId && estimatedMiles == null && tagList.length === 0) return null;
  return { nickname, fullId, tripId, driver, estimatedMiles, tags: tagList };
}

// Drops orders whose final delivery leg has reached a "hide" status (see above). Makes one /legs
// call per order, run with limited concurrency. On any per-order error the order is kept (fail open).
// Also resolves each order's manifest (master trip) for outbound/inbound tab routing and sheet links.
// manifestSide picks WHICH manifest is "the" manifest for an order — see pickManifestTripIdFor.
async function filterOutLoadedDeliveries(orders, { manifestSide = 'delivery' } = {}) {
  if (orders.length === 0) return { orders: [], manifestByOrderId: new Map(), schedulingByOrderId: new Map() };
  const api = await client();
  const keep = [];
  const manifestByOrderId = new Map();
  const schedulingByOrderId = new Map();
  const tripCache = new Map();
  const tagCache = new Map();
  const stopCache = new Map();
  // Manifests of outbound orders that have just reached LDT — candidates for the US I/B auto-tag.
  const ldtManifestTripIds = new Set();
  let hidden = 0;

  for (let i = 0; i < orders.length; i += LEG_FETCH_CONCURRENCY) {
    const batch = orders.slice(i, i + LEG_FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(async (o) => {
      try {
        const [legs, quotes] = await Promise.all([
          fetchOrderLegs(api, o.id),
          fetchOrderQuotes(api, o.id).catch(() => []),
        ]);
        const quote = primaryQuote(quotes);
        const freightRate = freightRateCadFromQuote(quote, o);
        // Drop completed legs: outbound when the delivery leg is LDT/delivered, inbound when the
        // pickup leg is unloaded at terminal (UT). An outbound order reaching LDT also marks its
        // manifest for the US I/B auto-tag (the truck is committed and will collect inbound next).
        if (orderLegComplete(legs, manifestSide)) {
          const ldtTripId =
            manifestSide === 'delivery' ? pickManifestTripIdFor(legs, 'delivery') : null;
          return { o, hide: true, ldtTripId };
        }

        const tripId = pickManifestTripIdFor(legs, manifestSide);
        let trip = null;
        let tags = [];
        if (tripId) {
          trip = await fetchMasterTrip(api, tripId, tripCache);
          tags = await fetchMasterTripTags(api, tripId, tagCache);
        }
        const stops = tripId
          ? await fetchMasterTripStops(api, tripId, stopCache)
          : [];
        const stopOrdinals = stopOrdinalsFromStops(stops);
        const deliverySequence = deliverySequenceForOrder(legs, tripId, stopOrdinals);
        const pickupSequence = pickupSequenceForOrder(legs, tripId, stopOrdinals);
        // Inbound sheet shows the inbound-leg miles (empty point → last pickup); outbound keeps the
        // full-manifest miles. Only compute the segment for the pickup side to avoid needless work.
        const milesOverride =
          manifestSide === 'pickup' ? inboundManifestMiles(stops) : null;
        schedulingByOrderId.set(o.id, schedulingFromLegs(legs, o));
        manifestByOrderId.set(
          o.id,
          orderManifestContextFromLegs(
            legs,
            trip,
            tags,
            deliverySequence,
            pickupSequence,
            milesOverride,
          ),
        );
        return { o: { ...o, _freightRate: freightRate ?? '' }, hide: false };
      } catch {
        return { o, hide: false };
      }
    }));
    for (const { o, hide, ldtTripId } of results) {
      if (hide) {
        hidden++;
        if (ldtTripId) ldtManifestTripIds.add(ldtTripId);
      } else keep.push(o);
    }
  }

  const completeLabel = manifestSide === 'pickup'
    ? 'pickup leg is unloaded at terminal (UT)'
    : 'delivery leg is loaded/delivered (LDT)';
  console.log(`[RoseRocket] Hid ${hidden} order(s) whose ${completeLabel}; ${keep.length} remain.`);
  const withManifest = [...manifestByOrderId.values()].filter(v => v.tripId).length;
  const legMilesOnly = [...manifestByOrderId.values()].filter(v => !v.tripId && v.estimatedMiles != null).length;
  console.log(
    `[RoseRocket] Miles: ${withManifest} from manifest, ${legMilesOnly} from leg distance (no manifest yet).`,
  );

  // Inbound Summary shows the whole-trip ("rounder") revenue. Computed once per manifest here (it needs
  // every order on the manifest, not just the inbound ones), then patched onto each order's context.
  if (manifestSide === 'pickup') {
    const tripIds = new Set(
      [...manifestByOrderId.values()].map((v) => v.tripId).filter(Boolean),
    );
    if (tripIds.size) {
      const rateByTrip = await rounderRevenueByTrip(api, tripIds, stopCache);
      for (const ctx of manifestByOrderId.values()) {
        if (ctx.tripId && rateByTrip.has(ctx.tripId)) {
          ctx.rounderRate = rateByTrip.get(ctx.tripId);
        }
      }
      console.log(`[RoseRocket] Rounder revenue computed for ${tripIds.size} manifest(s).`);
    }
  }

  return { orders: keep, manifestByOrderId, schedulingByOrderId, ldtManifestTripIds };
}

// Resolves EVERY order in a direction (active and completed alike) with the same manifest context,
// scheduling, and completion flag the live sheets use — the trip-history archive needs the completed
// ones (which filterOutLoadedDeliveries discards) plus, for the Rounder tab, the full per-manifest
// picture so it can tell when a manifest's inbound is entirely done. `complete` is true once the
// direction's trigger leg is reached: delivery LDT for outbound, pickup UT for inbound.
async function resolveOrdersForHistory(
  orders,
  { manifestSide = 'delivery', allowDirectDelivery = false } = {},
) {
  if (!orders.length) return [];
  const api = await client();
  const tripCache = new Map();
  const tagCache = new Map();
  const stopCache = new Map();
  const results = [];

  for (let i = 0; i < orders.length; i += LEG_FETCH_CONCURRENCY) {
    const batch = orders.slice(i, i + LEG_FETCH_CONCURRENCY);
    const resolved = await Promise.all(batch.map(async (o) => {
      try {
        const [legs, quotes] = await Promise.all([
          fetchOrderLegs(api, o.id),
          fetchOrderQuotes(api, o.id).catch(() => []),
        ]);
        const quote = primaryQuote(quotes);
        const freightRate = freightRateCadFromQuote(quote, o);
        const complete = orderLegComplete(legs, manifestSide, { allowDirectDelivery });
        const tripId = pickManifestTripIdFor(legs, manifestSide);
        let trip = null;
        let tags = [];
        if (tripId) {
          trip = await fetchMasterTrip(api, tripId, tripCache);
          tags = await fetchMasterTripTags(api, tripId, tagCache);
        }
        const stops = tripId ? await fetchMasterTripStops(api, tripId, stopCache) : [];
        const stopOrdinals = stopOrdinalsFromStops(stops);
        const milesOverride =
          manifestSide === 'pickup' ? inboundManifestMiles(stops) : null;
        const manifest = orderManifestContextFromLegs(
          legs,
          trip,
          tags,
          deliverySequenceForOrder(legs, tripId, stopOrdinals),
          pickupSequenceForOrder(legs, tripId, stopOrdinals),
          milesOverride,
        );
        return {
          order: { ...o, _freightRate: freightRate ?? '' },
          manifest,
          scheduling: schedulingFromLegs(legs, o),
          complete,
          // For the inbound side, when the haul unloaded at the terminal (the trip-finish date).
          completedAt: manifestSide === 'pickup' ? inboundUnloadedAt(legs) : null,
          tripId: manifest.tripId || tripId || null,
        };
      } catch {
        return null;
      }
    }));
    for (const r of resolved) if (r) results.push(r);
  }
  // NB: whole-trip revenue is left to the caller (trip-history sums the outbound + inbound legs, which
  // also makes the three tabs add up) — so this deliberately skips the per-manifest leg walk that
  // rounderRevenueByTrip would otherwise cost here.
  return results;
}

// The fallback scan in findOrderByFullId pulls the WHOLE recent-order window — several pages, ~1,300
// orders. Force Deliver calls that lookup once per queue row, so a queue holding two unknown IDs scanned
// the window twice over, stretching the ops run out while every other cron was competing for the same
// Sheets quota. The window is identical for every lookup in a run, so resolve it once per process.
let recentOrderScan = null;
function scanRecentOrders() {
  if (!recentOrderScan) {
    recentOrderScan = fetchOrders().catch((err) => {
      recentOrderScan = null; // let a later row retry rather than inherit the failure
      throw err;
    });
  }
  return recentOrderScan;
}

// MULTI-STOP ORDERS ARE INVISIBLE TO THE ORDER ENDPOINT. RoseRocket does not return a multi-stop
// ("consolidated") order from /api/v1/orders — not from search_term, and not from a full scan of the
// window either. The planners can see it perfectly well on the order screen and in the Legs module, so
// "Order not found" looked like a wrong ID when the order was really sitting there, Booked. That is what
// happened to CET-CEL1-10 / CET-CEL1-11.
//
// The Legs module is /api/v1/trips, and every leg row embeds its parent order — id, full_id, state and
// location_id, which is everything the ops queues need. So when the order endpoint draws a blank, look
// the order up through its legs instead. Cheap (one request) and it is the ONLY way to reach these.
async function findOrderViaLegs(fullId, orgUrl = SYNC_ORG_URL) {
  const needle = String(fullId).trim().toLowerCase();
  if (!needle) return null;
  const api = await client(orgUrl);
  try {
    const res = await api.get('/api/v1/trips', {
      params: { search_term: needle, limit: 50, offset: 0 },
    });
    const data = res.data?.data;
    const legs = Array.isArray(data) ? data : (data?.trips ?? []);
    for (const leg of legs) {
      const order = leg?.order;
      if (order?.id && String(order.full_id ?? '').trim().toLowerCase() === needle) return order;
    }
  } catch (err) {
    console.warn(`[RoseRocket] Leg lookup failed for "${fullId}": ${err.message}`);
  }
  return null;
}

// Look up a single order by its human-readable full_id (e.g. "CEL-VIL-45", "CET-GAT-386").
async function findOrderByFullId(fullId, orgUrl = SYNC_ORG_URL) {
  const needle = String(fullId).trim();
  if (!needle) return null;
  const api = await client(orgUrl);

  // Primary: RoseRocket order search.
  try {
    const res = await api.get('/api/v1/orders', {
      params: { search_term: needle, limit: 50, offset: 0 },
    });
    const orders = res.data?.data?.orders ?? res.data?.orders ?? [];
    const exact = orders.find(o => String(o.full_id ?? '').trim().toLowerCase() === needle.toLowerCase());
    if (exact) return exact;
    if (orders.length === 1) return orders[0];
  } catch (err) {
    console.warn(`[RoseRocket] Order search failed for "${needle}": ${err.message}`);
  }

  // Multi-stop orders never appear in the order endpoint at all, so try the Legs module before paying
  // for the full scan below — one request, and it is the only route to those orders.
  const viaLegs = await findOrderViaLegs(needle, orgUrl);
  if (viaLegs) return viaLegs;

  // Fallback: scan recent sync-window orders (only for the sync org), reusing one scan per run.
  if (orgUrl === SYNC_ORG_URL) {
    const recent = await scanRecentOrders();
    return recent.find(o => String(o.full_id ?? '').trim().toLowerCase() === needle.toLowerCase()) ?? null;
  }
  return null;
}

function orderIdPrefix(fullId) {
  const m = String(fullId).trim().match(/^([A-Za-z]+)-/);
  return m ? m[1].toUpperCase() : null;
}

function orgUrlForPrefix(prefix) {
  return FORCE_DELIVER_ROUTES.find(r => r.prefix === prefix)?.orgUrl ?? null;
}

function orgsToTryForOrderId(fullId) {
  const primary = orgUrlForPrefix(orderIdPrefix(fullId));
  const all = FORCE_DELIVER_ROUTES.map(r => r.orgUrl);
  if (primary) return [primary, ...all.filter(u => u !== primary)];
  return all;
}

function getForceDeliverOrgRoutes() {
  return FORCE_DELIVER_ROUTES;
}

// Tries the org implied by the order-ID prefix first (CEL/CET), then the other configured org.
async function findOrderForForceDeliver(fullId) {
  for (const orgUrl of orgsToTryForOrderId(fullId)) {
    const order = await findOrderByFullId(fullId, orgUrl);
    if (order) return { order, orgUrl };
  }
  return null;
}

async function fetchOrderDetail(orderId, orgUrl = SYNC_ORG_URL) {
  const api = await client(orgUrl);
  const res = await api.get(`/api/v1/orders/${orderId}`);
  return res.data?.data?.order ?? res.data?.order ?? res.data?.data ?? res.data;
}

// RoseRocket ties orders to customers via location_id (customer location UUID).
// List/search responses omit customer_id; org_id is the carrier, not the customer.
async function resolveOrderCustomerId(order, orgUrl = SYNC_ORG_URL) {
  if (order.location_id) return order.location_id;
  if (!order.id) return null;
  const detail = await fetchOrderDetail(order.id, orgUrl);
  return detail?.location_id ?? null;
}

async function platformOrderAction(customerId, orderId, action, orgUrl) {
  const token = await getToken(orgUrl);
  const cid = encodeURIComponent(customerId);
  const oid = encodeURIComponent(orderId);
  await axios.post(
    `${PLATFORM_URL}/api/v1/customers/${cid}/orders/${oid}/${action}`,
    {},
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
  );
}

// Books a pending-dispatch order so mark_delivered is allowed (RoseRocket platform API).
async function bookOrder(customerId, orderId, orgUrl) {
  await platformOrderAction(customerId, orderId, 'book', orgUrl);
}

// Forces an order to Delivered via RoseRocket platform API (bypasses stuck leg UI states like PRB/PP).
async function markOrderDelivered(customerId, orderId, orgUrl) {
  await platformOrderAction(customerId, orderId, 'mark_delivered', orgUrl);
}

// Cancels an order. Note the path: unlike book/mark_delivered this is NOT customer-scoped — it hangs off
// the order directly (POST /api/v1/orders/{id}/cancel). RoseRocket documents it as cancelling "a single
// order or consolidated order", i.e. it handles the multi-stop orders whose cancel button fails in the UI
// with "cannot operate on stop via the multi-stop order API. Use the child_orders API".
const CANCELLED_ORDER_STATES = new Set(['cancelled', 'canceled']);

async function cancelOrder(orderId, orgUrl) {
  if (!orgUrl) throw new Error('Missing org URL for cancel order');
  const token = await getToken(orgUrl);
  const oid = encodeURIComponent(orderId);
  const res = await axios.post(
    `${PLATFORM_URL}/api/v1/orders/${oid}/cancel`,
    {},
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
  );
  const updated = res.data?.data?.order ?? res.data?.data ?? null;
  return { state: updated?.order_state_id ?? null };
}

// Cancels an order, escalating to its CONSOLIDATED PARENT when there is one.
//
// A multi-stop order in RoseRocket is a "consolidated" order: the parent holds the stops, and each stop
// is its own order carrying `consolidated_order_id` + `consolidated_order_sequence_id`. Cancel refuses to
// act on a stop — "cannot operate on stop via the orders API. Use the stops API" — and RoseRocket
// documents exactly ONE cancel endpoint, which takes "a single order or consolidated order". So the only
// way to cancel a stop is to cancel the parent it belongs to.
//
// CONSEQUENCE, and the caller must surface it: cancelling the parent cancels EVERY stop on it, not just
// the one that was queued. There is no per-stop cancel in the API.
async function forceCancelOrder(order, orgUrl) {
  if (!orgUrl) throw new Error('Missing org URL for cancel order');
  const parentId = order?.consolidated_order_id;
  if (!parentId) {
    const { state } = await cancelOrder(order.id, orgUrl);
    return { targetId: order.id, targetFullId: order.full_id, consolidated: false, state };
  }
  const parent = await fetchOrderDetail(parentId, orgUrl).catch(() => null);
  const base = {
    targetId: parentId,
    targetFullId: parent?.full_id ?? parentId,
    consolidated: true,
    sequence: order.consolidated_order_sequence_id ?? null,
  };
  // Queueing two stops of the same consolidated order is the normal case — cancelling the parent for the
  // first one already cancelled the second. Report that instead of firing a redundant cancel at a parent
  // that is already done.
  const parentState = String(parent?.order_state_id ?? '').toLowerCase();
  if (CANCELLED_ORDER_STATES.has(parentState)) {
    return { ...base, alreadyCancelled: true, state: parentState };
  }
  const { state } = await cancelOrder(parentId, orgUrl);
  return { ...base, alreadyCancelled: false, state: state ?? null };
}

// Books first when still pending-dispatch, then marks delivered.
async function forceDeliverOrder(order, orgUrl) {
  if (!orgUrl) throw new Error('Missing org URL for force deliver');

  const customerId = await resolveOrderCustomerId(order, orgUrl);
  if (!customerId) throw new Error('Order has no customer location_id — cannot force deliver');

  const state = String(order.order_state_id ?? '').toLowerCase();
  if (state === 'pending-dispatch') {
    console.log(`[RoseRocket]   Booking ${order.full_id} (was pending-dispatch)...`);
    await bookOrder(customerId, order.id, orgUrl);
  }

  await markOrderDelivered(customerId, order.id, orgUrl);
}

function manifestIdPrefix(fullId) {
  const id = String(fullId).trim().toUpperCase();
  if (id.startsWith('CEL')) return 'CEL';
  if (id.startsWith('CET')) return 'CET';
  return null;
}

function orgsToTryForManifestId(fullId) {
  const primary = orgUrlForPrefix(manifestIdPrefix(fullId));
  const all = FORCE_DELIVER_ROUTES.map(r => r.orgUrl);
  if (primary) return [primary, ...all.filter(u => u !== primary)];
  return all;
}

// Look up a manifest (master trip) by human-readable full_id (e.g. "CETM25631").
async function findMasterTripByFullId(fullId, orgUrl = SYNC_ORG_URL) {
  const needle = String(fullId).trim();
  if (!needle) return null;
  const api = await client(orgUrl);

  try {
    const res = await api.get('/api/v1/master_trips', {
      params: { search_term: needle, limit: 50, offset: 0 },
    });
    const trips = res.data?.data?.master_trips ?? res.data?.data ?? [];
    const list = Array.isArray(trips) ? trips : [];
    const exact = list.find(t => String(t.full_id ?? '').trim().toLowerCase() === needle.toLowerCase());
    if (exact) return exact;
    if (list.length === 1) return list[0];
  } catch (err) {
    console.warn(`[RoseRocket] Manifest search failed for "${needle}": ${err.message}`);
  }
  return null;
}

async function findMasterTripForForceDelete(fullId) {
  for (const orgUrl of orgsToTryForManifestId(fullId)) {
    const trip = await findMasterTripByFullId(fullId, orgUrl);
    if (trip) return { trip, orgUrl };
  }
  return null;
}

async function fetchEmanifestsForTrip(api, tripId) {
  const res = await api.get('/api/v1/emanifests', { params: { master_trip_id: tripId, limit: 100 } });
  return res.data?.data?.emanifests ?? [];
}

async function deleteEmanifest(api, emanifestId) {
  await api.delete(`/api/v1/emanifests/${emanifestId}`);
}

async function deleteMasterTrip(api, tripId) {
  await api.delete(`/api/v1/master_trips/${tripId}`);
}

// Removes linked eManifests first, then deletes the manifest (master trip).
async function forceDeleteManifest(trip, orgUrl) {
  if (!orgUrl) throw new Error('Missing org URL for force delete manifest');
  if (!trip?.id) throw new Error('Manifest has no id — cannot delete');

  const api = await client(orgUrl);
  const emanifests = await fetchEmanifestsForTrip(api, trip.id);
  for (const em of emanifests) {
    console.log(
      `[RoseRocket]   Deleting eManifest ${em.id} (${em.emanifest_type ?? 'unknown'}, ${em.emanifest_status ?? 'unknown'})...`,
    );
    await deleteEmanifest(api, em.id);
  }

  console.log(`[RoseRocket]   Deleting manifest ${trip.full_id}...`);
  await deleteMasterTrip(api, trip.id);
  return { deletedEmanifests: emanifests.length };
}

module.exports = {
  fetchOrders,
  fetchOrdersForOrg,
  fetchDriverTypes,
  normalizePersonKey,
  fetchOrdersByState,
  filterUSOutbound,
  filterUSInbound,
  filterOutLoadedDeliveries,
  resolveOrdersForHistory,
  orderLegComplete,
  rounderRevenueByTrip,
  findOrderByFullId,
  findOrderViaLegs,
  findOrderForForceDeliver,
  fetchOrderDetail,
  fetchOrderLegs,
  fetchOrderQuotes,
  fetchOrderCommissionees,
  fetchMasterTrip,
  fetchMasterTripTags,
  autoTagInboundOnLdt,
  addManifestTag,
  resolveTagIdByName,
  fetchMasterTripStopOrdinals,
  pickManifestDeliveryLeg,
  deliverySequenceForOrder,
  pickManifestPickupLeg,
  pickupSequenceForOrder,
  pickManifestTripIdForPickup,
  pickManifestTripIdFor,
  pickManifestTripId,
  primaryQuote,
  freightRateFromQuote,
  freightRateCadFromQuote,
  manifestLabelFromTrip,
  manifestMilesFromTrip,
  inboundManifestMiles,
  outboundManifestMiles,
  manifestTurnOrdinal,
  manifestStopRole,
  isDeliverySideStop,
  isPickupSideStop,
  fetchMasterTripsSince,
  manifestContextFromTrip,
  manifestTagNamesFromTrip,
  masterTripFinishedAt,
  fetchMasterTripStops,
  milesFromLegs,
  orderManifestContextFromLegs,
  schedulingFromLegs,
  formatRequestedDate,
  resolveOrderCustomerId,
  bookOrder,
  markOrderDelivered,
  cancelOrder,
  forceCancelOrder,
  forceDeliverOrder,
  findMasterTripByFullId,
  findMasterTripForForceDelete,
  forceDeleteManifest,
  getForceDeliverOrgRoutes,
  orderIdPrefix,
  manifestIdPrefix,
  orgUrlForPrefix,
  client,
  SYNC_ORG_URL,
  CELOGISTICS_ORG_URL,
};

