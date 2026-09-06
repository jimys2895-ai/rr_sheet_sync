require('dotenv').config();
const {
  fetchOrdersForOrg,
  resolveOrdersForHistory,
  fetchMasterTripStops,
  fetchMasterTripsSince,
  isDeliverySideStop,
  isPickupSideStop,
  manifestTurnOrdinal,
  manifestContextFromTrip,
  manifestTagNamesFromTrip,
  masterTripFinishedAt,
  outboundManifestMiles,
  inboundManifestMiles,
  rounderRevenueByTrip,
  fetchOrderQuotes,
  primaryQuote,
  freightRateCadFromQuote,
  fetchDriverTypes,
  normalizePersonKey,
  client,
} = require('./roserocket');
const {
  readTabValues, writeToSheetWithRetry, syncTable, setConfigCell, withGoogleRetry,
  writeTabRange, applyCellDropdown,
} = require('./sheets');

// The blue "Alternating colors" look the client set on the sheet: #5b95f9 header, white / light-blue
// striped body, #acc9fe footer (totals) line. Applied to the native Table + totals row on every run.
const rgb = (hex) => ({
  rgbColor: {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255,
  },
});
const BLUE_BANDING = {
  headerColorStyle: rgb('#5b95f9'),
  firstBandColorStyle: rgb('#ffffff'),
  secondBandColorStyle: rgb('#e8f0fe'),
  footerColorStyle: rgb('#acc9fe'),
};

// RoseRocket web host for the clickable Manifest ID links.
const WEB = (process.env.ROSEROCKET_WEB_URL ?? process.env.ROSEROCKET_ORG_URL ?? '').replace(/\/+$/, '');

// Historical archive of completed round trips. One row PER MANIFEST on each tab, added when the trip
// finishes (its inbound haul unloads back at the terminal). Each row is stamped with the week number of
// that finish date, and every tab shows that same week for a given manifest. The three tabs differ in
// which leg's economics they show:
//   - O/B tab: the end city (last delivery), the outbound footage/weight, and revenue/miles/RPM for the
//     OUTBOUND leg only (terminal → last delivery).
//   - I/B tab: the start city (first pickup), the inbound footage/weight, and revenue/miles/RPM for the
//     INBOUND leg only (last delivery → back to terminal).
//   - Rounder tab: the last drop city, and revenue/miles/RPM for the WHOLE trip.
// Outbound miles + inbound miles = rounder miles. Append-only in spirit: existing rows are read back and
// re-emitted unchanged (frozen), new completed manifests are merged in, everything is sorted by week and
// a totals row is written where RPM = total revenue ÷ total miles.
const OUTBOUND_TAB = 'O/B';
const INBOUND_TAB = 'I/B';
const ROUNDER_TAB = 'Rounder';
const KEY_HEADER = 'Manifest ID';

const US_COUNTRIES = new Set(['US', 'USA', 'United States']);
const CA_COUNTRIES = new Set(['CA', 'CAN', 'Canada']);
const LEG_CONCURRENCY = 6;

// Tagging a manifest forces it onto the archive whatever its shape — the manual override for a trip the
// geography rule cannot see (a full-load round trip whose orders aged out, say). Same tag names the live
// O/B and I/B sheets use, so a planner has one thing to remember, and the same env overrides.
function normalizeTagName(name) {
  return String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
const TRIGGER_TAGS = new Set(
  [
    process.env.OUTBOUND_TRIGGER_TAG || 'US O/B',
    process.env.INBOUND_TRIGGER_TAG || 'US I/B',
  ].map(normalizeTagName).filter(Boolean),
);
// A completed trip's OUTBOUND orders were delivered a few weeks before its inbound finished, so they can
// sit further back than the live sheets' default window. A wider window keeps the outbound footage/
// weight/revenue available (RoseRocket only returns those on the order LIST, not the detail, so an order
// that ages out loses them). Default 60 days; raise via TRIP_HISTORY_SINCE_DAYS to reach older backlog.
const SINCE_DAYS = parseInt(process.env.TRIP_HISTORY_SINCE_DAYS ?? '60', 10);

function extractSheetId(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}
function getTripHistorySheetId() {
  const raw = process.env.GOOGLE_TRIP_HISTORY_SHEET_ID;
  return raw ? extractSheetId(raw) : null;
}

// ISO-8601 week number (Mon-based, week 1 holds the year's first Thursday). Matches Outlook's week
// numbers in North America — July 25, 2026 lands in week 30, exactly as the client showed.
function isoWeek(dateStr) {
  const ms = Date.parse(dateStr);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  t.setUTCDate(t.getUTCDate() - day + 3); // move to this week's Thursday
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  return 1 + Math.round((t - firstThursday) / (7 * 24 * 3600 * 1000));
}

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
const rpmOf = (rev, miles) => (miles > 0 ? round2(rev / miles) : '');
const num = (v) => (Number.isFinite(Number(v)) && Number(v) !== 0 ? Number(v) : '');
// Miles rounded to a whole number for display (blank passes through); the Table's DOUBLE column shows
// the cell's own digits, so decimals are removed at the value, not via a number format.
const wholeMiles = (v) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) ? '' : Math.round(n);
};

// The tab is a native Google Sheets Table so the planner can filter/sort each column and drill down to a
// single driver (or OO vs CD). Layout: row 1 is a frozen config cell ("OO Cut" + the editable %), row 2
// is the Table header, data follows, and a totals row sits just below the Table.
const HEADER_ROW = 2; // 1-based; row 1 holds the frozen OO Cut config cell
const CUT_REF = '$B$1'; // the editable OO Cut % cell every OO Rev formula multiplies by
const colLetter = (i) => String.fromCharCode(65 + i); // A, B, … (the tabs stay well under 26 columns)
const OO_CUT_DEFAULT = 0.59; // 59% — the client's starting owner-operator cut

// Totals row helpers. SUBTOTAL(109,…) sums only the rows left VISIBLE by the Table's filter, so drilling
// into one driver makes the totals show that driver's numbers (and the grand total when nothing is
// filtered). Column letters are resolved from the live layout by header name.
const letterOf = (header, colLetterFn, resolvedColumns) =>
  colLetterFn(resolvedColumns.findIndex((c) => c.header === header));
const subtotal = (header) => ({
  getTotalFormula: ({ firstDataRow, lastDataRow, colLetter: cl, resolvedColumns }) => {
    const L = letterOf(header, cl, resolvedColumns);
    return `=SUBTOTAL(109,${L}${firstDataRow}:${L}${lastDataRow})`;
  },
});
const ratioTotal = (numHeader, denHeader) => ({
  format: 'currency',
  getTotalFormula: ({ firstDataRow, lastDataRow, colLetter: cl, resolvedColumns }) => {
    const n = letterOf(numHeader, cl, resolvedColumns);
    const d = letterOf(denHeader, cl, resolvedColumns);
    return `=IFERROR(SUBTOTAL(109,${n}${firstDataRow}:${n}${lastDataRow})/SUBTOTAL(109,${d}${firstDataRow}:${d}${lastDataRow}),"")`;
  },
});

