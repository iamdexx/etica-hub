# Shared helpers sourced by every script in this directory.
# Not meant to be executed directly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${BUNDLE_ROOT}/.env"

log()  { printf '\033[1;34m[hyperlane-validator]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[hyperlane-validator]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[hyperlane-validator]\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    fail "Required env var '${var}' is unset. Edit ${ENV_FILE}."
  fi
}

load_env() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    fail "Missing ${ENV_FILE} — copy from .env.example and fill in."
  fi
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
}

# Idempotently set or update KEY=VALUE in .env. Used by provisioning
# scripts to write back values they generate (VPS IP, R2 keys, etc.).
write_env() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "${ENV_FILE}" ]] && grep -q "^${key}=" "${ENV_FILE}"; then
    sed "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}" > "${tmp}"
  else
    cp "${ENV_FILE}" "${tmp}" 2>/dev/null || true
    printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  fi
  mv "${tmp}" "${ENV_FILE}"
  log "wrote ${key} to ${ENV_FILE}"
}
