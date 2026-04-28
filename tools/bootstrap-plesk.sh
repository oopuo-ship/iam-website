#!/bin/bash
# IAM bootstrap — AlmaLinux 9 / Rocky 9 + Plesk Obsidian.
# Sibling of bootstrap.sh (which targets Ubuntu).
#
# What this script does (idempotent):
#   1. Verifies host is AlmaLinux 9 / Rocky 9 with Plesk installed.
#   2. Creates the release-tree skeleton under the Plesk subscription docroot.
#   3. Renders the env file into a private (out-of-docroot) location.
#   4. Verifies localhost:25 (the local MTA) is reachable — that's the email
#      delivery path the Express app uses (no third-party SMTP).
#   5. Prints a checklist of Plesk panel actions the operator must perform
#      manually. These cannot be automated from a shell script because they
#      live in Plesk's database and panel state, not on disk.
#
# What this script does NOT do (deliberately):
#   - Install nginx, certbot, ufw, or systemd units. Plesk owns all of that.
#   - Create system users. Plesk's per-subscription user is the deploy user.
#   - Run sudo systemctl. Passenger restarts are user-scoped under Plesk.
#
# Usage:
#   sudo DOMAIN=interactivemove.nl SUBSCRIPTION_USER=interactivemove_xyz \
#        OPENROUTER_API_KEY=... HUBSPOT_PORTAL_ID=... HUBSPOT_CONTACT_FORM_GUID=... \
#        bash tools/bootstrap-plesk.sh
set -euo pipefail

DOMAIN="${DOMAIN:-}"
SUBSCRIPTION_USER="${SUBSCRIPTION_USER:-}"
NODE_MAJOR="${NODE_MAJOR:-20}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '[bootstrap-plesk] %s\n' "$*"; }
warn() { printf '[bootstrap-plesk] WARN: %s\n' "$*" >&2; }
die()  { printf '[bootstrap-plesk] ERROR: %s\n' "$*" >&2; exit 1; }
redact_len() { printf '%d' "${#1}"; }

require_root() { [[ $EUID -eq 0 ]] || die "run as root"; }

preflight() {
  log "preflight"
  [[ -r /etc/os-release ]] || die "/etc/os-release missing"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    almalinux:9.*|rocky:9.*) : ;;
    *) die "unsupported OS: ${ID:-?} ${VERSION_ID:-?} (need AlmaLinux 9 or Rocky 9)" ;;
  esac

  [[ -f /usr/local/psa/version ]] || die "Plesk not detected (/usr/local/psa/version missing) — install Plesk Obsidian first"
  log "Plesk version: $(cat /usr/local/psa/version 2>/dev/null || echo unknown)"

  [[ -n "$DOMAIN" ]] || die "DOMAIN env var required (e.g. DOMAIN=interactivemove.nl)"
  [[ -n "$SUBSCRIPTION_USER" ]] || die "SUBSCRIPTION_USER env var required (the per-subscription system user Plesk created for the domain)"

  id "$SUBSCRIPTION_USER" >/dev/null 2>&1 || die "subscription user does not exist: $SUBSCRIPTION_USER"

  local docroot="/var/www/vhosts/$DOMAIN"
  [[ -d "$docroot" ]] || die "Plesk vhost dir missing: $docroot — add the domain in Plesk first"

  for f in \
    "$REPO_ROOT/tools/env-template" \
    "$REPO_ROOT/config/nginx/redirects.conf"; do
    [[ -f "$f" ]] || die "missing repo file: $f"
  done
}

setup_release_tree() {
  local base="/var/www/vhosts/$DOMAIN"
  local releases="$base/iam-releases"
  local private="$base/private"

  log "creating release tree under $base"
  install -d -o "$SUBSCRIPTION_USER" -g psacln -m 0755 "$releases"
  install -d -o "$SUBSCRIPTION_USER" -g psacln -m 0750 "$private"

  if [[ ! -e "$base/iam-current" ]]; then
    log "  iam-current symlink not present — operator will create it on first deploy"
  else
    log "  iam-current → $(readlink "$base/iam-current")"
  fi
}

