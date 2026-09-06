require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Bank of Canada Valet API — daily USD→CAD reference rate (series FXUSDCAD). Free, no API key.
// The value is CAD per 1 USD (e.g. 1.3712 → 1 USD = 1.3712 CAD). Rates publish on business days
// only, so a target date that lands on a weekend or holiday resolves to the most recent prior
// business-day rate.
const VALET_SERIES = 'FXUSDCAD';
const VALET_URL = `https://www.bankofcanada.ca/valet/observations/${VALET_SERIES}/json`;
// Progressive lookback windows before the target date. The first spans weekends and normal
// holidays; the wider steps are a safety net for an unusually long run of consecutive closures.
const LOOKBACK_STEPS = [8, 21, 60];
const MAX_ATTEMPTS = 4;

// Temporary on-disk cache so repeated runs (the commission sync runs on a short cron) don't re-fetch
// a day that was already looked up. Defaults to the OS temp dir (cleared on reboot). Point
// FX_CACHE_FILE at a persistent path/volume to keep the cache across ephemeral cron containers.
const CACHE_FILE = process.env.FX_CACHE_FILE
  || path.join(os.tmpdir(), 'rr-sheet-sync-fxusdcad.json');

// Historical rates are immutable, so cache per target date. `rateCache` holds the in-flight Promise
// so concurrent callers (many legs share a delivered date) reuse a single HTTP request instead of
// stampeding the API. `diskCache` mirrors the resolved values to CACHE_FILE for reuse across runs.
const rateCache = new Map();
let diskCache = null;

function shiftYmd(ymd, deltaDays) {
  const ms = Date.parse(`${ymd}T12:00:00Z`);
  const d = new Date(ms + deltaDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

// Loads CACHE_FILE once and pre-seeds the in-memory cache so seen dates skip the network entirely.
function loadDiskCache() {
  if (diskCache) return diskCache;
  diskCache = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [d, v] of Object.entries(parsed)) {
        const n = Number(v);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(n) && n > 0) {
          diskCache[d] = n;
          if (!rateCache.has(d)) rateCache.set(d, Promise.resolve(n));
        }
      }
    }
  } catch {
    // Missing or unreadable cache file — start empty.
  }
  return diskCache;
}

// Persists a finalized rate. Node is single-threaded so the read-modify-write can't interleave;
// the temp-file + rename keeps the on-disk file intact if the process dies mid-write.
function saveRateToDisk(dateYmd, rate) {
  const cache = loadDiskCache();
  if (cache[dateYmd] === rate) return;
  cache[dateYmd] = rate;
  try {
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    console.warn(`[FX] Could not write rate cache (${CACHE_FILE}): ${err.message}`);
  }
}

// Picks the most recent observation dated on or before targetYmd (never a future day). If the target
// itself is a business day with a published rate, that exact-day rate wins; otherwise this returns
// the most recent business day *before* the target — the weekend/holiday fallback.
function pickMostRecentOnOrBefore(observations, targetYmd) {
  let best = null;
  for (const o of observations ?? []) {
    const d = o?.d;
    const v = Number(o?.[VALET_SERIES]?.v);
    if (!d || d > targetYmd || !Number.isFinite(v) || v <= 0) continue;
    if (!best || d > best.d) best = { d, v };
  }
  return best; // { d, v } | null
}

async function fetchRateFromValet(targetYmd) {
  // Widen the window until a business day at/before the target is found (or the steps run out),
  // so even a long holiday stretch resolves to the most recent prior business-day rate.
  for (const lookback of LOOKBACK_STEPS) {
    const res = await axios.get(VALET_URL, {
      params: { start_date: shiftYmd(targetYmd, -lookback), end_date: targetYmd },
      timeout: 20000,
    });
    const best = pickMostRecentOnOrBefore(res.data?.observations, targetYmd);
    if (best) return best;
  }
  return null;
}

// Returns a Promise for the USD→CAD rate (CAD per 1 USD) on dateYmd, or null when unavailable.
function usdToCadRateOn(dateYmd) {
  const target = String(dateYmd ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return Promise.resolve(null);
  loadDiskCache();
  if (rateCache.has(target)) return rateCache.get(target);

  const promise = (async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const best = await fetchRateFromValet(target);
        if (!best) {
          console.warn(`[FX] USD→CAD ${target}: Bank of Canada returned no rate in the lookup window.`);
          return null;
        }
        if (best.d !== target) {
          console.log(`[FX] USD→CAD ${target}: no rate published that day — using ${best.d} rate (${best.v}).`);
        }
        // Persist only finalized rates: any past date is settled, and a same-day exact match is too.
        // A same-day fallback (today's rate not published yet) is kept in memory only so a later run
        // re-checks once the real rate publishes.
        if (target < todayYmd() || best.d === target) saveRateToDisk(target, best.v);
        return best.v;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          console.warn(`[FX] USD→CAD ${target}: lookup failed after ${attempt} attempt(s): ${err.message}`);
          return null;
        }
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
    return null;
  })();

  // Cache successful lookups for the whole run; drop nulls/failures so a later row can retry.
  rateCache.set(target, promise);
  promise.then(v => { if (v == null) rateCache.delete(target); }).catch(() => rateCache.delete(target));
  return promise;
}

module.exports = { usdToCadRateOn };
