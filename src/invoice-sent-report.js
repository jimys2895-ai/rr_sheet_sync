require("dotenv").config();
const {
  fetchOrdersByState,
  fetchOrderLegs,
  fetchOrderQuotes,
  fetchOrderCommissionees,
  fetchMasterTrip,
  client,
  CELOGISTICS_ORG_URL,
} = require("./roserocket");
const {
  writeToSheetWithRetry,
  sleep,
  removeUnwantedOpsSheets,
  reorderSheets,
  renameTabs,
  ensureTab,
  moveTabToIndex,
  readTabValues,
  writeTabRange,
  clearTabRange,
  applyCellDropdown,
  applyFilterDropdownCell,
} = require("./sheets");

const ALL_COMMISSION_CURRENT_TAB = "All Cur";
const ALL_COMMISSION_PREVIOUS_TAB = "All Pre";
const HOUSE_CURRENT_TAB = "House Cur";
const HOUSE_PREVIOUS_TAB = "House Pre";
const TAB_NAME = ALL_COMMISSION_CURRENT_TAB;
const COMMISSION_LOOKUP_TAB = "Lookup";
// Full names — used ONLY to match the "On commission" column to a rep (commissionRepForRow). The tab
// TITLES are the rep's first name plus " Cur"/" Pre" (see commissionRepTabName), e.g. "Roger Cur".
const COMMISSION_REP_NAMES = [
  "Roger Gratton",
  "Irena Pana",
  "Larry Persons",
  "Debbie Collins",
];
const COMMISSION_REP_CURRENT_SUFFIX = " Cur";
const COMMISSION_REP_PREVIOUS_SUFFIX = " Pre";

// Tab title for a rep: first name + suffix ("Roger Gratton" → "Roger Cur"). The rep's full name stays
// the matching key; only the visible tab name is shortened.
function commissionRepTabName(repName, suffix) {
  const firstName = String(repName ?? "").trim().split(/\s+/)[0];
  return `${firstName}${suffix}`;
}

const COMMISSION_REP_CURRENT_TABS = COMMISSION_REP_NAMES.map((rep) =>
  commissionRepTabName(rep, COMMISSION_REP_CURRENT_SUFFIX),
);
const COMMISSION_REP_PREVIOUS_TABS = COMMISSION_REP_NAMES.map((rep) =>
  commissionRepTabName(rep, COMMISSION_REP_PREVIOUS_SUFFIX),
);

// Left-to-right tab order on the commission spreadsheet.
const COMMISSION_SHEET_TAB_ORDER = [
  COMMISSION_LOOKUP_TAB,
  ALL_COMMISSION_CURRENT_TAB,
  ...COMMISSION_REP_CURRENT_TABS,
  HOUSE_CURRENT_TAB,
  ALL_COMMISSION_PREVIOUS_TAB,
  ...COMMISSION_REP_PREVIOUS_TABS,
  HOUSE_PREVIOUS_TAB,
];

const COMMISSION_CURRENT_TABS = [
  ...COMMISSION_REP_CURRENT_TABS,
  HOUSE_CURRENT_TAB,
];
const COMMISSION_PREVIOUS_TABS = [
  ...COMMISSION_REP_PREVIOUS_TABS,
  HOUSE_PREVIOUS_TAB,
];
const COMMISSION_TABS = COMMISSION_SHEET_TAB_ORDER.filter(
  (t) =>
    t !== COMMISSION_LOOKUP_TAB &&
    t !== ALL_COMMISSION_CURRENT_TAB &&
    t !== ALL_COMMISSION_PREVIOUS_TAB,
);
const NAMED_COMMISSION_REPS = [...COMMISSION_REP_NAMES];
const COMMISSION_FILTER_OPTIONS = ["All", ...NAMED_COMMISSION_REPS, "House"];
const COMMISSION_TAB_ORDER = COMMISSION_SHEET_TAB_ORDER.filter(
  (t) => t !== COMMISSION_LOOKUP_TAB,
);
const COMMISSION_KEEP_TABS = [...COMMISSION_SHEET_TAB_ORDER];

// Old (long) tab titles → new (short) ones. Renamed in place at the start of each sync so the existing
// tabs — including the Lookup tab's user-entered filters — carry over instead of being wiped and rebuilt.
// Safe to keep permanently: a rename no-ops once the target tab already exists.
const LEGACY_TAB_RENAMES = [
  ["Commission Lookup", COMMISSION_LOOKUP_TAB],
  ["All Commission Current", ALL_COMMISSION_CURRENT_TAB],
  ["All Commission Previous", ALL_COMMISSION_PREVIOUS_TAB],
  ["House Current", HOUSE_CURRENT_TAB],
  ["House Previous", HOUSE_PREVIOUS_TAB],
  ...COMMISSION_REP_NAMES.flatMap((rep) => [
    [`${rep} Current`, commissionRepTabName(rep, COMMISSION_REP_CURRENT_SUFFIX)],
    [`${rep} Previous`, commissionRepTabName(rep, COMMISSION_REP_PREVIOUS_SUFFIX)],
  ]),
].map(([from, to]) => ({ from, to }));
const COMMISSION_LOOKUP_TAB_INDEX = 0;
const INVOICE_SENT = "invoice-sent";
const LOOKUP_FILTER_ROW_COUNT = 6;
const LOOKUP_HEADER_ROW = LOOKUP_FILTER_ROW_COUNT + 1;
const REFRESH_LOOKUP_OPTIONS = ["ON", "OFF"];
const ENRICH_CONCURRENCY = 6;
const WEB = (
  process.env.ROSEROCKET_WEB_URL ??
  CELOGISTICS_ORG_URL ??
  ""
).replace(/\/+$/, "");
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || "America/Toronto";

