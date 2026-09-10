require("dotenv").config();
const {
  bankCommissionMonths,
  closedMonthsSince,
  monthDateRange,
  previousMonthKey,
  fetchInvoiceSentOrders,
  buildInvoiceSentRows,
  filterRowsByDateRange,
  COMMISSION_SUMMARY_TAB,
} = require("./invoice-sent-report");

// One-off backfill of the commission Summary tab.
//
//   npm run commission:summary-backfill                # from COMMISSION_SUMMARY_FROM (default 2026-06)
//   npm run commission:summary-backfill -- 2026-06
//
// The commission sheet keeps only the current and previous month, both rebuilt from RoseRocket on every
// run, so older months exist nowhere on it — they have to be re-fetched. This walks back to the start
// month, builds the leg rows once, and banks each closed month it does not already have.
//
// Safe to re-run: bankCommissionMonths skips any month already on the tab, so nothing frozen is
// recomputed. Correcting a month means deleting its rows first, then running this again.
const DEFAULT_FROM = process.env.COMMISSION_SUMMARY_FROM || "2026-06";

function getCommissionSheetId() {
  const raw = process.env.GOOGLE_COMMISSION_SHEET_ID;
  return raw ? String(raw).trim() : null;
}

// Days from the first day of `fromMonth` to today, plus slack for orders invoiced well after delivery.
function sinceDaysFor(fromMonth, bufferDays = 21) {
  const { start } = monthDateRange(fromMonth);
  const days = Math.ceil((Date.now() - Date.parse(`${start}T00:00:00Z`)) / 86400000);
  return Math.max(days + bufferDays, bufferDays);
}

async function backfillCommissionSummary(spreadsheetId, { from = DEFAULT_FROM } = {}) {
  if (!/^\d{4}-\d{2}$/.test(from)) throw new Error(`Start month must be YYYY-MM, got "${from}"`);
  const months = closedMonthsSince(from);
  if (!months.length) {
    console.log(`[CommissionSummary] Nothing to do — no closed month at or after ${from}.`);
    return { months: [] };
  }
  const sinceDays = sinceDaysFor(from);
  console.log(
    `[CommissionSummary] Backfilling ${months.join(", ")} ` +
      `(last closed month is ${previousMonthKey()}); fetching ${sinceDays} day(s) of invoiced orders...`,
  );

  const entries = await fetchInvoiceSentOrders({ sinceDays });
  console.log(`[CommissionSummary] ${entries.length} invoiced order(s) fetched.`);
  if (!entries.length) {
    console.warn("[CommissionSummary] No orders returned — nothing banked.");
    return { months: [] };
  }

  // Built once for the whole window, then sliced per month — enriching each order costs several
  // RoseRocket calls, so doing it per month would repeat that work for every month in range.
  const rows = await buildInvoiceSentRows(entries);
  console.log(`[CommissionSummary] ${rows.length} leg row(s) built.`);

  const monthRows = new Map();
  for (const key of months) {
    const { start, end } = monthDateRange(key);
    const slice = filterRowsByDateRange(rows, start, end);
    console.log(`[CommissionSummary]   ${key} (${start} → ${end}): ${slice.length} leg row(s)`);
    monthRows.set(key, slice);
  }

  const result = await bankCommissionMonths(spreadsheetId, monthRows);
  console.log(
    `[CommissionSummary] Done — ${result.newMonths.length ? `banked ${result.newMonths.join(", ")}` : "nothing new to bank"}.`,
  );
  return result;
}

if (require.main === module) {
  const sheetId = getCommissionSheetId();
  if (!sheetId) {
    console.error("[CommissionSummary] GOOGLE_COMMISSION_SHEET_ID not set.");
    process.exit(1);
  }
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  backfillCommissionSummary(sheetId, { from: arg || DEFAULT_FROM })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[CommissionSummary] Failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { backfillCommissionSummary, COMMISSION_SUMMARY_TAB };
