# Handoff: Production Deployment

This guide takes `oopuo-ship/iam-website` from source to a running
production instance on your VPS, fronted by Cloudflare, with the chat
proxy and HubSpot contact route live. Staging already runs end-to-end
at `https://iam.abbamarkt.nl` (on OOPUO infrastructure) — this is the
same codebase, deployed the same way, against your own VPS + Cloudflare
+ OpenRouter + HubSpot.

Est. time for a clean run: 45–75 min. Most of it is waiting (apt,
certbot, DNS propagation).

---

## 1. What you need before you start

| Item | Where to get it | Notes |
|---|---|---|
| Fresh Ubuntu 22.04 or 24.04 LTS VPS | your provider | 2 GB RAM / 20 GB disk is plenty. Root SSH access. |
| Domain in Cloudflare | `interactivemove.nl` already managed | Confirm the zone is live and nameservers point at Cloudflare |
| OpenRouter API key (prod) | https://openrouter.ai/keys | Create fresh — the staging key is not for prod. Give it a $10–20 monthly cap. |
| HubSpot Portal ID | portal.hubspot.com → Settings → Account Defaults | Expected: `49291889` |
| HubSpot contact form GUID | portal.hubspot.com → Marketing → Forms → the active contact form → URL bar shows the GUID | Expected: `82e91e6d-7a36-47a4-8171-9f213e17fcb5` |
| Admin email for Let's Encrypt renewal notices | any mailbox you monitor | receives maybe 1–2 emails/year |

---

## 2. Clone the repo on the VPS

```bash
ssh root@your-vps-ip
apt-get install -y git
mkdir -p /opt && cd /opt
git clone https://github.com/oopuo-ship/iam-website.git
cd iam-website
```

---

## 3. Run `bootstrap.sh`

`bootstrap.sh` is idempotent — safe to re-run if anything goes sideways.
It installs Node 20, nginx, systemd units, UFW, creates the `iam` and
`deploy` users, renders env files, and sets up TLS via certbot.

Replace the placeholder values below with yours:

```bash
sudo env \
  BOOTSTRAP_NONINTERACTIVE=1 \
  LETSENCRYPT_EMAIL=ops@interactivemove.nl \
  OPENROUTER_API_KEY=sk-or-v1-... \
  OPENROUTER_API_KEY_STAGING=sk-or-v1-... \
  REPO_URL=https://github.com/oopuo-ship/iam-website.git \
  DOMAIN=interactivemove.nl \
  bash bootstrap.sh
```

Notes:
- `OPENROUTER_API_KEY_STAGING` is required by the script even on a
  prod-only VPS. Reuse the prod key here or put a dummy non-empty
  value; only the prod key is actually used at runtime because staging
  is elsewhere.
- If you're serving both prod and a staging-on-same-host, drop
  `STAGING_ONLY=1`. If you're serving only prod (interactivemove.nl)
  and staging lives elsewhere, you can pass `STAGING_ONLY=0` (default)
  — but then DNS for `iam.abbamarkt.nl` must NOT point at this VPS.

Expected finish:
```
[bootstrap] DONE.
Next steps (human):
  1. Follow the Cloudflare runbook...
  2. Env files rendered at /etc/iam-api/env
  3. First deploy will be triggered by CI on push to main/staging.
```

---

## 4. Fill the HubSpot values in the env file

The env file starts with placeholders for HubSpot. Replace them:

```bash
sudo sed -i \
  -e 's#REPLACE_ME_HUBSPOT_PORTAL_ID#49291889#' \
  -e 's#REPLACE_ME_HUBSPOT_CONTACT_FORM_GUID#82e91e6d-7a36-47a4-8171-9f213e17fcb5#' \
  -e 's#REPLACE_ME_HUBSPOT_PARTNER_FORM_GUID#82e91e6d-7a36-47a4-8171-9f213e17fcb5#' \
  /etc/iam-api/env
sudo grep '^HUBSPOT' /etc/iam-api/env  # verify
```

The partner form GUID reuses the same form for now — when you create a
dedicated partner form in HubSpot later, swap it in.

---

## 5. First deploy

The deploy flow (automated or manual) builds a tarball of the repo and
invokes `/usr/local/bin/iam-deploy prod <sha> <tarball>`. It extracts
into a timestamped release dir, runs `npm ci --omit=dev`, atomic-flips
a `current` symlink, restarts the systemd unit, and health-checks.