// Quote-item types that have their own column and so must NOT also land in Accessorial Total.
// Fuel is matched by PREFIX, not by an exact name: RoseRocket types flat-rate fuel as
// "fuel-flat-rate-spot", which an exact-match list missed — so it was counted as an accessorial while
// quote.fuel_cost already included it, printing the same amount in both columns (CEL-KIN2-1007 showed
// $913.04 twice). Everything else, including "misc" (wait time, HAZ charges), stays an accessorial.
const FREIGHT_TYPES = new Set(["freight", "freight-spot"]);

function isFuelItemType(typeId) {
  return String(typeId ?? "")
    .toLowerCase()
    .startsWith("fuel");
}

function datePartsInReportTimezone(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { year: get("year"), month: get("month"), day: get("day") };
}

function legFinancialsMap(order) {
  const map = new Map();
  for (const f of order.child_order_leg_financials ?? []) {
    if (f?.leg_id) map.set(f.leg_id, f);
  }
  return map;
}

function primaryQuote(quotes) {
  if (!quotes?.length) return null;
  return (
    quotes.find((q) => q.quote_status_id === "dispatch-success") ?? quotes[0]
  );
}

function parseAccessorials(quote) {
  const items = (quote?.quote_items ?? []).filter((i) => {
    const type = String(i?.quote_item_type_id ?? "").toLowerCase();
    return i && !FREIGHT_TYPES.has(type) && !isFuelItemType(type);
  });
  const names = [];
  const amounts = [];
  for (const i of items) {
    const desc = String(i.description ?? i.quote_item_type_id ?? "").trim();
    const amt = Number(i.total_amount ?? 0);
    if (!desc) continue;
    names.push(desc);
    amounts.push(amt);
  }
  const total = amounts.reduce((sum, n) => sum + n, 0);
  return {
    accessorialNames: names.join("\n"),
    accessorialTotal: total > 0 ? total : "",
  };
}

function formatDeliveredDate(leg) {
  const raw = leg?.delivered_at ?? leg?.pod_date ?? "";
  if (!raw) return "";
  const parts = datePartsInReportTimezone(raw);
  if (!parts) return String(raw).slice(0, 10);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function currentYearMonth() {
  const parts = datePartsInReportTimezone(new Date());
  return `${parts.year}-${parts.month}`;
}

// Current commission tabs show legs delivered in the current calendar month only (Eastern).
function filterRowsByCurrentDeliveryMonth(rows) {
  const ym = currentYearMonth();
  const filtered = rows.filter((r) =>
    String(r.deliveredDate ?? "").startsWith(ym),
  );
  console.log(
    `[InvoiceSent] Current delivery month (${ym} ${REPORT_TIMEZONE}): ${filtered.length} of ${rows.length} leg row(s)`,
  );
  return filtered;
}

function filterRowsByPreviousDeliveryMonth(rows) {
  const { start, end } = previousMonthDateRange();
  const filtered = filterRowsByDateRange(rows, start, end);
  console.log(
    `[InvoiceSent] Previous delivery month (${start} → ${end} ${REPORT_TIMEZONE}): ${filtered.length} of ${rows.length} leg row(s)`,
  );
  return filtered;
}

function previousMonthDateRange() {
  const { year, month } = datePartsInReportTimezone(new Date());
  const y = Number(year);
  const m = Number(month);
  // Day 0 of the current month is the last day of the previous one. That instant is UTC midnight, so
  // it must be read back with UTC getters: formatting it in a timezone BEHIND UTC (America/Toronto)
  // rolls it back a day, which silently dropped every month's final delivery date from the Previous
  // tabs — e.g. June ended at the 29th and the 30th's orders appeared on no tab at all.
  const lastDayPrev = new Date(Date.UTC(y, m - 1, 0));
  const py = lastDayPrev.getUTCFullYear();
  const pm = String(lastDayPrev.getUTCMonth() + 1).padStart(2, "0");
  const pd = String(lastDayPrev.getUTCDate()).padStart(2, "0");
  return {
    start: `${py}-${pm}-01`,
    end: `${py}-${pm}-${pd}`,
  };
}

function parseSheetDate(val) {
  if (val == null || val === "") return "";
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, mo, day, year] = slash;
    return `${year}-${mo.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const n = Number(val);
  if (Number.isFinite(n) && n > 0) {
    // A Sheets serial is a calendar day, not an instant. It lands on UTC midnight, so read it back with
    // UTC getters — converting to a timezone behind UTC would shift it to the previous day.
    const d = new Date(Math.round((n - 25569) * 86400000));
    if (!Number.isNaN(d.getTime())) {
      const yy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${yy}-${mm}-${dd}`;
    }
  }

  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    const parts = datePartsInReportTimezone(new Date(parsed));
    if (parts) return `${parts.year}-${parts.month}-${parts.day}`;
  }
  return "";
}

