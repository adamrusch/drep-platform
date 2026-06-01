#!/usr/bin/env bash
#
# scripts/deploy.sh — race-safe wrapper for `cdk deploy`
#
# Why this exists (2026-05-26):
#   During deploy of PR #2, two `cdk deploy` invocations were issued in
#   parallel against the shared default `cdk.out/` directory. The second
#   process printed "Another CLI is currently synthing to cdk.out. Invoke
#   the CLI in sequence" and EXITED 0 — but the Lambda code was never
#   actually updated. The clean exit code masked a 10-minute production
#   outage that was only caught by spot-checking `aws lambda
#   get-function-configuration` and seeing a 9-day-stale LastModified.
#
# What this wrapper does:
#   1. Acquires an outer lock (`flock` if available, otherwise an
#      atomic `mkdir`-based lock) so two invocations of this script
#      cannot run concurrently.
#   2. Iterates stacks SEQUENTIALLY (never in parallel) so the
#      cdk.out race window cannot open within a single invocation.
#   3. Uses a per-stack `--output cdk.out.<stack-slug>` so even if
#      something does manage to invoke `cdk deploy` against the same
#      stack twice (e.g. inside a CI matrix), the two processes don't
#      share an `cdk.out` directory.
#   4. After each successful stack deploy, invokes the drift detector
#      (`scripts/check-deploy-drift.ts`) for that stack and prints the
#      result loudly. Drift is REPORTED but does NOT trigger a rollback
#      — that's the human's call.
#
# Usage:
#   ./scripts/deploy.sh DRepPlatform-Api-dev DRepPlatform-Scheduler-dev
#
# Flags:
#   --dry-run     Print what would be deployed without executing.
#   --no-drift    Skip the post-deploy drift check.
#   --stage NAME  Override the CDK stage context (default: dev).
#   -h, --help    Print this help and exit.
#
# Env:
#   AWS_PROFILE   AWS profile to use (default: drep-platform).
#
# Exit codes:
#   0   All requested stacks deployed cleanly.
#   1   Argument / usage error.
#   2   Lock acquisition failed (another deploy already running).
#   3   `cdk deploy` failed for at least one stack.
#   4   Post-deploy drift check failed for at least one stack.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${REPO_ROOT}/infra"
LOCK_DIR="/tmp/drep-platform-deploy.lock"
LOCK_FILE="/tmp/drep-platform-deploy.lock.flock"

# ---- Defaults ----
DRY_RUN=0
RUN_DRIFT=1
STAGE="dev"
TOUCH_PRODUCTION=0
AWS_PROFILE="${AWS_PROFILE:-drep-platform}"
export AWS_PROFILE

# ---- Argument parsing ----
print_help() {
    sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

STACKS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            print_help
            exit 0
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --no-drift)
            RUN_DRIFT=0
            shift
            ;;
        --touch-production)
            # Required acknowledgement to deploy a stage that serves the live
            # drep.tools domain (see the production guard below).
            TOUCH_PRODUCTION=1
            shift
            ;;
        --stage)
            STAGE="${2:-}"
            if [[ -z "$STAGE" ]]; then
                echo "ERROR: --stage requires an argument" >&2
                exit 1
            fi
            shift 2
            ;;
        --stage=*)
            STAGE="${1#--stage=}"
            shift
            ;;
        -*)
            echo "ERROR: unknown flag: $1" >&2
            echo "Run with --help for usage." >&2
            exit 1
            ;;
        *)
            STACKS+=("$1")
            shift
            ;;
    esac
done

