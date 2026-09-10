require('dotenv').config();
const axios = require('axios');
const { getToken, invalidateToken } = require('./auth');
const { usdToCadRateOn } = require('./fx');

// Keeps RoseRocket's USD→CAD Exchange Rates table (Settings → Accounting → Exchange rates) filled in
// automatically, so the CAD figures RoseRocket computes on bills — and therefore the commission
// report, which now reports RR's numbers verbatim — are based on a real published rate.
//
// The rate table is weekly, Saturday through Friday. Reverse-engineering the manually entered CEL
// rows showed the rule exactly: every week's rate is the Bank of Canada FXUSDCAD close of the FRIDAY
// IMMEDIATELY BEFORE the week starts (verified against 8 consecutive weeks, all 8 matching). BoC
// publishes that close around 16:30 ET Friday, so a Saturday-morning run always has it available.
//
// Exchange rates live on the platform host, not the network host used elsewhere in this project.
const PLATFORM_URL = (process.env.ROSEROCKET_PLATFORM_URL ?? 'https://platform.roserocket.com')
  .replace(/\/+$/, '');
const EXCHANGE_RATES_PATH = '/api/v1/exchange_rates';

// Each RoseRocket org keeps its own USD→CAD rate table, so the automated fill runs for every configured
// org. CE Logistics (CEL) feeds the commission report; CE Trucking (CET) is the main org. The rate value
// (Bank of Canada FXUSDCAD close) is the same for both — only the table it's written to differs.
const CEL_ORG_URL = (process.env.ROSEROCKET_CELOGISTICS_ORG_URL ?? '').replace(/\/+$/, '');
const CET_ORG_URL = (process.env.ROSEROCKET_ORG_URL ?? '').replace(/\/+$/, '');

const SOURCE_CURRENCY = 'usd';
const TARGET_CURRENCY = 'cad';

