require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { readSharedToken, writeSharedToken } = require('./token-cache');

// v1.0 auth: POST JSON to /api/v1/sessions on the org-specific subdomain.
// Credentials come from Settings → Org Apps in the RoseRocket UI.
const DEFAULT_ORG_URL = process.env.ROSEROCKET_ORG_URL; // e.g. https://yourorg.roserocket.com
const USERNAME      = process.env.ROSEROCKET_USERNAME;
const PASSWORD      = process.env.ROSEROCKET_PASSWORD;
const CLIENT_ID     = process.env.ROSEROCKET_CLIENT_ID;
const CLIENT_SECRET = process.env.ROSEROCKET_CLIENT_SECRET;

const stores = new Map(); // per-org in-memory cache + in-flight login

// When RoseRocket REFUSES a login (any 4xx — wrong credentials, a security block, "too many login
// attempts"), stop asking for a while instead of trying again on the next request. Retrying a refused
// login never helps, and it is actively harmful: RoseRocket counts the attempts, and a burst of them is
// what gets the account flagged. On 14 Oct a single refusal fanned out into ~10 attempts in seconds,
// RoseRocket blocked the account, and every scheduled sync on it stopped. One refusal now means one
// attempt, then nothing until the cool-down ends. Network errors and 5xx do not trip it — those are
// transient on RoseRocket's side, not a judgement about this account.
const LOGIN_COOLDOWN_MS = Number(process.env.ROSEROCKET_LOGIN_COOLDOWN_MS ?? 15 * 60 * 1000);

// A token taken from the shared cache must have at least this long left. Runs last up to ~10 minutes;
// starting one on a token about to expire just buys a second login halfway through it.
const SHARED_MIN_LIFE_MS = 5 * 60 * 1000;

function orgSlug(orgUrl) {
  try {
    return new URL(orgUrl).hostname.split('.')[0] || 'default';
  } catch {
    return 'default';
  }
}

function tokenPath(orgUrl) {
  const slug = orgSlug(orgUrl);
  if (orgUrl === DEFAULT_ORG_URL) {
    return path.join(__dirname, '..', '.token.json');
  }
  return path.join(__dirname, '..', `.token.${slug}.json`);
}

function tokenUrlFor(orgUrl) {
  if (process.env.ROSEROCKET_TOKEN_URL && orgUrl === DEFAULT_ORG_URL) {
    return process.env.ROSEROCKET_TOKEN_URL;
  }
  return `${String(orgUrl).replace(/\/+$/, '')}/api/v1/sessions`;
}

function getStore(orgUrl) {
  const key = orgSlug(orgUrl);
  if (!stores.has(key)) {
    stores.set(key, { memory: { token: null, expiresAt: 0 }, inFlight: null, refusedUntil: 0, refusal: null, rejected: null });
  }
  return stores.get(key);
}

// Throws away the cached token (memory + disk) so the next getToken logs in again. Called when the API
// answers 401/403: the token we hold is dead regardless of the expiry we recorded, and without this a
// long-running job would keep presenting it until its own clock said otherwise.
//
// `failedToken` is the token the rejected request actually carried. With several requests in flight,
// each one's 401 arrives separately: the first clears the dead token and starts a re-login, and the rest
// must NOT clear the replacement or cancel that re-login — otherwise every parallel 401 becomes its own
// login, the same burst that got the account throttled. So: only act if the failed token is still the
// current one, and never touch a re-login already in progress.
function invalidateToken(orgUrl = DEFAULT_ORG_URL, failedToken = null) {
  const store = getStore(orgUrl);
  if (failedToken && store.memory?.token && store.memory.token !== failedToken) return; // already replaced
  if (failedToken && !store.memory?.token && store.rejected === failedToken) return;   // already handled
  // Remember the token the API turned down, so the shared cache cannot hand the very same one back.
  store.rejected = failedToken ?? store.memory?.token ?? store.rejected;
  store.memory = { token: null, expiresAt: 0 };
  try {
    fs.unlinkSync(tokenPath(orgUrl));
  } catch {
    /* nothing cached on disk — in-memory reset is enough */
  }
}

function valid(entry) {
  return entry && entry.token && Date.now() < entry.expiresAt - 60_000;
}