// Driver type from RoseRocket, keyed off the (preserved) Driver name: "OO" owner-operator, "CD" company
// driver, blank if unknown. Only owner-operators get the OO Rev / OO RPM figures.
const isOwnerOp = (r, driverTypes) =>
  driverTypes.get(normalizePersonKey(r.Driver)) === 'owner-operator';
const driverTypeLabel = (r, driverTypes) => {
  const t = driverTypes.get(normalizePersonKey(r.Driver));
  return t === 'owner-operator' ? 'OO' : t === 'company-driver' ? 'CD' : '';
};

// Builds a tab's Table columns with the owner-operator additions: a Type flag after Driver; an OO Rev
// formula (that tab's Revenue × the shared OO Cut cell B1) after Revenue; an OO RPM formula (OO Rev ÷
// Miles) after RPM; then Notes. The editable OO Cut % lives in the frozen config cell above the Table, so
// it is NOT a column here — every OO Rev just references CUT_REF absolutely. The OO formulas point at
// cells by letter, resolved from this exact layout. `kind` is 'leg' (O/B, I/B — Feet/Weight) or 'rounder'.
function buildColumns(kind, driverTypes) {
  const cols = [
    { header: 'Completed', getLabel: (r) => r.Completed ?? '', width: 90 },
    { header: 'City', getLabel: (r) => r.City ?? '', width: 150 },
    { header: 'State', getLabel: (r) => r.State ?? '', width: 60 },
    { header: 'Driver', getLabel: (r) => r.Driver ?? '', width: 160 },
    { header: 'Type', getLabel: (r) => driverTypeLabel(r, driverTypes), width: 55 },
    { header: 'Manifest ID', getLabel: (r) => r['Manifest ID'] ?? '', width: 110 },
  ];
  if (kind === 'leg') {
    cols.push(
      { header: 'Feet', getLabel: (r) => r.Feet ?? '', width: 70, ...subtotal('Feet'), format: 'integer' },
      { header: 'Weight', getLabel: (r) => r.Weight ?? '', width: 85, ...subtotal('Weight'), format: 'integer' },
    );
  }
  cols.push(
    { header: 'Revenue', getLabel: (r) => r.Revenue ?? '', width: 95, ...subtotal('Revenue'), format: 'currency' },
    { header: 'OO Rev', getLabel: null, width: 95, ...subtotal('OO Rev'), format: 'currency' }, // formula set below
    // Miles show as whole numbers. The Table's DOUBLE column type renders the cell's own digits (it
    // ignores a number format), so the value itself is rounded; the RPM figures keep the precise ratio.
    { header: 'Miles', getLabel: (r) => wholeMiles(r.Miles), width: 85, ...subtotal('Miles'), format: 'integer' },
    { header: 'RPM', getLabel: null, width: 70, ...ratioTotal('Revenue', 'Miles') }, // live formula, set below
    { header: 'OO RPM', getLabel: null, width: 75, ...ratioTotal('OO Rev', 'Miles') }, // formula set below
    // A REAL date (not the "Week N" label), so week / month / year-over-year all become computable and
    // SUMIFS can compare against it. Deliberately sits just before Notes: the client's group-by views are
    // pinned to column POSITIONS that the API cannot read back, so inserting earlier would silently
    // repoint his filters onto the wrong columns.
    { header: 'Date', getLabel: (r) => r.Date ?? '', width: 100, format: 'date' },
    { header: 'Notes', getLabel: (r) => r.Notes ?? '', width: 260 },
  );
  const at = (h) => colLetter(cols.findIndex((c) => c.header === h));
  const revL = at('Revenue'), milesL = at('Miles'), ooRevL = at('OO Rev');
  const row = (i) => HEADER_ROW + 1 + i; // header on row 2, first data row on row 3
  // RPM is a LIVE formula (Revenue ÷ Miles), not a stored value, so a manual correction to the Miles cell
  // flows straight through to RPM (and, via SUBTOTAL, the trip total). Miles edits survive syncs because a
  // completed trip is frozen — its row is re-emitted from the sheet, not re-pulled from RoseRocket.
  cols.find((c) => c.header === 'RPM').getLabel = (r, i) =>
    `=IFERROR(${revL}${row(i)}/${milesL}${row(i)},"")`;
  cols.find((c) => c.header === 'OO Rev').getLabel = (r, i) =>
    isOwnerOp(r, driverTypes) ? `=${revL}${row(i)}*${CUT_REF}` : '';
  cols.find((c) => c.header === 'OO RPM').getLabel = (r, i) =>
    isOwnerOp(r, driverTypes) ? `=IFERROR(${ooRevL}${row(i)}/${milesL}${row(i)},"")` : '';
  return cols;
}

// ── By Driver ────────────────────────────────────────────────────────────────────────────────────────
// A per-driver roll-up of the three trip tabs. It exists because Google Sheets' native "group by" view
// cannot show a WEIGHTED rate: its aggregation menu offers only Sum / Average / Count / … , so a grouped
// RPM line is the average of each trip's RPM rather than total revenue ÷ total miles — a different (and
// wrong) number whenever the trips differ in length. This tab computes the real thing.
//
// Every figure is a LIVE formula over the source tab (COUNTIF/SUMIF on the Driver column), never a stored
// value, so a manual Miles correction or a change to a tab's OO Cut % flows straight through here on the
// next recalculation — no re-sync needed. One row per driver per leg; filter Leg to get a clean
// one-row-per-driver view, which also makes the SUBTOTAL totals row meaningful (unfiltered it spans all
// three legs, and Rounder already covers O/B + I/B, so the grand total double-counts by design).
const BY_DRIVER_TAB = 'By Driver';
const BY_DRIVER_HEADER_ROW = 1; // no OO Cut config cell here — the cut is already baked into the source OO Rev
// The three trip tabs and the record shape each is written with.
const TRIP_TABS = [
  { tab: OUTBOUND_TAB, kind: 'leg' },
  { tab: INBOUND_TAB, kind: 'leg' },
  { tab: ROUNDER_TAB, kind: 'rounder' },
];

const BY_DRIVER_LEGS = [
  { leg: 'O/B', tab: OUTBOUND_TAB, kind: 'leg' },
  { leg: 'I/B', tab: INBOUND_TAB, kind: 'leg' },
  { leg: 'Rounder', tab: ROUNDER_TAB, kind: 'rounder' },
];

const quoteTab = (title) => `'${String(title).replace(/'/g, "''")}'`;

// Column letters on a source tab, resolved from the same buildColumns layout that tab is written with —
// so reordering a column there can never leave these SUMIFs silently pointing at the wrong one.
function sourceLetters(kind, driverTypes) {
  const cols = buildColumns(kind, driverTypes);
  const at = (h) => colLetter(cols.findIndex((c) => c.header === h));
  return {
    driver: at('Driver'), revenue: at('Revenue'), ooRev: at('OO Rev'),
    miles: at('Miles'), date: at('Date'),
  };
}