function parseRefreshLookupCell(val, defaultOn = true) {
  const s = String(val ?? "")
    .trim()
    .toLowerCase();
  if (!s) return defaultOn;
  if (["on", "true", "yes", "y", "1"].includes(s)) return true;
  if (["off", "false", "no", "n", "0"].includes(s)) return false;
  return defaultOn;
}

function refreshLookupSheetValue(val, defaultOn = true) {
  return parseRefreshLookupCell(val, defaultOn) ? "ON" : "OFF";
}

async function applyRefreshLookupDropdown(spreadsheetId, cellValue = true) {
  await applyFilterDropdownCell(spreadsheetId, COMMISSION_LOOKUP_TAB, {
    rowIndex: 3,
    columnIndex: 1,
    value: refreshLookupSheetValue(cellValue),
    values: REFRESH_LOOKUP_OPTIONS,
  });
}

function readRefreshLookupFromValues(values) {
  const refreshRaw = values[3]?.[1] ?? values[1]?.[2] ?? values[0]?.[2];
  return parseRefreshLookupCell(refreshRaw, true);
}

function defaultSinceDays() {
  return parseInt(process.env.ROSEROCKET_SINCE_DAYS ?? "30", 10);
}

// RoseRocket lists orders by created_at — extend the pull window back from the lookup start date
// so orders delivered in that period are included (creation usually precedes delivery).
function computeLookupFetchSinceDays(filterStartYmd) {
  const envCommission = parseInt(
    process.env.ROSEROCKET_COMMISSION_SINCE_DAYS ?? "0",
    10,
  );
  const floor = Math.max(defaultSinceDays(), envCommission || 0);
  if (!filterStartYmd) return floor;

  const startMs = Date.parse(`${filterStartYmd}T12:00:00`);
  if (Number.isNaN(startMs)) return floor;

  const daysToStart = Math.ceil((Date.now() - startMs) / 86400000);
  const bufferDays = parseInt(
    process.env.ROSEROCKET_COMMISSION_LOOKUP_BUFFER_DAYS ?? "21",
    10,
  );
  const sinceDays = Math.max(floor, daysToStart + bufferDays);
  console.log(
    `[InvoiceSent] Lookup fetch window: ${sinceDays} day(s) ` +
      `(lookup start ${filterStartYmd}, buffer ${bufferDays} day(s))`,
  );
  return sinceDays;
}

function filterRowsByDateRange(rows, start, end) {
  const s = String(start ?? "").slice(0, 10);
  const e = String(end ?? "").slice(0, 10);
  if (!s || !e) return rows;
  return rows.filter((r) => {
    const d = String(r.deliveredDate ?? "");
    return d && d >= s && d <= e;
  });
}