if [[ ${#STACKS[@]} -eq 0 ]]; then
    echo "ERROR: no stacks specified" >&2
    echo "Usage: $0 [--dry-run] [--no-drift] [--stage NAME] STACK [STACK...]" >&2
    echo "Example: $0 DRepPlatform-Api-dev DRepPlatform-Scheduler-dev" >&2
    exit 1
fi

# ---- Production guard -------------------------------------------------------
# IMPORTANT (2026-05-31): the live drep.tools / api.drep.tools site is currently
# served by the `dev` stage stacks (a historical artifact — see
# docs/TOPOLOGY.md). Until the planned migration to real `*-prod` stacks, the
# `dev` (and future `prod`) stage IS production: deploying it changes the live
# app, and because `customDomainFor('dev')` now returns no domain, a `dev`
# deploy would DETACH drep.tools. Require an explicit acknowledgement so nobody
# does this by accident. `--dry-run` is always allowed (read-only).
if [[ "$STAGE" == "dev" || "$STAGE" == "prod" ]] && [[ "$DRY_RUN" -eq 0 ]] && [[ "$TOUCH_PRODUCTION" -ne 1 ]]; then
    echo "============================================================" >&2
    echo "  REFUSING TO DEPLOY STAGE '$STAGE' WITHOUT CONFIRMATION" >&2
    echo "============================================================" >&2
    echo "  The '$STAGE' stage currently serves the LIVE drep.tools site." >&2
    echo "  Deploying it will change production and can detach the domain." >&2
    echo "  See docs/TOPOLOGY.md for the safe migration runbook." >&2
    echo "" >&2
    echo "  If you really mean to touch production, re-run with:" >&2
    echo "      --touch-production" >&2
    echo "  (or use --dry-run to preview without deploying)." >&2
    echo "============================================================" >&2
    exit 2
fi

# ---- Lock acquisition ----
# Two strategies depending on what the host provides:
#   1. `flock` (Linux, some macOS via brew): atomic file lock, auto-released
#      on process exit even if we crash.
#   2. `mkdir` (macOS default): atomic directory create succeeds for
#      exactly one process. We register an EXIT trap to clean up.
#
# Both paths use a non-blocking acquire — if another deploy is in flight,
# we abort immediately with a clear error rather than hang silently.
acquire_lock() {
    if command -v flock >/dev/null 2>&1; then
        # File-descriptor 9 backs the flock; the FD is closed (and the
        # lock released) automatically when this shell exits.
        exec 9>"$LOCK_FILE"
        if ! flock -n 9; then
            echo "ERROR: another deploy is already running (flock on $LOCK_FILE)" >&2
            echo "If you're sure nothing else is deploying, remove the lock:" >&2
            echo "    rm -f $LOCK_FILE" >&2
            exit 2
        fi
        echo "lock acquired (flock $LOCK_FILE, pid $$)"
    else
        # mkdir is atomic on POSIX filesystems — exactly one process wins.
        if ! mkdir "$LOCK_DIR" 2>/dev/null; then
            echo "ERROR: another deploy is already running (lock dir $LOCK_DIR exists)" >&2
            if [[ -f "$LOCK_DIR/pid" ]]; then
                held_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo '?')"
                echo "Held by pid $held_pid (check with: ps -p $held_pid)" >&2
            fi
            echo "If you're sure nothing else is deploying, remove the lock:" >&2
            echo "    rm -rf $LOCK_DIR" >&2
            exit 2
        fi
        echo "$$" > "$LOCK_DIR/pid"
        # Clean up the lock dir on exit (normal or signal).
        trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
        echo "lock acquired (mkdir $LOCK_DIR, pid $$)"
    fi
}

# ---- Stack slug for --output dir ----
# CDK accepts almost any filename, but we lowercase + dash-only to keep
# things filesystem-friendly. The slug is also what the drift detector
# uses to find the synthesized template, so the two must stay in sync.
stack_slug() {
    echo "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed -e 's/^-*//' -e 's/-*$//'
}

# ---- Single-stack deploy ----
deploy_one() {
    local stack="$1"
    local slug
    slug="$(stack_slug "$stack")"
    local out_dir="cdk.out.${slug}"

    echo ""
    echo "================================================================"
    echo "  Deploying: $stack"
    echo "  Output dir: $out_dir"
    echo "  Stage: $STAGE"
    echo "  AWS_PROFILE: $AWS_PROFILE"
    echo "================================================================"

    if [[ "$DRY_RUN" -eq 1 ]]; then
        echo "[DRY RUN] Would run:"
        echo "  cd $INFRA_DIR"
        echo "  npx cdk deploy $stack \\"
        echo "    --context stage=$STAGE \\"
        echo "    --output $out_dir \\"
        echo "    --require-approval never"
        return 0
    fi

    (
        cd "$INFRA_DIR"
        npx cdk deploy "$stack" \
            --context "stage=${STAGE}" \
            --output "$out_dir" \
            --require-approval never
    )
}

# ---- Post-deploy drift check ----
check_drift_one() {
    local stack="$1"

    if [[ "$RUN_DRIFT" -eq 0 ]]; then
        echo "(drift check skipped: --no-drift)"
        return 0
    fi

    if [[ "$DRY_RUN" -eq 1 ]]; then
        echo "[DRY RUN] Would run drift check for $stack"
        return 0
    fi

    if [[ ! -f "${REPO_ROOT}/scripts/check-deploy-drift.ts" ]]; then
        echo "WARNING: scripts/check-deploy-drift.ts not found — skipping drift check"
        return 0
    fi

    echo ""
    echo "---- drift check: $stack ----"
    if (cd "$REPO_ROOT" && npx tsx scripts/check-deploy-drift.ts "$stack"); then
        echo "drift check OK"
        return 0
    else
        rc=$?
        echo ""
        echo "================================================================"
        echo "  WARNING: drift detected for $stack (drift-check exit $rc)"
        echo "  The deploy reported success but the deployed Lambda code"
        echo "  may not match what CDK synthesized. Investigate before"
        echo "  considering this stack production-ready."
        echo "================================================================"
        return $rc
    fi
}

# ---- Main ----
echo "drep.tools deploy wrapper"
echo "  stacks: ${STACKS[*]}"
echo "  stage: $STAGE"
echo "  dry-run: $([[ $DRY_RUN -eq 1 ]] && echo yes || echo no)"
echo "  drift-check: $([[ $RUN_DRIFT -eq 1 ]] && echo yes || echo no)"

# Dry-run does not acquire the real lock (nice for sanity-checking the
# script while another deploy is in flight).
if [[ "$DRY_RUN" -eq 0 ]]; then
    acquire_lock
fi

deploy_failures=()
drift_failures=()

for stack in "${STACKS[@]}"; do
    if ! deploy_one "$stack"; then
        echo ""
        echo "ERROR: cdk deploy failed for $stack" >&2
        deploy_failures+=("$stack")
        # Continue to the next stack — we want every requested stack to be
        # attempted, otherwise a flaky first deploy could mask drift in
        # subsequent ones. If you'd rather fail-fast, comment out the
        # following line and `break` instead.
        continue
    fi
    if ! check_drift_one "$stack"; then
        drift_failures+=("$stack")
    fi
done

echo ""
echo "================================================================"
echo "  Summary"
echo "================================================================"
echo "  stacks attempted: ${#STACKS[@]}"
echo "  deploy failures: ${#deploy_failures[@]} ${deploy_failures[*]:-}"
echo "  drift failures:  ${#drift_failures[@]} ${drift_failures[*]:-}"

if [[ ${#deploy_failures[@]} -gt 0 ]]; then
    exit 3
fi

# Post-deploy warm-up. EventBridge rate() rules don't fire until the first
# interval elapses, so a freshly deployed stack would have empty sync tables
# (no DReps for up to 30 min, etc.). If the Scheduler stack was (re)deployed,
# prime the syncs now. Non-fatal — the syncs still run on schedule regardless.
if [[ "$DRY_RUN" -eq 0 ]]; then
    warm=0
    for s in "${STACKS[@]}"; do [[ "$s" == *Scheduler* ]] && warm=1; done
    if [[ "$warm" -eq 1 ]]; then
        echo ""
        echo "Priming syncs (post-deploy warm-up)…"
        "$(dirname "$0")/warm-syncs.sh" "$STAGE" \
            || echo "WARN: warm-up failed (non-fatal); syncs will still run on schedule."
    fi
fi

if [[ ${#drift_failures[@]} -gt 0 ]]; then
    exit 4
fi

echo "  ✔ all clean"
exit 0
