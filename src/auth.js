require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// v1.0 auth: POST JSON to /api/v1/sessions on the org-specific subdomain.
// Credentials come from Settings → Org Apps in the RoseRocket UI.
const DEFAULT_ORG_URL = process.env.ROSEROCKET_ORG_URL; // e.g. https://yourorg.roserocket.com
const USERNAME      = process.env.ROSEROCKET_USERNAME;
const PASSWORD      = process.env.ROSEROCKET_PASSWORD;
const CLIENT_ID     = process.env.ROSEROCKET_CLIENT_ID;
const CLIENT_SECRET = process.env.ROSEROCKET_CLIENT_SECRET;

const stores = new Map(); // per-org in-memory cache + in-flight login

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
    stores.set(key, { memory: { token: null, expiresAt: 0 }, inFlight: null });
  }
  return stores.get(key);
}

// Throws away the cached token (memory + disk) so the next getToken logs in again. Called when the API
// answers 401/403: the token we hold is dead regardless of the expiry we recorded, and without this a
// long-running job would keep presenting it until its own clock said otherwise.
function invalidateToken(orgUrl = DEFAULT_ORG_URL) {
  const store = getStore(orgUrl);
  store.memory = { token: null, expiresAt: 0 };
  store.inFlight = null;
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
  if (disk) {
    store.memory = disk;
    console.log(`[Auth] Token loaded from cache (${orgSlug(orgUrl)}).`);
    return disk.token;
  }

  if (!store.inFlight) {
    store.inFlight = login(orgUrl)
      .then(entry => { store.memory = entry; store.inFlight = null; return entry; })
      .catch(err => { store.inFlight = null; throw err; });
  }
  const entry = await store.inFlight;
  return entry.token;
}

module.exports = { getToken, invalidateToken, orgSlug };
