#!/usr/bin/env bash
#
# scripts/deploy-frontend.sh — build + deploy the SPA to S3/CloudFront with
# CORRECT cache + content-type headers, then VERIFY them.
#
# Why this exists (2026-06-04):
#   The frontend was historically deployed by hand-typed `aws s3 sync` +
#   `create-invalidation` commands copied out of the RUNBOOK. Two footguns
#   bit us doing it that way:
#     1. `index.html` was uploaded with NO Cache-Control, so browsers served
#        a stale copy that referenced asset filenames a later `--delete` sync
#        had removed → blank page / "won't load".
#     2. A well-meaning `aws s3 cp --metadata-directive REPLACE` to add cache
#        headers RESET the JS/CSS content-type to `binary/octet-stream`.
#        Browsers refuse to execute an ES module (or apply CSS) served as
#        octet-stream → blank page.
#
#   This script encodes the correct rules once:
#     - Hashed assets (assets/*)      → `public, max-age=31536000, immutable`
#       (safe: Vite content-hashes the filenames, so a changed file is a new
#       URL — it can never be served stale).
#     - index.html                    → `no-cache, no-store, must-revalidate`
#       (always revalidated, so a new deploy is picked up immediately).
#     - Content-types are set from the file extension on upload, and `.wasm`
#       is forced to `application/wasm` (the AWS CLI's mimetypes DB often
#       doesn't know it and would default to octet-stream).
#   …and then it re-fetches the LIVE bundle and FAILS if the content-type is
#   wrong, so a broken deploy can never pass silently.
#
# Usage:
#   ./scripts/deploy-frontend.sh --target test
#   ./scripts/deploy-frontend.sh --target prod --confirm-prod
#
# Flags:
#   --target {test|prod}   Which environment to deploy (REQUIRED).
#                            test → test.drep.tools  (Frontend-test stack)
#                            prod → drep.tools        (Frontend-dev stack —
#                                   the live site is served by the dev-stage
#                                   stacks; see docs/TOPOLOGY.md)
#   --confirm-prod         Required acknowledgement to deploy `prod`
#                            (changes the LIVE drep.tools site).
#   --no-build             Skip `npm run build`; deploy the existing
#                            frontend/dist as-is (must already be built for
#                            the right target).
#   --network NAME         VITE_CARDANO_NETWORK (default: mainnet).
#   -h, --help             Print this help and exit.
#
# Env:
#   AWS_PROFILE            AWS profile (default: drep-platform).
#
# Exit codes:
#   0  Deployed + verified clean.
#   1  Argument / usage error.
#   2  Prod deploy attempted without --confirm-prod.
#   3  Build failed.
#   4  Post-deploy verification failed (content-type / cache-control wrong).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="${REPO_ROOT}/frontend"

AWS_PROFILE="${AWS_PROFILE:-drep-platform}"
export AWS_PROFILE

# ---- Defaults ----
TARGET=""
CONFIRM_PROD=0
DO_BUILD=1
NETWORK="mainnet"

print_help() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \?//'; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) print_help; exit 0 ;;
        --target) TARGET="${2:-}"; shift 2 ;;
        --target=*) TARGET="${1#--target=}"; shift ;;
        --confirm-prod) CONFIRM_PROD=1; shift ;;
        --no-build) DO_BUILD=0; shift ;;
        --network) NETWORK="${2:-}"; shift 2 ;;
        --network=*) NETWORK="${1#--network=}"; shift ;;
        *) echo "ERROR: unknown argument: $1" >&2; echo "Run with --help." >&2; exit 1 ;;
    esac
done

# ---- Resolve target → (stack suffix, VITE_STAGE) ----
case "$TARGET" in
    test) STACK_SUFFIX="test"; VITE_STAGE="test" ;;
    prod) STACK_SUFFIX="prod"; VITE_STAGE="prod" ;;  # post-migration: drep.tools is served by the *-prod stacks (2026-06-05)
    "")   echo "ERROR: --target {test|prod} is required" >&2; exit 1 ;;
    *)    echo "ERROR: --target must be 'test' or 'prod' (got '$TARGET')" >&2; exit 1 ;;
esac

if [[ "$TARGET" == "prod" && "$CONFIRM_PROD" -ne 1 ]]; then
    echo "============================================================" >&2
    echo "  REFUSING TO DEPLOY FRONTEND TO PROD WITHOUT CONFIRMATION" >&2
    echo "  This changes the LIVE drep.tools site." >&2
    echo "  Re-run with: --confirm-prod" >&2
    echo "============================================================" >&2
    exit 2
fi

# ---- Resolve bucket / distribution / API url from CloudFormation outputs ----
stack_output() { # $1=stack $2=outputKey
    aws cloudformation describe-stacks --stack-name "$1" \
        --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null
}

FRONTEND_STACK="DRepPlatform-Frontend-${STACK_SUFFIX}"
API_STACK="DRepPlatform-Api-${STACK_SUFFIX}"

BUCKET="$(stack_output "$FRONTEND_STACK" FrontendBucketName)"
DIST_ID="$(stack_output "$FRONTEND_STACK" DistributionId)"
PRIMARY_URL="$(stack_output "$FRONTEND_STACK" PrimaryUrl)"
API_URL="$(stack_output "$API_STACK" ApiCustomUrl)"

