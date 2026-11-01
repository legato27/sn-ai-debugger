// End-to-end: load the unpacked extension in Chromium, point mock.service-now.com at the
// mock instance, open the side panel page against that tab and run a trace.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { startMock, IDS } from './mock-instance.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '..');
const shots = process.env.SHOTS || here;

const mock = await startMock({ port: 8443, tls: { key: path.join(here, '.tls/key.pem'), cert: path.join(here, '.tls/cert.pem') } });
const ctx = await chromium.launchPersistentContext('', {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--host-resolver-rules=MAP mock.service-now.com 127.0.0.1:8443', '--ignore-certificate-errors', '--no-proxy-server', '--headless=new'],
  viewport: { width: 420, height: 1400 },
});
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = sw.url().split('/')[2];
const sn = await ctx.newPage();
await sn.goto(`https://mock.service-now.com/now/nav/ui/classic/params/target/sn_aia_execution_plan.do%3Fsys_id%3D${IDS.plan}`);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://mock.service-now.com/*' }))[0].id);
const panel = await ctx.newPage();
const errors = [];
panel.on('pageerror', e => errors.push(String(e)));
panel.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);
await panel.waitForFunction(() => !document.getElementById('btnPage').disabled, null, { timeout: 10000 });
const instance = await panel.textContent('#instance');
await panel.click('#btnPage');
await panel.waitForSelector('.root-cause', { timeout: 30000 });
const rc = await panel.textContent('.root-cause .rc-title');
const findings = await panel.$$eval('.finding .rid', els => els.map(e => e.textContent.split(' ')[0]));
const progress = await panel.textContent('#progress');
await panel.screenshot({ path: path.join(shots, 'e2e-plan.png'), fullPage: true });
const timelineCount = await panel.$$eval('.tl', els => els.length);
await panel.locator('.timeline').first().screenshot({ path: path.join(shots, 'e2e-timeline.png') });

// Agent trace by name -> candidates -> click
await panel.fill('#q', 'Travel Policy');
await panel.click('#btnTrace');
await panel.waitForSelector('[data-trace]', { timeout: 15000 });
await panel.click('[data-trace]');
await panel.waitForSelector('.root-cause', { timeout: 30000 });
const rc2 = await panel.textContent('.root-cause .rc-title');
await panel.screenshot({ path: path.join(shots, 'e2e-agent.png'), fullPage: true });

// Recent runs
await panel.click('#btnRecent');
await panel.waitForSelector('[data-trace]', { timeout: 15000 });
const recent = await panel.$$eval('[data-trace]', els => els.length);

// Claude analysis against the mock Messages API
await sw.evaluate(async () => { await chrome.storage.local.set({ settings: { claudeKey: 'test-key', claudeBase: 'https://mock.service-now.com', claudeModel: 'claude-opus-5-5', claudeConfirmed: false } }); });
await panel.reload();
await panel.waitForFunction(() => !document.getElementById('btnPage').disabled, null, { timeout: 10000 });
await panel.fill('#q', IDS.plan);
await panel.click('#btnTrace');
await panel.waitForSelector('#claudeGo:not([disabled])', { timeout: 30000 });
await panel.click('#claudeGo');
await panel.waitForSelector('.consent', { timeout: 5000 });
const consent = await panel.textContent('.consent');
await panel.click('#claudeSend');
await panel.waitForSelector('#claudeQ', { timeout: 20000 });
const answer = await panel.textContent('.claude .answer');
await panel.fill('#claudeQ', 'Is there a second problem?');
await panel.press('#claudeQ', 'Enter');
await panel.waitForFunction(() => document.querySelectorAll('.claude .answer').length === 2 && document.getElementById('claudeQ'), null, { timeout: 20000 });
const followup = (await panel.$$eval('.claude .answer', els => els.map(e => e.textContent)))[1];
const meta = await panel.textContent('.claude .meta-line');
await panel.evaluate(() => document.getElementById('claudeCard').scrollIntoView());
await panel.locator('#claudeCard').screenshot({ path: path.join(shots, 'e2e-claude.png') });
const sent = mock.claudeLog.at(-1);

// Stop actions: opt-in, fills Scripts - Background, never submits
await sw.evaluate(async () => { const s = (await chrome.storage.local.get('settings')).settings || {}; await chrome.storage.local.set({ settings: { ...s, actionsEnabled: true } }); });
await panel.reload();
await panel.waitForFunction(() => !document.getElementById('btnPage').disabled, null, { timeout: 10000 });
await panel.fill('#q', IDS.plan);
await panel.click('#btnTrace');
await panel.waitForSelector('[data-act="stop-plan"]', { timeout: 30000 });
await panel.click('[data-act="stop-plan"]');
await panel.waitForSelector('#actOpen');
await panel.locator('#actionsCard').screenshot({ path: path.join(shots, 'e2e-actions.png') });
const [scriptsPage] = await Promise.all([ctx.waitForEvent('page'), panel.click('#actOpen')]);
await scriptsPage.waitForLoadState('load');
await scriptsPage.waitForFunction(() => document.querySelector('textarea[name=script]').value.length > 100, null, { timeout: 15000 });
const filled = await scriptsPage.$eval('textarea[name=script]', t => t.value);
const actionsResult = { filled: filled.includes('var DRY_RUN = true;') && filled.includes('EXPECTED_INSTANCE = "mock"') && filled.includes(IDS.plan), posts: mock.scriptPosts.length, progress: await panel.textContent('#progress') };

console.log(JSON.stringify({ extId, instance, timelineCount, rootCause: rc, findings, progress, agentRootCause: rc2, recent,
  claude: { consentShown: /Send this trace to Claude/.test(consent), answer: answer.slice(0, 90), followup, meta, requests: mock.claudeLog.length, turnsInLastRequest: sent?.body.messages.length, browserHeader: sent?.headers['anthropic-dangerous-direct-browser-access'] },
  actions: actionsResult, errors }, null, 1));
await ctx.close(); mock.server.close();
if (errors.length) process.exit(1);