// SUMIF/COUNTIF over a source tab's data rows. The range runs open-ended from the first data row, which
// also takes in that tab's totals row — harmless, because its Driver cell is blank and matches no name.
const byDriverAgg = (r, rowRef) => {
  const t = quoteTab(r.tab);
  const key = `${t}!$${r.L.driver}$${HEADER_ROW + 1}:$${r.L.driver}`;
  return {
    count: `=COUNTIF(${key},$A${rowRef})`,
    sum: (letter) => `=SUMIF(${key},$A${rowRef},${t}!$${letter}$${HEADER_ROW + 1}:$${letter})`,
  };
};

function buildByDriverColumns(driverTypes) {
  const cols = [
    { header: 'Driver', getLabel: (r) => r.Driver, width: 160, getTotalValue: () => 'Total' },
    { header: 'Type', getLabel: (r) => driverTypeLabel(r, driverTypes), width: 55 },
    { header: 'Leg', getLabel: (r) => r.leg, width: 80 },
    { header: 'Trips', getLabel: null, width: 70, ...subtotal('Trips'), format: 'integer' },
    { header: 'Revenue', getLabel: null, width: 105, ...subtotal('Revenue'), format: 'currency' },
    { header: 'OO Rev', getLabel: null, width: 105, ...subtotal('OO Rev'), format: 'currency' },
    { header: 'Miles', getLabel: null, width: 90, ...subtotal('Miles'), format: 'integer' },
    { header: 'RPM', getLabel: null, width: 70, ...ratioTotal('Revenue', 'Miles') },
    { header: 'OO RPM', getLabel: null, width: 75, ...ratioTotal('OO Rev', 'Miles') },
  ];
  const at = (h) => colLetter(cols.findIndex((c) => c.header === h));
  const revL = at('Revenue'), ooRevL = at('OO Rev'), milesL = at('Miles');
  const row = (i) => BY_DRIVER_HEADER_ROW + 1 + i;
  const set = (h, fn) => { cols.find((c) => c.header === h).getLabel = fn; };
  set('Trips', (r, i) => byDriverAgg(r, row(i)).count);
  set('Revenue', (r, i) => byDriverAgg(r, row(i)).sum(r.L.revenue));
  set('OO Rev', (r, i) => byDriverAgg(r, row(i)).sum(r.L.ooRev));
  set('Miles', (r, i) => byDriverAgg(r, row(i)).sum(r.L.miles));
  // The weighted rates the group-by view can't express: totals divided, not rates averaged.
  set('RPM', (r, i) => `=IFERROR(${revL}${row(i)}/${milesL}${row(i)},"")`);
  set('OO RPM', (r, i) => `=IFERROR(${ooRevL}${row(i)}/${milesL}${row(i)},"")`);
  return cols;
}

// Rebuilt from scratch on every write — it holds no frozen state of its own, only formulas pointing at
// the three trip tabs, so the driver list always matches whoever is actually on them.
async function updateByDriverTab(sheetId, driverTypes, driverSets) {
  const drivers = new Set();
  for (const names of driverSets) for (const n of names) drivers.add(n);
  const sorted = [...drivers].sort((a, b) => a.localeCompare(b));
  const letters = new Map(BY_DRIVER_LEGS.map((l) => [l.leg, sourceLetters(l.kind, driverTypes)]));
  const records = sorted.flatMap((Driver) =>
    BY_DRIVER_LEGS.map((l) => ({ Driver, leg: l.leg, tab: l.tab, L: letters.get(l.leg) })));
  if (!records.length) return;
  const columns = buildByDriverColumns(driverTypes);
  await writeToSheetWithRetry(sheetId, BY_DRIVER_TAB, records, {
    columns, headerRow: BY_DRIVER_HEADER_ROW,
  });
  await withGoogleRetry(() => syncTable(sheetId, BY_DRIVER_TAB, {
    headerRowIndex: BY_DRIVER_HEADER_ROW - 1,
    dataRowCount: records.length,
    columns,
    palette: BLUE_BANDING,
  }), `table "${BY_DRIVER_TAB}"`, { baseDelayMs: 8000 });
  console.log(
    `[TripHistory] ${BY_DRIVER_TAB}: ${sorted.length} driver(s) × ${BY_DRIVER_LEGS.length} legs`
      + ` → ${records.length} rows.`,
  );
}

// ── Compare ──────────────────────────────────────────────────────────────────────────────────────────
// Two date ranges side by side, per driver, for one leg. This is what makes month-over-month and
// year-over-year analysis possible: pick any two periods (weeks 1–4 vs 5–9, June vs July, 2026 vs 2027)
// and read the difference. It leans entirely on the Date column — the "Week N" label carries no year and
// no month, so it cannot answer these questions on its own.
//
// Layout: rows 1–3 are the pickers, row 5 the Table header. writeToSheet clears only from the header row
// down, so the pickers survive every sync untouched and are seeded once, on creation.
const COMPARE_TAB = 'Compare';
const COMPARE_HEADER_ROW = 5;
const COMPARE_LEG_CELL = '$B$1';   // which tab the whole comparison reads from
const COMPARE_A = { from: '$B$2', to: '$C$2' };
const COMPARE_B = { from: '$B$3', to: '$C$3' };

// Every figure is resolved against all three tabs and picked by the Leg cell. Two deliberate choices:
//
//   NOT INDIRECT — real references break loudly if a tab is renamed and can be traced with Sheets' own
//   dependency tools, where a string-built range fails silently. The three tabs also disagree on column
//   letters (the leg tabs carry Feet/Weight, Rounder does not), which INDIRECT would have to rebuild.
//
//   NOT SWITCH — nested IF instead, purely so File → Download → Microsoft Excel produces a working
//   workbook. SWITCH postdates Excel 2007, so Google writes it into the .xlsx as `_xlfn.SWITCH`, which
//   older Excel cannot resolve: every Compare cell came through as #NAME?, and the Δ columns inherited it.
//   IF is understood by every version. It is the ONLY function on this sheet that had that problem.
function compareLegPick(fn) {
  const branches = BY_DRIVER_LEGS.map((l) => ({ leg: l.leg, expr: fn(l) }));
  let built = branches[branches.length - 1].expr; // the last leg is the fallback
  for (let i = branches.length - 2; i >= 0; i--) {
    built = `IF(${COMPARE_LEG_CELL}="${branches[i].leg}",${branches[i].expr},${built})`;
  }
  return `=${built}`;
}

// COUNTIFS/SUMIFS over one tab, bounded by a period's two date cells. Ranges run open-ended from the
// first data row; the totals row below the Table has a blank Driver and matches nothing.
const periodArgs = (tab, L, period) => {
  const t = quoteTab(tab);
  const d = `${t}!$${L.date}$${HEADER_ROW + 1}:$${L.date}`;
  return `${t}!$${L.driver}$${HEADER_ROW + 1}:$${L.driver},$A%ROW%,${d},">="&${period.from},${d},"<="&${period.to}`;
};
const countIn = (tab, L, period) => `COUNTIFS(${periodArgs(tab, L, period)})`;
const sumIn = (tab, L, period, letter) =>
  `SUMIFS(${quoteTab(tab)}!$${letter}$${HEADER_ROW + 1}:$${letter},${periodArgs(tab, L, period)})`;