**Manual first deploy** (run on the VPS, as root — subsequent deploys
should go through the deploy user from Actions):

```bash
cd /opt/iam-website
sudo git pull --ff-only
SHA=$(sudo git rev-parse --short HEAD)
TARBALL=/tmp/iam-deploy-${SHA}.tar.gz
sudo tar --exclude='.git' --exclude='node_modules' \
         --exclude='api/node_modules' --exclude='.github' \
         --exclude='.env*' \
         -czf "$TARBALL" -C /opt/iam-website .
sudo chown iam:iam "$TARBALL"
sudo -u deploy /usr/local/bin/iam-deploy prod "$SHA" "$TARBALL"
```

Expected tail of the output:
```
[iam-deploy prod] health check OK
[iam-deploy prod] deploy complete: /var/www/iam/releases/<timestamp>-<sha>
```

Quick local verification:
```bash
sudo systemctl status iam-api.service   # should be active (running)
sudo ss -tlnp | grep :3860               # should show node listening
curl -sS -o /dev/null -w '%{http_code}\n' --resolve interactivemove.nl:443:127.0.0.1 -k https://interactivemove.nl/
# expect: 200
```

---

## 6. Configure Cloudflare

There are two supported origin modes. Pick one:

### Option A — Proxied (orange cloud) with Cloudflare Origin Certificate **(recommended)**

1. Cloudflare → zone `interactivemove.nl` → SSL/TLS → Origin Server → **Create Certificate**
2. Hostnames: `*.interactivemove.nl, interactivemove.nl`
3. Validity: 15 years
4. Copy the Certificate PEM and Private Key PEM
5. On the VPS:
   ```bash
   sudo mkdir -p /etc/ssl/iam
   sudo nano /etc/ssl/iam/interactivemove.nl.crt    # paste cert, save
   sudo nano /etc/ssl/iam/interactivemove.nl.key    # paste key, save
   sudo chown root:root /etc/ssl/iam/interactivemove.nl.*
   sudo chmod 644 /etc/ssl/iam/interactivemove.nl.crt
   sudo chmod 600 /etc/ssl/iam/interactivemove.nl.key
   ```
6. Edit `/etc/nginx/sites-available/interactivemove.nl.conf` — replace
   the two Let's Encrypt paths with the origin cert paths:
   ```nginx
   ssl_certificate     /etc/ssl/iam/interactivemove.nl.crt;
   ssl_certificate_key /etc/ssl/iam/interactivemove.nl.key;
   ```
7. `sudo nginx -t && sudo systemctl reload nginx`
8. In Cloudflare → DNS: `interactivemove.nl` A record → VPS public IP, proxy ON (orange cloud). Same for `www` if you have one.
9. Cloudflare → SSL/TLS → Overview → **Full (strict)**
10. (Optional but worth it) Security → Bot Fight Mode ON; WAF → Create
    rule: rate-limit `/api/chat` to 10/min per IP.

Option A benefits: only Cloudflare can reach origin TLS (origin cert
is not trusted by anyone else), DDoS protection at edge, free.

### Option B — Let's Encrypt at origin, Cloudflare proxy

Only viable if DNS A record is temporarily set to "DNS only" (grey
cloud) during cert issuance, OR you use DNS-01 challenge.

Simpler path: temporarily flip proxy to DNS only, let bootstrap's
certbot succeed (during step 3), then flip proxy back on. This is what
the M2 Phase 02 Cloudflare runbook originally assumed. Option A is
cleaner long-term because renewals never need the DNS dance.

---

## 7. Smoke test prod end-to-end

```bash
# From any machine
curl -sS -o /dev/null -w 'GET / → %{http_code}\n' https://interactivemove.nl/
curl -sS -o /dev/null -w 'GET /pricing → %{http_code}\n' https://interactivemove.nl/pricing
curl -sS -o /dev/null -w 'GET /prijzen (should 301) → %{http_code}\n' -I https://interactivemove.nl/prijzen --max-redirs 0
curl -sSi -X OPTIONS \
  -H "Origin: https://interactivemove.nl" \
  -H "Access-Control-Request-Method: POST" \
  https://interactivemove.nl/api/chat | head -3
# expect: HTTP/2 204

# Real contact submission (use your own email; test will be visible
# in HubSpot and email inbox):
curl -sS -X POST https://interactivemove.nl/api/contact \
  -H "Origin: https://interactivemove.nl" \
  -H "Content-Type: application/json" \
  -d '{
    "firstname":"PROD",
    "lastname":"SMOKE-TEST",
    "email":"ops@interactivemove.nl",
    "company":"IAM internal",
    "message":"Production smoke test — ignore.",
    "consent":true,
    "pageUri":"https://interactivemove.nl/",
    "pageName":"Home",
    "language":"nl"
  }'
# expect: {"ok":true}
```