render_env_file() {
  local envfile="/var/www/vhosts/$DOMAIN/private/iam-api.env"
  log "rendering env file → $envfile"

  local missing=()
  [[ -n "${OPENROUTER_API_KEY:-}" ]] || missing+=(OPENROUTER_API_KEY)
  [[ -n "${HUBSPOT_PORTAL_ID:-}" ]] || missing+=(HUBSPOT_PORTAL_ID)
  [[ -n "${HUBSPOT_CONTACT_FORM_GUID:-}" ]] || missing+=(HUBSPOT_CONTACT_FORM_GUID)
  if (( ${#missing[@]} > 0 )); then
    warn "env vars not provided: ${missing[*]} — env file will contain placeholders"
  else
    log "  OPENROUTER_API_KEY len=$(redact_len "$OPENROUTER_API_KEY")"
    log "  HUBSPOT_PORTAL_ID=${HUBSPOT_PORTAL_ID}"
  fi

  local notify_to="${NOTIFY_EMAIL_TO:-klantcontact@$DOMAIN}"
  local notify_from="${NOTIFY_EMAIL_FROM:-notifications@$DOMAIN}"

  umask 077
  cat > "$envfile" <<EOF
# IAM Express API — env file rendered by tools/bootstrap-plesk.sh
# Plesk Application -> Custom Environment Variables: paste the contents of this
# file into the panel's env-vars field, OR use Plesk's "Specify file with
# environment variables" feature pointing at this path.

OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-REPLACE_ME_OPENROUTER_KEY}
CHAT_MODEL=${CHAT_MODEL:-google/gemini-2.0-flash-001}
CHAT_PORT=${CHAT_PORT:-3860}
CHAT_ALLOWED_ORIGINS=https://$DOMAIN
CHAT_RATE_LIMIT_MAX=10
CHAT_RATE_LIMIT_WINDOW_MS=60000
TOKEN_BUDGET_PATH=/var/www/vhosts/$DOMAIN/private/token-budget.json
LOG_LEVEL=info

HUBSPOT_PORTAL_ID=${HUBSPOT_PORTAL_ID:-REPLACE_ME_HUBSPOT_PORTAL_ID}
HUBSPOT_CONTACT_FORM_GUID=${HUBSPOT_CONTACT_FORM_GUID:-REPLACE_ME_HUBSPOT_CONTACT_FORM_GUID}
HUBSPOT_PARTNER_FORM_GUID=${HUBSPOT_PARTNER_FORM_GUID:-${HUBSPOT_CONTACT_FORM_GUID:-REPLACE_ME_HUBSPOT_PARTNER_FORM_GUID}}

# Local-MTA email (Plesk's Postfix on this box, no auth)
NOTIFY_EMAIL_TO=$notify_to
NOTIFY_EMAIL_FROM=$notify_from
EOF
  chown "$SUBSCRIPTION_USER:psacln" "$envfile"
  chmod 0640 "$envfile"
  log "  env file mode 0640, owner $SUBSCRIPTION_USER:psacln"
}

verify_local_mta() {
  log "checking local MTA (localhost:25)"
  if (echo > /dev/tcp/127.0.0.1/25) 2>/dev/null; then
    log "  localhost:25 is reachable"
  else
    warn "  localhost:25 NOT reachable — Plesk's Postfix may be disabled. Email notifications will fail until it's running."
    warn "  Check: systemctl status postfix && systemctl enable --now postfix"
  fi
}

print_panel_checklist() {
  cat <<EOF

============================================================
PLESK PANEL CHECKLIST — operator must complete these manually
============================================================
Plesk panel paths assume the Obsidian UI. Adjust if your version differs.

1. NODE.JS APP
   Plesk → Domains → $DOMAIN → Node.js
   - Node.js Version:        $NODE_MAJOR.x  (any 20.x is fine)
   - Application Mode:       production
   - Document Root:          $DOMAIN  (default; nginx serves static files from here)
   - Application Root:       /var/www/vhosts/$DOMAIN/iam-current
   - Application Startup File: server.js
   - Click "Enable Node.js", then "NPM install".

2. ENVIRONMENT VARIABLES
   Same panel → "Custom environment variables".
   Paste the lines from /var/www/vhosts/$DOMAIN/private/iam-api.env
   (excluding the # comment lines). Save.

3. NGINX CUSTOM DIRECTIVES
   Plesk → Domains → $DOMAIN → Apache & nginx Settings
   → "Additional nginx directives" (the HTTPS box).
   Paste the contents of:
     $REPO_ROOT/config/nginx/plesk-additional-directives.conf
   This injects: 51 legacy-URL redirects, security headers, and the
   /api/* proxy_pass to the Node app.
   Save and confirm Plesk shows "Apply" succeeded with no syntax errors.

4. SSL
   Plesk → Domains → $DOMAIN → SSL/TLS Certificates
   → "Install a free basic certificate provided by Let's Encrypt".
   Check both "Secure the wildcard domain" and "Secure www subdomain"
   if applicable. Plesk handles renewal — DO NOT run certbot manually.

5. FIRST DEPLOY
   From a workstation with SSH access to this server:
     SHA=\$(git rev-parse --short HEAD)
     git archive --format=tar.gz -o /tmp/iam-deploy-\$SHA.tar.gz HEAD
     scp /tmp/iam-deploy-\$SHA.tar.gz $SUBSCRIPTION_USER@$DOMAIN:/tmp/
     ssh $SUBSCRIPTION_USER@$DOMAIN "/usr/local/bin/iam-deploy-plesk $DOMAIN \$SHA /tmp/iam-deploy-\$SHA.tar.gz"

6. SMOKE
   curl -sI https://$DOMAIN/                         # expect 200
   curl -sI https://$DOMAIN/products/2-in-1-vloer-muur  # expect 301 → /products/2-in-1-floor-wall
   POST a contact form, watch for 'notify_email_sent' in the panel logs,
   confirm $notify_to receives the message.
============================================================
EOF
}

require_root
preflight
setup_release_tree
render_env_file
verify_local_mta
print_panel_checklist
log "done."
