require("dotenv").config();
const {
  fetchOrders,
  filterUSOutbound,
  filterUSInbound,
  filterOutLoadedDeliveries,
  autoTagInboundOnLdt,
  fetchDriverTypes,
  normalizePersonKey,
} = require("./roserocket");
const {
  createSpreadsheet,
  writeToSheetWithRetry,
  ensureGoogleAuth,
  sleep,
  removeUnwantedSheets,
  reorderSheets,
  readNotesByKey,
  removeUnwantedOpsSheets,
  flattenObject,
  resolveFieldValue,
  syncConditionalFormats,
  syncBanding,
  readFirstTabColumnWidths,
  applyColumnWidths,
  readTabValues,
  stampLastSynced,
  readColumnColorsByKey,
  applyCellColors,
  setConfigCell,
} = require("./sheets");
const {
  processForceDeliver,
  TAB_NAME: FORCE_DELIVER_TAB,
} = require("./force-deliver");
const {
  processForceDeleteManifest,
  TAB_NAME: FORCE_DELETE_MANIFEST_TAB,
} = require("./force-delete-manifest");
const {
  processForceCancel,
  TAB_NAME: FORCE_CANCEL_TAB,
} = require("./force-cancel");

const OPS_SHEET_TAB_ORDER = [
  FORCE_DELIVER_TAB,
  FORCE_CANCEL_TAB,
  FORCE_DELETE_MANIFEST_TAB,
];
const {
  syncInvoiceSentReport,
  COMMISSION_SHEET_TAB_ORDER,
} = require("./invoice-sent-report");
const fs = require("fs");
const path = require("path");

const SHEET_ID_FILE = path.join(__dirname, "..", ".sheet_id");
const TAB_WRITE_DELAY_MS = parseInt(
  process.env.SHEETS_TAB_WRITE_DELAY_MS ?? "2000",
  10,
);

function elapsed(startMs) {
  return `${((Date.now() - startMs) / 1000).toFixed(1)}s`;
}

function extractSheetId(value) {
  if (!value) return null;
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : value.trim();
}

function getOutboundSheetId() {
  if (process.env.GOOGLE_OUTBOUND_SHEET_ID)
    return extractSheetId(process.env.GOOGLE_OUTBOUND_SHEET_ID);
  if (fs.existsSync(SHEET_ID_FILE))
    return fs.readFileSync(SHEET_ID_FILE, "utf8").trim();
  return null;
}

function getOpsSheetId() {
  if (process.env.GOOGLE_OPS_SHEET_ID)
    return extractSheetId(process.env.GOOGLE_OPS_SHEET_ID);
  return null;
}

function getInboundSheetId() {
  if (process.env.GOOGLE_INBOUND_SHEET_ID)
    return extractSheetId(process.env.GOOGLE_INBOUND_SHEET_ID);
  return null;
}

function getCommissionSheetId() {
  if (process.env.GOOGLE_COMMISSION_SHEET_ID) {
    return extractSheetId(process.env.GOOGLE_COMMISSION_SHEET_ID);
  }
  return null;
}

function saveSheetId(id) {
  fs.writeFileSync(SHEET_ID_FILE, id, "utf8");
}

// Customs/bond tags to surface in the "Customs" column (matched by tag name, case-insensitive).
// Sourced from real RoseRocket data. Add/rename here if the org's customs tags change.
const CUSTOMS_TAGS = new Set(
  [
    "entry number",
    "customs docs n email",
    "sent customs broker",
    "need customs docs",
    "customs requested",
    "customs hold",
    "needs custom broker",
    "inbond go2 bond shed",
    "travels in bond",
    "csa shipment",
    "section 321",
    "customs clear",
  ].map((s) => s.toLowerCase()),
);

// Renders the order's customs-related tag names on separate lines (no icons),
// keeping only the whitelisted customs tags above and ignoring all other order tags.
function formatCustomsTags(orderTags) {
  if (!Array.isArray(orderTags)) return "";
  return orderTags
    .filter(
      (t) =>
        t &&
        CUSTOMS_TAGS.has(
          String(t.name ?? "")
            .trim()
            .toLowerCase(),
        ),
    )
    .map((t) => String(t.name ?? "").trim())
    .join("\n");
}

// The outbound/inbound sheets each have two fixed tabs — the master (US Outbound / US Inbound) and the
// Summary — plus one tab per manifest nickname, created dynamically from the live orders (see
// groupOrdersByManifestNickname). "Force Refresh" is managed by the bound Apps Script; it is preserved
// and kept last.
const US_OUTBOUND_TAB = "US Outbound";
const US_INBOUND_TAB = "US Inbound";
const SUMMARY_TAB = "Summary";
const FORCE_REFRESH_TAB = "Force Refresh";

// The reserved tabs for a sheet are its own master tab plus Summary + Force Refresh — a manifest nickname
// that collides with one of these is skipped (it can't own a nickname tab).
function reservedTabsFor(masterTab) {
  return new Set(
    [masterTab, SUMMARY_TAB, FORCE_REFRESH_TAB].map((t) => t.toLowerCase()),
  );
}

// The trigger tag is the on/off switch for the nickname tabs: an order gets a nickname tab only when its
// manifest carries this RoseRocket tag. The tag drives nothing else — tab names still come from the
// manifest nickname. Outbound uses "US O/B", inbound "US I/B"; both are env-overridable. Any other
// manifest tags (old lane tags, etc.) are ignored.
const OUTBOUND_TRIGGER_TAG = (
  process.env.OUTBOUND_TRIGGER_TAG || "US O/B"
).trim();
const INBOUND_TRIGGER_TAG = (
  process.env.INBOUND_TRIGGER_TAG || "US I/B"
).trim();

function normalizeTagName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function manifestHasTriggerTag(manifestInfo, triggerTag = OUTBOUND_TRIGGER_TAG) {
  const target = normalizeTagName(triggerTag);
  if (!target) return false;
  return (manifestInfo?.tags ?? []).some(
    (tag) => normalizeTagName(tag?.name ?? tag) === target,
  );
}

