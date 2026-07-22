#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy/aws/deploy.sh — REDEPLOY deal_flow (build → push → roll the EC2 box).
#
# For shipping CHANGES to the already-running prod instance. Self-contained:
# needs only prod AWS creds + Docker + this repo. NO config.env / secrets —
# the DB creds and AUTH_KEY already live in SSM (set once by 01-provision).
#
# It builds an arm64 image tagged with the git short SHA, pushes it to ECR,
# pins that image in SSM (/deal-flow/prod/IMAGE), then uses SSM Run Command
# to (re)install a self-healing run.sh, restart the container, and health-check
# — all without SSH or a bastion.
#
#   bash deploy/aws/deploy.sh                 # build HEAD, deploy, health-check
#   bash deploy/aws/deploy.sh --dry-run       # print the plan, touch nothing
#   bash deploy/aws/deploy.sh --tag <sha>     # redeploy/ROLLBACK an existing ECR tag (no build)
#   bash deploy/aws/deploy.sh --yes           # skip the confirm prompt (CI)
#   bash deploy/aws/deploy.sh --allow-dirty   # build from a dirty tree (tag gets -dirty-<ts>)
#   bash deploy/aws/deploy.sh --force-build   # rebuild even if the SHA tag already exists
#
# Exit 0 = deployed and healthy. Non-zero = aborted or unhealthy (see output).
# ---------------------------------------------------------------------------
set -uo pipefail

# --- fixed infra (verified read-only 2026-07-16; mirrors _common.sh) --------
export AWS_PROFILE="${AWS_PROFILE:-prod}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
ACCOUNT="554422457688"
ECR_REPO="deal-flow"
ECR_URI="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO"
INSTANCE_NAME="deal-flow"
SSM_PREFIX="/deal-flow/prod"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # …/deal_flow

# --- flags ------------------------------------------------------------------
DRY_RUN=0; ASSUME_YES=0; ALLOW_DIRTY=0; FORCE_BUILD=0; TAG_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)     DRY_RUN=1 ;;
    --yes|-y)      ASSUME_YES=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --force-build) FORCE_BUILD=1 ;;
    --tag)         TAG_OVERRIDE="${2:-}"; shift ;;
    --tag=*)       TAG_OVERRIDE="${1#*=}" ;;
    -h|--help)     sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

c_hdr(){ printf '\n\033[1m» %s\033[0m\n' "$1"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
info(){ printf '  \033[36mℹ\033[0m %s\n' "$1"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$1"; }
die(){ printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
run(){ printf '  \033[36m$\033[0m %s\n' "$*"; [ "$DRY_RUN" -eq 1 ] || "$@"; }

# --- 0. identity guard (must be PROD) --------------------------------------
c_hdr "0. identity"
ACCT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '')"
[ "$ACCT" = "$ACCOUNT" ] || die "wrong AWS account '${ACCT:-<none>}' (expected $ACCOUNT). Run: export AWS_PROFILE=prod"
ok "prod account $ACCT · region $AWS_REGION$( [ "$DRY_RUN" = 1 ] && echo ' · DRY-RUN' )"
command -v docker >/dev/null 2>&1 || [ -n "$TAG_OVERRIDE" ] || die "docker not found (needed to build). Install Docker Desktop, or use --tag to redeploy an existing image."

# --- 1. locate the running instance ----------------------------------------
c_hdr "1. target instance (tag Name=$INSTANCE_NAME)"
IID="$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=$INSTANCE_NAME" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null)"
[ -n "$IID" ] && [ "$IID" != "None" ] || die "no running instance tagged Name=$INSTANCE_NAME. Launch it first (03-launch.sh)."
[ "$(printf '%s\n' "$IID" | wc -w)" -eq 1 ] || die "multiple running instances tagged $INSTANCE_NAME: $IID — resolve manually."
ok "instance $IID"

# --- 2. resolve the image tag ----------------------------------------------
c_hdr "2. image tag"
SKIP_BUILD=0
if [ -n "$TAG_OVERRIDE" ]; then
  TAG="$TAG_OVERRIDE"; SKIP_BUILD=1
  aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag="$TAG" --region "$AWS_REGION" >/dev/null 2>&1 \
    || die "tag '$TAG' not found in ECR $ECR_REPO — can only --tag an image that was already pushed."
  info "redeploying existing tag $TAG (no build)"
else
  SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
    [ "$ALLOW_DIRTY" -eq 1 ] || die "working tree is dirty — commit first, or pass --allow-dirty."
    TAG="${SHA}-dirty-$(date +%Y%m%d%H%M%S)"
    warn "dirty tree → tag $TAG (not reproducible)"
  else
    TAG="$SHA"
    if [ "$FORCE_BUILD" -eq 0 ] && aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag="$TAG" --region "$AWS_REGION" >/dev/null 2>&1; then
      SKIP_BUILD=1; info "image $TAG already in ECR (clean tree) → reuse, skip build. (--force-build to rebuild.)"
    fi
  fi
fi
IMAGE="$ECR_URI:$TAG"

# --- 3. capture current image (rollback target) ----------------------------
PREV="$(aws ssm get-parameter --name "$SSM_PREFIX/IMAGE" --region "$AWS_REGION" --query Parameter.Value --output text 2>/dev/null || echo '')"

# --- plan + confirm ---------------------------------------------------------
c_hdr "plan"
info "instance : $IID"
info "new image: $IMAGE"
info "current  : ${PREV:-<none / first SSM-driven deploy>}"
info "build    : $( [ "$SKIP_BUILD" -eq 1 ] && echo 'skip (reuse existing)' || echo 'yes (arm64)' )"
if [ "$DRY_RUN" -eq 1 ]; then info "DRY-RUN — nothing executed."; exit 0; fi
if [ "$ASSUME_YES" -eq 0 ]; then
  printf '  \033[33mProceed with prod redeploy? [y/N]\033[0m '
  read -r ans; case "$ans" in y|Y|yes|YES) ;; *) die "aborted by user." ;; esac