function filterRowsByCommissionRep(rows, repFilter) {
  const f = String(repFilter ?? "").trim();
  if (!f || f.toLowerCase() === "all") return rows;
  return rows.filter((r) => commissionRepForRow(r) === f);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// "Converted into CAD" column. RoseRocket stores every money field twice: the native amount
// (e.g. quote.sub_total_cost) and its own CAD conversion (quote.fx_sub_total_cost), computed with the
// org's Exchange Rates table — Settings → Accounting → Exchange rates, maintained weekly by the
// exchange-rate cron. Those RR figures are the authoritative ones, so this reports them verbatim
// instead of re-converting anything here; that is what keeps the sheet tied to the RoseRocket order
// screen. A CAD order carries no separate fx value, so its native amount passes straight through.
function rrCadAmount(nativeAmount, fxAmount, currency) {
  const fx = Number(fxAmount);
  if (Number.isFinite(fx) && fx > 0) return round2(fx);
  const native = Number(nativeAmount);
  if (!Number.isFinite(native)) return "";
  // A CAD amount needs no conversion, and zero converts to zero in any currency.
  if (native === 0 || String(currency ?? "cad").toLowerCase() === "cad") return round2(native);
  // Foreign currency with no RoseRocket conversion — leave blank rather than invent a rate.
  return "";
}

// RoseRocket often leaves actual at 0 until finalized — show estimated until actual is available.
function actualOrEstimated(actual, estimated) {
  const a = Number(actual);
  const e = Number(estimated);
  if (Number.isFinite(a) && a > 0) return a;
  if (Number.isFinite(e)) return e;
  return Number.isFinite(a) ? a : 0;
}

function legRevenue(leg, financial) {
  return actualOrEstimated(
    financial?.actual_revenue ?? leg?.actual_revenue,
    financial?.estimated_revenue ?? leg?.estimated_revenue,
  );
}

function legCost(leg, financial) {
  return actualOrEstimated(
    financial?.actual_cost ?? leg?.actual_cost,
    financial?.estimated_cost ?? leg?.estimated_cost,
  );
}

function partnerByLeg(trip) {
  if (!trip) return "";
  const name = String(trip.partner_carrier_name ?? "").trim();
  if (name) return name;
  return String(trip.driver_user_name ?? "").trim();
}

// RoseRocket customer name on CEL orders (e.g. Green Theory Design, Forte Opening Solutions).
function resolveCustomerName(order) {
  const name = String(order.location_name ?? "").trim();
  if (name) return name;
  return String(order.billing_org_name ?? "").trim();
}

function formatOrderStatus(order) {
  const raw = String(order.order_state_id ?? order.order_state ?? "").trim();
  if (!raw) return "";
  return raw
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizePersonName(name) {
  return String(name ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function formatCommissionees(commissionees) {
  if (!Array.isArray(commissionees) || commissionees.length === 0) return "";
  return commissionees
    .map((u) => {
      const name = normalizePersonName(
        `${u.profile_first_name ?? ""} ${u.profile_last_name ?? ""}`,
      );
      return name || String(u.profile_email ?? u.email ?? "").trim();
    })
    .filter(Boolean)
    .join("\n");
}

function commissionRepForRow(row) {
  const lines = String(row.onCommission ?? "")
    .split("\n")
    .map(normalizePersonName)
    .filter(Boolean);
  if (lines.length === 0) return "House";

  for (const line of lines) {
    const rep = NAMED_COMMISSION_REPS.find(
      (r) => normalizePersonName(r) === line,
    );
    if (rep) return rep;
  }
  return "House";
}

function commissionTabForRow(row, { period = "current" } = {}) {
  const rep = commissionRepForRow(row);
  if (rep === "House") {
    return period === "previous" ? HOUSE_PREVIOUS_TAB : HOUSE_CURRENT_TAB;
  }
  if (period === "previous")
    return commissionRepTabName(rep, COMMISSION_REP_PREVIOUS_SUFFIX);
  return commissionRepTabName(rep, COMMISSION_REP_CURRENT_SUFFIX);
}

function groupRowsByCommissionTab(rows) {
  const groups = new Map(COMMISSION_CURRENT_TABS.map((tab) => [tab, []]));
  for (const row of rows) {
    groups.get(commissionTabForRow(row)).push(row);
  }
  return groups;
}

function groupRowsByCommissionPreviousTab(rows) {
  const groups = new Map(COMMISSION_PREVIOUS_TABS.map((tab) => [tab, []]));
  for (const row of rows) {
    groups.get(commissionTabForRow(row, { period: "previous" })).push(row);
  }
  return groups;
}

// The order's delivered date is the FINAL delivery leg's date — the leg that carries the freight to its
// last destination. It drives the displayed date, which calendar month the order is counted in, and the
// FX date for the customer-revenue conversion. Legs whose type includes "delivery" are preferred; among
// those the latest delivered_at (then highest sequential_id) wins. Falls back to the latest leg overall.
function finalDeliveryLeg(legs) {
  const arr = Array.isArray(legs) ? legs : [];
  if (arr.length === 0) return null;
  const deliveries = arr.filter((l) =>
    String(l.trip_type_id ?? "").includes("delivery"),
  );
  const pool = deliveries.length ? deliveries : arr;
  let best = null;
  let bestMs = -Infinity;
  let bestSeq = -Infinity;
  for (const l of pool) {
    const ms = Date.parse(l.delivered_at ?? l.pod_date ?? "");
    const at = Number.isNaN(ms) ? -Infinity : ms;
    const seq = Number(l.sequential_id) || 0;
    if (at > bestMs || (at === bestMs && seq > bestSeq)) {
      best = l;
      bestMs = at;
      bestSeq = seq;
    }
  }
  return best ?? arr[0];
}

// Builds ONE row per order (not per leg). RoseRocket's currency model, confirmed against live CEL data:
//   - The customer invoice is order-level and lives on the QUOTE in its native currency
//     (quote.cost_currency_id): quote.sub_total_cost is the native charge without tax and
//     quote.fx_sub_total_cost is RoseRocket's CAD conversion of it. We report RR's CAD figure directly.
//   - Carrier cost is per leg and is ALREADY in RoseRocket's CAD base — even for a USD carrier
//     (master_trip.currency_id = "usd"), leg cost is the converted CAD amount, not native USD. So the
//     legs are simply summed; converting them again is what previously inflated the column.
//   - Fuel / accessorials are order-level (from the quote) and are counted ONCE, in native currency.
// All CAD conversion happens inside RoseRocket, against the org's weekly Exchange Rates table, so
// Total Revenue / Total Carrier Cost / Margin here tie out exactly to the RoseRocket order screen.
async function enrichOrder(api, order, tripCache) {
  const [legs, quotes, commissionees] = await Promise.all([
    fetchOrderLegs(api, order.id),
    fetchOrderQuotes(api, order.id),
    fetchOrderCommissionees(api, order.id).catch(() => []),
  ]);
  const quote = primaryQuote(quotes);
  const currency = String(
    quote?.cost_currency_id ?? order.total_value_currency_id ?? "cad",
  ).toUpperCase();
  const fuel = quote?.fuel_cost ?? "";
  const { accessorialNames, accessorialTotal } = parseAccessorials(quote);
  const finMap = legFinancialsMap(order);
  const customer = resolveCustomerName(order);
  const onCommission =
    formatCommissionees(commissionees) ||
    String(order.account_manager_name ?? "").trim();
  const csr = String(order.csr_name ?? "").trim();
  const orderStatus = formatOrderStatus(order);

  // Each leg's manifest (master trip) gives its carrier and the carrier-cost currency.
  const trips = await Promise.all(
    legs.map((l) => fetchMasterTrip(api, l.master_trip_id, tripCache)),
  );

  const finalLeg = finalDeliveryLeg(legs);
  const deliveredDate = finalLeg ? formatDeliveredDate(finalLeg) : "";

  // Native customer revenue (without tax) from the quote, paired with RoseRocket's own CAD conversion
  // of that same field, so the "Converted into CAD" column is RR's number rather than one of ours.
  const hasSubTotal = quote != null && quote.sub_total_cost != null;
  const revenueNative = quote
    ? Number((hasSubTotal ? quote.sub_total_cost : quote.total_cost) ?? 0)
    : legs.reduce(
        (sum, l) => sum + Number(legRevenue(l, finMap.get(l.id)) || 0),
        0,
      );
  const revenueFx = hasSubTotal ? quote.fx_sub_total_cost : quote?.fx_total_cost;
  const revenueCad = rrCadAmount(revenueNative, revenueFx, currency);

  // Sum the legs' carrier cost. RoseRocket already stores each leg's cost in CAD, converted with the
  // org's Exchange Rates table, so these are added as-is — the total matches the order screen's
  // "Total Costs (CAD)". Converting them a second time is what previously overstated USD manifests.
  let carrierCostCad = 0;
  const carrierNames = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const trip = trips[i];
    carrierCostCad += Number(legCost(leg, finMap.get(leg.id))) || 0;
    const name = partnerByLeg(trip) || String(leg.partner_carrier_name ?? "").trim();
    if (name && !carrierNames.includes(name)) carrierNames.push(name);
  }
  carrierCostCad = round2(carrierCostCad);

  const revCad = Number(revenueCad) || 0;
  const margin = round2(revCad - carrierCostCad);
  const marginPctValue = revCad
    ? Math.round(((revCad - carrierCostCad) / revCad) * 10000) / 100
    : "";

  const finalTrip = finalLeg ? trips[legs.indexOf(finalLeg)] : null;
  const dispatcher = String(
    finalTrip?.dispatcher_user_name ??
      order.dispatcher_user_name ??
      order.dispatch_name ??
      "",
  ).trim();

  return [
    {
      customer,
      legId: String(order.full_id ?? "").trim(),
      orderUuid: order.id,
      orderStatus,
      onCommission,
      revenue: revenueNative,
      currency,
      revenueCad,
      accessorialNames,
      accessorialTotal,
      fuel,
      carrierCost: carrierCostCad,
      margin,
      marginPct: marginPctValue,
      partnerByLeg: carrierNames.join("\n"),
      deliveredDate,
      dispatcher,
      csr,
    },
  ];
}

async function fetchInvoiceSentOrders({ sinceDays } = {}) {
  if (!CELOGISTICS_ORG_URL) {
    console.warn(
      "[InvoiceSent] ROSEROCKET_CELOGISTICS_ORG_URL not set — skipping CEL-* report.",
    );
    return [];
  }

  const batch = await fetchOrdersByState(CELOGISTICS_ORG_URL, INVOICE_SENT, {
    sinceDays,
  });
  const cel = batch.filter((o) =>
    String(o.full_id ?? "")
      .toUpperCase()
      .startsWith("CEL-"),
  );
  console.log(
    `[InvoiceSent] CEL-* invoice-sent: ${cel.length} of ${batch.length} in window`,
  );
  return cel.map((order) => ({ order, orgUrl: CELOGISTICS_ORG_URL }));
}

async function buildInvoiceSentRows(orderEntries) {
  const rows = [];
  const tripCache = new Map();

  for (let i = 0; i < orderEntries.length; i += ENRICH_CONCURRENCY) {
    const batch = orderEntries.slice(i, i + ENRICH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ order, orgUrl }) => {
        try {
          const api = await client(orgUrl);
          return await enrichOrder(api, order, tripCache);
        } catch (err) {
          console.warn(
            `[InvoiceSent] Skipped ${order.full_id}: ${err.message}`,
          );
          return [];
        }
      }),
    );
    for (const legRows of results) rows.push(...legRows);

    if (
      (i + ENRICH_CONCURRENCY) % 60 === 0 ||
      i + ENRICH_CONCURRENCY >= orderEntries.length
    ) {
      console.log(
        `[InvoiceSent] Enriched ${Math.min(i + ENRICH_CONCURRENCY, orderEntries.length)}/${orderEntries.length} orders → ${rows.length} leg rows`,
      );
    }
  }
  return rows;
}

