#!/bin/bash
# IAM VPS bootstrap — Phase M2-02
# Idempotent installer for Ubuntu 22.04 / 24.04 LTS.
# Usage (interactive):     sudo bash bootstrap.sh
# Usage (non-interactive): sudo BOOTSTRAP_NONINTERACTIVE=1 \
#                               LETSENCRYPT_EMAIL=you@example.com \
#                               OPENROUTER_API_KEY=... \
#                               OPENROUTER_API_KEY_STAGING=... \
#                               bash bootstrap.sh
set -euo pipefail

# --- Constants (match D-XX in .planning/M2/phases/02-vps-deployment/CONTEXT.md) ---
DOMAIN="${DOMAIN:-interactivemove.nl}"
STAGING_DOMAIN="${STAGING_DOMAIN:-iam.abbamarkt.nl}"
REPO_URL="${REPO_URL:-REPLACE_ME_REPO_URL}"
IAM_USER="iam"
DEPLOY_USER="deploy"
PROD_RELEASE_ROOT="/var/www/iam"
STAGING_RELEASE_ROOT="/var/www/iam-staging"
PROD_ENV_DIR="/etc/iam-api"               # env file: /etc/iam-api/env
STAGING_ENV_DIR="/etc/iam-api-staging"     # env file: /etc/iam-api-staging/env
PROD_STATE_DIR="/var/lib/iam-api"
STAGING_STATE_DIR="/var/lib/iam-api-staging"
NODE_MAJOR="20"
NONINTERACTIVE="${BOOTSTRAP_NONINTERACTIVE:-0}"
STAGING_ONLY="${STAGING_ONLY:-0}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '[bootstrap] %s\n' "$*"; }
warn() { printf '[bootstrap] WARN: %s\n' "$*" >&2; }
die()  { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }
# Never echoes values — only lengths.
redact_len() { printf '%d' "${#1}"; }

require_root() { [[ $EUID -eq 0 ]] || die "run as root (see header comment for invocation)"; }

preflight_check() {
  log "preflight"
  [[ -r /etc/os-release ]] || die "/etc/os-release missing; not a supported OS"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || die "unsupported OS: ${ID:-unknown} (need Ubuntu 22.04 or 24.04)"
  case "${VERSION_ID:-}" in
    22.04|24.04) : ;;
    *) die "unsupported Ubuntu version: ${VERSION_ID:-unknown}" ;;
  esac

  for f in \
    "$REPO_ROOT/config/systemd/iam-api.service" \
    "$REPO_ROOT/config/systemd/iam-api-staging.service" \
    "$REPO_ROOT/config/nginx/interactivemove.nl.conf" \
    "$REPO_ROOT/config/nginx/iam.abbamarkt.nl.conf" \
    "$REPO_ROOT/tools/env-template" \
    "$REPO_ROOT/tools/env-staging-template"; do
    [[ -f "$f" ]] || die "missing required repo file: $f"
  done
}

