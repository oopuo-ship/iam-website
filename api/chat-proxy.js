// M2-01 hardened chat proxy — per D-05..D-11.
const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { z } = require('zod');
const pino = require('pino');
const https = require('https');
const { PassThrough } = require('stream');
const { IAM_KNOWLEDGE_BASE } = require('./knowledge-base');
const { SYSTEM_PROMPT } = require('./system-prompt');
const budget = require('./token-budget');
const { createContactRouter } = require('./contact-route');

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const PORT = Number(process.env.CHAT_PORT || 3860);
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.CHAT_MODEL || 'google/gemini-2.0-flash-001';
const ALLOWED_ORIGINS = (process.env.CHAT_ALLOWED_ORIGINS
  || 'https://interactivemove.nl,https://iam.abbamarkt.nl')
  .split(',').map(s => s.trim()).filter(Boolean);
const RL_MAX = Number(process.env.CHAT_RATE_LIMIT_MAX || 10);
const RL_WINDOW = Number(process.env.CHAT_RATE_LIMIT_WINDOW_MS || 60_000);
const UPSTREAM_URL = new URL(process.env.OPENROUTER_URL || 'https://openrouter.ai');

if (!API_KEY) log.warn('OPENROUTER_API_KEY not set — /api/chat will 503');

const app = express();
app.set('trust proxy', 1); // behind nginx in prod (Phase 02)

// Middleware order (agent discretion, per CONTEXT):
//  1. security headers (hand-rolled — avoid extra dep)
//  2. cors allowlist
//  3. json body parser with 32KB cap
//  4. per-IP rate limit on /api/chat
//  5. zod payload validation
//  6. upstream forward

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, false); // block no-origin (curl without -H) for /api/chat
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ['POST', 'OPTIONS'],
  credentials: false,
}));

// Explicit 403 for disallowed origins (cors() silently strips headers; we want an error status)
app.use('/api/chat', (req, res, next) => {
  const origin = req.get('origin');
  if (req.method === 'OPTIONS') return next();
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    log.warn({ origin, ip: req.ip }, 'origin_rejected');
    return res.status(403).json({ error: 'origin_not_allowed' });
  }
  next();
});

app.use('/api/chat', express.json({ limit: '32kb' })); // 413 on overflow

const chatLimiter = rateLimit({
  windowMs: RL_WINDOW,
  max: RL_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});
const BodySchema = z.object({
  messages: z.array(MessageSchema).min(1).max(20),
});

app.post('/api/chat', chatLimiter, (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'api_key_missing' });

  if (budget.isExhausted()) {
    log.warn({ period: budget.currentPeriodKey() }, 'budget_exhausted');
    return res.status(429).json({
      error: 'budget_exhausted',
      message: 'Monthly chat budget reached. Please contact klantcontact@interactivemove.nl or retry next month.',
    });
  }

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues, ip: req.ip }, 'validation_failed');
    return res.status(400).json({ error: 'invalid_payload' });
  }

  const upstreamMessages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${IAM_KNOWLEDGE_BASE}` },
    ...parsed.data.messages,
  ];

  const postData = JSON.stringify({ model: MODEL, messages: upstreamMessages, stream: true });

  const transport = UPSTREAM_URL.protocol === 'http:' ? require('http') : https;
  const upstream = transport.request({
    hostname: UPSTREAM_URL.hostname,
    port: UPSTREAM_URL.port || (UPSTREAM_URL.protocol === 'http:' ? 80 : 443),
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'IAM Support Chat',
      'Content-Length': Buffer.byteLength(postData),
    },
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    // Tap the upstream stream to capture usage.total_tokens from the final SSE event (D-10).
    const tap = new PassThrough();
    let buf = '';
    tap.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // Keep only the tail — usage lands at end of the stream.
      if (buf.length > 16_384) buf = buf.slice(-16_384);
    });
    tap.on('end', () => {
      try {
        const match = buf.match(/"total_tokens"\s*:\s*(\d+)/g);
        if (match && match.length) {
          const last = match[match.length - 1];
          const n = Number(last.match(/(\d+)/)[1]);
          if (n > 0) budget.recordUsage(n);
        }
      } catch (e) {
        log.warn({ err: e.message }, 'usage_parse_failed');
      }
    });
    up.pipe(tap).pipe(res);
  });

  upstream.on('error', (err) => {
    log.error({ err: err.message }, 'upstream_error');
    if (!res.headersSent) res.status(502).json({ error: 'upstream_error' });
  });

  upstream.write(postData);
  upstream.end();
});

// Mount /api/contact (M2-04). Reuses the top-level CORS allowlist.
app.use(createContactRouter({ log, allowedOrigins: ALLOWED_ORIGINS }));

// 413 handler for body-parser overflow
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    log.warn({ ip: req.ip }, 'body_too_large');
    return res.status(413).json({ error: 'payload_too_large' });
  }
  next(err);
});

if (require.main === module) {
  app.listen(PORT, () => log.info({ port: PORT, model: MODEL, allowed: ALLOWED_ORIGINS }, 'chat_proxy_listening'));
}

module.exports = app; // exported for smoke tests (Plan 05)