const REPORT_COLUMNS = [
  { header: "Customer", getLabel: (r) => r.customer, width: 220 },
  {
    header: "Order ID",
    getLabel: (r) => r.legId,
    getUrl: (r) =>
      WEB && r.orderUuid ? `${WEB}/#/ops/orders/${r.orderUuid}` : "",
    width: 130,
  },
  { header: "Order Status", getLabel: (r) => r.orderStatus, width: 110 },
  {
    header: "Actual Delivered Date",
    getLabel: (r) => r.deliveredDate,
    width: 130,
  },
  { header: "On commission", getLabel: (r) => r.onCommission, width: 140 },
  {
    header: "Total Revenue without Tax",
    getLabel: (r) => r.revenue,
    width: 160,
    sum: true,
    format: "currency",
  },
  { header: "Currency", getLabel: (r) => r.currency, width: 70 },
  {
    header: "Converted into CAD",
    getLabel: (r) => r.revenueCad,
    width: 150,
    sum: true,
    format: "currency",
  },
  {
    header: "Accessorials",
    getLabel: (r) => r.accessorialNames,
    width: 220,
    wrap: true,
    hiddenByDefault: true,
  },
  {
    header: "Accessorial Total",
    getLabel: (r) => r.accessorialTotal,
    width: 120,
    sum: true,
    format: "currency",
  },
  {
    header: "Fuel (surcharge)",
    getLabel: (r) => r.fuel,
    width: 110,
    sum: true,
    format: "currency",
  },
  {
    header: "Total Carrier Cost",
    getLabel: (r) => r.carrierCost,
    width: 130,
    sum: true,
    format: "currency",
  },
  {
    header: "Margin $",
    getLabel: (r) => r.margin,
    width: 90,
    sum: true,
    format: "currency",
  },
  {
    header: "Margin %",
    getLabel: (r) => r.marginPct,
    width: 80,
    format: "percent",
    getTotalFormula: ({ totalsRow, colLetter, resolvedColumns }) => {
      const cadIdx = resolvedColumns.findIndex(
        (c) => c.header === "Converted into CAD",
      );
      const marginIdx = resolvedColumns.findIndex(
        (c) => c.header === "Margin $",
      );
      if (cadIdx < 0 || marginIdx < 0) return "";
      const cad = colLetter(cadIdx);
      const margin = colLetter(marginIdx);
      return `=IF(${cad}${totalsRow}=0,"",${margin}${totalsRow}/${cad}${totalsRow}*100)`;
    },
  },
  {
    header: "Partner Carrier by leg",
    getLabel: (r) => r.partnerByLeg,
    width: 180,
  },
  { header: "Dispatcher", getLabel: (r) => r.dispatcher, width: 140 },
  { header: "CSR", getLabel: (r) => r.csr, width: 140 },
];

