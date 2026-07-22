#!/usr/bin/env bash
# -------------------------------------------------------------------------
# Shared config + helpers for the deal_flow deploy suite.
# Sourced by 01..04. Not meant to be run directly.
#
# Fixed infra IDs below were VERIFIED read-only on 2026-07-16 by 00-verify.sh:
#   account 554422457688 · vpc-9e875ff6 · subnet-02d50562903e96e1e (private,
#   NAT egress) · sg-07373311ce339650f (gateway) · ami-027f2df6eaf3477f9
#   (AL2023 arm64) · key pair bijnis-master.
# Re-run 00-verify.sh if you suspect any of these changed.
# -------------------------------------------------------------------------
set -uo pipefail    # -u catch typos, pipefail catch broken pipes; NOT -e (idempotent lookups return non-zero by design)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- load per-deploy inputs (secrets) ------------------------------------
if [ ! -f "$HERE/config.env" ]; then
  echo "ERROR: $HERE/config.env not found."
  echo "       cp $HERE/config.env.example $HERE/config.env  and fill it in."
  exit 1
fi
# shellcheck disable=SC1091
source "$HERE/config.env"

# --- fixed infra ---------------------------------------------------------
export AWS_PROFILE="${AWS_PROFILE:-prod}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
ACCOUNT="554422457688"
VPC="vpc-9e875ff6"
SUBNET="${SUBNET:-subnet-02d50562903e96e1e}"
GATEWAY_SG="sg-07373311ce339650f"
AMI="${AMI:-ami-027f2df6eaf3477f9}"
KEY_NAME="bijnis-master"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
INSTANCE_NAME="deal-flow"
DEAL_SG_NAME="deal-flow-sg"
IAM_ROLE="deal-flow-ec2-role"
ECR_REPO="deal-flow"
ECR_URI="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO"
SSM_PREFIX="/deal-flow/prod"
IMAGE_TAG="${IMAGE_TAG:-v1}"
IMAGE="$ECR_URI:$IMAGE_TAG"

# --- dry-run plumbing ----------------------------------------------------
DRY_RUN=0
for _a in "$@"; do [ "$_a" = "--dry-run" ] && DRY_RUN=1; done

c_hdr()  { printf '\n\033[1m» %s\033[0m\n' "$1"; }
c_ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
c_info() { printf '  \033[36mℹ\033[0m %s\n' "$1"; }
c_warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
c_err()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

# print a command (to stderr, so a caller's >/dev/null on the real output still
# shows the echo), then run it — unless --dry-run. Use ONLY for non-secret args.
mut() {
  printf '  \033[36m$\033[0m %s\n' "$*" >&2
  [ "$DRY_RUN" -eq 1 ] && return 0
  "$@"
}

require_account() {
  local acct
  acct="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '')"
  if [ "$acct" != "$ACCOUNT" ]; then
    c_err "wrong account: got '${acct:-<none>}', expected $ACCOUNT (prod). export AWS_PROFILE=prod"
    exit 1
  fi
  c_ok "prod account $acct · region $AWS_REGION${DRY_RUN:+ }$( [ "$DRY_RUN" = 1 ] && echo '· DRY-RUN (nothing will be executed)')"
}
