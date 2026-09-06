require('dotenv').config();
const http = require('http');
const { runOutboundSync, runInboundSync } = require('./sync');

const PORT = Number(process.env.PORT) || 3000;
const WEBHOOK_SECRET = process.env.SYNC_WEBHOOK_SECRET;

// One in-flight flag per sheet so an inbound refresh can't be blocked by an outbound refresh (or the
// reverse), while still rejecting a second concurrent refresh of the SAME sheet.
const syncInProgress = { outbound: false, inbound: false };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBearerToken(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function authorize(req, res) {
  if (!WEBHOOK_SECRET) {
    sendJson(res, 503, { ok: false, error: 'SYNC_WEBHOOK_SECRET is not configured on the server.' });
    return false;
  }
  const token = readBearerToken(req);
  if (!token || token !== WEBHOOK_SECRET) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Shared handler for both sheets — `kind` is 'outbound' | 'inbound'.
async function handleRefresh(res, { kind, run, label }) {
  if (syncInProgress[kind]) {
    sendJson(res, 409, { ok: false, error: `A ${label} refresh is already in progress. Try again in a minute.` });
    return;
  }

  syncInProgress[kind] = true;
  const startedAt = new Date().toISOString();
  console.log(`[Webhook] ${label} refresh requested at ${startedAt}`);

  try {
    const { sheetId } = await run();
    const completedAt = new Date().toISOString();
    sendJson(res, 200, {
      ok: true,
      scope: kind,
      message: `${label} sheet refreshed.`,
      sheetId,
      startedAt,
      completedAt,
    });
  } catch (err) {
    console.error(`[Webhook] ${label} refresh failed:`, err.message);
    sendJson(res, 500, { ok: false, error: err.message });
  } finally {
    syncInProgress[kind] = false;
  }
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0];

  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, syncInProgress });
    return;
  }

  if (req.method === 'POST' && path === '/refresh/outbound') {
    if (!authorize(req, res)) return;
    await handleRefresh(res, { kind: 'outbound', run: runOutboundSync, label: 'Outbound' });
    return;
  }

  if (req.method === 'POST' && path === '/refresh/inbound') {
    if (!authorize(req, res)) return;
    await handleRefresh(res, { kind: 'inbound', run: runInboundSync, label: 'Inbound' });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`[Webhook] Listening on port ${PORT}`);
  if (!WEBHOOK_SECRET) {
    console.warn('[Webhook] SYNC_WEBHOOK_SECRET is not set — /refresh/outbound is disabled.');
  }
});