async function ensureCommissionLookupFilters(spreadsheetId) {
  await ensureTab(spreadsheetId, COMMISSION_LOOKUP_TAB, {
    index: COMMISSION_LOOKUP_TAB_INDEX,
  });
  await moveTabToIndex(
    spreadsheetId,
    COMMISSION_LOOKUP_TAB,
    COMMISSION_LOOKUP_TAB_INDEX,
  );
  const values = await readTabValues(spreadsheetId, COMMISSION_LOOKUP_TAB);
  const { start, end } = previousMonthDateRange();
  const hasFilters = String(values[0]?.[0] ?? "").trim() === "Start date";

  const refreshValue = readRefreshLookupFromValues(values);

  if (!hasFilters) {
    const panel = [
      ["Start date", start],
      ["End date", end],
      ["On commission", "All"],
      ["Refresh lookup", ""],
      ["", "Filters above refresh on each sync. Dates use Eastern time."],
      ["", ""],
    ];
    await writeTabRange(spreadsheetId, COMMISSION_LOOKUP_TAB, "A1:B6", panel);
  } else {
    const row4Label = String(values[3]?.[0] ?? "")
      .trim()
      .toLowerCase();
    if (row4Label !== "refresh lookup") {
      await writeTabRange(
        spreadsheetId,
        COMMISSION_LOOKUP_TAB,
        "A4",
        [["Refresh lookup"]],
        "RAW",
      );
    }
    await writeTabRange(spreadsheetId, COMMISSION_LOOKUP_TAB, "A5:B6", [
      ["", "Filters above refresh on each sync. Dates use Eastern time."],
      ["", ""],
    ]);
    // Clear legacy column-C placement if present.
    if (
      String(values[0]?.[2] ?? "")
        .trim()
        .toLowerCase() === "refresh lookup"
    ) {
      await writeTabRange(spreadsheetId, COMMISSION_LOOKUP_TAB, "C1:C2", [
        [""],
        [""],
      ]);
    }
  }

  await applyCellDropdown(spreadsheetId, COMMISSION_LOOKUP_TAB, {
    rowIndex: 2,
    columnIndex: 1,
    values: COMMISSION_FILTER_OPTIONS,
    alignLeft: true,
  });
  await applyRefreshLookupDropdown(spreadsheetId, refreshValue);

  // Row 6 is a blank spacer; clear leftover headers from when data started on row 6.
  await clearTabRange(
    spreadsheetId,
    COMMISSION_LOOKUP_TAB,
    `A${LOOKUP_FILTER_ROW_COUNT}:ZZ${LOOKUP_FILTER_ROW_COUNT}`,
  );
}