Confirm:
- `klantcontact@interactivemove.nl` received the email notification for
  `PROD SMOKE-TEST` (check spam folder if nothing in the inbox).
- HubSpot portal → Marketing → Forms → the form shows the submission.
- Delete the test contact record from HubSpot.

If the HubSpot email doesn't arrive: check the form's "Notification"
setting has `klantcontact@interactivemove.nl` listed (portal → the
form → Options → Set who receives email notifications).

---

## 8. Subsequent deploys

```bash
ssh root@vps
cd /opt/iam-website
sudo git pull --ff-only
SHA=$(sudo git rev-parse --short HEAD)
TARBALL=/tmp/iam-deploy-${SHA}.tar.gz
sudo tar --exclude='.git' --exclude='node_modules' \
         --exclude='api/node_modules' --exclude='.github' \
         --exclude='.env*' \
         -czf "$TARBALL" -C /opt/iam-website .
sudo chown iam:iam "$TARBALL"
sudo -u deploy /usr/local/bin/iam-deploy prod "$SHA" "$TARBALL"
```

Or automate: a GitHub Actions workflow is shipped at
`.github/workflows/deploy.yml`. To use it:
- Set repo Secrets: `SSH_PRIVATE_KEY` (an ed25519 key whose public
  half you've added to `/home/deploy/.ssh/authorized_keys` on the VPS),
  `VPS_HOST` (the DNS name or IP), `VPS_USER=deploy`.
- Set environments in GitHub → Settings → Environments → create
  `production` with a required reviewer.
- On push to `main`, the workflow SSHes to the VPS, uploads a tarball,
  and runs the same `iam-deploy` path.

If your VPS is behind NAT with SSH not exposed, the Actions workflow
won't reach it. Either expose SSH on the public IP (restrict to
GitHub's IP ranges in UFW), use a self-hosted Actions runner on the
VPS, or keep the manual `git pull + iam-deploy` path above.

---

## 9. Ops cheat sheet

```bash
# Tail the chat proxy logs (structured JSON via pino):
sudo journalctl -u iam-api -f

# Force a restart after env change:
sudo systemctl restart iam-api

# List last 5 releases:
ls -lt /var/www/iam/releases/ | head -6

# Rollback to previous release:
PREV=$(ls -1 /var/www/iam/releases/ | sort -r | sed -n 2p)
sudo ln -sfn /var/www/iam/releases/$PREV /var/www/iam/current
sudo -u deploy sudo -n systemctl restart iam-api

# Check what's in the env (without leaking secrets to stdout):
sudo stat /etc/iam-api/env               # size + perms
sudo grep -c '^' /etc/iam-api/env        # line count
sudo grep -v '^OPENROUTER_API_KEY' /etc/iam-api/env  # everything except the key

# Rotate the OpenRouter key:
sudo sed -i 's#OPENROUTER_API_KEY=.*#OPENROUTER_API_KEY=sk-or-v1-NEW#' /etc/iam-api/env
sudo systemctl restart iam-api

# Rotate the origin cert (if using Option A and cert expires or you
# rotate it in Cloudflare):
# Just overwrite /etc/ssl/iam/interactivemove.nl.{crt,key} and
# sudo nginx -t && sudo systemctl reload nginx

# View the monthly token budget state (Chat):
sudo cat /var/lib/iam-api/token-budget.json
```

---

## 10. Known implementation notes (learned during staging bring-up)

These are already handled in the current repo and bootstrap, but worth
knowing about when reading the code or debugging:

- **nginx 1.24 uses the legacy `listen 443 ssl http2;` syntax**, not
  `http2 on;`. Vhosts are written this way.
- **`iam` user has no login shell by design** (`--no-create-home
  --shell /usr/sbin/nologin`). npm needs a writable HOME directory,
  so bootstrap creates `/home/iam` with correct ownership.
- **`deploy` user runs `iam-deploy`, but file operations happen under
  `iam`** — the release dir has g+w/g+s so deploy (in `iam` group)
  can write and new files inherit the `iam` group.
- **Legacy Dutch URL redirects** live in
  `config/nginx/redirects.conf`, included into the main vhost via
  `/etc/nginx/snippets/iam-redirects.conf`.
- **Release pruning sorts by filename (reverse)**, not by mtime, to
  stay deterministic even when tar preserves tarball mtimes across
  extractions.
- **sudoers drop-in allows `deploy` to `sudo -n systemctl
  restart|reload`** the `iam-api*` and `nginx` units. It covers both
  `/bin/` and `/usr/bin/` paths and both unit-with-suffix forms
  because Ubuntu's usr-merge can cause sudoers path-match misses.

---

## 11. If something breaks

- **`nginx -t` fails** → look at the error line, usually a path in a
  vhost. The most common one after bootstrap is the Let's Encrypt
  cert path doesn't exist yet; if you picked Option A (Cloudflare
  origin cert), make sure step 6 replaced the paths.