function shiftYmd(ymd, deltaDays) {
  const d = new Date(Date.parse(`${ymd}T12:00:00Z`) + deltaDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(ymd) {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0 = Sunday … 6 = Saturday
}

// The Saturday→Friday week containing `ymd`, plus the Friday whose BoC close prices it.
function rateWeekFor(ymd) {
  const saturday = shiftYmd(ymd, -((dayOfWeek(ymd) + 1) % 7));
  return {
    fromDate: saturday,
    toDate: shiftYmd(saturday, 6),
    rateDate: shiftYmd(saturday, -1), // the Friday before the week opens
  };
}

// The token is resolved PER REQUEST, not baked into the instance at creation. RoseRocket tokens live
// 30 minutes, and this job walks up to 40 pages: a run that starts near the end of a token's life would
// otherwise carry a stale bearer through every remaining call and fail. A 401/403 refreshes it and
// retries once — the same shape roserocket.js uses, and the fix for the failure mode that once left the
// trip-history archive full of half-empty rows.
async function api(orgUrl) {
  if (!orgUrl) {
    throw new Error('No RoseRocket org URL provided — cannot sync exchange rates.');
  }
  const instance = axios.create({
    baseURL: PLATFORM_URL,
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
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

function extractRates(payload) {
  return payload?.data?.exchange_rates ?? payload?.exchange_rates ?? [];
}

// Reads the whole table. The endpoint caps `limit` at 50 and its from_date filter parameters do not
// work — they return nothing even for weeks that exist — so every page is walked instead of filtering
// or trusting the newest-50 to contain the week in question. The table holds a few hundred rows and
// this runs once a week, so the extra calls cost nothing.
const PAGE_SIZE = 50;
const MAX_PAGES = 40; // ~2000 rows; a backstop against an endless loop, not a real limit

async function listExchangeRates(client, params = {}) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.get(EXCHANGE_RATES_PATH, {
      params: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, ...params },
    });
    const rows = extractRates(res.data);
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

// True when the table already prices this week, whether the row was created here or entered by hand.
// Manual entries always win: an existing week is never overwritten, only reported when it differs.
function findRateForWeek(rates, fromDate) {
  return (rates ?? []).find(
    (r) =>
      String(r?.from_date ?? '').slice(0, 10) === fromDate &&
      String(r?.source_currency ?? '').toLowerCase() === SOURCE_CURRENCY &&
      String(r?.target_currency ?? '').toLowerCase() === TARGET_CURRENCY,
  ) ?? null;
}

// Creates the row. RoseRocket refuses to create a rate whose date range overlaps an existing one, but
// it reports that as HTTP 200 with exchange_rate:null and the offending row in conflicting_exchange_rate
// — NOT as an error status. So a 200 alone does not mean the rate was written; the payload must be
// checked. This is the backstop behind findRateForWeek(): an existing week is never disturbed.
async function createExchangeRate(client, { fromDate, toDate, rate }) {
  const res = await client.post(EXCHANGE_RATES_PATH, {
    source_currency: SOURCE_CURRENCY,
    target_currency: TARGET_CURRENCY,
    exchange_rate: rate,
    from_date: `${fromDate}T00:00:00Z`,
    to_date: `${toDate}T00:00:00Z`,
  });
  const body = res.data?.data ?? res.data ?? {};
  const created = body.exchange_rate ?? null;
  const conflict = body.conflicting_exchange_rate ?? null;
  if (!created) {
    return { created: null, conflict, message: String(body.message ?? '').trim() };
  }
  return { created, conflict: null, message: '' };
}

// Creates the USD→CAD rate for the Saturday→Friday week containing `todayYmd` (default: today).
// Returns a summary describing what happened, so the caller can log or surface it.
async function syncExchangeRates({ today = null, orgUrl = CEL_ORG_URL, orgLabel = 'CEL' } = {}) {
  const target = String(today ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  const { fromDate, toDate, rateDate } = rateWeekFor(target);
  const label = `${orgLabel} ${fromDate}..${toDate}`;

  const client = await api(orgUrl);
  const existing = findRateForWeek(await listExchangeRates(client), fromDate);

  const rate = await usdToCadRateOn(rateDate);
  if (rate == null) {
    // Without a published rate there is nothing trustworthy to post; the next run picks it up.
    console.warn(`[FXRate] ${label}: no Bank of Canada rate available for ${rateDate} — nothing created.`);
    return { week: label, rateDate, rate: null, action: 'skipped-no-boc-rate' };
  }

  if (existing) {
    const current = Number(existing.exchange_rate);
    if (Number.isFinite(current) && Math.abs(current - rate) > 0.00005) {
      console.warn(
        `[FXRate] ${label}: already set to ${current} — keeping it (Bank of Canada ${rateDate} was ${rate}).`,
      );
    } else {
      console.log(`[FXRate] ${label}: already set to ${current} — nothing to do.`);
    }
    return { week: label, rateDate, rate, existingRate: current, action: 'skipped-exists' };
  }

  const { created, conflict, message } = await createExchangeRate(client, { fromDate, toDate, rate });
  if (!created) {
    const overlap = conflict
      ? `${String(conflict.from_date ?? '').slice(0, 10)}..${String(conflict.to_date ?? '').slice(0, 10)} = ${conflict.exchange_rate}`
      : 'unknown range';
    console.warn(
      `[FXRate] ${label}: not created — RoseRocket reports an overlapping rate (${overlap})${message ? `: ${message}` : ''}`,
    );
    return { week: label, rateDate, rate, action: 'skipped-conflict', conflict };
  }

  console.log(`[FXRate] ${label}: created USD→CAD ${rate} (Bank of Canada close ${rateDate}).`);
  return { week: label, rateDate, rate, action: 'created' };
}

// Fills the rate table for every configured org (CEL feeds the commission report; CET is the main org).
// Each org is independent: one being unconfigured or failing never stops the others, and the same weekly
// rate is written to each. This is what the exchange-rate cron runs.
async function syncAllExchangeRates({ today = null } = {}) {
  const targets = [
    { orgUrl: CEL_ORG_URL, orgLabel: 'CEL' },
    { orgUrl: CET_ORG_URL, orgLabel: 'CET' },
  ];
  const results = [];
  for (const { orgUrl, orgLabel } of targets) {
    if (!orgUrl) {
      console.warn(`[FXRate] ${orgLabel}: org URL not configured — skipped.`);
      results.push({ org: orgLabel, action: 'skipped-unconfigured' });
      continue;
    }
    try {
      results.push(await syncExchangeRates({ today, orgUrl, orgLabel }));
    } catch (err) {
      console.error(`[FXRate] ${orgLabel}: failed — ${err.response?.status ?? ''} ${err.message}`);
      if (err.response?.data) console.error(JSON.stringify(err.response.data).slice(0, 500));
      results.push({ org: orgLabel, action: 'error', error: err.message });
    }
  }
  return results;
}

module.exports = {
  syncExchangeRates,
  syncAllExchangeRates,
  rateWeekFor,
  listExchangeRates,
  findRateForWeek,
};

if (require.main === module) {
  syncAllExchangeRates()
    .then((results) => process.exit(results.some((r) => r.action === 'error') ? 1 : 0))
    .catch((err) => {
      console.error(`[FXRate] Failed: ${err.response?.status ?? ''} ${err.message}`);
      if (err.response?.data) console.error(JSON.stringify(err.response.data).slice(0, 500));
      process.exit(1);
    });
}
