#!/usr/bin/env bash
# Create an R2 bucket for validator checkpoint storage and generate an
# S3-compatible access key pair.
#
# Inputs (from .env):
#   CLOUDFLARE_API_TOKEN — needs R2 Edit permissions
#   CLOUDFLARE_ACCOUNT_ID
#
# Outputs (written back to .env):
#   R2_ACCESS_KEY_ID
#   R2_SECRET_ACCESS_KEY
#   R2_ENDPOINT_URL
#
# Idempotent: if the bucket already exists, we reuse it. Access keys
# are NOT regenerated if R2_ACCESS_KEY_ID is already set in .env.

source "$(dirname "$0")/_common.sh"
load_env
require CLOUDFLARE_API_TOKEN
require CLOUDFLARE_ACCOUNT_ID

BUCKET="${R2_BUCKET_NAME:-etica-hyperlane-validator-signatures}"

API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")

# 1. Create the bucket (idempotent — 409 means "already exists").
log "ensuring R2 bucket '${BUCKET}' exists"
http_code="$(curl -s -o /tmp/r2-create.json -w '%{http_code}' "${AUTH[@]}" -X POST "${API}/r2/buckets" \
  -d "$(jq -n --arg name "${BUCKET}" '{name:$name}')")"
if [[ "${http_code}" != "200" && "${http_code}" != "409" ]]; then
  cat /tmp/r2-create.json >&2
  fail "R2 bucket create failed (HTTP ${http_code})"
fi

# 2. Make bucket publicly readable. Validator checkpoint signatures
#    are public by design — anyone fetching from the bucket can verify
#    the validator signed a given root.
log "enabling public read on bucket"
curl -s "${AUTH[@]}" -X PUT "${API}/r2/buckets/${BUCKET}/domains/managed" \
  -d '{"enabled":true}' >/dev/null || warn "managed domain enable may already be set"

# 3. Generate S3-compatible access keys (skip if already in .env).
if [[ -n "${R2_ACCESS_KEY_ID:-}" && -n "${R2_SECRET_ACCESS_KEY:-}" ]]; then
  log "R2 access keys already present in .env, skipping regen"
else
  log "creating R2 access key pair"
  resp="$(curl -s "${AUTH[@]}" -X POST "${API}/r2/temp-access-credentials" \
    -d "$(jq -n --arg bucket "${BUCKET}" \
      '{bucket:$bucket, parentAccessKeyId:null, permission:"object-read-and-write", ttlSeconds:31536000}')")"
  access_key="$(echo "${resp}" | jq -r '.result.accessKeyId // empty')"
  secret_key="$(echo "${resp}" | jq -r '.result.secretAccessKey // empty')"
  if [[ -z "${access_key}" || -z "${secret_key}" ]]; then
    echo "${resp}" >&2
    fail "R2 access key creation failed"
  fi
  write_env R2_ACCESS_KEY_ID "${access_key}"
  write_env R2_SECRET_ACCESS_KEY "${secret_key}"
fi

write_env R2_BUCKET_NAME "${BUCKET}"
write_env R2_ENDPOINT_URL "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
write_env R2_REGION "auto"

log "✓ R2 bucket ready: ${BUCKET}. Next: ./scripts/deploy-core.sh"