- **Service won't start** → `sudo journalctl -u iam-api -n 50` — will
  show the JSON error line from pino, usually a missing env var or
  an exception at boot.
- **`iam-deploy` says "permission denied" on a release dir** →
  ownership drifted; `sudo chown -R iam:iam /var/www/iam &&
  sudo chmod -R g+w /var/www/iam`.
- **`/api/contact` returns 502** → the backend tried HubSpot and got
  a non-2xx. Check `sudo journalctl -u iam-api -f` for the log line
  with the HubSpot response, and verify the HubSpot env values.
- **Cloudflare says "Error 502 Bad Gateway"** → request didn't reach
  origin, or did and origin errored. If Cloudflare Analytics shows
  cached, purge cache. Otherwise check origin status via the `curl
  --resolve ... -k https://interactivemove.nl/ local-test` command
  in step 5.

---

## 12. Contact

OOPUO (website): `otto@oopuo.com` — keeper of the code and the staging
mirror. Prod ops from here on is yours; reach out if you hit something
that isn't in this document so we can fold it in.

HubSpot, OpenRouter, and Cloudflare account ownership stay with you.
OOPUO has no keys to any of those and no access to `interactivemove.nl`
DNS.

---

*Version: 1 — written at initial handover to IAM dev, after staging
(`iam.abbamarkt.nl`) verified end-to-end green.*

---

## 13. Plesk + AlmaLinux 9 deployment (recommended production target)

The Ubuntu / manual-systemd path documented in §1–§12 above is one option.
The recommended production target going forward is **AlmaLinux 9 (or
Rocky 9) with Plesk Obsidian**. Plesk owns nginx, SSL, the Node.js process
supervisor (Phusion Passenger), and the local mail server (Postfix). The
deploy automation is thinner because Plesk does most of the heavy lifting.

### 13.1 Prerequisites