// Turns a manifest nickname into a valid Google Sheets tab title: strips the only characters Sheets
// forbids in a title ([ and ]), collapses whitespace, and caps length. '' when there's no nickname.
function tabNameFromNickname(nickname) {
  return String(nickname ?? "")
    .replace(/[[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function orderManifestTabName(order, manifestByOrderId) {
  return tabNameFromNickname(manifestByOrderId.get(order.id)?.nickname);
}

// Groups master-tab orders into one bucket per manifest nickname — the dynamic lane tabs. Orders with no
// nickname (or one that collides with a reserved tab name) are skipped here; they still appear on the
// master tab. Returns [{ name, records }] sorted by tab name.
function groupOrdersByManifestNickname(
  orders,
  manifestByOrderId,
  reservedTabs = reservedTabsFor(US_OUTBOUND_TAB),
) {
  const groups = new Map();
  for (const order of orders) {
    const name = orderManifestTabName(order, manifestByOrderId);
    if (!name || reservedTabs.has(name.toLowerCase())) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(order);
  }
  return [...groups.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, records: groups.get(name) }));
}

function orderRate(order) {
  const freight = Number(order._freightRate);
  if (Number.isFinite(freight) && freight > 0) return freight;
  return "";
}

// Sums a per-manifest numeric field once per unique manifest (so a lane spanning one manifest reports
// that manifest's value, not N copies of it). Used for the inbound miles and the rounder figures.
function uniqueManifestFieldTotal(orders, manifestByOrderId, field) {
  const seen = new Set();
  let total = 0;
  for (const order of orders) {
    const info = manifestByOrderId.get(order.id);
    const value = Number(info?.[field]);
    if (!Number.isFinite(value) || value === 0) continue;
    const key = info.tripId || `order:${order.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += value;
  }
  return total;
}

function uniqueManifestMilesTotal(orders, manifestByOrderId) {
  const total = uniqueManifestFieldTotal(orders, manifestByOrderId, "estimatedMiles");
  return total > 0 ? Math.round(total * 10) / 10 : "";
}

// Each sheet's rows run in the same direction as the City/State/Zip it shows: outbound by the manifest's
// DELIVERY stops, inbound by its PICKUP stops (the inbound manifest is resolved from the pickup leg —
// see pickManifestTripIdFor — so its stop ordinals are the US collection run). Two fallbacks:
//   - if the configured sequence can't be resolved we fall back to deliverySequence, so rows still
//     follow the manifest's route instead of collapsing to an alphabetical full_id order.
//   - orders with no manifest at all sort by dateSortKey (pickup date inbound, delivery date outbound).
function sortSheetOrders(
  orders,
  manifestByOrderId,
  schedulingByOrderId,
  { sequenceKey = "deliverySequence", dateSortKey = "deliverySortMs" } = {},
) {
  const seqOf = (info) => info?.[sequenceKey] ?? info?.deliverySequence;
  const manifestMinSeq = new Map();
  for (const order of orders) {
    const info = manifestByOrderId.get(order.id);
    const seq = seqOf(info);
    if (info?.tripId && seq != null) {
      const current = manifestMinSeq.get(info.tripId);
      if (current == null || seq < current)
        manifestMinSeq.set(info.tripId, seq);
    }
  }

  return [...orders].sort((a, b) => {
    const ma = manifestByOrderId.get(a.id);
    const mb = manifestByOrderId.get(b.id);
    const tripA = ma?.tripId ?? "";
    const tripB = mb?.tripId ?? "";

    if (!tripA && !tripB) {
      const sortA = schedulingByOrderId.get(a.id)?.[dateSortKey];
      const sortB = schedulingByOrderId.get(b.id)?.[dateSortKey];
      if (sortA != null && sortB != null && sortA !== sortB)
        return sortA - sortB;
      if (sortA != null && sortB == null) return -1;
      if (sortA == null && sortB != null) return 1;
      return String(a.full_id ?? "").localeCompare(String(b.full_id ?? ""));
    }
    if (!tripA) return 1;
    if (!tripB) return -1;

    if (tripA !== tripB) {
      const minA = manifestMinSeq.get(tripA) ?? 9999;
      const minB = manifestMinSeq.get(tripB) ?? 9999;
      if (minA !== minB) return minA - minB;
      return String(ma.fullId ?? "").localeCompare(String(mb.fullId ?? ""));
    }

    const seqA = seqOf(ma) ?? 9999;
    const seqB = seqOf(mb) ?? 9999;
    if (seqA !== seqB) return seqA - seqB;
    return String(a.full_id ?? "").localeCompare(String(b.full_id ?? ""));
  });
}

// Attach scheduling fields for each order row.
function annotateSheetOrders(orders, schedulingByOrderId) {
  return orders.map((order) => {
    const scheduling = schedulingByOrderId.get(order.id);
    return {
      ...order,
      _pickupRequested: scheduling?.pickupRequested ?? "",
      _deliveryRequested: scheduling?.deliveryRequested ?? "",
    };
  });
}

// A manifest carrying a nickname is one of the line-haul loads the planners build and name. An order can
// also sit on an UNNAMED manifest — typically one dispatched to an outside carrier — and those were
// blanked here on the reasoning that they were numbers nobody used. The inbound planners now want them:
// a carrier is on the load, and the manifest is how they find it. `showUnnamed` decides, per sheet.
//
// The nickname stays empty either way, which is what keeps these orders OFF the lane tabs and out of the
// Summary — both group by nickname. They appear on the master tab only, exactly where they were asked for.
function visibleManifest(manifestInfo, showUnnamed = false) {
  if (showUnnamed) return manifestInfo?.fullId ? manifestInfo : null;
  return String(manifestInfo?.nickname ?? "").trim() ? manifestInfo : null;
}

// An order on an UN-NICKNAMED manifest that has started moving is off the planners' board: it is on an
// outside carrier's truck and there is nothing left to plan. It leaves the master tab and goes nowhere
// else. Nicknamed (line-haul) manifests are untouched by this — they keep their existing flow, and the
// lane tabs and Summary are both grouped by nickname, so neither is affected either way.
const MOVING_STATUS = "moving";
function isMovingUnnamedManifest(order, manifestByOrderId) {
  const info = manifestByOrderId.get(order.id);
  if (!info?.fullId) return false;
  if (String(info.nickname ?? "").trim()) return false;
  return String(info.status ?? "").toLowerCase() === MOVING_STATUS;
}

function manifestTripUrl(order, manifestByOrderId, web, showUnnamed = false) {
  const tripId = visibleManifest(manifestByOrderId.get(order.id), showUnnamed)?.tripId;
  return web && tripId ? `${web}/#/ops/manifests/${tripId}` : "";
}

// addressPrefix picks which end of the move the City/State/Zip columns show: "to" for the outbound sheet
// (freight heading INTO the US, so the destination is what matters) and "from" for the inbound sheet
// (freight coming OUT of the US, so the planners need the US origin).
function buildSheetColumns({
  notesByOrder,
  manifestByOrderId,
  web,
  includeMilesRpm = true,
  includeNickname = false,
  addressPrefix = "to",
  showUnnamedManifestId = false,
}) {
  const columns = [
    { header: "City", field: `${addressPrefix}_city`, width: 150 },
    { header: "State", field: `${addressPrefix}_state`, width: 70 },
    { header: "Zip", field: `${addressPrefix}_postal`, width: 70 },
    { header: "Skids", field: "total_skids", width: 70, sum: true },
    { header: "Feet", field: "total_linear_feet", width: 70, sum: true },
    { header: "Weight", field: "total_weight", width: 70, sum: true },
    {
      header: "Rate",
      getLabel: (r) => orderRate(r),
      width: 90,
      sum: true,
      format: "currency",
    },
  ];

  if (includeMilesRpm) {
    columns.push(
      {
        header: "Miles",
        getLabel: () => "",
        width: 80,
        format: "decimal",
        getTotalValue: ({ records }) =>
          uniqueManifestMilesTotal(records, manifestByOrderId),
      },
      {
        header: "RPM",
        getLabel: () => "",
        width: 80,
        format: "currency",
        getTotalFormula: ({ totalsRow, colLetter, resolvedColumns }) => {
          const rateIdx = resolvedColumns.findIndex((c) => c.header === "Rate");
          const milesIdx = resolvedColumns.findIndex(
            (c) => c.header === "Miles",
          );
          if (rateIdx < 0 || milesIdx < 0) return "";
          const rate = colLetter(rateIdx);
          const miles = colLetter(milesIdx);
          return `=IF(${miles}${totalsRow}=0,"",${rate}${totalsRow}/${miles}${totalsRow})`;
        },
      },
    );
  }

  columns.push(
    // clearBackground strips any fill left over from the old customs color-coding (a full refresh
    // clears values but not formatting, so an old color would otherwise linger on the row beneath it).
    {
      header: "Customs",
      getLabel: (r) => formatCustomsTags(r.order_tags),
      width: 200,
      wrap: true,
      clearBackground: true,
    },
    { header: "Customer", field: "billing_org_name", width: 250 },
    {
      header: "Order ID",
      getLabel: (r) => r.full_id,
      getUrl: (r) => (web && r.id ? `${web}/#/ops/orders/${r.id}` : ""),
      width: 130,
    },
  );
  // US Outbound master shows the manifest nickname (the value each subset tab is named after) to the
  // left of the Manifest ID.
  if (includeNickname) {
    columns.push({
      header: "Nickname",
      getLabel: (r) => manifestByOrderId.get(r.id)?.nickname ?? "",
      width: 200,
    });
  }
  columns.push(
    {
      header: "Manifest ID",
      getLabel: (r) =>
        visibleManifest(manifestByOrderId.get(r.id), showUnnamedManifestId)?.fullId ?? "",
      getUrl: (r) => manifestTripUrl(r, manifestByOrderId, web, showUnnamedManifestId),
      width: 130,
    },
    {
      header: "Pick up",
      getLabel: (r) => r._pickupRequested ?? "",
      width: 120,
    },
    {
      header: "Delivery",
      getLabel: (r) => r._deliveryRequested ?? "",
      width: 120,
    },
    {
      header: "Notes",
      getLabel: (r) => notesByOrder.get(String(r.full_id ?? "").trim()) ?? "",
      width: 300,
    },
  );

  return columns;
}

function sumNumeric(orders, getter) {
  return orders.reduce((sum, order) => {
    const n = Number(getter(order));
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
}

// Tolerant numeric parse — handles numbers and numeric strings ("1,500", "1500 lbs").
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(String(value ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Sums a sheet field across a lane's orders using the SAME fuzzy field resolution the US Outbound
// columns use. Direct access (o.total_weight) misses fields that aren't exact top-level keys — e.g.
// total_weight living under a unit-suffixed or nested key — which is why the Summary weight read 0.
function sumField(flatRecords, field) {
  return flatRecords.reduce(
    (sum, fr) => sum + toNumber(resolveFieldValue(fr, field)),
    0,
  );
}

// A lane's manifest ID label (distinct full_ids, usually one per nickname) plus a clickable link.
// The link is only set for a single-manifest lane, where one manifest URL is unambiguous.
function laneManifestLink(records, manifestByOrderId, web) {
  const ids = new Set();
  let tripId = "";
  for (const order of records) {
    const info = manifestByOrderId.get(order.id);
    if (!info?.fullId) continue;
    ids.add(info.fullId);
    if (!tripId && info.tripId) tripId = info.tripId;
  }
  return {
    manifestId: [...ids].join(", "),
    manifestUrl:
      web && ids.size === 1 && tripId ? `${web}/#/ops/manifests/${tripId}` : "",
  };
}

// The order whose address the Summary shows for a lane — the LAST stop of the run in both directions:
//   outbound → the LAST DROP (highest delivery-sequence stop) — where the manifest finishes in the US.
//   inbound  → the LAST PICKUP (highest pickup-sequence stop) — the final US collection before the truck
//              turns for Canada. It used to show the FIRST pickup, i.e. where collection began; the
//              planners want where it ends, so the Summary reads as "the last place this truck was".
// Records arrive sorted, but taking the explicit min/max keeps this right regardless of input order;
// with no resolved sequence it falls back to the last/first record.
function laneAnchorOrder(records, manifestByOrderId, sequenceKey, pick = "last") {
  let best = null;
  let bestSeq = pick === "first" ? Infinity : -Infinity;
  for (const order of records) {
    const seq = manifestByOrderId.get(order.id)?.[sequenceKey];
    const fallback = pick === "first" ? Infinity : -Infinity;
    const value = Number.isFinite(seq) ? seq : fallback;
    const better = pick === "first" ? value <= bestSeq : value >= bestSeq;
    if (better) {
      bestSeq = value;
      best = order;
    }
  }
  return best;
}

// The lane's driver, off the manifest. A lane is one manifest so the driver is the same across its
// orders; prefer the anchor order's manifest (the same one City/State/Zip come from) and fall back to
// the first order that has a driver, so a single order missing manifest data doesn't blank the column.
function laneDriver(records, manifestByOrderId, lastDrop) {
  const fromLastDrop = lastDrop
    ? String(manifestByOrderId.get(lastDrop.id)?.driver ?? "").trim()
    : "";
  if (fromLastDrop) return fromLastDrop;
  for (const order of records) {
    const driver = String(manifestByOrderId.get(order.id)?.driver ?? "").trim();
    if (driver) return driver;
  }
  return "";
}

function buildSummaryRecords(
  laneTasks,
  manifestByOrderId,
  web,
  notesByManifest = new Map(),
  {
    addressPrefix = "to",
    sequenceKey = "deliverySequence",
    anchor = "last",
    actualFootageByManifest = new Map(),
  } = {},
) {
  return laneTasks.map(({ name, records }) => {
    // Flatten once, then resolve each field the same way the sheet columns do (fixes 0/blank Weight).
    // NB: wrap flattenObject so Array.map's index arg isn't passed as its `prefix` param.
    const flats = records.map((order) => flattenObject(order));
    const skids = sumField(flats, "total_skids");
    const feet = sumField(flats, "total_linear_feet");
    const weight = sumField(flats, "total_weight");
    const rate = sumNumeric(records, orderRate);
    const miles =
      Number(uniqueManifestMilesTotal(records, manifestByOrderId)) || 0;
    const rpm = miles > 0 ? Math.round((rate / miles) * 100) / 100 : "";
    // "Rounder" = the whole round-trip manifest, once per unique manifest: full miles and full revenue.
    const rounderMiles = Math.round(
      uniqueManifestFieldTotal(records, manifestByOrderId, "rounderMiles") * 10,
    ) / 10;
    const rounderRate = Math.round(
      uniqueManifestFieldTotal(records, manifestByOrderId, "rounderRate") * 100,
    ) / 100;
    const rounderRpm =
      rounderMiles > 0 ? Math.round((rounderRate / rounderMiles) * 100) / 100 : "";
    const { manifestId, manifestUrl } = laneManifestLink(
      records,
      manifestByOrderId,
      web,
    );
    // Resolve the anchor order's address through the SAME fuzzy field lookup the lane tabs use, so the
    // Summary can't disagree with the City/State/Zip shown on the tab itself.
    const anchorOrder = laneAnchorOrder(
      records,
      manifestByOrderId,
      sequenceKey,
      anchor,
    );
    const anchorFlat = anchorOrder ? flats[records.indexOf(anchorOrder)] : null;
    const anchorField = (field) =>
      anchorFlat ? String(resolveFieldValue(anchorFlat, field) ?? "") : "";
    return {
      lane: name,
      dropCity: anchorField(`${addressPrefix}_city`),
      dropState: anchorField(`${addressPrefix}_state`),
      dropZip: anchorField(`${addressPrefix}_postal`),
      driver: laneDriver(records, manifestByOrderId, anchorOrder),
      manifestId,
      manifestUrl,
      skids: skids || "",
      feet: feet || "",
      weight: weight || "",
      rate: rate || "",
      miles: miles || "",
      rpm,
      // Keyed by manifest ID, so the note follows the manifest rather than the lane name.
      notes: notesByManifest.get(manifestId) ?? "",
      // Planner-entered, preserved the same way (inbound only; empty map otherwise).
      actualFootage: actualFootageByManifest.get(manifestId) ?? "",
      // Whole-trip figures (inbound Summary only; zero elsewhere).
      rounderRate: rounderRate || "",
      rounderMiles: rounderMiles || "",
      rounderRpm,
    };
  });
}

const SUMMARY_COLUMNS = [
  { header: "Lane", getLabel: (r) => r.lane, width: 120 },
  // City/State/Zip of the lane's anchor stop (see laneAnchorOrder): outbound = the manifest's final
  // delivery stop; inbound = its final pickup, i.e. the last US stop before it heads back to Canada.
  { header: "City", getLabel: (r) => r.dropCity, width: 110 },
  { header: "State", getLabel: (r) => r.dropState, width: 60 },
  { header: "Zip", getLabel: (r) => r.dropZip, width: 70 },
  { header: "Driver", getLabel: (r) => r.driver, width: 150 },
  {
    header: "Manifest ID",
    getLabel: (r) => r.manifestId,
    getUrl: (r) => r.manifestUrl ?? "",
    width: 95,
  },
  // Explicit "integer" format so these plain counts can't inherit a stale format on the cells beneath
  // them — a full refresh clears values but not formatting, and inserting City/State/Zip shifted Skids/
  // Feet onto columns that previously held Rate (currency) / Miles (decimal).
  { header: "Skids", getLabel: (r) => r.skids, width: 60, sum: true, format: "integer" },
  { header: "Feet", getLabel: (r) => r.feet, width: 60, sum: true, format: "integer" },
  {
    header: "Weight",
    getLabel: (r) => r.weight,
    width: 75,
    sum: true,
    format: "integer",
  },
  {
    header: "Rate",
    getLabel: (r) => r.rate,
    width: 90,
    sum: true,
    format: "currency",
  },
  {
    header: "Miles",
    getLabel: (r) => r.miles,
    width: 80,
    sum: true,
    format: "decimal",
  },
  {
    header: "RPM",
    getLabel: (r) => r.rpm,
    width: 70,
    format: "currency",
    getTotalValue: ({ records }) => {
      const totalRate = records.reduce((s, r) => s + (Number(r.rate) || 0), 0);
      const totalMiles = records.reduce(
        (s, r) => s + (Number(r.miles) || 0),
        0,
      );
      if (totalMiles <= 0) return "";
      return Math.round((totalRate / totalMiles) * 100) / 100;
    },
  },
  // Planner-entered text AND fill colour, both preserved across refreshes and both keyed by Manifest ID
  // (see runOutboundSync). clearBackground wipes the column's fills every run so a colour can't linger on
  // whatever row later sits in its place — the preserved colours are then painted back by manifest.
  {
    header: "Notes",
    getLabel: (r) => r.notes ?? "",
    width: 320,
    wrap: true,
    clearBackground: true,
  },
];

// Planner-entered "Actual" footage: editable and preserved across every sync exactly like the Notes
// column — read back keyed by Manifest ID before the refresh and rewritten, so it survives the full
// rebuild and only disappears when its manifest drops off. No sync-computed value and no forced number
// format, so whatever the planner types stays put. Inbound Summary only, inserted right after "Feet".
const ACTUAL_FOOTAGE_COLUMN = {
  header: "Actual",
  getLabel: (r) => r.actualFootage ?? "",
  width: 90,
};

// Whole round-trip ("rounder") figures for the inbound Summary, shown right after the inbound RPM: the
// full-manifest revenue and miles and their RPM. Revenue is a best-effort computed total (all on-manifest
// leg revenue) and will not tie exactly to the manifest screen's Total Revenue.
const ROUNDER_COLUMNS = [
  { header: "Rounder Rate", getLabel: (r) => r.rounderRate ?? "", width: 100, sum: true, format: "currency" },
  { header: "Rounder Miles", getLabel: (r) => r.rounderMiles ?? "", width: 100, sum: true, format: "decimal" },
  {
    header: "Rounder RPM",
    getLabel: (r) => r.rounderRpm ?? "",
    width: 100,
    format: "currency",
    getTotalValue: ({ records }) => {
      const rev = records.reduce((s, r) => s + (Number(r.rounderRate) || 0), 0);
      const mi = records.reduce((s, r) => s + (Number(r.rounderMiles) || 0), 0);
      return mi > 0 ? Math.round((rev / mi) * 100) / 100 : "";
    },
  },
];

// Inserts columns right after the one named `afterHeader` (or at the end if it's absent).
function insertAfter(columns, afterHeader, extra) {
  const idx = columns.findIndex((c) => c.header === afterHeader);
  const at = idx >= 0 ? idx + 1 : columns.length;
  return [...columns.slice(0, at), ...extra, ...columns.slice(at)];
}

// --- Owner-operator columns ---------------------------------------------------
// The same Type / OO Rev / OO RPM treatment the trip-history tabs carry, now on the live Summaries. The
// cut itself is an EDITABLE cell above the table (row 1, "OO Cut"), so a planner can change the rate in
// the sheet and every OO figure updates instantly — no sync, no redeploy. That is why the table starts on
// row 2 and every OO figure is a formula pointing at $B$1 rather than a number computed here.
const SUMMARY_HEADER_ROW = 2; // 1-based; row 1 holds the frozen OO Cut config cell
const SUMMARY_CUT_REF = "$B$1";
const OO_CUT_DEFAULT = 0.59; // 59% — matches the trip-history sheet's starting rate

function summaryColLetter(idx) {
  let n = idx;
  let s = "";
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

const driverTypeOf = (record, driverTypes) =>
  driverTypes.get(normalizePersonKey(record.driver));
const driverTypeLabel = (record, driverTypes) => {
  const t = driverTypeOf(record, driverTypes);
  return t === "owner-operator" ? "OO" : t === "company-driver" ? "CD" : "";
};

// ── Assumed type ─────────────────────────────────────────────────────────────────────────────────────
// A planner can type OO (or CD) into the Type column of a lane that has no driver yet, to see what the
// run would pay an owner-operator before committing it. Two things make that work:
//
//   1. It has to SURVIVE. The Summary is rewritten from scratch every five minutes and Type is derived
//      from the assigned driver, so a typed value was being blanked within minutes — by the refresh, not
//      by anything the planner did. It is now read back and re-emitted, keyed by Manifest ID, exactly as
//      Notes and Actual already are.
//   2. It has to YIELD. The moment a real driver is assigned the derived type takes over and the
//      assumption is dropped — whether that driver is an owner-operator or a company driver.
const ASSUMABLE_TYPES = new Set(["OO", "CD"]);
const normalizeAssumedType = (v) => {
  const s = String(v ?? "").trim().toUpperCase();
  return ASSUMABLE_TYPES.has(s) ? s : "";
};
const hasAssignedDriver = (record) => String(record?.driver ?? "").trim() !== "";
const assumedTypeOf = (record, assumedTypes) =>
  normalizeAssumedType(assumedTypes?.get(String(record?.manifestId ?? "").trim()));

// The type actually in force for a row: derived from the assigned driver, or — only while the lane is
// unassigned — the planner's assumption.
const effectiveTypeLabel = (record, driverTypes, assumedTypes) =>
  (hasAssignedDriver(record)
    ? driverTypeLabel(record, driverTypes)
    : assumedTypeOf(record, assumedTypes));
const isEffectiveOwnerOperator = (record, driverTypes, assumedTypes) =>
  effectiveTypeLabel(record, driverTypes, assumedTypes) === "OO";

// An OO Rev / OO RPM pair for one set of figures: the leg (Rate/Miles) or the whole trip (Rounder
// Rate/Rounder Miles). Only owner-operators get values — a company driver's cells stay blank, exactly as
// on the trip-history tabs, so the totals aren't inflated by drivers the cut doesn't apply to.
function ooColumnPair({ revHeader, milesHeader, ooRevHeader, ooRpmHeader }) {
  return [
    {
      header: ooRevHeader,
      width: 100,
      format: "currency",
      _ooSource: revHeader,
      // NOT a plain SUM: an assumed OO on an unassigned lane shows its own math, but the bottom line
      // stays a statement of what is actually committed. Rows with no driver are excluded.
      getTotalFormula: ({ firstDataRow, lastDataRow, colLetter, resolvedColumns }) => {
        const at = (h) => colLetter(resolvedColumns.findIndex((c) => c.header === h));
        const driver = at("Driver");
        const ooRev = at(ooRevHeader);
        return `=SUMIF(${driver}${firstDataRow}:${driver}${lastDataRow},"<>",`
          + `${ooRev}${firstDataRow}:${ooRev}${lastDataRow})`;
      },
    },
    {
      header: ooRpmHeader,
      width: 90,
      format: "currency",
      _ooRatio: { ooRevHeader, milesHeader },
      getTotalFormula: ({ totalsRow, colLetter, resolvedColumns }) => {
        const revIdx = resolvedColumns.findIndex((c) => c.header === ooRevHeader);
        const milesIdx = resolvedColumns.findIndex((c) => c.header === milesHeader);
        if (revIdx < 0 || milesIdx < 0) return "";
        const rev = colLetter(revIdx);
        const miles = colLetter(milesIdx);
        return `=IF(${miles}${totalsRow}=0,"",${rev}${totalsRow}/${miles}${totalsRow})`;
      },
    },
  ];
}

function buildSummaryColumns({
  showActualFootage = false,
  showRounder = false,
  driverTypes = new Map(),
  assumedTypes = new Map(),
} = {}) {
  let cols = insertAfter(SUMMARY_COLUMNS, "Driver", [
    {
      header: "Type",
      getLabel: (r) => effectiveTypeLabel(r, driverTypes, assumedTypes),
      width: 55,
    },
  ]);
  if (showActualFootage) cols = insertAfter(cols, "Feet", [ACTUAL_FOOTAGE_COLUMN]);
  cols = insertAfter(
    cols,
    "RPM",
    ooColumnPair({
      revHeader: "Rate",
      milesHeader: "Miles",
      ooRevHeader: "OO Rev",
      ooRpmHeader: "OO RPM",
    }),
  );
  if (showRounder) {
    // Rounder block sits after the leg's OO pair, then gets its own OO pair.
    cols = insertAfter(cols, "OO RPM", ROUNDER_COLUMNS);
    cols = insertAfter(
      cols,
      "Rounder RPM",
      ooColumnPair({
        revHeader: "Rounder Rate",
        milesHeader: "Rounder Miles",
        ooRevHeader: "Rounder OO Rev",
        ooRpmHeader: "Rounder OO RPM",
      }),
    );
  }

  // The per-row formulas can only be written once the final layout is known, because they address other
  // columns by letter. Resolve them here, the same way the trip-history tabs do.
  const letterOf = (header) =>
    summaryColLetter(cols.findIndex((c) => c.header === header));
  const rowOf = (i) => SUMMARY_HEADER_ROW + 1 + i; // header on row 2, first data row on row 3
  return cols.map((c) => {
    if (c._ooSource) {
      const rev = letterOf(c._ooSource);
      return {
        ...c,
        getLabel: (r, i) =>
          (isEffectiveOwnerOperator(r, driverTypes, assumedTypes)
            ? `=${rev}${rowOf(i)}*${SUMMARY_CUT_REF}`
            : ""),
      };
    }
    if (c._ooRatio) {
      const rev = letterOf(c._ooRatio.ooRevHeader);
      const miles = letterOf(c._ooRatio.milesHeader);
      return {
        ...c,
        getLabel: (r, i) =>
          (isEffectiveOwnerOperator(r, driverTypes, assumedTypes)
            ? `=IFERROR(${rev}${rowOf(i)}/${miles}${rowOf(i)},"")`
            : ""),
      };
    }
    return c;
  });
}

// The planner's OO Cut rate, read back off row 1 so their edit round-trips through the refresh. Read with
// UNFORMATTED_VALUE so 59.00% arrives as 0.59 rather than the string "59.00%". On the first run after this
// column set is introduced row 1 is still the old header row, so nothing parses and the default applies.
function readSummaryCutValue(grid) {
  const configRow = grid?.[0] ?? [];
  const found = configRow
    .map(Number)
    .find((n) => Number.isFinite(n) && n > 0 && n <= 1);
  return found ?? OO_CUT_DEFAULT;
}

// The outbound and inbound sheets are identical machinery; only these four things differ.
// addressPrefix / sequenceKey / summaryAnchor are what make the two sheets read from opposite ends of
// the move: outbound shows where freight is GOING (US destination, ordered by delivery stops, Summary =
// last drop); inbound shows where it is COMING FROM (US origin, ordered by pickup stops, Summary =
// first pickup).
const OUTBOUND_CONFIG = {
  label: "Outbound",
  masterTab: US_OUTBOUND_TAB,
  triggerTag: OUTBOUND_TRIGGER_TAG,
  getSheetId: getOutboundSheetId,
  filterOrders: filterUSOutbound,
  sheetIdEnv: "GOOGLE_OUTBOUND_SHEET_ID",
  createTitle: "RoseRocket Outbound",
  addressPrefix: "to",
  manifestSide: "delivery",
  sequenceKey: "deliverySequence",
  dateSortKey: "deliverySortMs",
  summaryAnchor: "last",
  // Planners may type OO / CD into Type on a lane with no driver yet, to price the run before committing
  // it. Outbound only — this was asked for on that board alone.
  allowAssumedType: true,
};
const INBOUND_CONFIG = {
  label: "Inbound",
  masterTab: US_INBOUND_TAB,
  triggerTag: INBOUND_TRIGGER_TAG,
  getSheetId: getInboundSheetId,
  filterOrders: filterUSInbound,
  sheetIdEnv: "GOOGLE_INBOUND_SHEET_ID",
  createTitle: "RoseRocket Inbound",
  addressPrefix: "from",
  manifestSide: "pickup",
  sequenceKey: "pickupSequence",
  dateSortKey: "pickupSortMs",
  // "last" = the final US pickup on the manifest, not the first one. See laneAnchorOrder.
  summaryAnchor: "last",
  // Inbound Summary carries an editable, sync-preserved "Actual Footage" column plus the whole-trip
  // "Rounder" revenue/miles/RPM columns (see buildSummaryColumns).
  showActualFootage: true,
  showRounder: true,
  // Show the Manifest ID even when the manifest has no nickname — an order dispatched to an outside
  // carrier is on a manifest the planners still need to find. Inbound only; asked for on that board.
  showUnnamedManifestId: true,
  // …and drop it off the master tab once that manifest is moving. Nicknamed manifests keep their flow.
  hideMovingUnnamedManifests: true,
};

// One engine for both the outbound (US Outbound) and inbound (US Inbound) sheets. `config` supplies the
// master tab name, the manifest trigger tag, the order filter (destination-USA vs origin-USA), and which
// spreadsheet to write. Everything else — Summary, nickname tabs, notes/colour preservation, banding,
// conditional formats, widths — is shared and behaves identically on both sheets.
async function runDirectionalSync(config) {
  const {
    masterTab,
    triggerTag,
    label,
    addressPrefix = "to",
    manifestSide = "delivery",
    sequenceKey = "deliverySequence",
    dateSortKey = "deliverySortMs",
    summaryAnchor = "last",
    showActualFootage = false,
    showRounder = false,
    allowAssumedType = false,
    showUnnamedManifestId = false,
    hideMovingUnnamedManifests = false,
  } = config;
  // Driver types (OO / CD) come from the org's user records. A failure here must not take the sync down —
  // the Type column just goes blank and the OO figures with it.
  let driverTypes = new Map();
  try {
    driverTypes = await fetchDriverTypes();
  } catch (err) {
    console.warn(`[Sync] Could not load driver types — Type/OO columns will be blank: ${err.message}`);
  }
  // Summary columns are per-direction: inbound adds Actual Footage and the Rounder columns. Rebuilt
  // further down once the sheet has been read — the assumed types can only come off the sheet itself,
  // and the layout (headers and widths) is identical either way, so the checks below are unaffected.
  let summaryCols = buildSummaryColumns({
    showActualFootage,
    showRounder,
    driverTypes,
  });
  const reservedTabs = reservedTabsFor(masterTab);
  const t0 = Date.now();
  console.log(`[Sync] ${label} refresh starting at ${new Date().toISOString()}`);

  let sheetId = config.getSheetId();
  const isOutboundDefault = config === OUTBOUND_CONFIG;
  if (!sheetId) {
    sheetId = await createSpreadsheet(config.createTitle);
    if (isOutboundDefault) saveSheetId(sheetId);
    console.warn(
      `[Sync] WARNING: ${config.sheetIdEnv} was not set, so a NEW spreadsheet was created (${sheetId}).\n` +
        `[Sync]          Set ${config.sheetIdEnv}=${sheetId} in your environment now.\n` +
        `[Sync]          On Render/serverless a local file does NOT persist between runs,\n` +
        `[Sync]          so without this every run will create yet another empty spreadsheet.`,
    );
  }

  console.log("\n[Sync] Fetching orders from RoseRocket...");
  const tFetch = Date.now();
  const orders = await fetchOrders();
  console.log(`[Sync] RoseRocket orders fetched in ${elapsed(tFetch)}`);
  const tFilter = Date.now();
  // Master subset (US-bound or US-origin), minus LDT/delivered legs; manifest info (nickname, tags,
  // miles) from master trips.
  const {
    orders: masterOrders,
    manifestByOrderId,
    schedulingByOrderId,
    ldtManifestTripIds,
  } = await filterOutLoadedDeliveries(config.filterOrders(orders), {
    manifestSide,
  });
  // When an outbound manifest reaches LDT, flag it US I/B so its inbound pickups surface on the inbound
  // sheet — the reverse of UT dropping an order off it. Only the outbound sync writes tags, and only
  // when SYNC_AUTO_TAG_INBOUND is on (default). Idempotent: skips manifests already tagged inbound.
  if (
    manifestSide === "delivery" &&
    envFlag("SYNC_AUTO_TAG_INBOUND", true) &&
    ldtManifestTripIds &&
    ldtManifestTripIds.size > 0
  ) {
    try {
      await autoTagInboundOnLdt(ldtManifestTripIds, {
        outboundTagName: OUTBOUND_TRIGGER_TAG,
        inboundTagName: INBOUND_TRIGGER_TAG,
      });
    } catch (err) {
      console.warn(`[Sync] Auto-tag US I/B step failed: ${err.message}`);
    }
  }
  // The master tab lists every qualifying Booked/In-Transit order, tagged or not. Only the per-nickname
  // tabs are opt-in: an order gets one when its manifest carries the trigger tag. Manifest tags were
  // already resolved above — no extra API calls.
  const taggedOrders = masterOrders.filter((o) =>
    manifestHasTriggerTag(manifestByOrderId.get(o.id), triggerTag),
  );
  console.log(
    `[Sync] ${masterTab} filter + enrichment in ${elapsed(tFilter)}: ${masterOrders.length} order(s) on the master; ` +
      `${taggedOrders.length} on manifests tagged "${triggerTag}" (nickname tabs).`,
  );

  const WEB = (
    process.env.ROSEROCKET_WEB_URL ??
    process.env.ROSEROCKET_ORG_URL ??
    ""
  ).replace(/\/+$/, "");

  // Notes are read from the master tab only so erasures aren't restored from regional tabs. The key
  // header must match the "Order ID" column header exactly — readNotesByKey looks it up by name, and a
  // mismatch silently reads zero notes and wipes them all on the next write.
  const notesByOrder = await readNotesByKey(sheetId, "Order ID", "Notes", {
    sourceTabs: [masterTab],
  });
  const noteCount = [...notesByOrder.values()].filter((n) => n).length;
  console.log(`[Sync] Preserved ${noteCount} note(s) from ${masterTab}.`);

  // Summary notes are the planners' own text and must survive the full refresh. They're keyed by
  // Manifest ID rather than the lane name, so a note follows its manifest through a rename (the
  // nickname — and therefore the lane — changes, the manifest ID doesn't) and only disappears once the
  // manifest itself drops off the sheet. Read from Summary alone, before any tab is written; on the
  // first run after this column was added there is no "Notes" header yet, so this reads zero notes.
  const summaryNotesByManifest = await readNotesByKey(
    sheetId,
    "Manifest ID",
    "Notes",
    { sourceTabs: [SUMMARY_TAB] },
  );
  const summaryNoteCount = [...summaryNotesByManifest.values()].filter(
    (n) => n,
  ).length;
  console.log(`[Sync] Preserved ${summaryNoteCount} note(s) from Summary.`);

  // "Actual" is the planners' own entry and must survive the refresh the same way — keyed by Manifest
  // ID, read from Summary before any tab is written. Inbound only; empty on the first run after the
  // column is added (no "Actual" header yet).
  const summaryActualFootageByManifest = showActualFootage
    ? await readNotesByKey(sheetId, "Manifest ID", "Actual", {
        sourceTabs: [SUMMARY_TAB],
      })
    : new Map();
  const actualFootageCount = [...summaryActualFootageByManifest.values()].filter(
    (v) => v,
  ).length;
  if (showActualFootage) {
    console.log(
      `[Sync] Preserved ${actualFootageCount} Actual value(s) from Summary.`,
    );
  }

  // The note's fill colour is preserved the same way — keyed by manifest, so it follows its lane when the
  // rows re-sort instead of staying behind on a row number.
  const summaryNoteColors = await readColumnColorsByKey(sheetId, SUMMARY_TAB, {
    keyHeader: "Manifest ID",
    colorHeader: "Notes",
  });
  console.log(
    `[Sync] Preserved ${summaryNoteColors.size} note colour(s) from Summary.`,
  );

  // The planner's assumed Type for lanes with no driver yet. Read from Summary before anything is
  // written, keyed by Manifest ID so it follows the manifest through a lane rename. Rows that DO have a
  // driver are read too but never consulted — the derived type wins there, which is what makes assigning
  // a driver erase the assumption.
  const assumedTypeByManifest = allowAssumedType
    ? await readNotesByKey(sheetId, "Manifest ID", "Type", {
        sourceTabs: [SUMMARY_TAB],
      })
    : new Map();
  if (allowAssumedType) {
    summaryCols = buildSummaryColumns({
      showActualFootage,
      showRounder,
      driverTypes,
      assumedTypes: assumedTypeByManifest,
    });
    const assumed = [...assumedTypeByManifest.values()].filter(
      (v) => normalizeAssumedType(v),
    ).length;
    console.log(`[Sync] Preserved ${assumed} Type entr(ies) from Summary.`);
  }

  // Widths belong to the planners once a tab exists, so the Summary's are only (re)seeded when its LAYOUT
  // changes — e.g. the refresh that first adds City/State/Zip + Notes. After that a manual resize sticks.
  const summaryHeaders = summaryCols.map((c) => c.header);
  let summaryLayoutChanged = true;
  let summaryCutValue = OO_CUT_DEFAULT;
  try {
    // One read serves both: the header row (now row 2) for the layout check, and row 1 for the planner's
    // OO Cut rate. UNFORMATTED_VALUE so the percentage comes back as 0.59, not "59.00%".
    const grid = await readTabValues(sheetId, SUMMARY_TAB, {
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    summaryCutValue = readSummaryCutValue(grid);
    const current = grid[SUMMARY_HEADER_ROW - 1] ?? [];
    const trimmed = current.map((h) => String(h ?? "").trim());
    summaryLayoutChanged =
      trimmed.length !== summaryHeaders.length ||
      summaryHeaders.some((h, i) => trimmed[i] !== h);
  } catch {
    summaryLayoutChanged = true;
  }
  if (summaryLayoutChanged) {
    console.log("[Sync] Summary layout changed — its column widths will be re-seeded.");
  }

  const regionalColumns = buildSheetColumns({
    notesByOrder,
    manifestByOrderId,
    web: WEB,
    addressPrefix,
  });
  // Only the MASTER tab shows un-nicknamed manifests. The lane tabs are grouped by nickname, so these
  // orders never reach them anyway — passing the flag there would be misleading, not merely redundant.
  const masterColumns = buildSheetColumns({
    notesByOrder,
    manifestByOrderId,
    web: WEB,
    includeMilesRpm: false,
    includeNickname: true,
    addressPrefix,
    showUnnamedManifestId,
  });

  // Capture the FIRST nickname tab's column widths as they are RIGHT NOW — before anything is written.
  // A nickname tab is deleted and rebuilt whenever its manifest is renamed, and the rebuilt tab arrives
  // carrying only the code defaults. Reading the widths after the write is therefore too late (that is
  // exactly what reset them). These pre-sync widths are re-applied to every nickname tab at the end.
  let priorNicknameWidths = null;
  try {
    priorNicknameWidths = await readFirstTabColumnWidths(sheetId, {
      skipTabs: [masterTab, SUMMARY_TAB, FORCE_REFRESH_TAB],
      columnCount: regionalColumns.length,
    });
    if (priorNicknameWidths) {
      console.log(
        `[Sync] Column widths captured from "${priorNicknameWidths.tabName}" (pre-sync): ${priorNicknameWidths.widths.join(",")}`,
      );
    }
  } catch (err) {
    console.error(`[Sync] ERROR reading pre-sync column widths: ${err.message}`);
  }

  // Applied to the MASTER records only, deliberately: the lane tabs and Summary are built from their own
  // order lists further down, so this cannot disturb them.
  let masterRecords = masterOrders;
  if (hideMovingUnnamedManifests) {
    const before = masterRecords.length;
    masterRecords = masterRecords.filter((o) => !isMovingUnnamedManifest(o, manifestByOrderId));
    const dropped = before - masterRecords.length;
    if (dropped) {
      console.log(
        `[Sync] ${dropped} order(s) hidden from ${masterTab} — on un-nicknamed manifests already moving.`,
      );
    }
  }

  const masterTask = {
    name: masterTab,
    records: annotateSheetOrders(
      sortSheetOrders(masterRecords, manifestByOrderId, schedulingByOrderId, {
        sequenceKey,
        dateSortKey,
      }),
      schedulingByOrderId,
    ),
    options: { columns: masterColumns },
  };

  // One tab per manifest nickname, created dynamically from the trigger-tagged orders (no hardcoded list).
  const laneTasks = groupOrdersByManifestNickname(
    taggedOrders,
    manifestByOrderId,
    reservedTabs,
  ).map(({ name, records }) => ({
    name,
    records: annotateSheetOrders(
      sortSheetOrders(records, manifestByOrderId, schedulingByOrderId, {
        sequenceKey,
        dateSortKey,
      }),
      schedulingByOrderId,
    ),
    options: { columns: regionalColumns },
  }));
  console.log(
    `[Sync] ${laneTasks.length} manifest-nickname tab(s): ${laneTasks.map((t) => t.name).join(", ") || "(none)"}`,
  );

  const summaryRecords = buildSummaryRecords(
    laneTasks,
    manifestByOrderId,
    WEB,
    summaryNotesByManifest,
    {
      addressPrefix,
      sequenceKey,
      anchor: summaryAnchor,
      actualFootageByManifest: summaryActualFootageByManifest,
    },
  );
  const summaryTask = {
    name: SUMMARY_TAB,
    records: summaryRecords,
    // headerRow 2: writeToSheet clears only from row 2 down, leaving the OO Cut cell on row 1 untouched.
    options: { columns: summaryCols, headerRow: SUMMARY_HEADER_ROW },
  };
  const allTasks = [masterTask, summaryTask, ...laneTasks];

  // Keep/reorder list is dynamic: fixed tabs, then the nickname tabs, then Force Refresh (last).
  const sheetTabOrder = [
    masterTab,
    SUMMARY_TAB,
    ...laneTasks.map((t) => t.name),
    FORCE_REFRESH_TAB,
  ];

  const tWrite = Date.now();
  for (let i = 0; i < allTasks.length; i++) {
    const task = allTasks[i];
    try {
      console.log(
        `\n[Sync] --- ${task.name} (${task.records.length} records) ---`,
      );
      await writeToSheetWithRetry(
        sheetId,
        task.name,
        task.records,
        task.options,
      );
    } catch (err) {
      console.error(`[Sync] ERROR writing ${task.name}: ${err.message}`);
    }
    if (i < allTasks.length - 1 && TAB_WRITE_DELAY_MS > 0)
      await sleep(TAB_WRITE_DELAY_MS);
  }
  console.log(
    `[Sync] ${label} sheet writes (${allTasks.length} tabs) in ${elapsed(tWrite)}`,
  );

  // The frozen "OO Cut" cell on row 1 of the Summary, rewritten with the value read back before the
  // refresh so a planner's edit round-trips instead of being reset. Every OO Rev formula multiplies by
  // this one cell, so changing it re-prices the whole tab immediately — no sync, no redeploy.
  try {
    await setConfigCell(sheetId, SUMMARY_TAB, {
      label: "OO Cut",
      value: summaryCutValue,
      numberFormat: { type: "PERCENT", pattern: "0.00%" },
    });
  } catch (err) {
    console.error(`[Sync] ERROR writing the Summary OO Cut cell: ${err.message}`);
  }

  try {
    await removeUnwantedSheets(sheetId, sheetTabOrder);
    await reorderSheets(sheetId, sheetTabOrder);
  } catch (err) {
    console.error(`[Sync] ERROR reordering ${label} tabs: ${err.message}`);
  }

  // Mirror the planners' color rules from the master tab onto every nickname tab. The master tab is the
  // single source of truth — set the conditional formatting there in the Sheets UI and each sync copies
  // it out, remapping columns by header (the subset tabs have Miles/RPM but no Nickname). Runs after the
  // tabs are written and cleaned up, so only live tabs get rules.
  try {
    await syncConditionalFormats(sheetId, {
      sourceTab: masterTab,
      sourceHeaders: masterColumns.map((c) => c.header),
      targets: laneTasks.map((t) => ({
        tabName: t.name,
        headers: regionalColumns.map((c) => c.header),
      })),
    });
  } catch (err) {
    console.error(`[Sync] ERROR mirroring conditional formats: ${err.message}`);
  }

  // Size the "Alternating colors" banding so the stripes stop at the last row that actually has data,
  // on every tab. Banding is a separate mechanism from conditional formatting, so it does NOT ride
  // along above — this also gives the nickname tabs stripes they'd otherwise never get. Row counts
  // change every run, so the band has to be re-sized each sync. A tab with no data gets no stripes.
  const bandedRowCount = (task) =>
    task.records.length > 0 ? task.records.length + 2 : 0; // header + data rows + totals row
  try {
    await syncBanding(sheetId, {
      sourceTab: masterTab,
      tabs: [masterTask, summaryTask, ...laneTasks].map((t) => ({
        tabName: t.name,
        rowCount: bandedRowCount(t),
        columnCount: t.options.columns.length,
        // Start the stripes at the table, so the Summary's OO Cut config row stays outside the band.
        startRowIndex: (t.options.headerRow ?? 1) - 1,
      })),
    });
  } catch (err) {
    console.error(`[Sync] ERROR sizing alternating colors: ${err.message}`);
  }

  // Re-apply the widths captured from the first nickname tab BEFORE this sync ran, onto every nickname
  // tab — including one that was just rebuilt by a manifest rename, so it gets its widths back instead
  // of keeping the code defaults. Resize the first nickname tab (the one after Summary) and every
  // nickname tab matches it from the next sync on.
  if (priorNicknameWidths && laneTasks.length > 0) {
    try {
      await applyColumnWidths(sheetId, {
        tabs: laneTasks.map((t) => t.name),
        widths: priorNicknameWidths.widths,
      });
    } catch (err) {
      console.error(
        `[Sync] ERROR applying nickname tab column widths: ${err.message}`,
      );
    }
  }

  // Seed the Summary's widths only on the refresh that changed its layout (see above).
  if (summaryLayoutChanged) {
    try {
      await applyColumnWidths(sheetId, {
        tabs: [SUMMARY_TAB],
        widths: summaryCols.map((c) => c.width),
      });
    } catch (err) {
      console.error(`[Sync] ERROR seeding Summary column widths: ${err.message}`);
    }
  }

  // Paint the preserved note colours back on, by manifest. Runs last: the write already wiped the Notes
  // column's fills, and going after syncBanding keeps a planner's highlight on top of the stripes. A
  // manifest that has left the sheet has no row here, so its colour is simply gone.
  const notesColumnIndex = summaryCols.findIndex(
    (c) => c.header === "Notes",
  );
  const noteColorCells = [];
  summaryRecords.forEach((record, i) => {
    const color = summaryNoteColors.get(record.manifestId);
    // 0-based sheet row of data row i: the header row itself, plus one, plus the offset.
    if (color) noteColorCells.push({ rowIndex: i + SUMMARY_HEADER_ROW, color });
  });
  if (noteColorCells.length > 0) {
    try {
      await applyCellColors(sheetId, SUMMARY_TAB, {
        columnIndex: notesColumnIndex,
        cells: noteColorCells,
      });
    } catch (err) {
      console.error(`[Sync] ERROR restoring Summary note colours: ${err.message}`);
    }
  }

  // Freshness marker beside the Summary's OO Cut cell. Written last, after setConfigCell — that clears
  // the whole of row 1 before rewriting A1:B1, so a stamp placed earlier would be wiped by it.
  const stamped = await stampLastSynced(sheetId, SUMMARY_TAB);
  if (stamped) console.log(`[Sync] ${label} Summary stamped: last synced ${stamped}`);

  console.log(
    `[Sync] ${label} refresh complete in ${elapsed(t0)}: https://docs.google.com/spreadsheets/d/${sheetId}`,
  );
  return { sheetId, orderCount: masterOrders.length };
}

// Public entry points: the outbound sheet and the inbound sheet, same engine.
async function runOutboundSync() {
  return runDirectionalSync(OUTBOUND_CONFIG);
}

async function runInboundSync() {
  if (!getInboundSheetId()) {
    console.log("[Sync] GOOGLE_INBOUND_SHEET_ID not set — skipping inbound sync.");
    return { sheetId: null, orderCount: 0 };
  }
  return runDirectionalSync(INBOUND_CONFIG);
}

async function runOpsSync() {
  const t0 = Date.now();
  const opsSheetId = getOpsSheetId();
  if (!opsSheetId) {
    console.log("[Sync] GOOGLE_OPS_SHEET_ID not set — skipping ops sync.");
    return { opsSheetId: null };
  }

  const runForceDeliver = envFlag("SYNC_INCLUDE_FORCE_DELIVER", true);
  const runForceCancel = envFlag("SYNC_INCLUDE_FORCE_CANCEL", true);
  const runForceDeleteManifest = envFlag(
    "SYNC_INCLUDE_FORCE_DELETE_MANIFEST",
    true,
  );

  if (!runForceDeliver && !runForceCancel && !runForceDeleteManifest) {
    console.log(
      "[Sync] All SYNC_INCLUDE_FORCE_* flags are false — skipping ops queues.",
    );
    return { opsSheetId };
  }

  if (runForceDeliver) {
    try {
      await processForceDeliver(opsSheetId);
    } catch (err) {
      console.error(
        `[Sync] ERROR processing Force Deliver ops sheet: ${err.message}`,
      );
    }
  } else {
    console.log(
      "[Sync] SYNC_INCLUDE_FORCE_DELIVER=false — skipping Force Deliver.",
    );
  }

  if (runForceCancel) {
    try {
      await processForceCancel(opsSheetId);
    } catch (err) {
      console.error(
        `[Sync] ERROR processing Force Cancel ops sheet: ${err.message}`,
      );
    }
  } else {
    console.log(
      "[Sync] SYNC_INCLUDE_FORCE_CANCEL=false — skipping Force Cancel.",
    );
  }

  if (runForceDeleteManifest) {
    try {
      await processForceDeleteManifest(opsSheetId);
    } catch (err) {
      console.error(
        `[Sync] ERROR processing Force Delete Manifest ops sheet: ${err.message}`,
      );
    }
  } else {
    console.log(
      "[Sync] SYNC_INCLUDE_FORCE_DELETE_MANIFEST=false — skipping Force Delete Manifest.",
    );
  }

  console.log(
    "[Sync] Ops sheet tab cleanup/reorder disabled — preserving all existing tabs and data.",
  );

  console.log(
    `[Sync] Ops sync complete in ${elapsed(t0)}: https://docs.google.com/spreadsheets/d/${opsSheetId}`,
  );
  return { opsSheetId };
}

async function runCommissionSync() {
  const t0 = Date.now();
  const commissionSheetId = getCommissionSheetId();
  if (!commissionSheetId) {
    console.log(
      "[Sync] GOOGLE_COMMISSION_SHEET_ID not set — skipping commission sync.",
    );
    return { commissionSheetId: null };
  }

  try {
    console.log("\n[Sync] --- All Commission + commission tabs ---");
    await syncInvoiceSentReport(commissionSheetId);
  } catch (err) {
    console.error(`[Sync] ERROR writing All Commission report: ${err.message}`);
  }

  try {
    await removeUnwantedOpsSheets(
      commissionSheetId,
      COMMISSION_SHEET_TAB_ORDER,
    );
    await reorderSheets(commissionSheetId, COMMISSION_SHEET_TAB_ORDER);
  } catch (err) {
    console.error(`[Sync] ERROR reordering commission tabs: ${err.message}`);
  }

  console.log(
    `[Sync] Commission sync complete in ${elapsed(t0)}: ` +
      `https://docs.google.com/spreadsheets/d/${commissionSheetId}`,
  );
  return { commissionSheetId };
}

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

const VALID_SYNC_SCOPES = new Set([
  "full",
  "outbound",
  "inbound",
  "ops",
  "commission",
]);

function syncScope() {
  const scope = String(process.env.SYNC_SCOPE ?? "full")
    .trim()
    .toLowerCase();
  if (VALID_SYNC_SCOPES.has(scope)) return scope;
  console.warn(
    `[Sync] Unknown SYNC_SCOPE="${process.env.SYNC_SCOPE}" — using "full".`,
  );
  return "full";
}

async function runSync() {
  const scope = syncScope();
  console.log(
    `[Sync] Starting at ${new Date().toISOString()} (scope: ${scope})`,
  );

  let sheetId = null;
  let inboundSheetId = null;
  let opsSheetId = null;
  let commissionSheetId = null;

  const includeOutbound = scope === "full" || scope === "outbound";
  const includeInbound = scope === "full" || scope === "inbound";
  const includeOps = scope === "full" || scope === "ops";
  const includeCommission = scope === "full" || scope === "commission";

  if (includeOutbound || includeInbound || includeOps || includeCommission) {
    await ensureGoogleAuth();
  }

  if (includeOutbound) {
    ({ sheetId } = await runOutboundSync());
  }

  if (includeInbound) {
    ({ sheetId: inboundSheetId } = await runInboundSync());
  }

  if (includeOps && envFlag("SYNC_INCLUDE_OPS", true)) {
    ({ opsSheetId } = await runOpsSync());
  } else if (includeOps) {
    console.log("[Sync] SYNC_INCLUDE_OPS=false — skipping Force Deliver.");
  }

  if (includeCommission && envFlag("SYNC_INCLUDE_COMMISSION", true)) {
    ({ commissionSheetId } = await runCommissionSync());
  } else if (includeCommission) {
    console.log(
      "[Sync] SYNC_INCLUDE_COMMISSION=false — skipping commission report.",
    );
  }

  console.log(`\n[Sync] Complete at ${new Date().toISOString()}`);
  if (sheetId) {
    console.log(
      `[Sync] Outbound sheet: https://docs.google.com/spreadsheets/d/${sheetId}`,
    );
  }
  if (inboundSheetId) {
    console.log(
      `[Sync] Inbound sheet: https://docs.google.com/spreadsheets/d/${inboundSheetId}`,
    );
  }
  if (opsSheetId) {
    console.log(
      `[Sync] Ops sheet: https://docs.google.com/spreadsheets/d/${opsSheetId}`,
    );
  }
  if (commissionSheetId) {
    console.log(
      `[Sync] Commission sheet: https://docs.google.com/spreadsheets/d/${commissionSheetId}`,
    );
  }
  return { sheetId, inboundSheetId, opsSheetId, commissionSheetId, scope };
}

module.exports = {
  runSync,
  runOutboundSync,
  runInboundSync,
  runOpsSync,
  runCommissionSync,
  sortSheetOrders,
  buildSummaryColumns,
  readSummaryCutValue,
  laneAnchorOrder,
  SUMMARY_HEADER_ROW,
  groupOrdersByManifestNickname,
  tabNameFromNickname,
  manifestHasTriggerTag,
  getOutboundSheetId,
  getInboundSheetId,
  getOpsSheetId,
  getCommissionSheetId,
  extractSheetId,
};
