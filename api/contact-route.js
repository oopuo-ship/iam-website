// /api/contact — server-to-server HubSpot Forms v3 submission + local-MTA notification.
// Mounted by api/chat-proxy.js. Reuses the hardened CORS allowlist.
// Env:
//   HUBSPOT_PORTAL_ID              — required, numeric portal id
//   HUBSPOT_CONTACT_FORM_GUID      — required, UUID of the contact form
//   HUBSPOT_FORMS_API_URL          — default https://api.hsforms.com
//   CONTACT_RATE_LIMIT_MAX         — default 5
//   CONTACT_RATE_LIMIT_WINDOW_MS   — default 600_000 (10 min)
//   NOTIFY_EMAIL_TO                — optional; recipient(s), comma-separated. When set
//                                    together with NOTIFY_EMAIL_FROM, every validated
//                                    submission also sends a direct email through the
//                                    local MTA (localhost:25, no auth — relies on the
//                                    host machine running its own mail server, e.g. the
//                                    Plesk-managed Postfix on the production box).
//   NOTIFY_EMAIL_FROM              — optional; verified sender address on the local MTA
const express = require('express');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { z } = require('zod');

const NOTIFY_TO = (process.env.NOTIFY_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
const NOTIFY_FROM = process.env.NOTIFY_EMAIL_FROM || '';
const mailer = (NOTIFY_TO.length && NOTIFY_FROM)
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST || '127.0.0.1',
      port: Number(process.env.SMTP_PORT || 25),
      secure: false,
      ignoreTLS: true,
      pool: true,
      maxConnections: 2,
    })
  : null;

function sendNotificationEmail(data, log) {
  if (!mailer) return;
  const subject = `Contact form — ${data.firstname}${data.lastname ? ' ' + data.lastname : ''}${data.company ? ' (' + data.company + ')' : ''}`;
  const lines = [
    `Name: ${data.firstname} ${data.lastname || ''}`.trim(),
    `Email: ${data.email}`,
    data.company ? `Company: ${data.company}` : null,
    data.pageUri ? `Page: ${data.pageUri}` : null,
    data.formType ? `Form: ${data.formType}` : null,
    '',
    data.message || '(no message)',
  ].filter(l => l !== null);
  mailer.sendMail({
    from: NOTIFY_FROM,
    to: NOTIFY_TO,
    replyTo: data.email,
    subject,
    text: lines.join('\n'),
  }).then(
    () => log.info('notify_email_sent'),
    (err) => log.warn({ err: err.message }, 'notify_email_failed'),
  );
}

const FORMS_API_URL = new URL(process.env.HUBSPOT_FORMS_API_URL || 'https://api.hsforms.com');
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
const FORM_GUID = process.env.HUBSPOT_CONTACT_FORM_GUID;
const RL_MAX = Number(process.env.CONTACT_RATE_LIMIT_MAX || 5);
const RL_WINDOW = Number(process.env.CONTACT_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);

const ContactSchema = z.object({
  firstname: z.string().min(1).max(100),
  lastname:  z.string().max(100).optional().default(''),
  email:     z.string().email().max(200),
  company:   z.string().max(200).optional().default(''),
  message:   z.string().max(5000).optional().default(''),
  consent:   z.boolean().optional().default(false),
  pageUri:   z.string().max(500).optional().default(''),
  pageName:  z.string().max(200).optional().default(''),
  // Reserved for future per-form routing; ignored in MVP (single form GUID).
  formType: z.enum(['contact', 'partner']).optional().default('contact'),
  // Honeypot (D-05) checked BEFORE zod so we can silent-200 bots instead of 400ing them.
  // Not listed in the schema on purpose.
}).passthrough();

function toHubSpotFields(parsed) {
  const fields = [
    { name: 'firstname', value: parsed.firstname },
    { name: 'email',     value: parsed.email },
  ];
  if (parsed.lastname) fields.push({ name: 'lastname', value: parsed.lastname });
  if (parsed.company)  fields.push({ name: 'company',  value: parsed.company });
  if (parsed.message)  fields.push({ name: 'message',  value: parsed.message });
  return fields;
}

function buildBody(parsed) {
  return {
    fields: toHubSpotFields(parsed),
    context: {
      pageUri:  parsed.pageUri  || '',
      pageName: parsed.pageName || '',
    },
    legalConsentOptions: parsed.consent ? {
      consent: {
        consentToProcess: true,
        text: 'I agree to be contacted by IAM about my inquiry.',
      },
    } : undefined,
  };
}

function createContactRouter({ log, allowedOrigins }) {
  const router = express.Router();

  // Origin enforcement (belt-and-suspenders on top of cors middleware)
  router.use((req, res, next) => {
    const origin = req.get('origin');
    if (req.method === 'OPTIONS') return next();
    if (!origin || !allowedOrigins.includes(origin)) {
      log.warn({ origin, ip: req.ip, route: '/api/contact' }, 'origin_rejected');
      return res.status(403).json({ ok: false, reason: 'origin_not_allowed' });
    }
    next();
  });

  router.use(express.json({ limit: '32kb' }));

  const limiter = rateLimit({
    windowMs: RL_WINDOW,
    max: RL_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, reason: 'rate_limited' },
  });

  router.post('/api/contact', limiter, async (req, res) => {
    if (!PORTAL_ID || !FORM_GUID) {
      log.error('hubspot_config_missing — HUBSPOT_PORTAL_ID and HUBSPOT_CONTACT_FORM_GUID must be set');
      return res.status(503).json({ ok: false, reason: 'hubspot_config_missing' });
    }

    // Honeypot (D-05): check BEFORE zod so bots get a silent 200 (not a 400 tell).
    if (req.body && typeof req.body.website_url === 'string' && req.body.website_url.length > 0) {
      log.warn({ ip: req.ip }, 'contact_honeypot_tripped');
      return res.status(200).json({ ok: true });
    }

    const parsed = ContactSchema.safeParse(req.body);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues, ip: req.ip }, 'contact_validation_failed');
      return res.status(400).json({ ok: false, reason: 'invalid_payload' });
    }

    const url = `${FORMS_API_URL.origin}/submissions/v3/integration/submit/${PORTAL_ID}/${FORM_GUID}`;
    const body = buildBody(parsed.data);

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (r.ok) {
        log.info({ ip: req.ip, pageUri: parsed.data.pageUri }, 'contact_submitted');
        sendNotificationEmail(parsed.data, log);
        return res.status(200).json({ ok: true });
      }
      const text = await r.text().catch(() => '');
      log.error({ status: r.status, body: text.slice(0, 400) }, 'hubspot_non_ok');
      return res.status(502).json({ ok: false, reason: 'hubspot_unavailable' });
    } catch (err) {
      clearTimeout(timeout);
      log.error({ err: err.message }, 'hubspot_fetch_failed');
      return res.status(502).json({ ok: false, reason: 'hubspot_unavailable' });
    }
  });

  return router;
}

module.exports = { createContactRouter, ContactSchema };
