#!/usr/bin/env bash
# Passive OWASP ZAP scan of the API (Onda 6a config; executed against the preview in Onda 6b).
#
# Usage:
#   TARGET_URL=http://host.docker.internal:4010 security/zap/run-zap.sh                  # local Prism mock
#   TARGET_URL=https://<preview>.vercel.app CONFIRM_REMOTE=yes security/zap/run-zap.sh   # preview (owner OK)
#
# Environment:
#   TARGET_URL      Required. Base URL, no path, no trailing slash.
#   CONFIRM_REMOTE  Must be "yes" for any non-local target (external action: needs human confirmation).
#   ZAP_MODE        api (default): imports contracts/openapi.v1.yaml, passive scan of every operation.
#                   baseline: spiders TARGET_URL/v1/health only (smoke check of the headers).
#   ZAP_IMAGE       Default zaproxy/zap-stable:2.17.0 (pinned by VERSION TAG; digest pinning is a 6b step,
#                   see security/zap/README.md).
#   ZAP_OUT_DIR     Where reports land. Default: a new temporary directory (path is printed).
#
# Exit codes: 0 = no FAIL rule and no High/Medium alert; 1 = a FAIL rule or a High/Medium alert;
#             3 = the scan itself failed (docker/ZAP error, no report).
#
# The scan is passive on purpose (zap-api-scan.py -S): an active scan would POST fuzzed payloads to
# POST /v1/leads, creating leads, burning Turnstile/Redis quota and tripping the bot-failure block.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
ZAP_DIR="$ROOT/security/zap"
ZAP_IMAGE="${ZAP_IMAGE:-zaproxy/zap-stable:2.17.0}"
ZAP_MODE="${ZAP_MODE:-api}"
TARGET_URL="${TARGET_URL:-}"

if [[ -z "$TARGET_URL" ]]; then
  echo "TARGET_URL is required (see header of this script)" >&2
  exit 64
fi
# Only scheme://host[:port]: also keeps the value safe for the sed rewrite below.
if [[ ! "$TARGET_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  echo "TARGET_URL must look like http(s)://host[:port] without path or trailing slash" >&2
  exit 64
fi
if [[ ! "$TARGET_URL" =~ ^http://(localhost|127\.0\.0\.1|host\.docker\.internal)(:[0-9]+)?$ ]] \
  && [[ "${CONFIRM_REMOTE:-}" != "yes" ]]; then
  echo "refusing to scan $TARGET_URL: not a local target. Set CONFIRM_REMOTE=yes only after the project" >&2
  echo "owner confirmed the target (preview, never production)." >&2
  exit 64
fi
if [[ "$ZAP_MODE" != "api" && "$ZAP_MODE" != "baseline" ]]; then
  echo "ZAP_MODE must be api or baseline" >&2
  exit 64
fi
command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 3; }

OUT_DIR="${ZAP_OUT_DIR:-$(mktemp -d)}"
mkdir -p "$OUT_DIR"
cp "$ZAP_DIR/zap-rules.tsv" "$OUT_DIR/zap-rules.tsv"
# The container runs as an unprivileged user (uid 1000) and must be able to write its reports here.
chmod a+rwx "$OUT_DIR"

zap_args=()
if [[ "$ZAP_MODE" == "api" ]]; then
  # Point every `servers:` entry of a COPY of the contract at the target (the repo file is untouched).
  sed -E "s|^(  - url: ).*\$|\1${TARGET_URL}|" "$ROOT/contracts/openapi.v1.yaml" >"$OUT_DIR/openapi.yaml"
  zap_args=(zap-api-scan.py -t /zap/wrk/openapi.yaml -f openapi -S)
else
  zap_args=(zap-baseline.py -t "$TARGET_URL/v1/health")
fi
chmod a+r "$OUT_DIR"/*

echo "ZAP $ZAP_MODE scan of $TARGET_URL with $ZAP_IMAGE (reports in $OUT_DIR)"
rc=0
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -v "$OUT_DIR:/zap/wrk:rw" \
  "$ZAP_IMAGE" \
  "${zap_args[@]}" \
  -c /zap/wrk/zap-rules.tsv -I -J report.json -r report.html || rc=$?

# zap-*.py: 0 ok, 1 a FAIL rule fired, 2 warnings (suppressed by -I), 3 scan error.
if [[ ! -s "$OUT_DIR/report.json" ]]; then
  echo "no report produced (ZAP exit code $rc)" >&2
  exit 3
fi
gate=0
node "$ZAP_DIR/check-report.mjs" "$OUT_DIR/report.json" || gate=$?
if [[ $rc -eq 1 || $gate -ne 0 ]]; then
  echo "ZAP gate failed (zap exit $rc, High/Medium check $gate). Report: $OUT_DIR/report.html" >&2
  exit 1
fi
if [[ $rc -ne 0 && $rc -ne 2 ]]; then
  exit 3
fi
echo "ZAP gate passed. Report: $OUT_DIR/report.html"