async function readCommissionLookupFilters(spreadsheetId) {
  const values = await readTabValues(spreadsheetId, COMMISSION_LOOKUP_TAB);
  const { start: defaultStart, end: defaultEnd } = previousMonthDateRange();
  const start = parseSheetDate(values[0]?.[1]) || defaultStart;
  const end = parseSheetDate(values[1]?.[1]) || defaultEnd;
  const commission = String(values[2]?.[1] ?? "").trim() || "All";
  const refreshRaw = values[3]?.[1] ?? values[1]?.[2] ?? values[0]?.[2];
  const refreshLookup = parseRefreshLookupCell(refreshRaw, true);
  return { start, end, commission, refreshLookup };
}

// Builds the row set for a window reaching further back than the standard monthly fetch, reusing the
// already-enriched monthly rows and enriching only the orders they don't cover.
//
// Both the Lookup tab and the previous-month tabs need such a window, and enriching several hundred
// orders is by far the most expensive part of the sync. They used to call this independently, so the
// same pass ran twice every run — doubling the RoseRocket calls and the Google write pressure (which
// showed up as "Write requests per minute" quota retries). The caller now resolves the widest window
// once and shares the result; every consumer filters by delivery date afterwards, so a superset of
// orders yields exactly the same tabs.
async function buildExtendedLegRows(
  monthlyOrderEntries,
  monthlyLegRowsAll,
  sinceDays,
) {
  const standardSinceDays = defaultSinceDays();
  if (sinceDays <= standardSinceDays) {
    console.log(
      `[InvoiceSent] No extended fetch needed — reusing the ${standardSinceDays}-day order fetch.`,
    );
    return monthlyLegRowsAll;
  }

  console.log(
    `[InvoiceSent] Extended order fetch (${sinceDays} day(s)) for the Lookup and previous-month tabs...`,
  );
  const extendedEntries = await fetchInvoiceSentOrders({ sinceDays });
  if (extendedEntries.length === 0) {
    console.warn(
      "[InvoiceSent] Extended fetch returned 0 orders — using monthly leg rows.",
    );
    return monthlyLegRowsAll;
  }
  if (monthlyOrderEntries.length === 0) {
    return buildInvoiceSentRows(extendedEntries);
  }

  const monthlyIds = new Set(monthlyOrderEntries.map((e) => e.order.id));
  const extraEntries = extendedEntries.filter(
    (e) => !monthlyIds.has(e.order.id),
  );
  if (extraEntries.length === 0) return monthlyLegRowsAll;

  console.log(
    `[InvoiceSent] Enriching ${extraEntries.length} order(s) beyond the monthly window...`,
  );
  const extraRows = await buildInvoiceSentRows(extraEntries);
  return [...monthlyLegRowsAll, ...extraRows];
}

async function writeCommissionLookupTab(spreadsheetId, periodRows, filters) {
  const filtered = filterRowsByCommissionRep(periodRows, filters.commission);
  console.log(
    `[InvoiceSent] Commission Lookup tab (${filters.start} → ${filters.end}, ${filters.commission}): ` +
      `${filtered.length} leg row(s)`,
  );
  await writeToSheetWithRetry(spreadsheetId, COMMISSION_LOOKUP_TAB, filtered, {
    columns: REPORT_COLUMNS,
    headerRow: LOOKUP_HEADER_ROW,
  });
}

async function writeReportTabs(spreadsheetId, currentRows, previousRows) {
  const currentGroups = groupRowsByCommissionTab(currentRows);
  const previousGroups = groupRowsByCommissionPreviousTab(previousRows);
  const tabs = COMMISSION_TAB_ORDER.filter(
    (name) => name !== COMMISSION_LOOKUP_TAB,
  ).map((name) => {
    if (name === ALL_COMMISSION_CURRENT_TAB)
      return { name, records: currentRows };
    if (name === ALL_COMMISSION_PREVIOUS_TAB)
      return { name, records: previousRows };
    if (
      COMMISSION_REP_PREVIOUS_TABS.includes(name) ||
      name === HOUSE_PREVIOUS_TAB
    ) {
      return { name, records: previousGroups.get(name) ?? [] };
    }
    return { name, records: currentGroups.get(name) ?? [] };
  });

  for (let i = 0; i < tabs.length; i++) {
    const { name, records: tabRows } = tabs[i];
    await writeToSheetWithRetry(spreadsheetId, name, tabRows, {
      columns: REPORT_COLUMNS,
    });
    console.log(`[InvoiceSent]   ${name}: ${tabRows.length} leg row(s)`);
    if (i < tabs.length - 1) await sleep(4000);
  }
}