// Totals-row difference between two ratios — B's rate minus A's — computed from the SUBTOTAL sums rather
// than by adding up the per-driver deltas, which would weight every driver equally regardless of miles.
const ratioDiffTotal = (numB, denB, numA, denA) => ({
  format: 'currency',
  getTotalFormula: ({ firstDataRow, lastDataRow, colLetter: cl, resolvedColumns }) => {
    const L = (h) => letterOf(h, cl, resolvedColumns);
    const st = (h) => `SUBTOTAL(109,${L(h)}${firstDataRow}:${L(h)}${lastDataRow})`;
    return `=IFERROR(${st(numB)}/${st(denB)}-${st(numA)}/${st(denA)},"")`;
  },
});

function buildCompareColumns(driverTypes) {
  const letters = new Map(BY_DRIVER_LEGS.map((l) => [l.leg, sourceLetters(l.kind, driverTypes)]));
  const L = (l) => letters.get(l.leg);
  const cols = [
    { header: 'Driver', getLabel: (r) => r.Driver, width: 160, getTotalValue: () => 'Total' },
    { header: 'Type', getLabel: (r) => driverTypeLabel(r, driverTypes), width: 55 },
  ];
  const period = [
    { key: 'A', range: COMPARE_A },
    { key: 'B', range: COMPARE_B },
  ];
  for (const p of period) {
    cols.push(
      { header: `${p.key} Trips`, getLabel: null, width: 70, ...subtotal(`${p.key} Trips`), format: 'integer' },
      { header: `${p.key} Revenue`, getLabel: null, width: 105, ...subtotal(`${p.key} Revenue`), format: 'currency' },
      { header: `${p.key} OO Rev`, getLabel: null, width: 105, ...subtotal(`${p.key} OO Rev`), format: 'currency' },
      { header: `${p.key} Miles`, getLabel: null, width: 85, ...subtotal(`${p.key} Miles`), format: 'integer' },
      { header: `${p.key} RPM`, getLabel: null, width: 70, ...ratioTotal(`${p.key} Revenue`, `${p.key} Miles`) },
      { header: `${p.key} OO RPM`, getLabel: null, width: 80, ...ratioTotal(`${p.key} OO Rev`, `${p.key} Miles`) },
    );
  }
  cols.push(
    { header: 'Δ Revenue', getLabel: null, width: 105, ...subtotal('Δ Revenue'), format: 'currency' },
    { header: 'Δ Miles', getLabel: null, width: 85, ...subtotal('Δ Miles'), format: 'integer' },
    { header: 'Δ RPM', getLabel: null, width: 80, ...ratioDiffTotal('B Revenue', 'B Miles', 'A Revenue', 'A Miles') },
  );

  const at = (h) => colLetter(cols.findIndex((c) => c.header === h));
  const row = (i) => COMPARE_HEADER_ROW + 1 + i;
  const set = (h, fn) => { cols.find((c) => c.header === h).getLabel = fn; };
  const forRow = (expr, i) => expr.replace(/%ROW%/g, String(row(i)));

  for (const p of period) {
    set(`${p.key} Trips`, (r, i) => forRow(compareLegPick((l) => countIn(l.tab, L(l), p.range)), i));
    set(`${p.key} Revenue`, (r, i) => forRow(compareLegPick((l) => sumIn(l.tab, L(l), p.range, L(l).revenue)), i));
    set(`${p.key} OO Rev`, (r, i) => forRow(compareLegPick((l) => sumIn(l.tab, L(l), p.range, L(l).ooRev)), i));
    set(`${p.key} Miles`, (r, i) => forRow(compareLegPick((l) => sumIn(l.tab, L(l), p.range, L(l).miles)), i));
    set(`${p.key} RPM`, (r, i) => `=IFERROR(${at(`${p.key} Revenue`)}${row(i)}/${at(`${p.key} Miles`)}${row(i)},"")`);
    set(`${p.key} OO RPM`, (r, i) => `=IFERROR(${at(`${p.key} OO Rev`)}${row(i)}/${at(`${p.key} Miles`)}${row(i)},"")`);
  }
  set('Δ Revenue', (r, i) => `=${at('B Revenue')}${row(i)}-${at('A Revenue')}${row(i)}`);
  set('Δ Miles', (r, i) => `=${at('B Miles')}${row(i)}-${at('A Miles')}${row(i)}`);
  // Blank unless BOTH periods actually ran miles. Sheets coerces the empty string an unused period's RPM
  // leaves behind to 0, which would otherwise report a driver's absence as a full-rate swing.
  set('Δ RPM', (r, i) =>
    `=IF(OR(${at('A Miles')}${row(i)}=0,${at('B Miles')}${row(i)}=0),"",`
    + `${at('B RPM')}${row(i)}-${at('A RPM')}${row(i)})`);
  return cols;
}

// Month boundaries for the seeded defaults: last full month as A, the current month as B. Written once,
// on creation, and never touched again — from then on the pickers belong to the planner.
const monthEdge = (offset, end = false) => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + (end ? 1 : 0), 1));
  if (end) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

// Seeds rows 1–3 only when the Leg cell is empty, so a planner's chosen periods are never overwritten.
async function seedCompareConfig(sheetId) {
  const grid = await readTabValues(sheetId, COMPARE_TAB).catch(() => []);
  if (String(grid?.[0]?.[1] ?? '').trim()) return false;
  await writeTabRange(sheetId, COMPARE_TAB, 'A1:C3', [
    ['Leg', ROUNDER_TAB, ''],
    ['Period A', monthEdge(-1), monthEdge(-1, true)],
    ['Period B', monthEdge(0), monthEdge(0, true)],
  ]);
  await withGoogleRetry(() => applyCellDropdown(sheetId, COMPARE_TAB, {
    rowIndex: 0, columnIndex: 1, values: BY_DRIVER_LEGS.map((l) => l.leg), alignLeft: true,
  }), `compare leg dropdown`, { baseDelayMs: 8000 });
  return true;
}

async function updateCompareTab(sheetId, driverTypes, driverSets) {
  const drivers = new Set();
  for (const names of driverSets) for (const n of names) drivers.add(n);
  const records = [...drivers].sort((a, b) => a.localeCompare(b)).map((Driver) => ({ Driver }));
  if (!records.length) return;
  const columns = buildCompareColumns(driverTypes);
  await writeToSheetWithRetry(sheetId, COMPARE_TAB, records, {
    columns, headerRow: COMPARE_HEADER_ROW,
  });
  const seeded = await seedCompareConfig(sheetId);
  await withGoogleRetry(() => syncTable(sheetId, COMPARE_TAB, {
    headerRowIndex: COMPARE_HEADER_ROW - 1,
    dataRowCount: records.length,
    columns,
    palette: BLUE_BANDING,
  }), `table "${COMPARE_TAB}"`, { baseDelayMs: 8000 });
  console.log(
    `[TripHistory] ${COMPARE_TAB}: ${records.length} driver(s)${seeded ? ' — pickers seeded' : ''}.`,
  );
}

