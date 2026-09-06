/**
 * RoseRocket inbound sheet — force refresh.
 *
 * WHY WEB APP: UrlFetchApp needs per-user Google authorization. A deployed web app runs
 * as the deployer (your client), so teammates can refresh without their own OAuth.
 *
 * One-time setup (client / sheet owner), bound to the US Inbound spreadsheet:
 *   1. Extensions → Apps Script → paste this file → Save.
 *   2. Edit setupRoseRocketWebhook() → Run once → Allow.
 *   3. Deploy → New deployment → Web app
 *        Execute as: Me
 *        Who has access: Anyone (or "Anyone in <your org>")
 *      → Deploy → copy the Web app URL.
 *   4. Run registerWebAppUrl() — paste the Web app URL when prompted (or edit the function).
 *   5. Run pinRefreshTab() — adds a "Force Refresh" tab anyone can click (no extra auth).
 *   6. Reload the spreadsheet — RoseRocket menu also works (one lightweight Allow per user).
 *
 * NOTE: this is the INBOUND counterpart of OutboundRefresh.gs — same script, but the webhook
 * points at /refresh/inbound so it refreshes the US Inbound sheet. Use the SAME Render web
 * service URL + SYNC_WEBHOOK_SECRET as the outbound sheet; only the path differs.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('RoseRocket')
    .addItem('Force refresh', 'forceRefresh')
    .addToUi();
}

/** Run once — stores Render webhook URL + secret (must match SYNC_WEBHOOK_SECRET on Render). */
function setupRoseRocketWebhook() {
  PropertiesService.getScriptProperties().setProperties({
    WEBHOOK_URL: 'https://YOUR-SERVICE.onrender.com/refresh/inbound',
    WEBHOOK_SECRET: 'YOUR_SYNC_WEBHOOK_SECRET',
  });
  Logger.log('Webhook configured.');
}

/**
 * Run once after deploying the web app — saves the deployment URL.
 * Or set WEB_APP_URL manually in Project Settings → Script properties.
 */
function registerWebAppUrl() {
  const ui = SpreadsheetApp.getUi();
  const prompt = ui.prompt(
    'Web app URL',
    'Paste the Web app URL from Deploy → Manage deployments (ends with /exec):',
    ui.ButtonSet.OK_CANCEL
  );
  if (prompt.getSelectedButton() !== ui.Button.OK) return;
  const url = String(prompt.getResponseText() || '').trim();
  if (!url) return;
  PropertiesService.getScriptProperties().setProperty('WEB_APP_URL', url);
  ui.alert('Web app URL saved. Run pinRefreshTab() next.');
}

/** Adds a clickable tab — no Google authorization needed for teammates who only click the link. */
function pinRefreshTab() {
  const url = getWebAppUrl();
  if (!url) {
    SpreadsheetApp.getUi().alert(
      'Deploy the web app first, then run registerWebAppUrl().\n\n' +
      'Deploy → New deployment → Web app → Execute as: Me → Anyone → Deploy'
    );
    return;
  }
  const linkUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'ui=1';
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Force Refresh');
  if (!sheet) {
    sheet = ss.insertSheet('Force Refresh', 0);
  } else {
    sheet.clear();
  }
  sheet.getRange('A1').setValue('Click the link below to pull the latest RoseRocket data into this spreadsheet.');
  sheet.getRange('A2').setFormula('=HYPERLINK("' + linkUrl + '", "Force refresh inbound sheet")');
  sheet.getRange('A2').setFontWeight('bold').setFontSize(14);
  sheet.setColumnWidth(1, 420);
  SpreadsheetApp.getUi().alert(
    'Done. Open the "Force Refresh" tab and use the link.\n\n' +
    'Share that tab with your team — they do not need to authorize Apps Script to click it.'
  );
}

function getWebAppUrl() {
  const stored = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (stored) return stored;
  try {
    return ScriptApp.getService().getUrl();
  } catch (e) {
    return '';
  }
}

/** Web app entry — runs as the deployer; calls Render webhook. */
function doGet(e) {
  const result = runWebhookRefresh();
  const showUi = e && e.parameter && e.parameter.ui === '1';
  if (showUi) {
    const title = result.ok ? 'Refresh complete' : 'Refresh failed';
    const detail = result.ok
      ? (result.message || 'Inbound sheet updated.')
      : (result.error || 'Unknown error');
    return HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:16px">' +
      '<h3>' + title + '</h3><p>' + detail + '</p>' +
      '<p style="color:#666;font-size:12px">You can close this tab and return to the spreadsheet.</p>' +
      '</body></html>'
    );
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function runWebhookRefresh() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WEBHOOK_URL');
  const secret = props.getProperty('WEBHOOK_SECRET');
  if (!url || !secret) {
    return { ok: false, error: 'Webhook not configured — run setupRoseRocketWebhook() in Apps Script.' };
  }
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + secret },
    });
    const code = response.getResponseCode();
    let body = {};
    try { body = JSON.parse(response.getContentText() || '{}'); } catch (err) { /* ignore */ }
    if (code === 200) {
      return { ok: true, message: body.message || 'Inbound sheet refreshed.' };
    }
    if (code === 409) {
      return { ok: false, error: body.error || 'A refresh is already running. Try again in a minute.' };
    }
    return { ok: false, error: body.error || ('HTTP ' + code) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Menu / drawing button — opens the web app (no UrlFetch permission for the clicker). */
function forceRefresh() {
  const webAppUrl = getWebAppUrl();
  if (!webAppUrl) {
    SpreadsheetApp.getUi().alert(
      'Web app not set up yet.\n\n' +
      '1. Deploy → New deployment → Web app (Execute as: Me)\n' +
      '2. Run registerWebAppUrl() and paste the deployment URL\n' +
      '3. Or run pinRefreshTab() for a no-auth link tab'
    );
    return;
  }
  const linkUrl = webAppUrl + (webAppUrl.indexOf('?') >= 0 ? '&' : '?') + 'ui=1';
  const html = HtmlService.createHtmlOutput(
    '<p>Opening refresh…</p>' +
    '<script>window.open("' + linkUrl + '","_blank");google.script.host.close();</script>'
  ).setWidth(280).setHeight(80);
  SpreadsheetApp.getUi().showModalDialog(html, 'RoseRocket');
  SpreadsheetApp.getActiveSpreadsheet().toast('Refresh started — check the new browser tab.', 'RoseRocket', 8);
}