async function syncInvoiceSentReport(spreadsheetId) {
  console.log(
    `\n[InvoiceSent] Building "${TAB_NAME}" report (CEL-* / CE Logistics only)...`,
  );
  // Migrate the old long tab titles to the short ones in place (preserves the Lookup tab's filters).
  await renameTabs(spreadsheetId, LEGACY_TAB_RENAMES);
  await ensureCommissionLookupFilters(spreadsheetId);
  const lookupFilters = await readCommissionLookupFilters(spreadsheetId);
  const standardSinceDays = defaultSinceDays();

  console.log(
    `[InvoiceSent] Monthly tabs: ${standardSinceDays}-day order window → current-month delivery filter`,
  );
  const monthlyOrderEntries = await fetchInvoiceSentOrders({
    sinceDays: standardSinceDays,
  });
  const monthlyLegRowsAll = monthlyOrderEntries.length
    ? await buildInvoiceSentRows(monthlyOrderEntries)
    : [];

  // Resolve every window that reaches past the monthly fetch, then build the widest ONE time and share
  // it. The Lookup tab and the previous-month tabs each filter it by their own delivery-date range, so
  // one pass serves both instead of enriching the same orders twice.
  const prevRange = previousMonthDateRange();
  const extendedStarts = [prevRange.start];
  if (lookupFilters.refreshLookup) extendedStarts.push(lookupFilters.start);
  const extendedSinceDays = Math.max(
    ...extendedStarts.map(computeLookupFetchSinceDays),
  );
  const extendedLegRowsAll = await buildExtendedLegRows(
    monthlyOrderEntries,
    monthlyLegRowsAll,
    extendedSinceDays,
  );

  let lookupPeriodRows = [];
  if (lookupFilters.refreshLookup) {
    lookupPeriodRows = filterRowsByDateRange(
      extendedLegRowsAll,
      lookupFilters.start,
      lookupFilters.end,
    );
    console.log(
      `[InvoiceSent] Commission Lookup delivery period: ${lookupPeriodRows.length} of ${extendedLegRowsAll.length} leg row(s)`,
    );
    await writeCommissionLookupTab(
      spreadsheetId,
      lookupPeriodRows,
      lookupFilters,
    );
  } else {
    console.log(
      "[InvoiceSent] Commission Lookup refresh is disabled (Refresh lookup=OFF) — keeping existing tab data.",
    );
  }

  const monthlyRows = filterRowsByCurrentDeliveryMonth(monthlyLegRowsAll);
  const previousRows = filterRowsByPreviousDeliveryMonth(extendedLegRowsAll);

  await writeReportTabs(spreadsheetId, monthlyRows, previousRows);

  await removeUnwantedOpsSheets(spreadsheetId, COMMISSION_SHEET_TAB_ORDER);
  await reorderSheets(spreadsheetId, COMMISSION_SHEET_TAB_ORDER);
  console.log(
    `[InvoiceSent] Wrote ${monthlyRows.length} current-month leg row(s) and ${previousRows.length} previous-month leg row(s) ` +
      `from ${monthlyOrderEntries.length} order(s); ` +
      (lookupFilters.refreshLookup
        ? `Commission Lookup ${lookupPeriodRows.length} leg row(s) in ${lookupFilters.start} → ${lookupFilters.end}.`
        : "Commission Lookup refresh skipped (kept existing data)."),
  );
  return {
    orders: monthlyOrderEntries.length,
    rows: monthlyRows.length,
    previousRows: previousRows.length,
    lookupRows: lookupPeriodRows.length,
  };
}

module.exports = {
  syncInvoiceSentReport,
  TAB_NAME,
  ALL_COMMISSION_CURRENT_TAB,
  ALL_COMMISSION_PREVIOUS_TAB,
  HOUSE_CURRENT_TAB,
  HOUSE_PREVIOUS_TAB,
  COMMISSION_LOOKUP_TAB,
  COMMISSION_REP_CURRENT_TABS,
  COMMISSION_REP_PREVIOUS_TABS,
  COMMISSION_CURRENT_TABS,
  COMMISSION_PREVIOUS_TABS,
  COMMISSION_TABS,
  COMMISSION_KEEP_TABS,
  COMMISSION_TAB_ORDER,
  COMMISSION_SHEET_TAB_ORDER,
  REPORT_COLUMNS,
  ALL_REPORT_TABS: [
    ALL_COMMISSION_CURRENT_TAB,
    ALL_COMMISSION_PREVIOUS_TAB,
    ...COMMISSION_TABS,
  ],
};