if [[ -z "$BUCKET" || "$BUCKET" == "None" || -z "$DIST_ID" || "$DIST_ID" == "None" || -z "$API_URL" || "$API_URL" == "None" ]]; then
    echo "ERROR: could not resolve stack outputs for target '$TARGET'." >&2
    echo "  bucket=$BUCKET dist=$DIST_ID api=$API_URL" >&2
    exit 1
fi

echo "================================================================"
echo "  Frontend deploy"
echo "    target:        $TARGET  ($PRIMARY_URL)"
echo "    VITE_STAGE:    $VITE_STAGE"
echo "    API:           $API_URL"
echo "    network:       $NETWORK"
echo "    bucket:        $BUCKET"
echo "    distribution:  $DIST_ID"
echo "    build:         $([[ $DO_BUILD -eq 1 ]] && echo yes || echo 'no (--no-build)')"
echo "================================================================"

# ---- Build ----
if [[ "$DO_BUILD" -eq 1 ]]; then
    echo "Building (VITE_STAGE=$VITE_STAGE)…"
    (
        cd "$FRONTEND_DIR"
        VITE_API_BASE_URL="$API_URL" \
        VITE_API_URL="$API_URL" \
        VITE_STAGE="$VITE_STAGE" \
        VITE_CARDANO_NETWORK="$NETWORK" \
        npm run build
    ) || { echo "ERROR: build failed" >&2; exit 3; }
fi

DIST_DIR="${FRONTEND_DIR}/dist"
if [[ ! -f "${DIST_DIR}/index.html" ]]; then
    echo "ERROR: ${DIST_DIR}/index.html not found — build first (omit --no-build)." >&2
    exit 1
fi

IMMUTABLE="public, max-age=31536000, immutable"
NOCACHE="no-cache, no-store, must-revalidate"

# ---- 1. Sync everything (handles --delete cleanup + content-type by ext) ----
# `aws s3 sync` from LOCAL files guesses content-type from the extension
# (js→text/javascript, css→text/css, …). index.html gets the immutable header
# here but we OVERRIDE it in step 3; .wasm gets octet-stream but we OVERRIDE it
# in step 2. --delete prunes assets removed by content-hashing.
echo "Syncing assets → s3://${BUCKET}/ …"
aws s3 sync "${DIST_DIR}/" "s3://${BUCKET}/" --delete --cache-control "$IMMUTABLE"

# ---- 2. Force correct content-type on .wasm (CLI mimetypes often misses it) ----
if compgen -G "${DIST_DIR}/assets/*.wasm" > /dev/null; then
    echo "Fixing .wasm content-type → application/wasm …"
    aws s3 cp "${DIST_DIR}/assets/" "s3://${BUCKET}/assets/" --recursive \
        --exclude "*" --include "*.wasm" \
        --content-type "application/wasm" --cache-control "$IMMUTABLE"
fi

# ---- 3. index.html: text/html + no-cache (so deploys are picked up at once) ----
echo "Uploading index.html (no-cache) …"
aws s3 cp "${DIST_DIR}/index.html" "s3://${BUCKET}/index.html" \
    --content-type "text/html" --cache-control "$NOCACHE"

# ---- 4. Invalidate ----
echo "Invalidating CloudFront ($DIST_ID) …"
INV_ID="$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
    --query "Invalidation.Id" --output text)"
echo "  invalidation: $INV_ID"
echo "  waiting for it to complete…"
aws cloudfront wait invalidation-completed --distribution-id "$DIST_ID" --id "$INV_ID" || \
    echo "  (wait timed out — it usually still completes; continuing to verify)"

# ---- 5. VERIFY live headers (fail loudly if the footguns recurred) ----
echo "Verifying live headers at ${PRIMARY_URL} …"
fail=0
cb="$(date +%s)"

# index.html must be no-cache.
idx_cc="$(curl -sI "${PRIMARY_URL}/?v=${cb}" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
if [[ "$idx_cc" != *"no-cache"* ]]; then
    echo "  ✗ index.html Cache-Control is '$idx_cc' (expected no-cache)"; fail=1
else
    echo "  ✓ index.html Cache-Control: $idx_cc"
fi

# Each referenced JS bundle must be served as a javascript type.
for b in $(curl -s "${PRIMARY_URL}/?v=${cb}" | grep -oE 'assets/index-[A-Za-z0-9_]+\.js'); do
    ct="$(curl -sI "${PRIMARY_URL}/${b}" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
    if [[ "$ct" != *"javascript"* ]]; then
        echo "  ✗ ${b} Content-Type is '$ct' (expected */javascript)"; fail=1
    else
        echo "  ✓ ${b} Content-Type: $ct"
    fi
done

if [[ "$fail" -ne 0 ]]; then
    echo "================================================================" >&2
    echo "  VERIFICATION FAILED — the deploy may render a blank page." >&2
    echo "  Check content-type / cache-control on the objects above." >&2
    echo "================================================================" >&2
    exit 4
fi

echo "================================================================"
echo "  ✔ Frontend deployed + verified: ${PRIMARY_URL}"
echo "================================================================"
exit 0
