#!/bin/bash
# IAM atomic deploy — Plesk + AlmaLinux/Rocky 9 sibling of tools/iam-deploy.sh.
# Designed to be installed at /usr/local/bin/iam-deploy-plesk (or run from
# anywhere as the Plesk subscription user).
#
# Same release-tree shape as the Ubuntu version (releases/<ts>-<sha>/, current
# symlink, keep last 5) — only the restart hook and paths differ. Plesk's
# Node.js extension is built on Phusion Passenger, so we restart with
# `passenger-config restart-app` against the current symlink.
set -euo pipefail

DOMAIN="${1:-}"
SHA="${2:-}"
TARBALL="${3:-/tmp/iam-deploy-${SHA}.tar.gz}"

[[ -n "$DOMAIN" && -n "$SHA" ]] || {
  echo "usage: iam-deploy-plesk <domain> <git_sha> [tarball]" >&2
  exit 2
}

VHOST_ROOT="/var/www/vhosts/$DOMAIN"
RELEASES_DIR="$VHOST_ROOT/iam-releases"
CURRENT_LINK="$VHOST_ROOT/iam-current"
PORT="${PORT:-3860}"
TS="$(date -u +%Y%m%d-%H%M%S)"
NEW_DIR="$RELEASES_DIR/${TS}-${SHA}"
KEEP=5

log() { printf '[iam-deploy-plesk %s] %s\n' "$DOMAIN" "$*"; }
die() { printf '[iam-deploy-plesk %s] ERROR: %s\n' "$DOMAIN" "$*" >&2; exit 1; }

[[ -d "$VHOST_ROOT" ]]    || die "vhost dir missing: $VHOST_ROOT (run bootstrap-plesk.sh first)"
[[ -d "$RELEASES_DIR" ]]  || die "releases dir missing: $RELEASES_DIR (run bootstrap-plesk.sh first)"
[[ -f "$TARBALL" ]]       || die "tarball missing: $TARBALL"

log "extracting $TARBALL → $NEW_DIR"
mkdir -p "$NEW_DIR"
tar -xzf "$TARBALL" -C "$NEW_DIR"

if [[ -f "$NEW_DIR/api/package.json" ]]; then
  log "installing prod deps (npm ci --omit=dev)"
  (cd "$NEW_DIR/api" && npm ci --omit=dev --no-audit --no-fund)
else
  die "new release missing api/package.json"
fi

PREV_TARGET=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREV_TARGET="$(readlink -f "$CURRENT_LINK" || true)"
  log "previous release: ${PREV_TARGET:-<none>}"
fi

log "flipping $CURRENT_LINK → $NEW_DIR"
ln -sfn "$NEW_DIR" "$CURRENT_LINK"

log "restarting Passenger app at $CURRENT_LINK"
if command -v passenger-config >/dev/null 2>&1; then
  passenger-config restart-app "$CURRENT_LINK" || die "passenger-config restart-app failed"
else
  # Plesk also exposes a touch-based restart via tmp/restart.txt under the app root.
  mkdir -p "$NEW_DIR/tmp"
  touch "$NEW_DIR/tmp/restart.txt"
  log "passenger-config not on PATH; created tmp/restart.txt as fallback"
fi
sleep 2

log "health check on 127.0.0.1:${PORT}"
if ! curl -fsS --max-time 5 -o /dev/null -X OPTIONS "http://127.0.0.1:${PORT}/api/chat"; then
  log "health check FAILED — rolling back"
  if [[ -n "$PREV_TARGET" && -d "$PREV_TARGET" ]]; then
    ln -sfn "$PREV_TARGET" "$CURRENT_LINK"
    if command -v passenger-config >/dev/null 2>&1; then
      passenger-config restart-app "$CURRENT_LINK" || true
    else
      mkdir -p "$PREV_TARGET/tmp"
      touch "$PREV_TARGET/tmp/restart.txt"
    fi
    die "rolled back to $PREV_TARGET"
  fi
  die "no previous release to roll back to"
fi
log "health check OK"

# Prune old releases — same logic as Ubuntu deploy. Filename sort = chronological
# (timestamp prefix); mtime is unreliable because tar preserves tarball mtimes.
log "pruning old releases (keeping $KEEP)"
# shellcheck disable=SC2012
ls -1 "$RELEASES_DIR" | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  [[ -n "$old" ]] || continue
  log "removing $RELEASES_DIR/$old"
  rm -rf "${RELEASES_DIR:?}/${old}"
done

log "deploy complete: $NEW_DIR"