// Footage, weight and line-haul revenue for a set of orders on one leg of the trip. Footage/weight come
// off the order LIST row (`ordersById`) — RoseRocket does NOT return them on the order detail endpoint —
// so an order that fell outside the fetch window is unrecoverable and reported via `resolved`.
async function sumOrderFigures(api, orderIds, ordersById) {
  let rev = 0, feet = 0, weight = 0, resolved = 0;
  for (let i = 0; i < orderIds.length; i += LEG_CONCURRENCY) {
    const batch = orderIds.slice(i, i + LEG_CONCURRENCY);
    await Promise.all(batch.map(async (oid) => {
      const o = ordersById.get(oid);
      if (!o) return;
      resolved += 1;
      feet += Number(o.total_linear_feet) || 0;
      weight += Number(o.total_weight_lb) || 0;
      const quote = primaryQuote(await fetchOrderQuotes(api, oid).catch(() => []));
      rev += Number(freightRateCadFromQuote(quote, o)) || 0;
    }));
  }
  return { rev: round2(rev), feet, weight, resolved };
}

// Order ids for one side of the trip, taken from the TASKS rather than the stops: a stop's role says
// which side it belongs to, but an "exchange" stop (drop and reload at one address) belongs to BOTH — its
// destination task is the outbound order and its origin task is the inbound one. Reading the task's own
// leg_location_type splits them correctly and is a no-op on plain delivery/pickup stops, whose tasks all
// carry the matching type anyway.
const taskOrderIds = (stops, locationType) => [
  ...new Set(
    stops.flatMap((s) =>
      (s.tasks ?? [])
        .filter(
          (t) => String(t?.leg_location_type ?? '').toLowerCase() === locationType && t.order_id,
        )
        .map((t) => t.order_id),
    ),
  ),
];

// Resolves everything needed for one completed manifest's three rows from its stops, splitting the trip
// at the TURN (see manifestTurnOrdinal): deliveries up to the turn are the outbound run, pickups after it
// are the inbound run. On the ordinary yard shape that is simply "all deliveries" / "all pickups"; on a
// full-load round trip (P-CA → D-US → P-US → D-CA) it is what keeps the Canadian pickup off the inbound
// row and the Canadian delivery off the outbound row.
//
// `candidate.ibRecords` are the already-resolved US→CA orders (they carry _freightRate, footage, weight);
// they stay the source of the inbound figures so those numbers match what earlier runs archived. A
// manifest reached only by its TAG has no such records, so its inbound side is derived from the stops
// instead, exactly like the outbound side.
async function resolveManifest(api, tripId, candidate, ordersById, stopCache) {
  const { ctx, ibRecords = [], finishedAt = null } = candidate;
  const stops = await fetchMasterTripStops(api, tripId, stopCache);
  // Every figure except the manifest's own mileage is derived from the stops, so without them a row
  // would be archived showing a Manifest ID, a week and nothing else — and the de-dup would then treat
  // that hollow row as done forever. fetchMasterTripStops answers [] both for a manifest that genuinely
  // has no stops and for one whose fetch failed, so refuse either way and let the run retry it later.
  if (!stops.length) {
    throw new Error('no stops returned — not archiving a row with no city, mileage or revenue');
  }
  const ordered = [...stops].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  // turn == null means the manifest never delivered in the US, so it has NO outbound run — the whole
  // thing is an inbound haul and every pickup belongs to it. The turn stop itself sits on both sides: it
  // is where the outbound freight comes off and the inbound freight goes on.
  const turn = manifestTurnOrdinal(stops);
  const outboundStops = turn == null ? [] : ordered.filter((s) => s.ordinal <= turn);
  const inboundStops = ordered.filter((s) => turn == null || s.ordinal >= turn);
  const lastDelivery = outboundStops.filter(isDeliverySideStop).pop();
  const firstPickup = inboundStops.filter(isPickupSideStop)[0];

  const obMiles = outboundManifestMiles(stops);
  const ibMiles = inboundManifestMiles(stops);
  const rounderMiles = ctx.rounderMiles;

  const obOrderIds = taskOrderIds(outboundStops, 'destination');
  const ob = await sumOrderFigures(api, obOrderIds, ordersById);

  let ibRev = 0, ibFeet = 0, ibWeight = 0;
  let ibOrderIds = [];
  let ibResolved = ibRecords.length;
  if (ibRecords.length) {
    for (const r of ibRecords) {
      ibRev += Number(r.order._freightRate) || 0;
      ibFeet += Number(r.order.total_linear_feet) || 0;
      ibWeight += Number(r.order.total_weight_lb) || 0;
    }
  } else {
    ibOrderIds = taskOrderIds(inboundStops, 'origin');
    const ib = await sumOrderFigures(api, ibOrderIds, ordersById);
    ({ rev: ibRev, feet: ibFeet, weight: ibWeight, resolved: ibResolved } = ib);
  }
  // Whole-trip revenue: RoseRocket's own on-manifest leg total (matches the live I/B sheet's Rounder
  // Rate the client copied), falling back to outbound + inbound if it can't be computed.
  const rateByTrip = await rounderRevenueByTrip(api, [tripId], stopCache);
  const rounderRev = round2(rateByTrip.get(tripId) ?? (ob.rev + ibRev));

  // The trip-finish date: when the inbound haul ended (terminal unload, or the direct delivery that
  // replaces it on a full-load run). A manifest reached only by its tag has no inbound order to date it
  // from, so it falls back to the manifest's own completed_at.
  const completedAt = ibRecords
    .map((r) => r.completedAt)
    .filter(Boolean)
    .sort()
    .pop() ?? finishedAt;
  const wk = completedAt ? isoWeek(completedAt) : '';
  const week = wk === '' ? '' : `Week ${wk}`;
  const completedDate = completedAt ? String(completedAt).slice(0, 10) : '';

  return {
    tripId,
    fullId: ctx.fullId,
    driver: ctx.driver || '',
    week,
    completedDate,
    endCity: lastDelivery?.city || '',
    endState: lastDelivery?.state || '',
    startCity: firstPickup?.city || '',
    startState: firstPickup?.state || '',
    obRev: ob.rev, obFeet: ob.feet, obWeight: ob.weight, obMiles: obMiles ?? '',
    ibRev: round2(ibRev), ibFeet, ibWeight, ibMiles: ibMiles ?? '',
    rounderRev: round2(rounderRev), rounderMiles: rounderMiles ?? '',
    // A leg that HAS orders but resolved none of them has aged out of the fetch window — its footage,
    // weight and revenue are gone, so the trip is skipped rather than archived half-blank.
    agedOut:
      (obOrderIds.length > 0 && ob.resolved === 0) ||
      (ibOrderIds.length > 0 && ibResolved === 0),
  };
}