function loadDiskToken(orgUrl) {
  try {
    const entry = JSON.parse(fs.readFileSync(tokenPath(orgUrl), 'utf8'));
    return valid(entry) ? entry : null;
  } catch {
    return null;
  }
}

function saveDiskToken(entry, orgUrl) {
  try {
    fs.writeFileSync(tokenPath(orgUrl), JSON.stringify(entry), 'utf8');
  } catch {
    /* non-fatal: fall back to in-memory cache only */
  }
}

async function login(orgUrl) {
  if (!orgUrl || !USERNAME || !PASSWORD || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      'Missing auth env vars. Required: ROSEROCKET_ORG_URL (or orgUrl arg), ROSEROCKET_USERNAME, ' +
      'ROSEROCKET_PASSWORD, ROSEROCKET_CLIENT_ID, ROSEROCKET_CLIENT_SECRET'
    );
  }

  const res = await axios.post(tokenUrlFor(orgUrl), {
    email:         USERNAME,
    password:      PASSWORD,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const payload = res.data?.data ?? res.data;
  const access_token = payload?.access_token;
  // RoseRocket currently issues SHORT-LIVED tokens — 1800s (30 minutes), not the day-long ones this
  // once assumed. Any job that outruns that must re-read the token rather than hold one (see client()
  // in roserocket.js, which resolves it per request). The fallback only applies if the field is absent.
  const expires_in   = payload?.expires_in ?? 86400;

  if (!access_token) {
    throw new Error(`No access_token in response: ${JSON.stringify(res.data)}`);
  }

  const entry = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  saveDiskToken(entry, orgUrl);
  console.log(`[Auth] Token obtained for ${orgSlug(orgUrl)} via /api/v1/sessions.`);
  return entry;
}

async function getToken(orgUrl = DEFAULT_ORG_URL) {
  if (!orgUrl) {
    throw new Error('Missing org URL for auth (set ROSEROCKET_ORG_URL or pass orgUrl)');
  }

  const store = getStore(orgUrl);

  if (valid(store.memory)) return store.memory.token;

  const disk = loadDiskToken(orgUrl);
  if (disk && disk.token !== store.rejected) {
    store.memory = disk;
    console.log(`[Auth] Token loaded from cache (${orgSlug(orgUrl)}).`);
    return disk.token;
  }

  if (Date.now() < store.refusedUntil) {
    const mins = Math.ceil((store.refusedUntil - Date.now()) / 60000);
    const err = new Error(
      `RoseRocket refused the login for ${orgSlug(orgUrl)} (${store.refusal}); not retrying for ${mins} more min.`,
    );
    err.rrLoginFailure = true;
    throw err;
  }

  if (!store.inFlight) {
    store.inFlight = resolveToken(orgUrl, store)
      .then(entry => { store.memory = entry; store.inFlight = null; return entry; })
      .catch(err => {
        store.inFlight = null;
        const status = err.response?.status;
        if (status >= 400 && status < 500) {
          store.refusedUntil = Date.now() + LOGIN_COOLDOWN_MS;
          const msg = err.response?.data?.errors?.[0]?.message ?? err.response?.data?.message ?? '';
          store.refusal = `HTTP ${status}${msg ? `: ${msg}` : ''}`;
          console.error(
            `[Auth] Login REFUSED for ${orgSlug(orgUrl)} (${store.refusal}). ` +
              `Not retrying for ${Math.round(LOGIN_COOLDOWN_MS / 60000)} min.`,
          );
        }
        err.rrLoginFailure = true;
        throw err;
      });
  }
  const entry = await store.inFlight;
  return entry.token;
}

// Shared cache first, then a real login — which is then shared for every other run. Runs inside the
// single in-flight promise, so parallel requests in one process cost one cache read and at most one login.
async function resolveToken(orgUrl, store) {
  const slug = orgSlug(orgUrl);
  const shared = await readSharedToken(slug);
  if (shared && shared.token !== store.rejected && Date.now() < shared.expiresAt - SHARED_MIN_LIFE_MS) {
    saveDiskToken(shared, orgUrl);
    const mins = Math.round((shared.expiresAt - Date.now()) / 60000);
    console.log(`[Auth] Token reused from shared cache (${slug}, ${mins} min left).`);
    return shared;
  }
  const entry = await login(orgUrl);
  await writeSharedToken(slug, entry);
  return entry;
}

module.exports = { getToken, invalidateToken, orgSlug };
