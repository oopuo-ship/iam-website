#!/bin/bash
# IAM atomic deploy — installed as /usr/local/bin/iam-deploy by bootstrap.sh (Plan 03).
# Invoked over SSH by Phase 03 GitHub Actions workflow.
# Runs as the `deploy` user (member of `iam` group); no sudo required.
set -euo pipefail

ENV="${1:-}"
SHA="${2:-}"
TARBALL="${3:-/tmp/iam-deploy-${SHA}.tar.gz}"

[[ -n "$ENV" && -n "$SHA" ]] || {
  echo "usage: iam-deploy <prod|staging> <git_sha> [tarball]" >&2
  exit 2
}

case "$ENV" in
  prod)
    RELEASE_ROOT="/var/www/iam"
    UNIT="iam-api.service"
    PORT="3860"
    ;;
  staging)
    RELEASE_ROOT="/var/www/iam-staging"
    UNIT="iam-api-staging.service"
    PORT="3861"
    ;;
  *)
    echo "unknown env: $ENV (expected prod|staging)" >&2
    exit 2
    ;;
esac

RELEASES_DIR="${RELEASE_ROOT}/releases"
CURRENT_LINK="${RELEASE_ROOT}/current"
TS="$(date -u +%Y%m%d-%H%M%S)"
NEW_DIR="${RELEASES_DIR}/${TS}-${SHA}"
KEEP=5

log() { printf '[iam-deploy %s] %s\n' "$ENV" "$*"; }
die() { printf '[iam-deploy %s] ERROR: %s\n' "$ENV" "$*" >&2; exit 1; }

[[ -d "$RELEASES_DIR" ]] || die "releases dir missing: $RELEASES_DIR (run bootstrap.sh first)"
[[ -f "$TARBALL" ]]      || die "tarball missing: $TARBALL"

# 1. Extract new release
log "extracting $TARBALL → $NEW_DIR"
mkdir -p "$NEW_DIR"
tar -xzf "$TARBALL" -C "$NEW_DIR"

# 2. Install prod deps under api/
if [[ -f "$NEW_DIR/api/package.json" ]]; then
  log "installing prod deps (npm ci --omit=dev)"
  (cd "$NEW_DIR/api" && npm ci --omit=dev --no-audit --no-fund)
else
  die "new release is missing api/package.json"
fi

# 3. Capture previous target for rollback
PREV_TARGET=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREV_TARGET="$(readlink -f "$CURRENT_LINK" || true)"
  log "previous release: ${PREV_TARGET:-<none>}"
fi

# 4. Atomic symlink flip
log "flipping $CURRENT_LINK → $NEW_DIR"
ln -sfn "$NEW_DIR" "$CURRENT_LINK"

# 5. Restart the unit
log "restarting $UNIT"
sudo -n systemctl restart "$UNIT"
# small settle window for Node to bind the port
sleep 2

# 6. Health check — if it fails, roll back
log "health check on 127.0.0.1:${PORT}"
if ! curl -fsS --max-time 5 -o /dev/null -X OPTIONS "http://127.0.0.1:${PORT}/api/chat"; then
  log "health check FAILED — rolling back"
  if [[ -n "$PREV_TARGET" && -d "$PREV_TARGET" ]]; then
    ln -sfn "$PREV_TARGET" "$CURRENT_LINK"
    sudo -n systemctl restart "$UNIT"
    die "rolled back to $PREV_TARGET"
  else
    die "no previous release to roll back to"
  fi
fi
log "health check OK"

# 7. Prune old releases (keep last $KEEP).
# Sort by filename reverse = chronological newest-first (names are timestamped).
# mtime sort is unreliable because tar preserves tarball mtimes across extractions.
log "pruning old releases (keeping $KEEP)"
# shellcheck disable=SC2012  # filenames are timestamped, no spaces
ls -1 "$RELEASES_DIR" | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  [[ -n "$old" ]] || continue
  log "removing $RELEASES_DIR/$old"
  rm -rf "${RELEASES_DIR:?}/${old}"
done

log "deploy complete: $NEW_DIR"