// Clickable Manifest ID cell (plain text if no web host configured).
function manifestCell(m) {
  return WEB && m.tripId ? `=HYPERLINK("${WEB}/#/ops/manifests/${m.tripId}","${m.fullId}")` : m.fullId;
}

function obRecord(m) {
  return {
    Completed: m.week, Date: m.completedDate, City: m.endCity, State: m.endState, Driver: m.driver,
    'Manifest ID': manifestCell(m), Feet: num(m.obFeet), Weight: num(m.obWeight),
    Revenue: m.obRev || '', Miles: m.obMiles || '',
    RPM: rpmOf(Number(m.obRev) || 0, Number(m.obMiles) || 0), Notes: '',
  };
}
function ibRecord(m) {
  return {
    Completed: m.week, Date: m.completedDate, City: m.startCity, State: m.startState, Driver: m.driver,
    'Manifest ID': manifestCell(m), Feet: num(m.ibFeet), Weight: num(m.ibWeight),
    Revenue: m.ibRev || '', Miles: m.ibMiles || '',
    RPM: rpmOf(Number(m.ibRev) || 0, Number(m.ibMiles) || 0), Notes: '',
  };
}
function rounderRecord(m) {
  // Last-drop (end) city; a pure-inbound trip has no delivery, so fall back to its first-pickup city.
  return {
    Completed: m.week, Date: m.completedDate, City: m.endCity || m.startCity, State: m.endState || m.startState, Driver: m.driver,
    'Manifest ID': manifestCell(m), Revenue: m.rounderRev || '', Miles: m.rounderMiles || '',
    RPM: rpmOf(Number(m.rounderRev) || 0, Number(m.rounderMiles) || 0),
  };
}

async function archivedManifestIds(sheetId, tab) {
  const grid = await readTabValues(sheetId, tab).catch(() => []);
  // The header is on row 2 once the tab is a Table (config cell above it), row 1 before — find it by the
  // Manifest ID column so already-archived trips are recognised and not needlessly re-resolved each run.
  let hIdx = grid.findIndex((r) => Array.isArray(r) && r.includes(KEY_HEADER));
  if (hIdx < 0) hIdx = 0;
  const header = grid[hIdx] ?? [];
  const idx = header.indexOf(KEY_HEADER);
  const ids = new Set();
  if (idx >= 0) for (const row of grid.slice(hIdx + 1)) {
    const k = manifestKey(row[idx]);
    if (k) ids.add(k);
  }
  return ids;
}

const weekNum = (v) => Number(String(v ?? '').match(/\d+/)?.[0]) || 0;
// Chronological order. The Date column is authoritative; "Week N" is only a fallback for rows archived
// before Date existed, and on its own it interleaves years (week 1 of 2027 sorting above week 52 of 2026).
//
// A Date reaches us in two shapes: the ISO string the resolver produces for a freshly archived trip, and
// — for a row read back off the sheet — a Google Sheets DATE serial (days since 1899-12-30). Date.parse
// does NOT reject a bare serial: it reads "46258" as the YEAR 46258. Left unhandled that sorts every
// existing row a few millennia after every new one, so each newly archived trip lands at the TOP of the
// sheet instead of the bottom.
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30); // serial 0; serial 1 is 1899-12-31
const MAX_DATE_SERIAL = 200000; // ~year 2447 — anything larger is not a date serial
const dateMs = (v) => {
  if (v === '' || v == null) return null;
  const raw = typeof v === 'number' ? v : String(v).trim();
  const serial = typeof raw === 'number' ? raw : (/^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN);
  if (Number.isFinite(serial)) {
    return serial > 0 && serial < MAX_DATE_SERIAL ? SHEETS_EPOCH_MS + serial * 86400000 : null;
  }
  // Only ISO (2026-08-24, what the resolver emits) or the US form Sheets renders (8/24/2026). Date.parse
  // is far too permissive to use bare here — it turns "Week 34" into 2034-01-01 — and this column is
  // hand-editable, so anything unrecognised is better treated as undated than as a fabricated date.
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw) && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
};
const rowOrder = (a, b) => {
  const da = dateMs(a.Date), db = dateMs(b.Date);
  if (da !== null && db !== null) return da - db;
  if (da !== null) return 1;  // dated rows are newer than the undated backlog
  if (db !== null) return -1;
  return weekNum(a.Completed) - weekNum(b.Completed);
};
// A Manifest ID cell may be a =HYPERLINK formula; the de-dup key is its display id (last quoted arg).
const manifestKey = (cell) => {
  const s = String(cell ?? '');
  const m = s.match(/=HYPERLINK\([^,]*,\s*"([^"]*)"\)/i);
  return (m ? m[1] : s).trim();
};

// Reads back the editable OO Cut rate. The current layout keeps it in the config cell above the header
// (row 1); a pre-Table sheet kept it in an "OO Cut" column on the first data row. Handles both so the
// planner's rate survives the one-time migration, defaulting to 59% if neither is present/valid.
function readCutValue(grid, headerRowIdx, header, dataRows) {
  if (headerRowIdx >= 1) {
    const cfg = grid[headerRowIdx - 1] ?? [];
    const v = cfg.map(Number).find((n) => Number.isFinite(n) && n > 0 && n <= 1);
    if (v) return v;
  } else {
    const idx = header.indexOf('OO Cut');
    const v = idx >= 0 ? Number(dataRows[0]?.[idx]) : NaN;
    if (Number.isFinite(v) && v > 0) return v;
  }
  return OO_CUT_DEFAULT;
}