gather_inputs() {
  log "gather inputs"
  if [[ "$STAGING_ONLY" == "1" ]]; then
    log "STAGING_ONLY=1 — will configure only $STAGING_DOMAIN (staging). Prod vhost + cert skipped."
  fi
  local missing=()
  [[ -n "${LETSENCRYPT_EMAIL:-}" ]] || missing+=("LETSENCRYPT_EMAIL")
  if [[ "$STAGING_ONLY" != "1" ]]; then
    [[ -n "${OPENROUTER_API_KEY:-}" ]] || missing+=("OPENROUTER_API_KEY")
  else
    # Prod key not used on a staging-only VM; placeholder suppresses downstream warnings.
    OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-STAGING_ONLY_NO_PROD_KEY}"
    export OPENROUTER_API_KEY
  fi
  [[ -n "${OPENROUTER_API_KEY_STAGING:-}" ]] || missing+=("OPENROUTER_API_KEY_STAGING")

  if (( ${#missing[@]} > 0 )); then
    if [[ "$NONINTERACTIVE" == "1" ]]; then
      die "non-interactive mode: missing env vars: ${missing[*]}"
    fi
    for var in "${missing[@]}"; do
      if [[ "$var" == OPENROUTER_API_KEY* ]]; then
        read -rs -p "Enter $var (input hidden): " val
        printf '\n'
      else
        read -r -p "Enter $var: " val
      fi
      [[ -n "$val" ]] || die "$var cannot be empty"
      printf -v "$var" '%s' "$val"
      export "${var?}"
    done
  fi

  [[ "$LETSENCRYPT_EMAIL" =~ ^[^@]+@[^@]+\.[^@]+$ ]] \
    || die "LETSENCRYPT_EMAIL does not look like an email address"

  log "got letsencrypt email: $LETSENCRYPT_EMAIL"
  log "got openrouter prod key (len=$(redact_len "$OPENROUTER_API_KEY"))"
  log "got openrouter staging key (len=$(redact_len "$OPENROUTER_API_KEY_STAGING"))"
}

create_users() {
  log "create users"
  id "$IAM_USER" &>/dev/null || \
    useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$IAM_USER"
  id "$DEPLOY_USER" &>/dev/null || \
    useradd --create-home --shell /bin/bash "$DEPLOY_USER"
  usermod -aG "$IAM_USER" "$DEPLOY_USER"
}

install_packages() {
  log "apt update"
  apt-get update -y
  log "apt install"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg nginx certbot python3-certbot-nginx fail2ban ufw git shellcheck
}

install_node20() {
  if command -v node >/dev/null 2>&1 && node -v | grep -q '^v20\.'; then
    log "node 20 already installed: $(node -v)"
    return
  fi
  log "install node 20 via NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  node -v | grep -q '^v20\.' || die "node 20 not active after install"
}

create_dirs() {
  log "create dirs"
  install -d -o "$IAM_USER" -g "$IAM_USER" -m 755 \
    "$PROD_RELEASE_ROOT/releases" \
    "$STAGING_RELEASE_ROOT/releases" \
    "$PROD_STATE_DIR" \
    "$STAGING_STATE_DIR"
  install -d -o root -g "$IAM_USER" -m 750 "$PROD_ENV_DIR" "$STAGING_ENV_DIR"
  install -d -o root -g www-data -m 755 /var/www/letsencrypt
}

_render_env_file() {
  # args: template_path target_path openrouter_key
  local tpl="$1" target="$2" key="$3"
  if [[ -e "$target" ]]; then
    log "env file already present at $target — skipping (edit manually if needed)"
    return
  fi
  local tmp
  tmp="$(mktemp)"
  # `#` used as sed delimiter — OpenRouter keys do not contain `#`.
  sed "s#REPLACE_ME_OPENROUTER_PROD_KEY#$key#; s#REPLACE_ME_OPENROUTER_STAGING_KEY#$key#" \
    "$tpl" > "$tmp"
  chmod 600 "$tmp"
  chown "$IAM_USER:$IAM_USER" "$tmp"
  mv "$tmp" "$target"
  log "rendered $target (len=$(stat -c%s "$target") bytes)"

  # Warn on remaining placeholders (HubSpot etc.) without printing their context lines.
  local remaining
  remaining="$(grep -cE 'REPLACE_ME_[A-Z_]+' "$target" || true)"
  if [[ "$remaining" -gt 0 ]]; then
    warn "$target still contains $remaining REPLACE_ME_* placeholder(s) — fill before Phase 04"
  fi
}

render_env() {
  log "render env files"
  if [[ "$STAGING_ONLY" != "1" ]]; then
    _render_env_file "$REPO_ROOT/tools/env-template" \
      "$PROD_ENV_DIR/env" "$OPENROUTER_API_KEY"
  else
    log "STAGING_ONLY=1 — skipping prod env file"
  fi
  _render_env_file "$REPO_ROOT/tools/env-staging-template" \
    "$STAGING_ENV_DIR/env" "$OPENROUTER_API_KEY_STAGING"
}

install_systemd_units() {
  log "install systemd units"
  install -m 644 "$REPO_ROOT/config/systemd/iam-api-staging.service" \
    /etc/systemd/system/iam-api-staging.service
  systemctl daemon-reload
  if [[ "$STAGING_ONLY" == "1" ]]; then
    systemctl enable iam-api-staging.service
    log "systemd units installed and enabled (staging only); will start after first deploy."
  else
    install -m 644 "$REPO_ROOT/config/systemd/iam-api.service" \
      /etc/systemd/system/iam-api.service
    systemctl enable iam-api.service iam-api-staging.service
    log "systemd units installed and enabled; will start after first deploy."
  fi
}

install_nginx_vhosts() {
  log "install nginx vhosts"
  install -m 644 "$REPO_ROOT/config/nginx/iam.abbamarkt.nl.conf" \
    /etc/nginx/sites-available/iam.abbamarkt.nl.conf
  ln -sf /etc/nginx/sites-available/iam.abbamarkt.nl.conf \
    /etc/nginx/sites-enabled/iam.abbamarkt.nl.conf
  if [[ "$STAGING_ONLY" != "1" ]]; then
    install -m 644 "$REPO_ROOT/config/nginx/interactivemove.nl.conf" \
      /etc/nginx/sites-available/interactivemove.nl.conf
    ln -sf /etc/nginx/sites-available/interactivemove.nl.conf \
      /etc/nginx/sites-enabled/interactivemove.nl.conf
  else
    log "STAGING_ONLY=1 — skipping prod vhost"
  fi

  # If a Cloudflare-origin cert is already installed at /etc/ssl/iam/,
  # rewrite the staging vhost to use those paths instead of Let's Encrypt.
  if [[ -f /etc/ssl/iam/iam.abbamarkt.nl.crt && -f /etc/ssl/iam/iam.abbamarkt.nl.key ]]; then
    log "origin cert detected at /etc/ssl/iam/ — patching staging vhost to use it"
    sed -i \
      -e 's#ssl_certificate     /etc/letsencrypt/live/iam.abbamarkt.nl/fullchain.pem;#ssl_certificate     /etc/ssl/iam/iam.abbamarkt.nl.crt;#' \
      -e 's#ssl_certificate_key /etc/letsencrypt/live/iam.abbamarkt.nl/privkey.pem;#ssl_certificate_key /etc/ssl/iam/iam.abbamarkt.nl.key;#' \
      /etc/nginx/sites-available/iam.abbamarkt.nl.conf
  fi

  nginx -t
  systemctl reload nginx
}

request_certs() {
  log "request certs"
  if [[ "$STAGING_ONLY" != "1" ]]; then
    if [[ ! -e "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
      certbot --nginx --non-interactive --agree-tos \
        --email "$LETSENCRYPT_EMAIL" \
        --domains "$DOMAIN,www.$DOMAIN" \
        --redirect --keep-until-expiring
    else
      log "prod cert already present for $DOMAIN — skipping"
    fi
  else
    log "STAGING_ONLY=1 — skipping prod cert for $DOMAIN"
  fi
  if [[ -f /etc/ssl/iam/iam.abbamarkt.nl.crt ]]; then
    log "staging uses Cloudflare origin cert at /etc/ssl/iam/ — skipping certbot for $STAGING_DOMAIN"
  elif [[ ! -e "/etc/letsencrypt/live/$STAGING_DOMAIN/fullchain.pem" ]]; then
    certbot --nginx --non-interactive --agree-tos \
      --email "$LETSENCRYPT_EMAIL" \
      --domains "$STAGING_DOMAIN" \
      --redirect --keep-until-expiring
  else
    log "staging cert already present for $STAGING_DOMAIN — skipping"
  fi
}

install_deploy_tool() {
  local src="$REPO_ROOT/tools/iam-deploy.sh"
  if [[ ! -f "$src" ]]; then
    warn "tools/iam-deploy.sh not found in repo (Plan 04 delivers it) — skipping deploy tool install"
    return
  fi
  log "install /usr/local/bin/iam-deploy"
  install -m 755 -o root -g root "$src" /usr/local/bin/iam-deploy
}

install_sudoers_deploy() {
  # D-09 (M2-03-cicd): narrow NOPASSWD so the `deploy` user can run iam-deploy
  # as the `iam` user and reload the three managed services.
  local src="$REPO_ROOT/config/sudoers.d/iam-deploy"
  if [[ ! -f "$src" ]]; then
    warn "config/sudoers.d/iam-deploy not found — CI deploy will fail until installed"
    return
  fi
  log "install /etc/sudoers.d/iam-deploy"
  install -m 440 -o root -g root "$src" /etc/sudoers.d/iam-deploy
  visudo -cf /etc/sudoers.d/iam-deploy >/dev/null || die "sudoers drop-in failed validation"
}

install_git_hooks() {
  log "install system-wide git hooks (safety net)"
  install -d -o root -g root -m 755 /etc/iam-githooks
  if [[ -f "$REPO_ROOT/.githooks/pre-commit" ]]; then
    install -m 755 "$REPO_ROOT/.githooks/pre-commit" /etc/iam-githooks/pre-commit
  fi
  git config --system core.hooksPath /etc/iam-githooks || \
    warn "could not set system-wide core.hooksPath (non-fatal)"
}

configure_firewall() {
  log "configure firewall"
  ufw allow OpenSSH >/dev/null
  ufw allow 'Nginx Full' >/dev/null
  if ufw status | grep -q 'Status: active'; then
    log "ufw already active — skipping enable"
  else
    ufw --force enable
  fi
}

print_next_steps() {
  cat <<EOF

[bootstrap] DONE.

Next steps (human):
  1. Follow the Cloudflare runbook:
       .planning/M2/phases/02-vps-deployment/cloudflare-runbook.md
  2. Env files rendered at:
       $PROD_ENV_DIR/env
       $STAGING_ENV_DIR/env
     Both still contain REPLACE_ME_HUBSPOT_* placeholders — fill in before Phase 04.
  3. First deploy will be triggered by CI (Phase 03) on push to main/staging.
     Until then, services are enabled but not started (release dirs are empty).
EOF
}

main() {
  require_root
  preflight_check
  gather_inputs
  create_users
  install_packages
  install_node20
  create_dirs
  render_env
  install_systemd_units
  install_nginx_vhosts
  request_certs
  install_deploy_tool
  install_sudoers_deploy
  install_git_hooks
  configure_firewall
  print_next_steps
}

main "$@"
