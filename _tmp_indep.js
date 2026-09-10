require('dotenv').config();
const { google } = require('googleapis');
const { ensureGoogleAuth } = require('./src/sheets.js');
const { fetchInvoiceSentOrders, buildInvoiceSentRows } = require('./src/invoice-sent-report.js');

// Deliberately NOT using filterRowsByDateRange / commissionRepForRow / summarizeRowsByRep —
// those are the functions being verified. Re-implemented here from the rep list in the source.
const REPS = ['Roger Gratton', 'Irena Pana', 'Larry Persons', 'Debbie Collins'];
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function repOf(row) {
  for (const line of String(row.onCommission ?? '').split('\n')) {
    const hit = REPS.find((r) => norm(r) === norm(line));
    if (hit) return hit;
  }
  return 'House';
}

(async () => {
  const days = Math.ceil((Date.now() - Date.parse('2026-06-01T00:00:00Z')) / 86400000) + 21;
  console.log(`fetching ${days} days of invoiced orders...`);
  const entries = await fetchInvoiceSentOrders({ sinceDays: days });
  const rows = await buildInvoiceSentRows(entries);
  console.log(`built ${rows.length} leg rows from ${entries.length} orders`);

  const want = {};
  for (const m of ['2026-06', '2026-07']) {
    const slice = rows.filter((r) => String(r.deliveredDate ?? '').slice(0, 7) === m);
    const agg = new Map();
    for (const r of slice) {
      const k = repOf(r);
      const a = agg.get(k) ?? { cad: 0, cost: 0, margin: 0, n: 0 };
      a.n++; a.cad += Number(r.revenueCad) || 0;
      a.cost += Number(r.carrierCost) || 0; a.margin += Number(r.margin) || 0;
      agg.set(k, a);
    }
    want[m] = { agg, n: slice.length };
  }

  const auth = await ensureGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const v = (await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_COMMISSION_SHEET_ID,
    range: "'Summary'!A1:F30", valueRenderOption: 'UNFORMATTED_VALUE' })).data.values || [];
  const H = v[0], iM = H.indexOf('Month'), iR = H.indexOf('On commission'),
        iC = H.indexOf('Total CAD'), iK = H.indexOf('Total Carrier Cost'), iG = H.indexOf('Margin $');

  let bad = 0, checked = 0;
  for (const m of ['2026-06', '2026-07']) {
    console.log(`\n${m}  (${want[m].n} leg rows recomputed independently)`);
    for (const [rep, a] of [...want[m].agg].sort((x, y) => y[1].cad - x[1].cad)) {
      const row = v.slice(1).find((r) => String(r[iM] ?? '') === m && String(r[iR] ?? '').trim() === rep);
      const near = (x, y) => Math.abs((Number(x) || 0) - (Number(y) || 0)) < 0.02;
      const ok = row && near(row[iC], a.cad) && near(row[iK], a.cost) && near(row[iG], a.margin);
      checked++; if (!ok) bad++;
      console.log(`   ${rep.padEnd(16)} n=${String(a.n).padStart(4)} cad=${a.cad.toFixed(2).padStart(11)} cost=${a.cost.toFixed(2).padStart(11)} margin=${a.margin.toFixed(2).padStart(10)}  ${ok ? 'MATCHES SHEET' : 'MISMATCH'}`);
      if (!ok && row) console.log(`        sheet: cad=${Number(row[iC]).toFixed(2)} cost=${Number(row[iK]).toFixed(2)} margin=${Number(row[iG]).toFixed(2)}`);
    }
  }
  console.log(`\n=== ${checked} rep-month rows checked, ${bad} mismatch(es)`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