// Read-modify-write one tab: keep the existing (frozen) rows, merge in new manifests keyed by Manifest
// ID, sort by week, rewrite with a SUBTOTAL totals row, then wrap the header+data in a native Table so
// the planner can filter/drill down. Reads FORMULA so existing hyperlinks (Manifest ID) and raw numbers
// both round-trip. Type / OO Rev / OO RPM are recomputed each write; the OO Cut % cell is read back (from
// wherever the layout keeps it) and rewritten to row 1 so manual edits survive.
// dropKeys removes manifests from the tab instead of keeping them — the repair path. Rows are otherwise
// frozen forever, so this is the only way a row archived from a failed fetch can be taken back out and
// re-resolved on the next run.
async function updateTab(
  sheetId, tab, kind, driverTypes, newRecords,
  { dropKeys = null, dateByManifest = null, overwriteDates = false } = {},
) {
  const grid = await readTabValues(sheetId, tab, { valueRenderOption: 'FORMULA' }).catch(() => []);
  // The header is wherever the Manifest ID column lives (row 1 pre-migration, row 2 once the Table exists).
  let headerRowIdx = grid.findIndex((r) => Array.isArray(r) && r.includes(KEY_HEADER));
  if (headerRowIdx < 0) headerRowIdx = 0;
  const header = grid[headerRowIdx] ?? [];
  const dataRows = grid.slice(headerRowIdx + 1);
  const cutValue = readCutValue(grid, headerRowIdx, header, dataRows);

  const keyIdx = header.indexOf(KEY_HEADER);
  const existing = [];
  const seen = new Set();
  let dropped = 0;
  let filledDates = 0;
  if (keyIdx >= 0) {
    for (const row of dataRows) {
      const key = manifestKey(row[keyIdx]);
      if (!key) continue; // skips the blank-key totals row
      if (dropKeys?.has(key)) { dropped++; continue; }
      const rec = {};
      header.forEach((h, i) => { rec[h] = row[i] ?? ''; });
      // Backfill the Date of a row archived before the column existed. Only ever FILLS a blank — a date
      // already on the sheet (or hand-corrected) is left alone, same as Miles and Notes. overwriteDates
      // is the escape hatch for re-running the backfill against a corrected source.
      if (dateByManifest && (overwriteDates || !String(rec.Date ?? '').trim())) {
        const d = dateByManifest.get(key);
        if (d && d !== rec.Date) { rec.Date = d; filledDates++; }
      }
      existing.push(rec);
      seen.add(key);
    }
  }
  const added = newRecords.filter((r) => !seen.has(manifestKey(r[KEY_HEADER])));
  const all = [...existing, ...added].sort(rowOrder);
  const columns = buildColumns(kind, driverTypes);

  // Header + data + totals go from row 2 down (writeToSheet clears only A2:ZZ, leaving row 1 alone). The
  // config cell and Table writes retry on transient Sheets quota errors, same as the row write.
  await writeToSheetWithRetry(sheetId, tab, all, { columns, headerRow: HEADER_ROW });
  // The frozen OO Cut config cell on row 1 — rewritten with the value we just read so edits round-trip.
  await withGoogleRetry(() => setConfigCell(sheetId, tab, {
    label: 'OO Cut', value: cutValue, numberFormat: { type: 'PERCENT', pattern: '0.00%' },
  }), `config "${tab}"`, { baseDelayMs: 8000 });
  // Wrap header+data in the native Table (excludes the config row above and the totals row below), size
  // it to the current rows, apply the blue palette, and freeze rows 1–2.
  await withGoogleRetry(() => syncTable(sheetId, tab, {
    headerRowIndex: HEADER_ROW - 1,
    dataRowCount: all.length,
    columns,
    palette: BLUE_BANDING,
  }), `table "${tab}"`, { baseDelayMs: 8000 });
  console.log(
    `[TripHistory] ${tab}: ${existing.length} kept, ${added.length} added` +
      (dropped ? `, ${dropped} removed` : '') +
      (filledDates ? `, ${filledDates} date(s) backfilled` : '') + ` → ${all.length} rows.`,
  );
  // Distinct driver names on the tab, for the By Driver roll-up. Taken from what was just written
  // (existing rows included), so it covers the whole archive rather than only this run's new trips.
  const drivers = [...new Set(all.map((r) => String(r.Driver ?? '').trim()).filter(Boolean))];
  return {
    added: added.length, dropped, drivers, filledDates,
    rowCount: all.length > 0 ? all.length + HEADER_ROW + 1 : 1,
  };
}

// Writes one batch of resolved manifests onto the three tabs. Each tab takes only the trips that have
// that leg: a one-way delivery run has no inbound leg and a pure-inbound run (deadhead down) has no
// outbound leg, so neither is padded onto the other tab with blank miles. Every trip reaches Rounder.
// updateTab re-reads the tab and drops manifests already present, so calling this repeatedly within a
// run is safe — that is what makes the long backfill resumable.
async function archiveManifests(sheetId, driverTypes, manifests) {
  const hasLeg = (v) => v !== '' && v != null;
  const obManifests = manifests.filter((m) => hasLeg(m.obMiles));
  const ibManifests = manifests.filter((m) => hasLeg(m.ibMiles));
  const ob = await updateTab(sheetId, OUTBOUND_TAB, 'leg', driverTypes, obManifests.map(obRecord));
  const ib = await updateTab(sheetId, INBOUND_TAB, 'leg', driverTypes, ibManifests.map(ibRecord));
  const rd = await updateTab(sheetId, ROUNDER_TAB, 'rounder', driverTypes, manifests.map(rounderRecord));
  // Last, so their SUMIFs are rebuilt against the row counts the three tabs just settled on.
  const driverSets = [ob.drivers, ib.drivers, rd.drivers];
  await updateByDriverTab(sheetId, driverTypes, driverSets);
  await updateCompareTab(sheetId, driverTypes, driverSets);
}

// A manifest earns a place in the archive two ways, and either is enough:
//   1. GEOGRAPHY — it carries a US→CA order whose inbound leg has finished. This is the original rule and
//      it needs no tagging at all; every trip on the sheet today got there this way.
//   2. TAG — it carries "US O/B" or "US I/B" and RoseRocket says the manifest itself is finished. This is
//      the manual override: tag a manifest and it appears, whatever its shape, even when its orders have
//      aged out of the order window.
// Returns Map<tripId, { ctx, ibRecords, finishedAt }>.
async function collectCandidates(orders, ordersById, sinceMs) {
  const inbound = orders.filter(
    (o) => US_COUNTRIES.has(o.from_country) && CA_COUNTRIES.has(o.to_country),
  );
  // allowDirectDelivery: a full-load run hands the freight straight to the consignee and never unloads at
  // the terminal, so "delivered" counts as the finish for it too (the live sheets keep the strict rule).
  const resolved = await resolveOrdersForHistory(inbound, {
    manifestSide: 'pickup',
    allowDirectDelivery: true,
  });
  const recordsByTrip = new Map();
  for (const r of resolved) {
    if (!r.tripId || !r.manifest?.fullId) continue;
    if (!recordsByTrip.has(r.tripId)) recordsByTrip.set(r.tripId, []);
    recordsByTrip.get(r.tripId).push(r);
  }

  const candidates = new Map();
  for (const [tripId, recs] of recordsByTrip) {
    const complete = recs.filter((r) => r.complete);
    if (!complete.length) continue;
    candidates.set(tripId, { ctx: complete[0].manifest, ibRecords: complete, finishedAt: null });
  }
  console.log(`[TripHistory] ${candidates.size} finished manifest(s) from US→CA orders.`);

  const trips = await fetchMasterTripsSince(undefined, { sinceMs });
  let tagged = 0;
  let taggedUnfinished = 0;
  for (const trip of trips) {
    const names = manifestTagNamesFromTrip(trip).map(normalizeTagName);
    if (!names.some((n) => TRIGGER_TAGS.has(n))) continue;
    if (candidates.has(trip.id)) continue; // already covered by its orders
    const finishedAt = masterTripFinishedAt(trip);
    if (!finishedAt) { taggedUnfinished++; continue; } // still on the road
    const ctx = manifestContextFromTrip(trip);
    if (!ctx?.fullId) continue;
    candidates.set(trip.id, {
      ctx,
      // Any US→CA orders that DID resolve still supply the inbound figures, complete flag or not — the
      // manifest itself is finished, so its inbound freight has landed.
      ibRecords: recordsByTrip.get(trip.id) ?? [],
      finishedAt,
    });
    tagged++;
  }
  console.log(
    `[TripHistory] +${tagged} manifest(s) added by tag (${[...TRIGGER_TAGS].join(' / ')})` +
      (taggedUnfinished ? `; ${taggedUnfinished} tagged but still running` : '') + '.',
  );
  return candidates;
}