- Server running AlmaLinux 9 or Rocky 9 (CentOS 8 is EOL — don't use it).
- Plesk Obsidian licensed and installed; Node.js extension enabled.
- Domain added as a Plesk subscription (creates the per-subscription
  system user and `/var/www/vhosts/<domain>/`).
- DNS A/AAAA pointed at the server.
- Postfix running (default on Plesk; verify `systemctl status postfix`).

### 13.2 One-time bootstrap

```bash
sudo DOMAIN=interactivemove.nl \
     SUBSCRIPTION_USER=interactivemove_xxxxx \
     OPENROUTER_API_KEY=... \
     HUBSPOT_PORTAL_ID=... \
     HUBSPOT_CONTACT_FORM_GUID=... \
     bash tools/bootstrap-plesk.sh
```

The script:
- Verifies AlmaLinux/Rocky 9 + Plesk are present.
- Creates `/var/www/vhosts/<domain>/iam-releases/` and `private/`.
- Renders the env file at `/var/www/vhosts/<domain>/private/iam-api.env`
  (mode 0640, owner = subscription user). Includes
  `NOTIFY_EMAIL_TO` / `NOTIFY_EMAIL_FROM` for the local-MTA email path —
  no SMTP creds needed because Plesk's Postfix runs on the same box.
- Verifies `localhost:25` is reachable.
- Prints a panel checklist (see §13.3) — these steps cannot be
  automated because they live in Plesk's database.

### 13.3 Plesk panel checklist (manual, one-time)

1. **Node.js**: Plesk → Domains → `<domain>` → Node.js. Set:
   - Application Mode: `production`
   - Application Root: `/var/www/vhosts/<domain>/iam-current`
   - Application Startup File: `server.js`
   - Click "Enable Node.js", then "NPM install".
2. **Environment variables**: same panel, "Custom environment variables"
   field. Paste the lines from `private/iam-api.env` (skip the comment
   lines).
3. **Nginx custom directives**: Plesk → Domains → `<domain>` →
   Apache & nginx Settings → "Additional nginx directives" (HTTPS box).
   Paste the contents of `config/nginx/plesk-additional-directives.conf`.
   This injects: 51 legacy-URL redirects, security headers, /api/* proxy.
4. **SSL**: Plesk → Domains → `<domain>` → SSL/TLS Certificates → install
   Let's Encrypt via the panel. Plesk handles renewal — do NOT run
   certbot manually.
5. **Mail**: confirm `nc -zv localhost 25` returns "succeeded". Optionally
   create the `notifications@<domain>` mailbox in Plesk → Mail if you
   want a real bounce address (otherwise Postfix rewrites it).

### 13.4 First deploy

From a workstation with SSH access to the Plesk box:

```bash
SHA=$(git rev-parse --short HEAD)
git archive --format=tar.gz -o /tmp/iam-deploy-$SHA.tar.gz HEAD
scp /tmp/iam-deploy-$SHA.tar.gz \
    interactivemove_xxxxx@<server>:/tmp/

ssh interactivemove_xxxxx@<server> \
    "/usr/local/bin/iam-deploy-plesk interactivemove.nl $SHA /tmp/iam-deploy-$SHA.tar.gz"
```

The script extracts, runs `npm ci --omit=dev`, flips the
`iam-current` symlink, and restarts the Passenger app via
`passenger-config restart-app`. Health check is the same OPTIONS
probe against the local Node port; on failure it rolls the symlink
back automatically.

### 13.5 Subsequent deploys

Same command — `iam-deploy-plesk <domain> <sha> <tarball>` — runs
both the symlink flip and the restart. No sudo required (Passenger
restarts are user-scoped under Plesk).

**Rollback:** repoint the symlink at a previous release dir under
`iam-releases/` and run `passenger-config restart-app
/var/www/vhosts/<domain>/iam-current`.

### 13.6 Ops cheat sheet (Plesk variant)

| What | How |
| --- | --- |
| Tail Node logs | Plesk → Domains → `<domain>` → Logs |
| Tail Passenger | `passenger-config print-instance-state` |
| Restart app | `passenger-config restart-app /var/www/vhosts/<domain>/iam-current` |
| Rotate env | Plesk panel → Node.js → "Custom environment variables" |
| Renew SSL | Automatic via Plesk Let's Encrypt extension |
| Check mail queue | `mailq` (or `postqueue -p`) |

### 13.7 Differences from the Ubuntu path

| Concern | Ubuntu (§1–§12) | Plesk + AlmaLinux 9 |
| --- | --- | --- |
| Process manager | systemd unit `iam-api.service` | Plesk Node.js extension (Passenger) |
| Restart | `sudo systemctl restart iam-api` | `passenger-config restart-app` |
| Sudoers drop-in | Required for `deploy` user | Not needed |
| Nginx vhost | `config/nginx/<domain>.conf` deployed manually | Plesk-generated; paste-ready directives snippet |
| SSL | certbot via systemd timer | Plesk Let's Encrypt extension |
| Email | None on the box (no local MTA) | Local Postfix on the same box, no auth |
| Deploy user | hand-rolled `deploy` user | Per-subscription Plesk user |
| Release root | `/var/www/iam[-staging]/` | `/var/www/vhosts/<domain>/iam-releases/` |

The release-tree shape (`releases/<ts>-<sha>/`, `current` symlink,
keep-last-5 prune) is identical between the two scripts. If you
already understand the Ubuntu deploy, the Plesk version is the same
mental model with different paths and a different restart hook.

---

*Version: 2 — added §13 covering Plesk + AlmaLinux 9 as the
recommended production target. Ubuntu path retained for staging
and any operator who prefers manual nginx + systemd.*
