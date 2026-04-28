// M2-04 D-14/D-15-flavored smoke: exercise /api/contact against a local HubSpot mock.
// MUST NOT ever reach api.hsforms.com.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { startMockHubSpot } = require('./mock-hubspot');
const { startMockOpenRouter } = require('./mock-openrouter'); // reused to satisfy OPENROUTER_URL

const PROXY_PORT = 3862;
const ALLOWED = 'https://interactivemove.nl';
const DISALLOWED = 'https://evil.example.com';
const PORTAL_ID = 'test-portal-123';
const FORM_GUID = 'test-form-guid-456';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitForPort(port, host, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, host);
      sock.once('connect', () => { sock.end(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${host}:${port}`));
        setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

async function main() {
  const orMock = await startMockOpenRouter(0);
  const hsMock = await startMockHubSpot(0);
  const orUrl = `http://127.0.0.1:${orMock.port}`;
  const hsUrl = `http://127.0.0.1:${hsMock.port}`;
  console.log(`[mock-openrouter] ${orUrl}`);
  console.log(`[mock-hubspot]    ${hsUrl}`);

  const env = {
    ...process.env,
    CHAT_PORT: String(PROXY_PORT),
    CHAT_ALLOWED_ORIGINS: 'https://interactivemove.nl,https://iam.abbamarkt.nl',
    OPENROUTER_URL: orUrl,
    OPENROUTER_API_KEY: 'test-dummy',
    HUBSPOT_FORMS_API_URL: hsUrl,
    HUBSPOT_PORTAL_ID: PORTAL_ID,
    HUBSPOT_CONTACT_FORM_GUID: FORM_GUID,
    CONTACT_RATE_LIMIT_MAX: '5',
    CONTACT_RATE_LIMIT_WINDOW_MS: '600000',
    TOKEN_BUDGET_PATH: '/tmp/iam-test-contact-budget.json',
    LOG_LEVEL: 'warn',
  };

  const proxy = spawn('node', ['chat-proxy.js'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const results = [];
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  };

  try {
    await waitForPort(PROXY_PORT, '127.0.0.1', 5000);
    console.log(`[proxy] listening on 127.0.0.1:${PROXY_PORT}`);
    const url = `http://127.0.0.1:${PROXY_PORT}/api/contact`;

    // (a) valid allowed-origin submission → 200, mock receives body with correct fields + URL path
    {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': ALLOWED },
        body: JSON.stringify({
          firstname: 'Otto',
          email: 'smoke-test@example.com',
          company: 'TEST-IGNORE',
          message: 'Smoke test submission',
          consent: true,
          pageUri: 'https://interactivemove.nl/',
          pageName: 'Home',
        }),
      });
      const body = await res.json().catch(() => ({}));
      const ok = res.status === 200 && body.ok === true;
      record('(a) valid submission returns 200 {ok:true}', ok, `status=${res.status}`);

      const last = hsMock.receivedRequests[hsMock.receivedRequests.length - 1];
      const pathOk = !!last && last.url === `/submissions/v3/integration/submit/${PORTAL_ID}/${FORM_GUID}`;
      const hasFields = !!last && last.body.includes('"firstname"') && last.body.includes('smoke-test@example.com');
      record('(a) mock received correct v3 path', pathOk, last ? last.url : '(no request)');
      record('(a) mock received fields array with firstname+email', hasFields, '');
    }

    // (b) disallowed origin → 403
    {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': DISALLOWED },
        body: JSON.stringify({ firstname: 'X', email: 'x@x.com' }),
      });
      record('(b) disallowed origin returns 403', res.status === 403, `status=${res.status}`);
    }

    // (c) missing required field → 400
    {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': ALLOWED },
        body: JSON.stringify({ firstname: 'NoEmail' }),
      });
      record('(c) missing required field returns 400', res.status === 400, `status=${res.status}`);
    }

    // (d) honeypot filled → silent 200, mock MUST NOT have seen a new request
    {
      const before = hsMock.receivedRequests.length;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': ALLOWED },
        body: JSON.stringify({
          firstname: 'Bot',
          email: 'bot@example.com',
          website_url: 'http://bot.example.com/',
        }),
      });
      const after = hsMock.receivedRequests.length;
      const silent = res.status === 200 && after === before;
      record('(d) honeypot trip returns silent 200 (mock not called)', silent, `status=${res.status} before=${before} after=${after}`);
    }

    // (e) flood (6 requests; limit is 5/window) → at least one 429 in tail
    {
      const statuses = [];
      for (let i = 0; i < 6; i++) {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Origin': ALLOWED },
          body: JSON.stringify({ firstname: 'Flood', email: `f${i}@example.com` }),
        });
        statuses.push(r.status);
        try { await r.text(); } catch (_) { /* drain */ }
      }
      record('(e) flood yields 429 once limit is exceeded', statuses.includes(429), `statuses=${statuses.join(',')}`);
    }
  } catch (err) {
    record('harness error', false, err.message);
  } finally {
    proxy.kill('SIGTERM');
    await sleep(150);
    if (!proxy.killed) proxy.kill('SIGKILL');
    await orMock.stop();
    await hsMock.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== CONTACT SUMMARY ===');
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  - FAIL: ${f.name} (${f.detail})`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