// A row is HOLLOW when it carries a Manifest ID but no City and no Revenue — the signature of a manifest
// archived while its /stops fetch was failing (everything but the manifest's own mileage comes from the
// stops). Such a row is not real history: it is a placeholder that also blocks the trip from ever being
// resolved properly, because the de-dup treats an archived manifest as finished.
function hollowRowKeys(grid) {
  const headerRowIdx = Math.max(0, grid.findIndex((r) => Array.isArray(r) && r.includes(KEY_HEADER)));
  const header = grid[headerRowIdx] ?? [];
  const keyIdx = header.indexOf(KEY_HEADER);
  const cityIdx = header.indexOf('City');
  const revIdx = header.indexOf('Revenue');
  const keys = new Set();
  if (keyIdx < 0 || cityIdx < 0 || revIdx < 0) return keys;
  for (const row of grid.slice(headerRowIdx + 1)) {
    const key = manifestKey(row?.[keyIdx]);
    if (!key) continue;
    const city = String(row?.[cityIdx] ?? '').trim();
    const revenue = String(row?.[revIdx] ?? '').trim();
    if (!city && !revenue) keys.add(key);
  }
  return keys;
}

// Removes those hollow rows from all three tabs so the trips become eligible again. Read-only unless
// `apply` is set. Returns the manifest ids it found.
async function repairTripHistory(sheetId, { apply = false } = {}) {
  const grid = await readTabValues(sheetId, ROUNDER_TAB).catch(() => []);
  const keys = hollowRowKeys(grid);
  if (!keys.size) {
    console.log('[TripHistory] Repair: no hollow rows found — nothing to do.');
    return { keys: [] };
  }
  console.log(
    `[TripHistory] Repair: ${keys.size} hollow row(s) (archived with no city/revenue): ${[...keys].join(', ')}`,
  );
  if (!apply) {
    console.log('[TripHistory] Repair: dry run — pass --apply to remove them.');
    return { keys: [...keys] };
  }
  const driverTypes = await fetchDriverTypes();
  for (const [tab, kind] of [[OUTBOUND_TAB, 'leg'], [INBOUND_TAB, 'leg'], [ROUNDER_TAB, 'rounder']]) {
    await updateTab(sheetId, tab, kind, driverTypes, [], { dropKeys: keys });
  }
  console.log('[TripHistory] Repair: done — re-run the sync/backfill to archive these trips properly.');
  return { keys: [...keys] };
}

// sinceDays widens the order + manifest window (the backfill runs a much wider one than the cron).
// flushEvery > 0 writes the sheet every N manifests so a long run is durable and resumable.
async function syncTripHistory(sheetId, { sinceDays = SINCE_DAYS, flushEvery = 0 } = {}) {
  const t0 = Date.now();
  console.log(
    `[TripHistory] Starting at ${new Date().toISOString()} → sheet ${sheetId} (window ${sinceDays} day(s))`,
  );
  const api = await client();
  const driverTypes = await fetchDriverTypes();
  const orders = await fetchOrdersForOrg(undefined, { sinceDays });
  const ordersById = new Map(orders.map((o) => [o.id, o]));
  const sinceMs = Date.now() - sinceDays * 86400000;

  const candidates = await collectCandidates(orders, ordersById, sinceMs);

  // Skip manifests already archived (keyed by Manifest ID on the Rounder tab) BEFORE the heavy
  // per-manifest resolution — each manifest is resolved once, ever.
  const archived = await archivedManifestIds(sheetId, ROUNDER_TAB);
  const stopCache = new Map();
  let pending = [];
  let archivedCount = 0;
  let skipped = 0;
  let done = 0;
  const todo = [...candidates].filter(
    ([, c]) => !archived.has(String(c.ctx.fullId).trim()),
  );
  console.log(`[TripHistory] ${todo.length} manifest(s) not yet archived — resolving.`);

  // `force` writes the tabs even with nothing new to add. Type / OO Rev / OO RPM are RECOMPUTED on every
  // write — a driver's owner-operator status can change in RoseRocket, or be corrected — so a run that
  // archives no new trips must still rewrite the rows already on the sheet. Without the final forced
  // write, a driver-type fix never reaches existing rows and the sync appears to do nothing at all.
  const flush = async ({ force = false } = {}) => {
    if (!pending.length && !force) return;
    await archiveManifests(sheetId, driverTypes, pending);
    archivedCount += pending.length;
    pending = [];
  };

  for (const [tripId, candidate] of todo) {
    const fullId = String(candidate.ctx.fullId).trim();
    done++;
    try {
      const m = await resolveManifest(api, tripId, candidate, ordersById, stopCache);
      // Don't archive a trip whose orders aged out of the window — it would only add half-blank rows
      // (no Feet/Weight/Revenue). Keeps the sheet clean no matter how wide a window a run uses.
      if (m.agedOut) skipped++;
      else pending.push(m);
    } catch (err) {
      console.warn(`[TripHistory] ${fullId}: ${err.message}`);
    }
    if (flushEvery > 0 && pending.length >= flushEvery) {
      await flush();
      console.log(`[TripHistory] …${done}/${todo.length} resolved, ${archivedCount} archived so far.`);
    }
  }
  await flush({ force: true });
  console.log(
    `[TripHistory] ${archivedCount} manifest(s) archived` +
      (skipped ? ` (${skipped} skipped — orders aged out of the window)` : '') + '.',
  );

  console.log(`[TripHistory] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  return { sheetId, archived: archivedCount, skipped };
}

module.exports = {
  syncTripHistory,
  getTripHistorySheetId,
  repairTripHistory,
  hollowRowKeys,
  collectCandidates,
  resolveManifest,
  isoWeek,
  OUTBOUND_TAB,
  INBOUND_TAB,
  ROUNDER_TAB,
  BY_DRIVER_TAB,
  COMPARE_TAB,
  TRIP_TABS,
  updateTab,
  updateByDriverTab,
  updateCompareTab,
};

if (require.main === module) {
  const sheetId = getTripHistorySheetId();
  if (!sheetId) {
    console.error('[TripHistory] GOOGLE_TRIP_HISTORY_SHEET_ID not set.');
    process.exit(1);
  }
  syncTripHistory(sheetId)
    .then(() => { console.log('Done'); process.exit(0); })
    .catch((err) => { console.error(`[TripHistory] Failed: ${err.message}`); process.exit(1); });
}