fi

# --- 4. build + push --------------------------------------------------------
if [ "$SKIP_BUILD" -eq 0 ]; then
  c_hdr "3. build (linux/arm64) + push"
  run docker build --platform linux/arm64 -t "$IMAGE" "$REPO_ROOT" || die "docker build failed"
  aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com" >/dev/null || die "ECR login failed"
  ok "logged in to ECR"
  run docker push "$IMAGE" || die "docker push failed"
  ok "pushed $IMAGE"
fi

# --- 5. pin the image in SSM ------------------------------------------------
c_hdr "4. pin image in SSM ($SSM_PREFIX/IMAGE)"
aws ssm put-parameter --name "$SSM_PREFIX/IMAGE" --type String --value "$IMAGE" --overwrite --region "$AWS_REGION" >/dev/null || die "failed to set SSM image param"
ok "$SSM_PREFIX/IMAGE = $IMAGE"

# --- 6. roll the container via SSM Run Command ------------------------------
# The remote step is STATIC (reads the image from SSM), so it is safe to run on
# every deploy: it (re)writes a self-healing run.sh, restarts, and health-checks.
c_hdr "5. roll container on $IID (SSM Run Command)"
REMOTE="$(cat <<'REMOTE_EOF'
set -euo pipefail
mkdir -p /opt/deal-flow
cat > /opt/deal-flow/run.sh <<'RUN'
#!/bin/bash
set -euo pipefail
REGION="ap-south-1"; ACCOUNT="554422457688"; SSM_PREFIX="/deal-flow/prod"
get(){ aws ssm get-parameter --name "$1" --with-decryption --region "$REGION" --query Parameter.Value --output text; }
IMAGE="$(aws ssm get-parameter --name "$SSM_PREFIX/IMAGE" --region "$REGION" --query Parameter.Value --output text)"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker pull "$IMAGE"
docker rm -f deal-flow 2>/dev/null || true
docker run -d --name deal-flow --restart=unless-stopped -p 3000:3000 \
  -e NODE_ENV=production \
  -e DB_HOST="$(get $SSM_PREFIX/DB_HOST)" \
  -e DB_PORT="$(get $SSM_PREFIX/DB_PORT)" \
  -e DB_USER="$(get $SSM_PREFIX/DB_USER)" \
  -e DB_PASSWORD="$(get $SSM_PREFIX/DB_PASSWORD)" \
  -e DB_NAME="$(get $SSM_PREFIX/DB_NAME)" \
  -e AUTH_KEY="$(get $SSM_PREFIX/AUTH_KEY)" \
  "$IMAGE"
RUN
chmod +x /opt/deal-flow/run.sh
systemctl restart deal-flow
for i in $(seq 1 25); do
  if curl -fsS localhost:3000/g/deal-flow/api/health >/dev/null 2>&1; then
    echo "HEALTHY after ~$((i*3))s"
    docker ps --filter name=deal-flow --format 'running: {{.Image}} ({{.Status}})'
    exit 0
  fi
  sleep 3
done
echo "HEALTH CHECK FAILED"
docker ps -a --filter name=deal-flow --format '{{.Image}} ({{.Status}})'
docker logs deal-flow --tail 40 2>&1 || true
exit 1
REMOTE_EOF
)"
REMOTE_B64="$(printf '%s' "$REMOTE" | base64 | tr -d '\n')"

CMD_ID="$(aws ssm send-command \
  --instance-ids "$IID" \
  --document-name "AWS-RunShellScript" \
  --comment "deal_flow redeploy $TAG" \
  --parameters commands="echo $REMOTE_B64 | base64 --decode | sudo bash" \
  --region "$AWS_REGION" --query Command.CommandId --output text 2>/dev/null)"
[ -n "$CMD_ID" ] && [ "$CMD_ID" != "None" ] || die "ssm send-command failed (check ssm:SendCommand perms + SSM agent on the box)"
info "command $CMD_ID — waiting for the box to pull + restart…"

STATUS="Pending"
for _ in $(seq 1 40); do
  sleep 4
  STATUS="$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$IID" --region "$AWS_REGION" --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in Success|Failed|Cancelled|TimedOut) break ;; esac
done
OUT="$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$IID" --region "$AWS_REGION" --query StandardOutputContent --output text 2>/dev/null)"
ERR="$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$IID" --region "$AWS_REGION" --query StandardErrorContent --output text 2>/dev/null)"
[ -n "$OUT" ] && printf '%s\n' "$OUT" | sed 's/^/    /'
[ -n "$ERR" ] && [ "$ERR" != "None" ] && printf '%s\n' "$ERR" | sed 's/^/    err: /'

c_hdr "done"
if [ "$STATUS" = "Success" ]; then
  ok "deployed $IMAGE → $IID (healthy)"
  [ -n "$PREV" ] && [ "$PREV" != "$IMAGE" ] && info "rollback: bash deploy/aws/deploy.sh --tag ${PREV##*:} --yes"
  exit 0
else
  die "redeploy did NOT succeed (status=$STATUS). The previous container may still be serving. Rollback: bash deploy/aws/deploy.sh --tag ${PREV##*:} --yes"
fi
