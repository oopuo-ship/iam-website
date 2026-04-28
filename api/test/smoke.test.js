// M2-01 D-13: smoke tests for the hardened chat proxy.
// Exercises origin lock (D-06), rate limit (D-07), size cap (D-08), and
// server-side KB/system-prompt prepend (D-09) against a local mock upstream.
// MUST NOT ever reach the live OpenRouter host — see OPENROUTER_URL env.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { startMockOpenRouter } = require('./mock-openrouter');

const PROXY_PORT = 3861;
const ALLOWED = 'https://interactivemove.nl';
const DISALLOWED = 'https://evil.example.com';
const BUDGET_FILE = '/tmp/iam-test-budget.json';

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

async function readBody(res) {
  const reader = res.body.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(Buffer.from)).toString('utf8');
}

async function main() {
  // Wipe budget file so a stale exhausted state from a previous run doesn't poison the 200 case.
  try { fs.unlinkSync(BUDGET_FILE); } catch { /* ignore */ }

  const mock = await startMockOpenRouter(0);
  const mockUrl = `http://127.0.0.1:${mock.port}`;
  console.log(`[mock] listening on ${mockUrl}`);

  const env = {
    ...process.env,
    CHAT_PORT: String(PROXY_PORT),
    CHAT_ALLOWED_ORIGINS: 'https://interactivemove.nl,https://iam.abbamarkt.nl',
    OPENROUTER_URL: mockUrl,
    OPENROUTER_API_KEY: 'test-dummy',
    CHAT_RATE_LIMIT_MAX: '10',
    CHAT_RATE_LIMIT_WINDOW_MS: '60000',
    TOKEN_BUDGET_PATH: BUDGET_FILE,
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

    const url = `http://127.0.0.1:${PROXY_PORT}/api/chat`;

    // (a) ALLOWED origin → 200 + streamed SSE body containing "hello world"
    //     and mock must have received a request whose body includes the KB sentinel.
    {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': ALLOWED },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      const body = await readBody(res);
      const combined = body.includes('hello') && body.includes('world');
      const ok = res.status === 200 && combined;
      record('(a) allowed origin returns 200 with streamed content', ok, `status=${res.status} bodyLen=${body.length}`);

      const lastMock = mock.receivedRequests[mock.receivedRequests.length - 1];
      const sentinelOk = !!(lastMock && lastMock.body.includes('Inter Active Move'));
      record('(a) mock received server-side KB prepend (D-09)', sentinelOk,
        `receivedRequests=${mock.receivedRequests.length}`);
    }

    // (b) DISALLOWED origin → 403
    {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': DISALLOWED },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      record('(b) disallowed origin returns 403', res.status === 403, `status=${res.status}`);
    }

    // (c) OVERSIZED body > 32KB → 413
    {
      const big = 'a'.repeat(40000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': ALLOWED },
        body: JSON.stringify({ messages: [{ role: 'user', content: big }] }),
      });
      record('(c) oversized (>32KB) body returns 413', res.status === 413, `status=${res.status}`);
    }

    // (d) FLOOD → at least one 429 in last two responses
    {
      const statuses = [];
      for (let i = 0; i < 12; i++) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Origin': ALLOWED },
          body: JSON.stringify({ messages: [{ role: 'user', content: `flood-${i}` }] }),
        });
        // drain body so sockets free up
        try { await readBody(res); } catch { /* ignore */ }
        statuses.push(res.status);
      }
      const tail = statuses.slice(-2);
      const ok = tail.includes(429);
      record('(d) flood (12 requests) yields 429 in last two responses', ok, `statuses=${statuses.join(',')}`);
    }
  } catch (err) {
    record('harness error', false, err.message);
  } finally {
    proxy.kill('SIGTERM');
    await sleep(150);
    if (!proxy.killed) proxy.kill('SIGKILL');
    await mock.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== SUMMARY ===');
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
